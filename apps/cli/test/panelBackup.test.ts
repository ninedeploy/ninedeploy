import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptPanelBackup, PANEL_BACKUP_DECRYPT_ERROR } from '../src/lib/panelBackupFile.js';

const h = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), header: vi.fn(), kv: vi.fn(), table: vi.fn() }));
vi.mock('../src/lib/format.js', () => ({
  ...h,
  fmtBytes: (b: number) => `${b} B`,
  fmtTime: (t: string | null | undefined) => String(t ?? ''),
}));

const {
  panelBackupDecryptAction,
  panelBackupListAction,
  panelBackupNowAction,
  panelBackupSetBody,
} = await import('../src/commands/panelBackup.js');

const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-cli-panel-backup-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Seal per the documented NDPB1 layout (docs/PANEL_BACKUP.md). */
function seal(plain: Buffer, passphrase: string, N = 1 << 14): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.from(`NDPB1:scrypt:${N}:8:1:${salt.toString('base64')}:${iv.toString('base64')}\n`);
  const key = scryptSync(passphrase, salt, 32, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  return Buffer.concat([header, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
});

describe('offline decrypt (NDPB1)', () => {
  it('opens a sealed backup with the right passphrase', async () => {
    const plain = randomBytes(70_000);
    writeFileSync(path.join(dir, 'a.ndpb'), seal(plain, 'recovery phrase'));
    await decryptPanelBackup(path.join(dir, 'a.ndpb'), path.join(dir, 'a.tar.gz'), 'recovery phrase');
    expect(readFileSync(path.join(dir, 'a.tar.gz')).equals(plain)).toBe(true);
  });

  it('a wrong passphrase leaves no output file', async () => {
    writeFileSync(path.join(dir, 'b.ndpb'), seal(Buffer.from('secret db'), 'recovery phrase'));
    await expect(decryptPanelBackup(path.join(dir, 'b.ndpb'), path.join(dir, 'b.tar.gz'), 'nope')).rejects.toThrow(PANEL_BACKUP_DECRYPT_ERROR);
    expect(existsSync(path.join(dir, 'b.tar.gz'))).toBe(false);
  });

  it('refuses files that are not panel backups', async () => {
    writeFileSync(path.join(dir, 'c.ndpb'), 'NDBK1:v0:aaaa\nxxxxxxxxxxxxxxxxxxxxxx');
    await expect(decryptPanelBackup(path.join(dir, 'c.ndpb'), path.join(dir, 'c.out'), 'x')).rejects.toThrow(/Not a NineDeploy panel backup/);
  });

  it('the decrypt command derives the .tar.gz name and points at `system import`', async () => {
    writeFileSync(path.join(dir, 'd.ndpb'), seal(Buffer.from('archive'), 'recovery phrase'));
    await panelBackupDecryptAction(path.join(dir, 'd.ndpb'), undefined, async () => 'recovery phrase');
    expect(readFileSync(path.join(dir, 'd.tar.gz'), 'utf8')).toBe('archive');
    expect(h.info).toHaveBeenCalledWith(expect.stringContaining('ninedeploy system import'));
    await panelBackupDecryptAction(path.join(dir, 'd.ndpb'), path.join(dir, 'e.tar.gz'), async () => 'wrong');
    expect(h.error).toHaveBeenCalledWith(PANEL_BACKUP_DECRYPT_ERROR);
  });
});

describe('panel-backup set', () => {
  it('maps flags to the PUT body and prompts twice for the passphrase', async () => {
    const answers = ['a long recovery phrase', 'a long recovery phrase'];
    const body = await panelBackupSetBody(
      { enable: true, cron: '0 4 * * *', destination: '2', retain: '5', passphrase: true },
      async () => answers.shift()!,
    );
    expect(body).toEqual({ enabled: true, cron: '0 4 * * *', destinationId: 2, retain: 5, passphrase: 'a long recovery phrase' });
  });

  it('rejects contradictory or malformed flags and mismatched passphrases', async () => {
    expect(await panelBackupSetBody({ enable: true, disable: true })).toMatch(/not both/);
    expect(await panelBackupSetBody({ destination: 'abc' })).toMatch(/destination/);
    expect(await panelBackupSetBody({ retain: '0' })).toMatch(/retain/);
    expect(await panelBackupSetBody({})).toMatch(/Nothing to change/);
    const answers = ['one phrase here', 'another one'];
    expect(await panelBackupSetBody({ passphrase: true }, async () => answers.shift()!)).toMatch(/do not match/);
  });
});

describe('panel-backup now / list', () => {
  it('--wait polls until the run completes', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ running: true, lastRun: null })
      .mockResolvedValueOnce({ running: false, lastRun: { status: 'completed', key: 'nd/panel-backups/x.ndpb', sizeBytes: 42, warning: null } });
    const client = { system: { panelBackup: { run: vi.fn(async () => ({ ok: true, started: true })), get } } };
    await panelBackupNowAction(client as never, { wait: true }, async () => undefined);
    expect(get).toHaveBeenCalledTimes(2);
    expect(h.success).toHaveBeenCalledWith(expect.stringContaining('nd/panel-backups/x.ndpb'));
  });

  it('--wait reports a failed run as an error', async () => {
    const get = vi.fn().mockResolvedValue({ running: false, lastRun: { status: 'failed', error: 'AccessDenied' } });
    const client = { system: { panelBackup: { run: vi.fn(async () => ({ ok: true, started: true })), get } } };
    await panelBackupNowAction(client as never, { wait: true }, async () => undefined);
    expect(h.error).toHaveBeenCalledWith(expect.stringContaining('AccessDenied'));
  });

  it('list forwards --destination and prints a table', async () => {
    const list = vi.fn(async () => ({ destinationId: 3, items: [{ key: 'nd/panel-backups/x.ndpb', name: 'x.ndpb', sizeBytes: 9, lastModified: 't' }] }));
    await panelBackupListAction({ system: { panelBackup: { list } } } as never, { destination: '3' });
    expect(list).toHaveBeenCalledWith(3);
    expect(h.table).toHaveBeenCalledWith([{ name: 'x.ndpb', size: '9 B', date: 't', key: 'nd/panel-backups/x.ndpb' }], ['name', 'size', 'date', 'key']);
  });
});
