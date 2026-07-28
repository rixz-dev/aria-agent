# ARIA — Getting Started

Blueprint arsitektur ada di [`README.md`](../README.md). File ini menjelaskan cara
menjalankan hasil implementasi milestone 1–6.

## Yang sudah dibangun

| Milestone (blueprint §8) | Status | Lokasi |
|---|---|---|
| 1. Bot Telegram interface (command + approval teks & inline button) | ✅ | `apps/telegram-bot` |
| 2. Orchestrator inti (intent parsing, approval gate, routing) | ✅ | `packages/core`, `apps/orchestrator` |
| 3. Provider Router v1 (nvidia, gemini, openrouter, opencode + fallback + tracking usage) | ✅ | `packages/providers` |
| 4. Integrasi Bot WA sebagai service (tanpa whitelist kontak) | ✅ | `apps/whatsapp-bot` |
| 5. Database (state, memory, approval log, plugin registry) | ✅ | `packages/db` (Postgres / fallback in-memory) |
| 6. Ringkas chat (via Provider Router) | ✅ | `packages/core/src/summarize.mjs` |
| 7. Plugin Manager v1 (tipe `tool` + `connector`, permission gate, timeout, circuit breaker) | ✅ | `packages/plugins` |
| 8. Plugin Manager v2 (ai-provider unofficial, isolasi proses) | sebagian | api-provider plugin sudah bisa daftar & ditandai `unofficial`; isolasi worker belum |
| 9. Termux on-demand | belum | — |
| 10. Browser & coding agent | belum | `opencode` provider CLI sudah ada sebagai fondasi coding-agent |

## Menjalankan lokal

```bash
cp .env.example .env        # isi token & API key
npm install                 # install semua workspace
npm test                    # 40+ unit test

# Terminal 1 — orchestrator (tanpa DATABASE_URL otomatis pakai in-memory)
npm run dev:orchestrator

# Terminal 2 — bot Telegram (antarmuka utama)
npm run dev:telegram

# Terminal 3 — service WhatsApp (opsional; scan QR saat pertama jalan)
npm run dev:wa
```

Database sungguhan:

```bash
npm run db:up               # PostgreSQL via docker compose
# DATABASE_URL di .env sudah default ke postgres://aria:aria@localhost:5432/aria
# schema diterapkan otomatis saat orchestrator boot (schema.sql idempotent)
```

## Cara pakai (via Telegram)

```
kamu : ringkas chat grup keluarga dari kemarin
ARIA : 📋 Ringkasan "Keluarga" (sejak …, 87 pesan, via gemini):
       - …

kamu : balas chat budi bilang otw
ARIA : ⏳ Draft siap — butuh approval kamu (#a1b2c3).
       ⏳ Approval #a1b2c3 — Kirim pesan WhatsApp
       👤 *TUJUAN: budi*
       📝 Draft:
       Siap, aku otw ya 👍
       [ ✅ Setuju ] [ ❌ Tolak ]      ← inline button
kamu : ya                              ← atau balas teks
ARIA : ✅ #a1b2c3 dieksekusi. terkirim ke 62812xxxx@s.whatsapp.net
```

Perintah: `/status`, `/providers`, `/plugins`, `/approvals`, `/approve <id>`, `/reject <id>`,
dan `ingat: <catatan>` untuk memory.

## Arsitektur proses

```
 telegram-bot ──POST /v1/message──► orchestrator ──HTTP──► whatsapp-bot (Baileys)
      ▲  ▲                            │  ├─ ProviderRouter → nvidia / gemini / openrouter / opencode (+ plugin)
      │  └─POST /notify/*─────────────┘  ├─ PluginManager  → /plugins (tool/connector/ai-provider)
      └─────── balasan/approval ◄────────┴─ repos          → Postgres (atau in-memory)
```

Semua endpoint internal dilindungi header `x-aria-token` (`ARIA_INTERNAL_TOKEN`).
Bot Telegram hanya menanggapi `TELEGRAM_OWNER_IDS`.
