import { eq, isNotNull } from 'drizzle-orm';
import { databases, type DB } from '@ninedeploy/db';
import fp from 'fastify-plugin';
import { agentOp } from '../lib/agentClient.js';
import { type NodeDatabaseAgent, nodeContainerOf, nodeContainerState, recordNodeReachability } from '../lib/nodeDatabase.js';

/**
 * Node database status (multi-node T6, design §5.6): every 60 s, ask each
 * node that hosts databases for the state of their containers
 * (`docker.inspect {format: 'state'}`, an op every agent has) and move
 * `status` the way the panel's own transitions do:
 *
 *  - a database the panel believes `running` whose container is gone or
 *    stopped → `error` (it died, or the node lost it);
 *  - a database in `error` whose container runs again (the node rebooted,
 *    `--restart unless-stopped` brought it back) → `running`;
 *  - `stopped` (the operator's), `creating` and `deleting` (in flight) are
 *    never changed here.
 *
 * An UNREACHABLE node never changes `status`: the database may well still
 * run there. The API reports `reachable: false` (lib/nodeDatabase.ts keeps
 * the last answer per node) and scheduled backups record the failure.
 *
 * Registered in `app.ts` after `kernelPlugin` (mount point M2). Every test
 * that boots the real app mocks it; the sweep itself is exported for tests.
 */

const SWEEP_EVERY_MS = 60_000;

/** One sweep over every node database. Never throws; returns what changed. */
export async function sweepNodeDatabases(
  db: DB,
  agentFor: (serverId: number) => NodeDatabaseAgent = (serverId) => (op, params, opts) => agentOp(db, serverId, op, params, () => undefined, opts),
): Promise<Array<{ id: number; from: string; to: string }>> {
  const changed: Array<{ id: number; from: string; to: string }> = [];
  let rows: Array<typeof databases.$inferSelect>;
  try {
    rows = await db.select().from(databases).where(isNotNull(databases.serverId));
  } catch {
    return changed;
  }
  const byServer = new Map<number, typeof rows>();
  for (const d of rows) byServer.set(d.serverId as number, [...(byServer.get(d.serverId as number) ?? []), d]);
  for (const [serverId, dbs] of byServer) {
    const agent = agentFor(serverId);
    let reachable = true;
    for (const d of dbs) {
      if (d.status !== 'running' && d.status !== 'error') continue;
      let state: string;
      try {
        state = await nodeContainerState(agent, nodeContainerOf(d));
      } catch {
        // The node did not answer: no status change for any of its databases.
        reachable = false;
        break;
      }
      const up = state === 'running' || state === 'restarting';
      const next = d.status === 'running' && !up ? 'error' : d.status === 'error' && up ? 'running' : null;
      if (next === null) continue;
      try {
        await db.update(databases).set({ status: next }).where(eq(databases.id, d.id));
        changed.push({ id: d.id, from: d.status, to: next });
      } catch {
        /* the next sweep tries again */
      }
    }
    recordNodeReachability(serverId, reachable);
  }
  return changed;
}

export default fp(
  async (fastify) => {
    let timer: NodeJS.Timeout | undefined;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const changed = await sweepNodeDatabases(fastify.db);
        for (const c of changed) fastify.log.info({ component: 'node-databases', ...c }, `node database #${c.id}: ${c.from} → ${c.to}`);
      } finally {
        busy = false;
      }
    };
    fastify.addHook('onReady', async () => {
      timer = setInterval(() => void tick(), SWEEP_EVERY_MS);
      timer.unref?.();
    });
    fastify.addHook('onClose', async () => {
      if (timer) clearInterval(timer);
    });
  },
  { name: 'ninedeploy-node-databases' },
);
