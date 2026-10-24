import { createHash } from 'node:crypto';
import { load } from 'js-yaml';
import { confirmProxyRouting, routingProbeArgs } from '../lib/proxyRoutingAck.js';
import { spawnValidated } from '../lib/spawnValidated.js';
import type { AgentOpModule } from './index.js';
import { str } from './operands.js';

export const proxyRoutingOps: AgentOpModule = {
  name: 'proxyRouting',
  caps: ['proxy.routingAck'],
  ops: {
    'proxy.confirmRouting': {
      cap: 'proxy.routingAck', sealedOnly: true,
      async run(params, onLine) {
        const content = str(params, 'content');
        if (content === undefined || content.includes('\u0000')) throw new Error('Invalid routing config');
        if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('Routing config too large');
        try {
          const parsed = load(content) as { http?: unknown } | null;
          if (content.trim() && (!parsed || typeof parsed.http !== 'object' || parsed.http === null || Array.isArray(parsed.http))) throw new Error();
        } catch { throw new Error('Invalid routing config'); }
        await confirmProxyRouting(content, { read: async (remainingMs, tls) => {
          let output = '', bytes = 0, overflow = false, bodyStarted = false;
          const code = await spawnValidated('docker', routingProbeArgs('ninedeploy-proxy', tls), line => {
            bytes += Buffer.byteLength(line) + 1;
            if (bytes > 4 * 1024 * 1024) { overflow = true; return; }
            // The bounded line splitter can fragment a large JSON line.
            // Keep header boundaries, then concatenate body fragments verbatim.
            if (/^\s*\{/.test(line)) bodyStarted = true;
            output += line + (bodyStarted ? '' : '\n');
          }, { timeoutMs: Math.min(3000, remainingMs) });
          if (code !== 0 || overflow) throw new Error('Node proxy observation unavailable');
          return output;
        } });
        // Raw API state can contain private configuration: only return a receipt.
        onLine(`ND-PROXY-ROUTING ${createHash('sha256').update(content).digest('hex')}`);
        return 0;
      },
    },
  },
};
