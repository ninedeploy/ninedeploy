import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, DEFAULT_IO, isDirectRun, main, staticToken } from '../src/index.js';
import type { NineDeployClient } from '@ninedeploy/sdk';

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    mock = true;
  },
}));

/** End-to-end over an in-memory MCP transport with a fake SDK client. */
async function connected(
  client: NineDeployClient,
  options: { readOnly?: boolean; tokenScopes?: string[] | null } = {},
) {
  const server = buildServer(client, () => undefined, options);
  const mcp = new Client({ name: 'test', version: '0' });
  const [cs, ss] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(cs), server.connect(ss)]);
  return mcp;
}

const fake = () =>
  ({
    services: { list: vi.fn(async () => [{ id: 1, name: 'api', status: 'running' }]), restart: vi.fn(async () => ({ ok: true })) },
    deploys: {
      trigger: vi.fn(async () => ({ deploymentId: 42 })),
      cancel: vi.fn(async () => ({ ok: true, status: 'cancelled' })),
      remove: vi.fn(async () => ({ ok: true, id: 42 })),
      queue: vi.fn(async () => ({ items: [], count: 0, byStatus: { queued: 0, building: 0, deploying: 0 } })),
    },
  }) as unknown as NineDeployClient;

describe('buildServer', () => {
  it('lists all tools with schemas', async () => {
    const mcp = await connected(fake());
    const tools = await mcp.listTools();
    expect(tools.tools).toHaveLength(38);
    expect(tools.tools.map((t) => t.name)).toContain('deploy_service');
    // An agent that can start a build must be able to stop one.
    expect(tools.tools.map((t) => t.name)).toContain('cancel_deploy');
    // An agent that lists builds should also be able to clean them up.
    expect(tools.tools.map((t) => t.name)).toContain('remove_deploy');
    // Global queue view mirrors the web /deploys page.
    expect(tools.tools.map((t) => t.name)).toContain('list_queue');
    expect(tools.tools.map((t) => t.name)).toContain('list_services');
    expect(tools.tools.map((t) => t.name)).toContain('list_workspaces');
    expect(tools.tools.map((t) => t.name)).toContain('list_container_files');
    expect(tools.tools.map((t) => t.name)).toContain('inspect_container');
    expect(tools.tools.map((t) => t.name)).toContain('get_container_compose');
    expect(tools.tools.map((t) => t.name)).toContain('list_log_drains');
    expect(tools.tools.map((t) => t.name)).toContain('seed_demo');
    expect(tools.tools.map((t) => t.name)).toContain('update_service');
    expect(tools.tools.map((t) => t.name)).toContain('list_plugins');
    expect(tools.tools.map((t) => t.name)).toContain('list_configs');
  });

  it('serves a tool call as JSON text', async () => {
    const c = fake();
    const mcp = await connected(c);
    const res = await mcp.callTool({ name: 'list_services', arguments: {} });
    expect(res.content).toEqual([{ type: 'text', text: JSON.stringify([{ id: 1, name: 'api', status: 'running' }], null, 2) }]);
  });

  it('treats empty scope lists and session markers as unrestricted, like the server does', async () => {
    // The server normalizes an EMPTY scope array to null ("unrestricted
    // legacy token", lib/auth.ts) and reports `['session']` for interactive
    // JWTs (introspection endpoint). Both must keep every tool registered —
    // a shared pending-scope filter would silently drop all scoped tools.
    for (const tokenScopes of [[], ['session']]) {
      const mcp = await connected(fake(), { tokenScopes });
      expect((await mcp.listTools()).tools).toHaveLength(38);
    }
  });

  it('narrows tools to a scoped token and keeps unscoped tools available', async () => {
    const mcp = await connected(fake(), { tokenScopes: ['nd://scope/read/services'] });
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('list_services');
    expect(names).not.toContain('deploy_service');
    expect(names).not.toContain('inspect_container');
  });

  // r333: a fine-grained token is a 403 on every route the server's scope map
  // does not classify, so advertising those tools to it only produced errors.
  it('r333: hides unmapped-route tools from fine-grained tokens, whatever scopes they hold', async () => {
    const mcp = await connected(fake(), {
      tokenScopes: ['operator', 'nd://scope/read/services', 'nd://scope/read/config'],
    });
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    for (const hidden of ['activity_log', 'system_stats', 'list_plugins', 'list_menus', 'list_workspaces', 'inspect_container', 'list_log_drains', 'seed_demo']) {
      expect(names).not.toContain(hidden);
    }
    expect(names).toContain('list_services');
    expect(names).toContain('list_queue');
    expect(names).toContain('list_configs');
    expect(names).toContain('health');
  });

  it('r333: coarse tokens keep unmapped-route tools, gated by the operator flag', async () => {
    const read = (await (await connected(fake(), { tokenScopes: ['read'] })).listTools()).tools.map((t) => t.name);
    expect(read).toContain('system_stats');
    expect(read).toContain('list_workspaces');
    expect(read).not.toContain('activity_log');
    expect(read).not.toContain('list_configs');
    const op = (await (await connected(fake(), { tokenScopes: ['operator'] })).listTools()).tools.map((t) => t.name);
    expect(op).toContain('activity_log');
    expect(op).toContain('list_configs');
    expect(op).toContain('inspect_container');
  });

  it('r333: list_queue is offered to a read/services token, not a read/deploys one', async () => {
    const svc = (await (await connected(fake(), { tokenScopes: ['nd://scope/read/services'] })).listTools()).tools.map((t) => t.name);
    expect(svc).toContain('list_queue');
    const dep = (await (await connected(fake(), { tokenScopes: ['nd://scope/read/deploys'] })).listTools()).tools.map((t) => t.name);
    expect(dep).not.toContain('list_queue');
  });

  it('uses a fail-closed allowlist in read-only mode', async () => {
    const mcp = await connected(fake(), { readOnly: true });
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('list_services');
    expect(names).not.toContain('inspect_container');
    expect(names).not.toContain('get_container_compose');
    expect(names).not.toContain('list_configs');
    expect(names).not.toContain('deploy_service');
    expect(names).not.toContain('set_config');
    expect(names).not.toContain('system_autoprune');
    expect(names).not.toContain('install_plugin');
  });

  it('rejects invalid arguments with isError', async () => {
    const mcp = await connected(fake());
    const res = await mcp.callTool({ name: 'deploy_service', arguments: { serviceId: -1 } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toMatch(/Invalid/i);
  });

  it('stringifies non-Error handler failures', async () => {
    const c = fake();
    (c.deploys.trigger as ReturnType<typeof vi.fn>).mockRejectedValue('plain-failure');
    const mcp = await connected(c);
    const res = await mcp.callTool({ name: 'deploy_service', arguments: { serviceId: 1 } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect((res.content as Array<{ type: string; text: string }>)[0]!.text).toBe('plain-failure');
  });

  it('rejects absent arguments at the protocol layer', async () => {
    const mcp = await connected(fake());
    const res = await mcp.callTool({ name: 'list_services', arguments: undefined });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain('-32602');
  });

  it('surfaces handler failures as isError, not crashes', async () => {
    const c = fake();
    (c.deploys.trigger as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const mcp = await connected(c);
    const res = await mcp.callTool({ name: 'deploy_service', arguments: { serviceId: 1 } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect((res.content as Array<{ type: string; text: string }>)[0]!.text).toBe('boom');
  });
});

describe('main (entrypoint wiring)', () => {
  it('exits with an error when NINEDEPLOY_TOKEN is missing', async () => {
    const error = vi.fn();
    const exit = vi.fn();
    await main({}, { error, exit, connect: async () => {} });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('NINEDEPLOY_TOKEN is required'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('connects the built server when configured', async () => {
    const error = vi.fn();
    const exit = vi.fn();
    const connect = vi.fn(async () => {});
    // Stub the global fetch so the token introspection at startup
    // resolves cleanly — the test only cares that `main` wires
    // through to `connect` and that no fatal error is logged.
    // A real fetch to `http://x` would fail on Node's DNS resolver
    // and surface as a "token introspection failed" warning, which
    // is intentional behaviour (the lib falls back to no scope
    // filter) but unrelated to what this test exercises.
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({ scopes: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fakeFetch as unknown as typeof fetch);
    try {
      await main({ NINEDEPLOY_TOKEN: 'tok', NINEDEPLOY_URL: 'http://x' }, { error, exit, connect });
      expect(connect).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to no scope filter when token introspection throws (logs once, keeps going)', async () => {
    const error = vi.fn();
    const exit = vi.fn();
    const connect = vi.fn(async () => {});
    // The fetch rejects outright (network blip, DNS failure, etc).
    // The lib catches and logs the failure, then continues without
    // a scope filter so a startup-time introspection failure does
    // NOT silently drop every tool.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    );
    try {
      await main({ NINEDEPLOY_TOKEN: 'tok', NINEDEPLOY_URL: 'http://x' }, { error, exit, connect });
      expect(connect).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();
      // The lib logs the introspection failure exactly once via
      // `io.error`. The message acknowledges the fallback.
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/token introspection failed.*continuing without scope filter/),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('production defaults', () => {
  it('DEFAULT_IO.error writes to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    DEFAULT_IO.error('mcp-msg');
    expect(spy).toHaveBeenCalledWith('mcp-msg');
    spy.mockRestore();
  });

  it('DEFAULT_IO.connect wires the server to a stdio transport', async () => {
    const server = { connect: vi.fn(async () => {}) } as unknown as Parameters<typeof DEFAULT_IO.connect>[0];
    await DEFAULT_IO.connect(server);
    expect(server.connect).toHaveBeenCalledOnce();
    const transport = (server.connect as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { mock?: boolean };
    expect(transport).toBeInstanceOf(Object);
    expect((transport as { mock?: boolean }).mock).toBe(true);
  });

  it('isDirectRun only matches when argv[1] resolves to this module', () => {
    // The self URL comparison must accept both the compiled entrypoint and
    // the TS source path forms of this very module…
    const self = pathToFileURL('/ninedeploy/dist/index.js').href;
    expect(isDirectRun('/ninedeploy/dist/index.js', self)).toBe(true);
    const selfTs = pathToFileURL('/ninedeploy/src/index.ts').href;
    expect(isDirectRun('/ninedeploy/src/index.ts', selfTs)).toBe(true);
    // …and reject any other package's identically-named entrypoint.
    expect(isDirectRun('/other/dist/index.js', self)).toBe(false);
    expect(isDirectRun('/x/test/server.test.ts', self)).toBe(false);
    expect(isDirectRun(undefined, self)).toBe(false);
    expect(isDirectRun('://bad-url\0', self)).toBe(false);
  });

  it('r196: isDirectRun follows the symlink npm installs as the bin', async () => {
    const { mkdtempSync, symlinkSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'nd-mcp-bin-'));
    try {
      const real = join(dir, 'index.js');
      writeFileSync(real, '');
      const link = join(dir, 'ninedeploy-mcp');
      try {
        symlinkSync(real, link, 'file');
      } catch {
        return; // no symlink privilege on this host (Windows without dev mode)
      }
      expect(isDirectRun(link, pathToFileURL(real).href)).toBe(true);
      expect(isDirectRun(join(dir, 'missing'), pathToFileURL(real).href)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('r195: advertises the package version, not a stale literal', async () => {
    const { createRequire } = await import('node:module');
    const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
    const server = buildServer({} as NineDeployClient, () => undefined);
    const info = (server.server as unknown as { _serverInfo: { version: string } })._serverInfo;
    expect(info.version).toBe(pkg.version);
  });

  it('staticToken returns a closure yielding the token', () => {
    expect(staticToken('abc')()).toBe('abc');
  });

  it('DEFAULT_IO.exit terminates the process with the code', () => {
    const spy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    DEFAULT_IO.exit(3);
    expect(spy).toHaveBeenCalledWith(3);
    spy.mockRestore();
  });

  it('runs main automatically when imported as the direct entrypoint', async () => {
    const spy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prev = process.argv[1];
    // The direct-run check compares argv[1] against the module's own URL —
    // under vitest the module's URL is the .ts source path.
    process.argv[1] = fileURLToPath(new URL('../src/index.ts', import.meta.url));
    delete process.env['NINEDEPLOY_TOKEN'];
    vi.resetModules();
    await import('../src/index.js');
    // main() ran with no token: it wrote the usage error and exited 1.
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('NINEDEPLOY_TOKEN is required'));
    expect(spy).toHaveBeenCalledWith(1);
    process.argv[1] = prev;
    spy.mockRestore();
    errSpy.mockRestore();
  });
});
