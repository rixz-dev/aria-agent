import { AllProvidersFailedError, ProviderError } from '@aria/shared';

const DEFAULT_BREAKER = { failureThreshold: 3, windowMs: 60_000, cooldownMs: 120_000 };

/**
 * ProviderRouter — lihat blueprint §4.
 *
 * Dua cara pakai:
 *   router.call('gemini', messages, opts)   // panggil provider tertentu langsung
 *   router.chat('summarize', messages, opts) // pilih otomatis per-task + fallback
 *
 * Fitur:
 *  - Fallback otomatis: error retryable (429/5xx/timeout/jaringan) -> kandidat
 *    berikutnya dalam chain task. Error non-retryable (401/config) -> langsung
 *    lempar kalau direct call; loncat ke kandidat berikutnya kalau routed call.
 *  - Circuit breaker per provider: >=N gagal dalam window -> "open" selama
 *    cooldown, dilewati router.
 *  - Usage tracking: setiap sukses, hook onUsage dipanggil (untuk risiko §9:
 *    cost/rate-limit tiap provider beda — perlu visibility).
 */
export class ProviderRouter {
  /**
   * @param {{ routes?: Record<string, string[]>,
   *           breaker?: Partial<typeof DEFAULT_BREAKER>,
   *           onUsage?: (entry: object) => void|Promise<void>,
   *           logger?: import('@aria/shared').createLogger }} cfg
   */
  constructor({ routes = {}, breaker = {}, onUsage, logger } = {}) {
    this.providers = new Map();
    this.routes = routes;
    this.breaker = { ...DEFAULT_BREAKER, ...breaker };
    this.onUsage = onUsage || (() => {});
    this.logger = logger;
    /** name -> { failures: number[], openUntil: number, lastError?: string, calls: number } */
    this.health = new Map();
  }

  /** @param {import('./types.mjs').AIProvider} provider */
  register(provider) {
    if (this.providers.has(provider.name)) {
      throw new ProviderError(`provider '${provider.name}' sudah terdaftar`, { provider: provider.name });
    }
    this.providers.set(provider.name, provider);
    this.health.set(provider.name, { failures: [], openUntil: 0, calls: 0, lastError: null });
    return this;
  }

  has(name) {
    return this.providers.has(name);
  }

  get(name) {
    const provider = this.providers.get(name);
    if (!provider) throw new ProviderError(`provider '${name}' tidak terdaftar`, { provider: name });
    return provider;
  }

  /** Panggilan langsung ke provider tertentu — blueprint: providerRouter.call(name, payload). */
  async call(name, messages, options = {}) {
    const provider = this.get(name);
    this.#assertNotOpen(name);
    try {
      const result = await provider.chat(messages, options);
      this.#recordSuccess(name, result, options.task || 'direct');
      return result;
    } catch (err) {
      this.#recordFailure(name, err);
      if (err instanceof ProviderError || err?.code) throw err;
      throw new ProviderError(`${name}: ${err.message}`, { provider: name, retryable: false, cause: err });
    }
  }

  /**
   * Routed call: coba kandidat dalam chain task berurutan, fallback saat gagal.
   * @param {string} task — 'intent' | 'planning' | 'chat' | 'summarize' | 'coding' | custom
   */
  async chat(task, messages, options = {}) {
    const chain = this.routes[task] || [];
    if (chain.length === 0) {
      throw new AllProvidersFailedError(`tidak ada route untuk task '${task}'`);
    }
    const attempts = [];
    for (const name of chain) {
      if (!this.providers.has(name)) {
        attempts.push({ name, error: 'tidak terdaftar', skipped: true });
        continue;
      }
      if (this.#isOpen(name)) {
        attempts.push({ name, error: 'circuit-open', skipped: true });
        continue;
      }
      try {
        const result = await this.call(name, messages, { ...options, task });
        if (attempts.length > 0) {
          this.logger?.info('provider fallback berhasil', { task, provider: name, setelah: attempts.map((a) => a.name) });
        }
        return { ...result, provider: name, attempts: attempts.length ? attempts : undefined };
      } catch (err) {
        attempts.push({ name, error: err.message, status: err.status });
        this.logger?.warn('provider gagal, coba kandidat berikutnya', { task, provider: name, error: err.message });
        // Non-retryable (mis. 401/config) tetap lanjut ke kandidat lain — chain
        // adalah daftar provider berbeda, bukan retry provider yang sama.
        continue;
      }
    }
    throw new AllProvidersFailedError(`semua provider untuk task '${task}' gagal/terbuka`, { attempts });
  }

  /** Snapshot status untuk endpoint /providers & command Telegram. */
  status() {
    const out = [];
    for (const [name, provider] of this.providers) {
      const h = this.health.get(name);
      out.push({
        ...(provider.describe ? {} : {}),
        name,
        kind: provider.kind,
        streaming: provider.streaming,
        unofficial: provider.unofficial || false,
        state: this.#isOpen(name) ? 'circuit-open' : 'ready',
        calls: h.calls,
        lastError: h.lastError,
        openUntil: h.openUntil ? new Date(h.openUntil).toISOString() : null,
      });
    }
    return out;
  }

  #isOpen(name) {
    const h = this.health.get(name);
    return Boolean(h && h.openUntil > Date.now());
  }

  #assertNotOpen(name) {
    if (this.#isOpen(name)) {
      throw new ProviderError(`provider '${name}' circuit-open sampai ${new Date(this.health.get(name).openUntil).toISOString()}`, {
        provider: name,
        retryable: true,
      });
    }
  }

  #recordSuccess(name, result, task) {
    const h = this.health.get(name);
    h.failures = [];
    h.openUntil = 0;
    h.calls += 1;
    h.lastError = null;
    if (result.usage && (result.usage.promptTokens || result.usage.completionTokens)) {
      void this.onUsage({
        provider: name,
        model: result.model,
        task,
        promptTokens: result.usage.promptTokens || 0,
        completionTokens: result.usage.completionTokens || 0,
        at: new Date(),
      });
    }
  }

  #recordFailure(name, err) {
    const h = this.health.get(name);
    h.calls += 1;
    h.lastError = err.message;
    const now = Date.now();
    h.failures = [...h.failures.filter((t) => now - t < this.breaker.windowMs), now];
    if (h.failures.length >= this.breaker.failureThreshold) {
      h.openUntil = now + this.breaker.cooldownMs;
      this.logger?.warn('circuit breaker OPEN', { provider: name, cooldownMs: this.breaker.cooldownMs });
    }
  }
}
