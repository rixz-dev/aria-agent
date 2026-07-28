import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql');
  const schemaSql = await readFile(schemaPath, 'utf8');
  await repos.migrate(schemaSql);
  return repos;
}
