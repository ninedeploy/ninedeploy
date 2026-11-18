/** Private node-to-panel WAL bundle; bounded metadata, exact file sizes and hashes, no archive paths. */
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { hashCheckpointFile, walFileDigest, type copyPitrWal } from './pitrCheckpoint.js';

const schema = z.object({ format: z.literal('NDWAL1'), systemIdentifier: z.string().regex(/^[0-9]{1,20}$/).optional(),
  files: z.array(z.object({ name: z.string().regex(/^[0-9A-F]{24}$/), size: z.number().int().positive().max(32 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), rawSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(129),
}).strict();
type CopiedWal = Awaited<ReturnType<typeof copyPitrWal>>;
const MAX_HEADER = 64 * 1024;

export async function packPitrWal(value: CopiedWal, file: string): Promise<void> {
  const metadata = schema.parse({ format: 'NDWAL1', systemIdentifier: value.systemIdentifier, files: [...value.files].map(([name, v]) => ({ name, size: v.size, sha256: v.sha256, rawSha256: v.rawSha256 })) });
  const header = Buffer.from(JSON.stringify(metadata));
  if (header.length > MAX_HEADER) throw new Error('WAL transfer metadata exceeds its bound');
  const prefix = Buffer.alloc(12); prefix.write('NDWAL1\n'); prefix.writeUInt32BE(header.length, 8);
  await writeFile(file, Buffer.concat([prefix, header]), { mode: 0o600, flag: 'wx' });
  for (const [name, v] of value.files) {
    const s = await lstat(v.file);
    if (!s.isFile() || s.nlink !== 1 || s.size !== v.size || await hashCheckpointFile(v.file) !== v.sha256) throw new Error(`WAL transfer source changed: ${name}`);
    await pipeline(createReadStream(v.file), createWriteStream(file, { flags: 'a' }));
  }
}

export async function unpackPitrWal(file: string, directory: string, expectedNames: string[]): Promise<CopiedWal> {
  const handle = await open(file, 'r');
  let metadata: z.infer<typeof schema>, offset: number;
  try {
    const prefix = Buffer.alloc(12);
    if ((await handle.read(prefix, 0, 12, 0)).bytesRead !== 12 || prefix.subarray(0, 7).toString() !== 'NDWAL1\n' || prefix[7] !== 0) throw new Error('Invalid WAL transfer prefix');
    const size = prefix.readUInt32BE(8);
    if (!size || size > MAX_HEADER) throw new Error('Invalid WAL transfer metadata size');
    const header = Buffer.alloc(size);
    if ((await handle.read(header, 0, size, 12)).bytesRead !== size) throw new Error('Truncated WAL transfer metadata');
    metadata = schema.parse(JSON.parse(header.toString('utf8'))); offset = size + 12;
    if (JSON.stringify(metadata.files.map((f) => f.name)) !== JSON.stringify(expectedNames) || new Set(expectedNames).size !== expectedNames.length) throw new Error('WAL transfer selection differs');
    if (metadata.files.reduce((n, f) => n + f.size, offset) !== (await handle.stat()).size) throw new Error('Truncated WAL transfer or trailing data');
  } finally { await handle.close(); }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files: CopiedWal['files'] = new Map();
  for (const [i, v] of metadata.files.entries()) {
    const output = path.join(directory, String(i));
    await pipeline(createReadStream(file, { start: offset, end: offset + v.size - 1 }), createWriteStream(output, { mode: 0o600, flags: 'wx' }));
    if ((await stat(output)).size !== v.size || await hashCheckpointFile(output) !== v.sha256 || await walFileDigest(output) !== v.rawSha256) throw new Error('WAL transfer integrity failed');
    files.set(v.name, { file: output, size: v.size, sha256: v.sha256, rawSha256: v.rawSha256 }); offset += v.size;
  }
  return { files, systemIdentifier: metadata.systemIdentifier };
}
