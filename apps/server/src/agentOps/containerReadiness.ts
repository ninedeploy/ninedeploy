import { performance } from 'node:perf_hooks';
import { containerReadinessReply, containerReadinessRequest, type ContainerReadinessReply } from '@ninedeploy/schemas';
import { probeContainer } from '../lib/containerProbe.js';
import { spawnValidated } from '../lib/spawnValidated.js';
import { confirmedNodeProbe } from '../lib/nodeProbeReceipt.js';
import type { AgentOpModule } from './index.js';

const FORMAT = '{"id":{{json .Id}},"name":{{json .Name}},"status":{{json .State.Status}},"health":{{with index .State "Health"}}{{json .Status}}{{else}}"none"{{end}},"failingStreak":{{with index .State "Health"}}{{.FailingStreak}}{{else}}0{{end}},"restarts":{{.RestartCount}}}';
let active = 0;

/** A single bounded sample of all serving replicas; the controller owns consecutive-sample policy. */
export const containerReadinessOps: AgentOpModule = {
  name: 'containerReadiness', caps: ['docker.readiness'],
  ops: {
    'docker.readiness': {
      cap: 'docker.readiness', sealedOnly: true,
      async run(params, onLine) {
        const input = containerReadinessRequest.parse(params);
        if (active >= 2) throw new Error('Node readiness capacity is busy');
        active++;
        const deadline = performance.now() + input.timeoutMs;
        const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
        const inspect = async () => {
          const rows: unknown[] = []; let bytes = 0, invalid = false;
          if (!remaining()) throw new Error('Node readiness deadline exceeded');
          const code = await spawnValidated('docker', ['inspect', '--format', FORMAT, ...input.targets.map(t => t.id)], line => {
            bytes += Buffer.byteLength(line);
            if (bytes > 64 * 1024 || rows.length >= input.targets.length) { invalid = true; return; }
            try { rows.push(JSON.parse(line)); } catch { invalid = true; }
          }, { timeoutMs: remaining() });
          if (invalid || code !== 0 || !remaining() || rows.length !== input.targets.length) throw new Error('Incomplete readiness inspection');
          const items = rows.map(raw => {
            const row = raw as Record<string, unknown>;
            return { ...row, name: typeof row.name === 'string' ? row.name.replace(/^\//, '') : row.name, ready: false };
          });
          const parsed = containerReadinessReply.parse({ requestId: input.requestId, complete: true, items });
          if (new Set(parsed.items.map(i => i.id)).size !== input.targets.length || input.targets.some(t => !parsed.items.some(i => i.id === t.id && i.name === t.name))) throw new Error('Readiness identity changed');
          return new Map(parsed.items.map(i => [i.id, i]));
        };
        try {
          const before = await inspect();
          const readiness = new Map<string, boolean>();
          const probes = await Promise.allSettled(input.targets.map(async target => {
            const row = before.get(target.id)!;
            let ready = row.status === 'running' && (row.health === 'healthy' || row.health === 'none' && input.mode !== 'command');
            if (ready && (input.mode === 'http-strict' || input.mode === 'tcp')) {
              if (!remaining()) ready = false;
              else {
                const protocol = input.mode === 'tcp' ? 'tcp' : 'http';
                const lines: string[] = [];
                const exitCode = await probeContainer({ name: target.id, port: input.port, protocol, path: input.path }, line => lines.push(line), { timeoutMs: remaining() });
                ready = confirmedNodeProbe(lines, exitCode, protocol);
              }
            }
            readiness.set(target.id, ready);
          }));
          const failed = probes.find(result => result.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
          const after = await inspect();
          const reply: ContainerReadinessReply = { requestId: input.requestId, complete: remaining() > 0, items: input.targets.map(target => {
            const row = after.get(target.id)!, previous = before.get(target.id)!;
            return { ...row, ready: readiness.get(target.id) === true && row.status === 'running' &&
              (row.health === 'healthy' || row.health === 'none' && input.mode !== 'command') && row.restarts === previous.restarts };
          }) };
          onLine(`ND-READINESS ${JSON.stringify(reply)}`); return 0;
        } finally { active--; }
      },
    },
  },
};
