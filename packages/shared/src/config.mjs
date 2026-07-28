import { existsSync } from 'node:fs';
import { ConfigError } from './errors.mjs';

/** Muat file .env kalau ada (Node >=20.6 punya process.loadEnvFile bawaan). */
export function loadEnvFile(path = '.env') {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

const DEFAULT_DEV_TOKEN = 'dev-insecure-token';

/**
 * Bangun objek konfigurasi ter-validasi dari env. Satu-satunya tempat yang
 * membaca process.env — modul lain menerima config lewat parameter (DI),
 * sehingga test tidak perlu menyentuh env global.
 */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';

  const internalToken = env.ARIA_INTERNAL_TOKEN || DEFAULT_DEV_TOKEN;
  if (isProd && internalToken === DEFAULT_DEV_TOKEN) {
    throw new ConfigError('ARIA_INTERNAL_TOKEN wajib di-set di production.');
  }

  const providersEnabled = csv(env.PROVIDERS_ENABLED || 'nvidia,gemini,openrouter,opencode');

  const providerDefs = {
    nvidia: {
      apiKey: env.NVIDIA_API_KEY || '',
      baseUrl: env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
      model: env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct',
    },
    gemini: {
      apiKey: env.GEMINI_API_KEY || '',
      baseUrl: env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: env.GEMINI_MODEL || 'gemini-2.5-flash',
    },
    openrouter: {
      apiKey: env.OPENROUTER_API_KEY || '',
      baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      model: env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct',
      headers: {
        ...(env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': env.OPENROUTER_SITE_URL } : {}),
        ...(env.OPENROUTER_APP_NAME ? { 'X-Title': env.OPENROUTER_APP_NAME } : {}),
      },
    },
    opencode: {
      bin: env.OPENCODE_BIN || 'opencode',
      timeoutMs: int(env.OPENCODE_TIMEOUT_MS, 120_000),
    },
  };

  const routes = {
    intent: csv(env.ROUTE_INTENT || 'gemini,nvidia,openrouter'),
    planning: csv(env.ROUTE_PLANNING || 'nvidia,openrouter,gemini'),
    chat: csv(env.ROUTE_CHAT || 'openrouter,nvidia,gemini'),
    summarize: csv(env.ROUTE_SUMMARIZE || 'gemini,openrouter,nvidia'),
    coding: csv(env.ROUTE_CODING || 'opencode,openrouter,nvidia'),
  };

  for (const [task, chain] of Object.entries(routes)) {
    if (chain.length === 0) throw new ConfigError(`ROUTE_${task.toUpperCase()} tidak boleh kosong.`);
  }

  const providerTuning = {
    // Timeout per attempt. Intent parsing harus cepat — provider yang menggantung
    // tidak boleh menguras budget request (temuan deploy: nvidia hang 60s x2
    // melampaui timeout 90s di sisi Telegram).
    requestTimeoutMs: int(env.PROVIDER_TIMEOUT_MS, 45_000),
    intentTimeoutMs: int(env.PROVIDER_INTENT_TIMEOUT_MS, 20_000),
    // Budget total satu routed call (semua percobaan fallback digabung).
    routeBudgetMs: int(env.PROVIDER_ROUTE_BUDGET_MS, 80_000),
  };

  const config = {
    nodeEnv,
    isProd,
    internalToken,
    bindHost: env.ARIA_BIND_HOST || '127.0.0.1',
    databaseUrl: env.DATABASE_URL || '',
    approvalTtlMs: int(env.APPROVAL_TTL_MS, 300_000),
    pluginsDir: env.PLUGINS_DIR || './plugins',
    log: {
      format: env.LOG_FORMAT || (isProd ? 'json' : 'pretty'),
      level: env.LOG_LEVEL || 'info',
    },
    providers: { enabled: providersEnabled, defs: providerDefs, routes, tuning: providerTuning },
    orchestrator: {
      port: int(env.ORCHESTRATOR_PORT, 4100),
      publicUrl: stripSlash(env.ORCHESTRATOR_PUBLIC_URL || `http://localhost:${int(env.ORCHESTRATOR_PORT, 4100)}`),
    },
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN || '',
      ownerIds: csv(env.TELEGRAM_OWNER_IDS || '').map(String),
      notifyPort: int(env.TELEGRAM_NOTIFY_PORT, 4200),
      notifyUrl: stripSlash(env.TELEGRAM_NOTIFY_URL || `http://localhost:${int(env.TELEGRAM_NOTIFY_PORT, 4200)}`),
    },
    whatsapp: {
      servicePort: int(env.WA_SERVICE_PORT, 4300),
      serviceUrl: stripSlash(env.WA_SERVICE_URL || `http://localhost:${int(env.WA_SERVICE_PORT, 4300)}`),
      authDir: env.WA_AUTH_DIR || './data/wa-auth',
    },
  };

  return config;
}

/** Validasi yang hanya relevan untuk app tertentu — dipanggil app bersangkutan. */
export function requireForApp(config, appName) {
  if (appName === 'telegram-bot' && !config.telegram.botToken) {
    throw new ConfigError('TELEGRAM_BOT_TOKEN belum diisi. Dapatkan dari @BotFather.');
  }
  if (appName === 'telegram-bot' && config.telegram.ownerIds.length === 0) {
    throw new ConfigError('TELEGRAM_OWNER_IDS belum diisi (ID numeric Telegram kamu, via @userinfobot).');
  }
}

function csv(value) {
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function stripSlash(url) {
  return url.replace(/\/+$/, '');
}
