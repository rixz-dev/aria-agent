const MAX_CHATS = 200;
const MAX_MESSAGES_PER_CHAT = 1000;

/**
 * Penyimpanan chat & pesan in-memory. Cukup untuk use-case "ringkas chat dari
 * kemarin" (pesan lama tetap ada di HP; service ini mengindeks yang lewat
 * sejak bot menyala). Persist ke DB bisa ditambah belakangan tanpa ubah API.
 */
export class ChatStore {
  constructor() {
    /** jid -> { jid, name, isGroup } */
    this.chats = new Map();
    /** jid -> [{ id, from, fromMe, text, ts }] */
    this.messagesByJid = new Map();
  }

  upsertChat(jid, { name, isGroup } = {}) {
    const cur = this.chats.get(jid) || { jid, name: jid, isGroup: jid.endsWith('@g.us') };
    if (name) cur.name = name;
    if (isGroup !== undefined) cur.isGroup = isGroup;
    this.chats.set(jid, cur);
    if (this.chats.size > MAX_CHATS) {
      const oldest = this.chats.keys().next().value;
      this.chats.delete(oldest);
      this.messagesByJid.delete(oldest);
    }
  }

  addMessage(jid, msg) {
    const list = this.messagesByJid.get(jid) || [];
    list.push(msg);
    if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT);
    this.messagesByJid.set(jid, list);
  }

  listChats() {
    return [...this.chats.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  messages(jid, { since, limit = 200 } = {}) {
    const list = this.messagesByJid.get(jid) || [];
    const filtered = since ? list.filter((m) => m.ts >= Number(since)) : list;
    return filtered.slice(-Number(limit));
  }
}

/** Normalisasi tujuan pesan: nama kontak / nomor / JID (tanpa whitelist). */
export function resolveToJid(to, store) {
  const raw = String(to || '').trim();
  if (!raw) throw new Error('tujuan kosong');

  if (raw.includes('@')) return raw; // sudah JID

  // Nomor: tanpa huruf, digit >= 8 setelah dibersihkan (mis. "0812…", "+62 812…")
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 8 && !/[a-zA-Z]/.test(raw)) {
    const normalized = digits.startsWith('0') ? '62' + digits.slice(1) : digits; // 08xx -> 62xx
    return `${normalized}@s.whatsapp.net`;
  }

  // anggap nama kontak/grup
  const needle = raw.toLowerCase();
  const chats = store.listChats();
  const exact = chats.find((c) => c.name.toLowerCase() === needle);
  if (exact) return exact.jid;
  const partial = chats.filter((c) => c.name.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0].jid;
  if (partial.length > 1) {
    throw new Error(`nama "${raw}" ambigu: ${partial.slice(0, 5).map((c) => c.name).join(', ')}`);
  }
  throw new Error(`kontak/grup "${raw}" tidak ditemukan di cache WA (pakai nomor lengkap atau JID)`);
}
