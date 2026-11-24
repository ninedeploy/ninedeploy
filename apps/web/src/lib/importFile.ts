import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const IMPORT_DUMP_ANCHOR = 'import-dump';
export const IMPORT_VOLUME_ANCHOR = 'import-volume';

/** Read from the requested offset in bounded slices. The SDK re-cuts these to its upload size. */
export function fileChunks(file: Blob, step = 4 * 1024 * 1024): (offset: number) => AsyncIterable<Uint8Array> {
  return async function* (offset) {
    for (let at = offset; at < file.size; at += step) {
      yield new Uint8Array(await file.slice(at, Math.min(at + step, file.size)).arrayBuffer());
    }
  };
}

export async function importFileChecksum(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const hash = sha256.create();
  for await (const chunk of chunks) hash.update(chunk);
  return bytesToHex(hash.digest());
}
