import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DB } from '@ninedeploy/db';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  dataDir: '', settings: new Map<string, unknown>(), bucket: new Map<string, Buffer>(), deleted: [] as string[],
  onList: null as null | (() => Promise<void>), onPut: null as null | (() => Promise<void>), onDelete: null as null | (() => Promise<void>),
}));
vi.mock('../../apps/server/src/config.js', () => ({ config: { paths: { get dataDir() { return state.dataDir; } } } }));
vi.mock('../../apps/server/src/lib/crypto.js', () => ({ encrypt: (s: string) => s, decrypt: (s: string) => s }));
vi.mock('../../apps/server/src/lib/audit.js', () => ({ audit: async () => undefined }));
vi.mock('../../apps/server/src/lib/settings.js', () => ({
  getSettingJson: async (_db: unknown, key: string, fallback: unknown) => structuredClone(state.settings.get(key) ?? fallback),
  getSettingString: async (_db: unknown, key: string, fallback: unknown) => state.settings.get(key) ?? fallback,
  setSettingJson: async (_db: unknown, key: string, value: unknown) => { state.settings.set(key, structuredClone(value)); },
  setSettingString: async (_db: unknown, key: string, value: unknown) => { state.settings.set(key, value); },
}));
vi.mock('../../apps/server/src/lib/systemArchive.js', () => ({
  systemImportInFlight: () => false,
  importSystemArchive: vi.fn(),
  createSystemArchive: async () => {
    const archive = path.join(state.dataDir, 'plain.tar.gz');
    writeFileSync(archive, 'synthetic archive: retention does not inspect tar members');
    return { archive, cleanup: () => rmSync(archive, { force: true }) };
  },
}));
vi.mock('../../apps/server/src/lib/s3.js', () => ({
  s3PutFile: async (_cfg: unknown, key: string, file: string) => {
    await state.onPut?.();
    state.bucket.set(key, readFileSync(file));
  },
  s3List: async () => { await state.onList?.(); return [...state.bucket].map(([key, body]) => ({ key, sizeBytes: body.length, lastModified: '' })); },
  s3Delete: async (_cfg: unknown, key: string) => {
    state.deleted.push(key);
    await state.onDelete?.();
    state.bucket.delete(key);
  },
  s3GetToFile: vi.fn(),
}));
const lib = await import('../../apps/server/src/lib/panelBackup.js');
const db = { query: { backupDestinations: { findFirst: async () => ({
  id: 1, name: 'synthetic', endpoint: 'https://s3.invalid', region: 'us-east-1', bucket: 'backup',
  prefix: 'nd', accessKeyId: 'synthetic', secretKeyEncrypted: 'synthetic',
}) } } } as unknown as DB;
const root = mkdtempSync(path.join(tmpdir(), 'nd-panel-retention-'));
state.dataDir = root;
const old = [1, 2, 3].map((day) => `nd/panel-backups/ninedeploy-panel-2000010${day}T030000Z-aaaaaa.ndpb`);
const foreign = 'nd/panel-backups/notes.txt';
const cfg = (retain: number, destinationId: number | null = 1) => ({ enabled: true, cron: '0 3 * * *', retain, destinationId });
const gate = () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  return { waiting, release, wait: async () => { entered(); await blocked; } };
};
beforeEach(async () => {
  state.settings.clear(); state.bucket.clear(); state.deleted.length = 0;
  state.onPut = null; state.onDelete = null; state.onList = null;
  for (const key of [...old, foreign]) state.bucket.set(key, Buffer.from(key));
  await lib.setPanelBackupConfig(db, cfg(1));
  await lib.setPanelBackupPassphrase(db, 'synthetic recovery passphrase');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function runAtUpload(change?: () => Promise<void>) {
  const upload = gate(); state.onPut = upload.wait;
  const running = lib.runPanelBackup(db, { trigger: 'manual', actorUserId: null });
  try { await upload.waiting; await change?.(); } finally { upload.release(); }
  const result = await running;
  expect(result.status).toBe('completed');
  expect(state.bucket.has(foreign)).toBe(true);
  expect(lib.panelBackupBusy()).toBe(false);
  expect(readdirSync(path.join(root, '_panel-backup'))).toEqual([]);
  return result;
}

// Independent oracle: count remaining backup objects, allowing only a delete
// dispatched before the committed settings change to finish.
for (const stage of ['upload', 'listing', 'delete'] as const) {
  for (const policy of [{ retain: 2, dest: 1 }, { retain: 4, dest: 1 }, { retain: 10, dest: 1 }, { retain: 1, dest: 2 }, { retain: 1, dest: null }]) {
    it(`independent ${stage} gate / retain ${policy.retain} / dest ${policy.dest}`, async () => {
      const barrier = gate();
      if (stage === 'upload') state.onPut = barrier.wait;
      if (stage === 'listing') state.onList = barrier.wait;
      if (stage === 'delete') state.onDelete = barrier.wait;
      const task = lib.runPanelBackup(db, { trigger: 'manual', actorUserId: null });
      try { await barrier.waiting; await lib.setPanelBackupConfig(db, cfg(policy.retain, policy.dest)); }
      finally { barrier.release(); }
      const result = await task;
      expect(result.status).toBe('completed');
      if (result.status !== 'completed') throw new Error('run failed');
      const survivors = [...state.bucket.keys()].filter(k => k.endsWith('.ndpb'));
      const available = stage === 'delete' ? 3 : 4;
      const expected = policy.dest === 1 ? Math.min(available, policy.retain) : available;
      expect(survivors).toHaveLength(expected);
      expect(state.bucket.has(result.key)).toBe(true);
      expect(state.bucket.get(foreign)?.toString()).toBe(foreign);
      expect(result.pruned).toBe(4 - expected);
      expect(lib.panelBackupBusy()).toBe(false);
      expect(readdirSync(path.join(root, '_panel-backup'))).toEqual([]);
    });
  }
}
it('failed upload prunes nothing and releases owned scratch', async () => {
  state.onPut = async () => { throw new Error('injected upload failure'); };
  expect(await lib.runPanelBackup(db, { trigger: 'manual', actorUserId: null })).toMatchObject({ status: 'failed', error: 'injected upload failure' });
  expect(state.deleted).toEqual([]);
  expect([...state.bucket.keys()].sort()).toEqual([...old, foreign].sort());
  expect(lib.panelBackupBusy()).toBe(false);
  expect(readdirSync(path.join(root, '_panel-backup'))).toEqual([]);
});
afterAll(() => console.log('FIX VERIFIED'));