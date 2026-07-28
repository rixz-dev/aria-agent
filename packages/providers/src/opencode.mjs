import { execFile } from 'node:child_process';
import { AIProvider } from './types.mjs';
import { ProviderError } from '@aria/shared';

/**
 * OpenCode — blueprint menandai provider ini "perlu dicek apakah dipakai
 * sebagai coding-agent backend atau model provider". Implementasi v1:
 * dipakai sebagai CODING-AGENT BACKEND via CLI (`opencode run "<prompt>"`),
 * bukan sebagai model provider chat biasa. Kalau binary tidak ada, provider
 * dilaporkan tidak tersedia dan router otomatis melewatinya (fallback).
 */
export class OpenCodeProvider extends AIProvider {
  name = 'opencode';
  kind = 'cli';
  streaming = false;

  constructor({ bin = 'opencode', timeoutMs = 120_000, cwd = process.cwd() } = {}) {
    super();
    this.bin = bin;
    this.timeoutMs = timeoutMs;
    this.cwd = cwd;
  }

  /** @param {import('./types.mjs').ChatMessage[]} messages */
  async chat(messages, options = {}) {
    const prompt = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
    const timeoutMs = options.timeoutMs || this.timeoutMs;
    const run = (args) => new Promise((resolve, reject) => {
      execFile(this.bin, args, { timeout: timeoutMs, cwd: this.cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') {
            return reject(new ProviderError(
              `opencode: binary '${this.bin}' tidak ditemukan — install dulu atau nonaktifkan dari PROVIDERS_ENABLED`,
              { provider: this.name, retryable: false, cause: err },
            ));
          }
          if (err.killed || err.signal === 'SIGTERM') {
            return reject(new ProviderError(`opencode: timeout setelah ${timeoutMs}ms`, { provider: this.name, retryable: true, cause: err }));
          }
          return reject(new ProviderError(`opencode: ${stderr || err.message}`, { provider: this.name, retryable: false, cause: err }));
        }
        resolve(stdout);
      });
    });

    const stdout = await run(['run', prompt]);
    const text = stdout.trim();
    if (!text) {
      throw new ProviderError('opencode: output kosong', { provider: this.name, retryable: true });
    }
    return { text, model: 'opencode-cli' };
  }
}
