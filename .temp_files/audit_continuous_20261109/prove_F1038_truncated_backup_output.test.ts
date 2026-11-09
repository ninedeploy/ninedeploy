import { expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.hoisted(() => { process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32); });
const state = vi.hoisted(() => ({ streams: [] as import('node:fs').WriteStream[] }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, createWriteStream: (...args: Parameters<typeof fs.createWriteStream>) => {
    const stream = fs.createWriteStream(...args); state.streams.push(stream); return stream;
  } };
});
import { encryptBackupFile, decryptBackupFile } from '../../apps/server/src/lib/backupCrypto.js';
async function closeStreams() {
  await Promise.all(state.streams.filter(stream => !stream.closed).map(stream => new Promise<void>(resolve => { stream.once('close', resolve); stream.destroy(); })));
  state.streams.length = 0;
}
it('does not open an orphan plaintext stream after rejecting a truncated encrypted envelope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nd-audit-crypto-'));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-09T00:00:00Z'));
  try {
    const input = join(dir, 'backup.dump'), output = join(dir, 'output.dump');
    writeFileSync(input, 'known backup body'); await encryptBackupFile(input); await closeStreams();
    await decryptBackupFile(input, output);
    expect(readFileSync(output, 'utf8')).toBe('known backup body');
    expect(state.streams.every(stream => stream.closed && stream.destroyed)).toBe(true);
    console.log('CONTROL EXPECTED: valid envelope finishes and closes output | ACTUAL: plaintext correct, stream closed');
    await closeStreams();
    const encrypted = readFileSync(input), headerEnd = encrypted.indexOf(10) + 1;
    writeFileSync(input, encrypted.subarray(0, headerEnd + 8));
    const brokenOutput = join(dir, 'truncated.dump');
    await expect(decryptBackupFile(input, brokenOutput)).rejects.toThrow();
    for (const stream of state.streams) {
      if (stream.pending && !stream.destroyed) await new Promise<void>(resolve => { stream.once('open', () => resolve()); stream.once('error', () => resolve()); });
    }
    const leaked = state.streams.filter(stream => !stream.closed || !stream.destroyed).length;
    console.log('EXPECTED: orphan streams=0 outputExists=false | ACTUAL:', JSON.stringify({ leaked, outputExists: existsSync(brokenOutput) }));
    console.log(leaked || existsSync(brokenOutput) ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED');
    expect(leaked).toBe(0); expect(existsSync(brokenOutput)).toBe(false);
  } finally { await closeStreams(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});
