import { OpenAICompatProvider } from './openai-compat.mjs';
import { OpenCodeProvider } from './opencode.mjs';
import { ProviderRouter } from './router.mjs';

export * from './types.mjs';
export * from './openai-compat.mjs';
export * from './opencode.mjs';
export * from './router.mjs';

/**
 * Bangun ProviderRouter dari config hasil @aria/shared loadConfig().
 * Daftarkan 4 provider resmi blueprint: nvidia, gemini, openrouter, opencode.
 * Provider plugin didaftarkan terpisah oleh PluginManager lewat router.register().
 */
export function createProviderRouter(config, { onUsage, logger } = {}) {
  const { enabled, defs, routes } = config.providers;
  const router = new ProviderRouter({ routes, onUsage, logger: logger?.child('router') });

  for (const name of enabled) {
    switch (name) {
      case 'nvidia':
        router.register(new OpenAICompatProvider({ name, ...defWithHeaders(defs.nvidia) }));
        break;
      case 'gemini':
        router.register(new OpenAICompatProvider({ name, ...defWithHeaders(defs.gemini) }));
        break;
      case 'openrouter':
        router.register(new OpenAICompatProvider({ name, ...defWithHeaders(defs.openrouter) }));
        break;
      case 'opencode':
        router.register(new OpenCodeProvider(defs.opencode));
        break;
      default:
        logger?.warn(`provider '${name}' di PROVIDERS_ENABLED tidak dikenal — dilewati`);
    }
  }
  return router;
}

function defWithHeaders(def) {
  const { headers, ...rest } = def;
  return { ...rest, extraHeaders: headers || {} };
}
