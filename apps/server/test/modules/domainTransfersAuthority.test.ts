/**
 * Domain transfer — authority re-checked at accept time, against a real
 * migrated SQLite (the sibling domainTransfers.test.ts mocks the lib, so it
 * cannot see these). Regressions for:
 *  - F308: the 7-day accept link outlived its initiator's admin seat — an
 *    offboarded/demoted/deactivated admin's link still moved the team's
 *    hostname, and only the initiator or an operator could cancel it.
 *  - F309: accept placed reserved instance-zone names (another service's
 *    automatic domain, `*.<zone>`) on the recipient's service without the
 *    r223 own-zone claim rules every other path runs.
 *  - F913: a failed domain move left the transfer `accepted` (token consumed)
 *    while the domain stayed put — claim and move are now one transaction.
 *
 * A temp file, not `:memory:`: accept runs a libsql transaction, and the
 * single-connection in-memory pool cannot serve one (see emailCase.test.ts).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  domainTransfers,
  domains,
  serviceWorkspaces,
  services,
  users,
  workspaceMembers,
  workspaces,
  type DB,
} from '@ninedeploy/db';
import { domainTransferStartRoutes, domainTransferTokenRoutes } from '../../src/modules/domainTransfers.js';
import { config } from '../../src/config.js';
import { asUser, buildTestApp } from '../helpers.js';

vi.mock('../../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/engine/proxy.js')>()),
  // The real one writes the host's Traefik file and refreshes node proxies.
  writeDynamicConfig: vi.fn(async () => undefined),
}));
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));
// `config` is typed read-only; the tests pin the instance zone like domainIngress.test.ts.
const zoneConfig = config as { wildcardDomain: string };
const savedZone = zoneConfig.wildcardDomain;

let db: DB;
let closeDb: () => void = () => undefined;
let alice: number; // team owner
let mallory: number; // team admin who starts the transfer
let carol: number; // team member
let bob: number; // recipient, owner of another workspace
let team: number;
let prod: number;
let sink: number;

async function user(email: string, op = false) {
  const [u] = await db.insert(users).values({ email, passwordHash: 'h', isInstanceOperator: op }).returning();
  return u!.id;
}
async function service(slug: string, ownerUserId: number, workspaceId: number) {
  const [s] = await db
    .insert(services)
    .values({ name: slug, slug, type: 'docker', port: 3000, runtimeId: `nd-${slug}`, ownerUserId })
    .returning();
  await db.insert(serviceWorkspaces).values({ serviceId: s!.id, workspaceId });
  return s!.id;
}
async function domain(hostname: string) {
  const [d] = await db
    .insert(domains)
    .values({ serviceId: prod, hostname, path: '/', status: 'active', verifiedAt: new Date() })
    .returning();
  return d!.id;
}

async function app() {
  const a = await buildTestApp({ db });
  await a.register(domainTransferStartRoutes, { prefix: '/domains' });
  await a.register(domainTransferTokenRoutes, { prefix: '/domain-transfers' });
  return a;
}

async function start(a: Awaited<ReturnType<typeof app>>, domainId: number, by: number, email = 'bob@other.test') {
  const res = await a.inject({
    method: 'POST',
    url: `/domains/${domainId}/transfer`,
    headers: asUser({ id: by, isOperator: false }),
    payload: { targetEmail: email },
  });
  const url = res.statusCode === 200 ? (res.json().acceptUrl as string) : '';
  return { res, token: url.replace(/^.*\/domains\/transfers\/([^/]+)\/accept$/, '$1') };
}

const accept = (a: Awaited<ReturnType<typeof app>>, token: string) =>
  a.inject({
    method: 'POST',
    url: `/domain-transfers/${token}/accept`,
    headers: asUser({ id: bob, isOperator: false }),
    payload: { targetServiceId: sink },
  });

const ownerOf = async (domainId: number) =>
  (await db.query.domains.findFirst({ where: eq(domains.id, domainId) }))?.serviceId;

beforeEach(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-transfer-'));
  const created = createDb({ url: `file:${path.join(dir, 'test.db').split(path.sep).join('/')}` });
  db = created.db;
  closeDb = () => {
    created.client?.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows file lock */
    }
  };
  await migrate(db, { migrationsFolder: MIGRATIONS });
  alice = await user('alice@team.test');
  mallory = await user('mallory@team.test');
  carol = await user('carol@team.test');
  bob = await user('bob@other.test');
  const [t] = await db.insert(workspaces).values({ name: 'team', slug: 'team', ownerId: alice }).returning();
  const [o] = await db.insert(workspaces).values({ name: 'other', slug: 'other', ownerId: bob }).returning();
  team = t!.id;
  await db.insert(workspaceMembers).values([
    { workspaceId: team, userId: alice, role: 'owner' },
    { workspaceId: team, userId: mallory, role: 'admin' },
    { workspaceId: team, userId: carol, role: 'member' },
    { workspaceId: o!.id, userId: bob, role: 'owner' },
  ]);
  prod = await service('prod', alice, team);
  sink = await service('sink', bob, o!.id);
  zoneConfig.wildcardDomain = 'apps.example.com';
});

afterEach(() => closeDb());

afterAll(() => {
  zoneConfig.wildcardDomain = savedZone;
});

describe('F308: the accept link dies with the initiator’s admin seat', () => {
  it.each([
    ['seat removed', () => db.delete(workspaceMembers).where(eq(workspaceMembers.userId, mallory))],
    ['demoted to member', () => db.update(workspaceMembers).set({ role: 'member' }).where(eq(workspaceMembers.userId, mallory))],
    ['deactivated', () => db.update(users).set({ deactivatedAt: new Date() }).where(eq(users.id, mallory))],
  ])('refuses the accept once the initiator was %s', async (_label, change) => {
    const a = await app();
    const d = await domain('shop.example.com');
    const { res, token } = await start(a, d, mallory);
    expect(res.statusCode, res.body).toBe(200);
    await change();
    const r = await accept(a, token);
    expect(r.statusCode).toBe(409);
    expect(await ownerOf(d)).toBe(prod);
    const row = await db.query.domainTransfers.findFirst({ where: eq(domainTransfers.id, res.json().transferId) });
    expect(row?.status).toBe('pending');
  });

  it('still moves the domain while the initiator is admin', async () => {
    const a = await app();
    const d = await domain('shop.example.com');
    const { token } = await start(a, d, mallory);
    expect((await accept(a, token)).statusCode).toBe(200);
    expect(await ownerOf(d)).toBe(sink);
  });

  it('lets a current admin (not a plain member) withdraw the stale link', async () => {
    const a = await app();
    const d = await domain('shop.example.com');
    const { token } = await start(a, d, mallory);
    await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, mallory));
    const cancel = (by: number) =>
      a.inject({ method: 'POST', url: `/domain-transfers/${token}/cancel`, headers: asUser({ id: by, isOperator: false }) });
    expect((await cancel(carol)).statusCode).toBe(400);
    expect((await cancel(bob)).statusCode).toBe(400);
    expect((await cancel(alice)).statusCode).toBe(200);
    expect((await start(a, d, alice, 'dave@partner.test')).res.statusCode).toBe(200);
  });
});

describe('F309: accept runs the own-zone claim rules on the target service', () => {
  it.each([
    ['prod.apps.example.com', /automatic domain of service "prod"/],
    ['*.apps.example.com', /operator-only/],
  ])('refuses %s onto another tenant’s service', async (hostname, why) => {
    const a = await app();
    const d = await domain(hostname);
    const { token } = await start(a, d, alice);
    const r = await accept(a, token);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(why);
    expect(await ownerOf(d)).toBe(prod);
  });

  it('moves an own-zone name no service reserves', async () => {
    const a = await app();
    const d = await domain('marketing.apps.example.com');
    const { token } = await start(a, d, alice);
    expect((await accept(a, token)).statusCode).toBe(200);
    expect(await ownerOf(d)).toBe(sink);
  });
});

describe('F913: a failed domain move does not consume the transfer', () => {
  it('leaves the transfer pending when the move fails, and the same link then succeeds', async () => {
    const a = await app();
    const d = await domain('shop.example.com');
    const { res, token } = await start(a, d, alice);
    expect(res.statusCode, res.body).toBe(200);
    // Fault injected at the database: the domain move aborts (stands in for
    // SQLITE_BUSY / an FK failure from a concurrently deleted target service).
    await db.run(
      sql.raw(
        `CREATE TRIGGER f913_fault BEFORE UPDATE OF service_id ON domains BEGIN SELECT RAISE(ABORT, 'f913 fault'); END;`,
      ),
    );
    expect((await accept(a, token)).statusCode).toBe(400);
    const row = await db.query.domainTransfers.findFirst({ where: eq(domainTransfers.id, res.json().transferId) });
    expect(row).toMatchObject({ status: 'pending', acceptedAt: null, targetServiceId: null });
    expect(await ownerOf(d)).toBe(prod);

    await db.run(sql.raw('DROP TRIGGER f913_fault;'));
    expect((await accept(a, token)).statusCode).toBe(200);
    expect(await ownerOf(d)).toBe(sink);
  });
});
