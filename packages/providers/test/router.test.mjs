import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRouter, AIProvider } from '@aria/providers';
import { ProviderError, AllProvidersFailedError } from '@aria/shared';

class FakeProvider extends AIProvider {
  constructor(name, behavior) {
    super();
    this.name = name;
    this.behavior = behavior;
    this.calls = 0;
  }
  async chat(messages) {
    this.calls += 1;
    const b = this.behavior;
    if (b.failWith) throw b.failWith;
    if (b.failTimes && this.calls <= b.failTimes) throw b.failTimesError || new ProviderError('boom', { provider: this.name, retryable: true });
    return { text: `ok:${this.name}:${messages.at(-1).content}`, model: 'fake', usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 } };
  }
}

const retryable = new ProviderError('rate limited', { status: 429, retryable: true });
const permanent = new ProviderError('bad key', { status: 401, retryable: false });

test('routed chat: fallback ke kandidat berikutnya saat yang pertama gagal', async () => {
  const router = new ProviderRouter({ routes: { chat: ['a', 'b'] } });
  router.register(new FakeProvider('a', { failWith: retryable }));
  router.register(new FakeProvider('b', {}));

  const result = await router.chat('chat', [{ role: 'user', content: 'halo' }]);
  assert.equal(result.provider, 'b');
  assert.equal(result.text, 'ok:b:halo');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].name, 'a');
});

test('non-retryable error pun tetap fallback ke provider lain (beda provider, bukan retry)', async () => {
  const router = new ProviderRouter({ routes: { chat: ['a', 'b'] } });
  router.register(new FakeProvider('a', { failWith: permanent }));
  router.register(new FakeProvider('b', {}));
  const result = await router.chat('chat', [{ role: 'user', content: 'x' }]);
  assert.equal(result.provider, 'b');
});

test('semua kandidat gagal -> AllProvidersFailedError dengan daftar attempts', async () => {
  const router = new ProviderRouter({ routes: { chat: ['a', 'b'] } });
  router.register(new FakeProvider('a', { failWith: retryable }));
  router.register(new FakeProvider('b', { failWith: permanent }));
  await assert.rejects(
    () => router.chat('chat', []),
    (err) => {
      assert.ok(err instanceof AllProvidersFailedError);
      assert.equal(err.attempts.length, 2);
      return true;
    },
  );
});

test('circuit breaker: provider di-open setelah threshold gagal, kemudian diskip', async () => {
  const router = new ProviderRouter({
    routes: { chat: ['a', 'b'] },
    breaker: { failureThreshold: 2, windowMs: 60_000, cooldownMs: 60_000 },
  });
  const a = new FakeProvider('a', { failWith: retryable });
  const b = new FakeProvider('b', {});
  router.register(a).register(b);

  await router.chat('chat', [{ role: 'user', content: '1' }]); // a fail #1 -> b
  await router.chat('chat', [{ role: 'user', content: '2' }]); // a fail #2 -> breaker open
  assert.equal(a.calls, 2);

  await router.chat('chat', [{ role: 'user', content: '3' }]); // a diskip (open) -> langsung b
  assert.equal(a.calls, 2);

  const status = router.status().find((s) => s.name === 'a');
  assert.equal(status.state, 'circuit-open');
});

test('direct call(name, ...) menghormati breaker dan melempar error apa adanya', async () => {
  const router = new ProviderRouter({});
  router.register(new FakeProvider('a', { failWith: permanent }));
  await assert.rejects(() => router.call('a', []), (err) => err.status === 401);
});

test('task tanpa route langsung ditolak', async () => {
  const router = new ProviderRouter({ routes: {} });
  await assert.rejects(() => router.chat('gaib', []), AllProvidersFailedError);
});

test('usage hook dipanggil saat sukses (untuk tracking cost/rate-limit)', async () => {
  const usages = [];
  const router = new ProviderRouter({ routes: { chat: ['a'] }, onUsage: (u) => usages.push(u) });
  router.register(new FakeProvider('a', {}));
  await router.chat('chat', [{ role: 'user', content: 'halo' }]);
  assert.equal(usages.length, 1);
  assert.deepEqual({ provider: usages[0].provider, prompt: usages[0].promptTokens, completion: usages[0].completionTokens },
    { provider: 'a', prompt: 3, completion: 5 });
});

test('sukses me-reset riwayat kegagalan (breaker tidak false-positive)', async () => {
  const router = new ProviderRouter({
    routes: { chat: ['a'] },
    breaker: { failureThreshold: 2, windowMs: 60_000, cooldownMs: 60_000 },
  });
  const a = new FakeProvider('a', { failTimes: 1 });
  router.register(a);
  await assert.rejects(() => router.chat('chat', [{ role: 'user', content: '1' }])); // fail #1, tidak ada kandidat lain
  await router.chat('chat', [{ role: 'user', content: '2' }]); // sukses -> reset
  const status = router.status().find((s) => s.name === 'a');
  assert.equal(status.state, 'ready');
});

test('route melewati provider yang tidak terdaftar', async () => {
  const router = new ProviderRouter({ routes: { chat: ['hantu', 'b'] } });
  router.register(new FakeProvider('b', {}));
  const result = await router.chat('chat', [{ role: 'user', content: 'x' }]);
  assert.equal(result.provider, 'b');
  assert.equal(result.attempts[0].skipped, true);
});

// Provider yang MENGGANTUNG (kasus nyata: endpoint tak menjawab).
class HangingProvider extends AIProvider {
  constructor(name, { respectSignal = true } = {}) {
    super();
    this.name = name;
    this.respectSignal = respectSignal;
    this.lastOptions = null;
  }
  chat(messages, options) {
    this.lastOptions = options;
    if (!this.respectSignal) return new Promise(() => {}); // hang selamanya
    return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () =>
        reject(new ProviderError(`${this.name}: digantung lalu di-abort`, { provider: this.name, retryable: true })));
    });
  }
}

test('budget route: provider menggantung di-abort, total tidak melampaui budget', async () => {
  const router = new ProviderRouter({ routes: { chat: ['slow', 'fast'] }, routeBudgetMs: 150 });
  const slow = new HangingProvider('slow');
  const fast = new FakeProvider('fast', {});
  router.register(slow).register(fast);

  const t0 = Date.now();
  // slow mengonsumsi seluruh budget (digantung 150ms) -> fast tidak sempat dicoba.
  await assert.rejects(() => router.chat('chat', [{ role: 'user', content: 'x' }]), AllProvidersFailedError);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, `harus selesai ~budget 150ms, bukan ${elapsed}ms`);
});

test('budget habis tercatat di attempts dengan skenario field skipped', async () => {
  const router = new ProviderRouter({ routes: { chat: ['slow', 'fast'] }, routeBudgetMs: 150 });
  router.register(new HangingProvider('slow')).register(new FakeProvider('fast', {}));
  await assert.rejects(
    () => router.chat('chat', [{ role: 'user', content: 'x' }]),
    (err) => {
      assert.ok(err instanceof AllProvidersFailedError);
      assert.ok(err.attempts.some((a) => a.name === 'slow' && /abort|budget/.test(a.error)));
      assert.ok(err.attempts.some((a) => a.name === 'fast' && a.skipped === true));
      return true;
    },
  );
});

test('timeout per-task diteruskan ke provider (intent lebih singkat dari default)', async () => {
  const router = new ProviderRouter({
    routes: { intent: ['probe'] },
    taskTimeouts: { intent: 5_000 },
    routeBudgetMs: 80_000,
  });
  const probe = new HangingProvider('probe');
  probe.chat = async (messages, options) => {
    probe.lastOptions = options;
    return { text: 'ok' };
  };
  router.register(probe);
  await router.chat('intent', [{ role: 'user', content: 'x' }]);
  assert.ok(probe.lastOptions.timeoutMs <= 5_000, `intent cap 5s, dapat ${probe.lastOptions.timeoutMs}ms`);
  assert.equal(probe.lastOptions.task, 'intent');
});
