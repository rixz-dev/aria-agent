import { ServiceCallError } from './errors.mjs';

export const INTERNAL_TOKEN_HEADER = 'x-aria-token';

/** Anth: header rahasia internal untuk semua call antar-service. */
export function internalAuthHeaders(config) {
  return { [INTERNAL_TOKEN_HEADER]: config.internalToken };
}

/**
 * Middleware Express: tolak request tanpa token internal yang benar.
 */
export function requireInternalToken(config) {
  return (req, res, next) => {
    if (req.headers[INTERNAL_TOKEN_HEADER] !== config.internalToken) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}

/**
 * fetch JSON dengan timeout + normalisasi error. Dipakai untuk komunikasi
 * antar-service di dalam VPS (bukan untuk provider AI — itu punya layer sendiri).
 */
export async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 15_000, service = url } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }
    if (!res.ok) {
      const message = data?.error || `${method} ${url} -> ${res.status}`;
      throw new ServiceCallError(message, {
        service,
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    return data;
  } catch (err) {
    if (err instanceof ServiceCallError) throw err;
    if (err.name === 'AbortError') {
      throw new ServiceCallError(`${service}: timeout setelah ${timeoutMs}ms`, { service, retryable: true, cause: err });
    }
    throw new ServiceCallError(`${service}: ${err.message}`, { service, retryable: true, cause: err });
  } finally {
    clearTimeout(timer);
  }
}
