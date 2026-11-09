import { expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.hoisted(() => { process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32); });
const observed = vi.hoisted(() => ({ streams: [] as import('node:fs').WriteStream[] }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, createWriteStream: (...args: Parameters<typeof fs.createWriteStream>) => {
    const stream = fs.createWriteStream(...args); observed.streams.push(stream); return stream;
  } };
});
import { decryptBackupFile, encryptBackupFile } from '../../apps/server/src/lib/backupCrypto.js';
async function settled() {
  for (const stream of observed.streams) {
    if (stream.pending && !stream.destroyed) await new Promise<void>(resolve => { stream.once('open', () => resolve()); stream.once('error', () => resolve()); });
  }
  expect(observed.streams.every(stream => stream.closed && stream.destroyed)).toBe(true);
}
it('keeps every incomplete-tag boundary resource-free and preserves authenticated empty/nonempty files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nd-verify-backup-crypto-'));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-09T00:00:00Z'));
  try {
    for (const size of [0, 1, 65537]) {
      const input = join(dir, `valid-${size}.dump`), output = join(dir, `valid-${size}.plain`), plain = Buffer.alloc(size, 97);
      writeFileSync(input, plain); await encryptBackupFile(input); await settled(); observed.streams.length = 0;
      await decryptBackupFile(input, output); await settled();
      expect(readFileSync(output)).toEqual(plain); observed.streams.length = 0;
    }
    const input = join(dir, 'bad.dump'), output = join(dir, 'bad.plain');
    writeFileSync(input, 'private fixture body'); await encryptBackupFile(input); await settled(); observed.streams.length = 0;
    const sealed = readFileSync(input), end = sealed.indexOf(10) + 1;
    for (let bytes = 0; bytes < 16; bytes++) {
      const truncated = sealed.subarray(0, end + bytes); writeFileSync(input, truncated);
      for (let retry = 0; retry < 2; retry++) {
        await expect(decryptBackupFile(input, output)).rejects.toThrow(); await settled();
        expect(existsSync(output)).toBe(false); expect(readFileSync(input)).toEqual(truncated);
      }
    }
    const corrupt = Buffer.from(sealed); corrupt[corrupt.length - 1]! ^= 1; writeFileSync(input, corrupt);
    await expect(decryptBackupFile(input, output)).rejects.toThrow(); await settled();
    expect(existsSync(output)).toBe(false); observed.streams.length = 0;
    writeFileSync(input, 'plain backup'); await expect(decryptBackupFile(input, output)).rejects.toThrow(/not encrypted/);
    expect(observed.streams).toHaveLength(0); expect(existsSync(output)).toBe(false);
    console.log('FIX VERIFIED');
  } finally {
    await Promise.all(observed.streams.filter(stream => !stream.closed).map(stream => new Promise<void>(resolve => { stream.once('close', resolve); stream.destroy(); })));
    observed.streams.length = 0; vi.useRealTimers(); rmSync(dir, { recursive: true, force: true });
  }
});
