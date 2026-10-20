import type { DB } from '@ninedeploy/db';
import { dockerBuilder } from '../engine/builders/docker.js';
import { writeDynamicConfig } from '../engine/proxy.js';
import { audit } from './audit.js';
import { run, sleep } from './exec.js';
import type { SleepDeps } from './sleep.js';

/** 0.16.11: the real docker, healthcheck, route and audit calls of lib/sleep.ts (the wake endpoint and the sleeper plugin share them). */
export function sleepDeps(db: DB, log: (line: string) => void): SleepDeps {
  return {
    db,
    docker: async (args) => {
      await run('docker', args, {}, () => undefined);
    },
    probe: (svc, name, timeoutMs) =>
      dockerBuilder.isHealthy(
        {
          runtimeId: name,
          port: svc.port ?? null,
          healthPath: svc.healthPath ?? '/',
          ...(svc.healthCheck === 'running' ? { healthCheck: 'running' as const } : {}),
          ...(svc.healthCheck === 'http-strict' || svc.healthCheck === 'tcp' ? { healthCheck: svc.healthCheck } : {}),
          ...(svc.healthCheck === 'command' && svc.healthCommand ? { healthCheck: 'command' as const, healthCommand: svc.healthCommand } : {}),
        },
        timeoutMs,
        0,
      ),
    writeConfig: () => writeDynamicConfig(db),
    audit: (action, entity, meta) => audit(db, null, action, entity, meta),
    sleep,
    log,
  };
}
