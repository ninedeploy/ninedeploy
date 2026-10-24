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
        const code = await spawnValidated('docker', ['inspect', '--type', 'container', '--format', format, name], line => {
          if (Buffer.byteLength(output) + Buffer.byteLength(line) > 16_384) { overflow = true; return; }
          output += line;
        }, { timeoutMs: 10_000 });
        if (overflow) throw new Error('Container identity unavailable');
        if (code !== 0) {
          if (/No such (object|container)/i.test(output)) { onLine('ND-CONTAINER null'); return 0; }
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
      async run(params, onLine) {
        const id = str(params, 'id'), name = str(params, 'name');
        if (!id || !/^[a-f0-9]{64}$/.test(id) || !name || name.length > 128 || !RE_NAME.test(name)) throw new Error('Invalid container generation');
        let actual = '';
        const found = await spawnValidated('docker', ['inspect', '--type', 'container', '--format', '{{.Name}}', id], line => { if (actual.length < 1024) actual += line; }, { timeoutMs: 10_000 });
        if (found !== 0) {
          if (/No such (object|container)/i.test(actual)) { onLine(`ND-RETIRED ${id}`); return 0; }
          throw new Error('Container generation unavailable');
        }
        if (actual.trim().replace(/^\//, '') !== name) throw new Error('Container generation changed; retained');
        for (const args of [['stop', '-t', '5', id], ['rm', '-f', id]]) {
          let error = '';
          const code = await spawnValidated('docker', args, line => { if (error.length < 1024) error += line; }, { timeoutMs: 10_000 });
          if (code !== 0 && !/No such (object|container)/i.test(error)) throw new Error('Container retirement unconfirmed');
        }
        onLine(`ND-RETIRED ${id}`); return 0;
      },
    },
  },
};
