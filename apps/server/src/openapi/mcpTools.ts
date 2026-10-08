import { requiredFineGrainedScope } from '../plugins/auth.js';
import { inlineSchema, paramSchema, pathParams } from './build.js';
import type { RouteSpecMap } from './types.js';

/**
 * Read-only MCP tools generated from `ROUTE_SPECS` (0.15, DESIGN §3.4).
 * Owner: task T4.
 *
 * Every spec entry carrying `mcp` becomes one tool whose input is the route's
 * path parameters plus its query schema, and whose handler is
 * `client.api.get(path, query)`. The generator refuses anything but a plain
 * GET: a non-GET method, a `sensitive` entry (it returns secrets, and MCP
 * results persist in agent transcripts) and a WebSocket. Writes stay
 * hand-written in `packages/mcp/src/tools.ts`; there is no generic "call any
 * endpoint" tool.
 *
 * `scripts/generateMcpSpecTools.ts` writes `renderSpecTools()` to
 * `packages/mcp/src/generated/specTools.ts`; `test/mcpSpecToolsDrift.test.ts`
 * fails when the committed file differs.
 */

export const SPEC_TOOLS_FILE = 'packages/mcp/src/generated/specTools.ts';

export interface SpecToolInput {
  /** The tool's input field. */
  name: string;
  /** zod source for the field. */
  zod: string;
  /** The path parameter it fills, or null for a query parameter. */
  param: string | null;
}

export interface SpecToolPlan {
  name: string;
  description: string;
  key: string;
  url: string;
  inputs: SpecToolInput[];
  requiredScopes?: string[];
  coarseTokenOnly?: true;
}

/** Tool names follow the hand-written ones: snake_case. */
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * The input field for a path parameter. `:id` is named after its resource
 * where the hand-written tools already use that name (`serviceId`,
 * `databaseId`); `:depId` is `deploymentId`; every other parameter keeps its
 * route name.
 */
export function inputNameFor(url: string, param: string): string {
  if (param === 'id' && url.startsWith('/v1/services/')) return 'serviceId';
  if (param === 'id' && url.startsWith('/v1/databases/')) return 'databaseId';
  if (param === 'depId') return 'deploymentId';
  return param;
}

/** A TS string literal: single-quoted, or double-quoted when that avoids an escape. */
const quote = (s: string) => {
  const escaped = s.replace(/\\/g, '\\\\');
  if (s.includes("'") && !s.includes('"')) return `"${escaped}"`;
  return `'${escaped.replace(/'/g, "\\'")}'`;
};

/** zod source for one query property's JSON Schema (flat queries only; anything else is a string). Always optional. */
export function zodSourceFor(schema: Record<string, unknown>): string {
  const base = (() => {
    const values = schema['enum'];
    if (Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === 'string')) {
      return `z.enum([${values.map((v) => quote(v as string)).join(', ')}])`;
    }
    switch (schema['type']) {
      case 'integer':
        return 'z.number().int()';
      case 'number':
        return 'z.number()';
      case 'boolean':
        return 'z.boolean()';
      default:
        return 'z.string()';
    }
  })();
  const description = typeof schema['description'] === 'string' ? `.describe(${quote(schema['description'])})` : '';
  return `${base}${description}.optional()`;
}

/** Plan every generated tool, refusing what must never become one. */
export function planSpecTools(
  specs: RouteSpecMap,
  scopeFor: (url: string, method: string) => string | null = requiredFineGrainedScope,
): SpecToolPlan[] {
  const plans: SpecToolPlan[] = [];
  const names = new Set<string>();
  for (const [key, spec] of Object.entries(specs)) {
    if (!spec.mcp) continue;
    const [method, url] = key.split(' ') as [string, string];
    if (method !== 'GET') throw new Error(`MCP spec tool ${spec.mcp.name}: ${key} is not a GET`);
    if (spec.sensitive) throw new Error(`MCP spec tool ${spec.mcp.name}: ${key} is sensitive`);
    if (spec.websocket) throw new Error(`MCP spec tool ${spec.mcp.name}: ${key} is a WebSocket`);
    if (spec.mcp.readOnly !== true) throw new Error(`MCP spec tool ${spec.mcp.name}: only read-only tools are generated`);
    if (!url.startsWith('/v1/') || url.includes('*')) throw new Error(`MCP spec tool ${spec.mcp.name}: ${key} is outside /v1`);
    if (!TOOL_NAME.test(spec.mcp.name)) throw new Error(`MCP spec tool name "${spec.mcp.name}" is not snake_case`);
    if (names.has(spec.mcp.name)) throw new Error(`MCP spec tool name "${spec.mcp.name}" is used twice`);
    names.add(spec.mcp.name);

    const inputs: SpecToolInput[] = pathParams(url).map((param) => ({
      name: inputNameFor(url, param),
      zod: paramSchema(param)['type'] === 'integer' ? 'z.number().int().positive()' : 'z.string().min(1)',
      param,
    }));
    if (spec.query) {
      const props = (inlineSchema(spec.query, 'input')['properties'] ?? {}) as Record<string, Record<string, unknown>>;
      for (const [name, schema] of Object.entries(props)) {
        if (inputs.some((i) => i.name === name)) throw new Error(`MCP spec tool ${spec.mcp.name}: query "${name}" shadows a path parameter`);
        inputs.push({ name, zod: zodSourceFor(schema), param: null });
      }
    }
    const scope = scopeFor(url, 'GET');
    const plan: SpecToolPlan = { name: spec.mcp.name, description: spec.mcp.description, key, url, inputs };
    if (scope === null) {
      plan.coarseTokenOnly = true;
      if (spec.floor === 'operator') plan.requiredScopes = ['operator'];
    } else {
      plan.requiredScopes = spec.floor === 'operator' ? ['operator', scope] : [scope];
    }
    plans.push(plan);
  }
  return plans.sort((a, b) => a.name.localeCompare(b.name));
}

function renderTool(plan: SpecToolPlan): string {
  const lines = [`  {`, `    name: ${quote(plan.name)},`, `    description: ${quote(plan.description)},`];
  const shape = plan.inputs.map((i) => `${i.name}: ${i.zod}`).join(', ');
  lines.push(`    input: z.object({${shape ? ` ${shape} ` : ''}}),`);
  lines.push(`    // ${plan.key}`);
  if (plan.coarseTokenOnly) lines.push('    coarseTokenOnly: true,');
  if (plan.requiredScopes) lines.push(`    requiredScopes: [${plan.requiredScopes.map(quote).join(', ')}],`);
  const path = plan.url.replace(/:([A-Za-z0-9_]+)/g, (_m, p: string) => {
    const input = plan.inputs.find((i) => i.param === p)!;
    return input.zod.startsWith('z.number') ? `\${i.${input.name}}` : `\${encodeURIComponent(i.${input.name})}`;
  });
  const query = plan.inputs.filter((i) => i.param === null);
  if (plan.inputs.length === 0) {
    lines.push(`    handler: (c) => c.api.get(${quote(plan.url)}),`);
  } else {
    const type = plan.inputs
      .map((i) => `${i.name}${i.param === null ? '?' : ''}: ${i.zod.startsWith('z.number') ? 'number' : i.zod.startsWith('z.boolean') ? 'boolean' : 'string'}`)
      .join('; ');
    const target = path.includes('${') ? `\`${path}\`` : quote(path);
    const args = query.length ? `${target}, { ${query.map((q) => `${q.name}: i.${q.name}`).join(', ')} }` : target;
    lines.push('    handler: (c, input) => {');
    lines.push(`      const i = input as { ${type} };`);
    lines.push(`      return c.api.get(${args});`);
    lines.push('    },');
  }
  lines.push('  },');
  return lines.join('\n');
}

/** The generated module's full source. */
export function renderSpecTools(plans: SpecToolPlan[]): string {
  const readOnly = plans.map((p) => `  ${quote(p.name)},`).join('\n');
  return [
    '// Generated by apps/server/scripts/generateMcpSpecTools.ts from the server\'s ROUTE_SPECS',
    '// (apps/server/src/openapi/specs). Do not edit by hand: change the spec entry\'s `mcp`',
    '// field and regenerate. apps/server/test/mcpSpecToolsDrift.test.ts fails on drift.',
    "import { z } from 'zod';",
    "import type { ToolDef } from '../tools.js';",
    '',
    '/** Read-only GET tools generated from the OpenAPI route specs (0.15). */',
    'export const SPEC_TOOLS: ToolDef[] = [',
    ...plans.map(renderTool),
    '];',
    '',
    '/** Every generated tool is a non-sensitive GET: all of them join the read-only allowlist. */',
    'export const SPEC_READ_ONLY_TOOL_NAMES: readonly string[] = [',
    ...(readOnly ? [readOnly] : []),
    '];',
    '',
  ].join('\n');
}
