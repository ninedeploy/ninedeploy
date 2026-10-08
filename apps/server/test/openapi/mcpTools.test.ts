/**
 * The MCP tool generator (0.15, DESIGN §3.4): read-only GETs only. It refuses
 * non-GET, sensitive and WebSocket entries, derives scopes from the auth
 * plugin's route map the way the hand-written tools declare them, and names
 * path inputs the way the hand-written tools do.
 */
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { inputNameFor, planSpecTools, renderSpecTools, zodSourceFor } from '../../src/openapi/mcpTools.js';
import type { RouteSpec, RouteSpecMap } from '../../src/openapi/types.js';

/** Generated source contains template placeholders: written as #{…} here to keep them out of string literals. */
const tpl = (s: string) => s.replaceAll('#{', `${'$'}{`);
const mcp = (name: string) => ({ name, description: `${name} tool`, readOnly: true as const });
const spec = (extra: Partial<RouteSpec>): RouteSpec => ({ summary: 's', tag: 't', floor: 'viewer', ...extra });

describe('planSpecTools', () => {
  it('refuses anything but a non-sensitive, plain GET under /v1', () => {
    const refuse = (key: string, extra: Partial<RouteSpec>, why: RegExp) =>
      expect(() => planSpecTools({ [key]: spec({ mcp: mcp('x_tool'), ...extra }) })).toThrow(why);
    refuse('POST /v1/services', {}, /not a GET/);
    refuse('GET /v1/databases/:id/credentials', { sensitive: true }, /sensitive/);
    refuse('GET /v1/events', { websocket: true }, /WebSocket/);
    refuse('GET /health', {}, /outside \/v1/);
    refuse('GET /v1/x/*', {}, /outside \/v1/);
    expect(() => planSpecTools({ 'GET /v1/a': spec({ mcp: { ...mcp('x'), readOnly: false as never } }) })).toThrow(/read-only/);
    expect(() => planSpecTools({ 'GET /v1/a': spec({ mcp: mcp('BadName') }) })).toThrow(/snake_case/);
    expect(() => planSpecTools({ 'GET /v1/a': spec({ mcp: mcp('dup') }), 'GET /v1/b': spec({ mcp: mcp('dup') }) })).toThrow(/used twice/);
    expect(() =>
      planSpecTools({ 'GET /v1/services/:id/x': spec({ mcp: mcp('shadow'), query: z.object({ serviceId: z.string() }) }) }),
    ).toThrow(/shadows/);
  });

  it('derives scopes like the hand-written tools: fine-grained, operator, or coarse-only', () => {
    const specs: RouteSpecMap = {
      'GET /v1/services/:id/jobs': spec({ mcp: mcp('a_jobs') }),
      'GET /v1/volumes': spec({ floor: 'operator', mcp: mcp('b_volumes') }),
      'GET /v1/doctor': spec({ floor: 'operator', mcp: mcp('c_doctor') }),
      'GET /v1/labels': spec({ floor: 'authed', mcp: mcp('d_labels') }),
      'GET /v1/plain': spec({ summary: 'no mcp' }),
    };
    const plans = planSpecTools(specs);
    expect(plans.map((p) => [p.name, p.requiredScopes, p.coarseTokenOnly])).toEqual([
      ['a_jobs', ['nd://scope/read/services'], undefined],
      ['b_volumes', ['operator', 'nd://scope/read/volumes'], undefined],
      ['c_doctor', ['operator'], true],
      ['d_labels', undefined, true],
    ]);
  });

  it('names inputs after the hand-written tools and renders query filters as optional', () => {
    expect(inputNameFor('/v1/services/:id', 'id')).toBe('serviceId');
    expect(inputNameFor('/v1/databases/:id', 'id')).toBe('databaseId');
    expect(inputNameFor('/v1/services/:id/deploys/:depId', 'depId')).toBe('deploymentId');
    expect(inputNameFor('/v1/workspaces/:id', 'id')).toBe('id');
    expect(inputNameFor('/v1/volumes/:name', 'name')).toBe('name');
    expect(zodSourceFor({ type: 'integer' })).toBe('z.number().int().optional()');
    expect(zodSourceFor({ type: 'number' })).toBe('z.number().optional()');
    expect(zodSourceFor({ type: 'boolean', description: "it's" })).toBe(`z.boolean().describe("it's").optional()`);
    expect(zodSourceFor({ type: 'string', enum: ['1h', '24h'] })).toBe("z.enum(['1h', '24h']).optional()");
    expect(zodSourceFor({ anyOf: [] })).toBe('z.string().optional()');
  });

  it('renders a module whose handlers call client.api.get only', () => {
    const source = renderSpecTools(
      planSpecTools({
        'GET /v1/volumes/:name/backups': spec({ floor: 'operator', mcp: mcp('volume_backups') }),
        'GET /v1/services/:id/metrics': spec({ mcp: mcp('metrics'), query: z.object({ minutes: z.number().int().optional() }) }),
        'GET /v1/servers': spec({ floor: 'operator', mcp: mcp('servers') }),
      }),
    );
    expect(source).toContain(tpl('return c.api.get(`/v1/volumes/#{encodeURIComponent(i.name)}/backups`);'));
    expect(source).toContain(tpl('return c.api.get(`/v1/services/#{i.serviceId}/metrics`, { minutes: i.minutes });'));
    expect(source).toContain("handler: (c) => c.api.get('/v1/servers'),");
    expect(source).toContain("export const SPEC_READ_ONLY_TOOL_NAMES: readonly string[] = [\n  'metrics',\n  'servers',\n  'volume_backups',\n];");
    expect(source).not.toMatch(/\bc\.(?!api\.get)\w+\./);
    expect(renderSpecTools([])).toContain('export const SPEC_TOOLS: ToolDef[] = [\n];');
  });
});
