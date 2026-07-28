/**
 * Implementasi in-memory dari semua repository. Dipakai saat DATABASE_URL
 * kosong (dev cepat) dan di unit test. Interface identik dengan pg-repos.
 */
export function createMemoryRepos() {
  const messages = [];
  const approvals = new Map();
  const pluginStates = new Map();
  const usage = [];
  const memory = new Map();
  let msgSeq = 0;
  let approvalSeq = 0;

  return {
    kind: 'memory',

    messages: {
      async add({ channel, chatId, userId, role, content }) {
        const row = { id: ++msgSeq, channel, chatId, userId, role, content, createdAt: new Date() };
        messages.push(row);
        return row;
      },
      async recent(chatId, limit = 20) {
        return messages
          .filter((m) => m.chatId === chatId)
          .slice(-limit);
      },
    },

    approvals: {
      async create(a) {
        approvals.set(a.id, { ...a, _seq: ++approvalSeq });
        return a;
      },
      async get(id) {
        return approvals.get(id) || null;
      },
      async update(id, fields) {
        const cur = approvals.get(id);
        if (!cur) return null;
        const next = { ...cur, ...fields };
        approvals.set(id, next);
        return next;
      },
      async list({ status = null, chatId = null, limit = 10 } = {}) {
        let rows = [...approvals.values()];
        if (status) rows = rows.filter((r) => r.status === status);
        if (chatId) rows = rows.filter((r) => r.chatId === chatId);
        // urut terbaru dulu; _seq menyelesaikan tie timestamp (stabil & deterministik)
        return rows
          .sort((a, b) => (b.createdAt - a.createdAt) || (b._seq - a._seq))
          .slice(0, limit);
      },
    },

    pluginStates: {
      async upsert(state) {
        const next = { ...pluginStates.get(state.name), ...state, updatedAt: new Date() };
        pluginStates.set(state.name, next);
        return next;
      },
      async get(name) {
        return pluginStates.get(name) || null;
      },
      async list() {
        return [...pluginStates.values()];
      },
    },

    usage: {
      async record(entry) {
        usage.push({ ...entry, at: entry.at || new Date() });
      },
      async totals({ sinceMs = 24 * 3600 * 1000 } = {}) {
        const cutoff = Date.now() - sinceMs;
        const by = {};
        for (const u of usage) {
          if (new Date(u.at).getTime() < cutoff) continue;
          by[u.provider] ||= { promptTokens: 0, completionTokens: 0, calls: 0 };
          by[u.provider].promptTokens += u.promptTokens || 0;
          by[u.provider].completionTokens += u.completionTokens || 0;
          by[u.provider].calls += 1;
        }
        return by;
      },
    },

    memory: {
      async set(key, value) {
        memory.set(key, { value, updatedAt: new Date() });
      },
      async get(key) {
        return memory.get(key)?.value ?? null;
      },
      async keys(prefix = '') {
        return [...memory.keys()].filter((k) => k.startsWith(prefix));
      },
    },

    async close() {},
  };
}
