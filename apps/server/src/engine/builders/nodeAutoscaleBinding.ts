import { eq, services, sql, type DB, type DeploymentRuntimeOwner } from '@ninedeploy/db';
import { createNodeRuntimeMutationClient } from '../../lib/nodeRuntimeMutationClient.js';
import { createNodeDeploymentAuthority } from '../../lib/nodeDeploymentOwner.js';
import { beginNodeDeploymentPreparation, completeNodeDeploymentPreparation } from '../../lib/nodeDeploymentPreparation.js';
import { prepareNodeAutoscaleDeployment } from './nodeAutoscaleDeployment.js';
import type { AgentCall } from './remoteDocker.js';
import type { BuildContext } from '../types.js';

/** Bind the ordered builder seam to its durable deployment owner and journal. */
export function bindNodeAutoscalePreparation(input: { db: DB; owner: DeploymentRuntimeOwner; agent: AgentCall;
  sealed: () => Promise<boolean>; checkpoint: () => Promise<void>; signal?: AbortSignal; log: (line: string) => void }) {
  const owner = Object.freeze({ ...input.owner });
  const authority = createNodeDeploymentAuthority(input.db, owner);
  const checkpoint = async () => { input.signal?.throwIfAborted(); await authority.check(); await input.checkpoint();
    await authority.check(); input.signal?.throwIfAborted(); };
  const client = createNodeRuntimeMutationClient(input.db, owner.serverId, { checkpoint, signal: input.signal, onLine: input.log });
  return async (runtime: { service: BuildContext['service']; deploymentId: number; image: string; env: Record<string, string>;
    volumeAttachments: NonNullable<BuildContext['volumeAttachments']>; files: NonNullable<BuildContext['nodeFiles']> }) => {
    await checkpoint();
    if (runtime.deploymentId !== owner.deploymentId || runtime.service.id !== owner.serviceId || runtime.service.serverId !== owner.serverId) {
      throw new Error('Node preparation binding owner changed');
    }
    const [sequence] = await input.db.select({ id: sql<number>`COALESCE((SELECT seq FROM sqlite_sequence WHERE name='deployments'), 0)` })
      .from(services).where(eq(services.id, owner.serviceId)).limit(1);
    const watermark = Number(sequence?.id);
    if (!Number.isSafeInteger(watermark) || watermark < owner.deploymentId) throw new Error('Node preparation creation watermark is unconfirmed');
    const sealed = await input.sealed();
    await checkpoint();
    const result = await prepareNodeAutoscaleDeployment({ service: runtime.service, owner, image: runtime.image, creationWatermark: watermark,
      env: runtime.env, attachments: runtime.volumeAttachments, files: runtime.files, agent: input.agent, client, sealed, checkpoint, log: input.log,
      journal: { begin: spec => beginNodeDeploymentPreparation(input.db, owner, spec), complete: targets => completeNodeDeploymentPreparation(input.db, owner, targets) } });
    return result.runtime;
  };
}
