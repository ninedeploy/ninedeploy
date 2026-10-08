/**
 * 0.15 (DESIGN §3.4): `packages/mcp/src/generated/specTools.ts` is generated
 * from ROUTE_SPECS by `scripts/generateMcpSpecTools.ts` and checked in.
 * Regenerating must reproduce the committed file exactly, so a spec entry's
 * `mcp` field and the tools the MCP server offers can never drift apart.
 * Fix a failure by running the script, then review the diff.
 *
 * Also pins the generated tools onto the MCP surface (mount point M17): they
 * are merged into `TOOLS` and the read-only allowlist.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { READ_ONLY_TOOL_NAMES } from '../../../packages/mcp/src/index.js';
import { SPEC_TOOLS } from '../../../packages/mcp/src/generated/specTools.js';
import { TOOLS } from '../../../packages/mcp/src/tools.js';
import { planSpecTools, renderSpecTools, SPEC_TOOLS_FILE } from '../src/openapi/mcpTools.js';
import { ROUTE_SPECS } from '../src/openapi/specs/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('generated MCP spec tools', () => {
  it('the committed file equals a fresh generation (run scripts/generateMcpSpecTools.ts)', () => {
    const committed = readFileSync(path.join(repoRoot, SPEC_TOOLS_FILE), 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(renderSpecTools(planSpecTools(ROUTE_SPECS)));
  });

  it('one tool per spec entry with mcp, merged into TOOLS and the read-only allowlist', () => {
    const fromSpecs = Object.values(ROUTE_SPECS)
      .filter((s) => s.mcp)
      .map((s) => s.mcp!.name)
      .sort();
    expect(SPEC_TOOLS.map((t) => t.name).sort()).toEqual(fromSpecs);
    for (const tool of SPEC_TOOLS) {
      expect(TOOLS).toContain(tool);
      expect(READ_ONLY_TOOL_NAMES.has(tool.name)).toBe(true);
    }
  });
});
