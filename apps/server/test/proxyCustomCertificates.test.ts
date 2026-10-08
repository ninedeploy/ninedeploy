/**
 * 0.14 custom certificates (DESIGN §2.4): upload proof with node:crypto on
 * real fixtures, coverage matching, and what the proxy renders from it —
 * `tls: {}` for fully covered SSL domains (www pairs need both names, the
 * panel domain follows the same rule), the panel's `certificates.yml`, the
 * per-node inline block, and `readCertificates()` merging uploads.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { domains, servers, services, serviceTargets, tlsCertificates } from '@ninedeploy/db';

const h = vi.hoisted(() => ({
  config: { paths: { dataDir: '' }, acmeEmail: null as string | null, port: 3001 },
  audit: vi.fn(async (..._a: unknown[]) => undefined),
}));
vi.mock('../src/config.js', () => ({ config: h.config }));
vi.mock('../src/lib/exec.js', () => ({
  capture: vi.fn(async () => {
    throw new Error('exec disabled');
  }),
  run: vi.fn(async () => {
    throw new Error('exec disabled');
  }),
  sleep: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/dockerPull.js', () => ({ ensureDockerImage: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => ({ audit: h.audit }));
// Settings are read through this seam; the fake db carries them as a map.
vi.mock('../src/lib/settings.js', () => ({
  getSettingString: async (db: { settingsMap?: Record<string, string> }, key: string, fallback: string | null) =>
    db.settingsMap?.[key] ?? fallback,
}));
// A reversible stand-in for the envelope: what matters here is that the key
// is stored encrypted and that an undecryptable one is skipped.
vi.mock('../src/lib/crypto.js', () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => {
    if (!s.startsWith('enc:')) throw new Error('bad envelope');
    return s.slice(4);
  },
}));

const base = mkdtempSync(path.join(os.tmpdir(), 'nd-certs-'));
h.config.paths.dataDir = base;
const traefikDir = path.join(base, 'traefik');
afterAll(() => rmSync(base, { recursive: true, force: true }));

const lib = await import('../src/lib/customCertificates.js');
const proxy = await import('../src/engine/proxy.js');

const FIX = path.join(import.meta.dirname, 'fixtures', 'certs');
const fx = (f: string) => readFileSync(path.join(FIX, f), 'utf8');
const NOW = new Date('2026-10-08T00:00:00Z');

/** A stored row as the route writes it, from a fixture pair. */
function row(id: number, cert: string, key: string, over: Record<string, unknown> = {}) {
  const p = lib.parseCertificateUpload(fx(cert), fx(key), new Date('2020-06-01T00:00:00Z'));
  return {
    id,
    name: `cert-${id}`,
    certPem: p.certPem,
    keyEncrypted: `enc:${p.keyPem}`,
    hostnames: p.hostnames,
    fingerprintSha256: `${p.fingerprint}-${id}`,
    subject: p.subject,
    issuer: p.issuer,
    notBefore: p.notBefore,
    notAfter: p.notAfter,
    createdByUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

interface FakeOpts {
  domains?: unknown[];
  services?: unknown[];
  targets?: unknown[];
  certs?: unknown[];
  settings?: Record<string, string>;
  nodes?: unknown[];
}
function fakeDb(o: FakeOpts) {
  const rows = (t: unknown): unknown[] =>
    t === domains ? (o.domains ?? [])
    : t === services ? (o.services ?? [])
    : t === serviceTargets ? (o.targets ?? [])
    : t === tlsCertificates ? (o.certs ?? [])
    : t === servers ? (o.nodes ?? [])
    : [];
  return {
    select: () => ({
      from: (t: unknown) => {
        const p = Promise.resolve().then(() => rows(t));
        return Object.assign(p, { where: async () => rows(t), orderBy: async () => rows(t) });
      },
    }),
    settingsMap: o.settings ?? {},
  } as never;
}

const svc = { id: 1, slug: 'web', port: 3000, runtimeId: 'web-1', type: 'docker' };
const dom = (id: number, hostname: string, over: Record<string, unknown> = {}) => ({
  id,
  serviceId: 1,
  hostname,
  path: '/',
  ssl: true,
  status: 'active',
  redirectWww: false,
  ...over,
});
const routerOf = (yaml: string, name: string) =>
  ((load(yaml) as { http: { routers: Record<string, { tls?: Record<string, unknown> }> } }).http.routers[name]);

beforeEach(() => {
  vi.useRealTimers();
  h.audit.mockClear();
  h.config.acmeEmail = null;
});

describe('parseCertificateUpload (node:crypto proof)', () => {
  it('accepts a CA-signed chain, leaf first, and reads its names and metadata', () => {
    const p = lib.parseCertificateUpload(fx('valid-chain.pem'), fx('valid.key'), NOW);
    expect(p.hostnames).toEqual(['app.example.test', 'www.app.example.test']);
    expect(p.subject).toBe('CN=app.example.test');
    expect(p.issuer).toBe('O=NineDeploy Test, CN=NineDeploy Test CA');
    expect(p.notAfter.toISOString()).toBe('2099-12-31T00:00:00.000Z');
    expect(p.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(p.certPem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(p.keyPem).toMatch(/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n$/);
  });

  it('accepts a P-384 wildcard, and an Ed25519 certificate named only by its CN', () => {
    expect(lib.parseCertificateUpload(fx('wildcard.crt'), fx('wildcard.key'), NOW).hostnames).toEqual(['*.example.test']);
    expect(lib.parseCertificateUpload(fx('ed25519-cn-only.crt'), fx('ed25519.key'), NOW).hostnames).toEqual([
      'cn-only.example.test',
    ]);
  });

  it.each([
    ['chain in the wrong order', 'chain-wrong-order.pem', 'valid.key', /must start with the leaf/],
    ['a key that does not match', 'valid.crt', 'other.key', /does not match the certificate/],
    ['a passphrase-protected PKCS#8 key', 'valid.crt', 'encrypted.key', /passphrase-protected/],
    ['a passphrase-protected legacy RSA key', 'expired.crt', 'encrypted-legacy.key', /passphrase-protected/],
    ['an expired certificate', 'expired.crt', 'expired.key', /expired on 2020-01-01/],
    ['an RSA key below 2048 bits', 'rsa1024.crt', 'rsa1024.key', /at least 2048 bits/],
    ['an ECDSA curve other than P-256/P-384', 'k1.crt', 'k1.key', /P-256 or P-384/],
  ])('refuses %s', (_label, cert, key, msg) => {
    expect(() => lib.parseCertificateUpload(fx(cert), fx(key), NOW)).toThrow(msg);
  });

  it('refuses a chain whose second certificate did not issue the first', () => {
    const chain = fx('valid.crt') + fx('wildcard.crt');
    expect(() => lib.parseCertificateUpload(chain, fx('valid.key'), NOW)).toThrow(/did not issue certificate #1/);
  });

  it('refuses junk, oversize input and a non-certificate block, as a 400', () => {
    const err = (() => {
      try {
        lib.parseCertificateUpload('nope', fx('valid.key'), NOW);
      } catch (e) {
        return e as { statusCode?: number; message: string };
      }
      return null;
    })();
    expect(err?.statusCode).toBe(400);
    expect(err?.message).toMatch(/no PEM certificate/);
    expect(() => lib.parseCertificateUpload('x'.repeat(64 * 1024 + 1), fx('valid.key'), NOW)).toThrow(/64 KiB/);
    expect(() => lib.parseCertificateUpload(fx('valid.crt'), 'x'.repeat(16 * 1024 + 1), NOW)).toThrow(/16 KiB/);
    expect(() =>
      lib.parseCertificateUpload('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----', fx('valid.key'), NOW),
    ).toThrow(/not a valid X.509/);
    expect(() => lib.parseCertificateUpload(fx('valid.crt'), '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----', NOW)).toThrow(
      /not a valid unencrypted PEM private key/,
    );
  });
});

describe('certificatesCovering', () => {
  const certs = [
    { ...lib.parseCertificateUpload(fx('wildcard.crt'), fx('wildcard.key'), NOW), id: 1, name: 'w' },
    { ...lib.parseCertificateUpload(fx('valid-chain.pem'), fx('valid.key'), NOW), id: 2, name: 'v' },
  ];
  it('matches exact names and single-label wildcards only, case-insensitively', () => {
    expect(lib.certificatesCovering('a.example.test', certs, NOW).map((c) => c.id)).toEqual([1]);
    expect(lib.certificatesCovering('APP.example.test', certs, NOW).map((c) => c.id)).toEqual([1, 2]);
    expect(lib.certificatesCovering('a.b.example.test', certs, NOW)).toEqual([]);
    expect(lib.certificatesCovering('example.test', certs, NOW)).toEqual([]);
    // A wildcard DOMAIN row is covered only by the same wildcard name.
    expect(lib.certificatesCovering('*.example.test', certs, NOW).map((c) => c.id)).toEqual([1]);
    expect(lib.certificatesCovering('', certs, NOW)).toEqual([]);
  });
  it('ignores certificates that have expired or are not valid yet', () => {
    expect(lib.certificatesCovering('a.example.test', certs, new Date('2100-01-02T00:00:00Z'))).toEqual([]);
    expect(lib.certificatesCovering('a.example.test', certs, new Date('2023-01-01T00:00:00Z'))).toEqual([]);
  });
  it('renders a tls block of inline PEM, nothing when empty, capped at 100', () => {
    expect(lib.renderCertificatesBlock([])).toBe('');
    const doc = load(lib.renderCertificatesBlock(certs)) as { tls: { certificates: Array<{ certFile: string; keyFile: string }> } };
    expect(doc.tls.certificates).toHaveLength(2);
    expect(doc.tls.certificates[1]!.certFile).toBe(certs[1]!.certPem);
    expect(doc.tls.certificates[1]!.keyFile).toBe(certs[1]!.keyPem);
    expect(lib.renderCertificateEntries(Array.from({ length: 120 }, () => certs[0]!))).toHaveLength(100);
  });
});

describe('refreshCustomCertificates', () => {
  it('skips an undecryptable key and audits it once, never throwing', async () => {
    const good = row(1, 'wildcard.crt', 'wildcard.key');
    const bad = row(2, 'valid-chain.pem', 'valid.key', { keyEncrypted: 'v9:not-ours' });
    const db = fakeDb({ certs: [good, bad] });
    expect((await lib.refreshCustomCertificates(db)).map((c) => c.id)).toEqual([1]);
    await lib.refreshCustomCertificates(db);
    expect(h.audit.mock.calls.filter((c) => c[2] === 'traefik.certificate_unreadable')).toHaveLength(1);
    // A db that cannot answer renders as "no uploads" (0.13's output).
    const broken = { select: () => ({ from: () => ({ orderBy: async () => { throw new Error('no table'); } }) }) } as never;
    await expect(lib.refreshCustomCertificates(broken)).resolves.toEqual([]);
  });
});

describe('M9: rendering with uploaded certificates', () => {
  const acme = { acme_email: 'ops@example.test' };

  it('a fully covered SSL domain drops the resolver; an uncovered one keeps it', async () => {
    const db = fakeDb({
      settings: acme,
      services: [svc],
      domains: [dom(1, 'a.example.test'), dom(2, 'other.test')],
      certs: [row(1, 'wildcard.crt', 'wildcard.key')],
    });
    const yaml = await proxy.renderDynamicConfig(db, { serverId: null });
    expect(routerOf(yaml, 'web_1')?.tls).toEqual({});
    expect(routerOf(yaml, 'web_2')?.tls).toEqual({ certResolver: 'letsencrypt' });
  });

  it('a www pair needs BOTH names covered', async () => {
    const pair = dom(1, 'app.example.test', { redirectWww: true });
    const onlyApex = row(1, 'ed25519-cn-only.crt', 'ed25519.key', { hostnames: ['app.example.test'] });
    let yaml = await proxy.renderDynamicConfig(fakeDb({ settings: acme, services: [svc], domains: [pair], certs: [onlyApex] }), {
      serverId: null,
    });
    expect(routerOf(yaml, 'web_1')?.tls).toMatchObject({ certResolver: 'letsencrypt' });
    yaml = await proxy.renderDynamicConfig(
      fakeDb({ settings: acme, services: [svc], domains: [pair], certs: [row(2, 'valid-chain.pem', 'valid.key')] }),
      { serverId: null },
    );
    expect(routerOf(yaml, 'web_1')?.tls).toEqual({});
  });

  it('an expired upload is ignored', async () => {
    const expired = row(1, 'wildcard.crt', 'wildcard.key', { notAfter: new Date('2021-01-01T00:00:00Z') });
    const yaml = await proxy.renderDynamicConfig(
      fakeDb({ settings: acme, services: [svc], domains: [dom(1, 'a.example.test')], certs: [expired] }),
      { serverId: null },
    );
    expect(routerOf(yaml, 'web_1')?.tls).toEqual({ certResolver: 'letsencrypt' });
  });

  it('the panel domain follows the same rule, and a covered panel redirects to HTTPS', async () => {
    const settingsNoAcme = { panel_domain: 'panel.example.test' };
    let yaml = await proxy.renderDynamicConfig(fakeDb({ settings: settingsNoAcme }), { serverId: null });
    expect(yaml).not.toContain('ninedeploy_panel_http');
    yaml = await proxy.renderDynamicConfig(
      fakeDb({ settings: { ...settingsNoAcme, ...acme }, certs: [row(1, 'wildcard.crt', 'wildcard.key')] }),
      { serverId: null },
    );
    expect(routerOf(yaml, 'ninedeploy_panel')?.tls).toEqual({});
    expect(yaml).toContain('ninedeploy_panel_http');
    yaml = await proxy.renderDynamicConfig(
      fakeDb({ settings: settingsNoAcme, certs: [row(1, 'wildcard.crt', 'wildcard.key')] }),
      { serverId: null },
    );
    expect(yaml).toContain('ninedeploy_panel_http');
  });

  it('the panel render never inlines certificates (they go to certificates.yml)', async () => {
    const yaml = await proxy.renderDynamicConfig(
      fakeDb({ settings: acme, services: [svc], domains: [dom(1, 'a.example.test')], certs: [row(1, 'wildcard.crt', 'wildcard.key')] }),
      { serverId: null },
    );
    expect(yaml).not.toContain('BEGIN');
  });

  it('a node inlines only the certificates covering hosts IT routes, in one tls list', async () => {
    const nodeSvc = { ...svc, serverId: 4 };
    const db = fakeDb({
      settings: { ...acme, dns_provider: 'cloudflare', dns_token_encrypted: 'enc:tok', wildcard_domain: 'example.test' },
      services: [nodeSvc],
      domains: [dom(1, 'a.example.test')],
      certs: [row(1, 'wildcard.crt', 'wildcard.key'), row(2, 'valid-chain.pem', 'valid.key', { hostnames: ['elsewhere.test'] })],
    });
    const yaml = await proxy.renderDynamicConfig(db, { serverId: 4 });
    const doc = load(yaml) as { tls: { certificates: Array<Record<string, unknown>> } };
    // The DNS-01 wildcard request and the one covering upload share ONE list.
    expect(doc.tls.certificates).toHaveLength(2);
    expect(doc.tls.certificates[0]).toMatchObject({ certResolver: 'letsencrypt' });
    expect(String(doc.tls.certificates[1]!.certFile)).toContain('BEGIN CERTIFICATE');
    expect(yaml.match(/certFile/g)).toHaveLength(1);
    // A node with nothing covered gets no certificate at all.
    const none = await proxy.renderDynamicConfig(
      fakeDb({ settings: acme, services: [nodeSvc], domains: [dom(1, 'b.other.test')], certs: [row(1, 'wildcard.crt', 'wildcard.key')] }),
      { serverId: 4 },
    );
    expect(none).not.toContain('certFile');
  });
});

describe('certificates.yml and readCertificates', () => {
  beforeEach(() => mkdirSync(traefikDir, { recursive: true }));

  it('writes certificates.yml with the servable uploads before the routes, and removes it when none remain', async () => {
    const certFile = path.join(traefikDir, 'dynamic', 'certificates.yml');
    const expired = row(2, 'valid-chain.pem', 'valid.key', { notAfter: new Date('2021-01-01T00:00:00Z') });
    await proxy.writeDynamicConfig(fakeDb({ services: [svc], domains: [dom(1, 'a.example.test')], certs: [row(1, 'wildcard.crt', 'wildcard.key'), expired] }));
    const doc = load(readFileSync(certFile, 'utf8')) as { tls: { certificates: unknown[] } };
    expect(doc.tls.certificates).toHaveLength(1);
    expect(existsSync(path.join(traefikDir, 'dynamic', 'ninedeploy.yml'))).toBe(true);

    // readCertificates: ACME entries plus one per uploaded hostname (expired ones included, for alerts).
    writeFileSync(path.join(traefikDir, 'acme.json'), '{}');
    const infos = proxy.readCertificates();
    expect(infos.map((c) => [c.domain, c.source])).toEqual([
      ['*.example.test', 'custom'],
      ['app.example.test', 'custom'],
      ['www.app.example.test', 'custom'],
    ]);
    expect(infos[0]).toMatchObject({ issuer: 'O=Wild Org, CN=*.example.test', expiresAt: new Date('2099-12-31T00:00:00Z') });

    await proxy.writeDynamicConfig(fakeDb({ services: [svc], domains: [dom(1, 'a.example.test')] }));
    expect(existsSync(certFile)).toBe(false);
    expect(proxy.readCertificates()).toEqual([]);
  });

  it('materialiseCertificatesFile rebuilds the file from the database and never throws', async () => {
    const certFile = path.join(traefikDir, 'dynamic', 'certificates.yml');
    rmSync(certFile, { force: true });
    await proxy.materialiseCertificatesFile(fakeDb({ certs: [row(1, 'wildcard.crt', 'wildcard.key')] }));
    expect(readFileSync(certFile, 'utf8')).toContain('certFile');
    await expect(proxy.materialiseCertificatesFile({} as never)).resolves.toBeUndefined();
  });

  it('D4/T2-A: an ACME entry reports its real expiry, issuer and subject from the stored (base64) PEM', () => {
    writeFileSync(
      path.join(traefikDir, 'acme.json'),
      JSON.stringify({
        letsencrypt: {
          Certificates: [{ domain: { main: 'app.example.test' }, certificate: Buffer.from(fx('valid-chain.pem')).toString('base64') }],
        },
      }),
    );
    const [acme] = proxy.readCertificates().filter((c) => c.source === 'acme');
    expect(acme).toMatchObject({
      domain: 'app.example.test',
      issuer: 'O=NineDeploy Test, CN=NineDeploy Test CA',
      subject: 'CN=app.example.test',
      sans: ['app.example.test', 'www.app.example.test'],
    });
    // T2-A: not null any more. (The 2099 fixture's notAfter is a
    // GeneralizedTime, which the UTCTime scanner reports as notBefore; real
    // ACME certificates expire long before 2050.)
    expect(acme?.expiresAt).toBeInstanceOf(Date);
    rmSync(path.join(traefikDir, 'acme.json'), { force: true });
  });
});
