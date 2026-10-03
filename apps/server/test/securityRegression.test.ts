import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildAgentApp } from '../src/agentApp.js';
import { agentRoutes } from '../src/agent.js';
import { hashPassword, verifyPassword } from '../src/lib/crypto.js';

const infra = vi.hoisted(() => ({
  worker: vi.fn(async () => undefined),
  traefik: vi.fn(async () => undefined),
  collector: vi.fn(async () => undefined),
  backups: vi.fn(async () => undefined),
}));

vi.mock('../src/plugins/worker.js', () => ({ default: infra.worker }));
vi.mock('../src/plugins/traefik.js', () => ({ default: infra.traefik }));
vi.mock('../src/plugins/collector.js', () => ({ default: infra.collector }));
vi.mock('../src/plugins/backupScheduler.js', () => ({ default: infra.backups }));

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-secreg-'));
const dbPath = path.join(tmp, 'ninedeploy.db');



async function bootProd() {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NINEDEPLOY_DATA_DIR', tmp);
  vi.stubEnv('NINEDEPLOY_DB_PATH', dbPath);
  vi.stubEnv('NINEDEPLOY_JWT_SECRET', 'a-strong-production-secret-value');
  const mod = await import('../src/app.js');
  return mod.buildApp();
}

afterAll(() => {
  vi.unstubAllEnvs();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows SQLite file lock */
  }
});

describe('K1: no default admin is seeded or force-reset on boot', () => {
  it('a production boot against a fresh database creates no users', { timeout: 20000 }, async () => {
    const app = await bootProd();
    const users = await app.db.query.users.findMany();
    expect(users).toEqual([]);
    await app.close();
  });

  it('a reboot never resets an operator-changed admin password to a known default', { timeout: 20000 }, async () => {
    const app = await bootProd();
    const strong = 'an-operator-changed-strong-password';
    await app.db.insert((await import('@ninedeploy/db')).users).values({
      email: 'root@example.com',
      passwordHash: await hashPassword(strong),
      name: 'Root',
      isOperator: true,
    });
    await app.close();

    // Reboot on the same DB file — the old code reset this hash to admin123456 here.
    const app2 = await bootProd();
    const rows = await app2.db.query.users.findMany({ where: (u, { eq }) => eq(u.email, 'root@example.com') });
    expect(rows).toHaveLength(1);
    const hash = rows[0]!.passwordHash;
    expect(await verifyPassword(hash, strong)).toBe(true);
    expect(await verifyPassword(hash, 'admin123456')).toBe(false);
    await app2.close();
  });
});

describe('K4: agent mode exposes only the minimal agent surface', () => {
  it('buildAgentApp serves only /agent routes — no /v1 API, no dashboard, no /health', async () => {
    const app = await buildAgentApp();
    await app.register(agentRoutes, { tokenHash: 'a'.repeat(64) });
    await app.ready();
    const routes = app.printRoutes();
    expect(routes).toContain('agent/');
    expect(routes).not.toContain('v1');
    expect(routes).not.toContain('health');

    // Behavioral proof: an API route that exists on the master app must 404 here.
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: '{}' });
    expect(res.statusCode).toBe(404);
    const res2 = await app.inject({ method: 'GET', url: '/health' });
    expect(res2.statusCode).toBe(404);
    await app.close();
  });
});
