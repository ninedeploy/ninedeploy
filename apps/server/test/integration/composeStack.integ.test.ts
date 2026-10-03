/**
 * Integration test: compose-stack lifecycle against a live Docker daemon —
 * the three guarantees this platform promises for template stacks:
 *
 *   1. first deploy comes up healthy through the REAL compose builder
 *      (magic-var resolver → .env → up → healthcheck wait),
 *   2. REDEPLOY is idempotent and loses no persistent data (named volume
 *      marker survives a full down+up cycle),
 *   3. a broken image tag FAILS THE DEPLOY while the previous stack keeps
 *      serving — the preflight gates never let a bad redeploy take the
 *      service down.
 *
 * Uses locally-cached images when present; gated on RUN_INTEGRATION=1 +
 * `docker compose` being available. Not part of coverage runs.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeBuilder } from '../../src/engine/builders/compose.js';
import { resolveStackEnvironment } from '../../src/engine/magicVars.js';
import { capture, run } from '../../src/lib/exec.js';

const ENABLED = process.env.RUN_INTEGRATION === '1';
let COMPOSE_OK = false;
if (ENABLED) {
  try {
    await capture('docker', ['compose', 'version']);
    COMPOSE_OK = true;
  } catch (_err) {
    COMPOSE_OK = false;
  }
}

const swallow = (): void => undefined;

// umami:latest + postgres:16-alpine are commonly cached on dev machines; the
// pre-pull gate would fetch them otherwise.
const COMPOSE_BODY = [
  'services:',
  '  umami:',
  '    image: ghcr.io/umami-software/umami:latest',
  '    environment:',
  '      - SERVICE_URL_UMAMI_3000',
  '      - DATABASE_URL=postgres://$SERVICE_USER_POSTGRES:$SERVICE_PASSWORD_POSTGRES@postgresql:5432/itestdb',
  '      - DATABASE_TYPE=postgres',
  '      - APP_SECRET=$SERVICE_PASSWORD_64_UMAMI',
  '      - DISABLE_TELEMETRY=1',
  '    depends_on:',
  '      postgresql:',
  '        condition: service_healthy',
  '    healthcheck:',
  '      test: ["CMD", "curl", "-f", "http://127.0.0.1:3000/api/heartbeat"]',
  '      interval: 5s',
  '      timeout: 10s',
  '      retries: 24',
  '  postgresql:',
  '    image: postgres:16-alpine',
  '    environment:',
  '      - POSTGRES_USER=$SERVICE_USER_POSTGRES',
  '      - POSTGRES_PASSWORD=$SERVICE_PASSWORD_POSTGRES',
  '      - POSTGRES_DB=itestdb',
  '    volumes:',
  '      - itest-pgdata:/var/lib/postgresql/data',
  '    healthcheck:',
  '      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d itestdb"]',
  '      interval: 5s',
  '      timeout: 10s',
  '      retries: 24',
  'volumes:',
  '  itest-pgdata:',
].join('\n');

describe.skipIf(!ENABLED || !COMPOSE_OK)('compose stack lifecycle (real Docker daemon)', () => {
  const slug = `itest-${Date.now().toString(36)}`;
  const project = `ndcmp-${slug}`;
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'nd-itest-'));
  const composeFile = path.join(workDir, 'docker-compose.yml');
  const pgContainer = `${project}-postgresql-1`;

  const resolved = resolveStackEnvironment(COMPOSE_BODY, { publicUrl: 'http://localhost' });
  const mkCtx = () => ({
    deploymentId: 1,
    service: { slug, composeService: 'umami', port: 3000, healthPath: '/' },
    buildConfig: { dockerfilePath: 'docker-compose.yml' },
    workDir,
    env: resolved.values,
    volumeAttachments: [],
    log: (line: string): void => console.log(`    │ ${line}`),
  });

  const writeCompose = (body: string): void => writeFileSync(composeFile, body);

  beforeAll(() => {
    writeCompose(COMPOSE_BODY);
  });

  afterAll(async () => {
    await run('docker', ['compose', '-p', project, '-f', composeFile, 'down', '--volumes', '--remove-orphans'], {}, swallow).catch(swallow);
    rmSync(workDir, { recursive: true, force: true });
  });

  // Missing file (pre-write) exits 1 — that is an empty marker, not an error.
  const marker = async (): Promise<string> =>
    capture('docker', ['exec', pgContainer, 'cat', '/var/lib/postgresql/data/.nd-e2e-marker'])
      .then((v) => v.trim())
      .catch(() => '');

  it(
    'deploys the stack healthy, survives a redeploy with data intact, and keeps serving through a bad-tag redeploy',
    { timeout: 600_000 },
    async () => {
      // ── 1. First deploy: healthy through the real builder path ──────────
      const first = await composeBuilder.buildAndRun(mkCtx() as never);
      const healthyFirst = await composeBuilder.isHealthy(first, 300_000, 0, console.log);
      expect(healthyFirst, 'first deploy should become healthy').toBe(true);
      expect(await marker()).toBe(''); // empty before we write it

      // ── 2. Persistence marker INSIDE the postgres named volume ─────────
      await run('docker', ['exec', pgContainer, 'sh', '-c', 'echo persisted > /var/lib/postgresql/data/.nd-e2e-marker'], {}, swallow);

      // ── 3. Redeploy: full down+up cycle, marker must survive ───────────
      const second = await composeBuilder.buildAndRun(mkCtx() as never);
      expect(second.runtimeId).toBe(first.runtimeId); // in-place, deterministic
      const healthySecond = await composeBuilder.isHealthy(second, 300_000, 0, console.log);
      expect(healthySecond, 'redeploy should become healthy again').toBe(true);
      expect(await marker()).toBe('persisted');

      // ── 4. Bad tag: deploy fails, previous stack stays healthy ─────────
      writeCompose(COMPOSE_BODY.replace('umami:latest', 'umami:no-such-tag-e2e'));
      await expect(composeBuilder.buildAndRun(mkCtx() as never)).rejects.toThrow();
      const stillHealthy = await composeBuilder.isHealthy(second, 30_000, 0, console.log);
      expect(stillHealthy, 'old stack must keep serving after a failed redeploy').toBe(true);
      expect(await marker()).toBe('persisted');

      // Restore the good file so afterAll cleanup downs the healthy project.
      writeCompose(COMPOSE_BODY);
    },
  );
});
