/**
 * Regenerate `packages/mcp/src/generated/specTools.ts`: the read-only MCP
 * tools derived from the `mcp` field of the server's ROUTE_SPECS (0.15,
 * DESIGN §3.4). Refuses non-GET, sensitive and WebSocket entries.
 *
 * Run with: pnpm --filter @ninedeploy/server exec tsx scripts/generateMcpSpecTools.ts [--check]
 * `--check` writes nothing and exits 1 when the committed file is stale
 * (test/mcpSpecToolsDrift.test.ts makes the same comparison in CI).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSpecTools, renderSpecTools, SPEC_TOOLS_FILE } from '../src/openapi/mcpTools.js';
import { ROUTE_SPECS } from '../src/openapi/specs/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const target = path.join(repoRoot, SPEC_TOOLS_FILE);
const plans = planSpecTools(ROUTE_SPECS);
const source = renderSpecTools(plans);

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    /* missing counts as stale */
  }
  if (current !== source) {
    console.error(`${SPEC_TOOLS_FILE} is stale: run scripts/generateMcpSpecTools.ts`);
    process.exit(1);
  }
  console.log(`${SPEC_TOOLS_FILE} is up to date (${plans.length} tools)`);
} else {
  writeFileSync(target, source);
  console.log(`wrote ${SPEC_TOOLS_FILE}: ${plans.map((p) => p.name).join(', ')}`);
}
