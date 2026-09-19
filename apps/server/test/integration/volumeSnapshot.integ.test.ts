/**
 * Integration test: managed-volume snapshot/restore round-trip against real
 * Docker, through the real engine code path — the staging extraction and the
 * rename swap of restoreVolume, not a mock. Like the database suite it is
 * excluded from the default run and gated on RUN_INTEGRATION=1 + Docker.
 */
import os from 'node:os';
import path from 'node:path';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capture } from '../../src/lib/exec.js';
import { backupVolume, restoreVolume } from '../../src/engine/database.js';

const ENABLED = process.env.RUN_INTEGRATION === '1';
const VOLUME = `nd-integ-vol-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const log = () => undefined;

/** Run a shell command inside the volume via a throwaway alpine container. */
const inVolume = (script: string) =>
  capture('docker', ['run', '--rm', '-v', `${VOLUME}:/v`, 'alpine:3.21', 'sh', '-c', script]);

describe.skipIf(!ENABLED)('managed volume snapshot/restore (real Docker)', () => {
  let backupFile: string;

  beforeAll(async () => {
    // Warm the Docker engine + helper image so a cold daemon (CI runner
    // start, Docker Desktop wake) does not eat the per-test timeout.
    await capture('docker', ['run', '--rm', 'alpine:3.21', 'true']);
    await capture('docker', ['volume', 'create', VOLUME]);
    backupFile = path.join(os.tmpdir(), `nd-integ-volume-${process.pid}-${Date.now()}.tar.gz`);
  }, 180_000);

  afterAll(async () => {
    if (backupFile && existsSync(backupFile)) rmSync(backupFile, { force: true });
    await capture('docker', ['volume', 'rm', '-f', VOLUME]).catch(() => undefined);
  }, 60_000);

  it('restores the snapshot exactly and loses the post-snapshot state', async () => {
    await inVolume("echo -n OLD > /v/old.txt; echo -n HIDDEN > /v/.hidden; mkdir -p /v/dir; echo -n DEEP > /v/dir/deep.txt");
    await backupVolume(VOLUME, backupFile, log);
    expect(existsSync(backupFile)).toBe(true);

    // Post-snapshot mutation: the restore must remove `stray.txt` and bring
    // `old.txt` back — extracting over the contents would keep the stray.
    await inVolume('rm /v/old.txt; echo -n STRAY > /v/stray.txt');

    await restoreVolume(VOLUME, backupFile, log);

    const listing = await inVolume('ls -A /v');
    expect(listing.split(/\s+/)).toEqual(expect.arrayContaining(['.hidden', 'dir', 'old.txt']));
    expect(listing).not.toContain('stray.txt');
    expect(await inVolume('cat /v/old.txt /v/.hidden /v/dir/deep.txt')).toBe('OLDHIDDENDEEP');
    // No staging residue from the swap.
    expect(listing).not.toContain('.nd-restore');
  }, 180_000);

  it('refuses a corrupt archive with the volume untouched', async () => {
    const badFile = `${backupFile}.bad`;
    writeFileSync(badFile, 'this is not a gzip stream');
    try {
      await expect(restoreVolume(VOLUME, badFile, log)).rejects.toThrow();
      // The pre-snapshot contents from the previous test survive verbatim.
      expect(await inVolume('cat /v/old.txt /v/.hidden')).toBe('OLDHIDDEN');
    } finally {
      rmSync(badFile, { force: true });
    }
  }, 180_000);
});
