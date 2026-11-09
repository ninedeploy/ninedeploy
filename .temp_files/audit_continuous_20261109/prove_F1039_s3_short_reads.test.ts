import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const reads = vi.hoisted(() => ({ cap: Infinity }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
    fs.readSync(fd, buffer, offset, Math.min(length, reads.cap), position) };
});
import { s3PutFile } from '../../apps/server/src/lib/s3.js';
const cfg = { endpoint: 'https://fixture.invalid', region: 'fixture', bucket: 'backups', accessKeyId: 'fixture', secretAccessKey: 'fixture' };
const source = Buffer.from('ABCDEFGHIJKL');
async function upload(file: string, mode: 'full' | 'short' | 'eof') {
  writeFileSync(file, source); reads.cap = mode === 'short' ? 2 : Infinity;
  const parts: Buffer[] = []; let completed = false, rejected = false, aborted = false;
  vi.stubGlobal('fetch', vi.fn(async (input: URL, init: RequestInit) => {
    const url = new URL(input);
    if (url.searchParams.has('uploads')) {
      if (mode === 'eof') writeFileSync(file, 'AB');
      return new Response('<UploadId>fixture</UploadId>');
    }
    if (init.method === 'PUT') { parts.push(Buffer.from(init.body as Uint8Array)); return new Response('', { headers: { etag: '"fixture"' } }); }
    if (init.method === 'DELETE') { aborted = true; return new Response(null, { status: 204 }); }
    completed = true; return new Response('<CompleteMultipartUploadResult/>');
  }));
  try { await s3PutFile(cfg, 'fixture.dump', file, { partSize: 4, threshold: 1 }); } catch { rejected = true; }
  return { uploaded: Buffer.concat(parts), completed, rejected, aborted };
}
it('never completes corrupted multipart bytes after short reads or early EOF', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nd-audit-s3-read-'));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-09T00:00:00Z'));
  try {
    const file = join(dir, 'backup.dump');
    const control = await upload(file, 'full'); expect(control.uploaded).toEqual(source); expect(control.completed).toBe(true);
    console.log('CONTROL EXPECTED: full reads upload ABCDEFGHIJKL | ACTUAL:', control.uploaded.toString());
    const short = await upload(file, 'short'), eof = await upload(file, 'eof');
    console.log('EXPECTED: short-read bytes exact; EOF rejected and aborted | ACTUAL:', JSON.stringify({ shortHex: short.uploaded.toString('hex'), expectedHex: source.toString('hex'), eofCompleted: eof.completed, eofRejected: eof.rejected, eofAborted: eof.aborted }));
    const bad = !short.uploaded.equals(source) || !eof.rejected || !eof.aborted || eof.completed;
    console.log(bad ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED');
    expect(short.uploaded).toEqual(source); expect(short.completed).toBe(true);
    expect(eof).toMatchObject({ rejected: true, aborted: true, completed: false });
  } finally { reads.cap = Infinity; vi.unstubAllGlobals(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});
