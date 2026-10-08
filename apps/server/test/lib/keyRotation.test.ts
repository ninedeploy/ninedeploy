import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backupDestinations,
  configEntries,
  databases,
  envVars,
  logDrains,
  notificationChannels,
  oidcProviders,
  servers,
  settings,
  sources,
  tunnels,
  users,
  ssoProviders,
  webhooks,
} from '@ninedeploy/db';

const cryptoMock = vi.hoisted(() => ({ reencrypt: vi.fn((v: string) => `re:${v}`) }));
vi.mock('../../src/lib/crypto.js', () => ({ reencrypt: cryptoMock.reencrypt, activeKeyVersion: () => 1 }));

beforeEach(() => {
  cryptoMock.reencrypt.mockClear();
});

const { rotateSecrets } = await import('../../src/lib/keyRotation.js');

interface FakeDb {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

function makeDb(rowsByTable: Map<unknown, Array<Record<string, unknown>>>, updates: Array<{ table: unknown; values: Record<string, unknown> }>): FakeDb {
  return {
    select: vi.fn(() => ({ from: vi.fn(async (table: unknown) => rowsByTable.get(table) ?? []) })),
    update: vi.fn((table: unknown) => ({
      set: (values: Record<string, unknown>) => ({ where: vi.fn(async () => { updates.push({ table, values }); return undefined; }) }),
    })),
  };
}

describe('rotateSecrets', () => {
  it('re-encrypts every stored secret with the active key version', async () => {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const rows = new Map<unknown, Array<Record<string, unknown>>>([
      [envVars, [{ id: 1, v: 'ev-enc' }]],
      [webhooks, [{ id: 2, v: 'wh-enc' }]],
      [databases, [{ id: 3, v: 'db-enc' }]],
      [tunnels, [{ id: 4, v: 'tn-enc' }]],
      // r473: the channel carries BOTH encrypted columns — the target AND the
      // (now envelope-encrypted) provider config blob; each rotates once.
      [notificationChannels, [{ id: 5, v: 'nc-enc', c: 'nc-cfg-enc' }]],
      // sources: one null credential column to exercise the nullable path
      [sources, [{ id: 6, t: 'src-tok', k: null }]],
      [users, [{ id: 7, v: 'totp-enc' }]],
      [oidcProviders, [{ id: 8, v: 'oidc-enc' }]],
      [backupDestinations, [{ id: 9, v: 'bkd-enc' }]],
      [servers, [{ id: 10, v: 'srv-enc' }]],
      [logDrains, [{ id: 11, v: 'drain-enc' }]],
      // Keyed stores: only the enumerated encrypted rows rotate; plaintext
      // settings rows and non-secret config entries must be skipped.
      [settings, [{ key: 'vault_token_encrypted', v: 'enc-vault' }, { key: 'allow_registration', v: true }]],
      [configEntries, [{ key: 'cfg-1', v: 'enc-cfg', s: true }, { key: 'cfg-2', v: 'plain-value', s: false }]],
    ]);
    const db = makeDb(rows, updates);

    const count = await rotateSecrets(db as never);

    expect(count).toBe(14); // 12 registry rows (target + config blob) + 1 settings secret + 1 config-center secret
    // reencrypt was applied to every non-null secret (null source key is skipped).
    expect(cryptoMock.reencrypt).toHaveBeenCalledWith('ev-enc');
    expect(cryptoMock.reencrypt).toHaveBeenCalledWith('wh-enc');
    expect(cryptoMock.reencrypt).toHaveBeenCalledWith('db-enc');
    expect(cryptoMock.reencrypt).toHaveBeenCalledWith('tn-enc');
    expect(cryptoMock.reencrypt).toHaveBeenCalledWith('nc-enc');
    expect(cryptoMock.reencrypt).toHaveBeenCalledWith('nc-cfg-enc');
    expect(cryptoMock.reencrypt).toHaveBeenCalledWith('src-tok');
    expect(cryptoMock.reencrypt).toHaveBeenCalledWith('totp-enc');
    expect(cryptoMock.reencrypt).toHaveBeenCalledWith('oidc-enc');
    expect(cryptoMock.reencrypt).toHaveBeenCalledWith('bkd-enc');
    expect(cryptoMock.reencrypt).toHaveBeenCalledWith('srv-enc');
    expect(cryptoMock.reencrypt).toHaveBeenCalledWith('drain-enc');

    // The sources row keeps a null deploy key (not passed through reencrypt).
    const srcUpdate = updates.find((u) => u.table === sources);
    expect(srcUpdate?.values).toEqual({ tokenEncrypted: 're:src-tok', deployKeyEncrypted: null });
    // Nullable columns on users/logDrains also stay null.
    const userUpdate = updates.find((u) => u.table === users);
    expect(userUpdate?.values).toEqual({ totpSecretEncrypted: 're:totp-enc' });
    const drainUpdate = updates.find((u) => u.table === logDrains);
    expect(drainUpdate?.values).toEqual({ apiKeyEncrypted: 're:drain-enc' });

    // Keyed stores: encrypted rows rotate onto the active key; plaintext
    // settings values and non-secret config entries are never touched.
    expect(cryptoMock.reencrypt).toHaveBeenCalledWith('enc-vault');
    expect(cryptoMock.reencrypt).toHaveBeenCalledWith('enc-cfg');
    expect(cryptoMock.reencrypt).not.toHaveBeenCalledWith(true);
    expect(cryptoMock.reencrypt).not.toHaveBeenCalledWith('plain-value');
    const settingsUpdates = updates.filter((u) => u.table === settings);
    expect(settingsUpdates).toHaveLength(1);
    expect(String(settingsUpdates[0]!.values.value)).toBe('re:enc-vault');
    expect(settingsUpdates[0]!.values.updatedAt).toBeInstanceOf(Date);
    const cfgUpdates = updates.filter((u) => u.table === configEntries);
    expect(cfgUpdates).toHaveLength(1);
    expect(String(cfgUpdates[0]!.values.value)).toBe('re:enc-cfg');
  });

  it('keeps nullable encrypted columns null without calling reencrypt', async () => {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const rows = new Map<unknown, Array<Record<string, unknown>>>([
      [users, [{ id: 7, v: null }]],
      [sources, [{ id: 6, t: null, k: null }]],
    ]);
    const db = makeDb(rows, updates);

    const count = await rotateSecrets(db as never);

    expect(count).toBe(2);
    expect(cryptoMock.reencrypt).not.toHaveBeenCalled();
    expect(updates.find((u) => u.table === users)?.values).toEqual({ totpSecretEncrypted: null });
    expect(updates.find((u) => u.table === sources)?.values).toEqual({ tokenEncrypted: null, deployKeyEncrypted: null });
  });

  it('0.12: rotates the preview-only env set like env_vars', async () => {
    const { previewEnvVars } = await import('@ninedeploy/db');
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const db = makeDb(new Map([[previewEnvVars, [{ id: 1, v: 'pev-enc' }]]]), updates);

    expect(await rotateSecrets(db as never)).toBe(1);
    expect(updates).toEqual([{ table: previewEnvVars, values: { valueEncrypted: 're:pev-enc' } }]);
  });

  it('reports zero when there is nothing to rotate', async () => {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const db = makeDb(new Map(), updates);
    const count = await rotateSecrets(db as never);
    expect(count).toBe(0);
    expect(cryptoMock.reencrypt).not.toHaveBeenCalled();
  });
});

// ── r466 coverage: the report wrapper and the ssoProviders tolerant entry ──
describe('rotateSecretsWithReport', () => {
  it('reports the rotated count, the active version and the backup warning', async () => {
    const { rotateSecretsWithReport } = await import('../../src/lib/keyRotation.js');
    const { backups } = await import('@ninedeploy/db');
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const rows = new Map<unknown, Array<Record<string, unknown>>>([
      [envVars, [{ id: 1, v: 'ev-enc' }]],
      // r446: an unnormalized pre-r435 SSO row is SKIPPED, not fatal.
      [ssoProviders, [{ id: 2, v: JSON.stringify({ issuer: 'x' }) }]],
      [backups, [{ id: 9 }]],
    ]);
    const db = makeDb(rows, updates);
    const report = await rotateSecretsWithReport(db as never);
    expect(report.rotated).toBe(1);
    expect(typeof report.activeVersion).toBe('number');
    expect(report.backupsNotRotated).toBe(1);
    // The plaintext SSO survivor produced no update at all.
    expect(updates.every((u) => u.table !== ssoProviders)).toBe(true);
  });
});
