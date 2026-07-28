import { parseSince, IntentParser } from './intent.mjs';
import { AgentRunner } from './agent.mjs';
import { summarizeWaChat } from './summarize.mjs';

const HISTORY_LIMIT = 10;

/**
 * Orchestrator pusat (blueprint §3): intent parsing, task planning,
 * approval gate, routing ke service. Semua channel masuk (Telegram,
 * nanti yang lain) melewati handleUserMessage().
 */
export class Orchestrator {
  /**
   * @param {{ repos: object, router: object, plugins?: object,
   *           services: object, gate: object, logger?: object,
   *           startedAt?: number }} deps
   */
  constructor({ repos, router, plugins = null, services, gate, logger, startedAt = Date.now() }) {
    this.repos = repos;
    this.router = router;
    this.plugins = plugins;
    this.services = services;
    this.gate = gate;
    this.logger = logger;
    this.startedAt = startedAt;
    this.intentParser = new IntentParser({ router, logger: logger?.child('intent') });
    this.agent = new AgentRunner({ router, plugins, logger: logger?.child('agent') });
  }

  /**
   * Titik masuk utama untuk semua pesan user.
   * @returns {Promise<{ reply: string, approvals?: object[] }>}
   */
  async handleUserMessage({ channel = 'telegram', chatId, userId, text }) {
    chatId = String(chatId);
    userId = String(userId);
    const log = this.logger?.child('msg');

    await this.repos.messages.add({ channel, chatId, userId, role: 'user', content: text });

    let response;
    try {
      const intent = await this.intentParser.parse(text);
      log?.info('intent terdeteksi', { intent: intent.name, source: intent.source });
      response = await this.#dispatch(intent, { chatId, userId, text });
    } catch (err) {
      log?.error('gagal memproses pesan', { error: err.message });
      response = { reply: `⚠️ Ada masalah: ${err.message}` };
    }

    await this.repos.messages.add({ channel, chatId, userId: 'aria', role: 'assistant', content: response.reply });
    return response;
  }

  async #dispatch(intent, ctx) {
    switch (intent.name) {
      case 'help':
        return { reply: helpText() };

      case 'status':
        return { reply: await this.buildStatus() };

      case 'memory.note': {
        const key = `note:${new Date().toISOString()}`;
        await this.repos.memory.set(key, { text: intent.slots.text, chatId: ctx.chatId });
        return { reply: `📝 Dicatat: "${intent.slots.text}"` };
      }

      case 'wa.summarize': {
        const wa = this.services.get('wa');
        if (!wa) return { reply: '❌ Service WhatsApp belum terkonfigurasi.' };
        const sinceMs = parseSince(intent.slots.sincePhrase || ctx.text);
        const { text } = await summarizeWaChat({
          wa,
          router: this.router,
          chatName: intent.slots.chat || '',
          sinceMs,
          logger: this.logger,
        });
        return { reply: text };
      }

      case 'wa.send':
        return this.#handleWaSend(intent, ctx);

      case 'chat':
      default: {
        const history = await this.#history(ctx.chatId);
        const out = await this.agent.run(history, { task: 'chat' });
        if (out.pendingApproval) {
          const approval = await this.gate.request({
            chatId: ctx.chatId,
            userId: ctx.userId,
            summary: out.pendingApproval.summary,
            action: out.pendingApproval,
          });
          return {
            reply: `⏳ Aku mau menjalankan aksi yang butuh izinmu. Approval #${approval.id} sudah dikirim.`,
            approvals: [approval],
          };
        }
        return { reply: out.text };
      }
    }
  }

  /** "Bales chat Budi bilang otw" → susun draft → MINTA APPROVAL (belum kirim). */
  async #handleWaSend(intent, ctx) {
    const { target, instruction } = intent.slots;
    if (!target) return { reply: '❌ Ke siapa pesannya? Sebutkan nama kontak atau nomornya.' };
    if (!instruction) return { reply: '❌ Isi pesannya apa?' };

    const draft = await this.#composeDraft(instruction, ctx);

    // Blueprint risiko: TANPA whitelist kontak — target harus ditampilkan
    // jelas di prompt supaya user tidak salah approve saat buru-buru.
    const approval = await this.gate.request({
      chatId: ctx.chatId,
      userId: ctx.userId,
      summary: 'Kirim pesan WhatsApp',
      target,
      draft,
      action: {
        service: 'wa',
        method: 'sendMessage',
        params: { to: target, text: draft },
        sideEffect: true,
      },
    });

    return {
      reply: `⏳ Draft siap — butuh approval kamu (#${approval.id}).`,
      approvals: [approval],
    };
  }

  async #composeDraft(instruction, ctx) {
    try {
      const result = await this.router.chat('chat', [
        {
          role: 'system',
          content: 'Tulis pesan WhatsApp atas nama user berdasarkan instruksinya. '
            + 'Hanya isi pesannya saja — singkat, natural, sopan, bahasa user. Tanpa tanda kutip, tanpa penjelasan.',
        },
        { role: 'user', content: `Instruksi user: "${instruction}". Tulis pesannya.` },
      ], { temperature: 0.4, maxTokens: 300 });
      const text = result.text.trim().replace(/^["']|["']$/g, '');
      return text || instruction;
    } catch (err) {
      this.logger?.warn('draft via LLM gagal, pakai instruksi mentah', { error: err.message });
      return instruction;
    }
  }

  /**
   * Keputusan approval (dari inline button MAUPUN teks balasan — jalur sama).
   * Aksi hanya dieksekusi SETELAH approved.
   */
  async resolveApproval(id, decision, by) {
    const { approval, changed } = await this.gate.decide(id, decision, by);
    if (!changed) {
      return { approval, reply: `Approval #${id} sudah ${approval.status}.` };
    }
    if (approval.status === 'expired') {
      return { approval, reply: `⌛ Approval #${id} kedaluwarsa.` };
    }
    if (decision === 'rejected') {
      return { approval, reply: `❌ #${id} dibatalkan. Tidak ada aksi yang dijalankan.` };
    }

    try {
      const resultText = await this.executeAction(approval.action);
      await this.gate.recordResult(id, resultText);
      return { approval, reply: `✅ #${id} dieksekusi. ${resultText}` };
    } catch (err) {
      await this.gate.recordResult(id, err.message, true);
      this.logger?.error('eksekusi approval gagal', { id, error: err.message });
      return { approval, reply: `⚠️ #${id} approved tapi gagal dieksekusi: ${err.message}` };
    }
  }

  /** Eksekutor aksi pasca-approval. Semua side effect lewat sini. */
  async executeAction(action) {
    const { service, method, params = {} } = action;

    if (service === 'tool') {
      const out = await this.plugins.callTool(method, params, {});
      return `Tool ${method}: ${typeof out === 'string' ? out : JSON.stringify(out)}`;
    }

    if (service === 'connector') {
      // method format: "<plugin>.<connector>.<method>"
      const parts = method.split('.');
      const methodName = parts.pop();
      const conn = this.plugins.connectors.get(parts.join('.'));
      if (!conn) throw new Error(`connector '${parts.join('.')}' tidak ditemukan`);
      const out = await conn.client[methodName](params);
      return `Connector ${method}: ${typeof out === 'string' ? out : JSON.stringify(out)}`;
    }

    const client = this.services.get(service);
    if (!client) throw new Error(`service '${service}' tidak terdaftar`);
    if (typeof client[method] !== 'function') throw new Error(`service '${service}' tidak punya method '${method}'`);
    const out = await client[method](...(Array.isArray(params) ? params : Object.values(params)));
    return typeof out === 'string' ? out : (out?.note || JSON.stringify(out));
  }

  async #history(chatId) {
    const rows = await this.repos.messages.recent(chatId, HISTORY_LIMIT);
    return rows
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));
  }

  async buildStatus() {
    const providers = this.router.status()
      .map((p) => `• ${p.name} (${p.kind}) — ${p.state}${p.unofficial ? ' [unofficial]' : ''}`)
      .join('\n');
    const plugins = this.plugins
      ? this.plugins.status().map((p) => `• ${p.name}@${p.version} [${p.type}] — ${p.status}`).join('\n') || '• (tidak ada)'
      : '• (plugin manager nonaktif)';
    const pending = await this.gate.listPending(null, 10);
    const usage = await this.repos.usage.totals({ sinceMs: 24 * 3600 * 1000 });
    const usageLines = Object.entries(usage)
      .map(([name, u]) => `• ${name}: ${u.calls} call, ${u.promptTokens}↓ ${u.completionTokens}↑ token`)
      .join('\n') || '• (belum ada pemakaian)';
    const upSec = Math.floor((Date.now() - this.startedAt) / 1000);

    return [
      `🤖 *ARIA status* — uptime ${formatUptime(upSec)}, db: ${this.repos.kind}`,
      '',
      '*Providers:*', providers,
      '',
      '*Plugins:*', plugins,
      '',
      `*Approval pending:* ${pending.length}${pending.length ? ' (' + pending.map((p) => '#' + p.id).join(' ') + ')' : ''}`,
      '',
      '*Pemakaian 24 jam:*', usageLines,
    ].join('\n');
  }
}

function helpText() {
  return [
    '🤖 *ARIA — perintah:*',
    '',
    '• Chat biasa — tanya apa saja, aku jawab lewat provider AI.',
    '• "Ringkas chat <nama/grup> dari kemarin/3 hari" — ringkasan WhatsApp (tanpa approval).',
    '• "Balas chat <nama> bilang <pesan>" — aku susun draft, kamu approve dulu baru terkirim.',
    '• "Ingat: <catatan>" — simpan ke memory.',
    '• status — kesehatan provider, plugin, approval pending, pemakaian.',
    '',
    'Approval: balas "ya"/"tolak" atau pakai tombol inline.',
  ].join('\n');
}

function formatUptime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}j ${m}m` : `${m}m ${sec % 60}d`;
}
