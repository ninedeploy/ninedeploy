#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from '@ninedeploy/sdk';
import { TOOLS } from './tools.js';
export { TOOLS };

/**
 * NineDeploy MCP server (stdio transport).
 *
 * AI assistants use this to inspect and operate a NineDeploy instance.
 * Credentials come from the environment — never from the model:
 *   NINEDEPLOY_URL   base URL of the control plane (default http://127.0.0.1:3000)
 *   NINEDEPLOY_TOKEN an API token (create one in Settings → API tokens)
 *   NINEDEPLOY_MCP_READONLY=1 exposes only the non-mutating, non-secret allowlist
 */

export function buildServer(
  client: ReturnType<typeof createClient>,
  warn: (msg: string) => void = console.error,
  options: { readOnly?: boolean; tokenScopes?: string[] | null } = {},
): McpServer {
  const server = new McpServer({ name: 'ninedeploy', version: '0.7.9' });

  // Read-only mode keeps the pre-existing behaviour (a
  // hand-picked allowlist of mutating-free tools). The
  // fine-grained filter is applied AFTER readOnly: a
  // token that holds `nd://scope/admin/services` can
  // still use the read-only allowlist (those tools don't
  // declare any required scope, so the filter is a no-op
  // for them). A token with no `nd://scope/read/services`
  // scope does NOT lose access to the health / topology
  // tools either, because those declare `read/services`
  // not the broader `read/anything`.
  let tools = options.readOnly ? TOOLS.filter((tool) => READ_ONLY_TOOL_NAMES.has(tool.name)) : TOOLS;
  if (options.tokenScopes !== undefined) {
    // Mirror the server-side normalization (apps/server/src/lib/auth.ts):
    // an EMPTY scope list is the "unrestricted legacy token" and `session`
    // is the interactive-JWT marker — both cover every scope, so the filter
    // must not run for them or all scoped tools would silently disappear.
    const scopes = options.tokenScopes;
    const unrestricted = scopes === null || scopes.length === 0 || scopes.includes('session');
    if (!unrestricted) {
      tools = tools.filter((tool) => toolMeetsScope(tool.requiredScopes, scopes));
    }
  }
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
      },
      async (args) => {
        // The SDK already validated `args` against the same zod schema
        // (registered as inputSchema) before invoking this handler.
        try {
          const result = await tool.handler(client, args);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          };
        }
      },
    );
  }

  void warn; // stderr logger reserved for transport diagnostics
  return server;
}

/**
 * Decide whether a token with the given `scopes` may
 * invoke a tool that declares `required`. Mirrors the
 * server-side `scopeCovers` (plugins/auth.ts):
 *   - null/undefined scopes = interactive JWT or legacy
 *     unrestricted token, every required scope is covered.
 *   - 'operator' covers any required scope.
 *   - Legacy `write` / `read` shorthands cover every
 *     `nd://scope/write/<r>` / `nd://scope/read/<r>`.
 *   - The resource-scoped form does NOT cross resources.
 *   - `admin/<r>` covers `write/<r>` and `read/<r>` for
 *     the same resource.
 */
function toolMeetsScope(required: string[] | undefined, scopes: string[] | null): boolean {
  if (!required || required.length === 0) return true;
  if (scopes === null) return true;
  if (scopes.includes('operator')) return true;
  for (const r of required) {
    if (scopes.includes(r)) continue;
    if (r.startsWith('nd://scope/admin/') || r.startsWith('nd://scope/write/')) {
      if (scopes.includes('write') || scopes.includes('admin')) continue;
    }
    if (r.startsWith('nd://scope/read/')) {
      if (scopes.includes('read')) continue;
    }
    if (r.startsWith('nd://scope/write/')) {
      const res = r.slice('nd://scope/write/'.length);
      if (scopes.includes(`nd://scope/admin/${res}`)) continue;
    }
    if (r.startsWith('nd://scope/read/')) {
      const res = r.slice('nd://scope/read/'.length);
      if (scopes.includes(`nd://scope/write/${res}`) || scopes.includes(`nd://scope/admin/${res}`)) continue;
    }
    return false;
  }
  return true;
}

export async function main(
  env: { NINEDEPLOY_URL?: string; NINEDEPLOY_TOKEN?: string; NINEDEPLOY_MCP_READONLY?: string } = process.env,
  io: {
    error: (msg: string) => void;
    exit: (code: number) => void;
    connect: (server: McpServer) => Promise<void>;
  } = DEFAULT_IO,
): Promise<void> {
  const url = env.NINEDEPLOY_URL ?? 'http://127.0.0.1:3000';
  const token = env.NINEDEPLOY_TOKEN;
  if (!token) {
    io.error('NINEDEPLOY_TOKEN is required (Settings → API tokens in the web UI).');
    io.exit(1);
    return;
  }
  const client = createClient({ baseUrl: url, getToken: staticToken(token) });
  const readOnly = /^(?:1|true|yes)$/i.test(env.NINEDEPLOY_MCP_READONLY ?? '');
  // G-08: introspect the bearer token so the build
  // server can filter tools by the token's fine-grained
  // scopes. A failure here means the token is bad or
  // the server is unreachable — fall back to the
  // existing behaviour (no scope filter) so a network
  // blip during startup doesn't silently drop tools.
  let tokenScopes: string[] | null | undefined;
  try {
    const info = await client.auth.introspectToken();
    tokenScopes = info.scopes;
  } catch (err) {
    io.error(`token introspection failed: ${err instanceof Error ? err.message : String(err)}; continuing without scope filter`);
    tokenScopes = undefined;
  }
  await io.connect(buildServer(client, console.error, { readOnly, tokenScopes }));
}

/** Explicit allowlist: newly added tools default to unavailable in read-only mode. */
export const READ_ONLY_TOOL_NAMES = new Set([
  'list_services', 'get_service', 'service_logs', 'list_deploys',
  'list_domains', 'list_databases', 'list_projects', 'list_alerts',
  'activity_log', 'system_stats', 'topology', 'health',
  'list_plugins', 'marketplace_plugins', 'list_menus',
  'list_workspaces', 'get_workspace', 'list_log_drains',
]);

/** A getToken closure that always returns the configured static token. */
export function staticToken(token: string): () => string {
  return () => token;
}

/** Production wiring: stderr diagnostics, real exit, stdio MCP transport. */
export const DEFAULT_IO = {
  error: (msg: string) => console.error(msg),
  exit: (code: number) => process.exit(code),
  // stdio is the standard MCP transport for local servers.
  connect: async (server: McpServer) => void (await server.connect(new StdioServerTransport())),
};

// Only run when executed directly (not under the test importer). Compares
// argv[1] against this module's own URL — matching by filename suffix alone
// would also fire for any other package's index.js entry.
export function isDirectRun(argv1: string | undefined, selfUrl: string): boolean {
  if (argv1 == null) return false;
  try {
    return pathToFileURL(argv1).href === selfUrl;
  } catch {
    /* v8 ignore next -- node:path accepts every string; defensive for exotic runtimes */
    return false;
  }
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  void main();
}
