import { findChatByName } from './services.mjs';

const TRANSCRIPT_CHAR_CAP = 12_000;

/**
 * Service "Ringkas Chat" (blueprint §3/§6): ambil chat dari bot WA lalu minta
 * ProviderRouter meringkas. Baca-saja → TANPA approval.
 */
export async function summarizeWaChat({ wa, router, chatName, sinceMs, logger }) {
  const { chats } = await wa.chats();
  const { match, candidates } = findChatByName(chats, chatName);
  if (!match) {
    const hint = candidates.length
      ? `Maksudmu salah satu ini? ${candidates.map((c) => c.name).join(', ')}`
      : chatName
        ? `Aku tidak menemukan chat bernama "${chatName}".`
        : 'Sebutkan nama kontak/grupnya.';
    return { ok: false, text: `❌ ${hint}` };
  }

  const { messages } = await wa.messages(match.jid, { since: sinceMs, limit: 300 });
  if (!messages || messages.length === 0) {
    return { ok: true, text: `Tidak ada pesan di "${match.name}" pada rentang waktu itu.` };
  }

  const transcript = buildTranscript(messages, TRANSCRIPT_CHAR_CAP);
  logger?.info('meringkas chat', { chat: match.name, pesan: messages.length });

  const system = [
    'Ringkas percakapan WhatsApp berikut dalam Bahasa Indonesia.',
    'Format: 3-6 bullet poin utama, lalu sebutkan action item/janji yang muncul (kalau ada).',
    'Jangan mengarang isi yang tidak ada di transkrip.',
  ].join('\n');
  const user = [
    `Chat: ${match.name}${match.isGroup ? ' (grup)' : ''}`,
    `Jumlah pesan: ${messages.length}`,
    '',
    transcript,
  ].join('\n');

  const result = await router.chat('summarize', [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { temperature: 0.2, maxTokens: 1200 });

  const period = new Date(sinceMs).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  return {
    ok: true,
    text: `📋 *Ringkasan "${match.name}"* (sejak ${period}, ${messages.length} pesan, via ${result.provider}):\n\n${result.text}`,
  };
}

function buildTranscript(messages, cap) {
  const lines = messages.map((m) => {
    const time = new Date(m.ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    return `[${time}] ${m.fromMe ? 'aku' : m.from}: ${m.text}`;
  });
  let out = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    // Prioritaskan pesan terbaru kalau transkrip kepanjangan.
    if ((out.length + lines[i].length) > cap) break;
    out = lines[i] + '\n' + out;
  }
  return out.trim();
}
