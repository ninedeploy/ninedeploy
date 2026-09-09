import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { domains, services } from '@ninedeploy/db';
import { encryptDnsToken, ensureNetwork, ensureTraefik, getAcmeEmail, getDnsConfig, NETWORK, parseBasicAuth, parseCertExpiry, parseIpAllowlist, readCertificates, renderDynamicConfig, renderStaticConfig, traefikConfigFingerprint, writeDynamicConfig } from '../src/engine/proxy.js';
import { load } from 'js-yaml';

const h = vi.hoisted(() => {
  const capture = vi.fn(async () => '');
  const run = vi.fn(async (_cmd: string, _args: unknown[], _opts: unknown, sink?: (line: string) => void) => {
    sink?.('');
  });
  const sleep = vi.fn(async () => undefined);
  const config: { paths: { dataDir: string }; acmeEmail: string | null } = {
    paths: { dataDir: '' },
    acmeEmail: null,
  };
  return { capture, run, sleep, config };
});

vi.mock('../src/lib/exec.js', () => ({ capture: h.capture, run: h.run, sleep: h.sleep }));
vi.mock('../src/lib/dockerPull.js', () => ({ ensureDockerImage: vi.fn(async () => undefined) }));
vi.mock('../src/config.js', () => ({ config: h.config }));

const base = mkdtempSync(path.join(os.tmpdir(), 'nd-proxy-'));
h.config.paths = { dataDir: base };
const traefikDir = path.join(base, 'traefik');

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Minimal self-signed-style PEM for parser tests: the DER contains two ASCII UTCTimes. */
function pemWithDates(notBefore: string, notAfter: string): string {
  // 0x17 = UTCTime tag; length 13; the timestamp as ASCII bytes.
  const body = Buffer.concat([
    Buffer.from([0x17, 13]), Buffer.from(notBefore, 'latin1'),
    Buffer.from([0x17, 13]), Buffer.from(notAfter, 'latin1'),
    Buffer.from([0xff, 0xfe, 0x5a]), // trailing non-timestamp bytes ending in 'Z'
  ]);
  return `-----BEGIN CERTIFICATE-----\n${body.toString('base64')}\n-----END CERTIFICATE-----\n`;
}

describe('certificate tracking', () => {
  beforeEach(() => {
    mkdirSync(traefikDir, { recursive: true });
  });

  it('parses the notAfter UTCTime out of a PEM certificate', () => {
    expect(parseCertExpiry(pemWithDates('260101000000Z', '270101000000Z'))).toEqual(new Date('2027-01-01T00:00:00Z'));
    // Equal timestamps exercise the not-newer branch.
    expect(parseCertExpiry(pemWithDates('270101000000Z', '270101000000Z'))).toEqual(new Date('2027-01-01T00:00:00Z'));
  });

  it('maps years 50-99 into the 1900s per RFC 5280', () => {
    expect(parseCertExpiry(pemWithDates('500101000000Z', '510101000000Z'))).toEqual(new Date('1951-01-01T00:00:00Z'));
  });

  it('returns null when nothing is configured anywhere', async () => {
    h.config.acmeEmail = null;
    const dbWithout = { query: { settings: { findFirst: async () => undefined } } };
    await expect(getAcmeEmail(dbWithout as never)).resolves.toBe(null);
  });

  it('keeps the newest of multiple parsed timestamps', () => {
    // notAfter in the past relative to notBefore — max() must still pick notBefore.
    expect(parseCertExpiry(pemWithDates('270101000000Z', '260101000000Z'))).toEqual(new Date('2027-01-01T00:00:00Z'));
  });

  it('returns null for a non-certificate or empty PEM', () => {
    expect(parseCertExpiry('not a pem')).toBeNull();
    expect(parseCertExpiry('-----BEGIN CERTIFICATE-----\n\n-----END CERTIFICATE-----')).toBeNull();
  });

  it('reads issued certificates from acme.json', () => {
    const pem = pemWithDates('260101000000Z', '270101000000Z');
    writeFileSync(
      path.join(traefikDir, 'acme.json'),
      JSON.stringify({ letsencrypt: { Certificates: [{ domain: { main: 'app.example.com' }, certificate: pem }] } }),
    );
    const certs = readCertificates();
    expect(certs).toEqual([{ domain: 'app.example.com', expiresAt: new Date('2027-01-01T00:00:00Z') }]);
  });

  it('skips acme.json entries without a domain or certificate', () => {
    writeFileSync(
      path.join(traefikDir, 'acme.json'),
      JSON.stringify({
        letsencrypt: {
          Certificates: [
            { domain: { main: 'ok.example.com' }, certificate: pemWithDates('260101000000Z', '270101000000Z') },
            { domain: undefined, certificate: 'x' },
            { domain: { main: 'no-cert.example.com' } },
          ],
        },
        emptyResolver: {},
        otherResolver: { Certificates: [] },
      }),
    );
    const certs = readCertificates();
    expect(certs).toHaveLength(1);
    expect(certs[0]).toMatchObject({ domain: 'ok.example.com' });
  });

  it('returns [] when acme.json is missing or corrupt', () => {
    rmSync(path.join(traefikDir, 'acme.json'), { force: true });
    expect(readCertificates()).toEqual([]);
    writeFileSync(path.join(traefikDir, 'acme.json'), '{not json');
    expect(readCertificates()).toEqual([]);
    writeFileSync(path.join(traefikDir, 'acme.json'), '{}');
    expect(readCertificates()).toEqual([]);
  });

  it('prefers the DB ACME email over the env fallback and never throws', async () => {
    h.config.acmeEmail = 'env@example.com';
    const dbWithEmail = { query: { settings: { findFirst: async () => ({ value: 'db@example.com' }) } } };
    await expect(getAcmeEmail(dbWithEmail as never)).resolves.toBe('db@example.com');
    const dbWithout = { query: { settings: { findFirst: async () => undefined } } };
    await expect(getAcmeEmail(dbWithout as never)).resolves.toBe('env@example.com');
    const brokenDb = { query: { settings: { findFirst: async () => { throw new Error('no table'); } } } };
    await expect(getAcmeEmail(brokenDb as never)).resolves.toBe('env@example.com');
    h.config.acmeEmail = null;
  });
});

const makeDb = (domainRows: unknown[], serviceRows: unknown[]) => ({
  select: vi.fn(() => ({
    from: vi.fn(async (t: unknown) => {
      if (t === domains) return domainRows;
      if (t === services) return serviceRows;
      return [];
    }),
  })),
});

describe('writeDynamicConfig', () => {
  beforeEach(() => {
    mkdirSync(traefikDir, { recursive: true });
  });

  it('generates routers and service blocks for domains pointing at running services', async () => {
    const db = makeDb(
      [
        { id: 1, serviceId: 1, hostname: 'app.example.com', path: '/', ssl: true, status: 'active' },
        { id: 2, serviceId: 1, hostname: 'api.example.com', path: '/api', ssl: false, status: 'active' },
      ],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
    );

    await writeDynamicConfig(db as never);

    const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    expect(yaml).toContain('rule: "Host(`app.example.com`)');
    expect(yaml).toContain('entryPoints:\n        - websecure');
    expect(yaml).toContain('tls: {}');
    expect(yaml).toContain('rule: "Host(`api.example.com`) && PathPrefix(`/api`)');
    expect(yaml).toContain('entryPoints:\n        - web');
    expect(yaml).toContain('svc_web_1:');
    expect(yaml).toContain('svc_web_2:');
    expect(yaml).toContain('url: "http://web-1:3000"');
    // domains + services to render, then `servers` to decide whether any node
    // proxy needs the same refresh. A single-host install pays that third
    // select over an empty table and fans out to nobody.
    expect(db.select).toHaveBeenCalledTimes(3);
  });

  it('routes PM2 services through the host gateway (a process name is not DNS-resolvable)', async () => {
    // A PM2 runtimeId is a PM2 PROCESS NAME on the host — inside the Traefik
    // container it resolves to NXDOMAIN, so every domain attached to a PM2
    // service would 502 forever with a container-style upstream.
    const db = makeDb(
      [{ id: 1, serviceId: 1, hostname: 'legacy.example.com', path: '/', ssl: false, status: 'active' }],
      [{ id: 1, slug: 'legacy', port: 3000, runtimeId: 'legacy-42', type: 'pm2' }],
    );

    await writeDynamicConfig(db as never);

    const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    expect(yaml).toContain('url: "http://host.docker.internal:3000"');
    expect(yaml).not.toContain('http://legacy-42:3000');
  });

  it('H-2: never routes a domain still awaiting DNS ownership proof', async () => {
    const db = makeDb(
      [
        { id: 1, serviceId: 1, hostname: 'unproven.victim.com', path: '/', ssl: true, status: 'pending' },
        { id: 2, serviceId: 1, hostname: 'failed.victim.com', path: '/', ssl: true, status: 'error' },
        { id: 3, serviceId: 1, hostname: 'proven.example.com', path: '/', ssl: true, status: 'active' },
      ],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
    );

    await writeDynamicConfig(db as never);

    // This file IS the enforcement point: a pending row exists in the database
    // and is simply never described to Traefik, so the claim serves nothing.
    const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    expect(yaml).toContain('proven.example.com');
    expect(yaml).not.toContain('unproven.victim.com');
    expect(yaml).not.toContain('failed.victim.com');
  });

  it('skips domains whose service is missing or not runnable', async () => {
    const db = makeDb(
      [
        { id: 1, serviceId: 99, hostname: 'orphan.example.com', path: '/', ssl: false, status: 'active' },
        { id: 2, serviceId: 3, hostname: 'noport.example.com', path: '/', ssl: false, status: 'active' },
        { id: 3, serviceId: 2, hostname: 'noruntime.example.com', path: '/', ssl: false, status: 'active' },
        { id: 4, serviceId: 1, hostname: 'ok.example.com', path: '/', ssl: false, status: 'active' },
      ],
      [
        { id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' },
        { id: 2, slug: 'x', port: 3000, runtimeId: null },
        { id: 3, slug: 'y', port: null, runtimeId: 'y-1' },
      ],
    );

    await writeDynamicConfig(db as never);

    const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    expect(yaml).toContain('ok.example.com');
    expect(yaml).not.toContain('orphan.example.com');
    expect(yaml).not.toContain('noport.example.com');
    expect(yaml).not.toContain('noruntime.example.com');
  });

  it('omits empty sections entirely when there are no domains', async () => {
    const db = makeDb([], []);

    await writeDynamicConfig(db as never);

    const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    // Traefik v3 rejects empty maps like `middlewares: {}` ("cannot be a
    // standalone element"), so empty sections must not be emitted at all.
    expect(yaml).not.toContain('routers:');
    expect(yaml).not.toContain('middlewares:');
    expect(yaml).not.toContain('services:');
    expect(yaml).toBe('');
  });

  it('dedupes identical service keys', async () => {
    const db = makeDb(
      [
        { id: 1, serviceId: 1, hostname: 'dup.example.com', path: '/', ssl: false, status: 'active' },
        { id: 1, serviceId: 1, hostname: 'dup.example.com', path: '/', ssl: false, status: 'active' },
      ],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
    );

    await writeDynamicConfig(db as never);

    const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    expect(yaml.match(/svc_web_1:/g)).toHaveLength(1);
  });

  it('propagates write failures', async () => {
    rmSync(traefikDir, { recursive: true, force: true });
    const db = makeDb(
      [{ id: 1, serviceId: 1, hostname: 'a.example.com', path: '/', ssl: false, status: 'active' }],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
    );

    await expect(writeDynamicConfig(db as never)).rejects.toThrow();
  });

  it('sanitizes hostile characters out of the hostname and path (rule/YAML injection)', async () => {
    const db = makeDb(
      [{ id: 1, serviceId: 1, hostname: 'evil`.example.com)inject', path: '/api`)breakout', ssl: false, status: 'active' }],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
    );

    await writeDynamicConfig(db as never);

    const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    // Backticks, ')' and other unsafe chars are stripped; the safe remainder is kept.
    expect(yaml).toContain('Host(`evil.example.cominject`) && PathPrefix(`/apibreakout`)');
    expect(yaml).not.toMatch(/\)$/); // no unescaped ')' terminating a rule
  });

  it('skips a domain whose hostname is null or sanitizes to nothing', async () => {
    const db = makeDb(
      [
        { id: 1, serviceId: 1, hostname: null, path: '/', ssl: false, status: 'active' },
        { id: 2, serviceId: 1, hostname: 'good.example.com', path: '/', ssl: false, status: 'active' },
      ],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
    );

    await writeDynamicConfig(db as never);

    const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    expect(yaml).toContain('good.example.com');
    // Only one router survived (the null-hostname one was skipped).
    expect(yaml.match(/rule:/g)).toHaveLength(1);
  });

  it('omits PathPrefix when the path is null', async () => {
    const db = makeDb(
      [{ id: 1, serviceId: 1, hostname: 'app.example.com', path: null, ssl: false, status: 'active' }],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
    );

    await writeDynamicConfig(db as never);

    const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    expect(yaml).toContain('Host(`app.example.com`)');
    expect(yaml).not.toContain('PathPrefix');
  });
});

describe('ensureNetwork', () => {
  it('does nothing when the network already exists', async () => {
    h.capture.mockResolvedValue(`${NETWORK}\n`);
    const log = vi.fn();

    await ensureNetwork(log);

    expect(h.run).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('creates the network when it is missing', async () => {
    h.capture.mockResolvedValue('');
    const log = vi.fn();

    await ensureNetwork(log);

    expect(h.run).toHaveBeenCalledWith('docker', ['network', 'create', NETWORK], {}, log);
    expect(log).toHaveBeenCalledWith(`network '${NETWORK}' created`);
  });

  it('logs and rejects when listing networks fails with an Error', async () => {
    h.capture.mockRejectedValue(new Error('docker down'));
    const log = vi.fn();

    await expect(ensureNetwork(log)).rejects.toThrow('docker down');

    expect(log).toHaveBeenCalledWith('network warning: docker down');
  });

  it('normalizes and rejects a non-Error network failure', async () => {
    h.capture.mockRejectedValue('boom');
    const log = vi.fn();

    await expect(ensureNetwork(log)).rejects.toThrow('boom');

    expect(log).toHaveBeenCalledWith('network warning: boom');
  });
});

describe('ensureTraefik', () => {
  const psWith = (ps: string, inspect = '{}') =>
    h.capture.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'ps') return Promise.resolve(ps);
      if (args[0] === 'inspect' && args[3]?.includes('.State.Running')) {
        return Promise.resolve(`true|{"${NETWORK}":{}}`);
      }
      if (args[0] === 'inspect' && args[3]?.includes('.Config.Labels')) {
        return Promise.resolve(traefikConfigFingerprint(null, null));
      }
      return Promise.resolve(inspect);
    });

  beforeEach(() => {
    mkdirSync(traefikDir, { recursive: true });
    // Start each ensureTraefik test with no dynamic.yml so the bootstrap write
    // branch (the initial empty config) is exercised.
    rmSync(path.join(traefikDir, 'dynamic.yml'), { force: true });
  });

  it('writes static + dynamic config and returns early when traefik is on the network', async () => {
    writeFileSync(path.join(traefikDir, 'traefik.yml'), renderStaticConfig(null, null));
    psWith('abc123\n', '{"ninedeploy":{}}');
    const log = vi.fn();

    await ensureTraefik(log);

    expect(log).toHaveBeenCalledWith('traefik already running on shared network');
    expect(h.run).not.toHaveBeenCalled();
    expect(existsSync(path.join(traefikDir, 'traefik.yml'))).toBe(true);
    expect(existsSync(path.join(traefikDir, 'dynamic.yml'))).toBe(true);
  });

  it('recreates the container when it is running but off the network', async () => {
    psWith('abc123\n', '{"other":{}}');
    h.run.mockRejectedValueOnce(new Error('no such container')).mockResolvedValueOnce(undefined);
    const log = vi.fn();

    await ensureTraefik(log);

    expect(log).toHaveBeenCalledWith('starting traefik container …');
    expect(log).toHaveBeenCalledWith('traefik started (http :80 / https :443) on shared network');
    expect(h.sleep).toHaveBeenCalledWith(1000);
    expect(h.run).toHaveBeenCalledWith('docker', ['rm', '-f', 'ninedeploy-traefik'], {}, expect.any(Function));
    expect(h.run).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'run', '-d', '--name', 'ninedeploy-traefik', '--restart', 'unless-stopped',
        '--network', NETWORK,
        '--add-host', 'host.docker.internal:host-gateway',
        '-p', '80:80', '-p', '443:443',
        // The whole config dir is mounted (single-file mounts pin the inode and
        // would never see atomic rename-based updates).
        '-v', `${traefikDir}:/etc/traefik:ro`,
        'traefik:3',
      ]),
      {},
      log,
    );
  });

  it('starts the container when none is running', async () => {
    psWith('', '{"ninedeploy":{}}');
    const log = vi.fn();

    await ensureTraefik(log);

    expect(log).toHaveBeenCalledWith('starting traefik container …');
    expect(log).toHaveBeenCalledWith('traefik started (http :80 / https :443) on shared network');
  });

  it('recreates when inspection fails', async () => {
    h.capture.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'ps') return Promise.resolve('abc\n');
      if (args[0] === 'inspect' && args[3]?.includes('.State.Running')) {
        return Promise.resolve(`true|{"${NETWORK}":{}}`);
      }
      return Promise.reject(new Error('inspect failed'));
    });
    const log = vi.fn();

    await ensureTraefik(log);

    expect(log).toHaveBeenCalledWith('starting traefik container …');
  });

  it('logs and rejects when the ps command fails', async () => {
    h.capture.mockRejectedValue(new Error('docker down'));
    const log = vi.fn();

    await expect(ensureTraefik(log)).rejects.toThrow('docker down');

    expect(log).toHaveBeenCalledWith('traefik warning: docker down');
    expect(log).toHaveBeenCalledWith('domain routing will be unavailable until traefik can bind :80/:443');
  });

  it('normalizes and rejects a non-Error traefik failure', async () => {
    h.capture.mockRejectedValue('boom');
    const log = vi.fn();

    await expect(ensureTraefik(log)).rejects.toThrow('boom');

    expect(log).toHaveBeenCalledWith('traefik warning: boom');
  });

  it('recreates a running container when its static configuration changes', async () => {
    writeFileSync(path.join(traefikDir, 'traefik.yml'), renderStaticConfig(null, null));
    psWith('abc123\n', '{"ninedeploy":{}}');
    const log = vi.fn();

    await ensureTraefik(log, 'ops@example.com');

    expect(log).toHaveBeenCalledWith('traefik static configuration changed; recreating container to apply it');
    expect(h.run).toHaveBeenCalledWith('docker', ['rm', '-f', 'ninedeploy-traefik'], {}, expect.any(Function));
    expect(readFileSync(path.join(traefikDir, 'traefik.yml'), 'utf8')).toContain('email: ops@example.com');
  });

  it('rejects when docker run returns but the container exits immediately', async () => {
    h.capture.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'ps') return Promise.resolve('');
      if (args[0] === 'inspect') return Promise.resolve('false|{}');
      if (args[0] === 'logs') return Promise.resolve('listen tcp :80: bind: address already in use');
      return Promise.resolve('');
    });
    const log = vi.fn();

    await expect(ensureTraefik(log)).rejects.toThrow('address already in use');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('traefik container did not stay running'));
  });

  it('leaves an existing dynamic.yml untouched', async () => {
    writeFileSync(path.join(traefikDir, 'dynamic.yml'), '# keep me');
    psWith('abc\n', '{"ninedeploy":{}}');
    const log = vi.fn();

    await ensureTraefik(log);

    expect(readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8')).toBe('# keep me');
    expect(log).toHaveBeenCalledWith('traefik already running on shared network');
  });
});

describe("ACME / Let's Encrypt", () => {
  beforeEach(() => {
    mkdirSync(traefikDir, { recursive: true });
    rmSync(path.join(traefikDir, 'acme.json'), { force: true });
  });

  it('omits the ACME resolver from the static config when no email is configured', async () => {
    const psWith = (ps: string) =>
      h.capture.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'ps') return Promise.resolve(ps);
        if (args[0] === 'inspect' && args[3]?.includes('.State.Running')) {
          return Promise.resolve(`true|{"${NETWORK}":{}}`);
        }
        return Promise.resolve('{}');
      });
    psWith('abc123\n');
    const log = vi.fn();

    await ensureTraefik(log);

    const yaml = readFileSync(path.join(traefikDir, 'traefik.yml'), 'utf8');
    expect(yaml).not.toContain('certificatesResolvers');
    expect(existsSync(path.join(traefikDir, 'acme.json'))).toBe(false);
  });

  it('writes a letsencrypt certificatesResolver when an email is configured', async () => {
    h.config.acmeEmail = 'ops@example.com';
    try {
      h.capture.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'ps') return Promise.resolve('abc123\n');
        if (args[0] === 'inspect' && args[3]?.includes('.State.Running')) {
          return Promise.resolve(`true|{"${NETWORK}":{}}`);
        }
        return Promise.resolve('{"ninedeploy":{}}');
      });
      const log = vi.fn();

      await ensureTraefik(log);

      const yaml = readFileSync(path.join(traefikDir, 'traefik.yml'), 'utf8');
      expect(yaml).toContain('certificatesResolvers:');
      expect(yaml).toContain('letsencrypt:');
      expect(yaml).toContain('email: ops@example.com');
      expect(yaml).toContain('storage: /etc/traefik/acme.json');
      expect(yaml).toContain('httpChallenge:');
      expect(yaml).toContain('entryPoint: web');
      // acme.json is seeded so the bind mount is a FILE, not an auto-created dir.
      expect(existsSync(path.join(traefikDir, 'acme.json'))).toBe(true);
    } finally {
      h.config.acmeEmail = null;
    }
  });

  it('mounts acme.json read-write and keeps the config dir read-only', async () => {
    h.config.acmeEmail = 'ops@example.com';
    try {
      h.capture.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'ps') return Promise.resolve('');
        if (args[0] === 'inspect' && args[3]?.includes('.State.Running')) {
          return Promise.resolve(`true|{"${NETWORK}":{}}`);
        }
        return Promise.resolve('{}');
      });
      // The stale-container rm is allowed to fail; the main run succeeds.
      h.run.mockRejectedValueOnce(new Error('no such container')).mockResolvedValueOnce(undefined);
      const log = vi.fn();

      await ensureTraefik(log);

      const runCall = h.run.mock.calls.find((c) => (c[1] as string[])[0] === 'run');
      expect(runCall).toBeDefined();
      const args = runCall![1] as string[];
      expect(args).toContain('-v');
      const dirIdx = args.indexOf('-v');
      expect(args[dirIdx + 1]).toBe(`${traefikDir}:/etc/traefik:ro`);
      expect(args).toContain(`${path.join(traefikDir, 'acme.json')}:/etc/traefik/acme.json`);
    } finally {
      h.config.acmeEmail = null;
    }
  });

  it('emits certResolver: letsencrypt on ssl routers when ACME is configured', async () => {
    h.config.acmeEmail = 'ops@example.com';
    try {
      const db = makeDb(
        [{ id: 1, serviceId: 1, hostname: 'app.example.com', path: '/', ssl: true, status: 'active' }],
        [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
      );

      await writeDynamicConfig(db as never);

      const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
      expect(yaml).toContain('tls:\n        certResolver: letsencrypt');
      expect(yaml).not.toContain('tls: {}');
    } finally {
      h.config.acmeEmail = null;
    }
  });

  it('keeps tls: {} on ssl routers when ACME is not configured', async () => {
    const db = makeDb(
      [{ id: 1, serviceId: 1, hostname: 'app.example.com', path: '/', ssl: true, status: 'active' }],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
    );

    await writeDynamicConfig(db as never);

    const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    expect(yaml).toContain('tls: {}');
    expect(yaml).not.toContain('certResolver');
  });
});


describe('DNS-01 challenge (wildcard SSL)', () => {
  beforeEach(() => {
    mkdirSync(traefikDir, { recursive: true });
    rmSync(path.join(traefikDir, 'dns.env'), { force: true });
    h.capture.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'ps') return Promise.resolve('');
      if (args[0] === 'inspect' && args[3]?.includes('.State.Running')) {
        return Promise.resolve(`true|{"${NETWORK}":{}}`);
      }
      return Promise.resolve('{}');
    });
  });

  it('renders a dnsChallenge resolver when a provider+token are configured', () => {
    const yml = renderStaticConfig('ops@example.com', { provider: 'cloudflare', token: 'tok', wildcardApex: 'example.com' });
    expect(yml).toContain('dnsChallenge:');
    expect(yml).toContain('provider: cloudflare');
    expect(yml).not.toContain('httpChallenge:');
  });

  it('emits caServer when a staging directory is configured', () => {
    h.config.acmeCaServer = 'https://acme-staging-v02.api.letsencrypt.org/directory';
    const yml = renderStaticConfig('ops@example.com', null);
    expect(yml).toContain('caServer: https://acme-staging-v02.api.letsencrypt.org/directory');
    h.config.acmeCaServer = null;
    // Without the override the production directory is used implicitly.
    expect(renderStaticConfig('ops@example.com', null)).not.toContain('caServer:');
  });

  it('keeps httpChallenge without a DNS provider', () => {
    const yml = renderStaticConfig('ops@example.com', null);
    expect(yml).toContain('httpChallenge:');
    expect(yml).not.toContain('dnsChallenge:');

    // An unknown provider or a missing token also falls back to HTTP-01.
    const unknown = renderStaticConfig('ops@example.com', { provider: 'nope', token: 'tok', wildcardApex: null });
    expect(unknown).toContain('httpChallenge:');
    const tokenless = renderStaticConfig('ops@example.com', { provider: 'cloudflare', token: null, wildcardApex: null });
    expect(tokenless).toContain('httpChallenge:');
  });

  it('writes the provider token to a 0600 dns.env and passes --env-file to the container', async () => {
    h.config.acmeEmail = 'ops@example.com';
    await ensureTraefik(() => undefined, 'ops@example.com', { provider: 'cloudflare', token: 'sekrit', wildcardApex: 'example.com' });
    const envFile = path.join(traefikDir, 'dns.env');
    expect(readFileSync(envFile, 'utf8')).toBe('CF_DNS_API_TOKEN=sekrit\n');
    // The last `run` call is the post-deploy Traefik bridge reap (Model B),
    // not the Traefik container run we want to inspect. Find the `docker run
    // -d --name ninedeploy-traefik` call explicitly.
    const runArgs = h.run.mock.calls.map((c) => c[1] as string[]);
    const args = runArgs.find((a) => a[0] === 'run' && a.includes('--name') && a.includes('ninedeploy-traefik'));
    expect(args).toBeDefined();
    const idx = args!.indexOf('--env-file');
    expect(idx).toBeGreaterThan(-1);
    expect(args![idx + 1]).toBe(envFile);
    h.config.acmeEmail = null;
  });

  it('skips the env file without a provider/token', async () => {
    h.config.acmeEmail = 'ops@example.com';
    await ensureTraefik(() => undefined, 'ops@example.com', null);
    expect(existsSync(path.join(traefikDir, 'dns.env'))).toBe(false);
    h.config.acmeEmail = null;
  });

  it('getDnsConfig prefers DB settings, decrypts the token, and normalizes the apex', async () => {
    const { encrypt } = await import('../src/lib/crypto.js');
    vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'b'.repeat(64));
    const values: Record<string, unknown> = {
      dns_provider: 'hetzner',
      dns_token_encrypted: encrypt('sekrit'),
      wildcard_domain: '*.example.com',
    };
    // getDnsConfig reads the three settings in a fixed order — answer each
    // lookup with its own value via a sequential mock.
    const ordered = [values['dns_provider'], values['dns_token_encrypted'], values['wildcard_domain']].map((value) => ({ value }));
    const db = {
      query: {
        settings: {
          findFirst: vi.fn()
            .mockResolvedValueOnce(ordered[0])
            .mockResolvedValueOnce(ordered[1])
            .mockResolvedValueOnce(ordered[2]),
        },
      },
    } as never;
    const result = await getDnsConfig(db);
    expect(result).toEqual({ provider: 'hetzner', token: 'sekrit', wildcardApex: 'example.com' });
    vi.unstubAllEnvs();
  });

  it('encryptDnsToken round-trips through the master-key envelope', async () => {
    vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'b'.repeat(64));
    const { decrypt } = await import('../src/lib/crypto.js');
    expect(decrypt(encryptDnsToken('roundtrip'))).toBe('roundtrip');
    vi.unstubAllEnvs();
  });

  it('does not leak the env token when the DB names a different provider', async () => {
    h.config.dnsProvider = 'cloudflare';
    h.config.dnsToken = 'cf-env-token';
    const db = {
      query: {
        settings: {
          findFirst: vi.fn()
            .mockResolvedValueOnce({ value: 'hetzner' }) // dns_provider (DB wins)
            .mockResolvedValueOnce(undefined) // no stored token
            .mockResolvedValueOnce(undefined), // no stored apex
        },
      },
    } as never;
    const result = await getDnsConfig(db);
    expect(result.provider).toBe('hetzner');
    expect(result.token).toBeNull(); // env token belongs to cloudflare, not hetzner
    h.config.dnsProvider = null;
    h.config.dnsToken = null;
  });

  it('renderDnsEnvFile returns null without provider/token or for unknown providers', async () => {
    h.config.acmeEmail = 'ops@example.com';
    // No token → no env file, no --env-file flag.
    await ensureTraefik(() => undefined, 'ops@example.com', { provider: 'cloudflare', token: null, wildcardApex: null });
    expect(existsSync(path.join(traefikDir, 'dns.env'))).toBe(false);
    // Unknown provider → also skipped (falls back to HTTP-01).
    await ensureTraefik(() => undefined, 'ops@example.com', { provider: 'nope', token: 'tok', wildcardApex: null });
    expect(existsSync(path.join(traefikDir, 'dns.env'))).toBe(false);
    h.config.acmeEmail = null;
  });

  it('getDnsConfig falls back to env vars and never throws on db errors', async () => {
    h.config.dnsProvider = 'cloudflare';
    h.config.dnsToken = 'env-tok';
    h.config.wildcardDomain = '*.example.com';
    const noRows = { query: { settings: { findFirst: async () => undefined } } } as never;
    expect(await getDnsConfig(noRows)).toEqual({ provider: 'cloudflare', token: 'env-tok', wildcardApex: 'example.com' });
    const broken = { query: { settings: { findFirst: async () => { throw new Error('no table'); } } } } as never;
    expect(await getDnsConfig(broken)).toEqual({ provider: 'cloudflare', token: 'env-tok', wildcardApex: 'example.com' });
    h.config.dnsProvider = null;
    h.config.dnsToken = null;
    h.config.wildcardDomain = '';
  });

  it('writes a wildcard certificate block and HostRegexp routes for wildcard hosts', async () => {
    vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'b'.repeat(64));
    h.config.acmeEmail = 'ops@example.com';
    h.config.dnsProvider = 'cloudflare';
    h.config.dnsToken = 'tok';
    h.config.wildcardDomain = 'example.com';

    const db = makeDb(
      [
        { id: 1, serviceId: 1, hostname: '*.example.com', path: '/', ssl: true, status: 'active' },
        { id: 2, serviceId: 1, hostname: 'plain.example.com', path: '/', ssl: true, status: 'active' },
      ],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
    );
    await writeDynamicConfig(db as never);
    const yml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    // Wildcard host → HostRegexp with an escaped suffix.
    // Backslashes are doubled: the rule sits in a double-quoted YAML scalar.
    expect(yml).toContain('HostRegexp(`^[a-zA-Z0-9-]+\\\\.example\\\\.com$`)');
    // Plain host keeps the literal matcher.
    expect(yml).toContain('Host(`plain.example.com`)');
    // One wildcard cert for the apex, apex as SAN.
    expect(yml).toContain('main: "*.example.com"');
    expect(yml).toContain('- "example.com"');

    h.config.acmeEmail = null;
    h.config.dnsProvider = null;
    h.config.dnsToken = null;
    h.config.wildcardDomain = '';
    vi.unstubAllEnvs();
  });

  it('omits the wildcard block without DNS-01 readiness', async () => {
    h.config.acmeEmail = 'ops@example.com';
    h.config.dnsProvider = null; // no provider → HTTP-01 only
    h.config.wildcardDomain = 'example.com';
    await writeDynamicConfig(makeDb([], []) as never);
    const yml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    expect(yml).not.toContain('main: "*.example.com"');
    h.config.acmeEmail = null;
    h.config.wildcardDomain = '';
  });

  it('emits a www→apex redirect middleware and wires it to the router', async () => {
    const db = makeDb(
      [{ id: 1, serviceId: 1, hostname: 'www.example.com', path: '/', ssl: true, redirectWww: true, status: 'active' }],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
    );

    await writeDynamicConfig(db as never);

    const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    expect(yaml).toContain('mw_web_1_www:');
    expect(yaml).toContain('regex: "^https?://(?:www\\\\.)?example\\\\.com(.*)"');
    expect(yaml).toContain('replacement: "https://example.com$1"');
    expect(yaml).toContain('middlewares:\n        - mw_web_1_www');
    // The empty middlewares section is never emitted when one exists.
    expect(yaml).not.toContain('middlewares:    {}');
  });

  it('skips the www redirect for wildcard hostnames', async () => {
    const db = makeDb(
      [{ id: 1, serviceId: 1, hostname: '*.example.com', path: '/', ssl: true, redirectWww: true, status: 'active' }],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
    );

    await writeDynamicConfig(db as never);

    const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    expect(yaml).not.toContain('mw_web_1_www');
  });

  it('emits sanitized custom response headers as a middleware', async () => {
    const db = makeDb(
      [
        {
          id: 1, serviceId: 1, hostname: 'app.example.com', path: '/', ssl: false, status: 'active',
          headers: JSON.stringify([
            { name: 'X-Frame-Options', value: 'DENY' },
            { name: 'X-Evil-Name!"', value: 'va"lue\nbreak' },
            { name: '', value: 'dropped' },
            'not-an-object',
          ]),
        },
      ],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
    );

    await writeDynamicConfig(db as never);

    const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    expect(yaml).toContain('mw_web_1_headers:');
    expect(yaml).toContain('"X-Frame-Options": "DENY"');
    // Unsafe chars are stripped from names and values; empty names dropped.
    expect(yaml).toContain('"X-Evil-Name": "valuebreak"');
    expect(yaml).not.toContain('dropped');
    expect(yaml).toContain('middlewares:\n        - mw_web_1_headers');
  });

  it('ignores malformed headers JSON entirely', async () => {
    const db = makeDb(
      [{ id: 1, serviceId: 1, hostname: 'app.example.com', path: '/', ssl: false, headers: '{oops', status: 'active' }],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
    );

    await writeDynamicConfig(db as never);

    const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    expect(yaml).not.toContain('mw_web_1_headers');
    expect(yaml).not.toContain('middlewares:');
  });

  it('ignores a non-array headers JSON document', async () => {
    const db = makeDb(
      [{ id: 1, serviceId: 1, hostname: 'app.example.com', path: '/', ssl: false, headers: '{"name":"x', status: 'active' }],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
    );

    await writeDynamicConfig(db as never);

    const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    expect(yaml).not.toContain('mw_web_1_headers');
  });

  it('omits the middlewares section when no domain needs one', async () => {
    const db = makeDb(
      [{ id: 1, serviceId: 1, hostname: 'plain.example.com', path: '/', ssl: false, status: 'active' }],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
    );

    await writeDynamicConfig(db as never);

    const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    expect(yaml).not.toContain('middlewares:');
  });

  it('emits basicAuth, ipAllowList, and rateLimit middlewares correctly', async () => {
    const db = makeDb(
      [
        {
          id: 1,
          serviceId: 1,
          hostname: 'secure.example.com', status: 'active',
          path: '/',
          ssl: false,
          basicAuth: JSON.stringify(['admin:$apr1$xyz', 'user:pass']),
          ipAllowlist: '1.2.3.4/32, 10.0.0.0/8',
          rateLimitAverage: 50,
          rateLimitBurst: 100,
        },
      ],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
    );

    await writeDynamicConfig(db as never);

    const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    expect(yaml).toContain('mw_web_1_auth:');
    expect(yaml).toContain('basicAuth:');
    expect(yaml).toContain('- "admin:$apr1$xyz"');
    expect(yaml).toContain('- "user:pass"');

    expect(yaml).toContain('mw_web_1_ip:');
    expect(yaml).toContain('ipAllowList:');
    expect(yaml).toContain('- "1.2.3.4/32"');
    expect(yaml).toContain('- "10.0.0.0/8"');

    expect(yaml).toContain('mw_web_1_ratelimit:');
    expect(yaml).toContain('rateLimit:');
    expect(yaml).toContain('average: 50');
    expect(yaml).toContain('burst: 100');

    expect(yaml).toContain('middlewares:\n        - mw_web_1_auth\n        - mw_web_1_ip\n        - mw_web_1_ratelimit');
  });

  it('handles fallback for rateLimitBurst when 0 or unspecified', async () => {
    const db = makeDb(
      [
        {
          id: 2,
          serviceId: 1,
          hostname: 'rate.example.com', status: 'active',
          path: '/',
          ssl: false,
          rateLimitAverage: 20,
          rateLimitBurst: 0,
        },
      ],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
    );

    await writeDynamicConfig(db as never);

    const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
    expect(yaml).toContain('mw_web_2_ratelimit:');
    expect(yaml).toContain('average: 20');
    expect(yaml).toContain('burst: 20');
  });

  it('generates a panel router and service when panel_domain is set', async () => {
    process.env['NINEDEPLOY_DOMAIN'] = 'panel.example.com';
    try {
      const db = makeDb([], []);
      await writeDynamicConfig(db as never);

      const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');
      expect(yaml).toContain('ninedeploy_panel:');
      expect(yaml).toContain('Host(`panel.example.com`)');
      expect(yaml).toContain('svc_ninedeploy_panel:');
      expect(yaml).toContain('http://host.docker.internal:');
    } finally {
      delete process.env['NINEDEPLOY_DOMAIN'];
    }
  });

  it('H-2: the panel router carries an explicit priority no service rule can beat', async () => {
    process.env['NINEDEPLOY_DOMAIN'] = 'panel.example.com';
    try {
      const db = makeDb([], []);
      await writeDynamicConfig(db as never);
      const yaml = readFileSync(path.join(traefikDir, 'dynamic.yml'), 'utf8');

      // Traefik's default priority IS the rule length, so a service router with
      // `Host(panel…) && PathPrefix(/v1)` would otherwise out-rank the panel and
      // intercept admin bearer tokens.
      const priority = /ninedeploy_panel:[\s\S]*?priority: (\d+)/.exec(yaml)?.[1];
      expect(priority).toBeDefined();
      // A hostname is at most 253 chars; a rule built from host + path cannot
      // approach this, so the panel always wins.
      expect(Number(priority)).toBeGreaterThan(1000);
    } finally {
      delete process.env['NINEDEPLOY_DOMAIN'];
    }
  });
});

describe('parseBasicAuth and parseIpAllowlist', () => {
  it('parses basicAuth from array, string, and raw fallback', () => {
    expect(parseBasicAuth(null)).toEqual([]);
    expect(parseBasicAuth('')).toEqual([]);
    expect(parseBasicAuth(JSON.stringify(['user:pass', 'invalid', '  admin:hash  ']))).toEqual(['user:pass', 'admin:hash']);
    expect(parseBasicAuth(JSON.stringify('alice:pass, bob:pass'))).toEqual(['alice:pass', 'bob:pass']);
    expect(parseBasicAuth('test:secret\nroot:hash')).toEqual(['test:secret', 'root:hash']);
  });

  it('parses ipAllowlist from array, string, and raw fallback', () => {
    expect(parseIpAllowlist(null)).toEqual([]);
    expect(parseIpAllowlist('')).toEqual([]);
    expect(parseIpAllowlist(JSON.stringify(['192.168.1.1/32', '  10.0.0.0/8  ', '']))).toEqual(['192.168.1.1/32', '10.0.0.0/8']);
    expect(parseIpAllowlist(JSON.stringify('1.1.1.1/32, 8.8.8.8/32'))).toEqual(['1.1.1.1/32', '8.8.8.8/32']);
    expect(parseIpAllowlist('127.0.0.1\nfe80::1/64, evil!chars')).toEqual(['127.0.0.1', 'fe80::1/64', 'eca']);
  });
});


/**
 * r037 — a router's upstream is a CONTAINER NAME resolved over the local
 * Docker network, so which proxy is being rendered decides which services may
 * appear in it.
 *
 * Before remote deploys existed this was moot: a service pinned to a node
 * never got a `runtimeId`, so the `!svc.runtimeId` guard dropped it anyway.
 * Now that nodes really run containers, rendering every service into every
 * proxy would make the panel's Traefik advertise routes for containers on
 * another machine and answer 502 for each one — with the node's own proxy
 * doing the same in reverse.
 */
describe('renderDynamicConfig scoping', () => {
  const localAndRemote = () =>
    makeDb(
      [
        { id: 1, serviceId: 1, hostname: 'local.example.com', path: '/', ssl: true, status: 'active' },
        { id: 2, serviceId: 2, hostname: 'node.example.com', path: '/', ssl: true, status: 'active' },
      ],
      [
        { id: 1, slug: 'local', port: 3000, runtimeId: 'local-1', serverId: null },
        { id: 2, slug: 'remote', port: 3000, runtimeId: 'remote-9', serverId: 4 },
      ],
    );

  it('keeps a node-pinned service out of the panel proxy', async () => {
    const yaml = await renderDynamicConfig(localAndRemote() as never, { serverId: null });
    expect(yaml).toContain('local.example.com');
    // The panel's Traefik cannot resolve `remote-9` — it lives on another host.
    expect(yaml).not.toContain('node.example.com');
    expect(yaml).not.toContain('remote-9');
  });

  it('renders only that node’s services into the node proxy', async () => {
    const yaml = await renderDynamicConfig(localAndRemote() as never, { serverId: 4 });
    expect(yaml).toContain('node.example.com');
    expect(yaml).toContain('url: "http://remote-9:3000"');
    expect(yaml).not.toContain('local.example.com');
  });

  it('never gives a node the panel dashboard router', async () => {
    // The dashboard runs on the panel host. A node claiming its hostname would
    // blackhole the control plane behind whichever node answered DNS first.
    const db = makeDb(
      [],
      [{ id: 2, slug: 'remote', port: 3000, runtimeId: 'remote-9', serverId: 4 }],
    );
    const withPanelDomain = {
      ...db,
      query: { settings: { findFirst: async () => ({ value: 'panel.example.com' }) } },
    };
    const yaml = await renderDynamicConfig(withPanelDomain as never, { serverId: 4 });
    expect(yaml).not.toContain('ninedeploy_panel');
    expect(yaml).not.toContain('panel.example.com');
  });

  it('still gives the panel its own dashboard router', async () => {
    const db = makeDb([], [{ id: 1, slug: 'local', port: 3000, runtimeId: 'local-1', serverId: null }]);
    const withPanelDomain = {
      ...db,
      query: { settings: { findFirst: async () => ({ value: 'panel.example.com' }) } },
    };
    const yaml = await renderDynamicConfig(withPanelDomain as never, { serverId: null });
    expect(yaml).toContain('ninedeploy_panel');
  });
});

/**
 * r034 regression — the sticky middleware block is keyed by SERVICE
 * (`mw_sticky_<id>`) but used to be emitted once PER DOMAIN. A service with
 * two domains produced duplicate YAML mapping keys, and Traefik's file
 * provider (go-yaml v3) refuses the whole dynamic config over a duplicate
 * key — silently freezing that proxy's route table. js-yaml v4 enforces the
 * same duplicate-key rule and stands in as the validator here.
 */
describe('sticky session middleware (r034 regression)', () => {
  /** Extract the settings key from a drizzle eq(settings.key, key) predicate. */
  const keyFromWhere = (where: unknown): string | undefined => {
    let found: string | undefined;
    const visited = new Set<object>();
    const walk = (node: unknown): void => {
      if (node == null || found !== undefined || typeof node !== 'object') return;
      if (visited.has(node)) return;
      visited.add(node);
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      const rec = node as { encoder?: unknown; value?: unknown; queryChunks?: unknown };
      // Param chunks carry .value + .encoder; StringChunk also has .value.
      if ('encoder' in rec && 'value' in rec) {
        found ??= String(rec.value);
        return;
      }
      if (rec.queryChunks) walk(rec.queryChunks);
    };
    try {
      walk((where as { queryChunks?: unknown } | undefined)?.queryChunks ?? where);
    } catch {
      /* predicate shape not understood — answer "absent" */
    }
    return found;
  };

  const stickyDb = (domainRows: unknown[], serviceRows: unknown[], enabled: Record<number, boolean>) => ({
    ...makeDb(domainRows, serviceRows),
    query: {
      settings: {
        findFirst: async (args?: { where?: unknown }) => {
          const match = /^sticky_session:(\d+):enabled$/.exec(keyFromWhere(args?.where) ?? '');
          if (match && enabled[Number(match[1])]) return { value: 'true' };
          return undefined;
        },
      },
    },
  });

  const svc = (id: number, slug: string) => ({
    id,
    slug,
    port: 3000,
    runtimeId: `nd-svc-${slug}`,
    type: 'docker',
    serverId: null,
  });
  const dom = (id: number, serviceId: number, hostname: string) => ({
    id,
    serviceId,
    hostname,
    path: null,
    ssl: true,
    status: 'active',
  });

  const countStickyBlocks = (yaml: string, id: number) => (yaml.match(new RegExp(`^    mw_sticky_${id}:$`, 'gm')) ?? []).length;
  const countStickyRefs = (yaml: string, id: number) => (yaml.match(new RegExp(`^        - mw_sticky_${id}$`, 'gm')) ?? []).length;

  it('emits one middleware block for a multi-domain sticky service — no duplicate YAML keys', async () => {
    const db = stickyDb(
      [dom(1, 1, 'a.example.com'), dom(2, 1, 'b.example.com')],
      [svc(1, 'web')],
      { 1: true },
    );
    const yaml = await renderDynamicConfig(db as never, { serverId: null });
    expect(countStickyBlocks(yaml, 1)).toBe(1);
    // Every router still references the shared middleware.
    expect(countStickyRefs(yaml, 1)).toBe(2);
    // js-yaml (same duplicate-key rule as Traefik v3's go-yaml) must accept it.
    const doc = load(yaml) as { http: { middlewares: Record<string, unknown> } };
    expect(Object.keys(doc.http.middlewares ?? {})).toContain('mw_sticky_1');
  });

  it('keeps a single-domain sticky service unchanged', async () => {
    const db = stickyDb([dom(1, 1, 'a.example.com')], [svc(1, 'web')], { 1: true });
    const yaml = await renderDynamicConfig(db as never, { serverId: null });
    expect(countStickyBlocks(yaml, 1)).toBe(1);
    expect(countStickyRefs(yaml, 1)).toBe(1);
  });

  it('emits one block per sticky service when several services are sticky', async () => {
    const db = stickyDb(
      [dom(1, 1, 'a.example.com'), dom(2, 2, 'b.example.com')],
      [svc(1, 'web'), svc(2, 'api')],
      { 1: true, 2: true },
    );
    const yaml = await renderDynamicConfig(db as never, { serverId: null });
    expect(countStickyBlocks(yaml, 1)).toBe(1);
    expect(countStickyBlocks(yaml, 2)).toBe(1);
  });

  it('emits no sticky block when the flag is off', async () => {
    const db = stickyDb(
      [dom(1, 1, 'a.example.com'), dom(2, 1, 'b.example.com')],
      [svc(1, 'web')],
      { 1: false },
    );
    const yaml = await renderDynamicConfig(db as never, { serverId: null });
    expect(countStickyBlocks(yaml, 1)).toBe(0);
    expect(countStickyRefs(yaml, 1)).toBe(0);
  });
});

// ── r036 regression: the custom-response-headers middleware must render a
// Traefik-parseable block with the headers INSIDE customResponseHeaders. ────
// Two defects shipped together here:
//   1. The header entries were indented at the same level as
//      `customResponseHeaders:` itself, so YAML parsed customResponseHeaders
//      as null and exposed each header as an unknown sibling field of the
//      `headers` middleware — the feature was inert, and Traefik's strict
//      dynamic-config parser refuses unknown fields.
//   2. parseHeaders/parseBasicAuth left raw C0 control bytes (e.g. \x0B) in
//      the emitted YAML. go-yaml v3's READER rejects the whole document over
//      any non-printable rune ("control characters are not allowed"),
//      freezing the proxy's route table. js-yaml is lenient on that rule, so
//      the oracle below pairs load() with an explicit printable-rune scan
//      encoding go-yaml readerc.go's allowed set.
describe('domain headers middleware is Traefik-parseable (r036 regression)', () => {
  function firstUnprintable(s: string): string | null {
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      const printable =
        cp === 0x09 || cp === 0x0a || cp === 0x0d ||
        (cp >= 0x20 && cp <= 0x7e) || cp === 0x85 ||
        (cp >= 0xa0 && cp <= 0xd7ff) ||
        (cp >= 0xe000 && cp <= 0xfffd) ||
        (cp >= 0x10000 && cp <= 0x10ffff);
      if (!printable) return ch;
    }
    return null;
  }

  const baseDomain = {
    id: 1, serviceId: 1, hostname: 'app.example.com', path: '/', ssl: false, status: 'active',
  };
  const svcRow = { id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' };

  it('nests headers inside customResponseHeaders so the middleware parses', async () => {
    const db = makeDb(
      [{
        ...baseDomain,
        headers: JSON.stringify([{ name: 'X-Frame-Options', value: 'DENY' }]),
      }],
      [svcRow],
    );
    const yaml = await renderDynamicConfig(db as never, { serverId: null });
    expect(firstUnprintable(yaml)).toBeNull();
    const doc = load(yaml) as {
      http: { middlewares: Record<string, { headers?: { customResponseHeaders?: Record<string, string> } }> };
    };
    expect(doc.http.middlewares['mw_web_1_headers']?.headers?.customResponseHeaders)
      .toEqual({ 'X-Frame-Options': 'DENY' });
  });

  it('strips control characters from header values, keeping benign text', async () => {
    const db = makeDb(
      [{
        ...baseDomain,
        headers: JSON.stringify([{ name: 'X-Debug', value: 'ok\u000Bvalue' }]),
      }],
      [svcRow],
    );
    const yaml = await renderDynamicConfig(db as never, { serverId: null });
    // go-yaml v3 would refuse the whole file over the raw byte pre-fix.
    expect(firstUnprintable(yaml)).toBeNull();
    const doc = load(yaml) as {
      http: { middlewares: Record<string, { headers?: { customResponseHeaders?: Record<string, string> } }> };
    };
    expect(doc.http.middlewares['mw_web_1_headers']?.headers?.customResponseHeaders)
      .toEqual({ 'X-Debug': 'okvalue' });
  });

  it('strips control characters from basicAuth entries, keeping benign text', async () => {
    const db = makeDb(
      [{
        ...baseDomain,
        basicAuth: JSON.stringify(['alice:pw\u001Bhash']),
      }],
      [svcRow],
    );
    const yaml = await renderDynamicConfig(db as never, { serverId: null });
    expect(firstUnprintable(yaml)).toBeNull();
    const doc = load(yaml) as {
      http: { middlewares: Record<string, { basicAuth?: { users?: string[] } }> };
    };
    expect(doc.http.middlewares['mw_web_1_auth']?.basicAuth?.users).toContain('alice:pwhash');
  });
});

// ── r040 regression: escapeRegexp must escape EVERY regex metacharacter. ───
// HOST_RE deliberately preserves `*` in hostnames (wildcard support) and the
// createDomain schema only checks length, so a hostname with an INTERIOR `*`
// (own-zone member hostnames skip the DNS ownership proof; legacy/admin rows
// too) reaches escapeRegexp unescaped. In a Go regexp an unescaped `*`
// quantifies the preceding literal, silently BROADENING the HostRegexp match
// set: `*.foo*bar.example.com` rendered
// `^[a-zA-Z0-9-]+\.foo*bar\.example\.com$`, which also matches sibling
// hostnames (`<label>.fobar.example.com`) that were never claimed — routing
// other tenants' traffic into this service's container.
describe('wildcard HostRegexp escaping (r040 regression)', () => {
  it('escapes an interior asterisk so the rule matches only the claimed suffix', async () => {
    const db = makeDb(
      [{ id: 1, serviceId: 1, hostname: '*.foo*bar.example.com', path: '/', ssl: false, status: 'active' }],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1' }],
    );
    const yaml = await renderDynamicConfig(db as never, { serverId: null });
    // yamlDoubleQuoted doubles backslashes for the YAML text layer, so the
    // correctly escaped rule carries `foo\\*bar` in the raw file text.
    expect(yaml).toContain('foo\\\\*bar');
    expect(yaml).not.toContain('foo*bar');
  });
});
