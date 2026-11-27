import type { DB } from '@ninedeploy/db';
import type { ServiceMoveView } from '@ninedeploy/schemas';
import { audit } from './audit.js';
import { setSettingJson } from './settings.js';
import { settingRowsWithPrefix } from './settingRows.js';

/**
 * N07: a move of a service with its data that a panel restart interrupted.
 *
 * A move runs in the process that started it (modules/serviceMoveWithData.ts):
 * the service row is switched to the target host first, then the volumes are
 * copied, then the service is deployed there, and the progress is the settings
 * row `service_move:<id>`. At boot nothing this process started can be
 * running, so every row that says `running` is the previous process's, and no
 * copy of it can finish here. The row becomes `failed` with what happened and
 * what to do; the service row is left as it is.
 *
 * - `copying`: the service is on the target, undeployed, and the data copied
 *   there may be incomplete. The source volume is kept by design, so the move
 *   starts again from it.
 * - `deploying`: every volume was copied whole. The deployment is the worker's
 *   to recover (plugins/worker.ts), and the Deploys tab says how it ended.
 */

const PREFIX = 'service_move:';
const host = (id: number | null) => (id === null ? 'the panel host' : `node #${id}`);

export interface RecoveredMove {
  serviceId: number;
  step: 'copying' | 'deploying';
}

function interruptedMove(value: unknown): ServiceMoveView | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Partial<ServiceMoveView>;
  return state.state === 'running' ? (state as ServiceMoveView) : null;
}

/** Marks every move the previous process left `running` as `failed`, and says which. */
export async function recoverInterruptedMoves(db: DB): Promise<RecoveredMove[]> {
  const recovered: RecoveredMove[] = [];
  for (const row of await settingRowsWithPrefix(db, PREFIX)) {
    if (!row.key.startsWith(PREFIX)) continue;
    const serviceId = Number(row.key.slice(PREFIX.length));
    const state = interruptedMove(row.value);
    if (!Number.isInteger(serviceId) || serviceId <= 0 || !state) continue;
    const step: RecoveredMove['step'] = state.step === 'deploying' ? 'deploying' : 'copying';
    const from = host(state.from ?? null);
    const to = host(state.to ?? null);
    const error =
      step === 'copying'
        ? `Interrupted by a panel restart: the data copied to ${to} may be incomplete, and nothing was deployed. The source volume on ${from} is untouched. Move the service back to ${from} with a plain host change, then start the move again.`
        : `Interrupted by a panel restart while deploying on ${to}: the data was copied whole. The panel's own recovery decided how that deployment ended; look at the Deploys tab and deploy again if it did not finish.`;
    await setSettingJson(db, row.key, { ...state, state: 'failed', error, finishedAt: new Date().toISOString() });
    recovered.push({ serviceId, step });
  }
  if (recovered.length > 0) {
    void audit(db, null, 'service.move_with_data_interrupted', `${recovered.length} move(s) with data interrupted by a panel restart`, {
      serviceIds: recovered.map((move) => move.serviceId),
    });
  }
  return recovered;
}
