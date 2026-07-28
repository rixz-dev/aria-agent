import { extractJson } from './intent.mjs';

const MAX_TOOL_ROUNDS = 3;

/**
 * AgentRunner — loop ReAct sederhana (blueprint §7: "ReAct loop mirip olympus").
 *
 * Konvensi tool-call provider-agnostic: model disuruh membalas dengan SATU
 * blok ```action {"tool": "<fq.name>", "args": {...}}``` bila perlu tool.
 * Tidak bergantung pada fitur native tool-calling masing-masing provider,
 * jadi semua provider resmi + plugin provider bisa ikutan.
 *
 * Tool ber-requiresApproval TIDAK dieksekusi otomatis — dikembalikan sebagai
 * pendingApproval supaya orchestrator mengeluarkan approval request dulu
 * (prinsip: selalu minta approval sebelum aksi ber-side-effect).
 */
export class AgentRunner {
  constructor({ router, plugins, logger } = {}) {
    this.router = router;
    this.plugins = plugins;
    this.logger = logger;
  }

  /**
   * @param {Array} history pesan [{role, content}]
   * @returns {Promise<{ text: string, pendingApproval?: object }>}
   */
  async run(history, { task = 'chat' } = {}) {
    const tools = this.plugins?.tools.list() ?? [];
    const messages = [buildSystemPrompt(tools), ...history];
    const workLog = [];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const result = await this.router.chat(task, messages, { temperature: 0.3 });
      const text = result.text || '';
      const action = parseActionBlock(text);

      if (!action) return { text: stripActionBlock(text).trim() || text };

      const tool = this.plugins?.tools.get(action.tool);
      if (!tool) {
        this.logger?.warn('model meminta tool yang tidak ada', { tool: action.tool });
        return { text: `Aku butuh tool "${action.tool}" yang tidak tersedia. Coba /plugins untuk cek tool aktif.` };
      }

      if (tool.requiresApproval) {
        return {
          text: '',
          pendingApproval: {
            service: 'tool',
            method: action.tool,
            params: action.args || {},
            sideEffect: true,
            summary: `Agent mau menjalankan tool ${action.tool}(${JSON.stringify(action.args || {})})`,
          },
        };
      }

      let observation;
      try {
        const out = await this.plugins.callTool(action.tool, action.args || {}, {});
        observation = truncate(typeof out === 'string' ? out : JSON.stringify(out), 4000);
      } catch (err) {
        observation = `ERROR: ${err.message}`;
      }
      workLog.push({ tool: action.tool, ok: !observation.startsWith('ERROR:') });
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: `[HASIL TOOL ${action.tool}]\n${observation}\n\nLanjutkan jawabanmu untuk user. Boleh panggil tool lain bila perlu.` });
    }

    return { text: 'Aku sudah mencoba beberapa kali tapi belum berhasil menyelesaikan permintaan ini.' };
  }
}

function buildSystemPrompt(tools) {
  const base = [
    'Kamu ARIA, AI agent personal. Jawab dalam bahasa yang sama dengan user (default Indonesia santai tapi jelas).',
    'Jawaban singkat dan langsung; kalau diminta detail baru panjang.',
  ];
  if (tools.length === 0) return { role: 'system', content: base.join('\n') };

  const catalog = tools.map((t) =>
    `- ${t.fqName} — ${t.description || '(tanpa deskripsi)'}; parameters: ${JSON.stringify(t.parameters)}` +
    (t.requiresApproval ? ' [BUTUH APPROVAL USER]' : ''),
  ).join('\n');

  return {
    role: 'system',
    content: [
      ...base,
      '',
      'Tool yang tersedia:',
      catalog,
      '',
      'Untuk memakai tool, balas HANYA dengan satu blok:',
      '```action',
      '{"tool": "<nama.tool>", "args": {...}}',
      '```',
      'Kalau tidak butuh tool, jawab langsung tanpa blok action.',
      'Tool bertanda BUTUH APPROVAL tidak boleh kamu eksekusi diam-diam — minta lewat blok action, sistem akan meminta izin user.',
    ].join('\n'),
  };
}

export function parseActionBlock(text) {
  const m = String(text).match(/```action\s*([\s\S]*?)```/i);
  if (!m) return null;
  const parsed = extractJson(m[1]);
  if (!parsed || typeof parsed.tool !== 'string') return null;
  return { tool: parsed.tool.trim(), args: parsed.args && typeof parsed.args === 'object' ? parsed.args : {} };
}

function stripActionBlock(text) {
  return String(text).replace(/```action[\s\S]*?```/gi, '');
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '\n…[dipotong]' : s;
}
