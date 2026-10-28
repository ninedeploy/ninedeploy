import { join } from 'node:path';
import { confirmsMissingContainer, guardLegacyNodeTarget } from '../lib/nodeLegacyMutation.js';
import { spawnValidated } from '../lib/spawnValidated.js';
import type { AgentOpModule } from './index.js';
import { RE_NAME, str } from './operands.js';

export const containerIdentityOps: AgentOpModule = {
  name: 'containerIdentity', caps: ['docker.recovery'],
  ops: {
    'docker.identity': {
      cap: 'docker.recovery', sealedOnly: true,
      async run(params, onLine) {
        const name = str(params, 'name');
        if (!name || name.length > 128 || !RE_NAME.test(name)) throw new Error('Invalid container name');
        const format = '{"id":{{json .Id}},"name":{{json .Name}},"managed":{{json (index .Config.Labels "ninedeploy.managed")}},"serviceId":{{json (index .Config.Labels "ninedeploy.service")}},"deploymentId":{{json (index .Config.Labels "ninedeploy.deployment")}}}';
        let output = '', overflow = false;
        const lines: string[] = [];
        const code = await spawnValidated('docker', ['inspect', '--type', 'container', '--format', format, name], line => {
          if (Buffer.byteLength(output) + Buffer.byteLength(line) > 16_384) { overflow = true; return; }
          output += line;
          lines.push(line);
        }, { timeoutMs: 10_000 });
        if (overflow) throw new Error('Container identity unavailable');
        if (code !== 0) {
          if (confirmsMissingContainer(lines, name)) { onLine('ND-CONTAINER null'); return 0; }
          throw new Error('Container identity unavailable');
        }
        let value: { id: string; name: string; managed?: string; serviceId?: string; deploymentId?: string };
        try {
          value = JSON.parse(output);
          if (!/^[a-f0-9]{64}$/.test(value.id) || typeof value.name !== 'string') throw new Error();
        } catch { throw new Error('Container identity unavailable'); }
        onLine(`ND-CONTAINER ${JSON.stringify({ id: value.id, name: value.name.replace(/^\//, ''), managed: value.managed ?? null, serviceId: value.serviceId ?? null, deploymentId: value.deploymentId ?? null })}`);
        return 0;
      },
    },
    'docker.retire': {
      cap: 'docker.recovery', sealedOnly: true,
      async run(params, onLine, ctx) {
        const id = str(params, 'id'), name = str(params, 'name');
        if (!id || !/^[a-f0-9]{64}$/.test(id) || !name || name.length > 128 || !RE_NAME.test(name)) throw new Error('Invalid container generation');
        const supplied = params['graceSeconds'];
        const grace = supplied === undefined ? 5 : typeof supplied === 'string' && /^\d+$/.test(supplied) ? Number(supplied) : typeof supplied === 'number' ? supplied : NaN;
        if (!Number.isInteger(grace) || grace < 0 || grace > 300) throw new Error('Invalid retirement grace');
        return guardLegacyNodeTarget(ctx.lifecycleJournalRoot ?? join(process.cwd(), '.agent-work', '.lifecycle'), id, async (target, remaining, current) => {
          if (!target) { onLine(`ND-RETIRED ${id}`); return 0; }
          if (target.name !== name) throw new Error('Container generation changed; retained');
          for (const args of [['stop', '-t', String(grace), id], ['rm', '-f', id]]) {
            const errors: string[] = []; let bytes = 0, overflow = false; current();
            const code = await spawnValidated('docker', args, line => {
              bytes += Buffer.byteLength(line);
              if (bytes > 1024) { overflow = true; return; }
              errors.push(line);
            }, { timeoutMs: Math.min(remaining(), args[0] === 'stop' ? Math.max(10_000, (grace + 5) * 1000) : 10_000) });
            current(); if (code !== 0 && (overflow || !confirmsMissingContainer(errors, id))) throw new Error('Container retirement unconfirmed');
          }
          onLine(`ND-RETIRED ${id}`); return 0;
        }, Math.max(35_000, (grace + 30) * 1000));
      },
    },
  },
};
