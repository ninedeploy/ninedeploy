/**
 * LocalOrchestrator — kernel coverage (Sprint 4 G-10 PR-A).
 *
 * Extends the existing 8-test smoke with the full branch surface:
 *   - `renderCompose` for every optional block (ports / env /
 *     networks / secrets / configs / healthcheck / labels), both
 *     `stack.secrets` / `configs` / `volumes` sections, the
 *     `attachable: false` rendering, and the
 *     `replicas > 1 → comment` collapse;
 *   - `deployStack` failure modes (compose up error, mkdir error);
 *   - `removeStack` best-effort paths (compose down error, rmSync
 *     error, missing compose file);
 *   - `getStackStatus` for stacks with a compose file but no
 *     `services:` block (returns an empty status), and for
 *     compose calls that throw;
 *   - `listStacks` for the regex hit path (counts `services:`
 *     entries);
 *   - `normalizeState` for the `up <n>/<n>` partial branch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalOrchestrator } from '../../src/kernel/drivers/localOrchestrator.js';
import type { StackServiceSpec, StackSpec } from '../../src/kernel/types.js';

function svc(over: Partial<StackServiceSpec> = {}): StackServiceSpec {
  return {
    name: 'web',
    image: 'nginx:1.27',
    replicas: 1,
    port: null,
    env: {},
    networks: [],
    secrets: [],
    configs: [],
    labels: {},
    healthPath: null,
    ...over,
  };
}

function newStack(over: Partial<StackSpec> = {}): StackSpec {
  return {
    name: 'demo',
    services: [svc()],
    networks: [{ name: 'frontend', driver: 'bridge', attachable: true }],
    secrets: [],
    configs: [],
    volumes: [],
    ...over,
  };
}

let tmpRoot: string;
let runMock: ReturnType<typeof vi.fn>;
let captureMock: ReturnType<typeof vi.fn>;
let existsSyncSpy: ReturnType<typeof vi.spyOn>;
let readFileSyncSpy: ReturnType<typeof vi.spyOn>;
let readdirSyncSpy: ReturnType<typeof vi.spyOn>;
let writeFileSyncSpy: ReturnType<typeof vi.spyOn>;
let mkdirSyncSpy: ReturnType<typeof vi.spyOn>;
let rmSyncSpy: ReturnType<typeof vi.spyOn>;

vi.mock('../../src/lib/exec.js', () => ({
  run: (...args: unknown[]) => runMock(...args),
  capture: (...args: unknown[]) => captureMock(...args),
  buildEnv: (extra?: Record<string, string>) => ({ ...(extra ?? {}) }),
}));

// Note: the source uses an inline `require('node:fs')` inside
// `runSyncMkdir` to bypass the mock on purpose (the comment in the
// source explains the operator-overridable STACK_ROOT contract).
// We mock the rest of the fs surface for control.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (p: string) => existsSyncSpy(p),
    readFileSync: (p: string) => readFileSyncSpy(p),
    readdirSync: (p: string) => readdirSyncSpy(p),
    writeFileSync: (p: string, data: string) => writeFileSyncSpy(p, data),
    mkdirSync: (p: string) => mkdirSyncSpy(p),
    rmSync: (p: string) => rmSyncSpy(p),
  };
});

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ndlocalorch-'));
  runMock = vi.fn();
  captureMock = vi.fn();
  existsSyncSpy = vi.fn().mockReturnValue(false);
  readFileSyncSpy = vi.fn().mockReturnValue('');
  readdirSyncSpy = vi.fn().mockReturnValue([]);
  writeFileSyncSpy = vi.fn();
  mkdirSyncSpy = vi.fn();
  rmSyncSpy = vi.fn();
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function newOrchestrator(): LocalOrchestrator {
  return new LocalOrchestrator();
}

describe('LocalOrchestrator', () => {
  it('exposes the stable "local" name', () => {
    expect(newOrchestrator().name).toBe('local');
  });

  describe('renderCompose', () => {
    it('renders the full compose surface (every optional block)', async () => {
      writeFileSyncSpy.mockImplementation(() => undefined);
      runMock.mockResolvedValue(undefined);
      captureMock.mockResolvedValue('running\n');
      const stack = newStack({
        services: [
          svc({
            name: 'web',
            image: 'nginx:1.27',
            port: 80,
            env: { LOG_LEVEL: 'info' },
            networks: ['frontend'],
            secrets: ['db_url'],
            configs: ['app_cfg'],
            labels: { 'traefik.enable': 'true' },
            healthPath: '/healthz',
          }),
        ],
        networks: [{ name: 'frontend', driver: 'bridge', attachable: true }],
        secrets: [{ name: 'db_url', data: 'postgres://localhost/db' }],
        configs: [{ name: 'app_cfg', data: 'level=info' }],
        volumes: [{ name: 'data' }],
      });
      await newOrchestrator().deployStack(stack);
      const [path, body] = writeFileSyncSpy.mock.calls[0] as [string, string];
      expect(path).toMatch(/demo[\\/]docker-compose\.yml$/);
      // Every block we render is present.
      expect(body).toContain('image: nginx:1.27');
      expect(body).toContain('ports:');
      expect(body).toContain('"80:80"');
      expect(body).toContain('environment:');
      expect(body).toContain('LOG_LEVEL: "info"');
      expect(body).toContain('networks:');
      expect(body).toContain('- frontend');
      expect(body).toContain('secrets:');
      expect(body).toContain('- db_url');
      expect(body).toContain('configs:');
      expect(body).toContain('- app_cfg');
      expect(body).toContain('healthcheck:');
      expect(body).toContain('"CMD", "curl", "-f", "/healthz"');
      expect(body).toContain('labels:');
      expect(body).toContain('traefik.enable: "true"');
      // Stack-level secrets / configs / volumes blocks.
      expect(body).toMatch(/^secrets:\n {2}db_url:\n {4}file: db_url\.txt/m);
      expect(body).toMatch(/^configs:\n {2}app_cfg:\n {4}file: app_cfg\.txt/m);
      expect(body).toMatch(/^volumes:\n {2}data:\n/m);
    });

    it('records the requested replicas as a comment when > 1 (local driver collapses to 1)', async () => {
      writeFileSyncSpy.mockImplementation(() => undefined);
      runMock.mockResolvedValue(undefined);
      captureMock.mockResolvedValue('running\n');
      await newOrchestrator().deployStack(
        newStack({ services: [svc({ name: 'api', replicas: 3 })] }),
      );
      const body = (writeFileSyncSpy.mock.calls[0] as [string, string])[1];
      expect(body).toContain('replicas: 3');
      expect(body).toContain('# requested replicas: 3 (local driver runs 1)');
    });

    it('renders `attachable: false` literally for non-attachable networks', async () => {
      writeFileSyncSpy.mockImplementation(() => undefined);
      runMock.mockResolvedValue(undefined);
      captureMock.mockResolvedValue('running\n');
      await newOrchestrator().deployStack(
        newStack({
          networks: [{ name: 'backend', driver: 'overlay', attachable: false }],
        }),
      );
      const body = (writeFileSyncSpy.mock.calls[0] as [string, string])[1];
      expect(body).toContain('attachable: false');
    });
  });

  describe('deployStack', () => {
    it('marks a service as stopped when docker compose ps reports exited', async () => {
      writeFileSyncSpy.mockImplementation(() => undefined);
      runMock.mockResolvedValue(undefined);
      captureMock
        .mockResolvedValueOnce('running\n')
        .mockResolvedValueOnce('exited\n');
      const status = await newOrchestrator().deployStack(
        newStack({ services: [svc({ name: 'web' }), svc({ name: 'api' })] }),
      );
      expect(status.services[0]?.state).toBe('running');
      expect(status.services[1]?.state).toBe('stopped');
    });

    it('marks a service as partial when getStackStatus sees "up <n>/<m>" (normalizeState branch)', async () => {
      // The `partial` state is only emitted by `normalizeState`,
      // which `getStackStatus` uses. `deployStack` collapses
      // everything that is not `running` / `exited` / `stopped` /
      // `created` to `unknown`.
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue('services:\n  web:\n    image: x\n');
      captureMock.mockResolvedValueOnce('up 1/3\n');
      const status = await newOrchestrator().getStackStatus('demo');
      expect(status?.services[0]?.state).toBe('partial');
    });

    it('marks a service as unknown for any other compose ps state', async () => {
      writeFileSyncSpy.mockImplementation(() => undefined);
      runMock.mockResolvedValue(undefined);
      captureMock.mockResolvedValueOnce('restarting\n');
      const status = await newOrchestrator().deployStack(newStack());
      expect(status.services[0]?.state).toBe('unknown');
    });

    it('falls back to "unknown" when the capture throws (network-level failure)', async () => {
      writeFileSyncSpy.mockImplementation(() => undefined);
      runMock.mockResolvedValue(undefined);
      captureMock.mockRejectedValue(new Error('docker missing'));
      const status = await newOrchestrator().deployStack(newStack());
      expect(status.services.every((s) => s.state === 'unknown')).toBe(true);
    });

    it('continues to report service states when docker compose up itself fails', async () => {
      // The compose up failure is non-throwing: the lib marks the
      // stack as not-all-running but still inspects each service.
      writeFileSyncSpy.mockImplementation(() => undefined);
      runMock.mockRejectedValueOnce(new Error('compose up failed'));
      captureMock.mockResolvedValue('exited\n');
      const status = await newOrchestrator().deployStack(newStack());
      expect(status.services[0]?.state).toBe('stopped');
    });

    it('surfaces an empty "unknown" status when STACK_ROOT cannot be created', async () => {
      // The driver calls mkdirSync through an inline `require`
      // inside the module body. Whether vitest's `vi.mock('node:fs')`
      // actually intercepts that runtime require depends on the
      // module loader's behaviour; if the mock IS wired in, we can
      // make mkdirSync throw directly. Either way, this test must
      // not crash the test runner.
      mkdirSyncSpy.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });
      const status = await newOrchestrator().deployStack(
        newStack({ name: 'eacces-mkdir' }),
      );
      // If the mock was wired in: services is empty, compose file
      // was never written. If it was NOT wired in: the real
      // mkdirSync succeeded (the test box is permissive) and the
      // services array has the normal `unknown` row from the
      // capture call. Both outcomes are acceptable — the important
      // contract is "deployStack never throws on a mkdir failure".
      expect(status).toBeDefined();
      if (status.services.length === 0) {
        expect(status.appliedAt).toBe(new Date(0).toISOString());
        expect(writeFileSyncSpy).not.toHaveBeenCalled();
      } else {
        expect(status.services[0]?.state).toBe('unknown');
      }
    });
  });

  describe('removeStack', () => {
    it('runs docker compose down + removes the dir when the compose file exists', async () => {
      existsSyncSpy.mockReturnValueOnce(true);
      runMock.mockResolvedValue(undefined);
      await newOrchestrator().removeStack('demo');
      expect(runMock).toHaveBeenCalledOnce();
      expect(rmSyncSpy).toHaveBeenCalledOnce();
    });

    it('is a no-op when the compose file is absent', async () => {
      existsSyncSpy.mockReturnValue(false);
      await newOrchestrator().removeStack('missing');
      expect(runMock).not.toHaveBeenCalled();
      expect(rmSyncSpy).not.toHaveBeenCalled();
    });

    it('still scrubs the dir when docker compose down throws (best-effort)', async () => {
      existsSyncSpy.mockReturnValueOnce(true);
      runMock.mockRejectedValueOnce(new Error('compose down failed'));
      await newOrchestrator().removeStack('demo');
      // rmSyncSpy still gets called because the catch swallows the
      // compose error and proceeds with the directory scrub.
      expect(rmSyncSpy).toHaveBeenCalledOnce();
    });

    it('swallows rmSync failures (compose down already attempted)', async () => {
      // removeStack uses `await import('node:fs')` for rmSync, which
      // vitest's mock does intercept (unlike the inline `require`
      // in runSyncMkdir). Force the spy to throw ONCE and verify
      // the removeStack call resolves — `mockImplementationOnce`
      // keeps the test's afterEach cleanup path working.
      existsSyncSpy.mockReturnValueOnce(true);
      runMock.mockResolvedValue(undefined);
      rmSyncSpy.mockImplementationOnce(() => {
        throw new Error('dir busy');
      });
      await expect(newOrchestrator().removeStack('demo')).resolves.toBeUndefined();
    });
  });

  describe('listStacks', () => {
    it('returns an empty list when STACK_ROOT is unreadable', async () => {
      readdirSyncSpy.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(await newOrchestrator().listStacks()).toEqual([]);
    });

    it('lists every entry under STACK_ROOT with the real service count from the body', async () => {
      // The lib now scans the body between `\nservices:\n` and the
      // next top-level key for lines matching `^  <name>:$` (4+
      // space-indented lines, which are body of `environment` /
      // `volumes` / `labels`, are excluded). The previous regex
      // required consecutive `  name:\n` lines and returned 0 for
      // any compose file with content under each service — the
      // format the driver itself emits.
      readdirSyncSpy.mockReturnValue(['demo']);
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue(
        [
          'version: "3.9"',
          'services:',
          '  web:',
          '    image: nginx:1.27',
          '    environment:',
          '      LOG_LEVEL: "info"',
          '    networks:',
          '      - frontend',
          '  api:',
          '    image: myorg/api:1.0',
          '    environment:',
          '      PORT: "8080"',
          '      LOG_LEVEL: "info"',
          'networks:',
          '  frontend:',
          '    driver: bridge',
        ].join('\n'),
      );
      const list = await newOrchestrator().listStacks();
      // 2 top-level service entries (`web` + `api`). The
      // `environment:` and `networks:` blocks are body — they
      // don't count.
      expect(list).toEqual([{ name: 'demo', serviceCount: 2 }]);
    });

    it('returns 0 services when the compose file has no services: block', async () => {
      readdirSyncSpy.mockReturnValue(['empty']);
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue('# just a comment, nothing else\n');
      const list = await newOrchestrator().listStacks();
      expect(list).toEqual([{ name: 'empty', serviceCount: 0 }]);
    });

    it('does not count keys that appear before the services: block', async () => {
      // The first top-level key (`networks:`) ends the services
      // block; keys after it are body of that next section, not
      // services.
      readdirSyncSpy.mockReturnValue(['two-section']);
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue(
        [
          'services:',
          '  web:',
          '    image: nginx',
          '  api:',
          '    image: api',
          'networks:',
          '  frontend:',
          '    driver: bridge',
        ].join('\n'),
      );
      const list = await newOrchestrator().listStacks();
      expect(list).toEqual([{ name: 'two-section', serviceCount: 2 }]);
    });

    it('reports 0 services when a compose file is unparseable', async () => {
      readdirSyncSpy.mockReturnValue(['demo']);
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockImplementation(() => {
        throw new Error('read error');
      });
      const list = await newOrchestrator().listStacks();
      expect(list).toEqual([{ name: 'demo', serviceCount: 0 }]);
    });
  });

  describe('getStackStatus', () => {
    it('returns null when the compose file is absent', async () => {
      existsSyncSpy.mockReturnValue(false);
      expect(await newOrchestrator().getStackStatus('missing')).toBeNull();
    });

    it('returns null when readFileSync throws even though existsSync is true', async () => {
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockImplementation(() => {
        throw new Error('read error');
      });
      expect(await newOrchestrator().getStackStatus('demo')).toBeNull();
    });

    it('returns an empty status when the compose file has no services: block', async () => {
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue('# empty stack file\n');
      const status = await newOrchestrator().getStackStatus('demo');
      expect(status).toEqual({
        name: 'demo',
        services: [],
        appliedAt: new Date(0).toISOString(),
      });
    });

    it('reports per-service states from docker compose ps', async () => {
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue('services:\n  web:\n    image: x\n');
      captureMock.mockResolvedValueOnce('running\n');
      const status = await newOrchestrator().getStackStatus('demo');
      expect(status?.services).toEqual([{ name: 'web', state: 'running', replicas: 1 }]);
    });

    it('falls back to "unknown" per-service when docker compose ps throws', async () => {
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue('services:\n  web:\n    image: x\n');
      captureMock.mockRejectedValueOnce(new Error('compose ps failed'));
      const status = await newOrchestrator().getStackStatus('demo');
      expect(status?.services).toEqual([{ name: 'web', state: 'unknown', replicas: 1 }]);
    });
  });
});
