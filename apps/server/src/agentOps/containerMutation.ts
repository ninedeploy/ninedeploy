import { join } from 'node:path';
import { createNodeRuntimeMutation } from '../lib/nodeRuntimeMutation.js';
import { handoffStoppedNodeToLegacy } from '../lib/nodeLegacyHandoff.js';
import type { AgentOpModule } from './index.js';
const runtime = () => createNodeRuntimeMutation(join(process.cwd(), '.agent-work', '.lifecycle'));
/** Shared per-service ownership for immutable preparation, fencing and retirement. */
export const containerMutationOps: AgentOpModule = {
  name: 'containerMutation', caps: ['docker.mutations', 'docker.prepareAttemptEnv', 'docker.limits', 'docker.startSet'],
  ops: {
    'docker.runtimeFence': { cap: 'docker.mutations', sealedOnly: true, async run(params, onLine) {
      onLine('ND-RUNTIME-FENCE ' + JSON.stringify(await runtime().fence(params))); return 0;
    } },
    'docker.runtimeInventory': { cap: 'docker.mutations', sealedOnly: true, async run(params, onLine) {
      onLine('ND-RUNTIME-INVENTORY ' + JSON.stringify(await runtime().inventory(params))); return 0;
    } },
    'docker.stopSet': { cap: 'docker.mutations', sealedOnly: true, async run(params, onLine) {
      onLine('ND-STOPPED-SET ' + JSON.stringify(await runtime().stop(params, onLine))); return 0;
    } },
    'docker.startSet': { cap: 'docker.startSet', sealedOnly: true, async run(params, onLine) {
      onLine('ND-STARTED-SET ' + JSON.stringify(await runtime().start(params, onLine))); return 0;
    } },
    'docker.runtimeLegacyHandoff': { cap: 'docker.mutations', sealedOnly: true, async run(params, onLine) {
      onLine('ND-RUNTIME-LEGACY ' + JSON.stringify(await handoffStoppedNodeToLegacy(join(process.cwd(), '.agent-work', '.lifecycle'), params))); return 0;
    } },
    'docker.prepare': { cap: 'docker.mutations', sealedOnly: true, async run(params, onLine) {
      onLine('ND-PREPARED ' + JSON.stringify(await runtime().prepare(params, onLine))); return 0;
    } },
    'docker.networkSet': { cap: 'docker.mutations', sealedOnly: true, async run(params, onLine) {
      onLine('ND-NETWORKS ' + JSON.stringify(await runtime().networks(params, onLine))); return 0;
    } },
    'docker.retireSet': { cap: 'docker.mutations', sealedOnly: true, async run(params, onLine) {
      onLine('ND-RETIRED-SET ' + JSON.stringify(await runtime().retire(params, onLine))); return 0;
    } },
    'docker.limits': { cap: 'docker.limits', sealedOnly: true, async run(params, onLine) {
      onLine('ND-LIMITS ' + JSON.stringify(await runtime().limits(params, onLine))); return 0;
    } },
  },
};
