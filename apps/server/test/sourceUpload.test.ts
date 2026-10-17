import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 0.16.1 uploaded source archives (lib/sourceUpload.ts): what is accepted,
 * what is refused before anything is kept, how an upload lands in the
 * workspace, and which uploads are kept. Archives are built byte by byte
 * here, so the hostile ones (`../`, symlinks, encryption, bombs) need no
 * tool that would refuse to make them.
 */

const root = mkdtempSync(path.join(tmpdir(), 'nd-source-'));
const cfg = vi.hoisted(() => ({ config: { paths: { dataDir: '' } } }));
vi.mock('../src/config.js', () => cfg);
cfg.config.paths.dataDir = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));

const lib = await import('../src/lib/sourceUpload.js');

// ── archive builders ───────────────────────────────────────────────────────

interface ZipItem {
  name: string;
  data?: string | Buffer;
  /** Unix mode, recorded as "made by Unix" (e.g. 0o100755, 0o120777 for a symlink). */
  mode?: number;
  deflate?: boolean;
  encrypted?: boolean;
  /** Override the declared uncompressed size / CRC (corruption and bomb cases). */
  size?: number;
  crc?: number;
}

function zip(items: ZipItem[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const it of items) {
    const name = Buffer.from(it.name, 'utf8');
    const data = Buffer.isBuffer(it.data) ? it.data : Buffer.from(it.data ?? '', 'utf8');
    const body = it.deflate ? deflateRawSync(data) : data;
    const method = it.deflate ? 8 : 0;
    const crc = it.crc ?? crc32(data);
    const size = it.size ?? data.length;
    const flags = it.encrypted ? 1 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(it.mode != null ? (3 << 8) | 20 : 20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(it.mode != null ? (it.mode << 16) >>> 0 : 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(items.length, 8);
  eocd.writeUInt16LE(items.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

interface TarItem {
  name: string;
  data?: string;
  /** ustar typeflag: '0' file, '5' directory, '2' symlink, '1' hardlink. */
  type?: string;
  link?: string;
}

function tarGz(items: TarItem[]): Buffer {
  const blocks: Buffer[] = [];
  for (const it of items) {
    const data = Buffer.from(it.data ?? '', 'utf8');
    const type = it.type ?? (it.name.endsWith('/') ? '5' : '0');
    const h = Buffer.alloc(512);
    h.write(it.name, 0, 100, 'utf8');
    h.write(type === '5' ? '0000755\0' : '0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${(type === '0' ? data.length : 0).toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(type, 156);
    if (it.link) h.write(it.link, 157, 100, 'utf8');
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h);
    if (type === '0' && data.length > 0) {
      blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

// ── tests ──────────────────────────────────────────────────────────────────

let serviceId = 100;
beforeEach(() => {
  serviceId++;
});
const workDir = () => path.join(root, 'repos', String(serviceId));
const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(dir, path.join(d.parentPath, d.name)).split(path.sep).join('/'))
    .sort();

describe('which services take uploads', () => {
  it('a docker service with no repository, image or inline stack', () => {
    expect(lib.isUploadSourced({ type: 'docker', repoUrl: null, image: null, composeContent: null })).toBe(true);
    expect(lib.isUploadSourced({ type: 'docker', repoUrl: 'https://github.com/a/b.git' })).toBe(false);
    expect(lib.isUploadSourced({ type: 'docker', image: 'nginx' })).toBe(false);
    expect(lib.isUploadSourced({ type: 'compose', composeContent: 'services: {}' })).toBe(false);
    expect(lib.isUploadSourced({ type: 'pm2' })).toBe(false);
  });
});

describe('format sniffing', () => {
  it('reads zip and gzip by magic bytes, nothing else', () => {
    expect(lib.sniffSourceFormat(zip([{ name: 'a', data: 'x' }]))).toBe('zip');
    expect(lib.sniffSourceFormat(tarGz([{ name: 'a', data: 'x' }]))).toBe('tar.gz');
    expect(lib.sniffSourceFormat(Buffer.from('FROM node:22\n'))).toBeNull();
  });
});

describe('zip uploads', () => {
  it('stores, then extracts into the workspace; a zipped folder becomes the root and junk is dropped', async () => {
    const archive = zip([
      { name: 'myapp/' },
      { name: 'myapp/Dockerfile', data: 'FROM nginx\n', deflate: true },
      { name: 'myapp/src/index.html', data: '<h1>hi</h1>' },
      { name: 'myapp/gradlew', data: '#!/bin/sh\n', mode: 0o100755 },
      { name: '__MACOSX/myapp/._Dockerfile', data: 'junk' },
      { name: 'myapp/.DS_Store', data: 'junk' },
    ]);
    const stored = await lib.storeSourceUpload(serviceId, archive);
    expect(stored).toMatchObject({ format: 'zip', bytes: archive.length });
    expect(stored.sha).toMatch(/^[0-9a-f]{40}$/);

    const out = await lib.extractSourceUpload(serviceId, null, workDir());
    expect(out).toMatchObject({ sha: stored.sha, strippedFolder: 'myapp' });
    expect(files(workDir())).toEqual(['Dockerfile', 'gradlew', 'src/index.html']);
    expect(readFileSync(path.join(workDir(), 'Dockerfile'), 'utf8')).toBe('FROM nginx\n');
    if (process.platform !== 'win32') expect(statSync(path.join(workDir(), 'gradlew')).mode & 0o111).not.toBe(0);
  });

  it('replaces the previous workspace entirely', async () => {
    await lib.storeSourceUpload(serviceId, zip([{ name: 'old.txt', data: '1' }, { name: 'keep.txt', data: '1' }]));
    await lib.extractSourceUpload(serviceId, null, workDir());
    await lib.storeSourceUpload(serviceId, zip([{ name: 'new.txt', data: '2' }, { name: 'keep.txt', data: '2' }]));
    await lib.extractSourceUpload(serviceId, null, workDir());
    expect(files(workDir())).toEqual(['keep.txt', 'new.txt']);
  });

  const refused: Array<[string, Buffer, RegExp]> = [
    ['a parent-directory path', zip([{ name: '../evil.sh', data: 'x' }]), /Unsafe path/],
    ['a nested parent-directory path', zip([{ name: 'a/../../evil', data: 'x' }]), /Unsafe path/],
    ['an absolute path', zip([{ name: '/etc/cron.d/x', data: 'x' }]), /Unsafe path/],
    ['a drive-letter path', zip([{ name: 'C:/Windows/x', data: 'x' }]), /Unsafe path/],
    ['a backslash parent path', zip([{ name: '..\\evil', data: 'x' }]), /Unsafe path/],
    ['a symlink', zip([{ name: 'link', data: '/etc/passwd', mode: 0o120777 }]), /regular files and directories/],
    ['an encrypted entry', zip([{ name: 'a', data: 'x', encrypted: true }]), /Encrypted/],
    ['a checksum mismatch', zip([{ name: 'a', data: 'hello', crc: 1 }]), /Corrupt entry/],
    ['a member that inflates past its declared size', zip([{ name: 'bomb', data: Buffer.alloc(1_000_000), deflate: true, size: 10 }]), /decompress|Corrupt/],
    ['a member declared larger than the in-memory cap', zip([{ name: 'big', data: 'x', size: 300 * 1024 * 1024 }]), /larger than 256 MiB/],
    ['not an archive at all', Buffer.from('hello world'), /\.zip or a \.tar\.gz/],
    ['a zip without its directory', zip([{ name: 'a', data: 'x' }]).subarray(0, 40), /not a valid zip/i],
  ];
  for (const [what, archive, message] of refused) {
    it(`refuses ${what} before keeping anything`, async () => {
      await expect(lib.storeSourceUpload(serviceId, archive)).rejects.toThrow(message);
      expect(lib.listSourceUploads(serviceId)).toEqual([]);
    });
  }

  it('refuses an empty upload', async () => {
    await expect(lib.storeSourceUpload(serviceId, Buffer.alloc(0))).rejects.toThrow(/empty/);
  });
});

describe('tar.gz uploads', () => {
  it('stores and extracts', async () => {
    const stored = await lib.storeSourceUpload(serviceId, tarGz([
      { name: 'app/' },
      { name: 'app/Dockerfile', data: 'FROM node:22\n' },
      { name: 'app/server.js', data: 'console.log(1)\n' },
    ]));
    expect(stored.format).toBe('tar.gz');
    const out = await lib.extractSourceUpload(serviceId, stored.sha, workDir());
    expect(out.strippedFolder).toBe('app');
    expect(files(workDir())).toEqual(['Dockerfile', 'server.js']);
  });

  const refused: Array<[string, Buffer, RegExp]> = [
    ['a parent-directory path', tarGz([{ name: '../evil.sh', data: 'x' }]), /Unsafe path/],
    ['an absolute path', tarGz([{ name: '/etc/evil', data: 'x' }]), /Unsafe path|regular files/],
    ['a symlink', tarGz([{ name: 'link', type: '2', link: '/etc' }, { name: 'link/passwd', data: 'x' }]), /regular files and directories/],
    ['a hardlink', tarGz([{ name: 'a', data: 'x' }, { name: 'h', type: '1', link: 'a' }]), /regular files and directories/],
    ['a broken gzip stream', Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('not gzip at all')]), /gzip|tar/i],
  ];
  for (const [what, archive, message] of refused) {
    it(`refuses ${what} before keeping anything`, async () => {
      await expect(lib.storeSourceUpload(serviceId, archive)).rejects.toThrow(message);
      expect(lib.listSourceUploads(serviceId)).toEqual([]);
      // No half-written file is left behind.
      const dir = path.join(root, 'uploads', String(serviceId));
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    });
  }
});

describe('which uploads are kept', () => {
  it(`keeps the newest ${lib.SOURCE_KEEP}, newest first; re-uploading the same bytes makes them the newest again`, async () => {
    const shas: string[] = [];
    for (let i = 0; i < lib.SOURCE_KEEP + 2; i++) {
      shas.push((await lib.storeSourceUpload(serviceId, zip([{ name: 'v.txt', data: String(i) }]))).sha);
      await new Promise((r) => setTimeout(r, 15));
    }
    const kept = lib.listSourceUploads(serviceId).map((u) => u.sha);
    expect(kept).toEqual(shas.slice(-lib.SOURCE_KEEP).reverse());

    await new Promise((r) => setTimeout(r, 15));
    await lib.storeSourceUpload(serviceId, zip([{ name: 'v.txt', data: String(lib.SOURCE_KEEP - 1) }]));
    expect(lib.listSourceUploads(serviceId)[0]!.sha).toBe(shas[lib.SOURCE_KEEP - 1]);
  });

  it('a redeploy of a pruned upload, or a service never uploaded to, fails with what to do', async () => {
    await expect(lib.extractSourceUpload(serviceId, null, workDir())).rejects.toThrow(/no uploaded source yet/);
    await lib.storeSourceUpload(serviceId, zip([{ name: 'a', data: 'x' }]));
    await expect(lib.extractSourceUpload(serviceId, 'f'.repeat(40), workDir())).rejects.toThrow(/no longer kept/);
  });

  it('removes every upload with the service', async () => {
    await lib.storeSourceUpload(serviceId, zip([{ name: 'a', data: 'x' }]));
    lib.removeSourceUploads(serviceId);
    expect(lib.listSourceUploads(serviceId)).toEqual([]);
  });
});
