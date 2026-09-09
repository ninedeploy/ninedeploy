import { describe, expect, it, vi } from 'vitest';
import { deployments, services } from '@ninedeploy/db';
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
