import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntentParser, parseSince, extractJson } from '@aria/core';

const parserNoLlm = new IntentParser({ router: null });

test('rule: ringkasan chat dengan nama grup & frasa waktu', async () => {
  const i = await parserNoLlm.parse('ARIA, ringkas chat grup keluarga dari kemarin dong');
  assert.equal(i.name, 'wa.summarize');
  assert.equal(i.slots.chat, 'keluarga');
  assert.equal(i.source, 'rule');
});

test('rule: balas pesan -> intent wa.send dengan target & instruksi', async () => {
  const i = await parserNoLlm.parse('balas chat budi bilang otw');
  assert.equal(i.name, 'wa.send');
  assert.equal(i.slots.target, 'budi');
  assert.equal(i.slots.instruction, 'otw');
});

test('rule: kirim ke nomor dengan isi setelah titik dua', async () => {
  const i = await parserNoLlm.parse('kirim pesan ke 081234567890: meeting dimajukan ke jam 3');
  assert.equal(i.name, 'wa.send');
  assert.equal(i.slots.target, '081234567890');
  assert.equal(i.slots.instruction, 'meeting dimajukan ke jam 3');
});

test('rule: catatan memory, status, help', async () => {
  assert.equal((await parserNoLlm.parse('ingat: ibu ulang tahun 12 agustus')).name, 'memory.note');
  assert.equal((await parserNoLlm.parse('status')).name, 'status');
  assert.equal((await parserNoLlm.parse('help')).name, 'help');
});

test('tanpa LLM, teks ambigu jatuh ke intent chat (aman, tanpa side effect)', async () => {
  const i = await parserNoLlm.parse('kenapa langit berwarna biru?');
  assert.equal(i.name, 'chat');
});

test('LLM fallback dipakai saat rule tidak cocok, hasilnya divalidasi', async () => {
  const router = {
    chat: async (task, messages, opts) => {
      assert.equal(task, 'intent');
      assert.equal(opts.jsonMode, true);
      return { text: 'prefix {"intent": "wa.send", "slots": {"target": "budi", "instruction": "otw"}} suffix' };
    },
  };
  const parser = new IntentParser({ router });
  const i = await parser.parse('tolong sampaikan ke budi kalau aku otw');
  assert.equal(i.name, 'wa.send');
  assert.equal(i.slots.target, 'budi');
  assert.equal(i.source, 'llm');
});

test('LLM fallback melempar / output sampah -> tetap aman ke chat', async () => {
  const parserThrow = new IntentParser({ router: { chat: async () => { throw new Error('down'); } } });
  assert.equal((await parserThrow.parse('pertanyaan acak')).name, 'chat');

  const parserGarbage = new IntentParser({ router: { chat: async () => ({ text: 'bukan json sama sekali' }) } });
  assert.equal((await parserGarbage.parse('pertanyaan acak')).name, 'chat');
});

test('parseSince: kemarin / hari ini / relatif N jam & hari / default 24 jam', () => {
  const now = new Date('2026-07-28T15:00:00').getTime();
  const day = 24 * 3600 * 1000;

  assert.equal(parseSince('3 hari', now), now - 3 * day);
  assert.equal(parseSince('6 jam', now), now - 6 * 3600 * 1000);
  assert.equal(parseSince('kemarin', now), new Date('2026-07-27T00:00:00').getTime());
  assert.equal(parseSince('hari ini', now), new Date('2026-07-28T00:00:00').getTime());
  assert.equal(parseSince('', now), now - day);
});

test('extractJson mengambil objek pertama dari teks campuran', () => {
  assert.deepEqual(extractJson('bla {"a":1} bla'), { a: 1 });
  assert.equal(extractJson('tidak ada json'), null);
});
