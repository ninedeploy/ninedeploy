import { NODE_HOOK_REPLY, runNodeDeployHook } from '../lib/nodeDeployHookRun.js';
import type { AgentOpModule } from './index.js';

/**
 * P2: deploy hooks of a node service, run as a one-off container from the
 * release image (lib/nodeDeployHookRun.ts). Sealed only: the env file it reads
 * holds the service's secrets, and so may the hook's output.
 */
export const deployHookOps: AgentOpModule = {
  name: 'agentOps/deployHooks.ts',
  caps: ['docker.hooks'],
  ops: {
    'docker.hookRun': {
      cap: 'docker.hooks',
      sealedOnly: true,
      async run(params, sink) {
        const receipt = await runNodeDeployHook(params, sink);
        sink(`${NODE_HOOK_REPLY}${JSON.stringify(receipt)}`);
        return 0;
      },
    },
  },
};
