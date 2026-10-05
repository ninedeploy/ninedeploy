import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ root: '', reads: 0, enabled: false, gate: Promise.resolve(), release: () => {} }));
vi.mock('../../src/config.js', () => ({ config: { paths: { get dataDir() { return state.root; } } } }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => {
    try { return await fs.readFile(...args); }
    catch (error) {
      if (state.enabled && String(args[0]).endsWith(`${path.sep}race.json`) && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (++state.reads === 2) state.release();
        await state.gate;
      }
      throw error;
    }
  } };
});
const { importCommunityTemplate } = await import('../../src/lib/communityTemplates.js');
const template = (id: string, name: string) => JSON.stringify({ id, name, tagline: 'fixture', description: 'fixture description', category: 'Demo', emoji: 'box', image: 'nginx:alpine', port: 8080 });
function cleanup(root: string) {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('nd-community-proof-')) throw new Error('Unowned fixture cleanup refused');
  rmSync(root, { recursive: true, force: true });
}
async function concurrentImportCase() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nd-community-proof-'));
  state.root = root; state.enabled = false; state.reads = 0;
  try {
    await importCommunityTemplate(template('control', 'original'));
    await expect(importCommunityTemplate(template('control', 'replacement'))).rejects.toThrow('already exists');
    expect(JSON.parse(readFileSync(path.join(root, 'community-templates/control.json'), 'utf8')).name).toBe('original');
    const gate = new Promise<void>((resolve) => { state.release = resolve; });
    state.gate = gate; state.enabled = true;
    const results = await Promise.allSettled(['first', 'second'].map((name) => importCommunityTemplate(template('race', name))));
    const accepted = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter((r) => r.status === 'rejected').length;
    const persisted = JSON.parse(readFileSync(path.join(root, 'community-templates/race.json'), 'utf8')).name;
    const winner = results.findIndex((r) => r.status === 'fulfilled');
    return { accepted, refused, persisted, winner: ['first', 'second'][winner], errors: results.filter((r) => r.status === 'rejected').map((r) => String(r.reason.message)) };
  } finally { state.enabled = false; cleanup(root); }
}
async function sequentialImportEdges() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nd-community-proof-'));
  state.root = root; state.enabled = false;
  try {
    await importCommunityTemplate(template('one', 'original'));
    await importCommunityTemplate(template('two', 'independent'));
    await importCommunityTemplate(template('one', 'replacement'), { replace: true });
    expect(JSON.parse(readFileSync(path.join(root, 'community-templates/one.json'), 'utf8')).name).toBe('replacement');
    expect(JSON.parse(readFileSync(path.join(root, 'community-templates/two.json'), 'utf8')).name).toBe('independent');
    await expect(importCommunityTemplate(template('one', 'blocked'))).rejects.toThrow('already exists');
  } finally { cleanup(root); }
}

it('F76: concurrent non-replacing imports preserve the exclusive creator', async () => {
  const result = await concurrentImportCase();
  expect(result.accepted).toBe(1);
  expect(result.refused).toBe(1);
  expect(result.persisted).toBe(result.winner);
  expect(result.errors[0]).toContain('already exists');
});
it('F76: explicit replace and independent IDs remain allowed', async () => {
  await sequentialImportEdges();
});
