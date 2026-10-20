import type { DB, Service } from '@ninedeploy/db';
import { pm2Logs } from '../engine/builders/pm2.js';
import { agentOp } from './agentClient.js';
import { capture } from './exec.js';
import { swarmRuntimeOf, swarmServiceLogs } from './swarm.js';

/**
 * The last `tail` lines of a service's runtime logs, wherever it runs: the
 * PM2 daemon's log files, every task of a Swarm service, a node's container
 * through its agent, or the panel host's container. Shared by
 * `GET /v1/services/:id/logs` and (0.16.15) the AI runtime-log analysis, so
 * both read exactly the same thing. Throws when the logs cannot be read; the
 * route answers '' then.
 */
export async function readRuntimeLogs(
  db: DB,
  svc: Pick<Service, 'type' | 'runtimeId' | 'serverId' | 'orchestrator' | 'isEphemeralPreview' | 'slug'>,
  tail: number,
): Promise<string> {
  if (!svc.runtimeId) return '';
  if (svc.type === 'pm2') return pm2Logs(svc.runtimeId, tail);
  // ── 0.16 T7 swarm ── every task's logs, wherever it runs.
  const swarmRuntime = swarmRuntimeOf(svc as Service);
  if (swarmRuntime) return swarmServiceLogs(swarmRuntime, tail);
  // ── end 0.16 T7 ──
  if (svc.serverId != null) {
    // An agent before 0.16.3 ignores `tail` and returns the last 300 lines.
    const out: string[] = [];
    try {
      await agentOp(db, svc.serverId, 'docker.logs', { name: svc.runtimeId, tail: String(tail) }, (line) => out.push(line));
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : String(err)}: ${out.join(' ').slice(0, 400)}`);
    }
    return out.join('\n');
  }
  // r667: 300 LINES is no byte bound — a container printing one endless
  // line used to be buffered whole; past 8 MiB the read stops.
  return capture('docker', ['logs', '--tail', String(tail), '--timestamps', svc.runtimeId], { maxOutputBytes: 8 * 1024 * 1024 });
}
