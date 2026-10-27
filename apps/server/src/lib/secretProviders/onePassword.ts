import { onePasswordProviderConfig } from '@ninedeploy/schemas';
import { providerBase, providerFetch, type NamedCallOptions, type NamedSecretDriver } from './named.js';
import { SecretProviderError } from './vault.js';

/**
 * G3.2: 1Password Connect, `${{op:<vault>/<item>[/<section>]/<field>}}` —
 * the `op://` secret-reference shape. Each part is a name or an id.
 *
 * Reads through a self-hosted Connect server with its access token; a
 * Connect server inside the network needs NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1
 * (plain http as well). A name that matches no vault, item, section or field
 * fails the deploy, and so does one that matches more than one.
 */

type OnePasswordConfig = { address: string };

/** 1Password ids are 26 lower-case base32 characters. */
const OP_ID = /^[a-z0-9]{26}$/;

interface Item {
  fields?: Array<{ id?: string; label?: string; value?: unknown; section?: { id?: string } }>;
  sections?: Array<{ id?: string; label?: string }>;
}

async function api<T>(config: OnePasswordConfig, creds: Record<string, string>, path: string, opts: NamedCallOptions): Promise<T> {
  const token = creds['token'];
  if (!token) throw new SecretProviderError('No 1Password Connect token is stored');
  const { text } = await providerFetch(
    '1Password Connect',
    `${providerBase(config.address, '1Password Connect')}${path}`,
    { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: opts.signal },
    [token],
  );
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SecretProviderError('1Password Connect answered with a body that is not JSON');
  }
}

const filterBy = (attr: 'name' | 'title', title: string): string => encodeURIComponent(`${attr} eq "${title.replace(/"/g, '\\"')}"`);

/** The id of the one entry named (or identified by) `part`. */
function pickOne(what: string, part: string, list: Array<{ id?: string; name?: string; title?: string }>): string {
  const matches = list.filter((e) => e.id === part || e.name === part || e.title === part);
  if (matches.length === 0 || !matches[0]!.id) throw new SecretProviderError(`1Password ${what} "${part}" was not found`);
  if (matches.length > 1) throw new SecretProviderError(`More than one 1Password ${what} is called "${part}"; use its id`);
  return matches[0]!.id;
}

async function readField(config: OnePasswordConfig, creds: Record<string, string>, name: string, opts: NamedCallOptions): Promise<string> {
  const parts = name.split('/');
  if (parts.length < 3 || parts.length > 4 || parts.some((p) => !p)) {
    throw new SecretProviderError('Invalid 1Password reference (expected <vault>/<item>[/<section>]/<field>)');
  }
  const [vault, item] = parts as [string, string];
  const section = parts.length === 4 ? parts[2]! : null;
  const field = parts[parts.length - 1]!;

  const vaultId = OP_ID.test(vault)
    ? vault
    : pickOne('vault', vault, await api<Array<{ id?: string; name?: string }>>(config, creds, `/v1/vaults?filter=${filterBy('name', vault)}`, opts));
  const itemId = OP_ID.test(item)
    ? item
    : pickOne(
        'item',
        item,
        await api<Array<{ id?: string; title?: string }>>(config, creds, `/v1/vaults/${vaultId}/items?filter=${filterBy('title', item)}`, opts),
      );
  const full = await api<Item>(config, creds, `/v1/vaults/${vaultId}/items/${itemId}`, opts);

  let fields = full.fields ?? [];
  if (section !== null) {
    const sectionId = pickOne('section', section, (full.sections ?? []).map((s) => ({ id: s.id, name: s.label })));
    fields = fields.filter((f) => f.section?.id === sectionId);
  }
  const matches = fields.filter((f) => f.id === field || f.label === field);
  if (matches.length === 0) throw new SecretProviderError(`1Password field "${field}" was not found`);
  if (matches.length > 1) throw new SecretProviderError(`More than one 1Password field is called "${field}"; name its section or use its id`);
  const value = matches[0]!.value;
  if (typeof value !== 'string') throw new SecretProviderError(`1Password field "${field}" has no value`);
  return value;
}

export const onePasswordDriver: NamedSecretDriver<OnePasswordConfig> = {
  kind: 'onepassword',
  label: '1Password Connect',
  credentialFields: ['token'],
  requiredCredentials: ['token'],
  parseConfig: (raw) => {
    const parsed = onePasswordProviderConfig.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  validate: (c) => void providerBase(c.address, '1Password Connect'),
  target: (c) => {
    try {
      return providerBase(c.address, '1Password Connect');
    } catch {
      return null;
    }
  },
  read: readField,
  async test(config, creds, opts) {
    const vaults = await api<unknown[]>(config, creds, '/v1/vaults', opts);
    let detail = `Token accepted (${Array.isArray(vaults) ? vaults.length : 0} vault(s) visible)`;
    if (opts.probeName) {
      await readField(config, creds, opts.probeName, opts);
      detail += '; probe field readable';
    }
    return detail;
  },
  clearCache: () => undefined,
};
