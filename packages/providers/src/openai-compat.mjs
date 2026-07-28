import { AIProvider } from './types.mjs';
import { ProviderError, ConfigError } from '@aria/shared';

/**
 * Provider generik untuk semua endpoint OpenAI-compatible:
 * build.nvidia.com (NIM), Gemini (endpoint /openai resmi), OpenRouter,
 * dan provider plugin official lainnya cukup reuse class ini.
 */
export class OpenAICompatProvider extends AIProvider {
  kind = 'chat';
  streaming = true;

  /**
   * @param {{ name: string, baseUrl: string, apiKey: string, model: string,
   *            extraHeaders?: Record<string,string>, timeoutMs?: number }} cfg
   */
  constructor(cfg) {
    super();
    this.name = cfg.name;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.apiKey = cfg.apiKey;
    this.defaultModel = cfg.model;
    this.extraHeaders = cfg.extraHeaders || {};
    this.timeoutMs = cfg.timeoutMs ?? 60_000;
  }

  configured() {
    return Boolean(this.apiKey);
  }

  /** @param {import('./types.mjs').ChatMessage[]} messages */
  async chat(messages, options = {}) {
    if (!this.configured()) {
      throw new ConfigError(`provider '${this.name}': API key belum di-set`);
    }
    const model = options.model || this.defaultModel;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const payload = {
      model,
      messages,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };

    let res;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new ProviderError(`${this.name}: timeout ${this.timeoutMs}ms`, { provider: this.name, retryable: true, cause: err });
      }
      throw new ProviderError(`${this.name}: ${err.message}`, { provider: this.name, retryable: true, cause: err });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderError(`${this.name}: HTTP ${res.status} — ${body.slice(0, 300)}`, {
        provider: this.name,
        status: res.status,
        retryable,
      });
    }

    const data = await res.json();
    const choice = data.choices?.[0]?.message;
    if (!choice?.content && choice?.content !== '') {
      throw new ProviderError(`${this.name}: response tanpa choices`, { provider: this.name, retryable: true });
    }
    return {
      text: choice.content,
      model: data.model || model,
      usage: {
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
        totalTokens: data.usage?.total_tokens,
      },
      raw: data,
    };
  }

  async describe() {
    return { ...(await super.describe()), model: this.defaultModel, configured: this.configured() };
  }
}
