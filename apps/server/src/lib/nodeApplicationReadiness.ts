import type { Service } from '@ninedeploy/db';
import type { AgentCall } from '../engine/builders/remoteDocker.js';
import { verifyNodeReadiness } from './nodeReadiness.js';

/** Configured policy plus an application-listener floor, sharing one deadline. */
export async function verifyNodeApplicationReadiness(service: Service, targets: { id: string; name: string }[], agent: AgentCall,
  checkpoint: () => Promise<void>, log: (line: string) => void = () => undefined): Promise<void> {
  const mode = service.healthCheck, deadline = Date.now() + (service.healthTimeoutSeconds ?? 300) * 1000;
  const modes = mode === 'http-strict' || mode === 'tcp' ? [mode] as const : [mode === 'command' || mode === 'running' ? mode : 'auto', 'tcp'] as const;
  for (const probeMode of modes) {
    const passed = await verifyNodeReadiness(agent, { targets, mode: probeMode, port: service.port, path: service.healthPath || '/' }, deadline - Date.now(), checkpoint, log);
    await checkpoint();
    if (!passed || Date.now() >= deadline) throw new Error('Node application readiness is unconfirmed');
  }
}
