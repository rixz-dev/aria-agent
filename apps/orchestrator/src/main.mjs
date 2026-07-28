import express from 'express';
import {
  loadEnvFile, loadConfig, createLogger,
  requireInternalToken, fetchJson, internalAuthHeaders, ApprovalError,
} from '@aria/shared';
import { createRepos } from '@aria/db';
import { createProviderRouter } from '@aria/providers';
import { PluginManager } from '@aria/plugins';
import { ApprovalGate, Orchestrator, ServiceRegistry, WaClient } from '@aria/core';

loadEnvFile();
const config = loadConfig();
const logger = createLogger({ scope: 'orchestrator', ...config.log });

async function main() {
  // 1. Database (state, memory, approval log, plugin registry — blueprint §3)
  const repos = await createRepos(config, logger.child('db'));

  // 2. Provider Router v1 (blueprint §4) + tracking usage ke DB (risiko §9)
  const router = createProviderRouter(config, {
    logger: logger.child('providers'),
    onUsage: (entry) => repos.usage.record(entry).catch((err) =>
      logger.warn('gagal mencatat usage provider', { error: err.message })),
  });

  // 3. Plugin Manager (blueprint §5) — scan /plugins, register tool/connector/provider
  const plugins = new PluginManager({
    dir: config.pluginsDir,
    providerRouter: router,
    states: repos.pluginStates,
    memory: repos.memory,
    logger: logger.child('plugins'),
  });
  await plugins.loadAll();

  // 4. Approval gate + service registry + orchestrator core (blueprint §3)
  const gate = new ApprovalGate({ repo: repos.approvals, ttlMs: config.approvalTtlMs, logger: logger.child('approval') });
  const services = new ServiceRegistry().register('wa', new WaClient(config));
  const orchestrator = new Orchestrator({ repos, router, plugins, services, gate, logger: logger.child('core') });

  // Notifier: dorong event async (approval expired) ke antarmuka Telegram
  const notifyTelegram = (path, body) =>
    fetchJson(`${config.telegram.notifyUrl}${path}`, {
      method: 'POST',
      headers: internalAuthHeaders(config),
      body,
      timeoutMs: 5_000,
      service: 'telegram-notify',
    }).catch((err) => logger.warn('notify gagal (telegram bot jalan?)', { error: err.message }));

  gate.on('expired', (ap) => {
    void notifyTelegram('/notify/message', { chatId: ap.chatId, text: `⌛ Approval #${ap.id} (${ap.summary}) kedaluwarsa tanpa keputusan. Tidak ada aksi yang dijalankan.` });
  });

  // Sweeper kedaluwarsa approval
  const sweeper = setInterval(() => {
    gate.expireDue().catch((err) => logger.warn('sweeper approval gagal', { error: err.message }));
  }, 30_000);
  sweeper.unref();

  // 5. HTTP API internal (dipanggil bot Telegram & service lain di VPS)
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (req, res) => {
    res.json({ ok: true, db: repos.kind, uptimeSec: Math.floor(process.uptime()) });
  });

  app.use('/v1', requireInternalToken(config));

  app.post('/v1/message', async (req, res, next) => {
    try {
      const { chatId, userId, text, channel } = req.body || {};
      if (!chatId || !userId || !text) return res.status(400).json({ error: 'butuh chatId, userId, text' });
      const out = await orchestrator.handleUserMessage({ channel: channel || 'telegram', chatId, userId, text });
      res.json(out);
    } catch (err) { next(err); }
  });

  app.get('/v1/approvals', async (req, res, next) => {
    try {
      const status = req.query.status || 'pending';
      const rows = await repos.approvals.list({ status: status === 'all' ? null : status, chatId: req.query.chatId || null, limit: 20 });
      res.json({ approvals: rows });
    } catch (err) { next(err); }
  });

  app.post('/v1/approvals/:id/resolve', async (req, res, next) => {
    try {
      const { decision, by = 'telegram' } = req.body || {};
      if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'decision harus approved|rejected' });
      const out = await orchestrator.resolveApproval(req.params.id, decision, by);
      res.json({ ...out, approval: out.approval });
    } catch (err) { next(err); }
  });

  // Jalur balasan teks tanpa id: pakai approval pending terbaru di chat itu.
  app.post('/v1/approvals/resolve-latest', async (req, res, next) => {
    try {
      const { chatId, decision, by = 'telegram' } = req.body || {};
      if (!chatId || !['approved', 'rejected'].includes(decision)) {
        return res.status(400).json({ error: 'butuh chatId dan decision approved|rejected' });
      }
      const latest = await gate.latestPending(chatId);
      if (!latest) return res.status(404).json({ error: 'tidak ada approval pending di chat ini' });
      const out = await orchestrator.resolveApproval(latest.id, decision, by);
      res.json(out);
    } catch (err) { next(err); }
  });

  app.get('/v1/providers', async (req, res, next) => {
    try {
      res.json({ providers: router.status(), usage24h: await repos.usage.totals({}) });
    } catch (err) { next(err); }
  });

  app.get('/v1/plugins', (req, res) => {
    res.json({ plugins: plugins.status(), tools: plugins.tools.list(), connectors: plugins.connectors.list() });
  });

  // Normalisasi error -> JSON
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err instanceof ApprovalError ? 404 : (err.status || 500);
    if (status >= 500) logger.error('request error', { error: err.message, path: req.path });
    res.status(status).json({ error: err.message });
  });

  const server = app.listen(config.orchestrator.port, () => {
    logger.info(`orchestrator berjalan di :${config.orchestrator.port}`, {
      db: repos.kind,
      providers: router.status().map((p) => `${p.name}:${p.state}`),
      plugins: plugins.status().map((p) => `${p.name}:${p.status}`),
    });
  });

  const shutdown = async () => {
    logger.info('shutdown...');
    clearInterval(sweeper);
    server.close();
    await repos.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('orchestrator gagal start', { error: err.message });
  process.exit(1);
});
