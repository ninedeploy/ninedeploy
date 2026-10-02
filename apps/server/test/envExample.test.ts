import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * `.env.example` is the only place an operator can discover how to configure
 * this thing — there is no settings reference elsewhere, and half of these
 * knobs are set on a host the panel never sees (the agent).
 *
 * Nothing checked it against reality, and it had drifted: the SSRF escape hatch
 * `NINEDEPLOY_ALLOW_PRIVATE_EGRESS` was named in the error message an operator
 * hits and nowhere else; the volume-backup retention count, the panel domain
 * fallback, the update-check URL (the panel's only unprompted outbound call,
 * and the only way to switch it off) and the agent's raw-token option were
 * documented in no file at all.
 */
function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectTsFiles(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every `process.env['X']` read, plus every key of the zod env schema. */
function envVarsTheCodeReads(): Set<string> {
  const vars = new Set<string>();
  // Server-side only. `.env.example` configures the SERVER (and the agent,
  // which is the same binary); the CLI's and MCP server's own variables
  // (NINEDEPLOY_URL / NINEDEPLOY_TOKEN / NINEDEPLOY_MCP_READONLY) are the
  // operator's client credentials and are documented in docs/AI_MCP_CLI.md.
  for (const dir of ['apps/server/src']) {
    for (const file of collectTsFiles(join(repoRoot, dir))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/process\.env\[['"]([A-Z0-9_]+)['"]\]/g)) vars.add(m[1]!);
    }
  }
  const envSchema = readFileSync(join(repoRoot, 'apps/server/src/env.ts'), 'utf8');
  for (const m of envSchema.matchAll(/^ {2}([A-Z][A-Z0-9_]+):\s*z\./gm)) vars.add(m[1]!);
  return vars;
}

/** Keys named in `.env.example`, whether active or commented out. */
function envVarsDocumented(): Set<string> {
  const text = readFileSync(join(repoRoot, '.env.example'), 'utf8');
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^#?\s*([A-Z0-9_]+)=/.exec(line.trim());
    if (m) keys.add(m[1]!);
  }
  return keys;
}

describe('.env.example', () => {
  it('documents every environment variable the code reads', () => {
    const read = envVarsTheCodeReads();
    // Supplied by the runtime, not by the operator.
    read.delete('NODE_ENV');
    // Copied into the plugin-sandbox worker's scrubbed env (r414) — runtime
    // values, never operator configuration.
    read.delete('PATH');
    read.delete('LANG');
    read.delete('TZ');
    const documented = envVarsDocumented();
    expect([...read].filter((v) => !documented.has(v)).sort()).toEqual([]);
  });

  it('finds a plausible number of variables (guards the scan itself)', () => {
    // A regex that silently stopped matching would make the check above vacuous.
    expect(envVarsTheCodeReads().size).toBeGreaterThan(25);
    expect(envVarsDocumented().size).toBeGreaterThan(25);
  });
});
