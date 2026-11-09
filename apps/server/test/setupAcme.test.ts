/**
 * A2 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): first run in one flow.
 *  - the setup form's ACME email is stored only when none is configured;
 *  - the public status tells the form whether to offer it, before setup only;
 *  - a domain install (public URL = the domain) still seeds sslip.io URLs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => ({
  ensureNetwork: vi.fn(async () => undefined),
  traefikInputs: vi.fn(async () => ({ acmeEmail: 'certs@example.com', dns: null })),
  ensureTraefik: vi.fn(async () => undefined),
  writeDynamicConfig: vi.fn(async () => undefined),
}));
vi.mock('../src/engine/proxy.js', () => proxy);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('adoptSetupAcmeEmail', () => {
  it('stores the email, applies it to Traefik a moment later, and never overwrites a configured one', async () => {
    vi.useFakeTimers();
    const { migratedDb, closeMigratedDb } = await import('./lib/githubAppKit.js');
    const { adoptSetupAcmeEmail, acmeConfigured } = await import('../src/lib/setupAcme.js');
    const { getSettingString } = await import('../src/lib/settings.js');
    const db = await migratedDb();
    const log = { error: vi.fn() };
    expect(await acmeConfigured(db)).toBe(false);
    expect(await adoptSetupAcmeEmail(db, 1, 'certs@example.com', log)).toBe(true);
    expect(await getSettingString(db, 'acme_email', null)).toBe('certs@example.com');
    expect(await acmeConfigured(db)).toBe(true);
    expect(proxy.ensureTraefik).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1100);
    expect(proxy.ensureTraefik).toHaveBeenCalledWith(expect.any(Function), 'certs@example.com', null, expect.anything());
    expect(proxy.writeDynamicConfig).toHaveBeenCalled();
    // A second setup-time email (or any later call) leaves the first in place.
    expect(await adoptSetupAcmeEmail(db, 1, 'other@example.com', log)).toBe(false);
    expect(await getSettingString(db, 'acme_email', null)).toBe('certs@example.com');
    expect(log.error).not.toHaveBeenCalled();
    closeMigratedDb(db);
  });

  it('leaves the installer email (NINEDEPLOY_ACME_EMAIL) alone', async () => {
    vi.stubEnv('NINEDEPLOY_ACME_EMAIL', 'ops@example.com');
    const { migratedDb, closeMigratedDb } = await import('./lib/githubAppKit.js');
    const { adoptSetupAcmeEmail, acmeConfigured } = await import('../src/lib/setupAcme.js');
    const db = await migratedDb();
    expect(await acmeConfigured(db)).toBe(true);
    expect(await adoptSetupAcmeEmail(db, 1, 'certs@example.com', { error: vi.fn() })).toBe(false);
    closeMigratedDb(db);
  });

  it('logs instead of throwing when the settings write fails', async () => {
    const { adoptSetupAcmeEmail } = await import('../src/lib/setupAcme.js');
    const log = { error: vi.fn() };
    const broken = { select: () => { throw new Error('db down'); } } as never;
    expect(await adoptSetupAcmeEmail(broken, 1, 'certs@example.com', log)).toBe(false);
    expect(log.error).toHaveBeenCalled();
  });
});

describe('GET /v1/auth/status before and after setup', () => {
  it('reports acmeConfigured only while the instance is not initialized', async () => {
    const { migratedDb, closeMigratedDb } = await import('./lib/githubAppKit.js');
    const { authRoutes } = await import('../src/modules/auth.js');
    const { buildTestApp } = await import('./helpers.js');
    const { users } = await import('@ninedeploy/db');
    const db = await migratedDb();
    const app = await buildTestApp({ db });
    await app.register(authRoutes);
    expect((await app.inject({ method: 'GET', url: '/status' })).json()).toMatchObject({ initialized: false, acmeConfigured: false });
    await db.insert(users).values({ email: 'a@example.com', passwordHash: 'x' });
    const after = (await app.inject({ method: 'GET', url: '/status' })).json();
    expect(after.initialized).toBe(true);
    expect(after).not.toHaveProperty('acmeConfigured');
    await app.close();
    closeMigratedDb(db);
  });
});

describe('seedFreshInstallAutoUrl on a domain install', () => {
  it('takes the address from NINEDEPLOY_PUBLIC_IP when the public URL is the domain', async () => {
    vi.stubEnv('NINEDEPLOY_PUBLIC_URL', 'https://panel.example.com');
    vi.stubEnv('NINEDEPLOY_PUBLIC_IP', '203.0.113.7');
    const { migratedDb, closeMigratedDb } = await import('./lib/githubAppKit.js');
    const { seedFreshInstallAutoUrl, getAutoUrlConfig } = await import('../src/lib/autoUrl.js');
    const db = await migratedDb();
    await seedFreshInstallAutoUrl(db);
    expect(await getAutoUrlConfig(db)).toMatchObject({ mode: 'sslip', ip: '203.0.113.7' });
    closeMigratedDb(db);
  });

  it('seeds nothing from a private address', async () => {
    vi.stubEnv('NINEDEPLOY_PUBLIC_URL', 'https://panel.example.com');
    vi.stubEnv('NINEDEPLOY_PUBLIC_IP', '10.0.0.4');
    const { migratedDb, closeMigratedDb } = await import('./lib/githubAppKit.js');
    const { seedFreshInstallAutoUrl } = await import('../src/lib/autoUrl.js');
    const { getSettingString } = await import('../src/lib/settings.js');
    const db = await migratedDb();
    await seedFreshInstallAutoUrl(db);
    expect(await getSettingString(db, 'auto_url_mode', null)).toBeNull();
    closeMigratedDb(db);
  });
});
