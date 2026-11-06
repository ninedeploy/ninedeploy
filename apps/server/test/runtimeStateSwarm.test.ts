import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createDb, services, users, type DB } from '@ninedeploy/db';
import { createRuntimeStateReconciler, SWARM_DOWN_PASSES } from '../src/plugins/runtimeState.js';
import { buildTestApp } from './helpers.js';

/**
 * R2 Swarm support: the runtime patrol used to skip every Swarm service, so a
 * row kept claiming `running` while the manager ran no task at all (a Restart
 * after a Stop, a crash loop, an image no node could pull, a removed stack).
 * It now checks a `running` Swarm row against the manager's task counts,
 * never starts a task itself (Swarm does), and never judges a service on a
 * manager it cannot read. Real migrated SQLite; the docker CLI is faked.
 */

const execMocks = vi.hoisted(() => ({
  capture: vi.fn(async (_cmd: string, _args: string[]): Promise<string> => ''),
  run: vi.fn(async () => undefined),
  sleep: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/exec.js', () => execMocks);
const auditMocks = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMocks);
vi.mock('../src/lib/agentClient.js', () => ({ agentOp: vi.fn(async () => ({ exitCode: 0, lines: [] })) }));
vi.mock('../src/config.js', () => ({
  config: {
    wildcardDomain: '',
    isProd: false,
    publicUrl: 'http://localhost:3000',
    paths: { dataDir: '/tmp', masterKeyFile: '/tmp/master.key' },
    jwt: { secret: 'x', accessTtl: '15m', refreshTtl: '7d' },
  },
}));

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));

async function seed(over: Partial<typeof services.$inferInsert> = {}) {
  const { db } = createDb({ url: ':memory:' }) as { db: DB };
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values({ id: 7, email: 'a@example.com', passwordHash: 'x' });
  const [row] = await db
    .insert(services)
    .values({ name: 'web', slug: 'web', type: 'docker', orchestrator: 'swarm', status: 'running', runtimeId: 'nd-web_web', replicas: 3, ownerUserId: 7, ...over })
    .returning();
  return { db, id: row!.id };
}

/** The manager: `replicas` answers `docker service ls` ("2/3"), null = no such service, an Error = unreadable. */
function manager(replicas: () => string | null | Error | Promise<string>, onScale?: () => Promise<void>) {
  execMocks.capture.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args[0] === 'service' && args[1] === 'ls') {
      const r = await replicas();
      if (r instanceof Error) throw r;
      return r === null ? '' : `nd-web_web ${r}\nnd-web_webx 9/9`;
    }
    if (args[0] === 'service' && args[1] === 'scale') {
      await onScale?.();
      return '';
    }
    return '';
  });
}
const swarmCalls = () =>
  execMocks.capture.mock.calls.map(([, argv]) => argv as string[]).filter((a) => a[0] === 'service' && a[1] !== 'ls');
const status = async (db: DB, id: number) => (await db.select({ status: services.status }).from(services).where(eq(services.id, id)))[0]?.status;

/** `n` patrol passes of ONE reconciler (the no-task count lives in it, like the real 60 s timer). */
async function passes(db: DB, n: number) {
  const app = await buildTestApp({ db });
  const patrol = createRuntimeStateReconciler(app);
  await app.ready();
  for (let i = 0; i < n; i += 1) await patrol.reconcile();
  await patrol.close();
  await app.close();
}

describe('the runtime patrol checks a running Swarm service against the manager (R2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('every desired task running, or some (Swarm converging): nothing to do', async () => {
    const { db, id } = await seed();
    let answer = '3/3';
    manager(() => answer);
    await passes(db, 1);
    answer = '1/3';
    await passes(db, SWARM_DOWN_PASSES + 2);
    expect(swarmCalls()).toEqual([]);
    expect(await status(db, id)).toBe('running');
    expect(auditMocks.audit).not.toHaveBeenCalled();
  });

  it('never a container command against the Swarm service name', async () => {
    const { db } = await seed();
    manager(() => '0/3');
    await passes(db, 1);
    const argvs = execMocks.capture.mock.calls.map(([, argv]) => argv as string[]);
    expect(argvs.some((a) => ['inspect', 'start', 'ps', 'logs'].includes(a[0]!))).toBe(false);
  });

  it('no task for SWARM_DOWN_PASSES passes: recorded as down once, with the service-down alert', async () => {
    const { db, id } = await seed();
    manager(() => '0/3');
    await passes(db, SWARM_DOWN_PASSES - 1);
    expect(await status(db, id)).toBe('running');
    expect(auditMocks.audit).not.toHaveBeenCalled();
    await passes(db, 0);
    // The count lives in one reconciler; a fresh one starts again from zero.
    await passes(db, SWARM_DOWN_PASSES - 1);
    expect(await status(db, id)).toBe('running');
    await passes(db, SWARM_DOWN_PASSES);
    expect(await status(db, id)).toBe('error');
    expect(auditMocks.audit).toHaveBeenCalledTimes(1);
    expect(auditMocks.audit).toHaveBeenCalledWith(expect.anything(), null, 'alert.service_down', `web #${id}`, { serviceId: id, runtimeId: 'nd-web_web', status: 'error' });
    // Swarm restarts its own tasks: the patrol never scaled or forced anything.
    expect(swarmCalls()).toEqual([]);
  });

  it('a task that comes back resets the count', async () => {
    const { db, id } = await seed();
    const answers = [...Array<string>(SWARM_DOWN_PASSES - 1).fill('0/3'), '1/3', ...Array<string>(SWARM_DOWN_PASSES - 1).fill('0/3')];
    manager(() => answers.shift() ?? '3/3');
    await passes(db, 2 * SWARM_DOWN_PASSES - 1);
    expect(await status(db, id)).toBe('running');
  });

  it('the Swarm service no longer exists: recorded as down at once', async () => {
    const { db, id } = await seed();
    manager(() => null);
    await passes(db, 1);
    expect(await status(db, id)).toBe('error');
    expect(auditMocks.audit).toHaveBeenCalledWith(expect.anything(), null, 'alert.service_down', `web #${id}`, expect.objectContaining({ status: 'error' }));
  });

  it('scaled to 0 outside the panel: scaled back to the service replicas, still running', async () => {
    const { db, id } = await seed();
    manager(() => '0/0');
    await passes(db, 1);
    expect(swarmCalls()).toEqual([['service', 'scale', '--detach', 'nd-web_web=3']]);
    expect(await status(db, id)).toBe('running');
    expect(auditMocks.audit).not.toHaveBeenCalled();
  });

  it('F889: a Stop recorded after the pass listed the row is never undone', async () => {
    const { db, id } = await seed();
    // The Stop route writes `stopped` first, then scales to 0: the pass reads 0/0 in between.
    manager(async () => {
      await db.update(services).set({ status: 'stopped' }).where(eq(services.id, id));
      return '0/0';
    });
    await passes(db, 1);
    expect(swarmCalls()).toEqual([]);
    expect(await status(db, id)).toBe('stopped');
  });

  it('a scale the manager refuses costs the other services nothing: the pass goes on', async () => {
    const { db, id } = await seed();
    const [other] = await db
      .insert(services)
      .values({ name: 'api', slug: 'api', type: 'docker', orchestrator: 'swarm', status: 'running', runtimeId: 'nd-api_web', replicas: 1, ownerUserId: 7 })
      .returning();
    execMocks.capture.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'service' && args[1] === 'ls') return args.includes('name=nd-web_web') ? 'nd-web_web 0/0' : '';
      if (args[0] === 'service' && args[1] === 'scale') throw new Error('Error response from daemon: rpc error: update out of sequence');
      return '';
    });
    await passes(db, 1);
    expect(await status(db, id)).toBe('running');
    // nd-api_web no longer exists: still judged in the same pass.
    expect(await status(db, other!.id)).toBe('error');
  });

  it('a manager that cannot answer (daemon down, panel left the swarm) is never a judgement', async () => {
    const { db, id } = await seed();
    manager(() => new Error('Error response from daemon: This node is not a swarm manager.'));
    await passes(db, SWARM_DOWN_PASSES + 1);
    expect(await status(db, id)).toBe('running');
    expect(swarmCalls()).toEqual([]);
    expect(auditMocks.audit).not.toHaveBeenCalled();
  });

  it('a stopped row is not visited; a compose row named like a stack is not Swarm', async () => {
    const stopped = await seed({ status: 'stopped' });
    manager(() => null);
    await passes(stopped.db, 1);
    expect(await status(stopped.db, stopped.id)).toBe('stopped');
    expect(execMocks.capture).not.toHaveBeenCalled();
    // Review L1: a compose service whose runtime id looks like nd-<slug>_web is a compose runtime.
    const compose = await seed({ type: 'compose', orchestrator: null, slug: 'attacker', runtimeId: 'nd-web_web' });
    await passes(compose.db, 1);
    expect(execMocks.capture.mock.calls.map(([, argv]) => argv as string[]).filter((a) => a[0] === 'service')).toEqual([]);
  });
});
