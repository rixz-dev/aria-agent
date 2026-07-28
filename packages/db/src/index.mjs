import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ConfigError } from '@aria/shared';
import { createMemoryRepos } from './memory-repos.mjs';
import { createPgRepos } from './pg-repos.mjs';

export { createMemoryRepos } from './memory-repos.mjs';
export { createPgRepos } from './pg-repos.mjs';

/**
 * Factory repository: pakai PostgreSQL kalau DATABASE_URL di-set,
 * fallback ke in-memory dengan warning jelas (dev only — data hilang saat restart).
 */
export async function createRepos(config, logger) {
  if (!config.databaseUrl) {
    logger?.warn('DATABASE_URL kosong — memakai storage IN-MEMORY (state hilang saat restart)');
    return createMemoryRepos();
  }
  const repos = createPgRepos(config.databaseUrl, logger);

  // Ping dulu supaya kegagalan koneksi DB (mis. Postgres belum diinstal)
  // menghasilkan pesan yang actionable, bukan AggregateError bermessage kosong.
  try {
    await repos.pool.query('SELECT 1');
  } catch (err) {
    let hostPort = '';
    try {
      const u = new URL(config.databaseUrl);
      hostPort = `${u.hostname}:${u.port || 5432}`;
    } catch { /* URL aneh dibiarkan kosong */ }
    const codes = collectErrorCodes(err);
    throw new ConfigError(
      `Tidak bisa konek ke PostgreSQL di ${hostPort || 'DATABASE_URL'} (${codes || err.message || 'koneksi ditolak'}).\n`
      + 'Perbaiki salah satu:\n'
      + '  a) Install PostgreSQL native:  sudo apt install -y postgresql\n'
      + '     lalu: sudo -u postgres psql -c "CREATE USER aria PASSWORD \'aria\'; CREATE DATABASE aria OWNER aria;"\n'
      + '  b) Atau pakai Docker:          sudo apt install -y docker.io docker-compose-v2 && npm run db:up\n'
      + '  c) Atau kosongkan DATABASE_URL di .env untuk mode in-memory (dev).',
      { cause: err },
    );
  }

  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql');
  const schemaSql = await readFile(schemaPath, 'utf8');
  await repos.migrate(schemaSql);
  return repos;
}

/** Node >= 20 melempar AggregateError (message kosong) saat connect gagal di ::1 & 127.0.0.1. */
function collectErrorCodes(err) {
  if (Array.isArray(err?.errors) && err.errors.length > 0) {
    return err.errors.map((e) => e.code || e.message).filter(Boolean).join(', ');
  }
  return err?.code || '';
}
