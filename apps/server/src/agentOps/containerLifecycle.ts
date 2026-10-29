import { join } from 'node:path';
import { createNodeLifecycle } from '../lib/nodeLifecycle.js';
import type { AgentOpModule } from './index.js';

/** Fixed managed-container effects; readiness and route publication are separate phases. */
export const containerLifecycleOps: AgentOpModule = {
  name: 'containerLifecycle', caps: ['docker.lifecycle', 'docker.lifecycle.generations', 'docker.lifecycle.creationFence'],
  ops: {
    'docker.lifecycle': {
      cap: 'docker.lifecycle', sealedOnly: true,
      async run(params, onLine) {
        // The generated agent command persists its working directory at
        // AGENT_HOME; the image's default /data volume is anonymous.
        const receipt = await createNodeLifecycle(join(process.cwd(), '.agent-work', '.lifecycle')).apply(params);
        onLine(`ND-LIFECYCLE ${JSON.stringify(receipt)}`); return 0;
      },
    },
  },
};
