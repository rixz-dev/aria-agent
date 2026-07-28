const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Logger kecil tanpa dependency. Dua format:
 *  - pretty (dev):  "12:00:01 INFO  [orchestrator] pesan"
 *  - json   (prod): {"ts":"...","level":"info","scope":"...","msg":"..."}
 */
export function createLogger({ scope = 'aria', level = 'info', format = 'pretty' } = {}) {
  const minLevel = LEVELS[level] ?? LEVELS.info;

  function emit(lv, msg, meta) {
    if (LEVELS[lv] < minLevel) return;
    const ts = new Date();
    if (format === 'json') {
      const line = JSON.stringify({ ts: ts.toISOString(), level: lv, scope, msg, ...(meta ? { meta } : {}) });
      (lv === 'error' || lv === 'warn' ? process.stderr : process.stdout).write(line + '\n');
      return;
    }
    const time = ts.toTimeString().slice(0, 8);
    const tag = lv.toUpperCase().padEnd(5);
    const extra = meta && Object.keys(meta).length ? ' ' + safeJson(meta) : '';
    (lv === 'error' || lv === 'warn' ? process.stderr : process.stdout)
      .write(`${time} ${tag} [${scope}] ${msg}${extra}\n`);
  }

  return {
    scope,
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
    child: (childScope) => createLogger({ scope: `${scope}:${childScope}`, level, format }),
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value, (key, val) => (val instanceof Error ? serializeError(val) : val));
  } catch {
    return '[unserializable meta]';
  }
}

/**
 * Error -> object loggable. Menangani kasus tricky:
 *  - AggregateError (message sering "" di Node 20): ikutkan sub-error codes
 *  - cause chain: ikutkan pesan penyebabnya
 */
function serializeError(err) {
  const out = { name: err.name, code: err.code, message: err.message };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  if (Array.isArray(err.errors) && err.errors.length > 0) {
    out.errors = err.errors.map((e) => `${e.code || '?'}: ${e.message || ''}`.slice(0, 120));
  }
  if (err.cause instanceof Error) out.cause = `${err.cause.code || ''} ${err.cause.message}`.trim();
  if (out.message === '' && !out.errors) out.message = String(err);
  return out;
}
