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

## Menjalankan lokal / VPS

```bash
cp .env.example .env        # isi token & API key
npm install                 # install semua workspace
npm test                    # 46 unit test

# Terminal 1 — orchestrator (DATABASE_URL kosong -> mode in-memory)
npm run dev:orchestrator

# Terminal 2 — bot Telegram (antarmuka utama)
npm run dev:telegram

# Terminal 3 — service WhatsApp (opsional; scan QR saat pertama jalan)
npm run dev:wa
```

## Setup VPS fresh (Ubuntu 22.04, DigitalOcean)

```bash
# 1. Node.js 20 (repo apt bawaan jammy itu Node 12 — jangan dipakai)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Clone & install
git clone <repo> aria && cd aria
cp .env.example .env      # isi TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_IDS,
                          # ARIA_INTERNAL_TOKEN (acak panjang), API key provider
npm install && npm test

# 3. Database — pilih SALAH SATU:
#    a) PostgreSQL native (tanpa Docker):
sudo apt-get install -y postgresql
npm run setup:db        # buat user+db 'aria' (idempotent), lalu print baris DATABASE_URL
#    b) Atau Docker:
sudo apt-get install -y docker.io docker-compose-v2 && docker compose up -d postgres
#    c) Atau biarkan DATABASE_URL kosong: jalan dengan storage in-memory.
#    Setelah a/b: uncomment DATABASE_URL di .env. Schema auto-migrate saat boot.

# 4. Jalankan ketiga service via PM2 (auto-restart + jalan setelah reboot)
sudo npm install -g pm2     # <- perlu sudo
pm2 start deploy/ecosystem.config.cjs
pm2 save && pm2 startup     # salin command yang diminta (biasanya: sudo env PATH=... pm2 startup systemd ...), jalanin
pm2 logs aria-orchestrator  # harusnya terlihat: "schema database diterapkan"
pm2 logs aria-whatsapp      # pertama kali: scan QR dari WhatsApp (Perangkat Tertaut)
```

## Keamanan default

- Semua HTTP internal (orchestrator `:4100`, notify `:4200`, WA `:4300`) **bind ke
  `127.0.0.1`** — tidak terekspos ke internet. Jangan buka port-port ini di
  firewall; lapis keamanannya `ARIA_BIND_HOST` + header `x-aria-token`.
- Bot Telegram hanya menanggapi user ID di `TELEGRAM_OWNER_IDS`.
- `.env` tidak pernah di-commit (sudah di-.gitignore). Di VPS: `chmod 600 .env`.

## Update kode di VPS

```bash
cd ~/aria
git pull origin arena/019fa65f-aria-agent   # remote + NAMA branch (bukan URL repo)
npm install                                  # kalau package.json berubah
pm2 restart all
```

Jika `git pull` menolak dengan `fatal: not a git repository` → folder itu bukan
clone git (file hasil copy manual). Pemulihan:

```bash
cp <folder-lama>/.env /tmp/aria-env-backup
git clone -b arena/019fa65f-aria-agent https://github.com/rixz-dev/aria-agent.git aria
cd aria && cp /tmp/aria-env-backup .env && npm install
```

## Troubleshooting

| Gejala | Sebab | Solusi |
|---|---|---|
| `fatal: not a git repository` | folder bukan clone (file di-copy manual) | Lihat "Update kode di VPS" di atas |
| `git pull` dengan URL repo ditolak | argumen salah — pakai nama branch | `git pull origin arena/019fa65f-aria-agent` |
| `EBADENGINE` / `baileys … requires Node.js 20+` / `node: bad option: --test` | Node apt jammy = v12 | Install Node 20 via NodeSource (langkah 1 di atas) |
| `dpkg … trying to overwrite '/usr/include/node/common.gypi'` saat upgrade | konflik `libnode-dev` v12 | `sudo dpkg --remove --force-remove-reinstreq libnode-dev` lalu `sudo apt-get install -f` |
| `orchestrator gagal start` dengan error PostgreSQL / ECONNREFUSED | `DATABASE_URL` mengarah ke Postgres yang belum terinstal/jalan | Langkah 3 di atas, atau kosongkan `DATABASE_URL` |
| PostgreSQL: `CREATE DATABASE cannot run inside a transaction block` | `psql -c` dengan 2 statement digabung jadi satu transaksi | Pakai `npm run setup:db` (statement terpisah). Interaktif: ketik tiap statement satu per satu di prompt `psql` |
| `could not change directory to "/home/...": Permission denied` saat `sudo -u postgres` | warning kosmetik — user postgres tak bisa baca home-mu | Abaikan; bukan error |
| PM2: `EACCES mkdir /usr/lib/node_modules/pm2` | install global npm perlu root | `sudo npm install -g pm2` |
| Telegram bot diam / log `409 Conflict` | Dua proses polling token yang sama (mis. bot lama masih jalan) | `pm2 delete` duplikatnya / hentikan proses lama |
| WhatsApp: `koneksi WA tertutup status 408` / QR tak kunjung muncul | butuh internet keluar bebas ke `web.whatsapp.com` | Cek firewall egress; coba lagi, QR akan muncul begitu handshake berhasil |
| `akses ditolak (bukan owner)` di log telegram | `TELEGRAM_OWNER_IDS` salah/harus ID numeric | Ambil ID numeric kamu dari @userinfobot, tanpa @ |

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
