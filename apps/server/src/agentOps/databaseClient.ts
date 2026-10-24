import { z } from 'zod';
import { HttpError } from '../lib/errors.js';
import { inspectContainer, dockerTransport, isEngineTransport } from '../lib/dockerTty.js';
import { switchedOff } from './operands.js';
import type { AgentOpModule } from './index.js';

export const DATABASE_CLIENT_CAPABILITY = 'db.client' as const;
export const databaseClientTarget = z.object({
  databaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  container: z.string().max(128).regex(/^nd-db-[a-z0-9][a-z0-9_.-]*$/),
  containerId: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export function databaseClientForbidden(env: NodeJS.ProcessEnv = process.env): boolean {
  return switchedOff(env['NINEDEPLOY_AGENT_DATABASES']) || switchedOff(env['NINEDEPLOY_AGENT_DATABASE_CLIENTS']);
}
/** Resolve once, then execute only the full ID; a name reuse cannot redirect a ticket. */
export async function inspectDatabaseClientTarget(container: string, databaseId: number, expectedId?: string) {
  if (databaseClientForbidden()) throw new HttpError(403,'node_database_client_disabled','Database clients are disabled by the node owner');
  const name = databaseClientTarget.shape.container.parse(container);
  const resourceId = databaseClientTarget.shape.databaseId.parse(databaseId);
  const transport = dockerTransport();
  if (!isEngineTransport(transport)) throw new HttpError(422,'node_database_client_transport','Database clients need the Docker Engine API on the node');
  const summary = await inspectContainer(transport,name);
  if (!summary || !summary.running) throw new HttpError(409,'not_running','The database container is not running on the node');
  if (summary.labels['ninedeploy.managed'] !== 'database' || summary.labels['ninedeploy.database.id'] !== String(resourceId) || summary.labels['ninedeploy.database.slug'] !== name.slice('nd-db-'.length)) throw new HttpError(409,'database_identity_changed','The target is not a confirmed managed database');
  const result = databaseClientTarget.parse({container:name,containerId:summary.id,databaseId:resourceId});
  if (expectedId !== undefined && expectedId !== result.containerId) throw new HttpError(409,'database_identity_changed','The database container changed; open a new client session');
  return {transport,...result};
}
export const databaseClientOps: AgentOpModule = {
  name:'agentOps/databaseClient.ts',caps:[DATABASE_CLIENT_CAPABILITY],
  ops:{
    'db.client.prepare':{cap:DATABASE_CLIENT_CAPABILITY,sealedOnly:true,async run(params,onLine){
      const {container,databaseId}=z.object({container:databaseClientTarget.shape.container,databaseId:databaseClientTarget.shape.databaseId}).strict().parse(params);
      try {
        const target=await inspectDatabaseClientTarget(container,databaseId);
        onLine(`ND-DB-CLIENT ${JSON.stringify({container:target.container,containerId:target.containerId,databaseId:target.databaseId})}`);return 0;
      } catch(error) {
        if(!(error instanceof HttpError))throw error;
        onLine(`ND-DB-CLIENT ${JSON.stringify({error:{status:error.statusCode,code:error.code,message:error.message}})}`);return 1;
      }
    }},
  },
};
