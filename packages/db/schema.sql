-- ==========================================================================
-- ARIA — schema PostgreSQL (blueprint §5 & tech stack: state, memory,
-- approval log, plugin registry, usage tracking)
-- Idempotent: aman dijalankan berulang.
-- ==========================================================================

-- Riwayat pesan percakapan (context untuk orchestrator)
CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  channel     TEXT        NOT NULL,             -- 'telegram' | 'whatsapp' | ...
  chat_id     TEXT        NOT NULL,
  user_id     TEXT        NOT NULL,
  role        TEXT        NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, created_at DESC);

-- Approval log (blueprint: selalu dicatat)
CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT        PRIMARY KEY,          -- short id, mis. 'a1b2c3'
  chat_id     TEXT        NOT NULL,
  user_id     TEXT        NOT NULL,
  summary     TEXT        NOT NULL,             -- deskripsi yang ditampilkan ke user
  target      TEXT,                             -- kontak/nomor tujuan (ditonjolkan di prompt)
  draft       TEXT,                             -- draft pesan/aksi
  action      JSONB       NOT NULL,             -- { service, method, params }
  status      TEXT        NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'failed')),
  decided_by  TEXT,
  result      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals (chat_id, status) WHERE status = 'pending';

-- Plugin registry (state persisten; folder /plugins adalah source of truth kode)
CREATE TABLE IF NOT EXISTS plugin_states (
  name        TEXT        PRIMARY KEY,
  version     TEXT        NOT NULL,
  type        TEXT        NOT NULL,
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  status      TEXT        NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error', 'disabled')),
  last_error  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tracking pemakaian provider (blueprint risiko: beda provider beda limit/cost)
CREATE TABLE IF NOT EXISTS provider_usage (
  id                BIGSERIAL PRIMARY KEY,
  provider          TEXT        NOT NULL,
  model             TEXT,
  task              TEXT        NOT NULL,
  prompt_tokens     INTEGER     NOT NULL DEFAULT 0,
  completion_tokens INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_usage_time ON provider_usage (created_at DESC);

-- Memory KV sederhana (catatan user, preferensi, state kecil)
CREATE TABLE IF NOT EXISTS memory (
  key         TEXT        PRIMARY KEY,
  value       JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
