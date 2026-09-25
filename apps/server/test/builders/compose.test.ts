import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeBuilder } from '../../src/engine/builders/compose.js';
import { NOW } from '../helpers.js';

const h = vi.hoisted(() => {
  const run = vi.fn(async (_cmd: string, _args: unknown[], _opts: unknown, sink?: (line: string) => void) => {
    sink?.('');
  });
  const capture = vi.fn(async () => 'running');
  return { run, capture };
});
vi.mock('../../src/lib/exec.js', () => ({ run: h.run, sleep: vi.fn(async () => undefined), capture: h.capture }));

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-compose-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const makeCtx = (over: Record<string, unknown> = {}) => ({
  deploymentId: 3,
  service: { slug: 'stack', composeService: 'api', port: 3000, healthPath: '/' },
  buildConfig: { dockerfilePath: 'compose.yaml' },
  workDir: tmp,
  commitSha: 'abcdef1',
  env: { TOKEN: 'secret-value' },
  log: vi.fn(),
  ...over,
});

describe('composeBuilder.buildAndRun', () => {
  beforeEach(() => {
    h.run.mockReset();
    h.run.mockImplementation(async (_cmd: string, _args: unknown[], _opts: unknown, sink?: (line: string) => void) => {
      sink?.('');
    });
    h.capture.mockClear();
    h.capture.mockResolvedValue('running');
  });

  it('brings the project up with env vars in a temporary .env', async () => {
    const runtime = await composeBuilder.buildAndRun(makeCtx() as never);

    // Previous revision torn down first — with -f so a non-default compose
    // file is honored — then up --build.
    const downCall = h.run.mock.calls.find((c) => (c[1] as string[])[5] === 'down');
    expect(downCall).toBeTruthy();
    expect((downCall![1] as string[])).toEqual(['compose', '-p', 'ndcmp-stack', '-f', 'compose.yaml', 'down', '--remove-orphans']);
    const upCall = h.run.mock.calls.find((c) => (c[1] as string[])[5] === 'up');
    expect((upCall![1] as string[])).toEqual(['compose', '-p', 'ndcmp-stack', '-f', 'compose.yaml', 'up', '-d', '--build', '--remove-orphans']);
    expect(upCall![2]).toMatchObject({ cwd: tmp });

    // The .env was written and cleaned up afterwards.
    expect(existsSync(path.join(tmp, '.env'))).toBe(false);

    // The main container follows docker compose's naming convention.
    expect(runtime.runtimeId).toBe('ndcmp-stack-api-1');
    expect(runtime.port).toBe(3000);
    expect(runtime.healthPath).toBe('/');
    expect(runtime.imageDigest).toBeUndefined();
  });

  it('writes secrets into the temporary .env and removes it even on failure', async () => {
    const dotEnvPath = path.join(tmp, '.env');
    // Capture content mid-flight: inspect after the up call starts.
    let seen: string | null = null;
    h.run.mockImplementation(async (_c, a, _o, sink) => {
      sink?.('');
      if ((a as string[])[5] === 'up') {
        seen = readFileSync(dotEnvPath, 'utf8');
        throw new Error('build failed');
      }
    });
    await expect(composeBuilder.buildAndRun(makeCtx() as never)).rejects.toThrow('build failed');
    expect(seen).toContain('TOKEN="secret-value"');
    expect(existsSync(dotEnvPath)).toBe(false);
  });

  it('escapes .env values so compose cannot truncate or expand them', async () => {
    // Verified against docker compose v5 (compose-go dotenv): unquoted values
    // are truncated at the first ` #`, and double-quoted values undergo
    // `$VAR` expansion from the panel's own environment. The escape recipe
    // here round-trips byte-exact through `docker compose config`.
    const dotEnvPath = path.join(tmp, '.env');
    let seen: string | null = null;
    h.run.mockImplementation(async (_c, a, _o, sink) => {
      sink?.('');
      if ((a as string[])[5] === 'up') {
        seen = readFileSync(dotEnvPath, 'utf8');
        throw new Error('stop');
      }
    });
    await expect(
      composeBuilder.buildAndRun(
        makeCtx({
          env: {
            TOKEN: 'abc #def',
            FORMULA: 'pa$$word',
            JSONISH: '{"a": 1}',
            MULTI: 'line1\nline2',
          },
        }) as never,
      ),
    ).rejects.toThrow('stop');
    expect(seen).toBe(
      'TOKEN="abc #def"\n' +
      'FORMULA="pa\\$\\$word"\n' +
      'JSONISH="{\\"a\\": 1}"\n' +
      'MULTI="line1\\nline2"\n',
    );
  });

  it('defaults the compose file and main service from the slug', async () => {
    const runtime = await composeBuilder.buildAndRun(
      makeCtx({ service: { slug: 'solo', port: null, healthPath: '' }, buildConfig: undefined }) as never,
    );
    const upCall = h.run.mock.calls.find((c) => (c[1] as string[])[5] === 'up');
    expect((upCall![1] as string[])).toContain('docker-compose.yml');
    expect(runtime.runtimeId).toBe('ndcmp-solo-solo-1');
  });

  it('skips the .env when there are no env vars', async () => {
    const dotEnvPath = path.join(tmp, '.env');
    await composeBuilder.buildAndRun(makeCtx({ env: {} }) as never);
    expect(existsSync(dotEnvPath)).toBe(false);
  });

  // r352: a repo-committed .env carries compose interpolation defaults. It
  // used to be overwritten with panel-only values (defaults resolved blank)
  // and then deleted from the checkout even when nothing was written.
  describe('r352: a repo-committed .env', () => {
    const repoEnv = '# committed defaults\r\nPG_VERSION=16\nTOKEN=from-repo';

    it('is merged with panel values (panel wins) during the deploy and restored byte-for-byte after', async () => {
      const dotEnvPath = path.join(tmp, '.env');
      writeFileSync(dotEnvPath, repoEnv);
      let seen: string | null = null;
      h.run.mockImplementation(async (_c, a, _o, sink) => {
        sink?.('');
        if ((a as string[])[5] === 'config') seen = readFileSync(dotEnvPath, 'utf8');
      });
      try {
        await composeBuilder.buildAndRun(makeCtx() as never);
        expect(seen).toContain('PG_VERSION=16');
        // Repo line first, panel value after it — compose-go's dotenv is
        // last-wins, so the panel's TOKEN is the one interpolated.
        expect(seen!.indexOf('TOKEN=from-repo')).toBeLessThan(seen!.indexOf('TOKEN="secret-value"'));
        expect(readFileSync(dotEnvPath, 'utf8')).toBe(repoEnv);
      } finally {
        rmSync(dotEnvPath, { force: true });
      }
    });

    it('is restored even when the deploy fails', async () => {
      const dotEnvPath = path.join(tmp, '.env');
      writeFileSync(dotEnvPath, repoEnv);
      h.run.mockImplementation(async (_c, a, _o, sink) => {
        sink?.('');
        if ((a as string[])[5] === 'up') throw new Error('build failed');
      });
      try {
        await expect(composeBuilder.buildAndRun(makeCtx() as never)).rejects.toThrow('build failed');
        expect(readFileSync(dotEnvPath, 'utf8')).toBe(repoEnv);
      } finally {
        rmSync(dotEnvPath, { force: true });
      }
    });

    it('is left untouched when the panel has no env vars', async () => {
      const dotEnvPath = path.join(tmp, '.env');
      writeFileSync(dotEnvPath, repoEnv);
      try {
        await composeBuilder.buildAndRun(makeCtx({ env: {} }) as never);
        expect(readFileSync(dotEnvPath, 'utf8')).toBe(repoEnv);
      } finally {
        rmSync(dotEnvPath, { force: true });
      }
    });
  });

  it('tolerates a failing previous-revision teardown', async () => {
    h.run.mockImplementation(async (_c, a, _o, sink) => {
      sink?.('');
      if ((a as string[])[5] === 'down') throw new Error('no such project');
    });
    const runtime = await composeBuilder.buildAndRun(makeCtx() as never);
    expect(runtime.runtimeId).toBe('ndcmp-stack-api-1');
  });

  it('writes an override compose file with -v mounts when attachments are present, and removes it afterwards', async () => {
    const overridePath = path.join(tmp, '.ninedeploy.compose.override.yml');
    const ctx = makeCtx({
      service: { slug: 'stack', composeService: 'api', port: 3000, healthPath: '/' },
      volumeAttachments: [
        { id: 1, serviceId: 1, volumeName: 'nd-svc-stack-uploads', containerPath: '/uploads', readOnly: false, createdAt: NOW, updatedAt: NOW },
        { id: 2, serviceId: 1, volumeName: 'nd-svc-stack-config', containerPath: '/etc/app', readOnly: true, createdAt: NOW, updatedAt: NOW },
      ],
    });

    let seenOverride: string | null = null;
    h.run.mockImplementation(async (_c, a, _o, sink) => {
      sink?.('');
      const args = a as string[];
      if (args.includes('up')) {
        seenOverride = readFileSync(overridePath, 'utf8');
      }
    });

    await composeBuilder.buildAndRun(ctx as never);

    // The override file was written and then cleaned up.
    expect(seenOverride).not.toBeNull();
    expect(seenOverride).toContain('services:');
    expect(seenOverride).toContain('  api:');
    expect(seenOverride).toContain('      - "nd-svc-stack-uploads:/uploads"');
    expect(seenOverride).toContain('      - "nd-svc-stack-config:/etc/app:ro"');
    expect(seenOverride).toContain('volumes:');
    expect(seenOverride).toContain('  nd-svc-stack-uploads:');
    expect(seenOverride).toContain('  nd-svc-stack-config:');
    // Each top-level volume is external (the user owns the named volume).
    expect(seenOverride).toContain('    external: true');
    expect(existsSync(overridePath)).toBe(false);

    // Both `down` and `up` invocations pass the override via -f.
    const downCall = h.run.mock.calls.find((c) => (c[1] as string[]).includes('down'));
    const upCall = h.run.mock.calls.find((c) => (c[1] as string[]).includes('up'));
    const downArgs = downCall![1] as string[];
    const upArgs = upCall![1] as string[];
    // Compose builder uses the absolute path of the override file in the
    // -f flag (it's written into the workdir).
    expect(downArgs).toEqual(expect.arrayContaining([overridePath]));
    expect(upArgs).toEqual(expect.arrayContaining([overridePath]));
  });

  it('omits the override file entirely when there are no attachments', async () => {
    const overridePath = path.join(tmp, '.ninedeploy.compose.override.yml');
    const ctx = makeCtx({ volumeAttachments: [] });
    await composeBuilder.buildAndRun(ctx as never);
    expect(existsSync(overridePath)).toBe(false);
    const upCall = h.run.mock.calls.find((c) => (c[1] as string[]).includes('up'));
    expect((upCall![1] as string[])).not.toContain(overridePath);
  });
});

describe('composeBuilder.isHealthy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.capture.mockResolvedValue('running|none|0|0');
  });

  it('returns true when the main container is running without a healthcheck', async () => {
    const ok = await composeBuilder.isHealthy({ runtimeId: 'ndcmp-stack-api-1', port: 3000, healthPath: '/' }, 5000);
    expect(ok).toBe(true);
    expect(h.capture).toHaveBeenCalledWith('docker', ['inspect', 'ndcmp-stack-api-1', '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}|{{.State.Health.FailingStreak}}{{else}}none|0{{end}}|{{.RestartCount}}']);
  });

  it('returns true when the container is running AND its healthcheck passes', async () => {
    h.capture.mockResolvedValue('running|healthy|0|0');
    const ok = await composeBuilder.isHealthy({ runtimeId: 'x', port: null, healthPath: '/' }, 5000);
    expect(ok).toBe(true);
  });

  it('does NOT deploy green while a healthcheck is failing (running but unhealthy)', async () => {
    // The old contract returned true on the first `running` poll even with a
    // healthcheck failing forever — the app below boots but never passes its
    // own check, so health must stay false.
    h.capture.mockResolvedValue('running|unhealthy|15|0');
    const ok = await composeBuilder.isHealthy({ runtimeId: 'x', port: null, healthPath: '/' }, 60_000);
    expect(ok).toBe(false);
  });

  it('returns false when the container never comes up', async () => {
    h.capture.mockRejectedValue(new Error('no such container'));
    const ok = await composeBuilder.isHealthy({ runtimeId: 'x', port: null, healthPath: '/' }, 10, 0);
    expect(ok).toBe(false);
  });

  it('retries until a non-running status becomes running', async () => {
    h.capture
      .mockResolvedValueOnce('created|none|0|0')
      .mockResolvedValueOnce('running|none|0|0');
    const ok = await composeBuilder.isHealthy({ runtimeId: 'x', port: null, healthPath: '/' }, 5000);
    expect(ok).toBe(true);
    expect(h.capture.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('composeBuilder redeploy safety gates', () => {
  beforeEach(() => {
    h.run.mockReset();
    h.run.mockImplementation(async (_cmd: string, _args: unknown[], _opts: unknown, sink?: (line: string) => void) => {
      sink?.('');
    });
    h.capture.mockClear();
    h.capture.mockResolvedValue('running');
  });

  it('validates config and pre-pulls images BEFORE tearing the old stack down', async () => {
    await composeBuilder.buildAndRun(makeCtx() as never);
    const calls = h.run.mock.calls.map((c) => (c[1] as string[])[5]);
    expect(calls.indexOf('config')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('pull')).toBeGreaterThan(calls.indexOf('config'));
    expect(calls.indexOf('down')).toBeGreaterThan(calls.indexOf('pull'));
    expect(calls.indexOf('up')).toBeGreaterThan(calls.indexOf('down'));
  });

  it('fails the deploy on a broken compose file without ever running down', async () => {
    h.run.mockImplementation(async (_cmd: string, args: unknown[]) => {
      if ((args as string[])[5] === 'config') throw new Error('invalid interpolation');
      return Promise.resolve();
    });
    await expect(composeBuilder.buildAndRun(makeCtx() as never)).rejects.toThrow('invalid interpolation');
    expect(h.run.mock.calls.some((c) => (c[1] as string[])[5] === 'down')).toBe(false);
  });

  it('fails the deploy on a dead registry without ever running down', async () => {
    h.run.mockImplementation(async (_cmd: string, args: unknown[]) => {
      if ((args as string[])[5] === 'pull') throw new Error('registry unreachable');
      return Promise.resolve();
    });
    await expect(composeBuilder.buildAndRun(makeCtx() as never)).rejects.toThrow('registry unreachable');
    expect(h.run.mock.calls.some((c) => (c[1] as string[])[5] === 'down')).toBe(false);
  });

  it('routes to the REAL container name when the stack pins container_name', async () => {
    h.capture.mockResolvedValue(JSON.stringify([{ Name: '/pinned-name', State: 'running' }]));
    const runtime = await composeBuilder.buildAndRun(makeCtx() as never);
    expect(runtime.runtimeId).toBe('pinned-name');
  });

  it('falls back to the deterministic name on unparseable ps output', async () => {
    h.capture.mockResolvedValue('not json at all');
    const runtime = await composeBuilder.buildAndRun(makeCtx() as never);
    expect(runtime.runtimeId).toBe('ndcmp-stack-api-1');
  });
  it('fails fast when the main container is crash-looping', async () => {
    let poll = 0;
    // First poll sets the restart baseline, the next one jumps past the
    // crash-loop threshold (delta >= 3) so the test exits after one sleep.
    h.capture.mockImplementation(async () => (poll++ === 0 ? 'restarting|none|0|0' : 'restarting|none|0|9'));
    const ok = await composeBuilder.isHealthy({ runtimeId: 'x', port: null, healthPath: '/' }, 60_000);
    expect(ok).toBe(false);
  });

  it('fails fast when healthcheck failing streak keeps growing', async () => {
    h.capture.mockResolvedValue('running|unhealthy|15|0');
    const ok = await composeBuilder.isHealthy({ runtimeId: 'x', port: null, healthPath: '/' }, 60_000);
    expect(ok).toBe(false);
  });
});

describe('composeBuilder.stop', () => {
  it('tears the project down using the container\'s own compose labels', async () => {
    h.run.mockClear();
    const live = path.join(tmp, 'compose.yaml');
    if (!existsSync(live)) writeFileSync(live, 'services: {}\n');
    // The label inspect yields project + config file(s), tab-separated.
    h.capture.mockResolvedValueOnce(`ndcmp-stack\t${live}`);
    await composeBuilder.stop('ndcmp-stack-api-1');
    const downCall = h.run.mock.calls[0];
    expect(h.capture).toHaveBeenCalledWith(
      'docker',
      ['inspect', 'ndcmp-stack-api-1', '--format', expect.stringContaining('com.docker.compose.project')],
    );
    expect((downCall![1] as string[])).toEqual(['compose', '-p', 'ndcmp-stack', '-f', live, 'down', '--remove-orphans']);
  });

  it('works for hyphenated project/service names (no string surgery)', async () => {
    h.run.mockClear();
    const live = path.join(tmp, 'docker-compose.yml');
    if (!existsSync(live)) writeFileSync(live, 'services: {}\n');
    h.capture.mockResolvedValueOnce(`ndcmp-my-app\t${live}`);
    await composeBuilder.stop('ndcmp-my-app-web-api-1');
    expect((h.run.mock.calls[0]![1] as string[])).toEqual(['compose', '-p', 'ndcmp-my-app', '-f', live, 'down', '--remove-orphans']);
  });

  it('does nothing when the container (and its labels) are already gone', async () => {
    h.run.mockClear();
    h.capture.mockRejectedValueOnce(new Error('No such object'));
    await expect(composeBuilder.stop('gone-1')).resolves.toBeUndefined();
    expect(h.run).not.toHaveBeenCalled();
  });

  it('does nothing when the container has no compose project label', async () => {
    h.run.mockClear();
    h.capture.mockResolvedValueOnce('\t');
    await expect(composeBuilder.stop('some-container-1')).resolves.toBeUndefined();
    expect(h.run).not.toHaveBeenCalled();
  });

  it('stops without -f when the container reports no config files', async () => {
    h.run.mockClear();
    h.capture.mockResolvedValueOnce('ndcmp-stack');
    await composeBuilder.stop('ndcmp-stack-api-1');
    expect((h.run.mock.calls[0]![1] as string[])).toEqual(['compose', '-p', 'ndcmp-stack', 'down', '--remove-orphans']);
  });

  it('passes every comma-separated config file', async () => {
    h.run.mockClear();
    const base = path.join(tmp, 'base.yml');
    const override = path.join(tmp, 'override.yml');
    for (const f of [base, override]) {
      if (!existsSync(f)) writeFileSync(f, 'services: {}\n');
    }
    h.capture.mockResolvedValueOnce(`p\t${base}, ${override}`);
    await composeBuilder.stop('p-api-1');
    expect((h.run.mock.calls[0]![1] as string[])).toEqual([
      'compose', '-p', 'p', '-f', base, '-f', override, 'down', '--remove-orphans',
    ]);
  });

  it('skips a recorded config file that no longer exists (deleted per-deploy override)', async () => {
    // The deploy path deletes its override file in `finally`; a `down` that
    // still references the dead path exits nonzero WITHOUT stopping the
    // stack — stop() would report success while every container keeps
    // running. Only surviving files may be handed to compose.
    h.run.mockClear();
    const live = path.join(tmp, 'live-compose.yml');
    if (!existsSync(live)) writeFileSync(live, 'services: {}\n');
    const dead = path.join(tmp, 'deleted-override.yml');
    rmSync(dead, { force: true });
    h.capture.mockResolvedValueOnce(`p\t${live}, ${dead}`);
    await composeBuilder.stop('p-api-1');
    expect((h.run.mock.calls[0]![1] as string[])).toEqual([
      'compose', '-p', 'p', '-f', live, 'down', '--remove-orphans',
    ]);
  });

  it('swallows failures', async () => {
    h.run.mockClear();
    h.capture.mockResolvedValueOnce('p\t/c.yml');
    h.run.mockRejectedValueOnce(new Error('compose not installed'));
    await expect(composeBuilder.stop('ndcmp-stack-api-1')).resolves.toBeUndefined();
  });
});
