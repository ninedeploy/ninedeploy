import { probeContainer } from '../lib/containerProbe.js';
import { spawnValidated } from '../lib/spawnValidated.js';
import type { AgentOpModule } from './index.js';
import { RE_NAME, str, validated } from './operands.js';

export const observabilityOps: AgentOpModule = {
  name: 'observability',
  caps: ['docker.probe', 'docker.logsSince'],
  ops: {
    'docker.probe': {
      cap: 'docker.probe', sealedOnly: true,
      run: probeContainer,
    },
    'docker.logsSince': {
      cap: 'docker.logsSince', sealedOnly: true,
      async run(params, onLine) {
        const name = validated(str(params, 'name'), RE_NAME, 'container name');
        const since = validated(str(params, 'since'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/, 'log cursor');
        let count = 0;
        let bytes = 0;
        return spawnValidated('docker', ['logs', '--timestamps', '--since', since, '--tail', '1000', name], (line) => {
          const bounded = line.slice(0, 16_384);
          bytes += Buffer.byteLength(bounded);
          if (count++ < 1000 && bytes <= 256 * 1024) onLine(bounded);
        }, { timeoutMs: 10_000 });
      },
    },
  },
};
