import { createHash } from 'node:crypto';
import type { StackSpec } from '../kernel/types.js';
import { capture } from '../lib/exec.js';

export type ManagedSwarmSpec = Record<string, unknown>;

/** Docker omits default/empty fields on round-trip. Preserve every nondefault field, including unknown fields. */
const ZERO_DEFAULTS = new Set(['TaskTemplate.ForceUpdate', 'TaskTemplate.RestartPolicy.MaxAttempts', 'TaskTemplate.RestartPolicy.Window', 'UpdateConfig.Delay', 'UpdateConfig.MaxFailureRatio', 'RollbackConfig.Delay', 'RollbackConfig.MaxFailureRatio']);
function normalized(value: unknown, path = ''): unknown {
  if (value == null || value === 0 && ZERO_DEFAULTS.has(path)) return undefined;
  if (Array.isArray(value)) return value.length ? value.map(v => normalized(v, `${path}[]`) ?? null) : undefined;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const next = normalized((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
      if (next !== undefined) out[key] = next;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

/** Keep fingerprints inside the encrypted journal; env values must not acquire a public hash oracle. */
export function swarmSpecFingerprint(spec: ManagedSwarmSpec): string {
  return createHash('sha256').update(JSON.stringify(normalized(spec))).digest('hex');
}

/** The managed service's narrow StackSpec surface, expressed directly as an Engine ServiceSpec. */
export async function managedSwarmServiceSpec(stack: StackSpec): Promise<ManagedSwarmSpec> {
  if (stack.services.length !== 1 || stack.services[0]?.name !== 'web' || stack.volumes.length || stack.configs.length || stack.secrets.length) throw new Error('Unsupported managed Swarm service shape');
  const service = stack.services[0];
  if (service.secrets.length || service.configs.length || !/^nd-[a-z0-9][a-z0-9-]{0,62}$/.test(stack.name)) throw new Error('Unsupported managed Swarm service inputs');
  const networks = [];
  for (const name of service.networks) {
    const id = (await capture('docker', ['network', 'inspect', '--format', '{{.Id}}', name], { timeoutMs: 30_000, maxOutputBytes: 1024 })).trim();
    if (!/^[a-z0-9]{25}$/.test(id)) throw new Error('Swarm overlay network identity is unconfirmed');
    networks.push({ Target: id, Aliases: ['web'] });
  }
  if (!networks.length) throw new Error('Managed Swarm service requires its encrypted overlay');
  const container: Record<string, unknown> = {
    Image: service.image,
    Labels: { ...service.containerLabels, 'com.docker.stack.namespace': stack.name },
    Env: Object.keys(service.env).sort().map(key => `${key}=${service.env[key]}`),
    Isolation: 'default',
    StopGracePeriod: (service.stopGraceSeconds ?? 10) * 1_000_000_000,
  };
  if (service.command?.length) container.Args = service.command;
  if (service.fileSecrets?.length) {
    // File mounts (lib/swarmFileSecrets.ts): read-only, owned by root, at their absolute path.
    container.Secrets = service.fileSecrets.map((f) => {
      if (!/^[a-z0-9]{25}$/.test(f.secretId) || !f.target.startsWith('/') || !/^nd-[a-z0-9-]+-f\d+-[a-f0-9]{12}$/.test(f.secretName)) {
        throw new Error('Unsupported managed Swarm file mount');
      }
      return { File: { Name: f.target, UID: '0', GID: '0', Mode: 0o444 }, SecretID: f.secretId, SecretName: f.secretName };
    });
  }
  const options = service.containerOptions;
  if (options?.init) container.Init = true;
  if (options?.capAdd?.length) {
    if (!options.capAdd.every((c) => /^CAP_[A-Z_]{2,32}$/.test(c))) throw new Error('Unsupported managed Swarm capability');
    container.CapabilityAdd = [...options.capAdd];
  }
  if (options?.ulimitNofile) container.Ulimits = [{ Name: 'nofile', Soft: options.ulimitNofile, Hard: options.ulimitNofile }];
  // Swarm has no --shm-size; a sized tmpfs over /dev/shm is the same thing to the app.
  if (options?.shmSizeMb) container.Mounts = [{ Type: 'tmpfs', Target: '/dev/shm', TmpfsOptions: { SizeBytes: options.shmSizeMb * 1024 * 1024 } }];
  if (service.healthCommand) container.Healthcheck = { Test: ['CMD-SHELL', service.healthCommand], Interval: 5_000_000_000, Timeout: 10_000_000_000, Retries: 3 };
  const limits: Record<string, number> = {};
  if (service.cpuLimitMilli && service.cpuLimitMilli > 0) limits.NanoCPUs = service.cpuLimitMilli * 1_000_000;
  if (service.memLimitMb && service.memLimitMb > 0) limits.MemoryBytes = service.memLimitMb * 1024 * 1024;
  return {
    Name: `${stack.name}_web`,
    Labels: { ...service.labels, 'com.docker.stack.namespace': stack.name, 'com.docker.stack.image': service.image },
    TaskTemplate: {
      ContainerSpec: container,
      Runtime: 'container',
      RestartPolicy: { Condition: 'any', Delay: 5_000_000_000 },
      ...(Object.keys(limits).length ? { Resources: { Limits: limits } } : {}),
      ...(service.constraints?.length ? { Placement: { Constraints: service.constraints } } : {}),
      Networks: networks,
    },
    Mode: { Replicated: { Replicas: service.replicas } },
    UpdateConfig: { Parallelism: 1, Order: 'start-first', FailureAction: 'rollback', Monitor: 30_000_000_000 },
    RollbackConfig: { Parallelism: 1, Order: 'start-first', FailureAction: 'pause', Monitor: 5_000_000_000 },
    EndpointSpec: { Mode: 'vip' },
  };
}
