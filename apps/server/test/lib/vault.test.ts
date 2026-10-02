import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVaultConfig, hasVaultRef, resolveVaultRefs, setVaultConfig, testVault } from '../../src/lib/vault.js';
import { createFakeDb } from '../helpers.js';

const cryptoMocks = vi.hoisted(() => ({
  encrypt: vi.fn((s: string) => `enc:${s}`),
  decrypt: vi.fn((s: string) => s.replace('enc:', '')),
}));
vi.mock('../../src/lib/crypto.js', () => cryptoMocks);

const settingRow = (key: string, value: unknown) => ({ key, value });

// r510: resolution is scoped to a service — these tests resolve for one
// owned by an instance operator (user 1), which always may.
const OPERATOR_SUBJECT = { service: { id: 1, ownerUserId: 1 }, projectIds: [] };

function vaultDb(over: Record<string, unknown> = {}) {
  return createFakeDb({
    findFirst: {
      users: { id: 1, isInstanceOperator: true },
      settings: (args: { where?: unknown } | undefined) => {
        void args;
        const key = lastRequestedKey;
        return Promise.resolve(key in over ? settingRow(key, over[key]) : undefined);
      },
    },
  });
}

// The settings helper resolves keys via findFirst({ where: eq(settings.key, k) });
// capture the requested key through a tiny spy on the drizzle eq argument.
let lastRequestedKey = '';
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (col: unknown, value: unknown) => {
      if (col && (col as { name?: string }).name === 'key') lastRequestedKey = String(value);
      return actual.eq(col, value);
    },
  };
});

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

afterEach(() => {
  fetchMock.mockReset();
  lastRequestedKey = '';
});

const INFISICAL_REF = `\u0024\u007B\u007Binfisical:API_KEY\u007D\u007D`;
const DOPPLER_REF = `\u0024\u007B\u007Bdoppler:API_KEY\u007D\u007D`;

describe('lib/vault', () => {
  it('reads a disabled config when the provider is absent', async () => {
    const cfg = await getVaultConfig(vaultDb());
    expect(cfg).toEqual({ provider: null, token: null, projectId: null, environment: null });
  });

  it('reads a disabled config for an unknown provider', async () => {
    const cfg = await getVaultConfig(vaultDb({ vault_provider: 'heroku' }));
    expect(cfg.provider).toBeNull();
  });

  it('reads a config without a stored token or project', async () => {
    const cfg = await getVaultConfig(vaultDb({ vault_provider: 'doppler' }));
    expect(cfg).toEqual({ provider: 'doppler', token: null, projectId: null, environment: null });
  });

  it('clears the token when setVaultConfig receives null', async () => {
    const db = vaultDb();
    await setVaultConfig(db, { provider: null, token: null, projectId: null, environment: null });
    expect(cryptoMocks.encrypt).not.toHaveBeenCalled();
  });

  it('reads a full infisical config (token decrypted)', async () => {
    const cfg = await getVaultConfig(
      vaultDb({
        vault_provider: 'infisical',
        vault_token_encrypted: 'enc:tok',
        vault_project_id: 'ws-1',
        vault_environment: 'prod',
      }),
    );
    expect(cfg).toEqual({ provider: 'infisical', token: 'tok', projectId: 'ws-1', environment: 'prod' });
  });

  it('writes a config (token encrypted)', async () => {
    const db = vaultDb();
    await setVaultConfig(db, { provider: 'doppler', token: 't', projectId: 'p', environment: 'dev' });
    expect(cryptoMocks.encrypt).toHaveBeenCalledWith('t');
  });

  it('detects vault references in values', () => {
    expect(hasVaultRef(INFISICAL_REF)).toBe(true);
    expect(hasVaultRef(DOPPLER_REF)).toBe(true);
    expect(hasVaultRef('plain')).toBe(false);
  });

  it('resolves infisical references from the fetched pool', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ secrets: [{ secretKey: 'API_KEY', secretValue: 'resolved' }] }),
    });
    const env = await resolveVaultRefs(
      vaultDb({
        vault_provider: 'infisical',
        vault_token_encrypted: 'enc:tok',
        vault_project_id: 'ws',
        vault_environment: 'default',
      }),
      { KEY: INFISICAL_REF, PLAIN: 'untouched' },
      OPERATOR_SUBJECT,
    );
    expect(env).toEqual({ KEY: 'resolved', PLAIN: 'untouched' });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('app.infisical.com/api/v3/secrets/raw');
    expect(url).toContain('workspaceId=ws');
  });

  it('resolves doppler references with basic auth', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ API_KEY: 'dop' }) });
    const env = await resolveVaultRefs(
      vaultDb({
        vault_provider: 'doppler',
        vault_token_encrypted: 'enc:tok',
        vault_project_id: 'billing',
        vault_environment: 'prd',
      }),
      { KEY: DOPPLER_REF },
      OPERATOR_SUBJECT,
    );
    expect(env.KEY).toBe('dop');
    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(String(init.headers.Authorization)).toContain('Basic ');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('project=billing');
  });

  it('throws when the referenced provider is not configured', async () => {
    await expect(resolveVaultRefs(vaultDb(), { KEY: INFISICAL_REF }, OPERATOR_SUBJECT)).rejects.toThrow(/not configured/);
  });

  it('throws when the referenced secret is missing', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ secrets: [] }) });
    await expect(
      resolveVaultRefs(
        vaultDb({ vault_provider: 'infisical', vault_token_encrypted: 'enc:tok' }),
        { KEY: INFISICAL_REF },
      OPERATOR_SUBJECT,
      ),
    ).rejects.toThrow(/not found/);
  });

  it('resolves doppler without a project (default config)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ API_KEY: 'd' }) });
    const env = await resolveVaultRefs(
      vaultDb({ vault_provider: 'doppler', vault_token_encrypted: 'enc:tok' }),
      { KEY: DOPPLER_REF },
      OPERATOR_SUBJECT,
    );
    expect(env.KEY).toBe('d');
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).not.toContain('project=');
  });

  it('treats a missing infisical secrets array as empty (then fails)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await expect(
      resolveVaultRefs(
        vaultDb({ vault_provider: 'infisical', vault_token_encrypted: 'enc:tok' }),
        { KEY: INFISICAL_REF },
      OPERATOR_SUBJECT,
      ),
    ).rejects.toThrow(/not found/);
  });

  it('defaults the infisical workspace/environment params', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ secrets: [{ secretKey: 'API_KEY', secretValue: 'v' }] }),
    });
    await resolveVaultRefs(
      vaultDb({ vault_provider: 'infisical', vault_token_encrypted: 'enc:tok' }),
      { KEY: INFISICAL_REF },
      OPERATOR_SUBJECT,
    );
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('workspaceId=');
    expect(url).toContain('environment=default');
  });

  it('surfaces provider API errors', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'unauthorized' });
    await expect(
      resolveVaultRefs(
        vaultDb({ vault_provider: 'infisical', vault_token_encrypted: 'enc:tok' }),
        { KEY: INFISICAL_REF },
      OPERATOR_SUBJECT,
      ),
    ).rejects.toThrow(/Infisical API 401/);
  });

  it('testVault returns the reachable secret count', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ A: '1', B: '2' }) });
    const n = await testVault(
      vaultDb({ vault_provider: 'doppler', vault_token_encrypted: 'enc:t' }),
    );
    expect(n).toBe(2);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ secrets: [{ secretKey: 'K', secretValue: 'v' }] }) });
    const infisical = await testVault(
      vaultDb({ vault_provider: 'infisical', vault_token_encrypted: 'enc:t' }),
    );
    expect(infisical).toBe(1);
  });

  it('surfaces doppler API errors', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'denied' });
    await expect(
      resolveVaultRefs(
        vaultDb({ vault_provider: 'doppler', vault_token_encrypted: 'enc:tok' }),
        { KEY: DOPPLER_REF },
      OPERATOR_SUBJECT,
      ),
    ).rejects.toThrow(/Doppler API 403/);
  });

  it('testVault throws without a provider/token', async () => {
    await expect(testVault(vaultDb())).rejects.toThrow(/No vault provider/);
  });
});
