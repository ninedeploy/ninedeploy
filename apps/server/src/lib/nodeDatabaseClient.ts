import { z } from 'zod';
import type { DB } from '@ninedeploy/db';
import { databaseClientTarget } from '../agentOps/databaseClient.js';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { capabilityRefusal, nodeLabel, type AgentCaller } from './agentCapabilities.js';
import { HttpError } from './errors.js';

/** Re-probe at create AND attach, before any credential or channel-open request. */
export async function assertNodeDatabaseClientSupport(db: DB,serverId: number): Promise<void> {
  const caller: AgentCaller=(op,params,sink)=>agentOp(db,serverId,op,params,sink,{timeoutMs:15_000});
  const refusal=await capabilityRefusal(caller,await nodeLabel(db,serverId),await agentTransportSealed(db,serverId),{
    cap:['db.manage','db.client'],feature:'open database client terminals',sealedRequired:true,persist:{db,serverId},
  });
  if(refusal)throw new HttpError(refusal.status,refusal.code,refusal.message);
}
export async function prepareNodeDatabaseClient(db: DB,serverId: number,container: string,databaseId: number): Promise<{container:string;containerId:string;databaseId:number}> {
  await assertNodeDatabaseClientSupport(db,serverId);
  const fail=()=>new HttpError(502,'node_database_client_unconfirmed','The node database client target could not be confirmed');
  let reply: Awaited<ReturnType<typeof agentOp>>;try{reply=await agentOp(db,serverId,'db.client.prepare',{container,databaseId},()=>undefined,{timeoutMs:20_000,tolerateExit:true});}catch{throw fail();}
  if(reply.lines.length!==1||!reply.lines[0]!.startsWith('ND-DB-CLIENT '))throw fail();
  let value: unknown;try{value=JSON.parse(reply.lines[0]!.slice('ND-DB-CLIENT '.length));}catch{throw fail();}
  if(reply.exitCode!==0) {
    const refusal=z.object({error:z.object({status:z.union([z.literal(403),z.literal(409),z.literal(422)]),code:z.enum(['node_database_client_disabled','node_database_client_transport','not_running','database_identity_changed']),message:z.string().min(1).max(256)}).strict()}).strict().safeParse(value);
    if(refusal.success)throw new HttpError(refusal.data.error.status,refusal.data.error.code,refusal.data.error.message);
    throw fail();
  }
  const parsed=databaseClientTarget.safeParse(value);
  if(!parsed.success||parsed.data.container!==container||parsed.data.databaseId!==databaseId)throw fail();
  return parsed.data;
}
