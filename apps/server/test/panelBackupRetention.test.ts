import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DB } from '@ninedeploy/db';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  dataDir: '', settings: new Map<string, unknown>(), bucket: new Map<string, Buffer>(), deleted: [] as string[],
  onPut: null as null | (() => Promise<void>), onDelete: null as null | (() => Promise<void>),
}));
vi.mock('../src/config.js', () => ({ config: { paths: { get dataDir() { return state.dataDir; } } } }));
vi.mock('../src/lib/crypto.js', () => ({ encrypt: (s: string) => s, decrypt: (s: string) => s }));
vi.mock('../src/lib/audit.js', () => ({ audit: async () => undefined }));
vi.mock('../src/lib/settings.js', () => ({
  getSettingJson: async (_db: unknown, key: string, fallback: unknown) => structuredClone(state.settings.get(key) ?? fallback),
  getSettingString: async (_db: unknown, key: string, fallback: unknown) => state.settings.get(key) ?? fallback,
  setSettingJson: async (_db: unknown, key: string, value: unknown) => { state.settings.set(key, structuredClone(value)); },
  setSettingString: async (_db: unknown, key: string, value: unknown) => { state.settings.set(key, value); },
}));
vi.mock('../src/lib/systemArchive.js', () => ({
  systemImportInFlight: () => false,
  importSystemArchive: vi.fn(),
  createSystemArchive: async () => {
    const archive = path.join(state.dataDir, 'plain.tar.gz');
    writeFileSync(archive, 'synthetic archive: retention does not inspect tar members');
    return { archive, cleanup: () => rmSync(archive, { force: true }) };
  },
}));
vi.mock('../src/lib/s3.js', () => ({
  s3PutFile: async (_cfg: unknown, key: string, file: string) => {
    await state.onPut?.();
    state.bucket.set(key, readFileSync(file));
  },
  s3List: async () => [...state.bucket].map(([key, body]) => ({ key, sizeBytes: body.length, lastModified: '' })),
  s3Delete: async (_cfg: unknown, key: string) => {
    state.deleted.push(key);
    await state.onDelete?.();
    state.bucket.delete(key);
  },
  s3GetToFile: vi.fn(),
}));
const lib = await import('../src/lib/panelBackup.js');
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
  state.onPut = null; state.onDelete = null;
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

it('control: unchanged retain=1 deletes only old panel objects', async () => {
  expect(await runAtUpload()).toMatchObject({ pruned: 3 });
  expect([...state.deleted].sort()).toEqual(old);
});

it('honors an increased retention committed while upload is blocked', async () => {
  await runAtUpload(() => lib.setPanelBackupConfig(db, cfg(4)));
  expect(state.deleted).toEqual([]);
});

it('does not prune the previous destination after switching destinations', async () => {
  await runAtUpload(() => lib.setPanelBackupConfig(db, cfg(1, 2)));
  expect(state.deleted).toEqual([]);
});

it('rechecks retention before dispatching each delete', async () => {
  const deletion = gate(); state.onDelete = deletion.wait;
  const running = lib.runPanelBackup(db, { trigger: 'manual', actorUserId: null });
  try {
    await deletion.waiting;
    await lib.setPanelBackupConfig(db, cfg(4));
  } finally { deletion.release(); }
  expect(await running).toMatchObject({ status: 'completed', pruned: 1 });
  expect(state.deleted).toEqual([old[2]]);
  expect(state.bucket.has(old[1]!)).toBe(true);
  expect(state.bucket.has(old[0]!)).toBe(true);
});

it('counts surviving objects when retention increases after one dispatched deletion', async () => {
  const deletion = gate(); state.onDelete = deletion.wait;
  const running = lib.runPanelBackup(db, { trigger: 'manual', actorUserId: null });
  try {
    await deletion.waiting;
    await lib.setPanelBackupConfig(db, cfg(2));
  } finally { deletion.release(); }
  expect(await running).toMatchObject({ status: 'completed', pruned: 2 });
  expect(state.bucket.has(old[1]!)).toBe(true);
  expect(state.bucket.size).toBe(3); // two backups and the foreign object
});
