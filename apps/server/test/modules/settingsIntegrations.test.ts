import { describe, expect, it, vi } from 'vitest';
import { settingsRoutes } from '../../src/modules/settings.js';
import { asUser, buildTestApp, createFakeDb } from '../helpers.js';

const vaultMocks = vi.hoisted(() => ({
  getVaultConfig: vi.fn(async () => ({ provider: 'infisical', token: 'tok', projectId: 'ws', environment: 'default' })),
  setVaultConfig: vi.fn(async () => undefined),
  testVault: vi.fn(async () => 7),
  ensureVaultAllowlistInitialised: vi.fn(async () => ({ workspaceIds: [], serviceIds: [] })),
  setVaultAllowlist: vi.fn(async (_db: unknown, list: unknown) => list),
}));
vi.mock('../../src/lib/vault.js', () => vaultMocks);

const cfMocks = vi.hoisted(() => ({
  getDnsRecordsConfig: vi.fn(async () => ({ enabled: true, token: 't', content: '1.2.3.4' })),
  setDnsRecordsConfig: vi.fn(async () => undefined),
  testCloudflareToken: vi.fn(async () => 'active'),
}));
vi.mock('../../src/lib/cloudflare.js', () => cfMocks);

async function app(db = createFakeDb()) {
  const a = await buildTestApp({ db });
  await a.register(settingsRoutes);
  return a;
}

describe('settings integrations (vault + dns records)', () => {
  it('returns the vault config (token presence, not value)', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/vault', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      provider: 'infisical',
      hasToken: true,
      projectId: 'ws',
      environment: 'default',
      // r510: the allowlist rides along (additive).
      allowlist: { workspaceIds: [], serviceIds: [] },
      workspaces: [],
      allowedServices: [],
    });
  });

  it('saves vault settings, keeping the stored token when omitted', async () => {
    const res = await (await app()).inject({
      method: 'PUT',
      url: '/vault',
      headers: asUser(),
      payload: { provider: 'infisical', projectId: 'ws-2', environment: 'prod' },
    });
    expect(res.statusCode).toBe(200);
    expect(vaultMocks.setVaultConfig).toHaveBeenCalledWith(
      expect.anything(),
      { provider: 'infisical', token: 'tok', projectId: 'ws-2', environment: 'prod' },
    );
  });

  it('drops the stored token when switching providers without a new one', async () => {
    await (await app()).inject({
      method: 'PUT',
      url: '/vault',
      headers: asUser(),
      payload: { provider: 'doppler' },
    });
    expect(vaultMocks.setVaultConfig).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: 'doppler', token: null }),
    );
  });

  it('clears the vault config when the provider is set to none', async () => {
    const res = await (await app()).inject({
      method: 'PUT',
      url: '/vault',
      headers: asUser(),
      payload: { provider: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, provider: null });
    expect(vaultMocks.setVaultConfig).toHaveBeenCalledWith(
      expect.anything(),
      { provider: null, token: null, projectId: null, environment: null },
    );
  });

  it('rejects an unknown vault provider', async () => {
    const res = await (await app()).inject({
      method: 'PUT',
      url: '/vault',
      headers: asUser(),
      payload: { provider: 'heroku' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('tests the vault connection', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/vault/test', headers: asUser() });
    expect(res.json()).toEqual({ ok: true, secrets: 7 });
  });

  it('saves dns-records settings (enable with token)', async () => {
    const res = await (await app()).inject({
      method: 'PUT',
      url: '/dns-records',
      headers: asUser(),
      payload: { enabled: true, token: 'cf-token-long-enough', content: '203.0.113.1' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns the dns-records config', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/dns-records', headers: asUser() });
    expect(res.json()).toEqual({ enabled: true, hasToken: true, content: '1.2.3.4' });
  });

  it('saves dns-records settings', async () => {
    const res = await (await app()).inject({
      method: 'PUT',
      url: '/dns-records',
      headers: asUser(),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(cfMocks.setDnsRecordsConfig).toHaveBeenCalledWith(expect.anything(), { enabled: false, token: undefined, content: null });
  });

  it('tests the dns-records token', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/dns-records/test', headers: asUser() });
    expect(res.json()).toEqual({ ok: true, status: 'active' });
    cfMocks.getDnsRecordsConfig.mockResolvedValueOnce({ enabled: true, token: null, content: null });
    const noToken = await (await app()).inject({ method: 'POST', url: '/dns-records/test', headers: asUser() });
    expect(noToken.json()).toEqual({ ok: false, error: 'No Cloudflare token configured' });
  });
});
