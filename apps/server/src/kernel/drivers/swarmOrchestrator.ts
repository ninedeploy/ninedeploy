import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { swarmStacks, type DB } from '@ninedeploy/db';
import { capture, run } from '../../lib/exec.js';
import type {
  IOrchestrator,
  StackServiceSpec,
  StackSpec,
  StackStatus,
} from '../types.js';

// Swarm-backed orchestrator - Sprint 5, Gap G-10 (PR #21).
//
// Routes every StackSpec through the Docker Swarm CLI:
//   - one `docker network create --driver overlay --attachable` per
//     StackNetworkSpec,
//   - one `docker secret create` per StackSecretSpec,
//   - one `docker config create` per StackConfigSpec,
//   - one `docker service create` per StackServiceSpec with
//     --replicas N, the attached networks, the mounted secrets + configs,
//     the env vars + labels, and --update-parallelism 1 --update-order
//     start-first for zero-downtime rolling updates.
//
// State lives in swarm_stacks (state_json) AND on disk under
// /var/lib/ninedeploy/stacks/<name>/stack.json for fast cold starts.
// The row is the source of truth across a kernel restart; the file
// is what the next apply diffs against.
const STACK_ROOT = '/var/lib/ninedeploy/stacks';

export interface SwarmStackState {
  name: string;
  networks: string[];
  secrets: string[];
  configs: string[];
  serviceNames: string[];
  appliedAt: string;
}

export class SwarmOrchestrator implements IOrchestrator {
  readonly name = 'swarm';
  private readonly db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  async deployStack(stack: StackSpec): Promise<StackStatus> {
    const stackDir = join(STACK_ROOT, stack.name);
    ensureDir(stackDir);

    // 1. Networks first
    for (const n of stack.networks) {
      try {
        await run(
          'docker',
          [
            'network',
            'create',
            '--driver',
            n.driver,
            n.attachable ? '--attachable' : '--attachable=false',
            n.name,
          ],
          { heartbeatMs: 20_000, heartbeatLabel: `swarm network ${n.name}` },
          () => {},
        );
      } catch {
        // The network may already exist
      }
    }

    // 2. Secrets + configs
    for (const s of stack.secrets) {
      const tmpFile = join(stackDir, `${s.name}.secret.tmp`);
      writeFileSync(tmpFile, s.data, { mode: 0o600 });
      try {
        await run('docker', ['secret', 'create', s.name, tmpFile], {
          heartbeatMs: 10_000,
          heartbeatLabel: `swarm secret ${s.name}`,
        }, () => {});
      } catch {
        // Likely an "already exists" race
      }
      rmSync(tmpFile, { force: true });
    }
    for (const c of stack.configs) {
      const tmpFile = join(stackDir, `${c.name}.config.tmp`);
      writeFileSync(tmpFile, c.data, { mode: 0o600 });
      try {
        await run('docker', ['config', 'create', c.name, tmpFile], {
          heartbeatMs: 10_000,
          heartbeatLabel: `swarm config ${c.name}`,
        }, () => {});
      } catch {
        // Same reasoning as secrets.
      }
      rmSync(tmpFile, { force: true });
    }

    // 3. Services
    const createdServices: string[] = [];
    for (const svc of stack.services) {
      const existing = await serviceExists(svc.name);
      if (existing) {
        try {
          await run('docker', ['service', 'update', '--image', svc.image, svc.name], {
            heartbeatMs: 30_000,
            heartbeatLabel: `swarm service update ${svc.name}`,
          }, () => {});
        } catch (err) {
          await this.markPartial(stack.name, createdServices, err);
          return await this.snapshotStatus(stack);
        }
      } else {
        try {
          await run('docker', buildServiceCreateArgs(svc, stack), {
            heartbeatMs: 30_000,
            heartbeatLabel: `swarm service create ${svc.name}`,
          }, () => {});
        } catch (err) {
          await this.markPartial(stack.name, createdServices, err);
          return await this.snapshotStatus(stack);
        }
      }
      createdServices.push(svc.name);
    }

    // 4. Persist
    const state: SwarmStackState = {
      name: stack.name,
      networks: stack.networks.map((n) => n.name),
      secrets: stack.secrets.map((s) => s.name),
      configs: stack.configs.map((c) => c.name),
      serviceNames: stack.services.map((s) => s.name),
      appliedAt: new Date().toISOString(),
    };
    writeFileSync(join(stackDir, 'stack.json'), JSON.stringify(state, null, 2), 'utf8');
    await this.upsertRow(state);

    return await this.snapshotStatus(stack);
  }

  async removeStack(name: string): Promise<void> {
    const state = await this.readState(name);
    if (state) {
      for (const svc of state.serviceNames) {
        try {
          await run('docker', ['service', 'rm', svc], {
            heartbeatMs: 20_000,
            heartbeatLabel: `swarm service rm ${svc}`,
          }, () => {});
        } catch {
          // Missing service is fine.
        }
      }
      for (const c of state.configs) {
        try {
          await run('docker', ['config', 'rm', c], {
            heartbeatMs: 10_000,
            heartbeatLabel: `swarm config rm ${c}`,
          }, () => {});
        } catch {
          // Missing
        }
      }
      for (const s of state.secrets) {
        try {
          await run('docker', ['secret', 'rm', s], {
            heartbeatMs: 10_000,
            heartbeatLabel: `swarm secret rm ${s}`,
          }, () => {});
        } catch {
          // Missing
        }
      }
      for (const n of state.networks) {
        try {
          await run('docker', ['network', 'rm', n], {
            heartbeatMs: 10_000,
            heartbeatLabel: `swarm network rm ${n}`,
          }, () => {});
        } catch {
          // Missing
        }
      }
    }
    try {
      rmSync(join(STACK_ROOT, name), { recursive: true, force: true });
    } catch {
      // Missing
    }
    await this.db.delete(swarmStacks).where(eq(swarmStacks.name, name));
  }

  async listStacks(): Promise<Array<{ name: string; serviceCount: number }>> {
    const rows: Array<{ name: string; stateJson: string }> = await this.db
      .select({ name: swarmStacks.name, stateJson: swarmStacks.stateJson })
      .from(swarmStacks);
    return rows.map((r) => ({
      name: r.name,
      serviceCount: parseJson<SwarmStackState>(r.stateJson).serviceNames?.length ?? 0,
    }));
  }

  async getStackStatus(name: string): Promise<StackStatus | null> {
    const state = await this.readState(name);
    if (!state) return null;
    const services: StackStatus['services'] = [];
    for (const svc of state.serviceNames) {
      let replicas = 0;
      let stateLabel: 'running' | 'stopped' | 'partial' | 'unknown' = 'unknown';
      try {
        const out = await capture('docker', [
          'service',
          'ls',
          '--filter',
          `name=${svc}`,
          '--format',
          '{{.Replicas}} {{.DesiredTasks}}',
        ]);
        const tokens = (out ?? '').trim().split(/\s+/);
        const replicasStr = tokens[0];
        const desiredStr = tokens[1];
        replicas = Number(replicasStr?.split('/')[0] ?? 0);
        const desired = Number(desiredStr ?? 0);
        if (replicas >= desired && desired > 0) {
          stateLabel = 'running';
        } else if (replicas === 0) {
          stateLabel = 'stopped';
        } else if (replicas < desired) {
          stateLabel = 'partial';
        }
      } catch {
        stateLabel = 'unknown';
      }
      services.push({ name: svc, state: stateLabel, replicas });
    }
    return { name, services, appliedAt: state.appliedAt };
  }

  // --- private helpers ---------------------------------------------------

  private async snapshotStatus(stack: StackSpec): Promise<StackStatus> {
    return (
      (await this.getStackStatus(stack.name)) ?? {
        name: stack.name,
        services: stack.services.map((s) => ({ name: s.name, state: 'unknown', replicas: 0 })),
        appliedAt: new Date().toISOString(),
      }
    );
  }

  private async markPartial(name: string, created: string[], err: unknown): Promise<void> {
    void err;
    const partial: SwarmStackState = {
      name,
      networks: [],
      secrets: [],
      configs: [],
      serviceNames: created,
      appliedAt: new Date().toISOString(),
    };
    await this.upsertRow(partial);
  }

  private async readState(name: string): Promise<SwarmStackState | null> {
    const filePath = join(STACK_ROOT, name, 'stack.json');
    if (existsSync(filePath)) {
      try {
        return JSON.parse(readFileSync(filePath, 'utf8')) as SwarmStackState;
      } catch {
        // Fall through to the DB row.
      }
    }
    const row = await this.db.query.swarmStacks.findFirst({
      where: eq(swarmStacks.name, name),
    });
    if (!row) return null;
    return parseJson(row.stateJson);
  }

  private async upsertRow(state: SwarmStackState): Promise<void> {
    const existing = await this.db.query.swarmStacks.findFirst({
      where: eq(swarmStacks.name, state.name),
    });
    if (existing) {
      await this.db
        .update(swarmStacks)
        .set({
          stateJson: JSON.stringify(state),
          lastAppliedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(swarmStacks.id, existing.id));
    } else {
      await this.db.insert(swarmStacks).values({
        name: state.name,
        stateJson: JSON.stringify(state),
      });
    }
  }
}

function buildServiceCreateArgs(svc: StackServiceSpec, _stack: StackSpec): string[] {
  void _stack;
  const args: string[] = [
    'service',
    'create',
    '--name',
    svc.name,
    '--replicas',
    String(svc.replicas),
  ];
  args.push('--update-parallelism', '1', '--update-order', 'start-first');
  for (const n of svc.networks) args.push('--network', n);
  for (const s of svc.secrets) args.push('--secret', `source=${s}`);
  for (const c of svc.configs) args.push('--config', `source=${c}`);
  for (const [k, v] of Object.entries(svc.env)) {
    args.push('--env', `${k}=${v}`);
  }
  for (const [k, v] of Object.entries(svc.labels)) {
    args.push('--label', `${k}=${v}`);
  }
  if (svc.healthPath) {
    args.push('--health-cmd', `curl -f ${svc.healthPath}`);
    args.push('--health-interval', '30s');
    args.push('--health-timeout', '5s');
    args.push('--health-retries', '3');
  }
  if (svc.port !== null) {
    args.push('--publish', `${svc.port}:${svc.port}`);
  }
  args.push(svc.image);
  return args;
}

async function serviceExists(name: string): Promise<boolean> {
  try {
    const out = await capture('docker', [
      'service',
      'ls',
      '--filter',
      `name=${name}`,
      '--format',
      '{{.Name}}',
    ]);
    return (out ?? '').trim() === name;
  } catch {
    return false;
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}
