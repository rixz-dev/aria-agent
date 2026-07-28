import { fetchJson, internalAuthHeaders } from '@aria/shared';

/**
 * ServiceRegistry: nama service -> client object. Client bisa:
 *  - service bawaan (wa, system)
 *  - connector dari plugin (didudukkan di sini juga via PluginManager registry)
 */
export class ServiceRegistry {
  #services = new Map();

  register(name, client) {
    this.#services.set(name, client);
    return this;
  }

  get(name) {
    return this.#services.get(name) || null;
  }

  list() {
    return [...this.#services.keys()];
  }
}

/**
 * Client HTTP untuk whatsapp-bot service (blueprint: bot WA diekspose sebagai
 * service yang dipanggil orchestrator; tanpa whitelist kontak — approval
 * prompt yang menjaga, bukan allowlist nomor).
 */
export class WaClient {
  constructor(config) {
    this.baseUrl = config.whatsapp.serviceUrl;
    this.headers = internalAuthHeaders(config);
    this.timeoutMs = 20_000;
  }

  #call(path, { method = 'GET', body } = {}) {
    return fetchJson(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body,
      timeoutMs: this.timeoutMs,
      service: 'whatsapp',
    });
  }

  status() {
    return this.#call('/status');
  }

  /** Daftar chat: [{ jid, name, isGroup }] */
  chats() {
    return this.#call('/chats');
  }

  messages(jid, { since, limit = 200 } = {}) {
    const params = new URLSearchParams();
    if (since) params.set('since', String(since));
    params.set('limit', String(limit));
    return this.#call(`/chats/${encodeURIComponent(jid)}/messages?${params}`);
  }

  /** Kirim pesan. `to` boleh nama kontak, nomor, atau JID — dinormalisasi di service. */
  sendMessage(to, text) {
    return this.#call('/send-message', { method: 'POST', body: { to, text } });
  }
}

/** Pencocokan chat by-nama yang toleran (case-insensitive, substring). */
export function findChatByName(chats, name) {
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return { match: null, candidates: chats.slice(0, 5) };

  const exact = chats.find((c) => c.name?.toLowerCase() === needle);
  if (exact) return { match: exact, candidates: [] };

  const partial = chats.filter((c) => c.name?.toLowerCase().includes(needle));
  if (partial.length === 1) return { match: partial[0], candidates: [] };
  return { match: null, candidates: partial.slice(0, 5) };
}
