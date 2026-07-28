import { PluginError } from '@aria/shared';

export const PLUGIN_TYPES = ['tool', 'connector', 'ai-provider', 'action', 'command'];
export const PLUGIN_PERMISSIONS = ['network', 'env', 'providers', 'memory'];
export const AI_PROVIDER_AUTH = ['none', 'apikey', 'cookie', 'session'];

/**
 * Validasi manifest.json plugin — lihat blueprint §5.
 * Desain generik: tipe baru bisa ditambah ke PLUGIN_TYPES tanpa breaking change.
 *
 * @returns manifest yang sudah dinormalisasi
 */
export function validateManifest(raw, { dir = '.' } = {}) {
  const fail = (msg) => { throw new PluginError(`manifest invalid (${dir}): ${msg}`, { plugin: raw?.name }); };

  if (!raw || typeof raw !== 'object') fail('bukan object JSON');

  if (typeof raw.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.name)) {
    fail('field "name" wajib berupa slug huruf-kecil (mis. "weather-tool")');
  }
  if (typeof raw.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(raw.version)) {
    fail('field "version" wajib format semver "x.y.z"');
  }
  if (!PLUGIN_TYPES.includes(raw.type)) {
    fail(`field "type" wajib salah satu dari: ${PLUGIN_TYPES.join(', ')}`);
  }

  const permissions = raw.permissions ?? [];
  if (!Array.isArray(permissions)) fail('field "permissions" harus array');
  const unknownPerms = permissions.filter((p) => !PLUGIN_PERMISSIONS.includes(p));
  if (unknownPerms.length > 0) {
    fail(`permission tidak dikenal: ${unknownPerms.join(', ')} (known: ${PLUGIN_PERMISSIONS.join(', ')})`);
  }

  // Tipe ai-provider wajib mendeklarasikan model auth-nya. 'cookie'/'session'
  // = unofficial (blueprint: paling berisiko) -> ditandai untuk isolasi ketat.
  let auth = null;
  let unofficial = false;
  if (raw.type === 'ai-provider') {
    if (!AI_PROVIDER_AUTH.includes(raw.auth)) {
      fail(`tipe ai-provider wajib punya field "auth": ${AI_PROVIDER_AUTH.join(', ')}`);
    }
    auth = raw.auth;
    unofficial = auth === 'cookie' || auth === 'session';
  }

  return {
    name: raw.name,
    version: raw.version,
    type: raw.type,
    description: typeof raw.description === 'string' ? raw.description : '',
    entry: typeof raw.entry === 'string' ? raw.entry : 'index.js',
    auth,
    unofficial,
    permissions,
  };
}
