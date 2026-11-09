import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ cap: 1 }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
    fs.readSync(fd, buffer, offset, Math.min(length, state.cap), position) };
});
import { s3PutFile } from '../../apps/server/src/lib/s3.js';
const cfg = { endpoint: 'https://fixture.invalid', region: 'fixture', bucket: 'backups', accessKeyId: 'fixture', secretAccessKey: 'fixture' };
it('verifies exact binary multipart boundaries and EOF abortion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nd-verify-s3-'));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T00:00:00Z'));
  let cases = 0;
  try {
    for (const length of [0, 1, 4, 5, 11, 12, 17]) {
      for (const cap of [1, 2, 3, 7]) {
        for (const truncate of [false, true]) {
          const source = Buffer.from(Array.from({ length }, (_, i) => (i * 73 + 255) % 256));
          const file = join(dir, 'input');
          writeFileSync(file, source);
          state.cap = cap;
          const parts: Buffer[] = [];
          let complete = false, abort = false;
          vi.stubGlobal('fetch', vi.fn(async (input: URL, init: RequestInit) => {
            const url = new URL(input);
            if (url.searchParams.has('uploads')) {
              if (truncate) writeFileSync(file, source.subarray(0, 1));
              return new Response('<UploadId>fixture</UploadId>');
            }
            if (init.method === 'PUT') { parts.push(Buffer.from(init.body as Uint8Array)); return new Response('', { headers: { etag: '"fixture"' } }); }
            if (init.method === 'DELETE') { abort = true; return new Response(null, { status: 204 }); }
            complete = true;
            return new Response('<CompleteMultipartUploadResult/>');
          }));
          const operation = s3PutFile(cfg, 'fixture', file, { partSize: 5, threshold: 4 });
          if (truncate && length >= 4) {
            await expect(operation).rejects.toThrow(/ended/);
            expect(abort).toBe(true); expect(complete).toBe(false); expect(parts).toHaveLength(0);
          } else {
            await operation;
            expect(Buffer.concat(parts)).toEqual(source);
            expect(abort).toBe(false); expect(complete).toBe(length >= 4);
          }
          cases++;
        }
      }
    }
    console.log(`EXPECTED: exact bytes or abort | ACTUAL: ${cases} binary/boundary/EOF cases passed`);
    console.log('FIX VERIFIED');
  } finally { vi.unstubAllGlobals(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});
