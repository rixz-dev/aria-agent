# Plugins

Taruh folder plugin di sini. Struktur (blueprint §5):

```
plugins/<nama-plugin>/
  manifest.json   # metadata + permission
  index.js        # entry point: export function register(ctx)
```

Lihat `../docs/PLUGIN.md` untuk panduan lengkap menulis plugin
(tool, connector, dan ai-provider official/unofficial).
