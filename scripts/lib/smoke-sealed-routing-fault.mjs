import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';

/** Owned smoke transport: forward bytes unchanged, drop exactly one verified routing response. */
export function createSealedRoutingFault({ server, decode, onMutation, onError }) {
  let armed = false, dropped = false, routingHash;
// Forward the actual sealed bytes to the enrolled agent. Only after the real
// agent confirms its loaded config do we drop one panel-facing TCP connection.
// No runtime collaborator or receipt is substituted.
const forwarder = createServer(async (incoming, outgoing) => {
  let upstream;
  try {
    const chunks = []; let size = 0;
    for await (const chunk of incoming) {
      size += chunk.length; assert.ok(size <= 2 * 1024 * 1024); chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const command = incoming.url === '/agent/exec' ? decode(JSON.parse(bytes).sealed) : null;
    if (command && ['docker.stopSet', 'docker.startSet', 'docker.lifecycle'].includes(command.op)) onMutation(command.op);
    upstream = request({ hostname: server.host, port: server.port, path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, host: `${server.host}:${server.port}` }, timeout: 30_000 }, response => {
      const parts = []; let responseSize = 0;
      response.on('data', chunk => {
        responseSize += chunk.length;
        if (responseSize > 4 * 1024 * 1024) upstream.destroy(new Error('Oversized agent response'));
        else parts.push(chunk);
      });
      response.on('error', () => outgoing.destroy());
      response.on('end', () => {
        try {
          const body = Buffer.concat(parts);
          if (armed && !dropped && command?.op === 'proxy.confirmRouting') {
            assert.equal(response.statusCode, 200);
            const receipt = decode(JSON.parse(body).sealed);
            assert.equal(receipt.nonce, command.nonce); assert.equal(receipt.exitCode, 0);
            routingHash = createHash('sha256').update(command.params.content).digest('hex');
            assert.ok(receipt.lines.includes(`ND-PROXY-ROUTING ${routingHash}`));
            // Leave the genuinely loaded fallback visible to the independent
            // observer before losing its acknowledgement on the wire.
            dropped = true; setTimeout(() => outgoing.destroy(), 1000); return;
          }
          outgoing.writeHead(response.statusCode, response.headers); outgoing.end(body);
        } catch { onError('response-verification'); outgoing.destroy(); }
      });
    });
    upstream.on('timeout', () => upstream.destroy(new Error('Upstream deadline')));
    upstream.on('error', () => outgoing.destroy()); upstream.end(bytes);
  } catch { onError('request-forwarding'); upstream?.destroy(); outgoing.destroy(); }
});
forwarder.requestTimeout = 35_000; forwarder.headersTimeout = 10_000;
  return { server: forwarder, arm() { armed = true; }, receipt() { return { dropped, routingHash }; } };
}
