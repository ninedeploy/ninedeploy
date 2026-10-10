/**
 * `loadRuntimeEnv(...).secretKeys` — which keys of a service's resolved env hold
 * a secret. Build placement uses it to refuse baking them into a Nixpacks image
 * that is pushed to a registry (engine/buildPlacement.ts). Names only.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDb, envVars, runMigrations, services } from '@ninedeploy/db';

// The pipeline module is imported for its env assembly only.
vi.mock('../src/engine/builders/docker.js', () => ({ dockerBuilder: {}, railpackUnavailableReason: vi.fn(async () => null) }));
vi.mock('../src/engine/builders/pm2.js', () => ({ pm2Builder: {} }));
vi.mock('../src/engine/builders/compose.js', () => ({ composeBuilder: {} }));
vi.mock('../src/engine/proxy.js', () => ({ writeDynamicConfig: vi.fn(), getAcmeEmail: vi.fn(async () => null) }));
vi.mock('../src/lib/agentClient.js', () => ({ agentOp: vi.fn() }));
vi.mock('../src/lib/git.js', () => ({ checkoutCommit: vi.fn() }));
vi.mock('../src/lib/exec.js', () => ({ sleep: vi.fn(async () => undefined), run: vi.fn() }));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const scratch = mkdtempSync(path.join(os.tmpdir(), 'nd-secretkeys-'));
vi.stubEnv('NINEDEPLOY_DATA_DIR', scratch);
vi.stubEnv('DOCKER_HOST', 'tcp://127.0.0.1:9');
vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'ab'.repeat(32));

const { encrypt } = await import('../src/lib/crypto.js');
const { loadRuntimeEnv } = await import('../src/engine/pipeline.js');

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe('loadRuntimeEnv secretKeys', () => {
  it('names the secret-flagged keys; a plain key and an overridden one stay out', async () => {
    const { db } = createDb({ url: ':memory:' });
    await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
    const [svc] = await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', repoUrl: 'https://github.com/acme/web.git' } as never).returning();
    const row = (key: string, value: string, isSecret: boolean) => ({ serviceId: svc!.id, scope: 'service', scopeKey: String(svc!.id), key, valueEncrypted: encrypt(value), isSecret });
    await db.insert(envVars).values([
      row('NEXT_PUBLIC_URL', 'https://x.example', false),
      row('STRIPE_KEY', 'sk_live_1', true),
      row('SESSION_SECRET', 'hunter2hunter2', true),
    ] as never);

    const env = await loadRuntimeEnv(db, svc!);
    expect(env.values).toEqual({ NEXT_PUBLIC_URL: 'https://x.example', STRIPE_KEY: 'sk_live_1', SESSION_SECRET: 'hunter2hunter2' });
    expect(env.secretKeys).toEqual(['SESSION_SECRET', 'STRIPE_KEY']);
    expect(JSON.stringify(env.secretKeys)).not.toContain('sk_live_1');
  });

  it('a service with no secret variables has none', async () => {
    const { db } = createDb({ url: ':memory:' });
    await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
    const [svc] = await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', repoUrl: 'https://github.com/acme/web.git' } as never).returning();
    expect((await loadRuntimeEnv(db, svc!)).secretKeys).toEqual([]);
  });
});
