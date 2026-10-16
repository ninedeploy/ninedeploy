// Database dump imports (0.14): resumable chunked uploads.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  DatabaseImport,
  DatabaseImportCreate,
  DatabaseImportOptions,
} from '@ninedeploy/schemas';
import { NineDeployError } from './errors.js';
import type { Transport } from './transport.js';

/** 0.14: an import that no longer changes (`DatabaseImport['status']`). */
export const DATABASE_IMPORT_FINISHED_STATUSES: ReadonlyArray<DatabaseImport['status']> = [
  'completed',
  'completed_with_warnings',
  'failed',
  'cancelled',
  'expired',
];

/** 0.14: `databases.imports.wait` polling options. */
export interface ImportWaitOptions {
  /**
   * `finished` (default) waits for a final status; `uploaded` returns as soon
   * as the import leaves `uploading` (an S3 download landing in `pending`).
   */
  until?: 'finished' | 'uploaded';
  /** Poll interval, default 2000 ms. */
  intervalMs?: number;
  /** Give up after this long (default: never). Throws `import_wait_timeout`. */
  timeoutMs?: number;
  /** Called with every polled row. */
  onStatus?: (row: DatabaseImport) => void;
}

/**
 * 0.14: the bytes `databases.importFile` uploads. A factory receives the byte
 * offset to resume from, so a seekable source (a browser `File`, a file
 * handle) skips what the server already holds without re-reading it.
 */
export type ImportFileData = Uint8Array | AsyncIterable<Uint8Array> | ((offset: number) => AsyncIterable<Uint8Array>);

/** 0.14: `databases.importFile` options. */
export interface ImportFileOptions {
  /** Required unless `data` is a Uint8Array (or `resumeImportId` is given). */
  sizeBytes?: number;
  filename?: string;
  /** Hex sha256 of the whole file; the server checks it before starting. */
  sha256?: string;
  options?: DatabaseImportOptions;
  /** Continue an `uploading` (or start a `pending`) import from where the server stands. */
  resumeImportId?: number;
  /** Start the import once uploaded (default true). */
  start?: boolean;
  /** Poll after starting until the import finishes. */
  poll?: boolean | Omit<ImportWaitOptions, 'until'>;
  /** Called once with the new import row (persist its id to resume later). */
  onCreated?: (row: DatabaseImport) => void;
  /** Called after every accepted chunk. */
  onProgress?: (progress: { receivedBytes: number; sizeBytes: number; row: DatabaseImport }) => void;
}

/** 0.14: the import bytes from `offset` on (a factory seeks; the rest skip). */
async function* sourceFrom(data: ImportFileData, offset: number): AsyncIterable<Uint8Array> {
  if (data instanceof Uint8Array) {
    yield data.subarray(offset);
    return;
  }
  if (typeof data === 'function') {
    yield* data(offset);
    return;
  }
  let skip = offset;
  for await (const piece of data) {
    if (skip >= piece.length) {
      skip -= piece.length;
      continue;
    }
    yield skip > 0 ? piece.subarray(skip) : piece;
    skip = 0;
  }
}

/** 0.14: re-cut a byte stream into `size`-byte chunks (the last one shorter). */
async function* rechunk(source: AsyncIterable<Uint8Array>, size: number): AsyncIterable<Uint8Array> {
  let buf = new Uint8Array(size);
  let len = 0;
  for await (const piece of source) {
    let at = 0;
    while (at < piece.length) {
      const take = Math.min(size - len, piece.length - at);
      buf.set(piece.subarray(at, at + take), len);
      len += take;
      at += take;
      if (len === size) {
        yield buf;
        buf = new Uint8Array(size);
        len = 0;
      }
    }
  }
  if (len > 0) yield buf.subarray(0, len);
}

/** Chunked dump-import helpers bound to one transport (used by `databases`). */
export function createImportHelpers(t: Transport) {
  const { get, send, request } = t;
  // ── 0.14 dump import helpers ─────────────────────────────────────────────
  const importPath = (id: number, importId?: number) => `/v1/databases/${id}/imports${importId === undefined ? '' : `/${importId}`}`;
  const getImport = (id: number, importId: number) => get<DatabaseImport>(importPath(id, importId));
  /** An 8 MiB chunk over a slow uplink outlasts the default 30 s budget. */
  const CHUNK_TIMEOUT_MS = 10 * 60_000;
  const uploadChunk = (id: number, importId: number, index: number, chunk: Uint8Array) =>
    request<DatabaseImport>(`${importPath(id, importId)}/chunks/${index}`, { method: 'PUT', raw: chunk }, CHUNK_TIMEOUT_MS);
  const startImport = (id: number, importId: number) => send<DatabaseImport>('POST', `${importPath(id, importId)}/start`);
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => unknown }).setTimeout(resolve, ms);
    });

  async function waitForImport(id: number, importId: number, o: ImportWaitOptions = {}): Promise<DatabaseImport> {
    const interval = o.intervalMs ?? 2000;
    const deadline = o.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + o.timeoutMs;
    for (;;) {
      const row = await getImport(id, importId);
      o.onStatus?.(row);
      const done = o.until === 'uploaded' ? row.status !== 'uploading' : DATABASE_IMPORT_FINISHED_STATUSES.includes(row.status);
      if (done) return row;
      if (Date.now() + interval > deadline) {
        throw new NineDeployError(0, 'import_wait_timeout', `Import ${importId} is still ${row.status}`);
      }
      await sleep(interval);
    }
  }

  async function importFile(id: number, data: ImportFileData, opts: ImportFileOptions = {}): Promise<DatabaseImport> {
    const declared = data instanceof Uint8Array ? data.length : opts.sizeBytes;
    let row: DatabaseImport;
    if (opts.resumeImportId !== undefined) {
      row = await getImport(id, opts.resumeImportId);
    } else {
      if (declared === undefined) throw new NineDeployError(0, 'import_size_required', 'sizeBytes is required for a streamed import');
      const input: DatabaseImportCreate = { source: 'upload', sizeBytes: declared };
      if (opts.sha256 !== undefined) input.sha256 = opts.sha256;
      if (opts.filename !== undefined) input.filename = opts.filename;
      if (opts.options !== undefined) input.options = opts.options;
      row = await send<DatabaseImport>('POST', importPath(id), input);
      opts.onCreated?.(row);
    }
    const size = row.sizeBytes;
    const mismatch = (what: string) =>
      new NineDeployError(0, 'import_size_mismatch', `The data is ${what} than the import's declared ${size} bytes`);
    if (declared !== undefined && declared !== size) throw mismatch(declared > size ? 'larger' : 'smaller');

    if (row.status === 'uploading') {
      let index = row.receivedBytes / row.chunkSize;
      for await (const chunk of rechunk(sourceFrom(data, row.receivedBytes), row.chunkSize)) {
        if (row.receivedBytes + chunk.length > size) throw mismatch('larger');
        row = await uploadChunk(id, row.id, index, chunk);
        index += 1;
        opts.onProgress?.({ receivedBytes: row.receivedBytes, sizeBytes: size, row });
      }
      if (row.receivedBytes < size) throw mismatch('smaller');
    } else if (row.status !== 'pending') {
      throw new NineDeployError(409, 'import_not_resumable', `Import ${row.id} is ${row.status}; only an uploading or pending import can continue`);
    }
    if (opts.start === false) return row;
    row = await startImport(id, row.id);
    if (!opts.poll) return row;
    return waitForImport(id, row.id, opts.poll === true ? {} : opts.poll);
  }

  return { importPath, getImport, uploadChunk, startImport, waitForImport, importFile };
}
