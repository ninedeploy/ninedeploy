import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsRoutes } from '../src/modules/settings.js';
import { asUser, buildTestApp, createFakeDb } from './helpers.js';

const settingsMock = vi.hoisted(() => {
  // A per-key map the tests can populate. The mock `getSettingString`
  // returns the matching value (or `null` by default), and `setSettingString`
  // records the (key, value) pair so the Namecheap PUT test can assert
  // it without poking at the db mock.
  const values: Record<string, string> = {};
  return {
    getSetting: vi.fn(async () => false),
    setSetting: vi.fn(async () => undefined),
    getSettingString: vi.fn(async (_db: unknown, key: string) => (key in values ? values[key]! : (key === 'dns_token_encrypted' ? 'enc' : null))),
    setSettingString: vi.fn(async (_db: unknown, key: string, value: string) => {
      values[key] = value;
    }),
    __values: values,
  };
});
vi.mock('../src/lib/settings.js', () => settingsMock);

const dnsMock = vi.hoisted(() => ({
  DNS_PROVIDERS: { cloudflare: 'CF_DNS_API_TOKEN', hetzner: 'HETZNER_API_TOKEN' },
  encryptDnsToken: vi.fn((t: string) => `enc:${t}`),
  ensureNetwork: vi.fn(async () => undefined),
  ensureTraefik: vi.fn(async () => undefined),
  getAcmeEmail: vi.fn(async () => 'acme@example.com'),
  getDnsConfig: vi.fn(async () => null),
  writeDynamicConfig: vi.fn(async () => undefined),
}));
vi.mock('../src/engine/proxy.js', () => dnsMock);

const keyMock = vi.hoisted(() => ({
  activeKeyVersion: vi.fn(() => 1),
  knownKeyVersions: vi.fn(() => [0, 1]),
  rotateSecretsWithReport: vi.fn(async () => ({ rotated: 7, activeVersion: 1, backupsNotRotated: 0 })),
}));
vi.mock('../src/lib/crypto.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  activeKeyVersion: keyMock.activeKeyVersion,
  knownKeyVersions: keyMock.knownKeyVersions,
}));
vi.mock('../src/lib/keyRotation.js', () => ({ rotateSecretsWithReport: keyMock.rotateSecretsWithReport }));

const vaultMock = vi.hoisted(() => ({
  getVaultConfig: vi.fn(async () => ({ provider: null, token: null, projectId: null, environment: null })),
  setVaultConfig: vi.fn(async () => undefined),
  testVault: vi.fn(async () => 0),
  ensureVaultAllowlistInitialised: vi.fn(async () => ({ workspaceIds: [], serviceIds: [] })),
  setVaultAllowlist: vi.fn(async (_db: unknown, list: unknown) => list),
}));
vi.mock('../src/lib/vault.js', () => vaultMock);

const cloudflareDnsMock = vi.hoisted(() => ({
  getDnsRecordsConfig: vi.fn(async () => ({ enabled: false, token: null, content: null })),
  setDnsRecordsConfig: vi.fn(async () => undefined),
  testCloudflareToken: vi.fn(async () => 'ok'),
}));
vi.mock('../src/lib/cloudflare.js', () => cloudflareDnsMock);

describe('settings routes (admin-only)', () => {
  it('returns the current flags', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ allowRegistration: false, acmeEmail: null, templatesSource: null, dnsProvider: null, hasDnsToken: true, wildcardApex: null, panelDomain: null });
    await app.close();
  });

  it('saves and clears the panel domain and triggers writeDynamicConfig', async () => {
    const db = createFakeDb();
    const app = await buildTestApp({ db });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/panel-domain',
      headers: asUser(),
      payload: { domain: 'panel.example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, panelDomain: 'panel.example.com' });
    expect(settingsMock.setSettingString).toHaveBeenCalledWith(db, 'panel_domain', 'panel.example.com');
    expect(dnsMock.writeDynamicConfig).toHaveBeenCalledWith(db);

    // Clear domain
    const resClear = await app.inject({
      method: 'PUT',
      url: '/panel-domain',
      headers: asUser(),
      payload: { domain: '' },
    });
    expect(resClear.statusCode).toBe(200);
    expect(resClear.json()).toEqual({ ok: true, panelDomain: null });
    await app.close();
  });

  it('still 200s on PUT /panel-domain when writeDynamicConfig throws (caught silently)', async () => {
    // The route calls `await writeDynamicConfig(app.db).catch(() => undefined)`
    // — a failed dynamic-config write is treated as non-fatal so
    // the operator can still save the panel domain. A regression
    // that drops the .catch would 500 the request on every DNS
    // blip.
    dnsMock.writeDynamicConfig.mockRejectedValueOnce(new Error('docker daemon offline'));
    const db = createFakeDb();
    const app = await buildTestApp({ db });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/panel-domain',
      headers: asUser(),
      payload: { domain: 'panel.example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, panelDomain: 'panel.example.com' });
    expect(settingsMock.setSettingString).toHaveBeenCalledWith(db, 'panel_domain', 'panel.example.com');
    expect(dnsMock.writeDynamicConfig).toHaveBeenCalledWith(db);
    await app.close();
  });

  it('toggles open registration and audits the change', async () => {
    const db = createFakeDb();
    const app = await buildTestApp({ db });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/allow-registration',
      headers: asUser(),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, allowRegistration: false });
    expect(settingsMock.setSetting).toHaveBeenCalledWith(db, 'allow_registration', false);
    await app.close();
  });

  it('re-enables open registration (audit wording flips)', async () => {
    settingsMock.getSetting.mockResolvedValueOnce(false);
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/allow-registration',
      headers: asUser(),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, allowRegistration: true });
    expect(settingsMock.setSetting).toHaveBeenCalledWith(expect.anything(), 'allow_registration', true);
    await app.close();
  });

  it('rejects a non-boolean payload with 400', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/allow-registration',
      headers: asUser(),
      payload: { enabled: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('exposes the DB-configured ACME email over the env fallback', async () => {
    settingsMock.getSettingString.mockResolvedValueOnce('ops@example.com');
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().acmeEmail).toBe('ops@example.com');
    await app.close();
  });

  it('saves the ACME email and audits it', async () => {
    const db = createFakeDb();
    const app = await buildTestApp({ db });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/acme-email',
      headers: asUser(),
      payload: { email: 'acme@example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, acmeEmail: 'acme@example.com', applied: 'live' });
    expect(settingsMock.setSettingString).toHaveBeenCalledWith(db, 'acme_email', 'acme@example.com');
    await app.close();
  });

  it('clears the ACME email with an empty string', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/acme-email',
      headers: asUser(),
      payload: { email: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, acmeEmail: null, applied: 'live' });
    await app.close();
  });

  it('rejects an invalid ACME email with 400', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/acme-email',
      headers: asUser(),
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('saves and clears the template registry source', async () => {
    const db = createFakeDb();
    const app = await buildTestApp({ db });
    await app.register(settingsRoutes);
    const set = await app.inject({
      method: 'PUT', url: '/templates-source', headers: asUser(),
      payload: { source: 'https://registry.example.com/registry.json' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ ok: true, templatesSource: 'https://registry.example.com/registry.json' });
    expect(settingsMock.setSettingString).toHaveBeenCalledWith(db, 'templates_source', 'https://registry.example.com/registry.json');

    const local = await app.inject({
      method: 'PUT', url: '/templates-source', headers: asUser(),
      payload: { source: '/etc/ninedeploy/registry.json' },
    });
    expect(local.statusCode).toBe(200);

    const cleared = await app.inject({
      method: 'PUT', url: '/templates-source', headers: asUser(),
      payload: { source: '' },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ ok: true, templatesSource: null });
    await app.close();
  });

  it('rejects an invalid template source with 400', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT', url: '/templates-source', headers: asUser(),
      payload: { source: 'ftp://nope.example.com/registry.json' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('reports a token configured via env (env-only setup)', async () => {
    vi.stubEnv('NINEDEPLOY_DNS_TOKEN', 'env-token');
    vi.stubEnv('NINEDEPLOY_WILDCARD_DOMAIN', 'env.example.com');
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasDnsToken).toBe(true);
    expect(res.json().wildcardApex).toBe('env.example.com');
    expect(res.json().dnsProvider).toBe(null);
    vi.unstubAllEnvs();
    await app.close();
  });

  it('reports no token when neither DB nor env has one', async () => {
    settingsMock.getSettingString.mockImplementation(async (_db: unknown, key: string) => (key === 'dns_token_encrypted' ? null : null));
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.json().hasDnsToken).toBe(false);
    await app.close();
  });

  it('saves the DNS-01 challenge config with an encrypted token', async () => {
    const db = createFakeDb();
    const app = await buildTestApp({ db });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT', url: '/dns', headers: asUser(),
      payload: { provider: 'cloudflare', token: 'sekrit', wildcardApex: 'example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, dnsProvider: 'cloudflare', wildcardApex: 'example.com', applied: 'live' });
    expect(settingsMock.setSettingString).toHaveBeenCalledWith(db, 'dns_provider', 'cloudflare');
    expect(settingsMock.setSettingString).toHaveBeenCalledWith(db, 'dns_token_encrypted', 'enc:sekrit');
    expect(settingsMock.setSettingString).toHaveBeenCalledWith(db, 'wildcard_domain', 'example.com');
    await app.close();
  });

  it('keeps the stored token when the payload omits it and can clear the config', async () => {
    const db = createFakeDb();
    const app = await buildTestApp({ db });
    await app.register(settingsRoutes);
    const before = settingsMock.setSettingString.mock.calls.length;
    const keep = await app.inject({
      method: 'PUT', url: '/dns', headers: asUser(),
      payload: { provider: 'hetzner', wildcardApex: '' },
    });
    expect(keep.statusCode).toBe(200);
    const stored: unknown[][] = settingsMock.setSettingString.mock.calls.slice(before).map((c) => [c[1], c[2]]);
    expect(stored).not.toContainEqual(['dns_token_encrypted', expect.any(String)]);

    const cleared = await app.inject({
      method: 'PUT', url: '/dns', headers: asUser(),
      payload: { provider: '', wildcardApex: '' },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ ok: true, dnsProvider: null, wildcardApex: null, applied: 'live' });
    await app.close();
  });

  it('rejects an unsupported DNS provider with 400', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT', url: '/dns', headers: asUser(),
      payload: { provider: 'nope', wildcardApex: '' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a malformed wildcard apex with 400', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT', url: '/dns', headers: asUser(),
      payload: { provider: 'cloudflare', wildcardApex: 'not a domain' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  // ── Namecheap DNS records (G-07 PR-A) ─────────────────────────────────
  // Round-trip coverage of the credential store lives in
  // `test/lib/namecheap.test.ts` (the real crypto.encrypt/decrypt
  // round-trip the route depends on). Here we only check the input
  // validation surface, which the route alone is responsible for.
  describe('Namecheap DNS records input validation', () => {
    it('PUT /dns-records/namecheap rejects a non-IPv4 clientIp with 400', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(settingsRoutes);
      const res = await app.inject({
        method: 'PUT',
        url: '/dns-records/namecheap',
        headers: asUser(),
        payload: { apiUser: 'u', apiKey: 'k-1234567890', clientIp: 'not-an-ip' },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('PUT /dns-records/namecheap rejects a missing apiKey with 400', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(settingsRoutes);
      const res = await app.inject({
        method: 'PUT',
        url: '/dns-records/namecheap',
        headers: asUser(),
        payload: { apiUser: 'u', clientIp: '1.2.3.4' },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('PUT /dns-records/namecheap rejects an empty apiUser with 400', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(settingsRoutes);
      const res = await app.inject({
        method: 'PUT',
        url: '/dns-records/namecheap',
        headers: asUser(),
        payload: { apiUser: '', apiKey: ['k', '1234567890'].join('-'), clientIp: '1.2.3.4' },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  // Round-trip coverage for the DNS-records / Namecheap happy paths
  // the input-validation tests cannot reach. The mock fixtures
  // wire the cloudflareDnsMock + namecheapConfig (via the
  // getNamecheapConfig / setNamecheapConfig shims).
  describe('DNS records happy paths', () => {
    // Capture the original `getSettingString` implementation so a
    // prior test's `mockImplementation` (line 249, "reports no
    // token when neither DB nor env has one") does not leak into
    // these tests. `vi.restoreMocks()` would also work but the
    // shim is intentionally per-test isolation — the file's other
    // describe blocks keep using their own seeded `__values` map.
    const originalGetSettingString = settingsMock.getSettingString.getMockImplementation();
    beforeEach(() => {
      // Restore the original implementation that reads from
      // `__values` so the populated values in each test are
      // visible to the route under test.
      if (originalGetSettingString) {
        settingsMock.getSettingString.mockImplementation(originalGetSettingString);
      }
      // Clear any queued mock values from earlier tests so a
      // `mockResolvedValueOnce` from one test does not bleed into
      // the next. The default implementation returns the same
      // shape as the rest of the file (enabled: false, token: null).
      cloudflareDnsMock.getDnsRecordsConfig.mockReset();
      cloudflareDnsMock.getDnsRecordsConfig.mockResolvedValue({
        enabled: false,
        token: null,
        content: null,
      });
      cloudflareDnsMock.setDnsRecordsConfig.mockReset();
      cloudflareDnsMock.testCloudflareToken.mockReset();
      cloudflareDnsMock.testCloudflareToken.mockResolvedValue('ok');
    });
    it('POST /dns-records/test returns ok with the active status when a token is configured', async () => {
      cloudflareDnsMock.getDnsRecordsConfig.mockResolvedValueOnce({
        enabled: true,
        token: 'cf-token',
        content: null,
      });
      cloudflareDnsMock.testCloudflareToken.mockResolvedValueOnce('active');
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(settingsRoutes);
      const res = await app.inject({ method: 'POST', url: '/dns-records/test', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, status: 'active' });
      expect(cloudflareDnsMock.testCloudflareToken).toHaveBeenCalledWith('cf-token');
      await app.close();
    });

    it('GET /dns-records/namecheap returns the configured apiUser + clientIp', async () => {
      // The previous input-validation tests only exercised the
      // configured=false branch (empty settings map). For the
      // configured=true branch we go through the real crypto
      // round-trip so getNamecheapConfig sees a token it can
      // decrypt.
      const { encrypt } = await import('../src/lib/crypto.js');
      const previousKey = process.env['NINEDEPLOY_MASTER_KEY'];
      process.env['NINEDEPLOY_MASTER_KEY'] = 'b'.repeat(64);
      try {
        const realEncrypted = encrypt('nc-key');
        // Clear any leftover values from earlier tests — the
        // shared settings mock keeps state across tests in the
        // same file, and a stray key from a previous PUT can
        // flip the configured=true branch off.
        for (const k of Object.keys(settingsMock.__values)) delete settingsMock.__values[k];
        Object.assign(settingsMock.__values, {
          namecheap_api_user: 'nc-user',
          namecheap_api_key_encrypted: realEncrypted,
          namecheap_client_ip: '1.2.3.4',
        });
        // Sanity check: prove the mock's getSettingString is
        // reading the value we just stored. (The shared
        // `settingsMock` keeps state across tests in the same
        // file, and the prior `mockImplementation` test would
        // otherwise shadow the factory-supplied lookup.)
        const probe = await settingsMock.getSettingString(undefined as never, 'namecheap_api_user');
        expect(probe).toBe('nc-user');
        const app = await buildTestApp({ db: createFakeDb() });
        await app.register(settingsRoutes);
        const res = await app.inject({ method: 'GET', url: '/dns-records/namecheap', headers: asUser() });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          configured: true,
          apiUser: 'nc-user',
          clientIp: '1.2.3.4',
          hasKey: true,
        });
        for (const k of Object.keys(settingsMock.__values)) delete settingsMock.__values[k];
        await app.close();
      } finally {
        if (previousKey === undefined) delete process.env['NINEDEPLOY_MASTER_KEY'];
        else process.env['NINEDEPLOY_MASTER_KEY'] = previousKey;
      }
    });

    it('GET /dns-records/namecheap returns all-nulls when the operator has not configured Namecheap', async () => {
      // The opposite of the configured=true test: an empty
      // settings map means `getNamecheapConfig` returns `null`,
      // and the route's `cfg?.apiUser ?? null` /
      // `cfg?.clientIp ?? null` short-circuits fire. The two
      // `?? null` arms are the only branches this test covers —
      // the configured=true test above exercises the truthy
      // side of the same expressions.
      for (const k of Object.keys(settingsMock.__values)) delete settingsMock.__values[k];
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(settingsRoutes);
      const res = await app.inject({ method: 'GET', url: '/dns-records/namecheap', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        configured: false,
        apiUser: null,
        clientIp: null,
        hasKey: false,
      });
      await app.close();
    });

    it('PUT /dns-records/namecheap saves the triple and audits the apiUser', async () => {
      // Persistence is exercised by the lib/namecheap unit tests.
      // Here we only check the route returns 200 and the audit
      // side-effect runs — a regression that drops the audit call
      // leaves a silent gap in the activity log.
      for (const k of Object.keys(settingsMock.__values)) delete settingsMock.__values[k];
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(settingsRoutes);
      const res = await app.inject({
        method: 'PUT',
        url: '/dns-records/namecheap',
        headers: asUser(),
        payload: { apiUser: 'nc-user', apiKey: 'k-1234567890', clientIp: '1.2.3.4' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, apiUser: 'nc-user' });
      // The route persists via the shared `setSettingString` shim
      // and audits via `audit()`. The audit call goes to the
      // shared fake db (we don't assert the row directly — the
      // shape is covered by the lib/audit tests).
      expect(settingsMock.__values['namecheap_api_user']).toBe('nc-user');
      expect(settingsMock.__values['namecheap_client_ip']).toBe('1.2.3.4');
      for (const k of Object.keys(settingsMock.__values)) delete settingsMock.__values[k];
      await app.close();
    });
  });

  /**
   * `lib/keyRotation.rotateSecrets` was implemented, tested, and called by
   * nothing. `.env.example` told operators to run `ninedeploy rotate-keys`, a
   * command that did not exist — so anyone who followed the documented rotation
   * procedure and then dropped the retired key version from
   * NINEDEPLOY_MASTER_KEYS was left holding ciphertext nothing could decrypt.
   */
  describe('master-key rotation', () => {
    it('reports the key ring', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(settingsRoutes);
      const res = await app.inject({ method: 'GET', url: '/master-key', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ activeVersion: 1, knownVersions: [0, 1], rotatable: true });
      await app.close();
    });

    it('refuses to rotate when the ring holds a single version', async () => {
      keyMock.knownKeyVersions.mockReturnValueOnce([0]).mockReturnValueOnce([0]);
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(settingsRoutes);
      const status = await app.inject({ method: 'GET', url: '/master-key', headers: asUser() });
      expect(status.json().rotatable).toBe(false);
      const res = await app.inject({ method: 'POST', url: '/master-key/rotate', headers: asUser() });
      expect(res.statusCode).toBe(422);
      expect(keyMock.rotateSecretsWithReport).not.toHaveBeenCalled();
      await app.close();
    });

    it('rotates and reports the count', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(settingsRoutes);
      const res = await app.inject({ method: 'POST', url: '/master-key/rotate', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ rotated: 7, activeVersion: 1, backupsNotRotated: 0, warning: null });
      await app.close();
    });

    it('warns that stored backups are NOT re-encrypted', async () => {
      // Backup envelopes carry their own `NDBK1:v<version>` header and are not
      // touched by the sweep. Retiring the old key would make every backup taken
      // under it permanently unrestorable — the one thing an operator has to
      // know before completing step 4 of the documented procedure.
      keyMock.rotateSecretsWithReport.mockResolvedValueOnce({ rotated: 7, activeVersion: 1, backupsNotRotated: 3 });
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(settingsRoutes);
      const res = await app.inject({ method: 'POST', url: '/master-key/rotate', headers: asUser() });
      expect(res.json().warning).toMatch(/3 stored backup/);
      await app.close();
    });

    it('rejects a member with 403', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(settingsRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/master-key/rotate',
        headers: { ...asUser(), 'x-test-role': 'member' },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  it('rejects a member with 403', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/allow-registration',
      headers: { ...asUser(), 'x-test-role': 'member' },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

// ── Node enrolment (M-6) ──────────────────────────────────────────────────
describe('enrolment token', () => {
  it('GET /enrolment reports enabled=false when no token is configured', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({ method: 'GET', url: '/enrolment', headers: asUser() });
    expect(res.json()).toEqual({ enabled: false, token: null });
    await app.close();
  });

  it('POST /enrolment/rotate returns the freshly minted token', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({ method: 'POST', url: '/enrolment/rotate', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; enabled: boolean; token: string | null };
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(true);
    expect(body.token).toBeTruthy();
    await app.close();
  });

  it('DELETE /enrolment clears the token and reports enabled=false', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/enrolment', headers: asUser() });
    expect(res.json()).toEqual({ ok: true, enabled: false });
    await app.close();
  });
});

// ── Cloudflare DNS records (G-07 PR-C) ───────────────────────────────────
describe('Cloudflare DNS records', () => {
  it('GET /dns-records returns enabled=false when the provider is not cloudflare', async () => {
    Object.assign(settingsMock.__values, { dns_records_provider: 'namecheap' });
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({ method: 'GET', url: '/dns-records', headers: asUser() });
    expect(res.json()).toMatchObject({ enabled: false });
    for (const k of Object.keys(settingsMock.__values)) delete settingsMock.__values[k];
    await app.close();
  });

  it('GET /dns-records returns enabled=false when no settings are stored', async () => {
    for (const k of Object.keys(settingsMock.__values)) delete settingsMock.__values[k];
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({ method: 'GET', url: '/dns-records', headers: asUser() });
    expect(res.json()).toEqual({ enabled: false, hasToken: false, content: null });
    await app.close();
  });

  it('PUT /dns-records saves the new enabled/token/content triple', async () => {
    for (const k of Object.keys(settingsMock.__values)) delete settingsMock.__values[k];
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/dns-records',
      headers: asUser(),
      payload: { enabled: true, token: 'cf-token-1234567890', content: '1.2.3.4' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, enabled: true });
    for (const k of Object.keys(settingsMock.__values)) delete settingsMock.__values[k];
    await app.close();
  });

  it('PUT /dns-records with enabled=false clears the provider', async () => {
    Object.assign(settingsMock.__values, { dns_records_provider: 'cloudflare' });
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/dns-records',
      headers: asUser(),
      payload: { enabled: false, content: '' },
    });
    expect(res.json()).toEqual({ ok: true, enabled: false });
    for (const k of Object.keys(settingsMock.__values)) delete settingsMock.__values[k];
    await app.close();
  });

  it('POST /dns-records/test returns ok:false when no token is configured', async () => {
    for (const k of Object.keys(settingsMock.__values)) delete settingsMock.__values[k];
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({ method: 'POST', url: '/dns-records/test', headers: asUser() });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/No Cloudflare token/);
    await app.close();
  });
});

// ── Vault provider (deploy-time secret resolution) ───────────────────────
describe('Vault provider (Infisical / Doppler)', () => {
  it('GET /vault returns the current provider / project / environment triple', async () => {
    vaultMock.getVaultConfig.mockResolvedValueOnce({
      provider: 'infisical',
      token: 'opaque',
      projectId: 'workspace-1',
      environment: 'production',
    });
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({ method: 'GET', url: '/vault', headers: asUser() });
    expect(res.json()).toEqual({
      provider: 'infisical',
      hasToken: true,
      projectId: 'workspace-1',
      environment: 'production',
      // r510: the allowlist rides along (additive).
      allowlist: { workspaceIds: [], serviceIds: [] },
      workspaces: [],
      allowedServices: [],
    });
    await app.close();
  });

  it('GET /vault reports hasToken=false when no token is configured', async () => {
    vaultMock.getVaultConfig.mockResolvedValueOnce({
      provider: 'doppler',
      token: null,
      projectId: 'proj-x',
      environment: 'dev',
    });
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({ method: 'GET', url: '/vault', headers: asUser() });
    expect(res.json()).toEqual({
      provider: 'doppler',
      hasToken: false,
      projectId: 'proj-x',
      environment: 'dev',
      allowlist: { workspaceIds: [], serviceIds: [] },
      workspaces: [],
      allowedServices: [],
    });
    await app.close();
  });

  it('PUT /vault keeps the stored token when the payload omits it', async () => {
    vaultMock.getVaultConfig.mockResolvedValueOnce({
      provider: 'infisical',
      token: 'old-stored-token',
      projectId: 'old-ws',
      environment: 'old-env',
    });
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/vault',
      headers: asUser(),
      payload: { provider: 'infisical', projectId: 'new-ws', environment: 'production' },
    });
    expect(res.json()).toEqual({ ok: true, provider: 'infisical' });
    // The route should have passed the stored token through,
    // not nulled it — operators can rotate projectId /
    // environment without re-entering the token.
    const setCall = vaultMock.setVaultConfig.mock.calls.at(-1)?.[1] as { token: string | null };
    expect(setCall.token).toBe('old-stored-token');
    await app.close();
  });

  it('PUT /vault clears the token when the provider switches', async () => {
    vaultMock.getVaultConfig.mockResolvedValueOnce({
      provider: 'infisical',
      token: 'opaque',
      projectId: 'ws',
      environment: 'prod',
    });
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/vault',
      headers: asUser(),
      payload: { provider: 'doppler', token: 'doppler-token', projectId: 'proj', environment: 'dev' },
    });
    expect(res.json()).toEqual({ ok: true, provider: 'doppler' });
    const setCall = vaultMock.setVaultConfig.mock.calls.at(-1)?.[1] as { token: string };
    expect(setCall.token).toBe('doppler-token');
    await app.close();
  });

  it('PUT /vault with an empty provider disables the integration', async () => {
    vaultMock.getVaultConfig.mockResolvedValueOnce({
      provider: 'infisical',
      token: 'opaque',
      projectId: 'ws',
      environment: 'prod',
    });
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/vault',
      headers: asUser(),
      payload: { provider: '' },
    });
    expect(res.json()).toEqual({ ok: true, provider: null });
    // Empty provider → null token, null projectId / environment.
    const setCall = vaultMock.setVaultConfig.mock.calls.at(-1)?.[1] as {
      provider: string | null;
      token: string | null;
      projectId: string | null;
      environment: string | null;
    };
    expect(setCall.provider).toBeNull();
    expect(setCall.token).toBeNull();
    expect(setCall.projectId).toBeNull();
    expect(setCall.environment).toBeNull();
    await app.close();
  });

  it('PUT /vault rejects an unknown provider with 400', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/vault',
      headers: asUser(),
      payload: { provider: 'hashicorp-vault' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST /vault/test returns the number of secrets the integration resolved', async () => {
    vaultMock.testVault.mockResolvedValueOnce(7);
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const res = await app.inject({ method: 'POST', url: '/vault/test', headers: asUser() });
    expect(res.json()).toEqual({ ok: true, secrets: 7 });
    await app.close();
  });
});

describe('settings routes — Traefik apply timer', () => {
  // PUT /dns and PUT /acme-email schedule `applyTraefikSettings`
  // to run 1 second AFTER the response flushes, so a successful
  // save doesn't look like a network failure to the operator
  // (the request itself is travelling through the proxy). The
  // timer is `unref()`'d so it does not pin the test process
  // open, and the onClose hook drains any pending timers.
  //
  // These tests pin the behaviour with vitest's fake timers
  // scoped to just `setTimeout` / `setInterval`. The narrower
  // scope matters: faking `setImmediate` and `process.nextTick`
  // (the global default) breaks fastify's internal request
  // scheduler and causes `app.inject()` to deadlock before the
  // response is ever returned.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules a Traefik apply ~1s after PUT /dns and runs it on the timer', async () => {
    // Reset the proxy mocks so this test owns the call counts.
    dnsMock.ensureNetwork.mockClear();
    dnsMock.ensureTraefik.mockClear();
    dnsMock.writeDynamicConfig.mockClear();
    // Drive the inner `log` callback in `applyTraefikSettings`:
    // the route hands `log` to ensureNetwork/ensureTraefik so
    // their docker progress lines flow through pino. The
    // factory-supplied mock just returns `undefined` and never
    // calls the callback; a one-shot implementation here covers
    // the otherwise-unreachable `(line) => app.log.info(...)`
    // arrow.
    let loggedFromApply: string | undefined;
    dnsMock.ensureNetwork.mockImplementationOnce(async (log: (line: string) => void) => {
      log('ensure-network: creating network ninedeploy');
      loggedFromApply = 'ensure-network';
      return undefined;
    });
    dnsMock.ensureTraefik.mockImplementationOnce(
      async (log: (line: string) => void, _email: unknown, _dns: unknown) => {
        log('ensure-traefik: container running');
        return undefined;
      },
    );
    const db = createFakeDb();
    const app = await buildTestApp({ db });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/dns',
      headers: asUser(),
      payload: { provider: 'cloudflare', token: 'sekrit', wildcardApex: 'example.com' },
    });
    expect(res.statusCode).toBe(200);
    // The apply must NOT have run yet — the timer is set for 1 s
    // after the response, so a synchronous run would race the
    // response flush.
    expect(dnsMock.ensureNetwork).not.toHaveBeenCalled();
    expect(dnsMock.ensureTraefik).not.toHaveBeenCalled();
    expect(dnsMock.writeDynamicConfig).not.toHaveBeenCalled();
    // Advance just past 1 s; the timer fires and the apply runs.
    // runAllTimersAsync drains the (faked) setTimeout queue and
    // awaits the microtask chain the timer callback scheduled.
    await vi.runAllTimersAsync();
    expect(dnsMock.ensureNetwork).toHaveBeenCalledTimes(1);
    expect(dnsMock.ensureTraefik).toHaveBeenCalledTimes(1);
    // ensureTraefik receives (log, acmeEmail, dnsConfig) — the
    // mocks are typed as `vi.fn(async () => undefined)` so any
    // call shape satisfies the assertion.
    expect(dnsMock.ensureTraefik).toHaveBeenCalledWith(
      expect.any(Function),
      'acme@example.com',
      null,
    );
    expect(dnsMock.writeDynamicConfig).toHaveBeenCalledWith(db);
    // The one-shot mock implementations invoked the route's log
    // callback — a regression that drops the log wiring would
    // surface here as `loggedFromApply === undefined`.
    expect(loggedFromApply).toBe('ensure-network');
    await app.close();
  });

  it('schedules a Traefik apply ~1s after PUT /acme-email and runs it on the timer', async () => {
    dnsMock.ensureNetwork.mockClear();
    dnsMock.ensureTraefik.mockClear();
    dnsMock.writeDynamicConfig.mockClear();
    const db = createFakeDb();
    const app = await buildTestApp({ db });
    await app.register(settingsRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/acme-email',
      headers: asUser(),
      payload: { email: 'new-acme@example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(dnsMock.ensureNetwork).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(dnsMock.ensureNetwork).toHaveBeenCalledTimes(1);
    expect(dnsMock.ensureTraefik).toHaveBeenCalledTimes(1);
    expect(dnsMock.writeDynamicConfig).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('catches and logs a thrown error from the apply (does not propagate)', async () => {
    // If `ensureNetwork` throws, the route must swallow it — the
    // scheduleTraefikSettingsApply body is `void
    // applyTraefikSettings().catch(err => app.log.error(...))`,
    // and a leaked rejection would crash the worker on the
    // unhandledRejection path. We assert no unhandled rejection
    // by simply advancing time and checking the error spy.
    dnsMock.ensureNetwork.mockClear();
    dnsMock.ensureTraefik.mockClear();
    dnsMock.writeDynamicConfig.mockClear();
    dnsMock.ensureNetwork.mockRejectedValueOnce(new Error('docker daemon offline'));
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);
    try {
      await app.inject({
        method: 'PUT',
        url: '/acme-email',
        headers: asUser(),
        payload: { email: 'err-acme@example.com' },
      });
      await vi.runAllTimersAsync();
      // ensureNetwork was called (and rejected); the catch
      // swallowed the rejection. ensureTraefik / writeDynamicConfig
      // never ran because the rejection fired before them.
      expect(dnsMock.ensureNetwork).toHaveBeenCalledTimes(1);
      expect(dnsMock.ensureTraefik).not.toHaveBeenCalled();
      expect(dnsMock.writeDynamicConfig).not.toHaveBeenCalled();
      // Yield once so the rejection chain is fully settled before
      // we assert. (A setTimeout here would never fire under fake
      // timers — we are still in the fake-timers scope from
      // beforeEach.)
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandled);
      await app.close();
    }
  });

  it('drains pending Traefik apply timers when the app closes', async () => {
    // The onClose hook in the settings plugin walks
    // `traefikApplyTimers` and `clearTimeout`s each one. Without
    // it, a PUT /dns 200 ms before the worker shuts down would
    // fire `ensureNetwork` against a torn-down proxy.
    dnsMock.ensureNetwork.mockClear();
    dnsMock.ensureTraefik.mockClear();
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(settingsRoutes);
    await app.inject({
      method: 'PUT',
      url: '/dns',
      headers: asUser(),
      payload: { provider: 'cloudflare', token: 'sekrit', wildcardApex: 'example.com' },
    });
    // The timer is pending but has not fired. Closing the app
    // should clearTimeout it.
    await app.close();
    // Advance fake time — the timer must NOT fire on a closed app.
    await vi.runAllTimersAsync();
    expect(dnsMock.ensureNetwork).not.toHaveBeenCalled();
    expect(dnsMock.ensureTraefik).not.toHaveBeenCalled();
  });
});
