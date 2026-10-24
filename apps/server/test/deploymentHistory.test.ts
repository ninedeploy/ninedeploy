import { describe, expect, it, vi } from 'vitest';
import { deployments, primaryTransitions, swarmTransitions, services, eq } from '@ninedeploy/db';
import { reconcileDeploymentHistory } from '../src/engine/pipeline.js';

/**
 * At most ONE deployment per service may read `running` (the build serving
 * traffic). The success finalize never used to archive older rows, so the
 * Deploys tab showed every past deploy as Running forever. Boot-time
 * reconciliation keeps the newest running row for LIVE services only and
 * demotes the rest to `superseded`.
 */

interface UpdateRec {
  table: unknown;
  values: Record<string, unknown>;
}

function makeDb(runningRows: Array<{ id: number; serviceId: number }>, serviceStates: Array<{ id: number; status: string }>) {
  const updates: UpdateRec[] = [];
  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: vi.fn(() =>
          Promise.resolve(
            table === deployments ? runningRows : table === services ? serviceStates : [],
          ),
        ),
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ table, values });
        return {
          where: vi.fn(function whereMock(...args: unknown[]) {
            void args;
            return Promise.resolve([]);
          }),
        };
      },
    })),
  };
  return { db: db as never, updates };
}

describe('reconcileDeploymentHistory', () => {
  it('preserves the serving Swarm deployment until its native recovery settles', async () => {
    const { observabilityDb } = await import('./fixtures/observability.js'); const f = await observabilityDb();
    try {
      await f.db.update(services).set({ status: 'deploying', orchestrator: 'swarm' }).where(eq(services.id, 1));
      await f.db.insert(deployments).values([{ id: 7, serviceId: 1, status: 'running' }, { id: 9, serviceId: 1, status: 'building' }]);
      await f.db.insert(swarmTransitions).values({ serviceId: 1, deploymentId: 9, managerNodeId: 'm'.repeat(25), runtimeId: 'nd-web_web', payloadEncrypted: 'opaque-fixture' });
      expect(await reconcileDeploymentHistory(f.db)).toBe(0);
      expect((await f.db.query.deployments.findFirst({ where: eq(deployments.id, 7) }))?.status).toBe('running');
    } finally { f.close(); }
  });
  it('preserves the previous serving deployment while a journalled transition awaits recovery', async () => {
    const { observabilityDb } = await import('./fixtures/observability.js'); const f = await observabilityDb();
    try {
      await f.db.update(services).set({ status: 'deploying' }).where(eq(services.id, 1));
      await f.db.insert(deployments).values([{ id: 7, serviceId: 1, status: 'running' }, { id: 9, serviceId: 1, status: 'building' }]);
      await f.db.insert(primaryTransitions).values({ serviceId: 1, deploymentId: 9, candidate: { runtimeId: 'web-9', port: 8080, healthPath: '/', healthCheck: null, replicas: 1, commitSha: null, containers: [] } });
      expect(await reconcileDeploymentHistory(f.db)).toBe(0);
      expect((await f.db.query.deployments.findFirst({ where: eq(deployments.id, 7) }))?.status).toBe('running');
    } finally { f.close(); }
  });
  it('bounds history scans linearly when every live row belongs to a different service', async () => {
    const size = 512;
    let serviceReads = 0;
    const rows = Array.from({ length: size }, (_, index) => ({
      id: index + 1,
      get serviceId() {
        serviceReads++;
        return index + 1;
      },
    }));
    const { db, updates } = makeDb(rows, rows.map((r) => ({ id: r.id, status: 'running' })));

    expect(await reconcileDeploymentHistory(db)).toBe(0);
    expect(updates).toHaveLength(0);
    // Allow several passes; a scan of every row for each service exceeds this.
    expect(serviceReads).toBeLessThanOrEqual(size * 8);
  });

  it('keeps the newest running row of a live service and demotes older ones', async () => {
    const { db } = makeDb(
      [ { id: 10, serviceId: 1 }, { id: 7, serviceId: 1 }, { id: 3, serviceId: 1 } ],
      [ { id: 1, status: 'running' } ],
    );
    const demoted = await reconcileDeploymentHistory(db);
    expect(demoted).toBe(2);
  });

  it('demotes ALL running rows when the service is not running', async () => {
    // Server restarted mid-deploy: nothing is live, so "running" is a lie.
    const { db, updates } = makeDb([ { id: 12, serviceId: 4 } ], [ { id: 4, status: 'error' } ]);
    const demoted = await reconcileDeploymentHistory(db);
    expect(demoted).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.values.status).toBe('superseded');
  });

  it('is a no-op when there are no running deployments', async () => {
    const { db, updates } = makeDb([], []);
    expect(await reconcileDeploymentHistory(db)).toBe(0);
    expect(updates).toHaveLength(0);
  });
});
