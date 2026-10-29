import { capture } from '../lib/exec.js';
import { containerImageId, parseTrivyReport, runTrivy } from '../lib/imageScan.js';
import type { AgentOpModule } from './index.js';
import { RE_IMAGE_ID, RE_NAME, str } from './operands.js';

/**
 * G5.1 `image.scan {container, knownImageId?}` → one line, `ND-IMAGE-SCAN
 * <json>`: Trivy on the node, the same `docker save | trivy` the panel host
 * runs (lib/imageScan.ts `runTrivy`, with its cache volume on the node). The
 * report is parsed here, so the answer is the bounded summary (at most 300
 * findings), never the raw report.
 *
 * Only a container the panel started for a service (`ninedeploy.managed=
 * service`) is scanned. With `knownImageId` equal to the container's image the
 * answer is `{"unchanged":true}` and nothing runs. The node's owner turns it
 * off with `NINEDEPLOY_AGENT_IMAGE_SCAN=off`.
 */
export const imageScanOps: AgentOpModule = {
  name: 'agentOps/imageScan.ts',
  caps: ['image.scan'],
  ops: {
    'image.scan': {
      cap: 'image.scan',
      sealedOnly: true,
      async run(params, onLine) {
        const container = str(params, 'container');
        if (!container || container.length > 128 || !RE_NAME.test(container)) throw new Error('image.scan: invalid container');
        const known = str(params, 'knownImageId');
        if (known !== undefined && !RE_IMAGE_ID.test(known)) throw new Error('image.scan: invalid knownImageId');
        const label = (await capture('docker', ['inspect', '--format', '{{index .Config.Labels "ninedeploy.managed"}}', container], { timeoutMs: 30_000 })).trim();
        if (label !== 'service') throw new Error(`image.scan: ${container} is not a service container the panel started`);
        const imageId = await containerImageId(container);
        if (known === imageId) {
          onLine(`ND-IMAGE-SCAN ${JSON.stringify({ imageId, unchanged: true })}`);
          return 0;
        }
        const parsed = parseTrivyReport(await runTrivy(imageId));
        onLine(`ND-IMAGE-SCAN ${JSON.stringify({ imageId, ...parsed })}`);
        return 0;
      },
    },
  },
};
