/**
 * @typedef {{ name: string, slots: object, source: 'rule'|'llm'|'fallback', confidence: number }} Intent
 *
 * Intent yang dikenali orchestrator (v1):
 *  - wa.summarize { chat: string, sincePhrase: string }
 *  - wa.send      { target: string, instruction: string }
 *  - memory.note  { text: string }
 *  - status / help
 *  - chat         { }  (fallback — diteruskan ke LLM biasa)
 */

const SUMMARIZE_RE = /\b(ringkas(?:kan)?|rangkum|summari[sz]e|summary)\b/i;
const CHAT_WORD_RE = /\b(chat|grup|group|wa|whatsapp)\b/i;
const SEND_RE = /^(?:tom\s+)?(?:kirim(?:kan)?|bales|balas|kabari|bilang(?:in)?)\s+(?:chat\s+|pesan\s+|wa\s+)?(?:ke(?:pada)?\s+)?(.+?)\s*(?:bilang|bahwa|isinya|pesannya|kalau|kalo|:)\s+([\s\S]+)$/i;
const NOTE_RE = /^(?:ingat(?:kan)?|catat|simpan)\s*[::]?\s+([\s\S]+)$/i;

/**
 * IntentParser dua tahap:
 *  1. Rule-based (cepat, deterministik, hemat token) — untuk pola umum Indonesia.
 *  2. LLM fallback via ProviderRouter task 'intent' (model murah/cepat sesuai route).
 * Jika LLM gagal/timeout → intent 'chat' (aman: tidak ada side effect).
 */
export class IntentParser {
  constructor({ router, logger, clock = () => new Date() } = {}) {
    this.router = router || null;
    this.logger = logger;
    this.clock = clock;
  }

  /** @param {string} text @returns {Promise<Intent>} */
  async parse(text) {
    const trimmed = text.trim();

    const rule = this.#ruleBased(trimmed);
    if (rule) return rule;

    if (this.router) {
      try {
        const llm = await this.#llmBased(trimmed);
        if (llm) return llm;
      } catch (err) {
        this.logger?.warn('LLM intent parsing gagal — fallback ke chat', { error: err.message });
      }
    }
    return { name: 'chat', slots: {}, source: 'fallback', confidence: 0.5 };
  }

  #ruleBased(text) {
    if (/^(status|ping|health|info)$/i.test(text)) {
      return { name: 'status', slots: {}, source: 'rule', confidence: 1 };
    }
    if (/^(help|bantuan|menu)$/i.test(text)) {
      return { name: 'help', slots: {}, source: 'rule', confidence: 1 };
    }

    const note = text.match(NOTE_RE);
    if (note) {
      return { name: 'memory.note', slots: { text: note[1].trim() }, source: 'rule', confidence: 0.9 };
    }

    const send = text.match(SEND_RE);
    if (send) {
      return {
        name: 'wa.send',
        slots: { target: normalizeTarget(send[1]), instruction: send[2].trim() },
        source: 'rule',
        confidence: 0.85,
      };
    }

    if (SUMMARIZE_RE.test(text) && CHAT_WORD_RE.test(text)) {
      const chatName = extractChatName(text);
      return {
        name: 'wa.summarize',
        slots: { chat: chatName, sincePhrase: text },
        source: 'rule',
        confidence: chatName ? 0.85 : 0.6,
      };
    }

    return null;
  }

  #llmBased(text) {
    const system = [
      'Kamu adalah intent parser untuk personal agent bernama ARIA.',
      'Klasifikasikan pesan user ke SATU intent berikut dan jawab HANYA dengan JSON valid:',
      '',
      '{"intent": "...", "slots": {...}}',
      '',
      'Intent yang tersedia:',
      '- "wa.summarize": user minta ringkasan chat WhatsApp. slots: {"chat": "<nama kontak/grup>", "sincePhrase": "<frasa waktu asli, mis. kemarin / 2 hari>"}',
      '- "wa.send": user minta kirim/balas pesan ke seseorang. slots: {"target": "<nama/nomor>", "instruction": "<isi/inti pesan>"}',
      '- "memory.note": user minta mengingat/mencatat sesuatu. slots: {"text": "..."}',
      '- "status": user tanya status sistem.',
      '- "help": user minta daftar kemampuan.',
      '- "chat": obrolan biasa / tidak cocok kategori di atas. slots: {}',
      '',
      'Jangan mengarang target pesan. Kalau ragu antara wa.send dan chat, pilih chat.',
    ].join('\n');

    return this.router.chat('intent', [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ], { jsonMode: true, temperature: 0, maxTokens: 300 }).then((result) => {
      const parsed = extractJson(result.text);
      if (!parsed || typeof parsed.intent !== 'string') return null;
      const known = new Set(['wa.summarize', 'wa.send', 'memory.note', 'status', 'help', 'chat']);
      if (!known.has(parsed.intent)) return null;
      return {
        name: parsed.intent,
        slots: typeof parsed.slots === 'object' && parsed.slots ? parsed.slots : {},
        source: 'llm',
        confidence: parsed.intent === 'chat' ? 0.7 : 0.8,
      };
    });
  }
}

/** Ubah frasa waktu Indonesia jadi timestamp "sejak" (ms epoch). */
export function parseSince(phrase, now = Date.now()) {
  const text = String(phrase || '').toLowerCase();
  const day = 24 * 3600 * 1000;

  const rel = text.match(/(\d+)\s*(jam|hari|pekan|minggu|menit)\b/);
  if (rel) {
    const n = Number.parseInt(rel[1], 10);
    const unit = rel[2];
    const ms = unit === 'menit' ? n * 60_000
      : unit === 'jam' ? n * 3600_000
      : unit === 'hari' ? n * day
      : n * 7 * day;
    return now - ms;
  }
  if (/kemarin/.test(text)) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime() - day;
  }
  if (/(hari ini|today)/.test(text)) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  // Masuk akal untuk "ringkas chat" tanpa frasa waktu: 24 jam terakhir.
  return now - day;
}

function extractChatName(text) {
  // "ringkas chat grup keluarga dari kemarin" → "keluarga"
  const m = text.match(/(?:chat|grup|group)\s+(?:wa\s+|whatsapp\s+)?(?:grup\s+|group\s+)?([a-z0-9&'@.\- ]+?)(?:\s+(?:dari|sejak|selama|untuk|mulai|yang|dihari|di hari|kemarin|hari|ini|tdk|tolong|ya|dong)|\s*$)/i);
  return m ? m[1].trim() : '';
}

function normalizeTarget(raw) {
  return raw.trim().replace(/^(nomor|kontak|wa)\s+/i, '');
}

export function extractJson(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
