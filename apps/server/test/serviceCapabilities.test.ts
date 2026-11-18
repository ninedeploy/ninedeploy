/**
 * C1 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): one evaluation per feature
 * for the panel, the API, the routes and the docs.
 *  - the capabilities route answers what the evaluator says;
 *  - a route refuses exactly what the evaluator calls unavailable;
 *  - every feature is refused through `assertServiceCapability` in some route;
 *  - docs/SUPPORT_MATRIX.md is generated from the evaluator
 *    (ND_UPDATE_SUPPORT_MATRIX=1 rewrites it).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConfigs, databases, servers, services, serviceTargets, users, type DB } from '@ninedeploy/db';
import { SERVICE_CAPABILITY_IDS, type ServiceCapabilityId } from '@ninedeploy/schemas';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const { runtimeOf, serviceCapabilities } = await import('../src/lib/serviceCapabilities.js');
const { config } = await import('../src/config.js');
const { default: sleeperPlugin } = await import('../src/plugins/sleeper.js');
const { readServiceSleepStatus } = await import('../src/lib/serviceSleepStatus.js');
const { pitrUnavailable } = await import('../src/lib/pitr.js');
const { upgradeRefusal } = await import('../src/lib/databaseUpgrade.js');
const { previewCopyRefusal } = await import('../src/lib/previewDatabases.js');
const { RESTORE_VERIFICATION_ENGINES } = await import('../src/lib/backupRestoreVerification.js');
const { remoteServiceRefusalDetail } = await import('../src/lib/remoteDeploy.js');
const { serviceCapabilityRoutes } = await import('../src/modules/serviceCapabilities.js');
const { restartLimitRoutes } = await import('../src/modules/restartLimit.js');
const { inlineDockerfileRoutes } = await import('../src/modules/inlineDockerfile.js');
const { asUser, buildTestApp } = await import('./helpers.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

/** One service per support-matrix column, ids 1–8. */
const FIXTURES = [
  { id: 1, slug: 'panel-docker', type: 'docker', repoUrl: 'https://github.com/acme/a' },
  { id: 2, slug: 'panel-docker-image', type: 'docker', image: 'nginx:1.27' },
  { id: 3, slug: 'panel-compose', type: 'compose', composeContent: 'services:\n  web:\n    image: nginx\n' },
  { id: 4, slug: 'panel-pm2', type: 'pm2', repoUrl: 'https://github.com/acme/b' },
  { id: 5, slug: 'node-docker', type: 'docker', repoUrl: 'https://github.com/acme/c', serverId: 9 },
  { id: 6, slug: 'node-compose', type: 'compose', composeContent: 'services:\n  web:\n    image: nginx\n', serverId: 9 },
  { id: 7, slug: 'swarm-docker', type: 'docker', image: 'nginx:1.27', orchestrator: 'swarm' },
  { id: 8, slug: 'panel-docker-fanout', type: 'docker', repoUrl: 'https://github.com/acme/d' },
] as const;

let db: DB;
const originalNodeSleepAutomation = config.nodeSleepAutomation;
beforeEach(async () => {
  config.nodeSleepAutomation = true;
  db = await migratedDb();
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'h', isInstanceOperator: true });
  await db.insert(servers).values({ id: 9, name: 'node', host: 'node.test', tokenEncrypted: 'fixture' } as never);
  await db.insert(services).values(FIXTURES.map((f) => ({ name: f.slug, branch: 'main', ownerUserId: 1, port: 80, ...f })) as never);
  await db.insert(serviceTargets).values({ serviceId: 8, serverId: 9 } as never);
});
afterEach(() => {
  config.nodeSleepAutomation = originalNodeSleepAutomation;
  closeMigratedDb(db);
});

const load = async (id: number) => (await db.query.services.findFirst({ where: (s, { eq }) => eq(s.id, id) }))!;

describe('evaluation', () => {
  it.each([true, false])('matches the real node sleep controller with automation=%s', async enabled => {
    config.nodeSleepAutomation = enabled;
    const app = await buildTestApp({ db });
    await app.register(sleeperPlugin);
    await app.register(serviceCapabilityRoutes, { prefix: '/services' });
    try {
      await app.ready();
      expect((await readServiceSleepStatus(db, await load(5))).nodeControllerActive).toBe(enabled);
      const res = await app.inject({ method: 'GET', url: '/services/5/capabilities', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json().capabilities.scaleToZero).toMatchObject({
        status: 'limited',
        reason: expect.stringMatching(enabled ? /idle.*wake.*capabilit/i : /NINEDEPLOY_NODE_SLEEP_AUTOMATION=off/),
      });
      // Disabling node automation does not disable the panel-host sleeper.
      expect((await serviceCapabilities(db, await load(1))).scaleToZero.status).toBe('available');
    } finally { await app.close(); }
    expect((await readServiceSleepStatus(db, await load(5))).nodeControllerActive).toBe(false);
  });

  it('explains that node fan-out cannot acquire automatic sleep authority', async () => {
    await db.insert(servers).values({ id: 10, name: 'target', host: 'target.test', tokenEncrypted: 'fixture' } as never);
    await db.insert(serviceTargets).values({ serviceId: 5, serverId: 10 } as never);
    expect((await serviceCapabilities(db, await load(5))).scaleToZero).toMatchObject({
      status: 'limited', reason: expect.stringMatching(/fan-out/),
    });
  });

  it('names the runtime column and answers the panel-only features by placement', async () => {
    const caps = async (id: number) => serviceCapabilities(db, await load(id));
    expect(runtimeOf(await load(5))).toBe('node-docker');
    expect(runtimeOf(await load(7))).toBe('swarm-docker');
    expect((await caps(1)).maintenance).toEqual({ status: 'available', reason: null });
    // P2: a node serves the pages itself; its agent is checked when the setting is saved.
    expect((await caps(5)).maintenance).toMatchObject({ status: 'limited', reason: expect.stringMatching(/agent serves the pages itself: it must be v0\.18\.27/) });
    expect((await caps(5)).errorPages.status).toBe('limited');
    expect((await caps(5)).forwardAuth).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/panel host/) });
    expect((await caps(8)).maintenance).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/also runs on nodes/) });
    expect((await caps(8)).forwardAuth).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/also runs on nodes/) });
    expect((await caps(2)).inlineDockerfile.status).toBe('unavailable');
    expect((await caps(7)).restartLimit.status).toBe('unavailable');
    expect((await caps(4)).restartLimit.status).toBe('available');
    // P2: on a node, the agent reports the restarts and takes the ordered Stop.
    expect((await caps(5)).restartLimit).toMatchObject({ status: 'limited', reason: expect.stringMatching(/Stop button’s own|Stop button's own/) });
    expect((await caps(8)).restartLimit.status).toBe('available');
    expect((await caps(3)).fileMounts.status).toBe('unavailable');
    expect((await caps(7)).autoscale.status).toBe('limited');
    expect((await caps(5)).scaleToZero.status).toBe('limited');
    expect((await caps(4)).canary.status).toBe('unavailable');
  });

  it('the route answers the evaluation, for a viewer', async () => {
    const app = await buildTestApp({ db });
    await app.register(serviceCapabilityRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'GET', url: '/services/5/capabilities', headers: asUser() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ serviceId: 5, runtime: 'node-docker', capabilities: await serviceCapabilities(db, await load(5)) });
    await app.close();
  });
});

describe('routes refuse exactly what the evaluation calls unavailable', () => {
  it('restart limit and inline Dockerfile, for every fixture', async () => {
    const app = await buildTestApp({ db });
    await app.register(restartLimitRoutes, { prefix: '/services' });
    await app.register(inlineDockerfileRoutes, { prefix: '/services' });
    for (const f of FIXTURES) {
      const caps = await serviceCapabilities(db, await load(f.id));
      const limit = await app.inject({ method: 'PUT', url: `/services/${f.id}/restart-limit`, headers: asUser(), payload: { limit: { maxRestarts: 5, windowMinutes: 10 } } });
      expect(limit.statusCode === 400, `${f.slug} restart limit`).toBe(caps.restartLimit.status === 'unavailable');
      if (limit.statusCode === 400) expect(limit.json().error).toEqual({ code: 'restart_limit_unsupported', message: caps.restartLimit.reason });
      const dockerfile = await app.inject({ method: 'PUT', url: `/services/${f.id}/inline-dockerfile`, headers: asUser(), payload: { content: 'FROM nginx:1.27\n' } });
      expect(dockerfile.statusCode === 400, `${f.slug} inline Dockerfile`).toBe(caps.inlineDockerfile.status === 'unavailable');
    }
    await app.close();
  });

  it('every feature is refused through assertServiceCapability in a route', () => {
    const root = fileURLToPath(new URL('../src/modules', import.meta.url));
    const text = readdirSync(root)
      .filter((f) => f.endsWith('.ts') && statSync(join(root, f)).isFile())
      .map((f) => readFileSync(join(root, f), 'utf8'))
      .join('\n');
    const used = new Set([...text.matchAll(/assertServiceCapability\([^)]*'([A-Za-z]+)'\)/g)].map((m) => m[1]));
    expect(SERVICE_CAPABILITY_IDS.filter((id) => !used.has(id))).toEqual([]);
  });
});

const LABEL: Record<ServiceCapabilityId, string> = {
  maintenance: 'Maintenance mode',
  errorPages: 'Custom error pages',
  forwardAuth: 'Panel sign-in on a domain (forward auth)',
  restartLimit: 'Restart-loop limit',
  inlineDockerfile: 'Inline Dockerfile',
  fileMounts: 'File mounts',
  autoscale: 'Autoscaling',
  scaleToZero: 'Scale to zero',
  canary: 'Canary releases',
};
const COLUMNS: Array<{ id: number; title: string }> = [
  { id: 1, title: 'Docker (panel host)' },
  { id: 2, title: 'Docker from an image (panel host)' },
  { id: 3, title: 'Compose (panel host)' },
  { id: 4, title: 'PM2 (panel host)' },
  { id: 5, title: 'Docker (node)' },
  { id: 6, title: 'Compose (node)' },
  { id: 7, title: 'Docker (Swarm)' },
  { id: 8, title: 'Docker (panel host + node fan-out)' },
];
const MARK = { available: '✅', limited: '🟡', in_progress: '🚧', unavailable: '—' } as const;

describe('docs/SUPPORT_MATRIX.md', () => {
  it('is generated from the evaluation', async () => {
    const results = new Map<number, Awaited<ReturnType<typeof serviceCapabilities>>>();
    for (const c of COLUMNS) results.set(c.id, await serviceCapabilities(db, await load(c.id)));
    const notes: string[] = [];
    const noteFor = (reason: string) => {
      let i = notes.indexOf(reason);
      if (i < 0) i = notes.push(reason) - 1;
      return `[${i + 1}]`;
    };
    const rows = SERVICE_CAPABILITY_IDS.map((id) => {
      const cells = COLUMNS.map((c) => {
        const cap = results.get(c.id)![id];
        return cap.reason ? `${MARK[cap.status]} ${noteFor(cap.reason)}` : MARK[cap.status];
      });
      return `| ${LABEL[id]} | ${cells.join(' | ')} |`;
    });
    // Use the same database guards the API and preview producer call. No
    // second hand-maintained engine allow-list belongs in the public matrix.
    const databaseRows: string[] = [];
    for (const engine of RESTORE_VERIFICATION_ENGINES) {
      const decisions: string[][] = [];
      for (const serverId of [null, 9]) {
        const [database] = await db.insert(databases).values({
          ownerUserId: 1, name: `${engine}-${serverId ?? 'panel'}`, slug: `${engine}-${serverId ?? 'panel'}`,
          engine, serverId, status: 'running', passwordEncrypted: 'fixture',
          containerName: 'managed-database', volumeName: 'managed-data',
        }).returning();
        decisions.push([
          pitrUnavailable(database!) ? '—' : '✅',
          upgradeRefusal(database!) ? '—' : '✅',
          previewCopyRefusal(database!) ? '—' : '✅',
        ]);
      }
      databaseRows.push(`| ${engine} | ${decisions[0]!.map((cell, i) => `${cell} / ${decisions[1]![i]}`).join(' | ')} | ✅ |`);
    }
    const buildRows: string[] = [];
    for (const pack of ['nixpacks', 'paketo', 'heroku'] as const) {
      await db.delete(buildConfigs).where(eq(buildConfigs.serviceId, 5));
      await db.insert(buildConfigs).values({ serviceId: 5, buildPack: pack });
      const cells: string[] = [];
      for (const placement of [{ serverId: null }, { serverId: 9, buildOn: 'target' }, { serverId: 9, buildOn: 'panel' }]) {
        const refusal = await remoteServiceRefusalDetail(db, { ...await load(5), ...placement }, {
          probe: async () => ({ nodeLabel: 'matrix fixture', sealed: true, agent: async op => {
            expect(op).toBe('agent.ping');
            return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.18.28', caps: ['build.nixpacks'] })}`] };
          } }),
        });
        cells.push(refusal ? '—' : '✅');
      }
      buildRows.push(`| ${pack} | ${cells.join(' | ')} |`);
    }
    const doc = [
      '# Support matrix',
      '',
      '<!-- Generated by apps/server/test/serviceCapabilities.test.ts from lib/serviceCapabilities.ts. Do not edit by hand: run the test with ND_UPDATE_SUPPORT_MATRIX=1. -->',
      '',
      'Which service features work where. The panel reads the same evaluation from `GET /v1/services/:id/capabilities` and disables a control before you save it. The routes refuse with the same reasons.',
      '',
      `${MARK.available} works · ${MARK.limited} works partly or is held at run time · ${MARK.in_progress} being built · ${MARK.unavailable} refused when saved`,
      '',
      `| Feature | ${COLUMNS.map((c) => c.title).join(' | ')} |`,
      `|---|${COLUMNS.map(() => '---').join('|')}|`,
      ...rows,
      '',
      '## Notes',
      '',
      ...notes.map((n, i) => `${i + 1}. ${n}`),
      '',
      'Checks of the live environment are not in this table. They run when you save or deploy. Examples: whether Traefik can reach the panel for maintenance pages and forward auth, and whether a node agent advertises an operation.',
      '',
      '## Database decisions',
      '',
      'Each pair is **panel host / node**. These are structural eligibility checks for an ordinary running managed database with a container and volume, with PITR off. The database API uses the same PITR and upgrade guards; the preview producer uses the same copy guard. Upgrade targets, free disk, privileges, agent capabilities and other live preflights still apply.',
      '',
      '| Engine | PITR | Major upgrade eligibility | Preview copy | Isolated restore adapter |',
      '|---|---|---|---|---|',
      ...databaseRows,
      '',
      "PITR keeps a live archive on the database's host. Node archiving/export requires a sealed agent advertising `db.pitr.archive`; managed replay remains panel-host only. Opt-in remote checkpoints/continuous WAL provide off-host recovery; see [Remote PITR archives](PITR_REMOTE_CHECKPOINTS.md). Major upgrades exclude pgvector, previews and databases with PITR enabled. Preview copies require the source to be running. Restore verification runs in an isolated helper on the panel host and measures the supplied backup, not high availability or recovery after host loss. RabbitMQ backups contain definitions, not queued messages.",
      '',
      'Read the actual database state through `GET /v1/databases/:id/pitr` and `GET /v1/databases/:id/upgrades/options`; live refusals are authoritative. See [Databases and backups](DATABASES_BACKUPS.md) and [Restore verification](RESTORE_VERIFICATION.md).',
      '',
      '## Build placement decisions',
      '',
      'Queue-time eligibility for a Docker service from a public Git repository, using a sealed agent advertising `build.nixpacks`. The evaluation calls `remoteServiceRefusalDetail`, the same guard used by deployment admission. A check mark does not promise a successful build: the tool, image, architecture, source and credentials must pass job-time checks too.',
      '',
      '| Pack | Panel host | Node, build on target | Node, build on panel |',
      '|---|---|---|---|',
      ...buildRows,
      '',
      'Building on the panel sends the resulting image to the node. Paketo/Heroku have no node-side builder. Dockerfile, Railpack, static and automatic pack resolution have additional job-time rules; see [Deployments](DEPLOYMENTS.md).',
      '',
      'For implementation, acceptance and publication status, see [Current status](CURRENT_STATUS.md).',
      '',
    ].join('\n');
    const file = new URL('../../../docs/SUPPORT_MATRIX.md', import.meta.url);
    if (process.env['ND_UPDATE_SUPPORT_MATRIX'] === '1') writeFileSync(file, doc);
    expect(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).toBe(doc);
  });
});
