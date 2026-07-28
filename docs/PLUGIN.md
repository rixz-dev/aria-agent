# Menulis Plugin ARIA

Plugin = "addon" untuk ARIA (analogi blueprint: addon Minecraft Bedrock —
nambah kemampuan tanpa ubah kode inti). Scan terjadi saat orchestrator boot;
plugin rusak tidak menjatuhkan plugin lain maupun orchestrator.

## Struktur

```
plugins/<nama-plugin>/
  manifest.json
  index.js
```

## manifest.json

```json
{
  "name": "my-provider",            // slug huruf-kecil, unik
  "type": "ai-provider",            // tool | connector | ai-provider | action | command
  "version": "1.0.0",               // semver x.y.z
  "auth": "cookie",                 // WAJIB utk tipe ai-provider: none|apikey|cookie|session
  "description": "...",
  "entry": "index.js",              // opsional, default index.js
  "permissions": ["network"]        // subset dari: network, env, providers, memory
}
```

- `auth: "cookie"/"session"` → plugin ditandai **unofficial** (blueprint: paling
  berisiko — rawan block/ban, cookie expired, pelanggaran ToS). Statusnya
  terlihat jelas di `/plugins` & `/providers`.
- Kalau pakai permission yang tidak dideklarasikan, pemanggilan API terkait
  melempar `PluginError`.

## Context (`ctx`) yang diterima `register(ctx)`

| API | Butuh permission | Keterangan |
|---|---|---|
| `ctx.log` | — | logger scope `plugin:<nama>` |
| `ctx.http(url, opts)` | `network` | fetch dengan timeout (default 10 dtk) |
| `ctx.env(name)` | `env` | baca env var (mis. API key plugin) |
| `ctx.memory.get/set(k, v)` | `memory` | KV per-plugin (`plugin:<nama>:`) |
| `ctx.tools.register(tool)` | — | daftarkan tool baru |
| `ctx.connectors.register(conn)` | — | daftarkan konektor |
| `ctx.providers.register(provider)` | `providers` | daftarkan AI provider ke Provider Router |

## Tipe: tool

```js
export function register(ctx) {
  ctx.tools.register({
    name: 'convert',                    // jadi fully-qualified: <plugin>.convert
    description: 'Konversi format…',
    parameters: { type: 'object', properties: { /* JSON schema */ } },
    requiresApproval: true,             // default false; true = dieksekusi HANYA setelah user approve
    timeoutMs: 10000,                   // default 10 dtk
    async handler(args, toolCtx) { return 'hasil'; },
  });
}
```

Tool dipakai agent lewat blok ```` ```action {"tool": "<plugin>.<tool>", "args": {...}} ````
(lihat `packages/core/src/agent.mjs`), atau dipanggil orchestrator sebagai aksi
approval `{service: "tool", method: "<plugin>.<tool>", params: {...}}`.

Perlindungan bawaan: timeout + circuit breaker (≥5 gagal/menit → open 60 dtk).

## Tipe: connector

```js
export function register(ctx) {
  ctx.connectors.register({
    name: 'github',
    client: {
      async repos({ user }) { /* pakai ctx.http */ },
    },
  });
}
```

Klien terdaftar sebagai `<plugin>.<connector>`; method-nya bisa dieksekusi
sebagai aksi approval `{service: "connector", method: "<plugin>.<conn>.<method>"}`.

## Tipe: ai-provider

```js
export function register(ctx) {
  ctx.providers.register({
    name: 'my-provider',               // nama yang dipakai di ROUTE_* config
    streaming: false,
    timeoutMs: 30000,                  // panggilan di-wrap timeout otomatis
    async chat(messages, options) {
      // messages: [{role: 'system'|'user'|'assistant', content}]
      // WAJIB return: { text, model?, usage? }
      // Lempar Error apa pun saat gagal — router yang menangani fallback.
      return { text: '...' };
    },
  });
}
```

Setelah terdaftar, provider bisa dipakai seperti provider resmi: tambahkan
namanya ke `ROUTE_CHAT=my-provider,gemini,…` di `.env` (restart orchestrator).

> **Catatan blueprint (risiko §9):** provider unofficial (cookie/scrape)
> sekarang berjalan in-process dengan timeout + circuit breaker. Isolasi
> proses terpisah (Plugin Manager v2) adalah milestone berikutnya agar
> kegagalan/deteksi provider tidak ikut menjatuhkan orchestrator. Simpan
> cookie di env/secret storage — jangan hardcode di kode plugin.
