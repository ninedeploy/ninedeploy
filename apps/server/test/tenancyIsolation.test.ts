/**
 * r510–r514 — cross-tenant isolation in the deploy path, against a real
 * migrated SQLite (the access decisions join users, workspaces, tags,
 * projects and the settings table — a fake db cannot model them honestly).
 * Every case goes through the seam that production mounts: the route, the
 * webhook receiver, the auto-update sweep, or the resolver the pipeline calls.
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditLog,
  createDb,
  deployments,
  domains,
  envVars,
  projects,
  serviceProjects,
  serviceWorkspaces,
  services,
  settings,
  sources,
  users,
  webhooks,
  workspaceMembers,
  workspaces,
  type DB,
} from '@ninedeploy/db';

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return { config: { ...actual.config, wildcardDomain: 'apps.example.com' } };
});
vi.mock('../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/proxy.js')>()),
  writeDynamicConfig: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/exec.js', () => ({
  capture: vi.fn(async () => ''),
  run: vi.fn(async () => undefined),
  sleep: vi.fn(async () => undefined),
}));
vi.mock('pm2', () => ({ default: { connect: vi.fn(), disconnect: vi.fn() } }));
// r514: every name resolves to a LAN address, so the egress guard's decision
// (not the network) is what the probe tests observe.
const dns = vi.hoisted(() => ({ lookup: vi.fn(async (_h: string, _o?: unknown) => [{ address: '10.0.0.5', family: 4 }]) }));
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, ...dns, default: { ...actual, ...dns } };
});

const { encrypt } = await import('../src/lib/crypto.js');
const { resetReplayWindowForTests } = await import('../src/lib/webhooks.js');
const { envRoutes, projectEnvRoutes } = await import('../src/modules/env.js');
const { hookReceiveRoutes } = await import('../src/modules/hooks.js');
const { servicesRoutes } = await import('../src/modules/services.js');
const { settingsRoutes } = await import('../src/modules/settings.js');
const { sourcesRoutes } = await import('../src/modules/sources.js');
const { templateRoutes } = await import('../src/modules/templates.js');
const { sweepAutoUpdates } = await import('../src/lib/autoUpdate.js');
const vault = await import('../src/lib/vault.js');
const registry = await import('../src/lib/registryBinding.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const REF = (key: string) => ['$', '{{infisical:', key, '}}'].join('');

let db: DB;
let close: () => void;
let dir: string;

// A file (not :memory:) database: the preview path runs a transaction, and an
// in-memory libsql client has a single connection that a transaction holds.
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-tenancy-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  resetReplayWindowForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

/** Operator #op, member #mem with a seat in W1 (allowed later) and W2. */
async function world() {
  const [op] = await db.insert(users).values({ email: 'op@x', passwordHash: 'h', isInstanceOperator: true }).returning();
  const [mem] = await db.insert(users).values({ email: 'mem@x', passwordHash: 'h' }).returning();
  const [w1] = await db.insert(workspaces).values({ name: 'Team One', slug: 'one', ownerId: op!.id }).returning();
  const [w2] = await db.insert(workspaces).values({ name: 'Team Two', slug: 'two', ownerId: op!.id }).returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: w1!.id, userId: mem!.id, role: 'member' },
    { workspaceId: w2!.id, userId: mem!.id, role: 'member' },
  ]);
  const svc = async (name: string, ownerUserId: number, wsId: number | null, over: Partial<typeof services.$inferInsert> = {}) => {
    const [row] = await db.insert(services).values({ name, slug: name, ownerUserId, ...over }).returning();
    if (wsId != null) await db.insert(serviceWorkspaces).values({ serviceId: row!.id, workspaceId: wsId });
    return row!;
  };
  const env = (serviceId: number, key: string, value: string) =>
    db.insert(envVars).values({ serviceId, scope: 'service', scopeKey: serviceId, key, valueEncrypted: encrypt(value), isSecret: true });
  return { op: op!, mem: mem!, w1: w1!, w2: w2!, svc, env };
}

const asMember = (id: number) => asUser({ id, isOperator: false });
const audits = async (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));

async function configureVault() {
  await vault.setVaultConfig(db, { provider: 'infisical', token: 'tok', projectId: 'ws', environment: 'prod' });
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ secrets: [{ secretKey: 'PROD_DB_PASSWORD', secretValue: 'hunter2' }] }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// ── r510 ─────────────────────────────────────────────────────────────────
describe('r510: vault references resolve only for allowed tenants', () => {
  it('upgrade seed: grandfathers current non-operator usage once, audits and logs it', async () => {
    const w = await world();
    const tagged = await w.svc('tagged', w.mem.id, w.w1.id);
    const untagged = await w.svc('untagged', w.mem.id, null);
    const opOwned = await w.svc('op-owned', w.op.id, w.w2.id);
    await w.svc('plain', w.mem.id, w.w2.id);
    await w.env(tagged.id, 'A', REF('X'));
    await w.env(untagged.id, 'B', `prefix-${REF('Y')}`);
    await w.env(opOwned.id, 'C', REF('Z')); // operator-owned: resolves anyway, needs no entry
    const [proj] = await db.insert(projects).values({ name: 'P', slug: 'p', workspaceId: w.w2.id }).returning();
    await db.insert(envVars).values({ serviceId: null, scope: 'project', scopeKey: proj!.id, key: 'D', valueEncrypted: encrypt(REF('Q')) });

    const log = vi.fn();
    const seeded = await vault.ensureVaultAllowlistInitialised(db, log);
    expect(seeded).toEqual({ workspaceIds: [w.w1.id, w.w2.id], serviceIds: [untagged.id] });
    expect(log).toHaveBeenCalledTimes(1);
    expect(await audits('settings.vault_allowlist_seeded')).toHaveLength(1);

    // Initialised: a later boot neither re-seeds nor re-audits.
    await vault.setVaultAllowlist(db, { workspaceIds: [], serviceIds: [] });
    expect(await vault.ensureVaultAllowlistInitialised(db, log)).toEqual({ workspaceIds: [], serviceIds: [] });
    expect(log).toHaveBeenCalledTimes(1);
    expect(await audits('settings.vault_allowlist_seeded')).toHaveLength(1);
  });

  it('deploy-time: a member service outside the allowlist cannot read a vault secret; allowed ones can', async () => {
    const w = await world();
    await vault.setVaultAllowlist(db, { workspaceIds: [w.w1.id], serviceIds: [] });
    const fetchMock = await configureVault();
    const attacker = await w.svc('attacker', w.mem.id, w.w2.id);
    const allowed = await w.svc('allowed', w.mem.id, w.w1.id);
    const opOwned = await w.svc('op-owned', w.op.id, w.w2.id);
    const env = { X: REF('PROD_DB_PASSWORD') };

    await expect(vault.resolveVaultRefs(db, env, { service: attacker, projectIds: [] })).rejects.toThrow(
      /not enabled for this service.*Settings → Integrations → Vault provider/,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    expect(await vault.resolveVaultRefs(db, env, { service: allowed, projectIds: [] })).toEqual({ X: 'hunter2' });
    expect(await vault.resolveVaultRefs(db, env, { service: opOwned, projectIds: [] })).toEqual({ X: 'hunter2' });
    // A (trust-filtered) project link into an allowed workspace also counts —
    // the shared env written there by its members resolves for the service.
    const [p1] = await db.insert(projects).values({ name: 'P1', slug: 'p1', workspaceId: w.w1.id }).returning();
    await db.insert(serviceProjects).values({ serviceId: attacker.id, projectId: p1!.id });
    expect(await vault.resolveVaultRefs(db, env, { service: attacker, projectIds: [p1!.id] })).toEqual({ X: 'hunter2' });
  });

  it('write-time: member gets a clear 403 for a reference on a non-allowed service, project, import and PATCH', async () => {
    const w = await world();
    await vault.setVaultAllowlist(db, { workspaceIds: [w.w1.id], serviceIds: [] });
    const mine = await w.svc('mine', w.mem.id, w.w2.id);
    const ok = await w.svc('ok', w.mem.id, w.w1.id);
    // Operator-owned but member-editable (W2 seat): owner status does NOT
    // let a member plant a new reference.
    const shared = await w.svc('shared', w.op.id, w.w2.id);
    const [p2] = await db.insert(projects).values({ name: 'P2', slug: 'p2', workspaceId: w.w2.id }).returning();
    const [p1] = await db.insert(projects).values({ name: 'P1', slug: 'p1', workspaceId: w.w1.id }).returning();

    const app = await buildTestApp({ db });
    await app.register(envRoutes, { prefix: '/services' });
    await app.register(projectEnvRoutes, { prefix: '/projects' });
    const post = (url: string, value: string, user = asMember(w.mem.id)) =>
      app.inject({ method: 'POST', url, headers: user, payload: { key: 'SECRET', value } });

    const refused = await post(`/services/${mine.id}/env`, REF('PROD_DB_PASSWORD'));
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toMatch(/Vault references .* are not enabled for service "mine".*allow its workspace/);
    expect((await post(`/services/${shared.id}/env`, REF('PROD_DB_PASSWORD'))).statusCode).toBe(403);
    expect((await post(`/projects/${p2!.id}/env`, REF('PROD_DB_PASSWORD'))).statusCode).toBe(403);
    const imported = await app.inject({
      method: 'POST',
      url: `/services/${mine.id}/env/import`,
      headers: asMember(w.mem.id),
      payload: { content: `PLAIN=1\nX=${REF('PROD_DB_PASSWORD')}\n` },
    });
    expect(imported.statusCode).toBe(403);

    // Plain values, allowed targets and operators are unaffected.
    const plain = await post(`/services/${mine.id}/env`, 'just-a-value');
    expect(plain.statusCode).toBe(200);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/services/${mine.id}/env/${plain.json().id}`,
      headers: asMember(w.mem.id),
      payload: { key: 'SECRET', value: REF('PROD_DB_PASSWORD') },
    });
    expect(patched.statusCode).toBe(403);
    expect((await post(`/services/${ok.id}/env`, REF('PROD_DB_PASSWORD'))).statusCode).toBe(200);
    expect((await post(`/projects/${p1!.id}/env`, REF('PROD_DB_PASSWORD'))).statusCode).toBe(200);
    expect((await post(`/services/${shared.id}/env`, REF('A'), asUser({ id: w.op.id, isOperator: true }))).statusCode).toBe(200);

    const stored = await db.select().from(envVars).where(eq(envVars.serviceId, mine.id));
    expect(stored.map((r) => r.key)).toEqual(['SECRET']); // the import wrote nothing
    await app.close();
  });

  it('settings API: GET exposes the allowlist with names, PUT /vault/allowlist replaces it and audits', async () => {
    const w = await world();
    const app = await buildTestApp({ db });
    await app.register(settingsRoutes);
    const opHeaders = asUser({ id: w.op.id, isOperator: true });
    const before = await app.inject({ method: 'GET', url: '/vault', headers: opHeaders });
    expect(before.json()).toMatchObject({
      allowlist: { workspaceIds: [], serviceIds: [] },
      workspaces: [
        { id: w.w1.id, name: 'Team One' },
        { id: w.w2.id, name: 'Team Two' },
      ],
      allowedServices: [],
    });
    const put = await app.inject({ method: 'PUT', url: '/vault/allowlist', headers: opHeaders, payload: { workspaceIds: [w.w2.id] } });
    expect(put.statusCode).toBe(200);
    expect(await vault.getVaultAllowlist(db)).toEqual({ workspaceIds: [w.w2.id], serviceIds: [] });
    expect(await audits('settings.vault_allowlist')).toHaveLength(1);
    // Members never reach it (settings are operator-only).
    const denied = await app.inject({ method: 'PUT', url: '/vault/allowlist', headers: asMember(w.mem.id), payload: { workspaceIds: [w.w1.id] } });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });
});

// ── r601 ─────────────────────────────────────────────────────────────────
describe('r601: the write-time vault gate also covers the template deploy env', () => {
  it('a member cannot plant a reference through a template deploy outside the allowlist; nothing is created', async () => {
    const w = await world();
    // W1 is allowed — but the member is tagged into W1 by default, so take
    // the member's W1 seat away to make the new service land in W2 only.
    await vault.setVaultAllowlist(db, { workspaceIds: [w.w1.id], serviceIds: [] });
    await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, w.w1.id));
    const app = await buildTestApp({ db });
    await app.register(templateRoutes);
    const deploy = (user: ReturnType<typeof asUser>, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/grafana/deploy', headers: user, payload });

    const refused = await deploy(asMember(w.mem.id), {
      name: 'graf-x',
      env: [{ key: 'GF_SECRET', value: REF('PROD_DB_PASSWORD') }],
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toMatch(/Vault references .* are not enabled for service "graf-x".*allow its workspace/);
    // Refused up front: no service row, no env, no deployment.
    expect(await db.select().from(services)).toEqual([]);
    expect(await db.select().from(deployments)).toEqual([]);

    // With a seat in an allowed workspace (the new service is tagged into it,
    // and the project there becomes visible) the same deploy goes through.
    const [p1] = await db.insert(projects).values({ name: 'P1', slug: 'p1', workspaceId: w.w1.id }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: w.w1.id, userId: w.mem.id, role: 'member' });
    const viaProject = await deploy(asMember(w.mem.id), {
      name: 'graf-ok',
      projectId: p1!.id,
      env: [{ key: 'GF_SECRET', value: REF('PROD_DB_PASSWORD') }],
    });
    expect(viaProject.statusCode).toBe(200);

    // Plain values and operators are unaffected.
    await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, w.w1.id));
    expect((await deploy(asMember(w.mem.id), { name: 'graf-plain', env: [{ key: 'A', value: 'b' }] })).statusCode).toBe(200);
    expect(
      (await deploy(asUser({ id: w.op.id, isOperator: true }), { name: 'graf-op', env: [{ key: 'A', value: REF('X') }] })).statusCode,
    ).toBe(200);
    await app.close();
  });
});

// ── r511 ─────────────────────────────────────────────────────────────────
describe('r511: PR preview domains cannot claim another tenant\'s host', () => {
  const SECRET = 'hook-secret';
  const sig = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

  async function openPr(parentPattern: string, prNumber: number) {
    const w = await world();
    const parent = await w.svc('app', w.mem.id, w.w1.id, {
      repoUrl: 'https://github.com/org/repo.git',
      previewDeploymentsEnabled: true,
      previewDomainPattern: parentPattern,
    });
    const victim = await w.svc('app12x', w.op.id, w.w2.id);
    const [hook] = await db
      .insert(webhooks)
      .values({ serviceId: parent.id, branch: 'main', secretEncrypted: encrypt(SECRET) })
      .returning();
    const app = await buildTestApp({ db, rawBody: true });
    await app.register(hookReceiveRoutes);
    const body = JSON.stringify({
      action: 'opened',
      number: prNumber,
      pull_request: {
        number: prNumber,
        title: 'feat',
        user: { login: 'bob' },
        head: { ref: 'feature-x', sha: 'deadbeef', repo: { clone_url: 'https://github.com/org/repo.git' } },
        base: { repo: { clone_url: 'https://github.com/org/repo.git' } },
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/${hook!.id}`,
      headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': sig(body) },
      payload: body,
    });
    await app.close();
    return { res, victim };
  }

  it('a stored pattern without {{pr}}/{{slug}} (the takeover shape) deploys but provisions no domain', async () => {
    const { res } = await openPr('app12x.{{domain}}', 12);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, action: 'preview_deployment_queued', previewDomainSkipped: 'pattern_requires_pr_and_slug' });
    expect(await db.select().from(domains)).toEqual([]);
  });

  it('a token-bearing pattern that still renders onto another service\'s automatic host is refused', async () => {
    // slug "app" + PR 12 + "x" renders to app12x — the victim's auto domain.
    const { res } = await openPr('{{slug}}{{pr}}x.{{domain}}', 12);
    expect(res.json()).toMatchObject({ ok: true, previewDomainSkipped: 'domain_claims_another_service' });
    expect(await db.select().from(domains)).toEqual([]);
  });

  it('the default pattern still provisions the preview host', async () => {
    const { res } = await openPr('pr-{{pr}}-{{slug}}.{{domain}}', 7);
    expect(res.json().previewDomainSkipped).toBeUndefined();
    const rows = await db.select().from(domains);
    expect(rows.map((d) => d.hostname)).toEqual(['pr-7-app.apps.example.com']);
  });

  it('services PATCH/create refuse a changed pattern without the tokens (400), re-sending a stored one is allowed', async () => {
    const w = await world();
    const legacy = await w.svc('legacy', w.mem.id, w.w1.id, { previewDomainPattern: 'old.{{domain}}' });
    const app = await buildTestApp({ db });
    await app.register(servicesRoutes, { prefix: '/services' });
    const patch = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url: `/services/${legacy.id}`, headers: asMember(w.mem.id), payload });
    const bad = await patch({ previewDomainPattern: 'victim.{{domain}}' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({ code: 'invalid_preview_domain_pattern' });
    expect(bad.json().error.message).toMatch(/must contain both \{\{pr\}\} and \{\{slug\}\}/);
    expect((await patch({ previewDomainPattern: 'pr-{{pr}}-{{slug}}.elsewhere.example' })).statusCode).toBe(400);
    expect((await patch({ previewDomainPattern: 'old.{{domain}}', previewMaxActive: 3 })).statusCode).toBe(200);
    expect((await patch({ previewDomainPattern: '{{slug}}-pr{{pr}}.{{domain}}' })).statusCode).toBe(200);
    const created = await app.inject({
      method: 'POST',
      url: '/services',
      headers: asMember(w.mem.id),
      payload: {
        name: 'fresh',
        type: 'docker',
        repoUrl: 'https://github.com/org/x.git',
        branch: 'main',
        previewDomainPattern: 'x.{{domain}}',
        build: { buildPack: 'auto', baseDir: '/' },
      },
    });
    expect(created.statusCode).toBe(400);
    await app.close();
  });
});

// ── r512 ─────────────────────────────────────────────────────────────────
describe('r512: a registry credential is only sent to the host it is bound to', () => {
  async function registryWorld() {
    const w = await world();
    const [src] = await db
      .insert(sources)
      .values({ type: 'registry', name: 'ghcr-ci', registryUsername: 'ci', tokenEncrypted: encrypt('pat') })
      .returning();
    return { ...w, src: src! };
  }

  it('upgrade seed binds each registry source to the hosts its services use today, audited', async () => {
    const w = await registryWorld();
    await w.svc('a', w.mem.id, w.w1.id, { image: 'ghcr.io/acme/a:1', sourceId: w.src.id });
    await w.svc('b', w.mem.id, w.w1.id, { image: 'nginx:latest', sourceId: w.src.id });
    const log = vi.fn();
    expect(await registry.ensureRegistryBindingsInitialised(db, log)).toEqual({ [String(w.src.id)]: ['docker.io', 'ghcr.io'] });
    expect(log).toHaveBeenCalledTimes(1);
    expect(await audits('source.registry_hosts_seeded')).toHaveLength(1);
  });

  it('the shared resolver withholds the credential from an unbound host and audits it', async () => {
    const w = await registryWorld();
    await registry.setBoundRegistryHosts(db, w.src.id, ['ghcr.io']);
    const lines: string[] = [];
    expect(
      await registry.registryCredentialFor(db, { sourceId: w.src.id, image: 'ghcr.io/acme/a:1' }, (l) => lines.push(l)),
    ).toEqual({ username: 'ci', password: 'pat', server: 'ghcr.io' });
    expect(
      await registry.registryCredentialFor(db, { sourceId: w.src.id, image: 'attacker.example/x:1' }, (l) => lines.push(l)),
    ).toBeUndefined();
    expect(lines.join('\n')).toMatch(/bound to ghcr\.io — not sending it to attacker\.example/);
    expect(await audits('source.registry_credential_withheld')).toHaveLength(1);
  });

  it('services PATCH: a member cannot retarget the image to another registry; an operator change binds the host', async () => {
    const w = await registryWorld();
    await registry.setBoundRegistryHosts(db, w.src.id, ['ghcr.io']);
    const svc = await w.svc('web', w.mem.id, w.w1.id, { image: 'ghcr.io/acme/web:1', sourceId: w.src.id });
    const app = await buildTestApp({ db });
    await app.register(servicesRoutes, { prefix: '/services' });
    const patch = (image: string, headers: Record<string, string>) =>
      app.inject({ method: 'PATCH', url: `/services/${svc.id}`, headers, payload: { image } });

    const stolen = await patch('attacker.example/web:1', asMember(w.mem.id));
    expect(stolen.statusCode).toBe(403);
    expect(stolen.json().error.message).toMatch(/another registry \(attacker\.example\).*"ghcr-ci"/);
    // Same registry (a new tag) stays a member's call.
    expect((await patch('ghcr.io/acme/web:2', asMember(w.mem.id))).statusCode).toBe(200);
    // The operator may move it; that binds the new host.
    expect((await patch('registry.acme.io/web:2', asUser({ id: w.op.id, isOperator: true }))).statusCode).toBe(200);
    expect(await registry.boundRegistryHosts(db, w.src.id)).toEqual(['ghcr.io', 'registry.acme.io']);
    await app.close();
  });

  it('sources API exposes, accepts and clears registryHosts', async () => {
    const w = await world();
    const app = await buildTestApp({ db });
    await app.register(sourcesRoutes, { prefix: '/sources' });
    const opHeaders = asUser({ id: w.op.id, isOperator: true });
    const created = await app.inject({
      method: 'POST',
      url: '/sources',
      headers: opHeaders,
      payload: { name: 'hub', type: 'registry', token: 't', registryUsername: 'u', registryHosts: ['index.docker.io'] },
    });
    expect(created.json()).toMatchObject({ registryHosts: ['docker.io'] });
    const id = created.json().id as number;
    const patched = await app.inject({ method: 'PATCH', url: `/sources/${id}`, headers: opHeaders, payload: { registryHosts: ['ghcr.io'] } });
    expect(patched.json()).toMatchObject({ registryHosts: ['ghcr.io'] });
    const list = await app.inject({ method: 'GET', url: '/sources', headers: opHeaders });
    expect(list.json()[0]).toMatchObject({ id, registryHosts: ['ghcr.io'] });
    await app.inject({ method: 'DELETE', url: `/sources/${id}`, headers: opHeaders });
    expect(await registry.boundRegistryHosts(db, id)).toEqual([]);
    await app.close();
  });
});

// ── r513 / r512 in the sweep ─────────────────────────────────────────────
describe('r513: the auto-update sweep applies the owner-privilege gate', () => {
  it('skips (logs + audits, no deploy) a member service the owner could not deploy; operator-owned still deploys', async () => {
    const w = await world();
    const base = { type: 'docker' as const, status: 'running' as const, autoUpdate: true, autoUpdateDigest: 'sha256:old' };
    const memberSocket = await w.svc('member-socket', w.mem.id, w.w1.id, { ...base, image: 'acme/a:1', dockerSocket: true });
    const opSocket = await w.svc('op-socket', w.op.id, w.w1.id, { ...base, image: 'acme/b:1', dockerSocket: true });
    const logs: string[] = [];

    const result = await sweepAutoUpdates(db, vi.fn(async () => 'sha256:new'), (m) => logs.push(m));

    expect(result).toMatchObject({ enqueued: 1, skipped: 1 });
    const queued = await db.select().from(deployments);
    expect(queued.map((d) => d.serviceId)).toEqual([opSocket.id]);
    expect(logs.some((l) => l.includes('member-socket skipped') && /Docker socket/.test(l))).toBe(true);
    expect(await audits('autoupdate.refused')).toHaveLength(1);
    // The refused move is recorded, so the next sweep does not re-audit it.
    await sweepAutoUpdates(db, vi.fn(async () => 'sha256:new'));
    expect(await audits('autoupdate.refused')).toHaveLength(1);
    const [after] = await db.select().from(services).where(eq(services.id, memberSocket.id));
    expect(after!.autoUpdateDigest).toBe('sha256:new');
  });

  it('r514: an operator-owned image may probe a LAN registry; a member-owned one is skipped with the reason', async () => {
    const w = await world();
    const base = { type: 'docker' as const, status: 'running' as const, autoUpdate: true, autoUpdateDigest: 'sha256:old' };
    await w.svc('op-lan', w.op.id, w.w1.id, { ...base, image: 'registry.lan:5000/team/app:1' });
    await w.svc('mem-lan', w.mem.id, w.w1.id, { ...base, image: 'registry.lan:5000/team/other:1' });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k === 'docker-content-digest' ? 'sha256:new' : null) },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const logs: string[] = [];

    const result = await sweepAutoUpdates(db, undefined, (m) => logs.push(m));

    // Only the operator's probe went out — still without following redirects.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://registry.lan:5000/v2/team/app/manifests/1');
    expect(fetchMock.mock.calls[0]![1]!.redirect).toBe('manual');
    expect(result).toMatchObject({ enqueued: 1, skipped: 1 });
    expect(logs.some((l) => l.includes('mem-lan skipped') && l.includes('registry probe refused') && l.includes('10.0.0.5'))).toBe(true);
  });

  it('r512: the registry probe never receives a credential for an unbound host', async () => {
    const w = await world();
    const [src] = await db
      .insert(sources)
      .values({ type: 'registry', name: 'ghcr-ci', registryUsername: 'ci', tokenEncrypted: encrypt('pat') })
      .returning();
    await registry.setBoundRegistryHosts(db, src!.id, ['ghcr.io']);
    await w.svc('moved', w.mem.id, w.w1.id, {
      type: 'docker',
      status: 'running',
      autoUpdate: true,
      autoUpdateDigest: 'sha256:old',
      image: 'attacker.example/x:1',
      sourceId: src!.id,
    });
    const probe = vi.fn(async () => 'sha256:old');
    await sweepAutoUpdates(db, probe);
    expect(probe).toHaveBeenCalledWith('attacker.example', 'x', '1', undefined, { allowPrivateEgress: false });
  });
});

describe('storage', () => {
  it('the allowlist and the bindings live in the existing settings table (no migration)', async () => {
    await vault.ensureVaultAllowlistInitialised(db);
    await registry.ensureRegistryBindingsInitialised(db);
    const keys = (await db.select().from(settings)).map((r) => r.key).sort();
    expect(keys).toEqual(['registry_source_hosts', 'vault_allowlist']);
  });
});
