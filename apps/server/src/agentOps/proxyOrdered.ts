import { z } from 'zod';
import { orderedNodeProxyWrite } from '../lib/nodeProxyJournal.js';
import { nodeProxyJournalDirectory, writeNodeProxyFile } from '../lib/nodeProxyFiles.js';
import type { AgentOpModule } from './index.js';

const request = z.object({ requestId: z.string().regex(/^[a-f0-9]{32}$/), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  timeoutMs: z.number().int().min(1).max(30_000), content: z.string().refine(value => !value.includes('\0') && Buffer.byteLength(value) <= 1_048_576) }).strict();
export const proxyOrderedOps: AgentOpModule = {
  name: 'proxyOrdered', caps: ['proxy.orderedWrite'],
  ops: { 'proxy.writeOrderedConfig': { cap: 'proxy.orderedWrite', sealedOnly: true, async run(params, onLine) {
    const input = request.parse(params);
    const receipt = await orderedNodeProxyWrite(nodeProxyJournalDirectory(), input, async content => writeNodeProxyFile('dynamic', content).changed);
    onLine(`ND-PROXY-WRITE ${JSON.stringify(receipt)}`); return 0;
  } } },
};
