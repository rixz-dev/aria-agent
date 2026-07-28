import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PluginError } from '@aria/shared';
import { validateManifest } from './manifest.mjs';
import { ToolRegistry, ConnectorRegistry } from './registry.mjs';

const TOOL_BREAKER = { failureThreshold: 5, windowMs: 60_000, cooldownMs: 60_000 };

/**
 * PluginManager — blueprint §5 ("addon ala Minecraft Bedrock": nambah
 * kemampuan tanpa ubah kode inti orchestrator).
 *
 * Tanggung jawab:
 *  - Scan folder /plugins, load + validasi manifest.json tiap plugin.
 *  - Register ke registry yang sesuai: tool registry / connector registry /
 *    provider registry (ProviderRouter).
 *  - Permission gate: plugin hanya dapat kemampuan yang dideklarasikan di
 *    manifest (network, env, providers, memory).
 *  - Eksekusi tool dengan timeout + circuit breaker per tool.
 *  - Status plugin (aktif/error) dipersist lewat pluginStates repo.
 *
 * CATATAN blueprint milestone: v1 menjalankan plugin in-process dengan
 * timeout + circuit breaker. Plugin ai-provider UNOFFICIAL (auth cookie/
 * session) ditandai `unofficial` — isolasi proses terpisah (worker) adalah
 * milestone Plugin Manager v2 agar kegagalan/deteksi provider tak menjatuhkan
 * orchestrator; hook `runIsolated` di bawah adalah titik ekstensinya.
 */
export class PluginManager {
  /**
   * @param {{ dir: string, providerRouter?: object, states?: object,
   *           memory?: object, logger?: object, now?: () => number }} deps
   */
  constructor({ dir, providerRouter, states, memory, logger, now = Date.now } = {}) {
    this.dir = resolve(dir || './plugins');
    this.providerRouter = providerRouter || null;
    this.states = states || null;
    this.memory = memory || null;
    this.logger = logger;
    this.now = now;

    this.tools = new ToolRegistry();
    this.connectors = new ConnectorRegistry();
    /** pluginName -> { manifest, status: 'active'|'error', error?, runIsolated } */
    this.plugins = new Map();
    /** fqToolName -> { failures: number[], openUntil: number } */
    this.toolHealth = new Map();
  }

  /** Scan + load semua plugin. Plugin rusak tidak menghentikan yang lain. */
  async loadAll() {
    if (!existsSync(this.dir)) {
      this.logger?.warn(`folder plugins tidak ada: ${this.dir} — dilewati`);
      return { loaded: [], failed: [] };
    }
    const entries = await readdir(this.dir, { withFileTypes: true });
    const loaded = [];
    const failed = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = join(this.dir, entry.name);
      try {
        await this.#loadOne(pluginDir);
        loaded.push(entry.name);
      } catch (err) {
        const wrapped = err instanceof PluginError ? err : new PluginError(err.message, { plugin: entry.name, cause: err });
        this.logger?.error('plugin gagal di-load', { plugin: entry.name, error: wrapped.message });
        this.plugins.set(entry.name, { manifest: null, status: 'error', error: wrapped.message });
        await this.states?.upsert({ name: entry.name, version: '0.0.0', type: 'tool', enabled: false, status: 'error', lastError: wrapped.message });
        failed.push(entry.name);
      }
    }
    this.logger?.info('plugin scan selesai', { loaded: loaded.length, failed: failed.length });
    return { loaded, failed };
  }

  async #loadOne(pluginDir) {
    const manifestPath = join(pluginDir, 'manifest.json');
    if (!existsSync(manifestPath)) throw new PluginError('manifest.json tidak ditemukan', { plugin: pluginDir });
    const raw = JSON.parse(await readFile(manifestPath, 'utf8'));
    const manifest = validateManifest(raw, { dir: pluginDir });

    const entryPath = join(pluginDir, manifest.entry);
    if (!existsSync(entryPath)) throw new PluginError(`entry '${manifest.entry}' tidak ditemukan`, { plugin: manifest.name });

    const module = await import(pathToFileURL(entryPath).href);
    const register = module.register ?? module.default;
    if (typeof register !== 'function') {
      throw new PluginError('entry harus mengekspor function register(ctx)', { plugin: manifest.name });
    }

    const ctx = this.#buildContext(manifest, pluginDir);
    await register(ctx);

    this.plugins.set(manifest.name, { manifest, status: 'active', runIsolated: null });
    await this.states?.upsert({
      name: manifest.name,
      version: manifest.version,
      type: manifest.type,
      enabled: true,
      status: 'ok',
      lastError: null,
    });
  }

  /** Context terbatas yang diterima plugin — permission gate ada di sini. */
  #buildContext(manifest, pluginDir) {
    const perms = new Set(manifest.permissions);
    const log = this.logger?.child(`plugin:${manifest.name}`) ?? console;

    const requirePerm = (perm) => {
      if (!perms.has(perm)) {
        throw new PluginError(`plugin '${manifest.name}' butuh permission '${perm}' (deklarasikan di manifest)`, { plugin: manifest.name });
      }
    };

    const manager = this;
    const ctx = {
      pluginName: manifest.name,
      manifest,
      log,

      /** fetch dengan timeout — wajib permission "network". */
      async http(url, options = {}) {
        requirePerm('network');
        const timeoutMs = options.timeoutMs ?? 10_000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(url, { ...options, signal: controller.signal });
          return res;
        } finally {
          clearTimeout(timer);
        }
      },

      /** akses env var — wajib permission "env" (untuk API key plugin sendiri). */
      env(name) {
        requirePerm('env');
        return process.env[name];
      },

      tools: {
        register: (tool) => manager.tools.register(tool, manifest.name),
      },

      connectors: {
        register: (connector) => manager.connectors.register(connector, manifest.name),
      },

      providers: {
        register: (provider) => {
          requirePerm('providers');
          manager.#registerProvider(manifest, provider);
        },
      },

      /** KV memory namespace per-plugin — wajib permission "memory". */
      memory: {
        get: async (key) => { requirePerm('memory'); return manager.memory?.get(`plugin:${manifest.name}:${key}`) ?? null; },
        set: async (key, value) => { requirePerm('memory'); await manager.memory?.set(`plugin:${manifest.name}:${key}`, value); },
      },
    };
    return ctx;
  }

  /** Daftarkan provider plugin ke ProviderRouter dengan dekorator timeout. */
  #registerProvider(manifest, provider) {
    if (!this.providerRouter) throw new PluginError('provider router tidak tersedia', { plugin: manifest.name });
    if (!provider || typeof provider.name !== 'string' || typeof provider.chat !== 'function') {
      throw new PluginError('provider plugin wajib punya { name, chat(messages, options) }', { plugin: manifest.name });
    }
    const original = provider.chat.bind(provider);
    const timeoutMs = provider.timeoutMs ?? 30_000;
    provider.chat = (messages, options = {}) => withTimeout(
      original(messages, options),
      timeoutMs,
      `provider plugin '${provider.name}' timeout ${timeoutMs}ms`,
    );
    // Blueprint risiko §9: provider unofficial (cookie/scrape) diberi flag agar
    // termonitor jelas di status & siap dipindah ke proses terisolasi (v2).
    provider.unofficial = manifest.unofficial;
    this.providerRouter.register(provider);
    this.logger?.info('provider terdaftar dari plugin', {
      plugin: manifest.name,
      provider: provider.name,
      unofficial: manifest.unofficial,
    });
  }

  /**
   * Eksekusi tool dengan timeout + circuit breaker.
   * Dipanggil orchestrator/agent loop; bukan oleh user langsung.
   */
  async callTool(fqName, args = {}, ctx = {}) {
    const tool = this.tools.get(fqName);
    if (!tool) throw new PluginError(`tool '${fqName}' tidak ditemukan`);

    const health = this.toolHealth.get(fqName) || { failures: [], openUntil: 0 };
    if (health.openUntil > this.now()) {
      throw new PluginError(`tool '${fqName}' circuit-open (sering gagal), coba lagi nanti`, { retryable: true });
    }

    try {
      const result = await withTimeout(
        Promise.resolve().then(() => tool.handler(args, ctx)),
        tool.timeoutMs,
        `tool '${fqName}' timeout setelah ${tool.timeoutMs}ms`,
      );
      health.failures = [];
      this.toolHealth.set(fqName, health);
      return result;
    } catch (err) {
      const now = this.now();
      health.failures = [...health.failures.filter((t) => now - t < TOOL_BREAKER.windowMs), now];
      if (health.failures.length >= TOOL_BREAKER.failureThreshold) {
        health.openUntil = now + TOOL_BREAKER.cooldownMs;
        this.logger?.warn('tool circuit-open', { tool: fqName, cooldownMs: TOOL_BREAKER.cooldownMs });
      }
      this.toolHealth.set(fqName, health);
      if (err instanceof PluginError) throw err;
      throw new PluginError(err.message, { cause: err });
    }
  }

  /** Status semua plugin untuk command /plugins. */
  status() {
    const out = [];
    for (const [name, p] of this.plugins) {
      out.push({
        name,
        version: p.manifest?.version ?? '?',
        type: p.manifest?.type ?? '?',
        unofficial: p.manifest?.unofficial ?? false,
        status: p.status,
        error: p.error ?? null,
      });
    }
    return out;
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new PluginError(message, { retryable: true })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
