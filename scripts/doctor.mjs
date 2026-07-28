#!/usr/bin/env node
/**
 * ARIA doctor — cek kesiapan environment sebelum menjalankan service.
 *   npm run doctor
 * Exit code 1 kalau ada masalah wajib (✗); ⚠ hanya peringatan.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const rows = [];
const ok = (m) => rows.push(['✓', m]);
const warn = (m) => rows.push(['⚠', m]);
const bad = (m) => rows.push(['✗', m]);

// --- Node ------------------------------------------------------------------
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj > 20 || (maj === 20 && min >= 6)) ok(`Node ${process.versions.node}`);
else bad(`Node ${process.versions.node} — butuh >= 20.6 (lihat docs/GETTING-STARTED.md)`);

// --- .env ------------------------------------------------------------------
if (!existsSync('.env')) {
  bad('.env tidak ditemukan — jalankan: cp .env.example .env');
  finish();
}
ok('.env ditemukan');
process.loadEnvFile('.env');

const { loadConfig } = await import('@aria/shared');
let config;
try {
  config = loadConfig();
} catch (err) {
  bad(`config invalid: ${err.message}`);
  finish();
}

// --- token internal ----------------------------------------------------------
if (config.internalToken === 'dev-insecure-token') {
  warn('ARIA_INTERNAL_TOKEN masih default — ganti dengan string acak panjang');
} else {
  ok('ARIA_INTERNAL_TOKEN custom');
}

// --- telegram ---------------------------------------------------------------
if (config.telegram.botToken) ok('TELEGRAM_BOT_TOKEN terisi');
else bad('TELEGRAM_BOT_TOKEN kosong — isi dari @BotFather, bot tidak akan jalan tanpa ini');

if (config.telegram.ownerIds.length > 0) ok(`TELEGRAM_OWNER_IDS: ${config.telegram.ownerIds.length} owner`);
else warn('TELEGRAM_OWNER_IDS kosong — bot akan menolak SEMUA user');

// --- database ---------------------------------------------------------------
if (!config.databaseUrl) {
  warn('DATABASE_URL kosong → mode IN-MEMORY (state hilang saat restart). '
    + 'Jalankan: npm run setup:db, lalu uncomment DATABASE_URL di .env');
} else {
  try {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 3000 });
    await pool.query('SELECT 1');
    await pool.end();
    ok('PostgreSQL bisa dihubungi via DATABASE_URL');
  } catch (err) {
    bad(`PostgreSQL gagal: ${err.code || ''} ${err.message || '(koneksi ditolak)'} — npm run setup:db / cek service postgresql`);
  }
}

// --- provider AI ---------------------------------------------------------------
const withKey = [];
const withoutKey = [];
for (const name of config.providers.enabled) {
  if (name === 'opencode') continue;
  (config.providers.defs[name]?.apiKey ? withKey : withoutKey).push(name);
}
if (withKey.length > 0) {
  ok(`Provider ber-key: ${withKey.join(', ')}`);
  if (withoutKey.length > 0) warn(`Provider tanpa key (otomatis di-skip router): ${withoutKey.join(', ')}`);
} else {
  warn('Belum ada API key provider terisi — draft/ringkasan jalan mode fallback mentah. '
    + 'Gratis tercepat: GEMINI_API_KEY dari aistudio.google.com');
}

// --- opencode CLI -------------------------------------------------------------
if (config.providers.enabled.includes('opencode')) {
  const bin = config.providers.defs.opencode.bin;
  const which = spawnSync('which', [bin], { encoding: 'utf8' });
  if (which.status === 0) ok(`opencode CLI: ${which.stdout.trim()}`);
  else warn(`binary '${bin}' tidak ditemukan — task coding akan fallback ke provider lain`);
}

// --- plugins -------------------------------------------------------------------
if (existsSync(config.pluginsDir)) ok(`folder plugins: ${config.pluginsDir}`);
else warn(`folder plugins tidak ada: ${config.pluginsDir}`);

finish();

// -----------------------------------------------------------------------------
function finish() {
  console.log('\nARIA doctor\n' + '─'.repeat(44));
  for (const [icon, msg] of rows) console.log(`${icon}  ${msg}`);
  console.log('─'.repeat(44));
  const fails = rows.filter(([icon]) => icon === '✗').length;
  if (fails > 0) {
    console.log(`${fails} masalah wajib diperbaiki dulu.\n`);
    process.exit(1);
  }
  console.log('Siap jalan: pm2 start deploy/ecosystem.config.cjs\n');
  process.exit(0);
}
