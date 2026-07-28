import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { ChatStore } from './store.mjs';

/**
 * Manajer koneksi WhatsApp (Baileys). Service ini jalan mandiri; orchestrator
 * memanggilnya via HTTP. Belum scan QR = status linked:false, endpoint kirim
 * menjawab 503 — orchestrator tetap hidup normal.
 */
export class WaConnection {
  constructor({ authDir, logger }) {
    this.authDir = authDir;
    this.logger = logger;
    this.store = new ChatStore();
    this.sock = null;
    this.linked = false;
    this.me = null;
    this.connecting = null;
    this.baileysLog = pino({ level: 'warn' });
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this.#connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async #connect() {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.baileysLog) },
      logger: this.baileysLog,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        this.logger.warn('Butuh pairing — scan QR ini dari WhatsApp (Perangkat Tertaut):');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        this.linked = true;
        this.me = sock.user?.id || null;
        this.logger.info('WhatsApp tersambung', { me: this.me });
      }
      if (connection === 'close') {
        this.linked = false;
        const status = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = status === DisconnectReason.loggedOut;
        this.logger.warn('koneksi WA tertutup', { status, loggedOut });
        if (!loggedOut) {
          setTimeout(() => this.connect().catch((e) => this.logger.error('reconnect gagal', { error: e.message })), 3000);
        } else {
          this.logger.error('Sesi WA logout — hapus auth dir & scan QR ulang untuk pairing lagi');
        }
      }
    });

    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) this.store.upsertChat(c.id, { name: c.name || c.notify });
    });

    sock.ev.on('chats.upsert', (chats) => {
      for (const c of chats) this.store.upsertChat(c.id, { name: c.name });
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const msg of messages) {
        try {
          await this.#indexMessage(msg);
        } catch (err) {
          this.logger.debug('gagal indeks pesan', { error: err.message });
        }
      }
    });
  }

  async #indexMessage(msg) {
    const jid = msg.key?.remoteJid;
    if (!jid || jid === 'status@broadcast') return;

    const text = extractText(msg);
    if (!text) return;

    const isGroup = jid.endsWith('@g.us');
    if (!this.store.chats.get(jid)?.name || this.store.chats.get(jid).name === jid) {
      // nama grup diambil malas; nama kontak dari pushName pesan berikutnya
      if (isGroup) {
        this.sock.groupMetadata(jid)
          .then((meta) => this.store.upsertChat(jid, { name: meta.subject, isGroup: true }))
          .catch(() => {});
      }
    }
    if (!isGroup && msg.pushName) this.store.upsertChat(jid, { name: msg.pushName, isGroup: false });

    this.store.addMessage(jid, {
      id: msg.key.id,
      from: isGroup ? (msg.pushName || msg.key.participant || '?') : (msg.key.fromMe ? 'aku' : (msg.pushName || jid)),
      fromMe: Boolean(msg.key.fromMe),
      text: text.slice(0, 2000),
      ts: Number(msg.messageTimestamp) * 1000,
    });
  }

  status() {
    return { linked: this.linked, me: this.me, chats: this.store.chats.size };
  }

  requireLinked() {
    if (!this.linked || !this.sock) {
      const err = new Error('WhatsApp belum terhubung (belum scan QR / koneksi putus)');
      err.status = 503;
      throw err;
    }
  }

  async sendMessage(jid, text) {
    this.requireLinked();
    await this.sock.sendMessage(jid, { text });
    return { jid, note: `terkirim ke ${jid}` };
  }
}

function extractText(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    null
  );
}
