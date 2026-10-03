/**
 * r333 wiring guard: every MCP tool's declared scopes must agree with the
 * route map this server actually enforces (`requiredFineGrainedScope`).
 *
 * The MCP filters its tool list by the token's scopes. Tools declared scopes
 * for resources the server never consults on their route (`read/audit` for
 * /v1/activity, `read/projects` for /v1/workspaces, `read/deploys` for
 * /v1/services/queue …), so a fine-grained token was shown tools that always
 * answered 403. This drives each tool through the REAL SDK, captures the HTTP
 * calls it makes, and classifies them with the server's own function.
 */
import { createClient } from '@ninedeploy/sdk';
import { describe, expect, it, vi } from 'vitest';
import { TOOLS } from '../../../packages/mcp/src/tools.js';
import { requiredFineGrainedScope } from '../src/plugins/auth.js';

/** One argument bag every tool's schema can be satisfied from (unknown keys are stripped). */
const SAMPLE = { serviceId: 1, deploymentId: 2, container: 'c1', key: 'k1', target: 't1', value: 'v' };

async function callsOf(tool: (typeof TOOLS)[number]): Promise<Array<{ url: string; method: string }>> {
  const calls: Array<{ url: string; method: string }> = [];
  const fetch = vi.fn(async (url: string, init: { method?: string }) => {
    calls.push({ url: url.replace(/^https?:\/\/[^/]+/, ''), method: init.method ?? 'GET' });
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) } as unknown as Response;
  });
  const client = createClient({ baseUrl: 'http://api.test', fetch, getToken: () => 't' });
  // `id` is a number for workspaces and a string for plugins.
  let parsed = tool.input.safeParse({ ...SAMPLE, id: 1 });
  if (!parsed.success) parsed = tool.input.safeParse({ ...SAMPLE, id: 'p1' });
  if (!parsed.success) throw new Error(`no sample input satisfies ${tool.name}`);
  await tool.handler(client, parsed.data);
  return calls;
}

describe('r333: MCP tool scopes match the server route map', () => {
  it.each(TOOLS.map((tool) => [tool.name, tool] as const))('%s', async (_name, tool) => {
    const calls = await callsOf(tool);
    expect(calls.length).toBeGreaterThan(0);
    const declaredFine = (tool.requiredScopes ?? []).filter((s) => s.startsWith('nd://scope/'));
    for (const call of calls) {
      if (!call.url.startsWith('/v1/')) {
        // Outside the API root (GET /health) the route is unauthenticated:
        // every token reaches it, so the tool must not demand anything.
        expect(tool.requiredScopes ?? []).toEqual([]);
        expect(tool.coarseTokenOnly).toBeUndefined();
        continue;
      }
      const required = requiredFineGrainedScope(call.url, call.method);
      if (required === null) {
        // Unclassified route: a fine-grained token is always refused.
        expect(tool.coarseTokenOnly, `${call.method} ${call.url} is unmapped`).toBe(true);
        expect(declaredFine).toEqual([]);
      } else {
        expect(tool.coarseTokenOnly).toBeUndefined();
        expect(declaredFine).toEqual([required]);
      }
    }
  });
});
