import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createClient } from '@ninedeploy/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer, handleHttpRequest } from '../src/index.js';

/** R4: the Streamable HTTP handler the panel mounts at /v1/mcp, behind a plain node server here. */
let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function serve(opts: { readOnly?: boolean; tokenScopes?: string[] | null }, fetch: ReturnType<typeof vi.fn>) {
  const client = createClient({ baseUrl: 'http://api.test', getToken: () => 'tok', fetch: fetch as never });
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      void handleHttpRequest(req, res, raw ? JSON.parse(raw) : undefined, {
        client,
        build: (c, o) => buildServer(c, () => undefined, o),
        ...opts,
      });
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as { port: number };
  const mcp = new Client({ name: 'test', version: '1' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return mcp;
}

describe('handleHttpRequest (R4)', () => {
  it('serves the tools statelessly and runs them through the given client', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify([{ id: 1, name: 'web' }]), { status: 200 }));
    const mcp = await serve({}, fetch);
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_services', 'deploy_service']));
    const res = await mcp.callTool({ name: 'list_services', arguments: {} });
    expect(JSON.stringify(res.content)).toContain('web');
    expect(fetch).toHaveBeenCalledWith('http://api.test/v1/services', expect.objectContaining({ method: 'GET' }));
    await mcp.close();
  });

  it('applies read-only and the token scopes to the tool list', async () => {
    const fetch = vi.fn(async () => new Response('[]', { status: 200 }));
    const ro = await serve({ readOnly: true }, fetch);
    expect((await ro.listTools()).tools.map((t) => t.name)).not.toContain('deploy_service');
    await ro.close();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    const scoped = await serve({ tokenScopes: ['nd://scope/read/services'] }, fetch);
    const names = (await scoped.listTools()).tools.map((t) => t.name);
    expect(names).toContain('list_services');
    expect(names).not.toContain('deploy_service');
    await scoped.close();
  });
});
