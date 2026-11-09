import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({ cap: Infinity, fail: false, active: new Set<number>() }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args);
      reads.active.add(fd);
      return fd;
    },
    closeSync: (fd: number) => { fs.closeSync(fd); reads.active.delete(fd); },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      if (reads.fail) throw new Error('fixture read failure');
      return fs.readSync(fd, buffer, offset, Math.min(length, reads.cap), position);
    },
  };
});
import { s3PutFile } from '../../src/lib/s3.js';

const cfg = { endpoint: 'https://fixture.invalid', region: 'fixture', bucket: 'backups', accessKeyId: 'fixture', secretAccessKey: 'fixture' };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nd-s3-reads-'));
  reads.cap = Infinity;
  reads.fail = false;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T00:00:00Z'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
  expect(reads.active.size).toBe(0);
});

function fixture(source: string, truncate?: 'init' | 'part') {
  const file = join(dir, 'backup.dump');
  writeFileSync(file, source);
  const parts: Buffer[] = [];
  const events: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: URL, init: RequestInit) => {
    const url = new URL(input);
    if (url.searchParams.has('uploads')) {
      events.push('init');
      if (truncate === 'init') writeFileSync(file, 'A');
      return new Response('<UploadId>fixture</UploadId>');
    }
    if (init.method === 'PUT') {
      events.push('part');
      parts.push(Buffer.from(init.body as Uint8Array));
      if (truncate === 'part') writeFileSync(file, 'A');
      return new Response('', { headers: { etag: '"fixture"' } });
    }
    if (init.method === 'DELETE') {
      events.push('abort');
      return new Response(null, { status: 204 });
    }
    events.push('complete');
    return new Response('<CompleteMultipartUploadResult/>');
  }));
  return { file, parts, events };
}

describe('S3 multipart source reads', () => {
  it.each([1, 2, 3, Infinity])('uploads exact bytes with reads capped at %s', async cap => {
    reads.cap = cap;
    const f = fixture('ABCDEFGHIJK');
    await s3PutFile(cfg, 'backup.dump', f.file, { partSize: 4, threshold: 1 });
    expect(Buffer.concat(f.parts).toString()).toBe('ABCDEFGHIJK');
    expect(f.parts.map(part => part.length)).toEqual([4, 4, 3]);
    expect(f.events).toEqual(['init', 'part', 'part', 'part', 'complete']);
  });

  it.each(['init', 'part'] as const)('aborts on premature EOF after %s without completing', async phase => {
    const f = fixture('ABCDEFGHIJK', phase);
    await expect(s3PutFile(cfg, 'backup.dump', f.file, { partSize: 4, threshold: 1 })).rejects.toThrow(/ended/);
    expect(f.events).toEqual(phase === 'init' ? ['init', 'abort'] : ['init', 'part', 'abort']);
    expect(Buffer.concat(f.parts).toString()).toBe(phase === 'init' ? '' : 'ABCD');
  });

  it('aborts and preserves the filesystem error', async () => {
    const f = fixture('ABCDEFGHIJK');
    reads.fail = true;
    await expect(s3PutFile(cfg, 'backup.dump', f.file, { partSize: 4, threshold: 1 })).rejects.toThrow('fixture read failure');
    expect(f.events).toEqual(['init', 'abort']);
  });

  it.each(['', 'A'])('keeps the single-PUT path exact for %j', async source => {
    const f = fixture(source);
    await s3PutFile(cfg, 'backup.dump', f.file, { partSize: 4, threshold: 4 });
    expect(Buffer.concat(f.parts).toString()).toBe(source);
    expect(f.events).toEqual(['part']);
  });
});
