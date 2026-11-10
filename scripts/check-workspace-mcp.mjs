#!/usr/bin/env node
// Read-only workspace launcher smoke. A missing-token refusal proves startup without API access.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'NINEDEPLOY_TOKEN')),
  NINEDEPLOY_URL: 'http://127.0.0.1:9',
};
const options = { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 15_000 };
const direct = spawnSync(process.execPath, [join(root, 'packages/mcp/dist/index.js')], options);
const launcher = process.platform === 'win32'
  ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd --dir apps/server exec ninedeploy-mcp'], options)
  : spawnSync('pnpm', ['--dir', 'apps/server', 'exec', 'ninedeploy-mcp'], options);
const refused = result => result.status === 1 && /NINEDEPLOY_TOKEN is required/.test(result.stderr ?? '');
const report = {
  platform: process.platform,
  architecture: process.arch,
  builtEntryExists: existsSync(join(root, 'packages/mcp/dist/index.js')),
  workspaceBinExists: existsSync(join(root, 'apps/server/node_modules/.bin', process.platform === 'win32' ? 'ninedeploy-mcp.cmd' : 'ninedeploy-mcp')),
  directEntryMissingTokenRefusal: refused(direct),
  workspaceMissingTokenRefusal: refused(launcher),
  directExit: direct.status,
  workspaceExit: launcher.status,
};
console.log(JSON.stringify(report, null, 2));
if (!report.builtEntryExists || !report.workspaceBinExists || !report.directEntryMissingTokenRefusal || !report.workspaceMissingTokenRefusal) {
  console.error('Workspace MCP launcher is unavailable after build. See docs/MACOS_DEVELOPMENT.md.');
  process.exitCode = 1;
}
