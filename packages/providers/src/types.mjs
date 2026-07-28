import { ProviderError } from '@aria/shared';

/**
 * @typedef {'system'|'user'|'assistant'|'tool'} ChatRole
 * @typedef {{ role: ChatRole, content: string, name?: string, tool_call_id?: string }} ChatMessage
 * @typedef {{ promptTokens?: number, completionTokens?: number, totalTokens?: number }} TokenUsage
 * @typedef {{ text: string, model?: string, usage?: TokenUsage, raw?: unknown }} ChatResult
 * @typedef {{ model?: string, temperature?: number, maxTokens?: number, jsonMode?: boolean, signal?: AbortSignal }} ChatOptions
 */

/**
 * Kontrak seragam untuk SEMUA provider AI — official maupun yang datang dari
 * plugin (lihat blueprint §4). Orchestrator tidak pernah memanggil provider
 * secara langsung; selalu lewat ProviderRouter.
 */
export class AIProvider {
  /** @type {string} nama unik, dipakai di route config (mis. 'gemini') */
  name = 'unnamed';
  /** @type {'chat'|'cli'} */
  kind = 'chat';
  /** @type {boolean} */
  streaming = false;
  /** @type {boolean} provider unofficial (cookie/scrape) — ditandai plugin manager */
  unofficial = false;

  /**
   * @param {ChatMessage[]} _messages
   * @param {ChatOptions} [_options]
   * @returns {Promise<ChatResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async chat(_messages, _options = {}) {
    throw new ProviderError(`provider '${this.name}' belum mengimplementasikan chat()`, {
      provider: this.name,
      retryable: false,
    });
  }

  /** Status singkat untuk /providers. Provider bisa override dengan ping nyata. */
  async describe() {
    return { name: this.name, kind: this.kind, streaming: this.streaming };
  }
}
