import express from 'express';
import { loadEnvFile, loadConfig, createLogger, requireInternalToken } from '@aria/shared';
import { WaConnection } from './connection.mjs';
import { resolveToJid } from './store.mjs';

loadEnvFile();
const config = loadConfig();
const logger = createLogger({ scope: 'whatsapp', ...config.log });

const wa = new WaConnection({ authDir: config.whatsapp.authDir, logger });
await wa.connect();

const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(requireInternalToken(config));

app.get('/status', (req, res) => res.json(wa.status()));

app.get('/chats', (req, res) => {
  wa.requireLinked();
  res.json({ chats: wa.store.listChats() });
});

app.get('/chats/:jid/messages', (req, res) => {
  const { since, limit } = req.query;
  res.json({ messages: wa.store.messages(req.params.jid, { since, limit }) });
});

// Blueprint: tanpa whitelist kontak — siapa pun boleh jadi tujuan, guard-nya
// adalah approval gate di orchestrator yang menampilkan tujuan dengan jelas.
app.post('/send-message', async (req, res, next) => {
  try {
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: 'butuh "to" dan "text"' });
    wa.requireLinked();
    const jid = resolveToJid(to, wa.store);
    logger.info('kirim pesan WA', { to, jid, panjang: text.length });
    res.json(await wa.sendMessage(jid, text));
  } catch (err) { next(err); }
});

// Nama kontak → JID (dipakai sebelum kirim bila perlu)
app.get('/resolve/:name', (req, res, next) => {
  try {
    res.json({ jid: resolveToJid(req.params.name, wa.store) });
  } catch (err) { next(err); }
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message });
});

const server = app.listen(config.whatsapp.servicePort, () => {
  logger.info(`WA service berjalan di :${config.whatsapp.servicePort}`, wa.status());
});

const shutdown = () => {
  logger.info('shutdown...');
  server.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
