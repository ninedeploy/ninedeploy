/**
 * 0.14 proxy management (DESIGN §2.3, §2.5): the custom dynamic config
 * validator (every rule 1–8), the preflight / post-write revert with Docker
 * stubbed, the eight operator-only routes against a real migrated SQLite,
 * and the wiring (M1 route registration, M12 boot re-materialisation).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, domains, projects, services, settings, users, workspaces } from '@ninedeploy/db';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'nd-traefik-custom-'));
vi.stubEnv('NINEDEPLOY_DATA_DIR', scratch);
vi.stubEnv('DOCKER_HOST', 'tcp://127.0.0.1:9');
vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'ab'.repeat(32));

const h = vi.hoisted(() => ({
  capture: vi.fn(async (..._a: unknown[]): Promise<string> => ''),
  run: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
  sleep: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
  audit: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
}));
vi.mock('../src/lib/exec.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/exec.js')>()),
  capture: h.capture,
  run: h.run,
  sleep: h.sleep,
}));
vi.mock('../src/lib/hostPath.js', () => ({ hostPathFor: vi.fn(async (p: string) => p) }));
vi.mock('../src/lib/audit.js', () => ({ audit: h.audit }));

const tcc = await import('../src/lib/traefikCustomConfig.js');
const { traefikCustomRoutes } = await import('../src/modules/traefikCustom.js');
const proxy = await import('../src/engine/proxy.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const CERTS = path.join(import.meta.dirname, 'fixtures', 'certs');
const fx = (f: string) => readFileSync(path.join(CERTS, f), 'utf8');
const customFile = () => proxy.customConfigPath();

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

const ctx = { acmeEmailSet: true };
const errorsOf = (yaml: string, c = ctx) => tcc.validateCustomConfig(yaml, c).errors.map((e) => `${e.path}: ${e.message}`);
const GOOD = `http:
  middlewares:
    custom-hello:
      headers:
        customResponseHeaders:
          X-Hello: "world"
  routers:
    custom-site:
      rule: "Host(\`legacy.example.com\`)"
      entryPoints: [websecure]
      service: svc_web_1
      middlewares: [custom-hello, mw_web_1_auth]
      priority: 500
      tls:
        certResolver: letsencrypt
`;

describe('validateCustomConfig — rules 1–8', () => {
  it('accepts a valid config and warns about references to generated names', () => {
    const v = tcc.validateCustomConfig(GOOD, ctx);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.path)).toEqual([
      'http.routers.custom-site.service',
      'http.routers.custom-site.middlewares[1]',
    ]);
  });

  it('rule 1: empty, NUL, invalid UTF-8 and oversize content', () => {
    expect(errorsOf('   ')).toEqual([': the config is empty']);
    expect(errorsOf('http: {}\u0000')).toEqual([': the config contains a NUL character']);
    expect(errorsOf('http: "\uD800"')).toEqual([': the config is not valid UTF-8']);
    expect(errorsOf(`# ${'x'.repeat(256 * 1024)}`)).toEqual([': the config is larger than 256 KiB']);
  });

  it('rule 2: YAML errors, non-mappings, aliases and the node cap', () => {
    expect(errorsOf('http: [')[0]).toMatch(/^: not valid YAML/);
    expect(errorsOf('# only a comment\n')).toEqual([': the config is empty']);
    expect(errorsOf('- a\n- b\n')[0]).toMatch(/must be a mapping/);
    expect(errorsOf('http:\n  routers:\n    custom-a: &r {rule: "Host(`a`)"}\n    custom-b: *r\n')).toContain(
      'http.routers.custom-b: YAML aliases (`*name`) are not allowed',
    );
    // CORE_SCHEMA: no custom tags.
    expect(errorsOf('http: !!binary aGVsbG8=')[0]).toMatch(/not valid YAML/);
    // Within 256 KiB: a flow sequence of 50 001 one-character items.
    const big = `http:\n  routers:\n    custom-big:\n      middlewares: [${Array.from({ length: 50_001 }, () => 'a').join(',')}]\n`;
    expect(errorsOf(big).some((e) => e.includes('more than 50000 nodes'))).toBe(true);
  });

  it('rule 3: only http, tcp and tls.options at the top', () => {
    expect(errorsOf('udp:\n  routers: {}\n')).toEqual(['udp: `udp` is not supported in a custom config']);
    expect(errorsOf('tls:\n  stores:\n    default: {}\n')[0]).toMatch(/^tls.stores: `tls.stores` is not allowed/);
    expect(errorsOf('tls:\n  certificates: []\n')[0]).toMatch(/^tls.certificates:/);
    expect(errorsOf('tls: []\n')).toEqual(['tls: `tls` must be a mapping']);
    expect(errorsOf('providers: {}\n')[0]).toMatch(/^providers: `providers` is not allowed/);
    expect(errorsOf('tls:\n  options:\n    custom-modern:\n      minVersion: VersionTLS13\n')).toEqual([]);
    // `tls.options.default` would change TLS for every generated router.
    expect(errorsOf('tls:\n  options:\n    default: {}\n')[0]).toMatch(/^tls.options.default:/);
  });

  it('rule 4: only the listed sections', () => {
    expect(errorsOf('http:\n  serversTransports:\n    custom-t: {}\n')).toEqual([]);
    expect(errorsOf('tcp:\n  serversTransports:\n    custom-t: {}\n')[0]).toMatch(/^tcp.serversTransports: `tcp.serversTransports` is not allowed/);
    expect(errorsOf('http: 3\n')).toEqual(['http: `http` must be a mapping']);
    expect(errorsOf('http:\n  routers: []\n')[0]).toMatch(/must be a mapping of names/);
  });

  it('rule 5: every defined name is custom- or custom_ prefixed, so it can never collide', () => {
    for (const name of ['svc_x', 'web_1', 'mw_https_redirect', 'ninedeploy_panel', 'custom-', 'custom', 'Custom-a', `custom-${'a'.repeat(101)}`]) {
      expect(errorsOf(`http:\n  services:\n    ${name}: {}\n`), name).toHaveLength(1);
    }
    expect(errorsOf('http:\n  services:\n    custom_a-B_9: {}\n')).toEqual([]);
  });

  it('rule 6: entry points, priority and the certificate resolver', () => {
    const r = (body: string, kind = 'http') => `${kind}:\n  routers:\n    custom-r:\n${body}`;
    expect(errorsOf(r('      entryPoints: [traefik]\n'))[0]).toMatch(/entryPoints must be within `web`, `websecure`/);
    expect(errorsOf(r('      entryPoints: websecure\n'))[0]).toMatch(/entryPoints must be within/);
    expect(errorsOf(r('      entryPoints: [web]\n', 'tcp'))[0]).toMatch(/entryPoints must be within `websecure`/);
    expect(errorsOf(r('      rule: "HostSNI(`*`)"\n', 'tcp'))[0]).toMatch(/must list `entryPoints: \[websecure\]`/);
    expect(errorsOf(r('      entryPoints: [websecure]\n', 'tcp'))).toEqual([]);
    expect(errorsOf(r('      priority: 100000\n'))[0]).toMatch(/priority must be a number below 100000/);
    expect(errorsOf(r('      priority: "1"\n'))[0]).toMatch(/priority must be a number/);
    expect(errorsOf(r('      priority: 99999\n'))).toEqual([]);
    expect(errorsOf(r('      tls:\n        certResolver: other\n'))[0]).toMatch(/only certificate resolver is `letsencrypt`/);
    expect(errorsOf(r('      tls:\n        certResolver: letsencrypt\n'), { acmeEmailSet: false })[0]).toMatch(/needs an ACME email/);
    expect(errorsOf(r('      tls: true\n'))[0]).toMatch(/`tls` must be a mapping/);
    expect(errorsOf(r('      tls:\n'))).toEqual([]);
    expect(errorsOf('http:\n  routers:\n    custom-r: 1\n')[0]).toMatch(/a router must be a mapping/);
    // Traefik ignores key case, so the rule does too.
    expect(errorsOf(r('      EntryPoints: [traefik]\n'))[0]).toMatch(/entryPoints must be within/);
  });

  it('rule 7: plugin, file paths and CA material are refused anywhere; so are merge keys and case-twins', () => {
    const mw = (body: string) => `http:\n  middlewares:\n    custom-m:\n${body}`;
    expect(errorsOf(mw('      plugin:\n        evil: {}\n'))[0]).toMatch(/`plugin` is not allowed/);
    expect(errorsOf('http:\n  serversTransports:\n    custom-t:\n      rootCAs: [/etc/ssl/x]\n')[0]).toMatch(/`rootCAs` is not allowed/);
    expect(errorsOf('http:\n  serversTransports:\n    custom-t:\n      certificates:\n        - certFile: /x\n          keyFile: /y\n')).toHaveLength(2);
    expect(errorsOf('tcp:\n  serversTransports: {}\n').length).toBeGreaterThan(0);
    expect(errorsOf(mw('      CA: x\n'))[0]).toMatch(/`CA` is not allowed/);
    expect(errorsOf('http:\n  routers:\n    custom-r:\n      <<: {entryPoints: [traefik]}\n')[0]).toMatch(/`<<` is not allowed/);
    expect(errorsOf('http:\n  routers:\n    custom-r:\n      entryPoints: [web]\n      entrypoints: [websecure]\n')[0]).toMatch(/defined twice/);
  });

  it('chain middlewares and tls options referencing generated names warn', () => {
    const v = tcc.validateCustomConfig(
      'http:\n  middlewares:\n    custom-c:\n      chain:\n        middlewares: [mw_x, custom-y@file, api@internal]\n  routers:\n    custom-r:\n      tls:\n        options: foo\n',
      ctx,
    );
    expect(v.errors).toEqual([]);
    expect(v.warnings.map((w) => w.path)).toEqual(['http.middlewares.custom-c.chain.middlewares[0]', 'http.routers.custom-r.tls.options']);
  });

  it('classifies Traefik log lines into file-provider errors and router-level errors', () => {
    const logs = [
      '2026-10-08T10:00:00Z INF Starting provider *file.Provider',
      '2026-10-08T10:00:01Z ERR Error while building configuration (for the first time) error="field not found, node: bogus" providerName=file',
      '2026-10-08T10:00:01Z ERR error="middleware \\"mw_x@file\\" does not exist" entryPointName=websecure routerName=custom-r@file',
      '',
    ].join('\n');
    const c = tcc.classifyTraefikLog(logs);
    expect(c.fileErrors).toHaveLength(1);
    expect(c.otherErrors).toHaveLength(1);
  });
});

// ── apply / revert / routes against a real migrated SQLite ─────────────────

let db: DB;
let close: () => void;

beforeEach(async () => {
  h.capture.mockReset();
  h.run.mockReset();
  h.run.mockResolvedValue(undefined);
  h.sleep.mockClear();
  h.audit.mockClear();
  const created = createDb({ url: ':memory:' });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true });
  rmSync(path.join(scratch, 'traefik'), { recursive: true, force: true });
  mkdirSync(proxy.traefikDynamicDir(), { recursive: true });
  writeFileSync(proxy.generatedConfigPath(), '# generated\nhttp:\n  routers:\n  services:\n');
});
afterEach(() => close());

/**
 * Docker for the apply path: the preflight container's log, then the live
 * Traefik's log since the write.
 */
function dockerLogs(opts: { preflight?: string; live?: string; runFails?: boolean }) {
  h.capture.mockImplementation(async (_cmd: unknown, a: unknown) => {
    const args = a as string[];
    if (args[0] === 'run') {
      if (opts.runFails) throw new Error('Cannot connect to the Docker daemon');
      return 'container-id\n';
    }
    if (args[0] === 'logs' && args[1] === '--since') return opts.live ?? '';
    if (args[0] === 'logs') return opts.preflight ?? '';
    return '';
  });
}

async function app() {
  const a = await buildTestApp({ db });
  await a.register(traefikCustomRoutes, { prefix: '/traefik' });
  return a;
}
const OP = asUser({ id: 1, isOperator: true });
const MEMBER = asUser({ id: 2, isOperator: false, role: 'member' });

describe('custom config: preflight, write, post-write check', () => {
  it('PUT applies a valid config after the preflight, stores it as last good and audits the save', async () => {
    dockerLogs({});
    await db.insert(settings).values({ key: 'acme_email', value: 'ops@example.com' });
    const a = await app();
    const res = await a.inject({ method: 'PUT', url: '/traefik/custom-config', headers: OP, payload: { content: GOOD } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, status: 'applied' });
    expect(res.json().warnings).toHaveLength(2);

    // The preflight: a throwaway container, no network, read-only, no host ports.
    const runArgv = h.capture.mock.calls.map((c) => c[1] as string[]).find((x) => x[0] === 'run')!;
    expect(runArgv).toEqual(expect.arrayContaining(['--network', 'none', '--read-only']));
    expect(runArgv).not.toContain('-p');
    expect(runArgv.at(-1)).toBe(proxy.TRAEFIK_IMAGE);
    expect(h.run).toHaveBeenCalledWith('docker', ['rm', '-f', runArgv[3]], {}, expect.any(Function));
    expect(existsSync(path.join(scratch, 'traefik-preflight'))).toBe(true);
    expect(rmSyncLeft()).toEqual([]);

    expect(readFileSync(customFile(), 'utf8')).toBe(GOOD);
    const state = await a.inject({ method: 'GET', url: '/traefik/custom-config', headers: OP });
    expect(state.json()).toMatchObject({ content: GOOD, status: 'applied', lastError: null, updatedBy: 1 });
    expect(state.json().sha256).toMatch(/^[0-9a-f]{64}$/);
    // Stored encrypted: no plaintext YAML in the settings table.
    const raw = await db.select().from(settings);
    expect(JSON.stringify(raw)).not.toContain('custom-hello');
    expect(raw.map((r) => r.key).sort()).toEqual(
      ['acme_email', tcc.CUSTOM_CONFIG_KEY, tcc.CUSTOM_CONFIG_LAST_GOOD_KEY, tcc.CUSTOM_CONFIG_STATUS_KEY].sort(),
    );
    expect(h.audit).toHaveBeenCalledWith(db, 1, 'traefik.custom_config.save', 'custom.yml', expect.objectContaining({ sha256: state.json().sha256 }));
  });

  it('PUT 400s an invalid config with [{path, message}] and writes nothing', async () => {
    const a = await app();
    const res = await a.inject({ method: 'PUT', url: '/traefik/custom-config', headers: OP, payload: { content: 'http:\n  services:\n    svc_x: {}\n' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors).toEqual([{ path: 'http.services.svc_x', message: expect.stringMatching(/must start with `custom-`/) }]);
    expect(h.capture).not.toHaveBeenCalled();
    expect(existsSync(customFile())).toBe(false);
  });

  it('PUT 422s when the preflight Traefik refuses the file, and writes nothing', async () => {
    dockerLogs({ preflight: 'ERR Error while building configuration error="field not found" providerName=file\n' });
    const res = await (await app()).inject({ method: 'PUT', url: '/traefik/custom-config', headers: OP, payload: { content: 'http:\n  services:\n    custom-a: {}\n' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('custom_config_refused');
    expect(existsSync(customFile())).toBe(false);
    expect(await db.select().from(settings)).toEqual([]);
  });

  it('PUT 503s when Docker is unavailable, and does not save', async () => {
    dockerLogs({ runFails: true });
    const res = await (await app()).inject({ method: 'PUT', url: '/traefik/custom-config', headers: OP, payload: { content: 'http:\n  services:\n    custom-a: {}\n' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toBe('Traefik validation unavailable; not applied');
    expect(existsSync(customFile())).toBe(false);
    expect(await db.select().from(settings)).toEqual([]);
  });

  it('a post-write file error reverts to the last good version, keeps the attempt for editing and audits the rejection', async () => {
    const a = await app();
    const first = 'http:\n  services:\n    custom-a: {}\n';
    dockerLogs({});
    expect((await a.inject({ method: 'PUT', url: '/traefik/custom-config', headers: OP, payload: { content: first } })).statusCode).toBe(200);

    const second = 'http:\n  services:\n    custom-b: {}\n';
    dockerLogs({ live: 'ERR error="cannot decode configuration" providerName=file filename=/etc/traefik/dynamic/custom.yml\n' });
    const res = await a.inject({ method: 'PUT', url: '/traefik/custom-config', headers: OP, payload: { content: second } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/last good version was restored/);
    expect(readFileSync(customFile(), 'utf8')).toBe(first);
    const state = (await a.inject({ method: 'GET', url: '/traefik/custom-config', headers: OP })).json();
    expect(state).toMatchObject({ content: second, status: 'rejected' });
    expect(state.lastError).toMatch(/cannot decode/);
    expect(h.audit).toHaveBeenCalledWith(db, 1, 'traefik.custom_config.rejected', 'custom.yml', expect.objectContaining({ reverted: 'last_good' }));

    // Boot re-materialises the LAST GOOD version, not the rejected attempt.
    rmSync(customFile());
    await tcc.materialiseCustomConfig(db);
    expect(readFileSync(customFile(), 'utf8')).toBe(first);
  });

  it('a post-write rejection with no last good version removes the file', async () => {
    dockerLogs({ live: 'ERR something providerName=file\n' });
    const res = await (await app()).inject({ method: 'PUT', url: '/traefik/custom-config', headers: OP, payload: { content: 'http:\n  services:\n    custom-a: {}\n' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/it was removed/);
    expect(existsSync(customFile())).toBe(false);
  });

  it('the template escape (F520) is applied to what Traefik reads', async () => {
    dockerLogs({});
    const content = 'http:\n  middlewares:\n    custom-h:\n      headers:\n        customResponseHeaders:\n          X: "{{ env `CF_DNS_API_TOKEN` }}"\n';
    expect((await (await app()).inject({ method: 'PUT', url: '/traefik/custom-config', headers: OP, payload: { content } })).statusCode).toBe(200);
    expect(readFileSync(customFile(), 'utf8')).toContain('{{`{{`}} env');
  });

  it('POST validate reports without touching anything; DELETE clears every version', async () => {
    const a = await app();
    const v = await a.inject({ method: 'POST', url: '/traefik/custom-config/validate', headers: OP, payload: { content: GOOD } });
    expect(v.statusCode).toBe(200);
    // No ACME email stored → the resolver is refused.
    expect(v.json().ok).toBe(false);
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();

    dockerLogs({});
    await a.inject({ method: 'PUT', url: '/traefik/custom-config', headers: OP, payload: { content: 'http:\n  services:\n    custom-a: {}\n' } });
    const del = await a.inject({ method: 'DELETE', url: '/traefik/custom-config', headers: OP });
    expect(del.json()).toEqual({ ok: true, cleared: true });
    expect(existsSync(customFile())).toBe(false);
    expect(await db.select().from(settings)).toEqual([]);
    expect((await a.inject({ method: 'GET', url: '/traefik/custom-config', headers: OP })).json()).toMatchObject({ content: null, status: 'none' });
    expect(h.audit).toHaveBeenCalledWith(db, 1, 'traefik.custom_config.clear', 'custom.yml', expect.objectContaining({ existed: true }));
  });

  it('boot removes a custom.yml no stored version backs', async () => {
    writeFileSync(customFile(), 'stale');
    await tcc.materialiseCustomConfig(db);
    expect(existsSync(customFile())).toBe(false);
  });
});

/** Preflight scratch directories left behind (each run removes its own). */
function rmSyncLeft(): string[] {
  const d = path.join(scratch, 'traefik-preflight');
  return existsSync(d) ? readdirSync(d) : [];
}

describe('custom certificates routes', () => {
  async function seedDomain(hostname: string) {
    const [ws] = await db.insert(workspaces).values({ name: 'W', slug: `w-${hostname}`, ownerId: 1 }).returning();
    const [p] = await db.insert(projects).values({ name: 'P', slug: `p-${hostname}`, workspaceId: ws!.id }).returning();
    const [s] = await db
      .insert(services)
      .values({ name: 'web', slug: `web${hostname.length}`, projectId: p!.id, type: 'docker', port: 3000, runtimeId: 'web-1' } as never)
      .returning();
    await db.insert(domains).values({ serviceId: s!.id, hostname, ssl: true, status: 'active' } as never);
    return s!.id;
  }

  it('upload (201) → list with covered domains → replace → delete, re-rendering and auditing each step', async () => {
    await db.insert(settings).values({ key: 'acme_email', value: 'ops@example.com' });
    const serviceId = await seedDomain('a.example.test');
    const a = await app();

    const up = await a.inject({
      method: 'POST',
      url: '/traefik/certificates/custom',
      headers: OP,
      payload: { name: 'wild', certPem: fx('wildcard.crt'), keyPem: fx('wildcard.key') },
    });
    expect(up.statusCode, up.body).toBe(201);
    const body = up.json();
    expect(body).toMatchObject({ name: 'wild', hostnames: ['*.example.test'], expired: false, warnings: [] });
    expect(body.coveredDomains).toEqual([{ id: expect.any(Number), hostname: 'a.example.test', serviceId }]);
    expect(JSON.stringify(body)).not.toContain('PRIVATE KEY');
    // The panel's certificates file and the route switch to `tls: {}`.
    expect(readFileSync(proxy.certificatesConfigPath(), 'utf8')).toContain('certFile');
    expect(readFileSync(proxy.generatedConfigPath(), 'utf8')).toMatch(/Host\(`a\.example\.test`\)"[\s\S]*?tls: \{\}/);
    expect(h.audit).toHaveBeenCalledWith(db, 1, 'traefik.certificate.upload', 'wild', expect.objectContaining({ hostnames: ['*.example.test'] }));
    const auditMeta = JSON.stringify(h.audit.mock.calls.map((c) => c.slice(2)));
    expect(auditMeta).not.toContain('BEGIN');

    // The key is stored encrypted.
    const stored = await db.query.tlsCertificates.findFirst();
    expect(stored!.keyEncrypted).not.toContain('PRIVATE KEY');

    const dup = await a.inject({
      method: 'POST',
      url: '/traefik/certificates/custom',
      headers: OP,
      payload: { name: 'again', certPem: fx('wildcard.crt'), keyPem: fx('wildcard.key') },
    });
    expect(dup.statusCode).toBe(409);

    const list = await a.inject({ method: 'GET', url: '/traefik/certificates/custom', headers: OP });
    expect(list.json()).toHaveLength(1);

    const rep = await a.inject({
      method: 'PUT',
      url: `/traefik/certificates/custom/${body.id}`,
      headers: OP,
      payload: { certPem: fx('valid-chain.pem'), keyPem: fx('valid.key') },
    });
    expect(rep.statusCode, rep.body).toBe(200);
    expect(rep.json()).toMatchObject({ name: 'wild', hostnames: ['app.example.test', 'www.app.example.test'], coveredDomains: [] });
    expect(readFileSync(proxy.generatedConfigPath(), 'utf8')).toContain('certResolver: letsencrypt');
    expect(h.audit).toHaveBeenCalledWith(db, 1, 'traefik.certificate.replace', 'wild', expect.objectContaining({ certificateId: body.id }));

    expect((await a.inject({ method: 'DELETE', url: `/traefik/certificates/custom/${body.id}`, headers: OP })).json()).toEqual({ ok: true });
    expect(existsSync(proxy.certificatesConfigPath())).toBe(false);
    expect(h.audit).toHaveBeenCalledWith(db, 1, 'traefik.certificate.delete', 'wild', expect.objectContaining({ certificateId: body.id }));
    expect((await a.inject({ method: 'DELETE', url: `/traefik/certificates/custom/${body.id}`, headers: OP })).statusCode).toBe(404);
    expect((await a.inject({ method: 'PUT', url: '/traefik/certificates/custom/999', headers: OP, payload: {} })).statusCode).toBe(404);
  });

  it('refuses a mismatched key (400) and an encrypted key at the schema (400)', async () => {
    const a = await app();
    const bad = await a.inject({
      method: 'POST',
      url: '/traefik/certificates/custom',
      headers: OP,
      payload: { name: 'x', certPem: fx('valid.crt'), keyPem: fx('other.key') },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({ code: 'invalid_certificate', message: expect.stringMatching(/does not match/) });
    const enc = await a.inject({
      method: 'POST',
      url: '/traefik/certificates/custom',
      headers: OP,
      payload: { name: 'x', certPem: fx('valid.crt'), keyPem: fx('encrypted.key') },
    });
    expect(enc.statusCode).toBe(400);
    expect(await db.query.tlsCertificates.findMany()).toEqual([]);
  });

  it('every route is operator-only', async () => {
    const a = await app();
    for (const [method, url] of [
      ['GET', '/traefik/custom-config'],
      ['POST', '/traefik/custom-config/validate'],
      ['PUT', '/traefik/custom-config'],
      ['DELETE', '/traefik/custom-config'],
      ['GET', '/traefik/certificates/custom'],
      ['POST', '/traefik/certificates/custom'],
      ['PUT', '/traefik/certificates/custom/1'],
      ['DELETE', '/traefik/certificates/custom/1'],
    ] as const) {
      expect((await a.inject({ method, url, headers: MEMBER, payload: method === 'GET' || method === 'DELETE' ? undefined : {} })).statusCode, `${method} ${url}`).toBe(403);
      expect((await a.inject({ method, url })).statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe('wiring', () => {
  it('M1: api.ts registers traefikCustomRoutes under /traefik', () => {
    const src = readFileSync(new URL('../src/modules/api.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/register\(traefikCustomRoutes, \{ prefix: '\/traefik' \}\)/);
  });

  it('M12: boot re-materialises custom.yml and certificates.yml before Traefik is healed, then renders', async () => {
    const calls: string[] = [];
    vi.resetModules();
    vi.doMock('../src/engine/proxy.js', () => ({
      ensureNetwork: vi.fn(async () => calls.push('ensureNetwork')),
      ensureTraefik: vi.fn(async () => {
        calls.push('ensureTraefik');
        return false;
      }),
      getAcmeEmail: vi.fn(async () => null),
      getDnsConfig: vi.fn(async () => null),
      materialiseCertificatesFile: vi.fn(async () => calls.push('certificates')),
      writeDynamicConfig: vi.fn(async () => calls.push('writeDynamicConfig')),
    }));
    vi.doMock('../src/lib/traefikCustomConfig.js', () => ({
      materialiseCustomConfig: vi.fn(async () => calls.push('custom')),
    }));
    const plugin = (await import('../src/plugins/traefik.js')).default;
    const f = Fastify({ logger: false });
    f.decorate('db', db);
    await f.register(plugin);
    await f.ready();
    await f.close();
    vi.doUnmock('../src/engine/proxy.js');
    vi.doUnmock('../src/lib/traefikCustomConfig.js');
    expect(calls).toEqual(['custom', 'certificates', 'ensureNetwork', 'ensureTraefik', 'writeDynamicConfig']);
  });
});
