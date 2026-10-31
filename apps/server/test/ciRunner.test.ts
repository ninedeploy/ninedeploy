import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ciJobs, envVars, services, users } from '@ninedeploy/db';
import { jobEnv, jobRunArgs, type RunnerOptions, runnerLabel, runRunner } from '../src/ciRunner.js';
import * as ci from '../src/lib/ci.js';
import { encrypt } from '../src/lib/crypto.js';
import { ciRunnerProtocolRoutes } from '../src/modules/ci.js';
import { closeMigratedDb, migratedDb } from './lib/githubAppKit.js';

const dataDir = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
  const dir = `${process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp'}/nd-runner-data-${process.pid}`;
  process.env['NINEDEPLOY_DATA_DIR'] = dir;
  return dir;
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const opts: RunnerOptions = {
  url: 'https://panel.example.com',
  token: 'ndrun_abc',
  capacity: 1,
  pollMs: 1000,
  memory: '1g',
  cpus: '1',
  pidsLimit: 256,
  docker: 'docker',
  workDir: '/var/lib/ninedeploy-runner',
  version: 'test',
  log: () => undefined,
};

const SECRET = ['very', 'secret'].join('-');
const claim = {
  attemptId: 12,
  jobId: 3,
  number: 2,
  leaseToken: 'ndlease_x',
  leaseSeconds: 60,
  heartbeatSeconds: 15,
  image: 'node:24-alpine',
  script: 'npm test',
  timeoutSeconds: 600,
  env: { API_KEY: SECRET },
  commitSha: 'a'.repeat(40),
  sourcePath: null,
};

describe('R5 runner: the job container', () => {
  const args = jobRunArgs(opts, claim, { source: '/w/src', script: '/w/script.sh' });

  it('gets the workspace and the script, limits, and no way to raise privileges', () => {
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(args).toEqual(expect.arrayContaining(['--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '1g', '--cpus', '1']));
    expect(args.join(' ')).toContain('-v /w/src:/workspace -v /w/script.sh:/nd-ci/script.sh:ro');
    expect(args.slice(-4)).toEqual(['/bin/sh', 'node:24-alpine', '-e', '/nd-ci/script.sh']);
  });

  it('never mounts the Docker socket, never runs privileged, and keeps secret values off the command line', () => {
    const line = args.join(' ');
    expect(line).not.toMatch(/docker\.sock|--privileged|--cap-add|--network[= ]host|--pid[= ]host/);
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain('ndlease_x');
    expect(line).not.toContain('ndrun_abc');
    expect(args).toEqual(expect.arrayContaining(['-e', 'API_KEY', '-e', `NINEDEPLOY_CI_COMMIT=${'a'.repeat(40)}`]));
  });

  it("labels the container with this runner's id (not its token) for orphan cleanup", () => {
    expect(runnerLabel('ndrun_abc')).toMatch(/^[0-9a-f]{16}$/);
    expect(args).toEqual(expect.arrayContaining(['--label', `ninedeploy.ci-runner=${runnerLabel('ndrun_abc')}`, '--name', 'nd-ci-12']));
  });
});

describe('R5 runner: job variables never steer the docker client', () => {
  it('drops reserved names from both the -e list and the client environment, and the schema refuses them', async () => {
    const { ciPipeline } = await import('@ninedeploy/schemas');
    const hostile = { DOCKER_HOST: 'tcp://evil:2375', LD_PRELOAD: '/tmp/x.so', PATH: '/evil', NODE_OPTIONS: '--require x', docker_config: '/x', HTTPS_PROXY: 'http://evil', API_KEY: SECRET };
    expect(jobEnv(hostile)).toEqual({ API_KEY: SECRET });
    const args = jobRunArgs(opts, { ...claim, env: hostile }, { source: '/w/src', script: '/w/s.sh' });
    // Variables passed by name (the shell's own `-e /nd-ci/script.sh` aside).
    expect(args.filter((a, i) => args[i - 1] === '-e' && !a.includes('=') && !a.startsWith('/'))).toEqual(['API_KEY']);
    for (const name of ['DOCKER_HOST', 'LD_PRELOAD', 'PATH', 'NODE_OPTIONS', 'docker_tls_verify', 'BASH_ENV', 'NINEDEPLOY_RUNNER_TOKEN', 'CI']) {
      expect(ciPipeline.safeParse({ image: 'alpine:3.20', script: 'true', secrets: [name] }).success, name).toBe(false);
    }
    expect(ciPipeline.safeParse({ image: 'alpine:3.20', script: 'true', secrets: ['NPM_TOKEN', 'DATABASE_URL'] }).success).toBe(true);
  });
});

describe('R5 runner against the real CI routes (docker replaced by a stand-in)', () => {
  it('removes its orphans, runs jobs, ships logs and reports one result each', async () => {
    const db = await migratedDb();
    const work = mkdtempSync(path.join(os.tmpdir(), 'nd-runner-test-'));
    const calls = path.join(work, 'docker.log');
    process.env['FAKE_DOCKER_LOG'] = calls;
    await db.insert(users).values({ id: 1, email: 'ops@example.com', passwordHash: 'x', isInstanceOperator: true } as never);
    await db.insert(services).values({ id: 1, name: 'img', slug: 'img', type: 'docker', image: 'nginx:1.27', ownerUserId: 1 } as never);
    await db.insert(envVars).values({ serviceId: 1, key: 'API_KEY', valueEncrypted: encrypt(SECRET), isSecret: true } as never);
    const app = Fastify({ logger: false });
    app.decorate('db', db as never);
    await app.register(async (api) => api.register(ciRunnerProtocolRoutes, { prefix: '/ci/runner' }), { prefix: '/v1' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const { token } = await ci.createRunner(db, { name: 't', labels: [], capacity: 2 }, 1);
    const base = { image: 'alpine:3.20', labels: [], secrets: ['API_KEY'], timeoutMinutes: 5, maxAttempts: 2, requireApproval: false };
    const ok = await ci.createJob(db, { id: 1 }, { ...base, script: 'echo fine' }, { trigger: 'manual', userId: 1 });
    const bad = await ci.createJob(db, { id: 1 }, { ...base, script: 'exit 3' }, { trigger: 'manual', userId: 1 });
    const lines: string[] = [];
    const controller = new AbortController();
    const running = runRunner(
      {
        ...opts,
        url: `http://127.0.0.1:${port}`,
        token,
        capacity: 2,
        pollMs: 100,
        docker: process.execPath,
        dockerPrefix: [fileURLToPath(new URL('./fixtures/fakeDocker.mjs', import.meta.url))],
        workDir: work,
        log: (l) => lines.push(l),
      },
      controller.signal,
    );
    const status = async (id: number) => (await db.query.ciJobs.findFirst({ where: eq(ciJobs.id, id) }))!.status;
    const settled = async () => !['queued', 'running'].includes(await status(ok.id)) && !['queued', 'running'].includes(await status(bad.id));
    try {
      for (let i = 0; i < 200 && !(await settled()); i++) await new Promise((r) => setTimeout(r, 100));
      expect(await status(ok.id)).toBe('succeeded');
      expect(await status(bad.id)).toBe('failed');
      const okLog = ci.readLog(ok.id, 1);
      expect(okLog).toContain('image alpine:3.20');
      expect(okLog).toContain(`API_KEY=${SECRET}`);
      expect(okLog).toContain('a line on stderr');
      expect(okLog).toContain('✓ Succeeded');
      expect(ci.readLog(bad.id, 1)).toContain('✗ Exited with 3');
      expect(lines[0]).toBe('removed 1 container(s) left by an earlier run');
      const dockerCalls = readFileSync(calls, 'utf8');
      expect(dockerCalls).toContain('rm -f orphan-1');
      expect(dockerCalls).not.toContain(SECRET);
    } finally {
      controller.abort();
      await running;
      await app.close();
      closeMigratedDb(db);
      delete process.env['FAKE_DOCKER_LOG'];
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});
