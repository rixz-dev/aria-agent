/** Error ter-normalisasi yang dipakai di seluruh codebase ARIA. */

export class AriaError extends Error {
  constructor(message, { code = 'ARIA_ERROR', retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = retryable;
  }
}

/** Kesalahan konfigurasi — hampir selalu butuh intervensi manusia. */
export class ConfigError extends AriaError {
  constructor(message, opts = {}) {
    super(message, { code: 'CONFIG_ERROR', retryable: false, ...opts });
  }
}

/**
 * Kesalahan provider AI.
 * `retryable: true` (429/5xx/timeout/jaringan) -> ProviderRouter akan mencoba
 * kandidat fallback berikutnya.
 */
export class ProviderError extends AriaError {
  constructor(message, { provider, status, retryable = false, cause } = {}) {
    super(message, { code: 'PROVIDER_ERROR', retryable, cause });
    this.provider = provider;
    this.status = status;
  }
}

/** Semua provider kandidat gagal / sedang circuit-open. */
export class AllProvidersFailedError extends AriaError {
  constructor(message, { attempts = [] } = {}) {
    super(message, { code: 'ALL_PROVIDERS_FAILED', retryable: true });
    this.attempts = attempts;
  }
}

/** Plugin tidak valid / gagal saat load / saat eksekusi. */
export class PluginError extends AriaError {
  constructor(message, { plugin, retryable = false, cause } = {}) {
    super(message, { code: 'PLUGIN_ERROR', retryable, cause });
    this.plugin = plugin;
  }
}

/** Panggilan HTTP antar-service gagal. */
export class ServiceCallError extends AriaError {
  constructor(message, { service, status, retryable = true, cause } = {}) {
    super(message, { code: 'SERVICE_CALL_ERROR', retryable, cause });
    this.service = service;
    this.status = status;
  }
}

/** Approval tidak ditemukan / sudah tidak pending. */
export class ApprovalError extends AriaError {
  constructor(message, opts = {}) {
    super(message, { code: 'APPROVAL_ERROR', retryable: false, ...opts });
  }
}
