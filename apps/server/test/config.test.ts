import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const tmp = path.join(os.tmpdir(), `ninedeploy-config-${process.pid}-${Date.now()}`);

async function loadConfig() {
  vi.resetModules();
  const mod = await import('../src/config.js');
  return mod.config;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('config', () => {
  it('resolves defaults and creates the data directories', async () => {
    for (const key of ['NINEDEPLOY_DATA_DIR', 'NINEDEPLOY_DB_PATH', 'NINEDEPLOY_HOST', 'NINEDEPLOY_PORT', 'NODE_ENV', 'NINEDEPLOY_PUBLIC_URL', 'NINEDEPLOY_WILDCARD_DOMAIN', 'NINEDEPLOY_JWT_SECRET']) {
      delete process.env[key];
    }

    const config = await loadConfig();
    // The default data dir anchors to the MONOREPO ROOT (three levels up from
    // apps/server/{src,dist}), NOT the process cwd: a restart from a different
    // working directory must not provision a fresh .data with a new master key
    // (that would make every stored secret undecryptable).
    const moduleDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const repoRoot = path.resolve(moduleDir, '..', '..', '..');

    expect(config.env).toBe('development');
    expect(config.isProd).toBe(false);
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(3000);
    expect(config.paths.dataDir).toBe(path.resolve(repoRoot, './.data'));
    expect(config.paths.dbFile).toBe(path.resolve(repoRoot, './.data/ninedeploy.db'));
    expect(config.dbUrl).toBe(`file:${path.resolve(repoRoot, './.data/ninedeploy.db')}`);
    expect(config.jwt.secret).toBe('dev-insecure-secret-change-me');
    expect(config.wildcardDomain).toBe('');

    for (const dir of [config.paths.dataDir, config.paths.reposDir, config.paths.logsDir, config.paths.backupsDir]) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  it('honours custom env and flags production mode', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NINEDEPLOY_HOST', '127.0.0.1');
    vi.stubEnv('NINEDEPLOY_PORT', '8443');
    vi.stubEnv('NINEDEPLOY_DATA_DIR', path.join(tmp, 'data'));
    vi.stubEnv('NINEDEPLOY_DB_PATH', path.join(tmp, 'db', 'ninedeploy.db'));
    vi.stubEnv('NINEDEPLOY_PUBLIC_URL', 'https://deploy.example.com');
    vi.stubEnv('NINEDEPLOY_JWT_SECRET', 'x'.repeat(32));
    vi.stubEnv('NINEDEPLOY_JWT_ACCESS_TTL', '30m');
    vi.stubEnv('NINEDEPLOY_JWT_REFRESH_TTL', '30d');
    vi.stubEnv('NINEDEPLOY_WILDCARD_DOMAIN', 'apps.example.com');

    const config = await loadConfig();

    expect(config.isProd).toBe(true);
    expect(config.env).toBe('production');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8443);
    expect(config.publicUrl).toBe('https://deploy.example.com');
    expect(config.paths.dataDir).toBe(path.join(tmp, 'data'));
    expect(config.dbUrl).toBe(`file:${path.join(tmp, 'db', 'ninedeploy.db')}`);
    expect(config.jwt).toMatchObject({ secret: 'x'.repeat(32), accessTtl: '30m', refreshTtl: '30d' });
    expect(config.wildcardDomain).toBe('apps.example.com');
    expect(existsSync(config.paths.backupsDir)).toBe(true);
  });

  it('passes through file: URLs without resolving them against the cwd', async () => {
    vi.stubEnv('NINEDEPLOY_DATA_DIR', path.join(tmp, 'data2'));
    vi.stubEnv('NINEDEPLOY_DB_PATH', 'file:/var/lib/ninedeploy/ninedeploy.db');

    const config = await loadConfig();

    expect(config.paths.dbFile).toBe('file:/var/lib/ninedeploy/ninedeploy.db');
    expect(config.dbUrl).toBe('file:/var/lib/ninedeploy/ninedeploy.db');
    expect(existsSync(config.paths.backupsDir)).toBe(true);
  });

  it('derives trustProxy from NINEDEPLOY_TRUST_PROXY (true/false/hop count)', async () => {
    vi.stubEnv('NINEDEPLOY_TRUST_PROXY', 'false');
    expect((await loadConfig()).trustProxy).toBe(false);

    vi.stubEnv('NINEDEPLOY_TRUST_PROXY', 'true');
    expect((await loadConfig()).trustProxy).toBe(true);

    // Default: trust ONE hop (the bundled Traefik) — and the Fastify-style
    // function trusts hop 0 while refusing hop 1 and beyond.
    delete process.env['NINEDEPLOY_TRUST_PROXY'];
    const trust = (await loadConfig()).trustProxy as (addr: string, hop: number) => boolean;
    expect(typeof trust).toBe('function');
    expect(trust('10.0.0.1', 0)).toBe(true);
    expect(trust('10.0.0.1', 1)).toBe(false);
    // r100: only a proxy on the host's own network is trusted — a public peer
    // (a client talking to the panel directly) never is.
    expect(trust('127.0.0.1', 0)).toBe(true);
    expect(trust('::ffff:172.18.0.2', 0)).toBe(true);
    expect(trust('203.0.113.9', 0)).toBe(false);
    expect(trust('2606:4700::1111', 0)).toBe(false);
  });

  it('ignores X-Forwarded-For from a directly-connected public client (r100)', async () => {
    // End to end through Fastify: with the address ignored, a fresh fake XFF
    // per request minted a fresh rate-limit bucket for every login attempt.
    delete process.env['NINEDEPLOY_TRUST_PROXY'];
    const { default: Fastify } = await import('fastify');
    const app = Fastify({ trustProxy: (await loadConfig()).trustProxy });
    app.get('/ip', async (req) => ({ ip: req.ip }));
    const spoofed = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '203.0.113.9',
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    expect(spoofed.json().ip).toBe('203.0.113.9');
    const viaTraefik = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '172.18.0.2',
      headers: { 'x-forwarded-for': '198.51.100.7' },
    });
    expect(viaTraefik.json().ip).toBe('198.51.100.7');
    await app.close();
  });
});
