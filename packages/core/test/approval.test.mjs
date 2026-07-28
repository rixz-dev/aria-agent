import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalGate, parseApprovalReply } from '@aria/core';
import { createMemoryRepos } from '@aria/db';
import { ApprovalError } from '@aria/shared';

function makeGate({ clock, ttlMs = 60_000 } = {}) {
  const repos = createMemoryRepos();
  const gate = new ApprovalGate({ repo: repos.approvals, ttlMs, clock });
  return { gate, repos };
}

const action = { service: 'wa', method: 'sendMessage', params: { to: 'budi', text: 'otw' }, sideEffect: true };

test('request -> pending, tercatat di repo lengkap dengan target & draft', async () => {
  const { gate } = makeGate();
  const ap = await gate.request({ chatId: 1, userId: 9, summary: 'Kirim WA', target: 'budi', draft: 'otw ya', action });
  assert.match(ap.id, /^[a-f0-9]{6}$/);
  assert.equal(ap.status, 'pending');
  assert.ok(ap.expiresAt > ap.createdAt);
  const stored = await gate.repo.get(ap.id);
  assert.equal(stored.target, 'budi');
});

test('decide approved lalu decide lagi bersifat idempotent (changed: false)', async () => {
  const { gate } = makeGate();
  const ap = await gate.request({ chatId: 1, userId: 9, summary: 'x', action });
  const first = await gate.decide(ap.id, 'approved', 'owner');
  assert.equal(first.changed, true);
  assert.equal(first.approval.status, 'approved');
  const second = await gate.decide(ap.id, 'rejected', 'owner');
  assert.equal(second.changed, false);
  assert.equal(second.approval.status, 'approved');
});

test('decide pada id tak dikenal melempar ApprovalError', async () => {
  const { gate } = makeGate();
  await assert.rejects(() => gate.decide('ffffff', 'approved', 'x'), ApprovalError);
});

test('approval kedaluwarsa tidak bisa di-approve; sweeper menandainya expired', async () => {
  let now = 1_000_000;
  const { gate } = makeGate({ clock: () => now });
  const ap = await gate.request({ chatId: 1, userId: 9, summary: 'x', action });

  now += 61_000; // lewat TTL 60 detik
  const events = [];
  gate.on('expired', (a) => events.push(a.id));

  const denied = await gate.decide(ap.id, 'approved', 'owner');
  assert.equal(denied.approval.status, 'expired');

  const ap2 = await gate.request({ chatId: 1, userId: 9, summary: 'x2', action });
  now += 61_000;
  assert.equal(await gate.expireDue(), 1);
  assert.deepEqual(events, [ap.id, ap2.id]);
  assert.equal((await gate.repo.get(ap2.id)).status, 'expired');
});

test('latestPending dipakai untuk balasan teks tanpa id', async () => {
  const { gate } = makeGate();
  await gate.request({ chatId: 1, userId: 9, summary: 'pertama', action });
  const kedua = await gate.request({ chatId: 1, userId: 9, summary: 'kedua', action });
  await gate.request({ chatId: 2, userId: 9, summary: 'chat lain', action });
  const latest = await gate.latestPending(1);
  assert.equal(latest.id, kedua.id);
});

test('event requested & resolved terpancar', async () => {
  const { gate } = makeGate();
  const seen = [];
  gate.on('requested', (a) => seen.push(['requested', a.id]));
  gate.on('resolved', (a) => seen.push(['resolved', a.id, a.status]));
  const ap = await gate.request({ chatId: 1, userId: 9, summary: 'x', action });
  await gate.decide(ap.id, 'rejected', 'owner');
  assert.deepEqual(seen, [['requested', ap.id], ['resolved', ap.id, 'rejected']]);
});

// --- parser balasan teks ---------------------------------------------------

test('parseApprovalReply: kata setuju & tolak umum', () => {
  assert.deepEqual(parseApprovalReply('ya'), { decision: 'approved', id: null });
  assert.deepEqual(parseApprovalReply('Oke'), { decision: 'approved', id: null });
  assert.deepEqual(parseApprovalReply('gas'), { decision: 'approved', id: null });
  assert.deepEqual(parseApprovalReply('tolak'), { decision: 'rejected', id: null });
  assert.deepEqual(parseApprovalReply('batal'), { decision: 'rejected', id: null });
});

test('parseApprovalReply: dengan id eksplisit & slash command', () => {
  assert.deepEqual(parseApprovalReply('approve a1b2c3'), { decision: 'approved', id: 'a1b2c3' });
  assert.deepEqual(parseApprovalReply('/reject a1b2c3'), { decision: 'rejected', id: 'a1b2c3' });
  assert.deepEqual(parseApprovalReply('ya #a1b2c3'), { decision: 'approved', id: 'a1b2c3' });
});

test('parseApprovalReply: kalimat biasa TIDAK boleh jadi approval (anti false-positive)', () => {
  assert.equal(parseApprovalReply('ya ampun lihat itu'), null);
  assert.equal(parseApprovalReply('tidak mungkin sekali'), null);
  assert.equal(parseApprovalReply('halo apa kabar'), null);
  assert.equal(parseApprovalReply(''), null);
});
