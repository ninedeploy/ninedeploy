import { OS_UPDATE_ACTIONS, runOsUpdateAction, type OsUpdateAction } from '../lib/osUpdates.js';
import type { AgentOpModule } from './index.js';
import { NODE_PROXY_IMAGE, RE_IMAGE, str } from './operands.js';

/** The helper that enters the host: `NINEDEPLOY_HOST_SHELL_IMAGE`, else the node proxy's image (already present, has nsenter). */
function helperImage(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env['NINEDEPLOY_HOST_SHELL_IMAGE'] ?? '').trim();
  return configured && configured.length <= 255 && RE_IMAGE.test(configured) ? configured : NODE_PROXY_IMAGE;
}

/**
 * G4.2 `host.packages {action}` → one line, the host's update status as JSON.
 * `action` picks a fixed script (lib/osUpdates.ts); nothing else is read from
 * the request. Sealed only: it changes the host's package configuration.
 * The node's owner turns it off with `NINEDEPLOY_AGENT_HOST_PACKAGES=off`.
 */
export const osUpdateOps: AgentOpModule = {
  name: 'osUpdates',
  caps: ['host.packages'],
  ops: {
    'host.packages': {
      cap: 'host.packages',
      sealedOnly: true,
      async run(params, onLine) {
        const action = str(params, 'action');
        if (!action || !(OS_UPDATE_ACTIONS as readonly string[]).includes(action)) throw new Error('host.packages: unknown action');
        const status = await runOsUpdateAction(helperImage(), action as OsUpdateAction);
        onLine(JSON.stringify(status));
        return 0;
      },
    },
  },
};
