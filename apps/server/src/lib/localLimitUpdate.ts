import type { Service } from '@ninedeploy/db';
import { replicaNames } from '../engine/dockerNames.js';
import { capture } from './exec.js';
import { runtimeReplicaCounts } from './runtimeReplicaCounts.js';

const FORMAT = '{"id":{{json .Id}},"name":{{json .Name}},"managed":{{json (index .Config.Labels "ninedeploy.managed")}},"serviceId":{{json (index .Config.Labels "ninedeploy.service")}},"deploymentId":{{json (index .Config.Labels "ninedeploy.deployment")}},"status":{{json .State.Status}},"restarts":{{json .RestartCount}},"cpuShares":{{json .HostConfig.CpuShares}},"nanoCpus":{{json .HostConfig.NanoCpus}},"cpuQuota":{{json .HostConfig.CpuQuota}},"memory":{{json .HostConfig.Memory}},"memorySwap":{{json .HostConfig.MemorySwap}}}';
type Row = { id: string; name: string; managed: string; serviceId: string; deploymentId: string; status: string; restarts: number;
  cpuShares: number; nanoCpus: number; cpuQuota: number; memory: number; memorySwap: number };

/** Apply limits to immutable, owned local replicas and verify the resulting configuration. */
export async function applyLocalLimits(service: Service, isCurrent: () => Promise<boolean>): Promise<boolean> {
  if (service.type !== 'docker' || service.serverId != null || service.orchestrator === 'swarm' || service.status !== 'running') return false;
  const generation = /-([1-9]\d*)$/.exec(service.runtimeId ?? '')?.[1];
  if (!generation || !service.runtimeId) return false;
  const shape = runtimeReplicaCounts(service), names = replicaNames(service.runtimeId, shape.capacity);
  const inspect = async (references: string[]): Promise<Row[]> => {
    const output = await capture('docker', ['inspect', '--type', 'container', '--format', FORMAT, ...references]);
    if (Buffer.byteLength(output) > 64 * 1024) throw new Error('Limit target inspection is too large');
    const rows: Row[] = output.trim().split(/\r?\n/).map(line => JSON.parse(line) as Row);
    if (rows.length !== names.length || new Set(rows.map(row => row.id)).size !== names.length ||
      names.some(name => !rows.some(row => typeof row.name === 'string' && row.name.replace(/^\//, '') === name)) ||
      rows.some(row => !/^[a-f0-9]{64}$/.test(row.id) || row.managed !== 'service' || row.serviceId !== String(service.id) ||
        row.deploymentId !== generation || !['running', 'created', 'exited'].includes(row.status) || !Number.isSafeInteger(row.restarts) || row.restarts < 0 ||
        ![row.cpuShares, row.nanoCpus, row.cpuQuota, row.memory, row.memorySwap].every(Number.isSafeInteger) ||
        row.cpuShares < 0 || row.nanoCpus < 0 || row.cpuQuota < -1 || row.memory < 0 || row.memorySwap < -1)) throw new Error('Limit target ownership is unconfirmed');
    if (names.slice(0, shape.serving).some(name => !rows.some(row => row.name.replace(/^\//, '') === name && row.status === 'running'))) {
      throw new Error('A serving limit target is not running');
    }
    return rows;
  };
  try {
    const before = await inspect(names);
    if (!await isCurrent()) return false;
    const argv = ['update'];
    if (service.cpuShares > 0) argv.push('--cpu-shares', String(service.cpuShares));
    if (service.cpuLimitMilli > 0) argv.push('--cpus', String(service.cpuLimitMilli / 1000));
    if (service.memLimitMb > 0) argv.push('--memory', `${service.memLimitMb}m`, '--memory-swap', `${service.memLimitMb}m`);
    if (argv.length === 1) return false;
    await capture('docker', [...argv, ...before.map(row => row.id)]);
    const after = await inspect(before.map(row => row.id));
    if (!await isCurrent()) return false;
    return before.every(first => {
      const last = after.find(row => row.id === first.id);
      if (!last || last.name !== first.name || last.restarts !== first.restarts || last.status !== first.status) return false;
      const cpuMatches = service.cpuLimitMilli > 0 ? last.nanoCpus === service.cpuLimitMilli * 1_000_000 : last.nanoCpus === 0 && last.cpuQuota <= 0;
      const memoryMatches = service.memLimitMb > 0 ? last.memory === service.memLimitMb * 1_048_576 && last.memorySwap === last.memory : last.memory === 0;
      return last.cpuShares === service.cpuShares && cpuMatches && memoryMatches;
    });
  } catch {
    return false;
  }
}
