import { containerMetricsReply, containerMetricsRequest } from '@ninedeploy/schemas';
import { spawnValidated } from '../lib/spawnValidated.js';
import type { AgentOpModule } from './index.js';

const INSPECT = '{"id":{{json .Id}},"name":{{json .Name}},"managed":{{json (index .Config.Labels "ninedeploy.managed")}},"serviceId":{{json (index .Config.Labels "ninedeploy.service")}},"deploymentId":{{json (index .Config.Labels "ninedeploy.deployment")}},"status":{{json .State.Status}},"restarts":{{json .RestartCount}},"memoryLimit":{{json .HostConfig.Memory}},"nanoCpus":{{json .HostConfig.NanoCpus}},"cpuQuota":{{json .HostConfig.CpuQuota}},"cpuPeriod":{{json .HostConfig.CpuPeriod}}}';
const STATS = '{"id":{{json .ID}},"name":{{json .Name}},"cpu":{{json .CPUPerc}},"memory":{{json .MemUsage}}}';
let active = 0;

function memoryUsage(value: unknown): number {
  if (typeof value !== 'string') throw new Error('Invalid node memory metric');
  const m = /^([\d]+(?:\.[\d]+)?)\s*([KMGTPE]?i?B)\s*\/\s*[\d]+(?:\.[\d]+)?\s*[KMGTPE]?i?B$/i.exec(value);
  if (!m) throw new Error('Invalid node memory metric');
  const unit = m[2]!.toLowerCase();
  const power = ['b', 'kb', 'mb', 'gb', 'tb', 'pb', 'eb'].indexOf(unit.replace('i', ''));
  const bytes = Math.round(Number(m[1]) * (unit.includes('i') ? 1024 : 1000) ** power);
  if (power < 0 || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid node memory metric');
  return bytes;
}

/** Read-only samples bound to immutable IDs and their actual resource limits. */
export const containerMetricsOps: AgentOpModule = {
  name: 'containerMetrics', caps: ['docker.metrics'],
  ops: {
    'docker.metrics': {
      cap: 'docker.metrics', sealedOnly: true,
      async run(params, onLine) {
        const input = containerMetricsRequest.parse(params);
        if (active >= 2) throw new Error('Node metric sampler capacity is busy');
        active++;
        const deadline = performance.now() + input.timeoutMs;
        const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
        const read = async (args: string[]): Promise<Record<string, unknown>[]> => {
          if (!remaining()) throw new Error('Node metrics deadline exceeded');
          let bytes = 0, invalid = false;
          const rows: Record<string, unknown>[] = [];
          const code = await spawnValidated('docker', args, line => {
            bytes += Buffer.byteLength(line);
            if (bytes > 64 * 1024 || rows.length >= input.targets.length) { invalid = true; return; }
            try {
              const row = JSON.parse(line);
              if (!row || typeof row !== 'object' || Array.isArray(row)) invalid = true;
              else rows.push(row);
            } catch { invalid = true; }
          }, { timeoutMs: remaining() });
          if (invalid || code !== 0 || !remaining() || rows.length !== input.targets.length) throw new Error('Incomplete node metric sample');
          if (new Set(rows.map(row => row.id)).size !== input.targets.length || input.targets.some(target => !rows.some(row => row.id === target.id &&
            typeof row.name === 'string' && row.name.replace(/^\//, '') === target.name))) throw new Error('Node metric identity changed');
          return rows;
        };
        const inspect = async () => {
          const rows = await read(['inspect', '--type', 'container', '--format', INSPECT, ...input.targets.map(t => t.id)]);
          for (const row of rows) {
            if (row.managed !== 'service' || row.serviceId !== String(input.serviceId) || row.deploymentId !== String(input.deploymentId) || row.status !== 'running') {
              throw new Error('Node metric generation or running state changed');
            }
            if (!['memoryLimit', 'nanoCpus', 'cpuPeriod', 'restarts'].every(key => Number.isSafeInteger(row[key]) && Number(row[key]) >= 0) ||
              !Number.isSafeInteger(row.cpuQuota) || Number(row.cpuQuota) < -1) throw new Error('Invalid node metric limits');
          }
          return new Map(rows.map(row => [row.id, row]));
        };
        try {
          const before = await inspect();
          const samples = await read(['stats', '--no-stream', '--no-trunc', '--format', STATS, ...input.targets.map(t => t.id)]);
          const after = await inspect();
          const items = input.targets.map(target => {
            const first = before.get(target.id)!, last = after.get(target.id)!, sample = samples.find(row => row.id === target.id)!;
            if (['restarts', 'memoryLimit', 'nanoCpus', 'cpuQuota', 'cpuPeriod'].some(key => first[key] !== last[key])) throw new Error('Node metric generation or limits changed');
            const cpu = typeof sample.cpu === 'string' && /^\d+(?:\.\d+)?%$/.test(sample.cpu) ? Number(sample.cpu.slice(0, -1)) : Number.NaN;
            if (!Number.isFinite(cpu)) throw new Error('Invalid node CPU metric');
            const cpuLimitMilli = Number(last.nanoCpus) > 0 ? Number(last.nanoCpus) / 1_000_000
              : Number(last.cpuQuota) > 0 && Number(last.cpuPeriod) > 0 ? Number(last.cpuQuota) / Number(last.cpuPeriod) * 1000 : 0;
            return { ...target, cpuPct: cpu, cpuLimitMilli, memBytes: memoryUsage(sample.memory), memLimitBytes: last.memoryLimit,
              restarts: last.restarts };
          });
          const reply = containerMetricsReply.parse({ requestId: input.requestId, serviceId: input.serviceId, deploymentId: input.deploymentId,
            complete: remaining() > 0, items });
          if (!reply.complete) throw new Error('Node metrics deadline exceeded');
          onLine(`ND-METRICS ${JSON.stringify(reply)}`);
          return 0;
        } finally { active--; }
      },
    },
  },
};
