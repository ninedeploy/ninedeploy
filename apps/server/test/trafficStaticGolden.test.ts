/**
 * 0.15 traffic analytics — the upgrade guarantee (DESIGN §2.1, §2.7; owner
 * decisions O3 and O7).
 *
 * With analytics OFF, a 0.15 panel renders byte-for-byte the static config,
 * the fingerprint and the `docker run` argv that v0.14.0 rendered, so an
 * upgrade never recreates `ninedeploy-traefik`. The golden file was produced
 * by RUNNING the v0.14.0 `engine/proxy.ts` (`git show v0.14.0:…`, generator
 * kept in `.temp_files/run_0.15/t3/gen_014_golden.test.ts`), the approach the
 * 0.14 directory-provider golden used (`v0.13.0-*.yml` next to it).
 *
 * The one argv difference 0.15 allows is D5's `--log-opt` pair on the
 * json-file/local drivers, which is NOT fingerprinted: it rides along at the
 * next natural recreate and never causes one (pinned below with a running
 * 0.14 container).
 *
 * Also here: the analytics render (`accessLog: 'file'`), "static filePath ⇔
 * mount in argv", and the recreate-flap guard (every `ensureTraefik` caller
 * passes `traefikInputs`).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  config: {
    paths: { dataDir: '' },
    acmeEmail: null as string | null,
    acmeCaServer: undefined as string | undefined,
    port: 3001,
  },
  capture: vi.fn(async (..._a: unknown[]): Promise<string> => ''),
  run: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
  settings: {} as Record<string, unknown>,
  failSettings: false,
}));
vi.mock('../src/config.js', () => ({ config: h.config }));
vi.mock('../src/lib/exec.js', () => ({ capture: h.capture, run: h.run, sleep: vi.fn(async () => undefined) }));
vi.mock('../src/lib/dockerPull.js', () => ({ ensureDockerImage: vi.fn(async () => undefined) }));
vi.mock('../src/lib/serviceBridge.js', () => ({ reapTraefikNetworks: vi.fn(async () => undefined) }));
vi.mock('../src/lib/hostPath.js', () => ({ hostPathFor: vi.fn(async (p: string) => p) }));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/crypto.js', () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ''),
}));
vi.mock('../src/lib/settings.js', () => {
  const read = (k: string) => {
    if (h.failSettings) throw new Error('database is locked');
    return h.settings[k];
  };
  return {
    getSetting: async (_db: unknown, k: string, f: boolean) => {
      const v = read(k);
      return typeof v === 'boolean' ? v : f;
    },
    getSettingString: async (_db: unknown, k: string, f: string | null) => {
      const v = read(k);
      return typeof v === 'string' ? v : f;
    },
    getSettingJson: async (_db: unknown, k: string, f: unknown) => read(k) ?? f,
    setSetting: async () => undefined,
    setSettingJson: async () => undefined,
  };
});

const base = mkdtempSync(path.join(os.tmpdir(), 'nd-traffic-golden-'));
h.config.paths.dataDir = base;
afterAll(() => rmSync(base, { recursive: true, force: true }));

const proxy = await import('../src/engine/proxy.js');

const FIX = path.join(import.meta.dirname, 'fixtures', 'traefik-upgrade', 'v0.14.0-static.json');
type GoldenCase = { static: string; fingerprint: string; argv: string[] };
const golden = JSON.parse(readFileSync(FIX, 'utf8')) as {
  caServer: string;
  dns: { provider: string; token: string; wildcardApex: string };
  cases: Record<'noAcme' | 'acmeHttp' | 'acmeDns' | 'caServer', GoldenCase>;
};
const DNS = golden.dns;
const CASES: Record<keyof typeof golden.cases, [string | null, typeof DNS | null, string | undefined]> = {
  noAcme: [null, null, undefined],
  acmeHttp: ['ops@example.com', null, undefined],
  acmeDns: ['ops@example.com', DNS, undefined],
  caServer: ['ops@example.com', null, golden.caServer],
};

const norm = (s: string) => s.split(base).join('<DATA>').replace(/\\/g, '/');
const LOG_OPTS = ['--log-opt', 'max-size=20m', '--log-opt', 'max-file=3'];

/** Docker with no Traefik running; `docker info` reports `driver` (null = Docker refuses). */
function freshDocker(driver: string | null): void {
  h.capture.mockImplementation(async (_c: unknown, a: unknown) => {
    const args = a as string[];
    if (args[0] === 'info') {
      if (driver === null) throw new Error('Cannot connect to the Docker daemon');
      return `${driver}\n`;
    }
    if (args[0] === 'ps') return '';
    if (args[0] === 'inspect' && args.join(' ').includes('.State.Running')) return 'true|{"ninedeploy":{}}';
    return '';
  });
}

/** ensureTraefik on a clean data dir; returns the normalised `docker run` argv. */
async function runArgv(name: keyof typeof CASES, accessLog: 'stdout' | 'file' = 'stdout'): Promise<string[]> {
  const [email, dns, ca] = CASES[name];
  h.config.acmeCaServer = ca;
  rmSync(path.join(base, 'traefik'), { recursive: true, force: true });
  h.run.mockClear();
  try {
    await proxy.ensureTraefik(() => undefined, email, dns, { accessLog });
  } finally {
    h.config.acmeCaServer = undefined;
  }
  const argv = h.run.mock.calls.map((c) => c[1] as string[]).find((a) => a[0] === 'run');
  expect(argv, 'docker run was issued').toBeDefined();
  return argv!.map(norm);
}

beforeEach(() => {
  h.capture.mockReset();
  h.run.mockReset();
  h.run.mockResolvedValue(undefined);
  h.settings = {};
  h.failSettings = false;
  h.config.acmeCaServer = undefined;
  proxy.resetDockerLoggingDriverCache();
});

describe('analytics off: byte-identical to v0.14.0 (the upgrade guarantee)', () => {
  for (const name of Object.keys(CASES) as Array<keyof typeof CASES>) {
    it(`${name}: static config and fingerprint`, () => {
      const [email, dns, ca] = CASES[name];
      h.config.acmeCaServer = ca;
      expect(proxy.renderStaticConfig(email, dns)).toBe(golden.cases[name].static);
      expect(proxy.renderStaticConfig(email, dns, { accessLog: 'stdout' })).toBe(golden.cases[name].static);
      expect(proxy.traefikConfigFingerprint(email, dns)).toBe(golden.cases[name].fingerprint);
      expect(proxy.traefikConfigFingerprint(email, dns, { accessLog: 'stdout' })).toBe(golden.cases[name].fingerprint);
    });

    it(`${name}: docker run argv (a non-rotating log driver)`, async () => {
      freshDocker('journald');
      expect(await runArgv(name)).toEqual(golden.cases[name].argv);
    });

    it(`${name}: docker run argv (Docker did not answer the driver probe)`, async () => {
      freshDocker(null);
      expect(await runArgv(name)).toEqual(golden.cases[name].argv);
    });
  }

  it('the static file ensureTraefik writes is the golden text', async () => {
    freshDocker('journald');
    await runArgv('acmeDns');
    expect(readFileSync(path.join(base, 'traefik', 'traefik.yml'), 'utf8')).toBe(golden.cases.acmeDns.static);
    // No analytics mount, and no traffic-logs directory created.
    expect(existsSync(path.join(base, 'traffic-logs'))).toBe(false);
  });
});

describe('D5 (O7): Docker log rotation for the Traefik container', () => {
  for (const driver of ['json-file', 'local']) {
    it(`${driver}: the argv is the v0.14 argv plus the log-opt pair before the image`, async () => {
      freshDocker(driver);
      const argv = await runArgv('acmeDns');
      const want = [...golden.cases.acmeDns.argv];
      want.splice(want.length - 1, 0, ...LOG_OPTS);
      expect(argv).toEqual(want);
    });
  }

  it('another driver gets no log option (it would make docker run fail)', async () => {
    for (const driver of ['journald', 'syslog', 'fluentd', 'none', 'awslogs']) {
      expect(proxy.traefikLogOptArgs(driver)).toEqual([]);
    }
    expect(proxy.traefikLogOptArgs(null)).toEqual([]);
  });

  it('caches a known driver for the process; a failed probe is retried', async () => {
    freshDocker(null);
    expect(await proxy.dockerLoggingDriver()).toBeNull();
    freshDocker('json-file');
    expect(await proxy.dockerLoggingDriver()).toBe('json-file');
    h.capture.mockClear();
    freshDocker('journald');
    expect(await proxy.dockerLoggingDriver()).toBe('json-file');
    expect(h.capture.mock.calls.filter((c) => (c[1] as string[])[0] === 'info')).toHaveLength(0);
  });

  it('a garbage probe answer is not trusted', async () => {
    h.capture.mockResolvedValue('Error: something {{.LoggingDriver}}');
    expect(await proxy.dockerLoggingDriver()).toBeNull();
  });

  it('is NOT fingerprinted: a running v0.14 container on a json-file daemon is left alone', async () => {
    freshDocker('json-file');
    await runArgv('acmeDns'); // lay the data dir down
    h.run.mockClear();
    h.capture.mockImplementation(async (_c: unknown, a: unknown) => {
      const args = a as string[];
      if (args[0] === 'info') return 'json-file\n';
      if (args[0] === 'ps') return 'abc123\n';
      if (args[0] === 'inspect' && args[3]?.includes('.Config.Labels')) return golden.cases.acmeDns.fingerprint;
      if (args[0] === 'inspect' && args[3]?.includes('.Mounts')) return path.join(base, 'traefik');
      if (args[0] === 'inspect') return '{"ninedeploy":{}}';
      return '';
    });
    const logs: string[] = [];
    await proxy.ensureTraefik((l) => logs.push(l), 'ops@example.com', DNS, { accessLog: 'stdout' });
    expect(logs).toContain('traefik already running on shared network');
    expect(h.run).not.toHaveBeenCalled();
  });
});

describe('analytics on: the JSON access log (DESIGN §2.2)', () => {
  it('replaces only the accessLog block', () => {
    const on = proxy.renderStaticConfig('ops@example.com', DNS, { accessLog: 'file' });
    expect(on).toBe(golden.cases.acmeDns.static.replace('accessLog: {}\n', proxy.TRAFFIC_ACCESS_LOG_BLOCK));
    expect(proxy.traefikConfigFingerprint('ops@example.com', DNS, { accessLog: 'file' })).not.toBe(
      golden.cases.acmeDns.fingerprint,
    );
  });

  it('keeps router, host, status, size and timing; drops every other field and every header', () => {
    const doc = load(proxy.renderStaticConfig(null, null, { accessLog: 'file' })) as {
      accessLog: {
        filePath: string;
        format: string;
        fields: { defaultMode: string; names: Record<string, string>; headers: { defaultMode: string; names?: unknown } };
      };
    };
    expect(doc.accessLog.filePath).toBe('/var/log/ninedeploy-traffic/access.log');
    expect(doc.accessLog.format).toBe('json');
    expect(doc.accessLog.fields.defaultMode).toBe('drop');
    expect(doc.accessLog.fields.headers).toEqual({ defaultMode: 'drop' });
    expect(doc.accessLog.fields.names).toEqual({
      StartUTC: 'keep',
      RouterName: 'keep',
      ServiceName: 'keep',
      RequestHost: 'keep',
      RequestMethod: 'keep',
      DownstreamStatus: 'keep',
      DownstreamContentSize: 'keep',
      Duration: 'keep',
      OriginDuration: 'keep',
    });
    // Privacy: nothing that identifies a client or a resource is kept.
    for (const field of ['ClientAddr', 'ClientHost', 'ClientUsername', 'RequestPath', 'RequestAddr', 'RequestLine']) {
      expect(Object.keys(doc.accessLog.fields.names)).not.toContain(field);
    }
  });

  it('logLevel and accessLog compose (the preflight never asks for the file)', () => {
    const both = proxy.renderStaticConfig(null, null, { logLevel: 'ERROR', accessLog: 'file' });
    expect(both).toContain('  level: ERROR\naccessLog:\n  filePath: ');
  });

  it('static filePath ⇔ the traffic-logs mount in the argv, and the directory is created', async () => {
    freshDocker('journald');
    const on = await runArgv('acmeDns', 'file');
    const mount = `<DATA>/traffic-logs:/var/log/ninedeploy-traffic`;
    expect(on).toContain(mount);
    expect(on[on.indexOf(mount) - 1]).toBe('-v');
    expect(statSync(path.join(base, 'traffic-logs')).isDirectory()).toBe(true);
    // Everything else is the 0.14 argv except the label, which carries the new fingerprint.
    const fp = proxy.traefikConfigFingerprint('ops@example.com', DNS, { accessLog: 'file' });
    const want = golden.cases.acmeDns.argv.map((a) => a.replace(golden.cases.acmeDns.fingerprint, fp));
    want.splice(want.length - 1, 0, '-v', mount);
    expect(on).toEqual(want);
    expect(proxy.staticWritesAccessLogFile(readFileSync(path.join(base, 'traefik', 'traefik.yml'), 'utf8'))).toBe(true);

    const off = await runArgv('acmeDns', 'stdout');
    expect(off.some((a) => a.includes('ninedeploy-traffic'))).toBe(false);
    expect(proxy.staticWritesAccessLogFile(readFileSync(path.join(base, 'traefik', 'traefik.yml'), 'utf8'))).toBe(false);
  });

  it('the traffic-logs directory sits outside <data>/traefik, which the system export archives whole', () => {
    expect(path.relative(path.join(base, 'traefik'), path.join(base, 'traffic-logs')).startsWith('..')).toBe(true);
  });

  it('enabling recreates once; a second heal with the same inputs does not', async () => {
    freshDocker('journald');
    await runArgv('noAcme', 'stdout');
    // A 0.14-fingerprinted container is running; analytics gets enabled.
    const running = (fingerprint: string) =>
      h.capture.mockImplementation(async (_c: unknown, a: unknown) => {
        const args = a as string[];
        if (args[0] === 'info') return 'journald\n';
        if (args[0] === 'ps') return 'abc123\n';
        if (args[0] === 'inspect' && args[3]?.includes('.Config.Labels')) return fingerprint;
        if (args[0] === 'inspect' && args[3]?.includes('.Mounts')) return path.join(base, 'traefik');
        if (args[0] === 'inspect') return 'true|{"ninedeploy":{}}';
        return '';
      });
    running(golden.cases.noAcme.fingerprint);
    h.run.mockClear();
    await proxy.ensureTraefik(() => undefined, null, null, { accessLog: 'file' });
    expect(h.run.mock.calls.some((c) => (c[1] as string[])[0] === 'run')).toBe(true);
    running(proxy.traefikConfigFingerprint(null, null, { accessLog: 'file' }));
    h.run.mockClear();
    await proxy.ensureTraefik(() => undefined, null, null, { accessLog: 'file' });
    expect(h.run).not.toHaveBeenCalled();
  });
});

describe('traefikInputs: the one source of ensureTraefik inputs (recreate-flap guard)', () => {
  it('reads the analytics switch alongside the ACME email and DNS config', async () => {
    h.settings = { acme_email: 'ops@example.com' };
    await expect(proxy.traefikInputs({} as never)).resolves.toMatchObject({ acmeEmail: 'ops@example.com', accessLog: 'stdout' });
    h.settings.traffic_analytics_enabled = true;
    await expect(proxy.traefikInputs({} as never)).resolves.toMatchObject({ accessLog: 'file' });
    h.settings.traffic_analytics_enabled = false;
    await expect(proxy.traefikInputs({} as never)).resolves.toMatchObject({ accessLog: 'stdout' });
  });

  it('a database error does not guess "off" (that would recreate an enabled proxy)', async () => {
    h.failSettings = true;
    await expect(proxy.traefikInputs({} as never)).rejects.toThrow('database is locked');
  });

  const SRC = path.join(import.meta.dirname, '..', 'src');
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const full = path.join(dir, e);
      return statSync(full).isDirectory() ? sources(full) : e.endsWith('.ts') ? [full] : [];
    });
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('every ensureTraefik( call outside proxy.ts passes traefikInputs (static source test)', () => {
    const calls: string[] = [];
    for (const file of sources(SRC)) {
      if (file.endsWith(path.join('engine', 'proxy.ts'))) continue;
      const src = strip(readFileSync(file, 'utf8'));
      for (const m of src.matchAll(/\bensureTraefik\(([^)]*)\)/g)) {
        const rel = path.relative(SRC, file).replace(/\\/g, '/');
        calls.push(rel);
        const args = m[1]!.split(',').map((a) => a.trim());
        expect(args, `${rel}: ensureTraefik(${m[1]})`).toHaveLength(4);
        const t = args[3]!;
        expect(args[1], rel).toBe(`${t}.acmeEmail`);
        expect(args[2], rel).toBe(`${t}.dns`);
        expect(src, rel).toMatch(new RegExp(`const ${t} = await traefikInputs\\(`));
      }
    }
    // The three callers named in the design (M14), and no others.
    expect(calls.sort()).toEqual(['modules/settings.ts', 'modules/traefik.ts', 'modules/traffic.ts', 'modules/traffic.ts', 'plugins/traefik.ts']);
  });

  it('node proxies and the custom-config preflight never render the analytics file', () => {
    for (const rel of ['lib/nodeProxy.ts', 'lib/traefikCustomConfig.ts']) {
      const src = strip(readFileSync(path.join(SRC, rel), 'utf8'));
      expect(src, rel).toMatch(/renderStaticConfig\(/);
      expect(src, rel).not.toMatch(/accessLog/);
    }
  });
});
