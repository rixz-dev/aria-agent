# ARIA — Blueprint Arsitektur (v2)

## 1. Ringkasan
ARIA adalah AI agent personal (mirip JARVIS) dengan satu orchestrator pusat di VPS, memanggil beberapa "anggota badan" (bot & service) sebagai eksekutor. Semua interaksi & approval lewat satu bot Telegram. Termux di HP cuma dipanggil on-demand untuk akses spesifik perangkat. Orchestrator bisa "gonta-ganti otak" lewat multi-provider AI, dan seluruh sistem bisa diperluas lewat **plugin system**.

**Infrastruktur:** VPS DigitalOcean 4 vCPU / 8GB RAM.

---

## 2. Prinsip Desain (hasil diskusi)
| Keputusan | Pilihan |
|---|---|
| Orkestrasi | 1 orchestrator pusat, bot-bot sebagai service terpisah |
| Otonomi | Selalu minta approval sebelum eksekusi aksi |
| Memory/state | Database di VPS, diakses semua service |
| Approval & interface | Bot Telegram tunggal (command masuk + notifikasi/approval keluar) |
| Format approval | Teks balasan **dan** inline button — dua-duanya didukung |
| Whitelist kontak | Tidak ada — semua kontak boleh jadi tujuan pesan |
| Termux (HP) | On-demand, bukan always-on listener |
| Provider AI | Multi-provider: build.nvidia.com, Gemini API, OpenRouter, OpenCode |
| Ekstensibilitas | Plugin system (konsep ala addon Minecraft Bedrock) |

---

## 3. Komponen Sistem

```
┌───────────────────────────────────────────────────────────────┐
│                        VPS (DO 4vCPU/8GB)                      │
│                                                                  │
│  ┌──────────────┐      ┌────────────────────────┐              │
│  │ Bot Telegram  │◄────►│    ORCHESTRATOR         │              │
│  │ (interface +  │      │  - intent parsing        │              │
│  │  approval:    │      │  - task planning          │              │
│  │  teks+button) │      │  - approval gate           │              │
│  └──────────────┘      │  - routing ke service       │              │
│                         │  - PROVIDER ROUTER ─────┐   │              │
│                         └──────────┬──────────────┼───┘              │
│                                    │              │                  │
│                    ┌───────────────┼──────┐  ┌────▼─────────────┐   │
│                    │               │      │  │  PROVIDER LAYER   │   │
│                    ▼               ▼      ▼  │  - build.nvidia   │   │
│             ┌────────────┐ ┌────────────┐ ┌──┤  - Gemini API     │   │
│             │ Bot WA      │ │ Ringkas    │ │..│  - OpenRouter     │   │
│             │ (Baileys)   │ │ Chat/LLM   │ │  │  - OpenCode       │   │
│             └────────────┘ └────────────┘ │  │  - [+ plugin AI]  │   │
│                                            │  └───────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐        │
│  │              PLUGIN MANAGER (loader + registry)            │        │
│  │  Plugin = paket berisi salah satu/kombinasi dari:           │        │
│  │  • Custom AI provider (official API ATAU unofficial        │        │
│  │    via cookie/session + script nembak/scrape)               │        │
│  │  • Tool baru (function/skill yang bisa dipanggil agent)     │        │
│  │  • Konektor baru (integrasi service luar)                    │        │
│  │  • Kategori lain (browser action, custom command, dll)      │        │
│  └──────────────────────────────────────────────────────────┘        │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │  Database (state, memory, log approval, plugin registry) │    │
│  └────────────────────────────────────────────────────────┘    │
└──────────────────────┬───────────────────────────────────────┘
                        │ HTTP/webhook, dipanggil on-demand
                        ▼
              ┌───────────────────┐
              │  Termux Agent (HP) │
              │  - notifikasi      │
              │  - GPS             │
              │  - file lokal      │
              └───────────────────┘
```

---

## 4. Provider Layer (Multi-Provider AI)

Orchestrator gak nembak satu LLM aja — ada **Provider Router** yang milih provider mana dipakai per task.

| Provider | Tipe | Catatan |
|---|---|---|
| build.nvidia.com | Official API | NIM endpoints, banyak model open-weight (Llama, Nemotron, dll) |
| Gemini API | Official API | Google AI Studio / Vertex |
| OpenRouter | Official API (aggregator) | Satu API key, banyak model dari banyak vendor |
| OpenCode | Official/CLI-based | Perlu dicek apakah dipakai sebagai coding-agent backend atau model provider |

**Kenapa butuh Provider Router (bukan hardcode satu provider):**
- Fallback otomatis kalau satu provider down/rate-limited.
- Pilih model beda per jenis task (misal: model murah/cepat buat intent parsing, model kuat buat coding/planning).
- Basis buat plugin sistem — provider baru (termasuk yang unofficial) tinggal didaftarkan sebagai plugin, gak perlu ubah kode inti orchestrator.

**Desain minimal Provider Router:**
```
interface AIProvider {
  name: string;
  chat(messages, options): Promise<Response>;
  streaming: boolean;
}
```
Semua provider (termasuk yang official di atas dan yang datang dari plugin) implement interface yang sama, jadi orchestrator manggilnya seragam — tinggal `providerRouter.call(providerName, payload)`.

---

## 5. Plugin System (ala addon Minecraft Bedrock)

Analogi addon Bedrock pas: addon nambah behavior/resource tanpa ubah game inti. Plugin ARIA sama — nambah kemampuan tanpa ubah kode orchestrator inti.

**Struktur plugin (usulan):**
```
/plugins
  /plugin-nama/
    manifest.json   # metadata: nama, versi, tipe, permission yang dibutuhkan
    index.js        # entry point, register ke Plugin Manager
```

**manifest.json contoh:**
```json
{
  "name": "my-custom-provider",
  "type": "ai-provider",
  "version": "1.0.0",
  "auth": "cookie",
  "permissions": ["network"]
}
```

**Tipe plugin yang perlu didukung dari awal:**
1. **AI Provider (official)** — pakai API key resmi, gampang: implement `AIProvider` interface.
2. **AI Provider (unofficial)** — pakai cookie/session browser + script buat nembak endpoint provider atau scrape response. Ini **paling berisiko**: rawan kena block/ban dari provider, cookie expired butuh refresh, dan bisa melanggar ToS provider yang bersangkutan — perlu isolasi (sandbox proses sendiri) biar kalau gagal/detect, gak jatuhin orchestrator.
3. **Tool** — fungsi baru yang bisa dipanggil agent (misal: cek cuaca, convert file, dll).
4. **Konektor** — integrasi ke service luar (mirip MCP server: Notion, GitHub, dll).
5. **Kategori lain** — command custom, custom action browser, dst — desain manifest generik biar gampang ditambah tanpa breaking change.

**Plugin Manager bertanggung jawab:**
- Load manifest saat startup, validasi format.
- Register plugin ke registry yang sesuai (provider registry, tool registry, connector registry).
- Isolasi eksekusi plugin unofficial (proses/sandbox terpisah + timeout + circuit breaker kalau sering gagal).
- Simpan status plugin (aktif/nonaktif/error) ke Database.

---

## 6. Alur Kerja (contoh)

**Skenario: "ARIA, ringkas chat grup X di WA dari kemarin"**
1. Command masuk via Bot Telegram → Orchestrator.
2. Orchestrator panggil Bot WA service ambil chat.
3. Orchestrator pilih provider (via Provider Router, misal OpenRouter model tertentu) buat ringkas.
4. Karena cuma baca+ringkas (bukan kirim ke orang), **tanpa approval** — langsung dibalas.

**Skenario butuh approval: "Bales chat Budi bilang otw"**
1-2. Sama.
3. Orchestrator susun draft via provider yang dipilih.
4. Kirim ke Telegram: teks **atau** inline button "Approve/Reject" (dua-duanya didukung, user pilih salah satu cara respon).
5. Approved → Orchestrator panggil Bot WA `POST /send-message` ke kontak manapun (tidak ada whitelist).
6. Log ke Database.

**Skenario plugin: user install plugin AI provider unofficial**
1. User taruh folder plugin baru + manifest.json (`type: ai-provider`, `auth: cookie`).
2. Plugin Manager detect, validasi, register ke Provider Router sebagai provider baru — jalan di proses terisolasi.
3. Orchestrator sekarang bisa pilih provider ini lewat nama yang sama seperti provider resmi.

---

## 7. Tech Stack yang Disarankan

| Komponen | Tools |
|---|---|
| Orchestrator | Node.js/Express, ReAct loop mirip [[olympus]] |
| Provider Router | Custom layer, interface seragam untuk 4 provider resmi + plugin provider |
| Bot Telegram | Grammy.js (reuse pola dari [[ryn]]), dukung inline keyboard utk approval |
| Bot WhatsApp | Baileys (reuse [[whatsapp-bot-baileys]]) |
| Database | PostgreSQL — state, memory, approval log, **plugin registry** |
| Plugin Manager | Loader custom — scan folder `/plugins`, validasi manifest, isolasi proses (child_process/worker) untuk plugin unofficial |
| Browser automation | MCP tool open source (Playwright-based) — bisa juga jadi plugin |
| Coding agent | Reuse [[rxs-code]] sebagai sub-agent lewat MCP |
| Termux agent | Python/Node, expose endpoint lokal, konek lewat Tailscale saat dipanggil |

---

## 8. Urutan Build (Milestone)

1. **Bot Telegram interface** — command + approval (teks & inline button).
2. **Orchestrator inti** — intent parsing + approval gate + routing dasar.
3. **Provider Router v1** — integrasi 4 provider resmi (nvidia, Gemini, OpenRouter, OpenCode) dengan interface seragam + fallback sederhana.
4. **Integrasi Bot WA** — expose sebagai service dipanggil orchestrator, tanpa whitelist kontak.
5. **Database** — state, memory, approval log.
6. **Ringkas chat service** — pakai Provider Router.
7. **Plugin Manager v1** — dukung tipe `tool` dan `connector` dulu (lebih aman, gak nyentuh auth pihak ketiga).
8. **Plugin Manager v2** — dukung tipe `ai-provider` termasuk unofficial (cookie/script), dengan isolasi proses.
9. **Termux on-demand** — Tailscale + endpoint notif/GPS/file.
10. **Browser & coding agent** — sebagai plugin/MCP, paling belakangan.

---

## 9. Risiko yang Perlu Diperhatikan
- **Provider unofficial (cookie/script):** paling rawan — provider bisa update sistem deteksi, cookie expired, atau ToS violation. Wajib isolasi + monitoring health per plugin.
- **Tanpa whitelist kontak:** ARIA bisa kirim ke siapa aja setelah approval — pastikan approval prompt selalu nunjukin nomor/kontak tujuan dengan jelas biar gak salah approve pas buru-buru.
- **Multi-provider cost/rate limit:** masing-masing provider punya limit beda — Provider Router perlu tracking usage biar gak kena limit tanpa sadar.
