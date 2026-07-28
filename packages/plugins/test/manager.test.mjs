import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginManager, validateManifest } from '@aria/plugins';
import { PluginError } from '@aria/shared';
import { ProviderRouter } from '@aria/providers';

// --- helper ---------------------------------------------------------------

async function makePlugin(dir, name, manifest, entryCode) {
  const p = join(dir, name);
  await mkdir(p, { recursive: true });
  await writeFile(join(p, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(p, manifest.entry || 'index.js'), entryCode);
  return p;
}

let root;
before(async () => { root = await mkdtemp(join(tmpdir(), 'aria-plugins-')); });
after(async () => { await rm(root, { recursive: true, force: true }); });

// --- manifest validation ---------------------------------------------------

test('manifest valid dinormalisasi dengan default yang benar', () => {
  const m = validateManifest({ name: 'cuaca', version: '1.0.0', type: 'tool' });
  assert.equal(m.entry, 'index.js');
  assert.deepEqual(m.permissions, []);
  assert.equal(m.unofficial, false);
});

test('manifest menolak nama/version/tipe/permission invalid', () => {
  assert.throws(() => validateManifest({ name: 'Cuaca Buruk!', version: '1.0.0', type: 'tool' }), PluginError);
  assert.throws(() => validateManifest({ name: 'cuaca', version: '1.0', type: 'tool' }), PluginError);
  assert.throws(() => validateManifest({ name: 'cuaca', version: '1.0.0', type: 'sihir' }), PluginError);
  assert.throws(() => validateManifest({ name: 'cuaca', version: '1.0.0', type: 'tool', permissions: ['root'] }), PluginError);
});

test('ai-provider wajib deklarasi auth; cookie/session ditandai unofficial', () => {
  assert.throws(() => validateManifest({ name: 'x', version: '1.0.0', type: 'ai-provider' }), PluginError);
  const official = validateManifest({ name: 'x', version: '1.0.0', type: 'ai-provider', auth: 'apikey' });
  assert.equal(official.unofficial, false);
  const unofficial = validateManifest({ name: 'y', version: '1.0.0', type: 'ai-provider', auth: 'cookie' });
  assert.equal(unofficial.unofficial, true);
});

// --- loading & registry ----------------------------------------------------

test('loadAll: plugin valid ter-load, plugin rusak tidak menjatuhkan yang lain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aria-p1-'));
  await makePlugin(dir, 'bagus', { name: 'bagus', version: '1.0.0', type: 'tool' }, `
    export function register(ctx) {
      ctx.tools.register({ name: 'halo', description: 'test', handler: async () => 'hai' });
    }
  `);
  await mkdir(join(dir, 'rusak'), { recursive: true }); // tanpa manifest

  const statesWrites = [];
  const mgr = new PluginManager({ dir, states: { upsert: async (s) => statesWrites.push(s) } });
  const { loaded, failed } = await mgr.loadAll();

  assert.deepEqual(loaded, ['bagus']);
  assert.deepEqual(failed, ['rusak']);
  assert.equal(mgr.status().find((p) => p.name === 'rusak').status, 'error');
  assert.ok(statesWrites.some((s) => s.name === 'rusak' && s.status === 'error'));
  await rm(dir, { recursive: true, force: true });
});

test('eksekusi tool berhasil lewat callTool dengan nama fully-qualified', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aria-p2-'));
  await makePlugin(dir, 'mat', { name: 'mat', version: '1.0.0', type: 'tool' }, `
    export function register(ctx) {
      ctx.tools.register({ name: 'tambah', handler: async ({ a, b }) => a + b });
    }
  `);
  const mgr = new PluginManager({ dir });
  await mgr.loadAll();
  const result = await mgr.callTool('mat.tambah', { a: 2, b: 40 });
  assert.equal(result, 42);
  await rm(dir, { recursive: true, force: true });
});

test('permission gate: http/env/memory ditolak tanpa deklarasi di manifest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aria-p3-'));
  await makePlugin(dir, 'nakal', { name: 'nakal', version: '1.0.0', type: 'tool' }, `
    export function register(ctx) {
      ctx.tools.register({ name: 'net', handler: async () => (await ctx.http('http://localhost')).status });
      ctx.tools.register({ name: 'baca-env', handler: async () => ctx.env('HOME') });
    }
  `);
  const mgr = new PluginManager({ dir });
  await mgr.loadAll();
  await assert.rejects(() => mgr.callTool('nakal.net'), (e) => e.code === 'PLUGIN_ERROR' && /permission 'network'/.test(e.message));
  await assert.rejects(() => mgr.callTool('nakal.baca-env'), /permission 'env'/);
  await rm(dir, { recursive: true, force: true });
});

test('timeout: tool yang menggantung diputus setelah timeoutMs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aria-p4-'));
  await makePlugin(dir, 'lambat', { name: 'lambat', version: '1.0.0', type: 'tool' }, `
    export function register(ctx) {
      ctx.tools.register({ name: 'gantung', timeoutMs: 50, handler: () => new Promise(() => {}) });
    }
  `);
  const mgr = new PluginManager({ dir });
  await mgr.loadAll();
  await assert.rejects(() => mgr.callTool('lambat.gantung'), (e) => e.code === 'PLUGIN_ERROR' && /timeout/.test(e.message) && e.retryable);
  await rm(dir, { recursive: true, force: true });
});

test('circuit breaker: tool gagal beruntun -> circuit-open sementara', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aria-p5-'));
  await makePlugin(dir, 'rapuh', { name: 'rapuh', version: '1.0.0', type: 'tool' }, `
    export function register(ctx) {
      ctx.tools.register({ name: 'meledak', handler: async () => { throw new Error('boom'); } });
    }
  `);
  let clock = 1_000_000;
  const mgr = new PluginManager({ dir, now: () => clock });
  await mgr.loadAll();

  for (let i = 0; i < 5; i++) await assert.rejects(() => mgr.callTool('rapuh.meledak'), /boom/);
  await assert.rejects(() => mgr.callTool('rapuh.meledak'), /circuit-open/);

  clock += 61_000; // lewati cooldown
  await assert.rejects(() => mgr.callTool('rapuh.meledak'), /boom/); // dicoba lagi
  await rm(dir, { recursive: true, force: true });
});

test('provider dari plugin terdaftar di ProviderRouter + di-wrap timeout + flag unofficial', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aria-p6-'));
  await makePlugin(dir, 'prov-plugin',
    { name: 'prov-plugin', version: '1.0.0', type: 'ai-provider', auth: 'cookie', permissions: ['providers', 'network'] },
    `export function register(ctx) {
       ctx.providers.register({
         name: 'prov-plugin',
         streaming: false,
         timeoutMs: 1000,
         chat: async (messages) => ({ text: 'dari plugin: ' + messages.at(-1).content }),
       });
     }`);
  const router = new ProviderRouter({ routes: { chat: ['prov-plugin'] } });
  const mgr = new PluginManager({ dir, providerRouter: router });
  await mgr.loadAll();

  assert.ok(router.has('prov-plugin'));
  const result = await router.chat('chat', [{ role: 'user', content: 'halo' }]);
  assert.equal(result.text, 'dari plugin: halo');
  const status = router.status().find((s) => s.name === 'prov-plugin');
  assert.equal(status.unofficial, true);
  await rm(dir, { recursive: true, force: true });
});

test('konektor tercatat di connector registry beserta daftar method-nya', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aria-p7-'));
  await makePlugin(dir, 'toko', { name: 'toko', version: '1.0.0', type: 'connector' }, `
    export function register(ctx) {
      ctx.connectors.register({ name: 'belanja', client: { list: async () => ['apel'], beli: async (x) => 'ok:' + x } });
    }
  `);
  const mgr = new PluginManager({ dir });
  await mgr.loadAll();
  const conn = mgr.connectors.get('toko.belanja');
  assert.deepEqual(conn.methods.sort(), ['beli', 'list']);
  assert.equal(await conn.client.beli('apel'), 'ok:apel');
  await rm(dir, { recursive: true, force: true });
});
