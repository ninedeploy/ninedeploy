import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const allocations = vi.hoisted(() => ({ returned: [] as number[] }));
// Instrument the native boundary, forwarding every call to the real codec.
// The assertion measures returned output bytes, not elapsed time or an option.
vi.mock('node:zlib', async original => {
  const real = await original<typeof import('node:zlib')>();
  return {
    ...real,
    gunzipSync: (...args: Parameters<typeof real.gunzipSync>) => {
      const output = real.gunzipSync(...args);
      allocations.returned.push(output.length);
      return output;
    },
  };
});

const { gunzipTo, sniffBytes, sniffFile } = await import('../../src/lib/databaseImport.js');
const BUDGET = 64 * 1024;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'nd-import-gzip-'));
  allocations.returned.length = 0;
});
afterEach(() => {
  if (dirname(directory) !== tmpdir() || !basename(directory).startsWith('nd-import-gzip-')) throw new Error('Invalid gzip fixture cleanup path');
  rmSync(directory, { recursive: true, force: true });
});

it('bounds native output allocation when sniffing a high-ratio gzip file', async () => {
  const control = sniffBytes(gzipSync(Buffer.from('SELECT 1;\n')));
  expect(control).toEqual({ gzip: true, kind: 'text' });
  console.log('CONTROL: small gzip remains text = true');
  const inputBytes = 32 * 1024 * 1024;
  const compressed = gzipSync(Buffer.alloc(inputBytes, 65));
  expect(compressed.length).toBeLessThan(BUDGET);
  const file = join(directory, 'large.sql.gz');
  writeFileSync(file, compressed);
  allocations.returned.length = 0;
  for (let repetition = 0; repetition < 3; repetition++) {
    expect(await sniffFile(file)).toEqual({ gzip: true, kind: 'text' });
  }
  const largestResult = Math.max(0, ...allocations.returned);
  const bounded = largestResult <= BUDGET;
  console.log(`INPUT: uncompressed=${inputBytes}, gzip=${compressed.length}, repetitions=3`);
  console.log(`EXPECTED: native result <= ${BUDGET} bytes | ACTUAL: largest=${largestResult}`);
  console.log(bounded ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
  expect(bounded).toBe(true);
});

it('preserves magic bytes for large gzip inputs and a compressed prefix', () => {
  const fixtures: Array<[Buffer, string]> = [
    [Buffer.from('PGDMP'), 'pg_custom'], [Buffer.from('REDIS0012'), 'rdb'],
    [Buffer.from('NDBK1:v1:x'), 'envelope'], [Buffer.from([0x6d, 0xe2, 0x99, 0x81]), 'mongo_archive'],
    [Buffer.from([65, 0, 66]), 'binary'],
  ];
  const tar = Buffer.alloc(1024);
  tar.write('ustar', 257);
  fixtures.push([tar, 'tar']);
  for (const [prefix, kind] of fixtures) {
    const compressed = gzipSync(Buffer.concat([prefix, Buffer.alloc(1024 * 1024, 65)]));
    expect(sniffBytes(compressed)).toEqual({ gzip: true, kind });
    expect(sniffBytes(compressed.subarray(0, -8))).toEqual({ gzip: true, kind });
  }
});

it('handles empty, exact-budget, malformed and plain input', () => {
  expect(sniffBytes(gzipSync(Buffer.alloc(0)))).toEqual({ gzip: true, kind: 'empty' });
  expect(sniffBytes(gzipSync(Buffer.alloc(BUDGET, 65)))).toEqual({ gzip: true, kind: 'text' });
  expect(sniffBytes(Buffer.from([0x1f, 0x8b, 0xff, 0xff]))).toEqual({ gzip: true, kind: 'binary' });
  expect(sniffBytes(Buffer.from('SELECT 1;'))).toEqual({ gzip: false, kind: 'text' });
});

it('keeps full decompression capped and cleans its own failed output', async () => {
  const source = join(directory, 'data.gz');
  const output = join(directory, 'data.raw');
  const compressed = gzipSync(Buffer.alloc(8192, 65));
  writeFileSync(source, compressed);
  await gunzipTo(source, output, 8192);
  expect(readFileSync(output)).toEqual(Buffer.alloc(8192, 65));
  const failed = join(directory, 'failed.raw');
  await expect(gunzipTo(source, failed, 8191)).rejects.toThrow(/exceeds/);
  expect(existsSync(failed)).toBe(false);
  expect(readFileSync(source)).toEqual(compressed);
});
