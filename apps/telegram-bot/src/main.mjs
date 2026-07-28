import express from 'express';
import { Bot, InlineKeyboard } from 'grammy';
import {
  loadEnvFile, loadConfig, requireForApp, createLogger,
  requireInternalToken, fetchJson, internalAuthHeaders,
} from '@aria/shared';
import { parseApprovalReply } from '@aria/core';

loadEnvFile();
const config = loadConfig();
requireForApp(config, 'telegram-bot');
const logger = createLogger({ scope: 'telegram', ...config.log });

const bot = new Bot(config.telegram.botToken);
const OWNER_IDS = new Set(config.telegram.ownerIds.map(String));

// --- client ke orchestrator (service terpisah, tidak in-process) -----------
const orch = (path, body) => fetchJson(`${config.orchestrator.publicUrl}${path}`, {
  method: body ? 'POST' : 'GET',
  headers: internalAuthHeaders(config),
  body,
  timeoutMs: 90_000, // LLM bisa lambat
  service: 'orchestrator',
});

// --- guard: hanya owner yang boleh mengendalikan ARIA -----------------------
bot.use(async (ctx, next) => {
  const id = String(ctx.from?.id ?? '');
  if (!OWNER_IDS.has(id)) {
    logger.warn('akses ditolak (bukan owner)', { telegramId: id, username: ctx.from?.username });
    if (ctx.chat?.type === 'private') await ctx.reply('Maaf, bot ini privat.').catch(() => {});
    return;
  }
  return next();
});

// --- commands ---------------------------------------------------------------
bot.command(['start', 'help'], (ctx) => replyOrch(ctx, 'help'));

bot.command('status', async (ctx) => replyOrch(ctx, 'status'));
bot.command(['providers', 'provider'], async (ctx) => {
  const data = await orch('/v1/providers');
  const lines = data.providers.map((p) =>
    `• ${p.name} (${p.kind}) — ${p.state}${p.unofficial ? ' [unofficial]' : ''} — ${p.calls} call${p.lastError ? `, err: ${p.lastError.slice(0, 60)}` : ''}`);
  const usage = Object.entries(data.usage24h || {})
    .map(([name, u]) => `• ${name}: ${u.calls} call, ${u.promptTokens}↓ ${u.completionTokens}↑`)
    .join('\n');
  await ctx.reply(['*Providers:*', ...lines, '', '*Pemakaian 24 jam:*', usage || '• (belum ada)'].join('\n'), { parse_mode: 'Markdown' });
});

bot.command('plugins', async (ctx) => {
  const data = await orch('/v1/plugins');
  const plugins = data.plugins.map((p) => `• ${p.name}@${p.version} [${p.type}] — ${p.status}${p.unofficial ? ' [unofficial]' : ''}`);
  const tools = data.tools.map((t) => `  ⚙ ${t.fqName}${t.requiresApproval ? ' (butuh approval)' : ''}`);
  const connectors = data.connectors.map((c) => `  🔌 ${c.fqName}: ${c.methods.join(', ')}`);
  await ctx.reply([
    '*Plugins:*', ...(plugins.length ? plugins : ['• (tidak ada)']),
    '', '*Tools:*', ...(tools.length ? tools : ['• (tidak ada)']),
    '', '*Connectors:*', ...(connectors.length ? connectors : ['• (tidak ada)']),
  ].join('\n'), { parse_mode: 'Markdown' });
});

bot.command('approvals', async (ctx) => {
  const data = await orch(`/v1/approvals?status=pending&chatId=${ctx.chat.id}`);
  if (data.approvals.length === 0) return ctx.reply('Tidak ada approval pending.');
  for (const ap of data.approvals) {
    await ctx.reply(formatApproval(ap), { reply_markup: approvalKeyboard(ap.id) });
  }
});

bot.command(['approve', 'reject'], async (ctx) => {
  const id = ctx.match?.trim();
  const decision = ctx.message.text.startsWith('/approve') ? 'approved' : 'rejected';
  if (!id) return ctx.reply('Pakai: /approve <id> atau /reject <id>');
  await resolveAndReply(ctx, id, decision);
});

// --- inline button approval (jalur 1) ---------------------------------------
bot.callbackQuery(/^appr:([a-f0-9]{6}):(yes|no)$/, async (ctx) => {
  const [, id, choice] = ctx.match;
  await ctx.answerCallbackQuery({ text: choice === 'yes' ? 'Menyetujui…' : 'Menolak…' });
  const decision = choice === 'yes' ? 'approved' : 'rejected';
  try {
    const out = await orch(`/v1/approvals/${id}/resolve`, { decision, by: String(ctx.from.id) });
    await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n—\n${out.reply}`);
  } catch (err) {
    await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n—\n⚠️ ${err.message}`);
  }
});

// --- teks bebas: balasan approval (jalur 2) ATAU pesan biasa -----------------
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;

  const decision = parseApprovalReply(text);
  if (decision) {
    if (decision.id) return resolveAndReply(ctx, decision.id, decision.decision);
    return resolveLatestAndReply(ctx, decision.decision);
  }

  // Pesan biasa -> orchestrator
  const typing = sendTyping(ctx);
  try {
    const out = await orch('/v1/message', { chatId: ctx.chat.id, userId: ctx.from.id, text });
    await replyWithApprovals(ctx, out);
  } catch (err) {
    logger.error('orchestrator gagal', { error: err.message });
    await ctx.reply(`⚠️ Orchestrator bermasalah: ${err.message}`);
  } finally {
    clearInterval(typing);
  }
});

// --- helpers ----------------------------------------------------------------
async function replyOrch(ctx, text) {
  try {
    const out = await orch('/v1/message', { chatId: ctx.chat.id, userId: ctx.from.id, text });
    await ctx.reply(out.reply, { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.reply(`⚠️ Orchestrator bermasalah: ${err.message}`);
  }
}

async function replyWithApprovals(ctx, out) {
  if (out.reply) await safeMarkdownReply(ctx, out.reply);
  for (const ap of out.approvals || []) {
    await ctx.reply(formatApproval(ap), { reply_markup: approvalKeyboard(ap.id) });
  }
}

async function resolveAndReply(ctx, id, decision) {
  try {
    const out = await orch(`/v1/approvals/${id}/resolve`, { decision, by: String(ctx.from.id) });
    await safeMarkdownReply(ctx, out.reply);
  } catch (err) {
    await ctx.reply(`⚠️ ${err.message}`);
  }
}

async function resolveLatestAndReply(ctx, decision) {
  try {
    const out = await orch('/v1/approvals/resolve-latest', { chatId: String(ctx.chat.id), decision, by: String(ctx.from.id) });
    await safeMarkdownReply(ctx, out.reply);
  } catch (err) {
    await ctx.reply(`⚠️ ${err.message}`);
  }
}

/**
 * Prompt approval. Blueprint risiko: tanpa whitelist kontak, jadi tujuan
 * pesan WAJIB ditampilkan menonjol supaya tidak salah approve.
 */
function formatApproval(ap) {
  const lines = [
    `⏳ *Approval #${ap.id}* — ${escapeMd(ap.summary)}`,
  ];
  if (ap.target) lines.push(`👤 *TUJUAN: ${escapeMd(ap.target)}*`);
  if (ap.draft) lines.push('', '📝 Draft:', escapeMd(ap.draft));
  if (ap.expiresAt) lines.push('', `⌛ berlaku sampai ${new Date(ap.expiresAt).toLocaleTimeString('id-ID')}`);
  lines.push('', 'Balas *ya* / *tolak*, atau:');
  return lines.join('\n');
}

function approvalKeyboard(id) {
  return new InlineKeyboard()
    .text('✅ Setuju', `appr:${id}:yes`)
    .text('❌ Tolak', `appr:${id}:no`);
}

/** Telegram Markdown v1 sensitif terhadap underscore/link mentah — fallback aman. */
async function safeMarkdownReply(ctx, text) {
  try {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(text);
  }
}

function escapeMd(s) {
  return String(s).replace(/([_*`\[])/g, '\\$1');
}

function sendTyping(ctx) {
  ctx.replyWithChatAction('typing').catch(() => {});
  return setInterval(() => ctx.replyWithChatAction('typing').catch(() => {}), 4000);
}

// --- server notify: orchestrator mendorong event async ke sini ---------------
const notifyApp = express();
notifyApp.use(express.json({ limit: '256kb' }));
notifyApp.use(requireInternalToken(config));

notifyApp.post('/notify/message', async (req, res) => {
  const { chatId, text } = req.body || {};
  if (!chatId || !text) return res.status(400).json({ error: 'butuh chatId & text' });
  await bot.api.sendMessage(chatId, text).catch((err) => logger.warn('gagal kirim notif', { error: err.message }));
  res.json({ ok: true });
});

notifyApp.post('/notify/approval', async (req, res) => {
  const ap = req.body?.approval;
  if (!ap?.id || !ap?.chatId) return res.status(400).json({ error: 'payload approval invalid' });
  await bot.api.sendMessage(ap.chatId, formatApproval(ap), { reply_markup: approvalKeyboard(ap.id) })
    .catch((err) => logger.warn('gagal kirim approval', { error: err.message }));
  res.json({ ok: true });
});

notifyApp.get('/health', (req, res) => res.json({ ok: true }));

// --- start -------------------------------------------------------------------
const server = notifyApp.listen(config.telegram.notifyPort, config.bindHost, () => {
  logger.info(`notify endpoint berjalan di ${config.bindHost}:${config.telegram.notifyPort}`);
});

bot.catch((err) => logger.error('bot error', { error: String(err.error || err) }));

const shutdown = async () => {
  logger.info('shutdown...');
  try { await bot.stop(); } catch { /* long-poll abort saat stop — aman diabaikan */ }
  server.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

bot.start({
  onStart: (me) => logger.info(`bot Telegram @${me.username} aktif (long polling)`),
});
