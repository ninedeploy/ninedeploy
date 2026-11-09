import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({ streams: [] as import('node:fs').WriteStream[] }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, createWriteStream: (...args: Parameters<typeof fs.createWriteStream>) => {
    const stream = fs.createWriteStream(...args); observed.streams.push(stream); return stream;
  } };
});
import { decryptBackupFile, encryptBackupFile } from '../../src/lib/backupCrypto.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nd-backup-truncation-')); });
afterEach(async () => {
  await Promise.all(observed.streams.filter(stream => !stream.closed).map(stream => new Promise<void>(resolve => {
    stream.once('close', resolve); stream.destroy();
  })));
  observed.streams.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

describe('truncated encrypted backups', () => {
  it.each([0, 1, 8, 15])('does not open a late output or leak a descriptor with only %i tag bytes', async bytes => {
    const input = join(dir, 'backup.dump'), output = join(dir, 'plain.dump');
    writeFileSync(input, 'original backup'); await encryptBackupFile(input);
    observed.streams.length = 0; // Encryption finished and closed its own stream.
    const sealed = readFileSync(input);
    const truncated = sealed.subarray(0, sealed.indexOf(10) + 1 + bytes);
    writeFileSync(input, truncated);
    await expect(decryptBackupFile(input, output)).rejects.toThrow();
    // If an output was opened asynchronously after rejection, wait for that
    // event before checking: an immediate existsSync would miss the orphan.
    for (const stream of observed.streams) {
      if (stream.pending && !stream.destroyed) await new Promise<void>(resolve => {
        stream.once('open', () => resolve()); stream.once('error', () => resolve());
      });
    }
    expect(observed.streams.every(stream => stream.closed && stream.destroyed)).toBe(true);
    expect(existsSync(output)).toBe(false);
    expect(readFileSync(input)).toEqual(truncated);
  });

  it('control: an empty authenticated backup still creates and closes a valid empty output', async () => {
    const input = join(dir, 'empty.dump'), output = join(dir, 'plain.dump');
    writeFileSync(input, ''); await encryptBackupFile(input);
    observed.streams.length = 0;
    await decryptBackupFile(input, output);
    expect(readFileSync(output)).toEqual(Buffer.alloc(0));
    expect(observed.streams).toHaveLength(1);
    expect(observed.streams[0]!.closed && observed.streams[0]!.destroyed).toBe(true);
  });
});
