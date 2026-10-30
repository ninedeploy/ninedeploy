import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runOp } from '../../src/agent.js';

let work: string, cwd: ReturnType<typeof vi.spyOn>;
const request = (revision: number, content: string) => ({ requestId: revision.toString(16).padStart(32, '0'), revision, timeoutMs: 5_000, content });
const file = () => join(work, '.agent-proxy', 'dynamic', 'ninedeploy.yml');
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'nd-proxy-ordered-op-')); cwd = vi.spyOn(process, 'cwd').mockReturnValue(work); });
afterEach(() => { cwd.mockRestore(); rmSync(work, { recursive: true, force: true }); });

it('keeps legacy dynamic writes working until ordered adoption then rejects late legacy and stale writes', async () => {
  await runOp('proxy.writeConfig', { kind: 'dynamic', content: 'legacy' }, () => {});
  const lines: string[] = [];
  await runOp('proxy.writeOrderedConfig', request(2, 'new'), line => lines.push(line), { sealed: true });
  expect(lines).toHaveLength(1); expect(lines[0]).toMatch(/^ND-PROXY-WRITE /);
  const receipt = JSON.parse(lines[0]!.slice('ND-PROXY-WRITE '.length));
  expect(receipt).toMatchObject({ revision: 2, requestId: request(2, 'new').requestId, complete: true, changed: true });
  await expect(runOp('proxy.writeConfig', { kind: 'dynamic', content: 'late' }, () => {})).rejects.toThrow(/fenced/);
  await expect(runOp('proxy.writeOrderedConfig', request(1, 'old'), () => {}, { sealed: true })).rejects.toThrow(/stale/);
  expect(readFileSync(file(), 'utf8')).toBe('new');
});
it('requires a sealed request before touching the proxy or journal', async () => {
  await expect(runOp('proxy.writeOrderedConfig', request(1, 'new'), () => {})).rejects.toThrow(/sealed|unencrypted/);
  await runOp('proxy.writeConfig', { kind: 'dynamic', content: 'legacy' }, () => {});
  expect(readFileSync(file(), 'utf8')).toBe('legacy');
});
it('keeps the same fence across independent agent processes', () => {
  const require = createRequire(import.meta.url), cli = join(require.resolve('tsx/package.json'), '..', 'dist', 'cli.mjs');
  const worker = fileURLToPath(new URL('../fixtures/nodeProxyOrderedWorker.ts', import.meta.url));
  const call = (op: string, params: object) => execFileSync(process.execPath, [cli, worker, op, JSON.stringify(params)], { cwd: work, encoding: 'utf8', timeout: 15_000 });
  expect(call('proxy.writeOrderedConfig', request(2, 'new'))).toContain('ND-PROXY-WRITE');
  expect(() => call('proxy.writeOrderedConfig', request(1, 'old'))).toThrow(/stale/);
  expect(() => call('proxy.writeConfig', { kind: 'dynamic', content: 'legacy' })).toThrow(/fenced/);
  expect(readFileSync(file(), 'utf8')).toBe('new');
});
it('respects the node owner switch for ordered writes', async () => {
  vi.stubEnv('NINEDEPLOY_AGENT_ORDERED_PROXY', 'off');
  try { await expect(runOp('proxy.writeOrderedConfig', request(1, 'new'), () => {}, { sealed: true })).rejects.toThrow(/ORDERED_PROXY/); }
  finally { vi.unstubAllEnvs(); }
});
