import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalGate, Orchestrator, ServiceRegistry } from '@aria/core';
import { createMemoryRepos } from '@aria/db';

/**
 * Router palsu: menjawab deterministik berdasarkan task & isi system prompt,
 * sekaligus mencatat berapa kali dipanggil per task.
 */
function fakeRouter() {
  const calls = [];
  return {
    calls,
    chat: async (task, messages) => {
      calls.push(task);
      const sys = messages.find((m) => m.role === 'system')?.content || '';
      if (task === 'intent') return { text: '{"intent":"chat","slots":{}}' };
      if (sys.includes('Tulis pesan WhatsApp')) return { text: 'Oke siap, aku otw ya 👍', provider: 'fake' };
      if (task === 'summarize') return { text: '- bahas piknik\n- iuran terkumpul', provider: 'fake' };
      return { text: 'jawaban standar', provider: 'fake', usage: { promptTokens: 1, completionTokens: 1 } };
    },
    call: async (name, messages) => ({ text: 'direct', provider: name }),
    status: () => [{ name: 'fake', kind: 'chat', state: 'ready', calls: calls.length }],
  };
}

function fakeWa({ chats = [], messagesByJid = {} } = {}) {
  const sent = [];
  return {
    sent,
    status: async () => ({ linked: true }),
    chats: async () => ({ chats }),
    messages: async (jid) => ({ messages: messagesByJid[jid] || [] }),
    sendMessage: async (to, text) => {
      sent.push({ to, text });
      return { jid: 'fake-jid', note: `terkirim ke ${to}` };
    },
  };
}

function makeOrchestrator({ wa, router = fakeRouter(), plugins = null } = {}) {
  const repos = createMemoryRepos();
  const gate = new ApprovalGate({ repo: repos.approvals, ttlMs: 60_000 });
  const services = new ServiceRegistry();
  if (wa) services.register('wa', wa);
  const orch = new Orchestrator({ repos, router, plugins, services, gate });
  return { orch, gate, repos, router };
}

const me = { chatId: '42', userId: '7' };

test('ringkas chat: dieksekusi langsung TANPA approval, pakai task summarize', async () => {
  const wa = fakeWa({
    chats: [{ jid: 'g@g.us', name: 'Keluarga', isGroup: true }],
    messagesByJid: { 'g@g.us': [
      { ts: Date.now() - 1000, from: 'Ayah', text: 'jadi piknik minggu?', fromMe: false },
      { ts: Date.now(), from: 'Ibu', text: 'jadi, iuran 50rb', fromMe: false },
    ] },
  });
  const { orch, repos, router } = await ready({ wa });
  const res = await orch.handleUserMessage({ ...me, text: 'ringkas chat grup keluarga dari kemarin' });

  assert.equal(res.approvals, undefined); // baca-saja → tanpa approval
  assert.match(res.reply, /Ringkasan "Keluarga"/);
  assert.match(res.reply, /piknik/);
  assert.ok(router.calls.filter((t) => t === 'summarize').length >= 1);
  assert.equal(wa.sent.length, 0);
  assert.deepEqual(await repos.approvals.list({}), []); // tidak ada approval tercipta
});

test('ringkas chat ambigu: jawaban berisi kandidat, tetap tanpa approval', async () => {
  const wa = fakeWa({
    chats: [
      { jid: 'a@g.us', name: 'Keluarga Besar', isGroup: true },
      { jid: 'b@g.us', name: 'Keluarga Inti', isGroup: true },
    ],
  });
  const { orch } = await ready({ wa });
  const res = await orch.handleUserMessage({ ...me, text: 'ringkas chat keluarga' });
  assert.match(res.reply, /Maksudmu salah satu ini\?/);
  assert.match(res.reply, /Keluarga Besar/);
  assert.equal(wa.sent.length, 0);
});

test('balas chat: draft disusun, approval diminta, TIDAK terkirim sebelum approve', async () => {
  const wa = fakeWa();
  const { orch } = await ready({ wa });
  const res = await orch.handleUserMessage({ ...me, text: 'balas chat budi bilang otw' });

  assert.equal(res.approvals.length, 1);
  const ap = res.approvals[0];
  assert.equal(ap.target, 'budi');       // target ditampilkan jelas (risiko §9)
  assert.match(ap.draft, /otw/i);         // draft dari LLM
  assert.equal(ap.action.service, 'wa');
  assert.equal(wa.sent.length, 0);        // prinsip utama: belum terkirim!

  // User menolak → tetap tidak terkirim.
  const rejected = await orch.resolveApproval(ap.id, 'rejected', me.userId);
  assert.match(rejected.reply, /dibatalkan/);
  assert.equal(wa.sent.length, 0);
});

test('approve -> pesan TERKIRIM ke tujuan + hasil dicatat (audit)', async () => {
  const wa = fakeWa();
  const { orch, repos } = await ready({ wa });
  const res = await orch.handleUserMessage({ ...me, text: 'balas chat budi bilang otw' });
  const ap = res.approvals[0];

  const done = await orch.resolveApproval(ap.id, 'approved', me.userId);
  assert.match(done.reply, /dieksekusi/);
  assert.equal(wa.sent.length, 1);
  assert.equal(wa.sent[0].to, 'budi');
  assert.match(wa.sent[0].text, /otw/i);

  const stored = await repos.approvals.get(ap.id);
  assert.equal(stored.status, 'approved');
  assert.equal(stored.decidedBy, me.userId);
  assert.match(stored.result, /terkirim/);
});

test('kegagalan eksekusi pasca-approve tercatat status failed, bukan crash', async () => {
  const wa = fakeWa();
  wa.sendMessage = async () => { throw new Error('WA tidak terhubung'); };
  const { orch, repos } = await ready({ wa });
  const res = await orch.handleUserMessage({ ...me, text: 'balas chat budi bilang otw' });
  const done = await orch.resolveApproval(res.approvals[0].id, 'approved', me.userId);
  assert.match(done.reply, /gagal dieksekusi/);
  assert.equal((await repos.approvals.get(res.approvals[0].id)).status, 'failed');
});

test('chat biasa: lewat agent loop + konteks riwayat, tanpa approval', async () => {
  const wa = fakeWa();
  const { orch } = await ready({ wa });
  await orch.handleUserMessage({ ...me, text: 'halo' });
  const res = await orch.handleUserMessage({ ...me, text: 'apa kabar?' });
  assert.equal(res.reply, 'jawaban standar');
});

test('ingat/catat disimpan ke memory repo', async () => {
  const { orch, repos } = await ready({ wa: fakeWa() });
  const res = await orch.handleUserMessage({ ...me, text: 'ingat: pln token habis' });
  assert.match(res.reply, /Dicatat/);
  const keys = await repos.memory.keys('note:');
  assert.equal(keys.length, 1);
});

test('status menampilkan provider & count approval pending', async () => {
  const wa = fakeWa();
  const { orch } = await ready({ wa });
  await orch.handleUserMessage({ ...me, text: 'balas chat budi bilang otw' });
  const res = await orch.handleUserMessage({ ...me, text: 'status' });
  assert.match(res.reply, /fake/);
  assert.match(res.reply, /Approval pending:\*\s*1/);
});

test('riwayat percakapan dipersist (user & assistant) per chat', async () => {
  const { orch, repos } = await ready({ wa: fakeWa() });
  await orch.handleUserMessage({ ...me, text: 'halo' });
  const rows = await repos.messages.recent(me.chatId, 10);
  assert.deepEqual(rows.map((r) => r.role), ['user', 'assistant']);
});

async function ready({ wa, router, plugins } = {}) {
  return makeOrchestrator({ wa, router, plugins });
}
