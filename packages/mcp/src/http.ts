import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { createClient } from '@ninedeploy/sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * R4 remote MCP: answer one Streamable HTTP request. Stateless: every POST
 * gets its own server and transport, built for the caller's credential, so
 * nothing (tools, scopes, a session id) is shared between callers or kept
 * between requests. The host checks the credential first; each tool call
 * then goes through `client` with that same credential, so the API's own
 * per-route authorization applies to it, and a revoked token stops working
 * on the next call.
 */
export async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  opts: {
    client: ReturnType<typeof createClient>;
    build: (client: ReturnType<typeof createClient>, options: { readOnly?: boolean; tokenScopes?: string[] | null }) => McpServer;
    readOnly?: boolean;
    tokenScopes?: string[] | null;
  },
): Promise<void> {
  const server = opts.build(opts.client, { readOnly: opts.readOnly, tokenScopes: opts.tokenScopes });
  // No session id: the stateless mode. JSON responses, no SSE stream to hold open.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
