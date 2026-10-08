/**
 * r690 — the authorization matrix: EVERY route the real app registers, called
 * as every kind of caller, against a real migrated SQLite.
 *
 * Three audits found the same defect class over and over: one route letting a
 * caller reach another tenant's row, or do more than their workspace role
 * allows. Per-route tests only guard the routes someone remembered to test.
 * This file instead boots the REAL `buildApp()` (every side-effecting plugin
 * stubbed, no Docker/shell/network), collects the live route table through an
 * `onRoute` hook, and requires every route to carry a classification in
 * `MATRIX` below — a new route without one fails `classifies every route`.
 *
 * For each classified route it checks:
 *   • anonymous callers are refused (unless the route is public/token-gated);
 *   • cross-tenant: every workspace-B identity (owner…viewer) and an outsider
 *     with no seat, calling with workspace A's ids, get 403/404 — never 2xx,
 *     never 5xx — and the database is row-for-row unchanged;
 *   • mixed ids: workspace B's owner naming B's parent with A's child
 *     (`/services/<B>/deploys/<A>`), and B's resource with A's ids in the
 *     body (attach A's database to B's service), is refused and changes
 *     nothing;
 *   • role floor: every workspace-A role below the classified floor is
 *     refused without a write; the identity AT the floor gets past authz;
 *   • no B-side 2xx response ever contains workspace A's marker string.
 *
 * Fixtures: every route gets its OWN freshly seeded workspaces (all four
 * roles seated in each), so a destructive route can never take another
 * route's fixture down with it.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DB } from '@ninedeploy/db';

// ── hermetic boot: nothing may reach Docker, a shell, the network or a timer ──
const hoisted = vi.hoisted(() => {
  const fp = (fn: (f: unknown) => Promise<void>, name: string) =>
    Object.assign(fn, { [Symbol.for('skip-override')]: true, [Symbol.for('fastify.display-name')]: name });
  /** Managed docker volumes the fake `docker volume ls` reports. */
  const volumes = new Set<string>();
  /**
   * Side effects outside the database a request ATTEMPTED (every stub below
   * records itself before failing): a docker/git/agent/mail/HTTP call made on
   * behalf of a caller who should have been refused is as much a breach as a
   * row write, even when the stub then fails it into a 4xx.
   */
  const effects: string[] = [];
  /** Every route the real app registers, collected by an onRoute hook on the real factory. */
  const routes: Array<{ method: string | string[]; url: string; websocket?: boolean }> = [];
  return { fp, volumes, routes, effects };
});
const noop = (name: string) => ({ default: hoisted.fp(async () => undefined, name) });
vi.mock('../src/plugins/worker.js', () => noop('ninedeploy-worker'));
vi.mock('../src/plugins/traefik.js', () => noop('ninedeploy-traefik'));
vi.mock('../src/plugins/backupScheduler.js', () => noop('authz-backups'));
vi.mock('../src/plugins/runtimeState.js', () => noop('authz-runtime'));
vi.mock('../src/plugins/autoUpdateScheduler.js', () => noop('authz-autoupdate'));
vi.mock('../src/plugins/housekeeping.js', () => noop('authz-housekeeping'));
vi.mock('../src/plugins/logShipper.js', () => noop('authz-logshipper'));
vi.mock('../src/plugins/jobScheduler.js', () => noop('authz-jobs'));
vi.mock('../src/plugins/panelBackupScheduler.js', () => noop('authz-panel-backup'));
vi.mock('../src/plugins/staticFiles.js', () => noop('authz-static'));
// The limiter is not under test, and ~4k requests from one address trip it.
vi.mock('../src/plugins/rateLimit.js', () => noop('authz-ratelimit'));
vi.mock('../src/plugins/collector.js', () => ({
  default: hoisted.fp(async (f) => {
    // Every container "exists" with live stats, so a stats route that forgets
    // to filter by tenant shows the other tenant's names (caught by MARK_A).
    const stat = { cpuPct: 1, memBytes: 1024, memLimitBytes: 0 };
    const containers = { get: () => stat, has: () => true, size: 0, [Symbol.iterator]: function* () {} };
    (f as { decorate: (n: string, v: unknown) => void }).decorate('stats', { raw: () => ({ containers, host: null }) });
  }, 'ninedeploy-collector'),
}));
// simple-git and nodemailer live in node_modules, which a node:child_process
// mock does not reach: stub them at the package boundary.
vi.mock('simple-git', () => {
  const git = (): unknown =>
    new Proxy(() => undefined, {
      get: (_t, k) => {
        if (k !== 'then') return git();
        hoisted.effects.push('git');
        return (_ok: unknown, fail: (e: Error) => void) => fail(new Error('git disabled in authz matrix'));
      },
      apply: () => git(),
    });
  return { simpleGit: () => git(), default: () => git() };
});
vi.mock('nodemailer', () => {
  const createTransport = () => ({
    sendMail: async () => {
      hoisted.effects.push('mail');
      throw new Error('mail disabled in authz matrix');
    },
    verify: async () => {
      throw new Error('mail disabled in authz matrix');
    },
  });
  return { createTransport, default: { createTransport } };
});
vi.mock('../src/lib/agentClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentClient.js')>()),
  agentOp: vi.fn(async (..._a: unknown[]) => {
    hoisted.effects.push(`agent ${String(_a[1] ?? '')}`);
    throw new Error('agent disabled in authz matrix');
  }),
  agentPing: vi.fn(async () => {
    throw new Error('agent disabled in authz matrix');
  }),
}));
// Every name resolves to a TEST-NET address: egress guards decide, nothing connects.
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  const stub = {
    lookup: vi.fn(async (_h: string, o?: { all?: boolean }) =>
      o?.all ? [{ address: '203.0.113.10', family: 4 }] : { address: '203.0.113.10', family: 4 },
    ),
    resolve4: vi.fn(async () => ['203.0.113.10']),
    resolve6: vi.fn(async () => []),
    resolveTxt: vi.fn(async () => []),
  };
  return { ...actual, ...stub, default: { ...actual, ...stub } };
});
vi.mock('pm2', () => ({ default: { connect: vi.fn((cb: (e: Error) => void) => cb(new Error('pm2 disabled'))) } }));
vi.mock('../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/exec.js')>()),
  capture: vi.fn(async (cmd: string, args: string[]) => {
    // The managed-volume listing is the one host READ access decisions consult.
    if (cmd === 'docker' && args[0] === 'volume' && args[1] === 'ls') return [...hoisted.volumes].join('\n');
    hoisted.effects.push(`${cmd} ${args.slice(0, 2).join(' ')}`);
    throw new Error('exec disabled in authz matrix');
  }),
  run: vi.fn(async (cmd: string, args: string[]) => {
    hoisted.effects.push(`${cmd} ${args.slice(0, 2).join(' ')}`);
    throw new Error('exec disabled in authz matrix');
  }),
  sleep: vi.fn(async () => undefined),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const fake = (cmd?: unknown) => {
    hoisted.effects.push(`spawn ${String(cmd)}`);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      pid: undefined,
      kill: () => true,
      unref: () => undefined,
    });
    setImmediate(() => {
      if (child.listenerCount('error') > 0) {
        child.emit('error', Object.assign(new Error('spawn disabled in authz matrix'), { code: 'ENOENT' }));
      }
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 127, null);
      child.emit('exit', 127, null);
    });
    return child;
  };
  const cbFake = (...args: unknown[]) => {
    const cb = args.find((a) => typeof a === 'function') as ((e: Error) => void) | undefined;
    setImmediate(() => cb?.(new Error('exec disabled in authz matrix')));
    return fake();
  };
  const sync = () => {
    throw new Error('exec disabled in authz matrix');
  };
  const mod = { ...actual, spawn: fake, fork: fake, exec: cbFake, execFile: cbFake, execSync: sync, execFileSync: sync, spawnSync: sync };
  return { ...mod, default: mod };
});
vi.mock('fastify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fastify')>();
  const factory = actual.default as unknown as (o: unknown) => FastifyInstance;
  const wrapped = (opts: unknown) => {
    const inst = factory(opts);
    inst.addHook('onRoute', (r) => {
      hoisted.routes.push({ method: r.method as string | string[], url: r.url, websocket: (r as { websocket?: boolean }).websocket });
    });
    return inst;
  };
  return { ...actual, default: Object.assign(wrapped, actual.default) };
});

// ── identities ───────────────────────────────────────────────────────────
const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
type Role = (typeof ROLES)[number];
type Who = `${Role}A` | `${Role}B` | 'outsider' | 'leaverA' | 'operator' | 'anon';
type Named = Exclude<Who, 'anon'>;
/**
 * Everyone who must get nothing from workspace A: every B role, a user with
 * no seat at all, and `leaverA` — who CREATED A's services and databases
 * (`ownerUserId`) and has since been removed from the workspace.
 */
const OTHERS: Who[] = ['outsider', 'leaverA', 'ownerB', 'adminB', 'memberB', 'viewerB'];
const ids = {} as Record<Named, number>;

/** Markers: no B-side response may ever contain A's. */
const MARK_A = 'qxalpha';
const MARK_B = 'qxbravo';
/** In every secret value (secret env, webhook secret, database password): no viewer or member may read it. */
const SECRET = 'zzsecret';

// ── fixtures ─────────────────────────────────────────────────────────────
/** Ids of one freshly seeded workspace and one of every resource in it. */
interface Res {
  n: number;
  ws: number;
  owner: number;
  project: number;
  environment: number;
  label: number;
  service: number;
  service2: number;
  deployment: number;
  domain: number;
  envVar: number;
  projectEnvVar: number;
  previewEnvVar: number;
  webhook: number;
  job: number;
  database: number;
  backup: number;
  dbAttachment: number;
  volAttachment: number;
  volumeName: string;
  invitation: number;
  /** A plain member's seat (not one of the four test identities). */
  member: number;
  scimToken: number;
  scimSecret: string;
  alert: number;
  session: number;
  apiToken: number;
  passkey: number;
  logDrain: number;
  transferToken: string;
  inviteToken: string;
  serviceSlug: string;
  /** A user seated in the workspace that user-targeting routes act on. */
  victim: number;
  victimEmail: string;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-authz-'));
let app: FastifyInstance;
let db: DB;
let S: typeof import('@ninedeploy/db');
let crypto: typeof import('../src/lib/crypto.js');
let signAccessToken: typeof import('../src/lib/jwt.js').signAccessToken;
let seq = 0;
/** Workspace B's fixture — shared: nothing any case does may change it. */
let B: Res;

/**
 * Seed one workspace with one of everything, in ONE batch (one transaction).
 * Ids are assigned here — `10_000 × n` per table — so no insert waits on
 * another's `returning()`; rows a request creates get `max(id) + 1`, which
 * the next seed's block never reaches.
 */
async function seed(side: 'A' | 'B'): Promise<Res> {
  const n = ++seq;
  const id = n * 10_000;
  const mark = side === 'A' ? MARK_A : MARK_B;
  const owner = ids[`owner${side}`];
  const creator = side === 'A' ? ids.leaverA : owner;
  const future = new Date(Date.now() + 86_400_000);
  const serviceSlug = `${mark}-svc-${n}`;
  const dbSlug = `${mark}-db-${n}`;
  const volumeName = `nd-svc-${serviceSlug}-data`;
  const backupPath = path.join(tmp, 'backups', `${mark}-${n}.sql.gz`);
  const victimEmail = `victim-${n}@${mark}.test`;
  const inviteToken = `${mark}-invite-${n}-${'0'.repeat(32)}`;
  const transferToken = `${mark}-transfer-${n}-${'0'.repeat(32)}`;
  const scimSecret = `${mark}-scim-${n}`;
  hoisted.volumes.add(volumeName);
  hoisted.volumes.add(`nd-db-${dbSlug}-data`);
  writeFileSync(path.join(tmp, 'logs', `${id}.log`), `${mark} build log\n`);
  writeFileSync(backupPath, `${mark} dump`);
  const service = (sid: number, slug: string) => ({
    id: sid,
    ownerUserId: creator,
    name: slug,
    slug,
    type: 'docker' as const,
    image: 'nginx:alpine',
    port: 80,
    status: 'running' as const,
    runtimeId: `nd-app-${slug}`,
    environmentId: id,
  });
  const links = (sid: number) => [
    db.insert(S.serviceWorkspaces).values({ serviceId: sid, workspaceId: id }),
    db.insert(S.serviceProjects).values({ serviceId: sid, projectId: id }),
    db.insert(S.serviceLabels).values({ serviceId: sid, labelId: id }),
    db.insert(S.buildConfigs).values({ id: sid, serviceId: sid }),
  ];
  await db.batch([
    db.insert(S.workspaces).values({ id, name: `${mark} team ${n}`, slug: `${mark}-${n}`, ownerId: owner }),
    db.insert(S.workspaceMembers).values(ROLES.map((role, i) => ({ id: id + i, workspaceId: id, userId: ids[`${role}${side}`], role }))),
    db.insert(S.users).values({ id, email: victimEmail, passwordHash: 'x', name: `${mark}-victim-${n}` }),
    db.insert(S.workspaceMembers).values({ id: id + 9, workspaceId: id, userId: id, role: 'member' }),
    db.insert(S.projects).values({ id, workspaceId: id, name: `${mark}-proj-${n}`, slug: `${mark}-proj-${n}` }),
    db.insert(S.environments).values({ id, workspaceId: id, name: `${mark}-env-${n}`, slug: `${mark}-env-${n}` }),
    db.insert(S.labels).values({ id, workspaceId: id, name: `${mark}-label-${n}` }),
    db.insert(S.services).values([service(id, serviceSlug), service(id + 1, `${serviceSlug}-b`)]),
    ...links(id),
    ...links(id + 1),
    db.insert(S.deployments).values([
      { id, serviceId: id, status: 'running', commitSha: 'a'.repeat(40), message: `${mark} deploy` },
      // A queued deploy, so the global queue has A rows to leak.
      { id: id + 1, serviceId: id + 1, status: 'queued', message: `${mark} queued` },
    ]),
    db.insert(S.domains).values({ id, serviceId: id, hostname: `${mark}-${n}.example.test`, status: 'active' }),
    db.insert(S.envVars).values([
      { id, serviceId: id, scope: 'service', scopeKey: id, key: `${mark.toUpperCase()}_KEY`, valueEncrypted: crypto.encrypt(`${mark}-${SECRET}-env`) },
      { id: id + 1, serviceId: null, scope: 'project', scopeKey: id, key: `${mark.toUpperCase()}_PKEY`, valueEncrypted: crypto.encrypt(`${mark}-${SECRET}-penv`) },
    ]),
    // 0.12 preview-only env: a secret value only an admin-tier reader may see.
    db.insert(S.previewEnvVars).values({ id, serviceId: id, key: `${mark.toUpperCase()}_VKEY`, valueEncrypted: crypto.encrypt(`${mark}-${SECRET}-venv`), isSecret: true }),
    db.insert(S.webhooks).values({ id, serviceId: id, branch: 'main', secretEncrypted: crypto.encrypt(`${mark}-${SECRET}-hook`) }),
    db.insert(S.scheduledJobs).values({ id, serviceId: id, name: `${mark}-job-${n}`, cron: '0 3 * * *', kind: 'deploy' }),
    db.insert(S.jobRuns).values({ id, jobId: id, status: 'completed', output: `${mark} run` }),
    db.insert(S.databases).values({
      id,
      projectId: id,
      ownerUserId: creator,
      name: dbSlug,
      slug: dbSlug,
      engine: 'postgres',
      status: 'running',
      containerName: `nd-db-${dbSlug}`,
      internalHost: `nd-db-${dbSlug}`,
      internalPort: 5432,
      username: 'app',
      dbName: 'app',
      volumeName: `nd-db-${dbSlug}-data`,
      passwordEncrypted: crypto.encrypt(`${mark}-${SECRET}-dbpass`),
    }),
    db.insert(S.backups).values({ id, databaseId: id, scope: 'db', status: 'completed', path: backupPath, sizeBytes: 9 }),
    db.insert(S.backupDrills).values({ id, databaseId: id, backupId: id, status: 'passed', engine: 'postgres' }),
    db.insert(S.databaseAttachments).values({ id, serviceId: id, databaseId: id, envAlias: 'DATABASE' }),
    db.insert(S.serviceVolumeAttachments).values({ id, serviceId: id, volumeName, containerPath: '/data' }),
    db.insert(S.workspaceInvitations).values({
      id,
      workspaceId: id,
      email: `invitee-${n}@${mark}.test`,
      role: 'member',
      token: crypto.sha256(inviteToken),
      invitedByUserId: owner,
      expiresAt: future,
    }),
    db.insert(S.scimTokens).values({ id, name: `${mark}-idp-${n}`, tokenHash: crypto.sha256(scimSecret), workspaceId: id }),
    db.insert(S.emailTemplateOverrides).values({ id, workspaceId: id, name: 'workspace-invitation', subject: `${mark} subject`, text: `${mark} {{acceptUrl}}` }),
    db.insert(S.alertRules).values({ id, serviceId: id, name: `${mark}-alert-${n}`, metric: 'cpu', threshold: 90 }),
    db.insert(S.sessions).values({ id, userId: owner, jti: `${mark}-jti-${n}`, expiresAt: future }),
    db.insert(S.apiTokens).values({ id, userId: owner, name: `${mark}-tok-${n}`, hash: crypto.sha256(`${mark}-api-${n}`) }),
    db.insert(S.webauthnCredentials).values({ id, userId: owner, credentialId: `${mark}-cred-${n}`, publicKey: 'x', name: `${mark}-key` }),
    db.insert(S.logDrains).values({ id, name: `${mark}-drain-${n}`, url: 'https://logs.example.test/in', serviceId: id }),
    db.insert(S.domainTransfers).values({
      id,
      domainId: id,
      sourceUserId: owner,
      targetEmail: `target-${n}@${mark}.test`,
      tokenSha256: crypto.sha256(transferToken),
      expiresAt: future.getTime(),
    }),
  ]);
  return {
    n,
    ws: id,
    owner,
    project: id,
    environment: id,
    label: id,
    service: id,
    service2: id + 1,
    deployment: id,
    domain: id,
    envVar: id,
    projectEnvVar: id + 1,
    previewEnvVar: id,
    webhook: id,
    job: id,
    database: id,
    backup: id,
    dbAttachment: id,
    volAttachment: id,
    volumeName,
    invitation: id,
    member: id + 9,
    scimToken: id,
    scimSecret,
    alert: id,
    session: id,
    apiToken: id,
    passkey: id,
    logDrain: id,
    transferToken,
    inviteToken,
    serviceSlug,
    victim: id,
    victimEmail,
  };
}

/** Which seeded value a path parameter names, decided by the URL around it. */
function paramValue(url: string, param: string, r: Res): string {
  const at = (prefix: string) => url.startsWith(prefix);
  switch (param) {
    case 'depId':
      return String(r.deployment);
    case 'domainId':
      return String(r.domain);
    case 'varId':
      return String(at('/v1/projects') ? r.projectEnvVar : url.includes('/env/preview/') ? r.previewEnvVar : r.envVar);
    case 'hookId':
      return String(r.webhook);
    case 'jobId':
      return String(r.job);
    case 'attId':
      return String(url.includes('/volumes/') ? r.volAttachment : r.dbAttachment);
    case 'bid':
      return String(r.backup);
    case 'inviteId':
      return String(r.invitation);
    case 'memberId':
      return String(r.member);
    case 'wid':
      return String(r.ws);
    case 'projectId':
      return String(r.project);
    case 'name':
      if (at('/v1/workspaces')) return 'workspace-invitation';
      if (at('/v1/volumes')) return r.volumeName;
      if (at('/v1/networks')) return `nd-svc-${r.serviceSlug}`;
      return 'zz-name';
    case 'container':
      return `nd-app-${r.serviceSlug}`;
    case 'token':
      return at('/v1/invitations') ? r.inviteToken : r.transferToken;
    case 'slug':
      return 'zz-provider';
    case 'key':
      return 'zz.key';
    case 'stack':
      return 'zz-stack';
    case '*':
      return '';
    case 'id': {
      const table: Array<[string, string]> = [
        ['/v1/services', 'service'],
        ['/v1/ai/services', 'service'],
        ['/v1/databases', 'database'],
        ['/v1/projects', 'project'],
        ['/v1/workspaces', 'ws'],
        ['/v1/labels', 'label'],
        ['/v1/environments', 'environment'],
        ['/v1/alerts', 'alert'],
        ['/v1/domains', 'domain'],
        ['/v1/scim/tokens', 'scimToken'],
        ['/v1/auth/sessions', 'session'],
        ['/v1/auth/tokens', 'apiToken'],
        ['/v1/auth/passkey', 'passkey'],
        ['/v1/users', 'victim'],
        ['/v1/hooks', 'webhook'],
        ['/v1/log-drains', 'logDrain'],
        ['/scim/v2/Users', 'victim'],
        ['/v1/templates/community', '=zz-template'],
        ['/v1/templates', '=pocketbase'],
        ['/v1/plugins', '=notifications-dispatcher'],
      ];
      for (const [prefix, key] of table) {
        if (!at(prefix)) continue;
        return key.startsWith('=') ? key.slice(1) : String(r[key as keyof Res]);
      }
      return '999999';
    }
    default:
      throw new Error(`unmapped path parameter :${param} in ${url}`);
  }
}

const PARAM = /:([A-Za-z]+)|\*/g;
const paramCount = (url: string) => [...url.matchAll(PARAM)].filter((m) => m[1]).length;

/** Fill a route's parameters: the first from `parent`, the rest from `child`. */
function fill(url: string, parent: Res, child: Res = parent): string {
  let i = 0;
  return url.replace(PARAM, (_m, p: string | undefined) => paramValue(url, p ?? '*', i++ === 0 ? parent : child));
}

// ── classification ───────────────────────────────────────────────────────
/**
 * The minimum a caller needs, as the code enforces it:
 *   public    — no credential at all
 *   token     — no session needed; a secret in the URL/body/header/cookie is the credential
 *   self      — any signed-in user, acting only on their own account
 *   authed    — any signed-in user; list routes filter to what the caller may see
 *   viewer…owner — that workspace role on the resource (or its workspace)
 *   operator  — `users.is_instance_operator`
 *   scim      — a workspace SCIM bearer token
 */
type Floor = 'public' | 'token' | 'self' | 'authed' | Role | 'operator' | 'scim';
interface Rule {
  floor: Floor;
  /** Request body, built from the resource set the request targets. */
  body?: (r: Res) => unknown;
  /** Query string (without `?`). */
  query?: (r: Res) => string;
  /** Not exercised; the reason must say what covers it instead. */
  skip?: string;
  /** The at-floor call is not made (it would mutate state the whole file shares). */
  noPositive?: string;
  /** The at-floor call may 404 for a reason unrelated to access (missing catalog entry). */
  allow404?: string;
  /** Behaviour that is intentional but surprising — kept, and documented here. */
  note?: string;
  /** Extra statuses a mixed-ownership refusal may use (a 400 naming the bad body field). */
  mixedStatus?: number[];
}
const R = (floor: Floor, extra: Omit<Rule, 'floor'> = {}): Rule => ({ floor, ...extra });
const OP = R('operator');
const uniq = (r: Res, what: string) => `${what}-${r.n}-${++seq}`;

export const MATRIX: Record<string, Rule> = {
  // ── public & token-gated ──
  'GET /health': R('public'),
  'GET /v1/about': R('public'),
  'POST /v1/setup': R('public'),
  'GET /v1/auth/status': R('public'),
  'POST /v1/auth/login': R('public'),
  'POST /v1/auth/register': R('public'),
  'POST /v1/auth/refresh': R('public'),
  'POST /v1/auth/forgot-password': R('public'),
  'POST /v1/auth/reset-password': R('token'),
  'GET /v1/auth/oidc/providers/public': R('public'),
  'GET /v1/auth/oidc/:slug/login': R('public'),
  'GET /v1/auth/oidc/:slug/callback': R('token'),
  'POST /v1/auth/oidc/:slug/callback': R('token'),
  'POST /v1/auth/passkey/login/options': R('public'),
  'POST /v1/auth/passkey/login/verify': R('token'),
  'POST /v1/hooks/:id': R('token'),
  'POST /v1/servers/announce': R('token'),
  'GET /v1/invitations/:token': R('token'),
  'POST /v1/invitations/:token/accept': R('token'),
  'GET /v1/domain-transfers/:token': R('token'),
  'POST /v1/domain-transfers/:token/accept': R('token', { body: (r) => ({ targetServiceId: r.service }) }),
  'POST /v1/domain-transfers/:token/cancel': R('token'),
  'ALL /v1/databases/:id/studio-proxy': R('token', { note: 'operator-minted, path-scoped studio cookie is the credential' }),
  'ALL /v1/databases/:id/studio-proxy/*': R('token', { note: 'operator-minted, path-scoped studio cookie is the credential' }),
  'GET /scim/v2/Schemas': R('public'),
  'GET /scim/v2/ServiceProviderConfig': R('public'),
  'GET /scim/v2/Users': R('scim'),
  'POST /scim/v2/Users': R('scim'),
  'GET /scim/v2/Users/:id': R('scim'),
  'PUT /scim/v2/Users/:id': R('scim'),
  'PATCH /scim/v2/Users/:id': R('scim'),
  'DELETE /scim/v2/Users/:id': R('scim'),

  // ── WebSockets (the only skips) ──
  'GET /v1/events': R('authed', { skip: 'WebSocket — feed narrowing is covered by test/events.test.ts' }),
  'GET /v1/services/:id/deploys/:depId/logs': R('viewer', { skip: 'WebSocket — covered by the log-stream cases in test/deploys.test.ts' }),
  'GET /v1/services/:id/exec': R('operator', { skip: 'WebSocket — covered by the exec cases in test/deploys.test.ts' }),

  // ── own account ──
  'GET /v1/auth/me': R('self'),
  'POST /v1/auth/logout': R('self'),
  'POST /v1/auth/password': R('self'),
  'POST /v1/auth/2fa/setup': R('self', { noPositive: 'step-up: needs the current password' }),
  'POST /v1/auth/2fa/enable': R('self'),
  'POST /v1/auth/2fa/disable': R('self'),
  'GET /v1/auth/passkey': R('self'),
  'DELETE /v1/auth/passkey/:id': R('self'),
  'POST /v1/auth/passkey/register/options': R('self', { noPositive: 'step-up: needs the current password' }),
  'POST /v1/auth/passkey/register/verify': R('self'),
  'GET /v1/auth/sessions': R('self'),
  'DELETE /v1/auth/sessions/:id': R('self'),
  'GET /v1/auth/token': R('self'),
  'GET /v1/auth/tokens': R('self'),
  'POST /v1/auth/tokens': R('self', { body: () => ({ name: 'ci' }) }),
  'DELETE /v1/auth/tokens/:id': R('self'),
  'POST /v1/auth/oidc/:slug/link': R('self', { allow404: 'no OIDC provider is configured' }),

  // ── any signed-in user (lists filter by visibility) ──
  'GET /v1/services': R('authed'),
  'GET /v1/services/queue': R('authed'),
  'GET /v1/databases': R('authed'),
  'GET /v1/projects': R('authed'),
  'GET /v1/workspaces': R('authed'),
  'POST /v1/workspaces': R('authed', { body: (r) => ({ name: uniq(r, 'team') }) }),
  'GET /v1/labels': R('authed'),
  'GET /v1/environments': R('authed'),
  'GET /v1/alerts': R('authed'),
  'GET /v1/backups': R('authed'),
  'GET /v1/dashboard': R('authed'),
  'GET /v1/domains': R('authed'),
  'GET /v1/topology': R('authed'),
  'GET /v1/stats': R('authed'),
  'GET /v1/env/search': R('authed', { query: () => `q=${MARK_A.toUpperCase()}` }),
  'GET /v1/menus': R('authed'),
  'GET /v1/plugins': R('authed'),
  'GET /v1/plugins/marketplace': R('authed'),
  'GET /v1/plugins/:id/inspect': R('authed', { allow404: 'built-in plugins are not inspectable' }),
  'GET /v1/templates': R('authed'),
  'GET /v1/templates/:id': R('authed'),
  'GET /v1/templates/community': R('authed'),
  'GET /v1/branding': R('authed'),
  'GET /v1/build-cache/stats': R('authed'),
  'GET /v1/domain-presets': R('authed'),
  'GET /v1/metric-history': R('authed'),
  'GET /v1/ai/config': R('authed'),
  'GET /v1/traefik': R('authed', { note: 'non-operators get container status only; routers/certs are operator-only' }),
  'POST /v1/insights': R('authed', {
    body: () => ({ repoUrl: 'https://github.com/example/app.git' }),
    note: 'r711: a "member" seat somewhere (or operator), as for POST /v1/services — the outsider gets 403 (rate-limited 10/min)',
  }),
  'GET /v1/sso/:name/login': R('authed', { note: 'documented in sso.ts: login/callback stay authentication-only' }),
  'GET /v1/sso/:name/callback': R('authed', { note: 'documented in sso.ts: login/callback stay authentication-only' }),
  'POST /v1/sso/:name/saml-callback': R('authed', { note: 'answers saml_unavailable to everyone' }),

  // ── workspaces ──
  'GET /v1/workspaces/:id': R('viewer'),
  'PATCH /v1/workspaces/:id': R('admin', { body: () => ({ description: 'renamed' }) }),
  'DELETE /v1/workspaces/:id': R('owner', {
    note: "its services lose their tags and become their creators' personal services; its projects' databases likewise",
  }),
  'GET /v1/workspaces/:id/invitations': R('admin'),
  'POST /v1/workspaces/:id/invitations': R('admin', { body: (r) => ({ email: `new-${r.n}-${++seq}@x.test`, role: 'member' }) }),
  'DELETE /v1/workspaces/:id/invitations/:inviteId': R('admin'),
  'POST /v1/workspaces/:id/members': R('admin', { body: () => ({ email: 'outsider@other.test', role: 'member' }) }),
  'PATCH /v1/workspaces/:id/members/:memberId': R('admin', { body: () => ({ role: 'viewer' }) }),
  'DELETE /v1/workspaces/:id/members/:memberId': R('admin'),
  'GET /v1/workspaces/:wid/email-templates': R('member'),
  'POST /v1/workspaces/:wid/email-templates/preview': R('member', { body: () => ({ name: 'workspace-invitation', vars: {} }) }),
  'PUT /v1/workspaces/:wid/email-templates/:name': R('admin', { body: () => ({ subject: 'Join', text: 'Join us: {{acceptUrl}}' }) }),
  'DELETE /v1/workspaces/:wid/email-templates/:name': R('admin'),

  // ── projects, labels, environments ──
  'POST /v1/projects': R('member', { body: (r) => ({ name: uniq(r, 'proj'), workspaceId: r.ws }) }),
  'PATCH /v1/projects/:id': R('admin', { body: (r) => ({ description: 'changed', workspaceId: r.ws }) }),
  'DELETE /v1/projects/:id': R('admin'),
  'GET /v1/projects/:id/env': R('viewer'),
  'POST /v1/projects/:id/env': R('member', { body: () => ({ key: 'NEW_KEY', value: 'v' }) }),
  'PATCH /v1/projects/:id/env/:varId': R('member', { body: () => ({ key: `${MARK_A.toUpperCase()}_PKEY`, value: 'v2' }) }),
  'DELETE /v1/projects/:id/env/:varId': R('member'),
  'POST /v1/labels': R('member', { body: (r) => ({ name: uniq(r, 'label'), workspaceId: r.ws }) }),
  'PATCH /v1/labels/:id': R('member', { body: () => ({ color: 'emerald' }) }),
  'DELETE /v1/labels/:id': R('member', { note: 'a member may delete a label every service in the workspace shares' }),
  'POST /v1/environments': R('member', { body: (r) => ({ name: uniq(r, 'env'), workspaceId: r.ws }) }),
  'PATCH /v1/environments/:id': R('member', { body: (r) => ({ name: uniq(r, 'env') }) }),
  'DELETE /v1/environments/:id': R('admin'),

  // ── services ──
  'POST /v1/services': R('member', {
    body: (r) => ({
      name: uniq(r, 'svc'),
      image: 'nginx:alpine',
      port: 80,
      tagWorkspaceIds: [r.ws],
      tagProjectIds: [r.project],
      tagLabelIds: [r.label],
      environmentId: r.environment,
    }),
  }),
  'GET /v1/services/:id': R('viewer'),
  'PATCH /v1/services/:id': R('member', { body: (r) => ({ healthPath: '/healthz', environmentId: r.environment }) }),
  'DELETE /v1/services/:id': R('admin', {
    note: 'the seated creator is the service owner, so a member who created a service may delete it (the RBAC doc table says admin)',
  }),
  'POST /v1/services/:id/clone': R('admin', { body: (r) => ({ name: uniq(r, 'clone') }) }),
  'GET /v1/services/:id/export': OP,
  'POST /v1/services/import': OP,
  'POST /v1/services/compose/preview': OP,
  'PATCH /v1/services/:id/limits': R('member', { body: () => ({ memLimitMb: 256 }) }),
  'POST /v1/services/:id/start': R('member'),
  'POST /v1/services/:id/stop': R('member'),
  'POST /v1/services/:id/restart': R('member'),
  'GET /v1/services/:id/logs': R('viewer'),
  'POST /v1/log-drains/search': R('member', { body: (r) => ({ query: 'error', serviceId: r.service }) }),
  'GET /v1/services/:id/metrics': R('viewer'),
  'POST /v1/services/:id/sticky-session': R('admin', { body: () => ({ enabled: true }) }),
  'GET /v1/services/:id/tags': R('viewer'),
  'PUT /v1/services/:id/tags': R('admin', {
    body: (r) => ({ workspaceIds: [r.ws], projectIds: [r.project], labelIds: [r.label] }),
  }),
  'GET /v1/services/:id/targets': R('viewer'),
  'PATCH /v1/services/:id/targets': R('operator', { body: () => ({ serverIds: [] }) }),
  'POST /v1/services/:id/manifest/apply': OP,
  'GET /v1/services/:id/insights': R('viewer'),
  'POST /v1/services/:id/insights/refresh': R('member'),
  'POST /v1/services/:id/promote': R('member', { body: (r) => ({ targetServiceId: r.service2 }) }),
  'GET /v1/services/:id/deploys': R('viewer'),
  'POST /v1/services/:id/deploys': R('member', { body: () => ({}) }),
  'DELETE /v1/services/:id/deploys/:depId': R('admin'),
  'POST /v1/services/:id/deploys/:depId/cancel': R('member'),
  'POST /v1/services/:id/deploys/:depId/rollback': R('member'),
  'GET /v1/services/:id/deploys/:depId/diff': R('viewer'),
  'GET /v1/services/:id/deploys/:depId/logs/download': R('viewer'),
  'GET /v1/services/:id/domains': R('viewer'),
  'POST /v1/services/:id/domains': R('member', { body: (r) => ({ hostname: `${uniq(r, 'new')}.example.test` }) }),
  'PATCH /v1/services/:id/domains/:domainId': R('member', { body: () => ({ ssl: true }) }),
  'DELETE /v1/services/:id/domains/:domainId': R('member'),
  'GET /v1/services/:id/domains/:domainId/dns': R('viewer'),
  'POST /v1/services/:id/domains/:domainId/verify': R('member'),
  'PATCH /v1/domains/:id': R('member', { body: () => ({ ssl: true }) }),
  'POST /v1/domains/:id/transfer': R('admin', { body: () => ({ targetEmail: 'someone@else.test' }) }),
  'GET /v1/services/:id/env': R('viewer'),
  'POST /v1/services/:id/env': R('member', { body: () => ({ key: 'NEW_KEY', value: 'v' }) }),
  'PATCH /v1/services/:id/env/:varId': R('member', { body: () => ({ key: `${MARK_A.toUpperCase()}_KEY`, value: 'v2' }) }),
  'DELETE /v1/services/:id/env/:varId': R('member'),
  'GET /v1/services/:id/env/export': R('admin'),
  'POST /v1/services/:id/env/import': R('member', { body: () => ({ content: 'IMPORTED=1' }) }),
  // 0.12 preview-only env: the same floors as the service env routes above.
  'GET /v1/services/:id/env/preview': R('viewer'),
  'POST /v1/services/:id/env/preview': R('member', { body: () => ({ key: 'NEW_PREVIEW_KEY', value: 'v' }) }),
  'PATCH /v1/services/:id/env/preview/:varId': R('member', { body: () => ({ key: `${MARK_A.toUpperCase()}_VKEY`, value: 'v2' }) }),
  'DELETE /v1/services/:id/env/preview/:varId': R('member'),
  'GET /v1/services/:id/attachments': R('viewer'),
  'POST /v1/services/:id/attachments': R('admin', { body: (r) => ({ databaseId: r.database, envAlias: 'OTHER_DB' }) }),
  'DELETE /v1/services/:id/attachments/:attId': R('member', { note: 'detaching is member; attaching needs admin on the database' }),
  'GET /v1/services/:id/volumes': R('viewer'),
  'POST /v1/services/:id/volumes': R('member', { body: (r) => ({ volumeName: r.volumeName, containerPath: '/shared' }) }),
  'PATCH /v1/services/:id/volumes/:attId': R('member', { body: () => ({ readOnly: true }) }),
  'DELETE /v1/services/:id/volumes/:attId': R('admin'),
  'POST /v1/services/:id/volumes/config-repair': R('member', { body: (r) => ({ filePath: 'config.php', attachmentId: r.volAttachment }) }),
  'GET /v1/services/:id/webhooks': R('viewer'),
  'POST /v1/services/:id/webhooks': R('admin', { body: () => ({ branch: 'main' }) }),
  'DELETE /v1/services/:id/webhooks/:hookId': R('admin'),
  'GET /v1/services/:id/jobs': R('viewer'),
  'POST /v1/services/:id/jobs': R('member', { body: (r) => ({ name: uniq(r, 'job'), cron: '0 4 * * *', kind: 'deploy' }) }),
  'PATCH /v1/services/:id/jobs/:jobId': R('member', { body: () => ({ enabled: false }) }),
  'DELETE /v1/services/:id/jobs/:jobId': R('member'),
  'POST /v1/services/:id/jobs/:jobId/run': R('member'),
  'GET /v1/services/:id/jobs/:jobId/runs': R('viewer'),
  'POST /v1/ai/services/:id/deploys/:depId/diagnose': R('operator', {
    note: 'operator by default; the AI allowlist setting opens it to named workspaces',
  }),
  'POST /v1/ai/suggest-manifest': R('operator', { note: 'operator by default; widened by the AI allowlist' }),
  'PUT /v1/ai/config': OP,
  'POST /v1/templates/:id/prepare': R('member', { body: (r) => ({ name: uniq(r, 'tpl'), projectId: r.project }) }),
  'POST /v1/templates/:id/deploy': R('member', { body: (r) => ({ name: uniq(r, 'tpl'), projectId: r.project }) }),

  // ── databases & backups ──
  'POST /v1/databases': R('member', { body: (r) => ({ name: uniq(r, 'db'), engine: 'postgres', projectId: r.project }) }),
  'GET /v1/databases/:id': R('viewer'),
  'DELETE /v1/databases/:id': R('admin'),
  'GET /v1/databases/:id/logs': R('viewer'),
  'GET /v1/databases/:id/storage': R('viewer'),
  'PATCH /v1/databases/:id/limits': R('member', { body: () => ({ memLimitMb: 256 }) }),
  'POST /v1/databases/:id/start': R('member'),
  'POST /v1/databases/:id/stop': R('member'),
  'POST /v1/databases/:id/restart': R('member'),
  'GET /v1/databases/:id/credentials': R('admin'),
  'GET /v1/databases/:id/backups': R('viewer'),
  'POST /v1/databases/:id/backups': R('admin'),
  'POST /v1/databases/:id/backups/:bid/restore': R('admin'),
  'POST /v1/databases/:id/backups/drill': R('member', {
    body: (r) => ({ backupId: r.backup }),
    note: 'member may drill (restore into a scratch container) a backup only an admin may take or download',
  }),
  'GET /v1/databases/:id/drills': R('viewer'),
  // 0.12 per-database backup policy: read follows the backups list, write the backup routes.
  'GET /v1/databases/:id/backup-policy': R('viewer'),
  'PUT /v1/databases/:id/backup-policy': R('admin', { body: () => ({ enabled: true, cron: '0 3 * * *', retainCount: 7 }) }),
  'GET /v1/databases/:id/pgbouncer': R('member'),
  'POST /v1/databases/:id/pgbouncer/enable': OP,
  'POST /v1/databases/:id/pgbouncer/disable': OP,
  'POST /v1/databases/:id/studio': OP,
  'DELETE /v1/databases/:id/studio': OP,
  'DELETE /v1/backups/:bid': R('admin'),
  'GET /v1/backups/:bid/download': R('admin'),
  'GET /v1/volumes/:name/backups': R('viewer'),

  // ── instance operator ──
  'GET /v1/activity': OP,
  'POST /v1/alerts': OP,
  'PATCH /v1/alerts/:id': OP,
  'DELETE /v1/alerts/:id': OP,
  'GET /v1/auth/oidc/providers': OP,
  'POST /v1/auth/oidc/providers': OP,
  'PATCH /v1/auth/oidc/providers/:id': OP,
  'DELETE /v1/auth/oidc/providers/:id': OP,
  'GET /v1/backup-destinations': OP,
  'POST /v1/backup-destinations': OP,
  'PATCH /v1/backup-destinations/:id': OP,
  'DELETE /v1/backup-destinations/:id': OP,
  'POST /v1/backup-destinations/:id/test': OP,
  'PATCH /v1/branding': OP,
  'POST /v1/build-cache/store': OP,
  'GET /v1/config': OP,
  'GET /v1/config/:key': OP,
  'POST /v1/config/:key': OP,
  'DELETE /v1/config/:key': OP,
  'GET /v1/config-presets': OP,
  'POST /v1/config-presets': OP,
  'GET /v1/config-presets/:id': OP,
  'DELETE /v1/config-presets/:id': OP,
  'PUT /v1/config-presets/:id/apply': OP,
  'GET /v1/containers/:container/inspect': OP,
  'GET /v1/containers/:container/compose': OP,
  'GET /v1/containers/:container/files': OP,
  'GET /v1/containers/:container/files/content': OP,
  'PUT /v1/containers/:container/files': OP,
  'POST /v1/containers/:container/files/dir': OP,
  'DELETE /v1/containers/:container/files': OP,
  'POST /v1/demo/seed': R('operator', { noPositive: 'seeds demo rows into the database every case shares' }),
  'GET /v1/doctor': OP,
  'POST /v1/doctor/fix': OP,
  'POST /v1/domain-presets/apply': OP,
  'GET /v1/egress': OP,
  'POST /v1/egress': OP,
  'DELETE /v1/egress/:projectId': OP,
  'GET /v1/firewall': OP,
  'POST /v1/firewall/recommended': OP,
  'POST /v1/firewall/rules': OP,
  'DELETE /v1/firewall/rules/:id': OP,
  'POST /v1/firewall/toggle': OP,
  'GET /v1/housekeeping/images': OP,
  'POST /v1/housekeeping/images/prune': OP,
  'POST /v1/housekeeping/prune': OP,
  'GET /v1/housekeeping/prune/config': OP,
  'PATCH /v1/housekeeping/prune/config': OP,
  'GET /v1/log-drains': OP,
  'POST /v1/log-drains': OP,
  'GET /v1/log-drains/:id': OP,
  'PATCH /v1/log-drains/:id': OP,
  'DELETE /v1/log-drains/:id': OP,
  'POST /v1/log-drains/:id/test': OP,
  'POST /v1/metric-history/flush': OP,
  'GET /v1/networks': OP,
  'POST /v1/networks': OP,
  'DELETE /v1/networks/:name': OP,
  'GET /v1/networks/:name/members': OP,
  'POST /v1/networks/attach': OP,
  'POST /v1/networks/detach': OP,
  'GET /v1/notifications/channels': OP,
  'POST /v1/notifications/channels': OP,
  'PATCH /v1/notifications/channels/:id': OP,
  'DELETE /v1/notifications/channels/:id': OP,
  'POST /v1/notifications/channels/:id/test': OP,
  'GET /v1/notifications/log': OP,
  'GET /v1/orchestrators': OP,
  'GET /v1/orchestrators/:name/stacks': OP,
  'GET /v1/orchestrators/:name/stacks/:stack': OP,
  'POST /v1/plugins/install': OP,
  'POST /v1/plugins/marketplace/refresh': OP,
  'POST /v1/plugins/:id/enable': OP,
  'POST /v1/plugins/:id/disable': R('operator', { noPositive: 'disabling a built-in plugin changes the kernel every case shares' }),
  'POST /v1/plugins/:id/reload': OP,
  'POST /v1/plugins/:id/uninstall': OP,
  'GET /v1/scim/tokens': R('operator', { note: 'SCIM tokens carry a workspace, but managing them is operator-only' }),
  'POST /v1/scim/tokens': R('operator', { note: 'SCIM tokens carry a workspace, but managing them is operator-only' }),
  'DELETE /v1/scim/tokens/:id': R('operator', { note: 'SCIM tokens carry a workspace, but managing them is operator-only' }),
  'GET /v1/servers': OP,
  'POST /v1/servers': OP,
  'DELETE /v1/servers/:id': OP,
  'POST /v1/servers/:id/approve': OP,
  'POST /v1/servers/:id/reject': OP,
  'POST /v1/servers/:id/test': OP,
  'GET /v1/servers/:id/stats': OP,
  'GET /v1/servers/:id/bootstrap-logs': OP,
  'POST /v1/servers/ssh-bootstrap': OP,
  'POST /v1/servers/ssh-test': OP,
  'GET /v1/settings': OP,
  'PUT /v1/settings/acme-email': OP,
  'PUT /v1/settings/allow-registration': OP,
  'PUT /v1/settings/dns': OP,
  'GET /v1/settings/dns-records': OP,
  'PUT /v1/settings/dns-records': OP,
  'GET /v1/settings/dns-records/namecheap': OP,
  'PUT /v1/settings/dns-records/namecheap': OP,
  'POST /v1/settings/dns-records/test': OP,
  'GET /v1/settings/domain-policy': OP,
  'PUT /v1/settings/domain-policy': OP,
  'GET /v1/settings/enrolment': OP,
  'POST /v1/settings/enrolment/rotate': OP,
  'DELETE /v1/settings/enrolment': OP,
  'GET /v1/settings/master-key': OP,
  'POST /v1/settings/master-key/rotate': R('operator', { noPositive: 'rotating the master key re-encrypts the database every case shares' }),
  'PUT /v1/settings/panel-domain': OP,
  'PUT /v1/settings/templates-source': OP,
  'GET /v1/settings/vault': OP,
  'PUT /v1/settings/vault': OP,
  'PUT /v1/settings/vault/allowlist': OP,
  'POST /v1/settings/vault/test': OP,
  'GET /v1/sources': OP,
  'POST /v1/sources': OP,
  'PATCH /v1/sources/:id': OP,
  'DELETE /v1/sources/:id': OP,
  'GET /v1/sources/:id/branches': OP,
  'GET /v1/sources/:id/repos': OP,
  'GET /v1/sources/:id/test': OP,
  'POST /v1/sources/:id/generate-deploy-key': OP,
  'GET /v1/sso/providers': OP,
  'POST /v1/sso/providers': OP,
  'DELETE /v1/sso/providers/:id': OP,
  'GET /v1/system/resources': OP,
  'GET /v1/system/docker-events': OP,
  'GET /v1/system/export': OP,
  'POST /v1/system/import': OP,
  'POST /v1/system/prune-images': OP,
  'GET /v1/system/update-check': OP,
  'POST /v1/system/update-start': OP,
  'GET /v1/system/update-status': OP,
  'GET /v1/system/panel-backup': OP,
  'PUT /v1/system/panel-backup': OP,
  'POST /v1/system/panel-backup/run': OP,
  'GET /v1/system/panel-backup/remote': OP,
  'POST /v1/system/panel-backup/restore': OP,
  'DELETE /v1/templates/community/:id': OP,
  'POST /v1/templates/community/import': OP,
  'POST /v1/traefik/backup-certs': OP,
  'GET /v1/traefik/certificates': OP,
  'GET /v1/traefik/certificates/expiring': OP,
  'GET /v1/traefik/certificates/inventory': OP,
  'GET /v1/traefik/config': OP,
  'GET /v1/traefik/logs': OP,
  'POST /v1/traefik/restart': OP,
  'GET /v1/traefik/status': OP,
  'POST /v1/traefik/update': OP,
  'GET /v1/traefik/version': OP,
  'GET /v1/tunnels': OP,
  'POST /v1/tunnels': OP,
  'DELETE /v1/tunnels/:id': OP,
  'GET /v1/users': OP,
  'POST /v1/users': OP,
  'DELETE /v1/users/:id': OP,
  'PATCH /v1/users/:id/operator': OP,
  'PATCH /v1/users/:id/password': OP,
  'POST /v1/users/:id/reset-link': OP,
  'GET /v1/volumes': OP,
  'POST /v1/volumes/prune': OP,
  'DELETE /v1/volumes/:name': OP,
  'POST /v1/volumes/:name/backups': OP,
  'POST /v1/volumes/:name/backups/:bid/restore': OP,
  'GET /v1/volumes/:name/backups/:bid/download': OP,
  'GET /v1/volumes/:name/files': OP,
  'GET /v1/volumes/:name/files/content': OP,
  'PUT /v1/volumes/:name/files': OP,
  'POST /v1/volumes/:name/files/dir': OP,
  'DELETE /v1/volumes/:name/files': OP,
};

// ── harness ──────────────────────────────────────────────────────────────
interface Reply {
  status: number;
  body: string;
}

async function call(who: Who, method: string, url: string, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (who !== 'anon') {
    // Minted per call from the live row: a logout or password route bumps
    // tokenVersion, which must not lock the identity out of later routes.
    const row = await db.query.users.findFirst({ where: (t, { eq }) => eq(t.id, ids[who]) });
    headers['authorization'] = `Bearer ${await signAccessToken(ids[who], row?.tokenVersion ?? 0)}`;
  }
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers,
    ...(body !== undefined && method !== 'GET' && method !== 'DELETE' ? { payload: body as object } : {}),
  });
  return { status: res.statusCode, body: res.body };
}

const errorText = (r: Reply) => {
  try {
    return (JSON.parse(r.body) as { error?: { message?: string } }).error?.message ?? r.body.slice(0, 120);
  } catch {
    return r.body.slice(0, 120);
  }
};

/**
 * Write journal: an AFTER INSERT/UPDATE/DELETE trigger on every table except
 * the append-only audit trail records the table name, whichever connection
 * wrote it. `mark()` → call → `writesSince(mark)` names every table a request
 * touched — including a write it later undid by hand.
 */
interface Mark {
  row: number;
  effect: number;
}
async function mark(): Promise<Mark> {
  const [row] = (await db.all(S.sql.raw('SELECT coalesce(max(rowid), 0) AS m FROM authz_writes'))) as Array<{ m: number }>;
  return { row: row!.m, effect: hoisted.effects.length };
}
/** Tables written and outside effects attempted since `m`. */
async function writesSince(m: Mark, ignore: string[] = []): Promise<string[]> {
  const rows = (await db.all(S.sql.raw(`SELECT DISTINCT tbl FROM authz_writes WHERE rowid > ${m.row}`))) as Array<{ tbl: string }>;
  const effects = [...new Set(hoisted.effects.slice(m.effect))].map((e) => `[${e}]`);
  return [...rows.map((r) => r.tbl).filter((t) => !ignore.includes(t)), ...effects];
}

interface RouteEntry {
  key: string;
  method: string;
  url: string;
}
function liveRoutes(): RouteEntry[] {
  const out = new Map<string, RouteEntry>();
  for (const r of hoisted.routes) {
    const methods = [r.method].flat();
    // A catch-all proxy registers every verb; one classification covers it.
    if (methods.length > 3) {
      out.set(`ALL ${r.url}`, { key: `ALL ${r.url}`, method: 'GET', url: r.url });
      continue;
    }
    for (const m of methods) {
      // HEAD mirrors GET; `OPTIONS *` is the CORS preflight.
      if (m === 'HEAD' || (m === 'OPTIONS' && r.url === '*')) continue;
      out.set(`${m} ${r.url}`, { key: `${m} ${r.url}`, method: m, url: r.url });
    }
  }
  return [...out.values()].sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
}

/** True when a body/query builder names resource ids — such a body gets a mixed-ownership variant. */
function readsIds(fn: ((r: Res) => unknown) | undefined): boolean {
  if (!fn) return false;
  const seen = new Set<string>();
  const probe = new Proxy({} as Res, {
    get: (_t, k) => {
      seen.add(String(k));
      return typeof k === 'string' && /Name|Token|Slug|Email|Secret/.test(k) ? 'x' : 1;
    },
  });
  fn(probe);
  return [...seen].some((k) => k !== 'n');
}

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const isRoleFloor = (f: Floor): f is Role => f in RANK;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DOCKER_HOST', 'tcp://127.0.0.1:9');
  vi.stubEnv('NINEDEPLOY_DATA_DIR', tmp);
  vi.stubEnv('NINEDEPLOY_DB_PATH', path.join(tmp, 'nd.db'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: unknown) => {
      hoisted.effects.push(`fetch ${String(u).slice(0, 60)}`);
      throw new Error('network disabled in authz matrix');
    }),
  );
  mkdirSync(path.join(tmp, 'logs'), { recursive: true });
  mkdirSync(path.join(tmp, 'backups'), { recursive: true });
  const mod = await import('../src/app.js');
  app = await mod.buildApp();
  // ~4k requests: request logging would bury the suite's output.
  app.log.level = 'silent';
  await app.ready();
  db = (app as unknown as { db: DB }).db;
  S = await import('@ninedeploy/db');
  crypto = await import('../src/lib/crypto.js');
  signAccessToken = (await import('../src/lib/jwt.js')).signAccessToken;
  const user = async (key: Named, operator = false) => {
    // The leaver's own account is not workspace A data — only what they created there is.
    const domain = key === 'leaverA' ? 'other' : key.endsWith('A') ? MARK_A : key.endsWith('B') ? MARK_B : 'other';
    const [row] = await db
      .insert(S.users)
      .values({ email: `${key.toLowerCase()}@${domain}.test`, passwordHash: 'x', name: key, isInstanceOperator: operator })
      .returning();
    ids[key] = row!.id;
  };
  await user('operator', true);
  for (const side of ['A', 'B'] as const) for (const role of ROLES) await user(`${role}${side}`);
  await user('outsider');
  await user('leaverA');
  const rows = (await db.all(
    S.sql.raw(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`),
  )) as Array<{ name: string }>;
  await db.run(S.sql.raw('PRAGMA synchronous = OFF'));
  await db.run(S.sql.raw('CREATE TABLE authz_writes (tbl TEXT NOT NULL)'));
  for (const { name } of rows) {
    if (name === 'audit_log') continue;
    for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
      await db.run(
        S.sql.raw(`CREATE TRIGGER "authz_${op}_${name}" AFTER ${op} ON "${name}" BEGIN INSERT INTO authz_writes (tbl) VALUES ('${name}'); END`),
      );
    }
  }
  B = await seed('B');
}, 60_000);

afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

describe('authorization matrix (r690)', () => {
  it('classifies every registered route — a new route must be added to MATRIX with its floor', () => {
    const live = liveRoutes();
    expect(live.length).toBeGreaterThan(300);
    const missing = live.filter((r) => !(r.key in MATRIX)).map((r) => r.key);
    expect(missing, 'unclassified routes').toEqual([]);
    const stale = Object.keys(MATRIX).filter((k) => !live.some((r) => r.key === k));
    expect(stale, 'MATRIX entries for routes that no longer exist').toEqual([]);
  });

  it('keeps the skip list short and justified', () => {
    const skipped = Object.values(MATRIX).filter((r) => r.skip);
    expect(skipped.length).toBeLessThanOrEqual(3);
    for (const r of skipped) expect(r.skip).toMatch(/covered by/);
  });

  const CASES = Object.entries(MATRIX)
    .filter(([, r]) => !r.skip)
    .map(([key, rule]) => ({ key, rule }));

  // A loop, not it.each: it.each's $key interpolation truncates long names.
  for (const { key, rule } of CASES) it(key, async () => {
    const [method, url] = key.split(' ') as [string, string];
    const verb = method === 'ALL' ? 'GET' : method;
    const params = paramCount(url);
    const problems: string[] = [];
    const A = await seed('A');
    // A list route also gets every filter a list understands, pointed at A:
    // a filter must narrow what the caller may see, never widen it.
    const query = (r: Res) =>
      rule.query
        ? rule.query(r)
        : rule.floor === 'authed' && verb === 'GET' && params === 0
          ? `workspaceId=${r.ws}&projectId=${r.project}&serviceId=${r.service}&environmentId=${r.environment}&tagProjectIds=${r.project}&tagWorkspaceIds=${r.ws}&tagLabelIds=${r.label}`
          : '';
    const urlFor = (parent: Res, child: Res = parent) => {
      const q = query(child);
      return `${fill(url, parent, child)}${q ? `?${q}` : ''}`;
    };
    const bodyFor = (r: Res) => (rule.body ? rule.body(r) : verb === 'GET' || verb === 'DELETE' ? undefined : {});
    const leak = (who: Who, res: Reply) => {
      // A token route answers whoever holds the secret — that is its design.
      if (rule.floor !== 'token' && res.status < 300 && res.body.includes(MARK_A)) {
        problems.push(`${who}: a 2xx response carries workspace A data`);
      }
    };

    // 1. no credential
    if (rule.floor !== 'public' && rule.floor !== 'token' && rule.floor !== 'scim') {
      const res = await call('anon', verb, urlFor(A), bodyFor(A));
      if (res.status !== 401) problems.push(`anon: expected 401, got ${res.status} (${errorText(res)})`);
    } else if (rule.floor === 'token' && url.includes(':token')) {
      const res = await call('anon', verb, url.replace(':token', 'zz-not-a-real-token-000000000000000000000000'), bodyFor(A));
      if (res.status < 400) problems.push(`anon with a bogus token: expected 4xx, got ${res.status}`);
    }

    if (rule.floor === 'scim') {
      if (params > 0) {
        const m = await mark();
        const res = await app.inject({
          method: verb as 'GET',
          url: urlFor(A),
          headers: { authorization: `Bearer ${B.scimSecret}` },
          ...(verb !== 'GET' && verb !== 'DELETE' ? { payload: { Operations: [{ op: 'replace', path: 'active', value: false }] } } : {}),
        });
        if (res.statusCode !== 404) problems.push(`B's SCIM token on A's user: expected 404, got ${res.statusCode}`);
        // B's own token row stamps its last use; nothing else may move.
        const changed = await writesSince(m, ['scim_tokens']);
        if (changed.length) problems.push(`B's SCIM token on A's user wrote: ${changed.join(', ')}`);
      } else if (verb === 'GET') {
        const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${B.scimSecret}` } });
        if (res.body.includes(MARK_A)) problems.push(`B's SCIM token lists workspace A users`);
      }
      const anon = await app.inject({ method: verb as 'GET', url: urlFor(A) });
      if (anon.statusCode !== 401) problems.push(`anon SCIM: expected 401, got ${anon.statusCode}`);
    }

    // 2. cross-tenant: every B identity and the outsider, A's ids everywhere
    if (rule.floor !== 'public' && rule.floor !== 'scim') {
      const targetsA = params > 0 || readsIds(rule.body) || readsIds(rule.query);
      const whos: Who[] = rule.floor === 'self' && params > 0 ? [...OTHERS, 'adminA', 'operator'] : OTHERS;
      const m = await mark();
      for (const who of whos) {
        const res = await call(who, verb, urlFor(A), bodyFor(A));
        leak(who, res);
        if (targetsA && res.status >= 500) problems.push(`${who} on A's ids: ${res.status} (${errorText(res)})`);
        else if (targetsA && rule.floor !== 'token' && rule.floor !== 'authed' && ![403, 404].includes(res.status)) {
          problems.push(`${who} on A's ids: expected 403/404, got ${res.status} (${errorText(res)})`);
        } else if (rule.floor === 'token' && verb !== 'GET' && res.status < 400) {
          // Holding A's secret is not enough to ACT on it as someone else
          // (accept an invitation or a domain transfer meant for A's user).
          problems.push(`${who} with A's secret: expected 4xx, got ${res.status} (${errorText(res)})`);
        }
      }
      if (targetsA) {
        const changed = await writesSince(m);
        if (changed.length) problems.push(`cross-tenant calls wrote: ${changed.join(', ')}`);
      }
    }

    // 3. mixed ownership: B's owner, B's own parent, A's child / A's ids in the body
    if (isRoleFloor(rule.floor) || rule.floor === 'token') {
      const variants: Array<[string, string, unknown]> = [];
      // Only when a child parameter actually names a different row in A.
      if (params > 1 && fill(url, B, A) !== fill(url, B, B)) variants.push(["B's parent + A's child", urlFor(B, A), bodyFor(B)]);
      if (readsIds(rule.body)) variants.push(["B's resource + A's ids in the body", urlFor(B), bodyFor(A)]);
      for (const [label, u, b] of variants) {
        const m = await mark();
        const res = await call('ownerB', verb, u, b);
        leak('ownerB', res);
        if (![403, 404].includes(res.status) && !(rule.mixedStatus ?? []).includes(res.status)) {
          problems.push(`ownerB, ${label}: expected 403/404, got ${res.status} (${errorText(res)})`);
        }
        const changed = await writesSince(m);
        if (changed.length) problems.push(`ownerB, ${label}: wrote ${changed.join(', ')}`);
      }
    }

    // 4. role floor inside workspace A
    if (isRoleFloor(rule.floor) || rule.floor === 'operator') {
      const floor = rule.floor;
      const below: Who[] =
        floor === 'operator'
          ? ['ownerA', 'adminA', 'memberA', 'viewerA']
          : ROLES.filter((r) => RANK[r] < RANK[floor]).map((r) => `${r}A` as Who);
      const m = await mark();
      for (const who of below) {
        const res = await call(who, verb, urlFor(A), bodyFor(A));
        if (![403, 404].includes(res.status)) {
          problems.push(`${who}, below the "${floor}" floor: expected 403/404, got ${res.status} (${errorText(res)})`);
        }
      }
      const changed = await writesSince(m);
      if (changed.length) problems.push(`below-floor calls wrote: ${changed.join(', ')}`);
    }
    const positive = !rule.noPositive && !['public', 'token', 'scim'].includes(rule.floor);
    if (positive) {
      const at: Who =
        rule.floor === 'operator' ? 'operator' : rule.floor === 'authed' ? 'outsider' : rule.floor === 'self' ? 'ownerA' : (`${rule.floor}A` as Who);
      const res = await call(at, verb, urlFor(A), bodyFor(A));
      // An operator passes every loader, so a 404 there is a missing
      // instance-level fixture (no source/tunnel/server rows), not a denial.
      const refused =
        res.status === 401 || res.status === 403 || (res.status === 404 && params > 0 && !rule.allow404 && rule.floor !== 'operator');
      if (refused) problems.push(`${at}, AT the "${rule.floor}" floor, was refused: ${res.status} (${errorText(res)})`);
    }

    // 5. secrets stay at the admin tier: a viewer or member seat never reads one
    if (verb === 'GET' && (rule.floor === 'authed' || rule.floor === 'viewer' || rule.floor === 'member')) {
      for (const who of ['viewerA', 'memberA'] as const) {
        const res = await call(who, verb, urlFor(A));
        if (res.status < 300 && res.body.includes(SECRET)) problems.push(`${who}: a 2xx response carries a secret value`);
      }
    }

    expect(problems, `${key}\n  ${problems.join('\n  ')}`).toEqual([]);
  });
});
