import pg from 'pg';

const { Pool } = pg;

/**
 * Implementasi PostgreSQL. Interface identik dengan memory-repos sehingga
 * orchestrator tidak peduli backend mana yang aktif.
 */
export function createPgRepos(databaseUrl, logger) {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });

  const q = (text, params) => pool.query(text, params);

  return {
    kind: 'postgres',
    pool,

    /** Terapkan schema.sql idempotent sekali saat boot. */
    async migrate(schemaSql) {
      await q(schemaSql);
      logger?.info('schema database diterapkan');
    },

    messages: {
      async add({ channel, chatId, userId, role, content }) {
        const r = await q(
          `INSERT INTO messages (channel, chat_id, user_id, role, content)
           VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at AS "createdAt"`,
          [channel, chatId, userId, role, content],
        );
        return { id: r.rows[0].id, createdAt: r.rows[0].createdAt };
      },
      async recent(chatId, limit = 20) {
        const r = await q(
          `SELECT id, channel, chat_id AS "chatId", user_id AS "userId", role, content, created_at AS "createdAt"
           FROM messages WHERE chat_id = $1 ORDER BY created_at DESC LIMIT $2`,
          [chatId, limit],
        );
        return r.rows.reverse();
      },
    },

    approvals: {
      async create(a) {
        await q(
          `INSERT INTO approvals (id, chat_id, user_id, summary, target, draft, action, status, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
          [a.id, a.chatId, a.userId, a.summary, a.target ?? null, a.draft ?? null, JSON.stringify(a.action), a.expiresAt ?? null],
        );
        return a;
      },
      async get(id) {
        const r = await q(
          `SELECT id, chat_id AS "chatId", user_id AS "userId", summary, target, draft,
                  action, status, decided_by AS "decidedBy", result,
                  created_at AS "createdAt", expires_at AS "expiresAt", resolved_at AS "resolvedAt"
           FROM approvals WHERE id = $1`,
          [id],
        );
        return r.rows[0] || null;
      },
      async update(id, fields) {
        const map = {
          status: 'status',
          decidedBy: 'decided_by',
          result: 'result',
          resolvedAt: 'resolved_at',
        };
        const sets = [];
        const values = [id];
        for (const [jsKey, col] of Object.entries(map)) {
          if (fields[jsKey] !== undefined) {
            values.push(fields[jsKey]);
            sets.push(`${col} = $${values.length}`);
          }
        }
        if (sets.length === 0) return this.get(id);
        await q(`UPDATE approvals SET ${sets.join(', ')} WHERE id = $1`, values);
        return this.get(id);
      },
      async list({ status = null, chatId = null, limit = 10 } = {}) {
        const conds = [];
        const values = [];
        if (status) { values.push(status); conds.push(`status = $${values.length}`); }
        if (chatId) { values.push(chatId); conds.push(`chat_id = $${values.length}`); }
        values.push(limit);
        const r = await q(
          `SELECT id, chat_id AS "chatId", user_id AS "userId", summary, target, draft, action, status,
                  decided_by AS "decidedBy", created_at AS "createdAt", expires_at AS "expiresAt", resolved_at AS "resolvedAt"
           FROM approvals ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
           ORDER BY created_at DESC LIMIT $${values.length}`,
          values,
        );
        return r.rows;
      },
    },

    pluginStates: {
      async upsert({ name, version, type, enabled = true, status = 'ok', lastError = null }) {
        await q(
          `INSERT INTO plugin_states (name, version, type, enabled, status, last_error, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6, now())
           ON CONFLICT (name) DO UPDATE SET version=$2, type=$3, enabled=$4, status=$5, last_error=$6, updated_at=now()`,
          [name, version, type, enabled, status, lastError],
        );
      },
      async get(name) {
        const r = await q(
          `SELECT name, version, type, enabled, status, last_error AS "lastError", updated_at AS "updatedAt"
           FROM plugin_states WHERE name = $1`,
          [name],
        );
        return r.rows[0] || null;
      },
      async list() {
        const r = await q(
          `SELECT name, version, type, enabled, status, last_error AS "lastError", updated_at AS "updatedAt"
           FROM plugin_states ORDER BY name`,
        );
        return r.rows;
      },
    },

    usage: {
      async record({ provider, model, task, promptTokens = 0, completionTokens = 0 }) {
        await q(
          `INSERT INTO provider_usage (provider, model, task, prompt_tokens, completion_tokens)
           VALUES ($1,$2,$3,$4,$5)`,
          [provider, model ?? null, task, promptTokens, completionTokens],
        );
      },
      async totals({ sinceMs = 24 * 3600 * 1000 } = {}) {
        const r = await q(
          `SELECT provider,
                  SUM(prompt_tokens)::int     AS "promptTokens",
                  SUM(completion_tokens)::int AS "completionTokens",
                  COUNT(*)::int               AS calls
           FROM provider_usage WHERE created_at > now() - ($1 || ' milliseconds')::interval
           GROUP BY provider`,
          [String(sinceMs)],
        );
        return Object.fromEntries(r.rows.map((row) => [row.provider, row]));
      },
    },

    memory: {
      async set(key, value) {
        await q(
          `INSERT INTO memory (key, value, updated_at) VALUES ($1,$2, now())
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
          [key, JSON.stringify(value)],
        );
      },
      async get(key) {
        const r = await q('SELECT value FROM memory WHERE key = $1', [key]);
        return r.rows[0]?.value ?? null;
      },
      async keys(prefix = '') {
        const r = await q('SELECT key FROM memory WHERE key LIKE $1 ORDER BY key', [`${prefix}%`]);
        return r.rows.map((row) => row.key);
      },
    },

    async close() {
      await pool.end();
    },
  };
}
