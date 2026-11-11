import type { AgentOpModule } from './index.js';
import { HttpError } from '../lib/errors.js';
import { ensureNodePagesServer, NODE_PAGES_REPLY, pruneNodePages, writeNodePages } from '../lib/nodePages.js';

/** P2 node maintenance and error pages (lib/nodePages.ts). Every reply is one `ND-PAGES {…}` line. */
async function answer(onLine: (line: string) => void, action: () => unknown): Promise<number> {
  try {
    onLine(`${NODE_PAGES_REPLY}${JSON.stringify(await action())}`);
    return 0;
  } catch (err) {
    const failure = err instanceof HttpError ? err : new HttpError(400, 'node_pages_failed', (err instanceof Error ? err.message : String(err)).slice(0, 500));
    onLine(`${NODE_PAGES_REPLY}${JSON.stringify({ error: { status: failure.statusCode, code: failure.code, message: failure.message } })}`);
    return 1;
  }
}

export const nodePagesOps: AgentOpModule = {
  name: 'nodePages', caps: ['proxy.pages'],
  ops: {
    'proxy.pages.write': { cap: 'proxy.pages', sealedOnly: true, run: (params, sink) => answer(sink, () => writeNodePages(params)) },
    'proxy.pages.prune': { cap: 'proxy.pages', sealedOnly: true, run: (params, sink) => answer(sink, () => pruneNodePages(params)) },
    'proxy.pages.ensure': { cap: 'proxy.pages', sealedOnly: true, run: (_params, sink) => answer(sink, () => ensureNodePagesServer()) },
  },
};
