import { EventEmitter } from 'node:events';
import { shortId, ApprovalError } from '@aria/shared';

export const APPROVAL_STATUS = ['pending', 'approved', 'rejected', 'expired', 'failed'];

/**
 * ApprovalGate — blueprint §2: selalu minta approval sebelum eksekusi aksi
 * ber-side-effect; respon bisa lewat teks balasan ATAU inline button
 * (dua jalur ini berujung ke fungsi decide() yang sama, jadi konsisten).
 *
 * Events: 'requested', 'resolved' (approved/rejected), 'expired'.
 */
export class ApprovalGate extends EventEmitter {
  constructor({ repo, ttlMs = 300_000, clock = () => Date.now(), logger } = {}) {
    super();
    this.repo = repo;
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.logger = logger;
  }

  /**
   * Buat permintaan approval baru. `action` adalah envelope eksekusi:
   * { service, method, params, sideEffect: true }.
   */
  async request({ chatId, userId, summary, target = null, draft = null, action }) {
    if (!action || !action.service || !action.method) {
      throw new ApprovalError('approval wajib punya action {service, method, params}');
    }
    const approval = {
      id: shortId(6),
      chatId: String(chatId),
      userId: String(userId),
      summary,
      target,
      draft,
      action,
      status: 'pending',
      decidedBy: null,
      result: null,
      createdAt: new Date(this.clock()),
      expiresAt: new Date(this.clock() + this.ttlMs),
      resolvedAt: null,
    };
    await this.repo.create(approval);
    this.emit('requested', approval);
    this.logger?.info('approval diminta', { id: approval.id, action: `${action.service}.${action.method}` });
    return approval;
  }

  /**
   * Putuskan approval. Idempotent: kalau sudah tidak pending, kembalikan
   * status terkini tanpa mengubah apa pun (klik ganda/balas dua kali aman).
   *
   * @returns {Promise<{approval: object, changed: boolean}>}
   */
  async decide(id, decision, by = 'unknown') {
    if (!['approved', 'rejected'].includes(decision)) {
      throw new ApprovalError(`decision harus 'approved' atau 'rejected', dapat '${decision}'`);
    }
    const approval = await this.repo.get(id);
    if (!approval) throw new ApprovalError(`approval #${id} tidak ditemukan`);
    if (approval.status !== 'pending') {
      return { approval, changed: false };
    }

    // Cek kedaluwarsa tepat sebelum memutuskan.
    if (approval.expiresAt && new Date(approval.expiresAt).getTime() < this.clock()) {
      const updated = await this.repo.update(id, { status: 'expired', resolvedAt: new Date(this.clock()) });
      this.emit('expired', updated);
      return { approval: updated, changed: true };
    }

    const updated = await this.repo.update(id, {
      status: decision,
      decidedBy: String(by),
      resolvedAt: new Date(this.clock()),
    });
    this.emit('resolved', updated);
    this.logger?.info('approval diputuskan', { id, decision, by });
    return { approval: updated, changed: true };
  }

  /** Tandai hasil eksekusi (sukses/gagal) untuk audit log. */
  async recordResult(id, resultText, failed = false) {
    const fields = { result: resultText };
    if (failed) fields.status = 'failed';
    return this.repo.update(id, fields);
  }

  /** Approval pending terbaru untuk sebuah chat (untuk balasan teks "ya"/"tolak"). */
  async latestPending(chatId) {
    const rows = await this.repo.list({ status: 'pending', chatId: String(chatId), limit: 1 });
    return rows[0] || null;
  }

  async listPending(chatId = null, limit = 20) {
    return this.repo.list({ status: 'pending', chatId: chatId ? String(chatId) : null, limit });
  }

  /** Sweeper: panggil berkala; approval lewat expiresAt ditandai 'expired'. */
  async expireDue() {
    const pending = await this.repo.list({ status: 'pending', limit: 100 });
    const now = this.clock();
    let count = 0;
    for (const ap of pending) {
      if (ap.expiresAt && new Date(ap.expiresAt).getTime() < now) {
        const updated = await this.repo.update(ap.id, { status: 'expired', resolvedAt: new Date(now) });
        this.emit('expired', updated);
        count += 1;
      }
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Parser balasan TEKS untuk approval (jalur selain inline button).
// ---------------------------------------------------------------------------

const APPROVE_WORDS = new Set(['ya', 'y', 'yes', 'ok', 'oke', 'okay', 'setuju', 'approve', 'acc', 'lanjut', 'gas', 'kirim', 'jalan', 'boleh', 'betul', 'benar']);
const REJECT_WORDS = new Set(['tidak', 'ga', 'gak', 'nggak', 'enggak', 'no', 'nope', 'tolak', 'batal', 'batalin', 'cancel', 'jangan', 'stop', 'reject']);

/**
 * Parse teks seperti "ya", "tolak", "approve a1b2c3", "/reject a1b2c3",
 * "gas #a1b2c3" -> { decision: 'approved'|'rejected', id: string|null } | null
 */
export function parseApprovalReply(text) {
  const cleaned = String(text || '').trim().toLowerCase().replace(/^\/+/, '');
  if (!cleaned) return null;

  const idMatch = cleaned.match(/#?([a-f0-9]{6})\b/);
  const withoutId = idMatch ? cleaned.replace(idMatch[0], ' ') : cleaned;
  const words = withoutId.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 3) return null;

  const first = words[0];
  let decision = null;
  if (APPROVE_WORDS.has(first)) decision = 'approved';
  else if (REJECT_WORDS.has(first)) decision = 'rejected';
  else return null;

  // Kata tambahan harus netral ("dong", "deh", dst) — kalau bukan, ini
  // kemungkinan kalimat biasa ("ya ampun") dan tidak boleh auto-approve.
  const extras = words.slice(1);
  const neutral = new Set(['dong', 'deh', 'aja', 'saja', 'lah', 'bang', 'kak', 'mas', 'mbak', 'pak', 'bu', 'ari', 'aria']);
  if (!extras.every((w) => neutral.has(w))) return null;

  return { decision, id: idMatch ? idMatch[1] : null };
}
