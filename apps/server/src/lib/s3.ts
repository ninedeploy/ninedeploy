import { createHash, createHmac } from 'node:crypto';

/**
 * Minimal S3-compatible client with AWS SigV4 request signing — zero
 * dependencies beyond node:crypto + fetch. Works with AWS S3 and any
 * S3-compatible endpoint (MinIO, R2, Backblaze B2, Garage, …) using
 * path-style addressing.
 *
 * Large transfers never buffer the whole object: `s3PutFile` streams a file
 * as a bounded-memory multipart upload (one ≤32 MB part in heap at a time)
 * and `s3GetToFile` pipes a GET straight to disk. Buffering multi-gigabyte
 * database dumps used to OOM the panel, which also hosts the deploy worker.
 */

export interface S3Config {
  endpoint: string; // e.g. https://s3.eu-central-1.amazonaws.com
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Part size for multipart uploads — the heap ceiling per part. */
const MULTIPART_PART_SIZE = 32 * 1024 * 1024;
/** Objects below this size skip the multipart handshake entirely. */
const MULTIPART_THRESHOLD = 64 * 1024 * 1024;

const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest();

function uriEncode(s: string): string {
  // Keep `/` literal (path separators in the object key); percent-encode
  // everything else that is not URL-safe, including the reserved !'()* set.
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, '/');
}

/** Canonical (sorted, URI-encoded) query string for SigV4; '' when empty. */
function canonicalQueryString(query?: URLSearchParams): string {
  if (!query || [...query.keys()].length === 0) return '';
  return [...query.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/**
 * Sign and execute one S3 request. `path` is the object key (already
 * namespace-prefixed by the caller); method/body drive the signature.
 */
/** Per-request timeout; for streamed downloads, the no-progress (stall) limit. */
const S3_TIMEOUT_MS = 120_000;

export async function s3Request(
  cfg: S3Config,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD',
  key: string,
  body?: Buffer | string,
  contentType = 'application/octet-stream',
  query?: URLSearchParams,
  /** Abort signal replacing the default whole-request 120 s timeout. */
  signal?: AbortSignal,
): Promise<Response> {
  const canonicalQuery = canonicalQueryString(query);
  const url = new URL(`${cfg.endpoint.replace(/\/$/, '')}/${cfg.bucket}/${uriEncode(key)}`);
  if (canonicalQuery) url.search = canonicalQuery;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body ?? '');

  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (method === 'PUT') headers['content-type'] = contentType;

  // Canonical request (sorted header names; signed headers list must match).
  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaders.map((h) => `${h}:${headers[h]!.trim()}\n`).join('');
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, dateStamp), cfg.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;

  return fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : body instanceof Buffer ? new Uint8Array(body) : body,
    signal: signal ?? AbortSignal.timeout(S3_TIMEOUT_MS),
  });
}

/** PUT an object; throws with the response body when the upload fails. */
export async function s3Put(cfg: S3Config, key: string, data: Buffer | string): Promise<void> {
  const res = await s3Request(cfg, 'PUT', key, data);
  if (!res.ok) throw new Error(`S3 upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

/** Pull the upload id out of an InitiateMultipartUploadResult response. */
function parseUploadId(xml: string): string | undefined {
  return xml.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
}

/**
 * PUT a file from disk without ever holding the whole object in heap:
 * single PUT below the multipart threshold, a bounded-memory multipart
 * upload above it (one part in memory at a time).
 *
 * The size knobs are injectable so tests can drive the multipart path with
 * tiny files.
 */
export async function s3PutFile(
  cfg: S3Config,
  key: string,
  filePath: string,
  sizes?: { partSize?: number; threshold?: number },
): Promise<void> {
  const { statSync, openSync, readSync, closeSync, readFileSync } = await import('node:fs');
  const partSize = sizes?.partSize ?? MULTIPART_PART_SIZE;
  const threshold = sizes?.threshold ?? MULTIPART_THRESHOLD;
  const size = statSync(filePath).size;
  if (size < threshold) {
    await s3Put(cfg, key, readFileSync(filePath));
    return;
  }

  // 1. Initiate.
  const initRes = await s3Request(cfg, 'POST', key, undefined, 'application/xml', new URLSearchParams({ uploads: '' }));
  if (!initRes.ok) throw new Error(`S3 multipart initiate failed (${initRes.status}): ${(await initRes.text()).slice(0, 200)}`);
  const uploadId = parseUploadId(await initRes.text());
  if (!uploadId) throw new Error('S3 multipart initiate returned no UploadId');

  try {
    // 2. Upload parts — one bounded chunk in heap at a time.
    const parts: Array<{ partNumber: number; etag: string }> = [];
    const totalParts = Math.ceil(size / partSize);
    const fh = openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(partSize);
      for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        const length = partNumber === totalParts ? size - (partNumber - 1) * partSize : partSize;
        readSync(fh, buf, 0, length, (partNumber - 1) * partSize);
        const chunk = length === partSize ? buf : buf.subarray(0, length);
        const res = await s3Request(
          cfg, 'PUT', key, chunk, 'application/octet-stream',
          new URLSearchParams({ partNumber: String(partNumber), uploadId }),
        );
        if (!res.ok) throw new Error(`S3 multipart part ${partNumber}/${totalParts} failed (${res.status})`);
        const etag = res.headers.get('etag');
        if (!etag) throw new Error(`S3 multipart part ${partNumber} returned no ETag`);
        parts.push({ partNumber, etag: etag.replaceAll('"', '') });
      }
    } finally {
      closeSync(fh);
    }

    // 3. Complete.
    const completeXml =
      '<CompleteMultipartUpload>' +
      parts
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag}"</ETag></Part>`)
        .join('') +
      '</CompleteMultipartUpload>';
    const done = await s3Request(
      cfg, 'POST', key, completeXml, 'application/xml',
      new URLSearchParams({ uploadId }),
    );
    const doneBody = await done.text();
    if (!done.ok) throw new Error(`S3 multipart complete failed (${done.status}): ${doneBody.slice(0, 200)}`);
    // r312: CompleteMultipartUpload is the one S3 call that can fail AFTER
    // the 200 status line — S3 sends the headers early and reports e.g.
    // InternalError / EntityTooSmall as an <Error> document in the body.
    // Checking `ok` alone recorded such an upload as a success: backupRemote
    // saved the remoteKey, retention could then delete the local file, and
    // the only copy was a recovery point that did not exist. Success is a
    // <CompleteMultipartUploadResult>; an <Error> element is a failure (the
    // catch below aborts the upload so its parts stop billing).
    if (/<Error[\s>]/.test(doneBody)) {
      throw new Error(`S3 multipart complete failed (${done.status} with an error body): ${doneBody.slice(0, 200)}`);
    }
  } catch (err) {
    // An abandoned multipart upload keeps billing for stored parts — always
    // abort on the way out of a failed upload.
    await s3Request(cfg, 'DELETE', key, undefined, 'application/octet-stream', new URLSearchParams({ uploadId })).catch(() => undefined);
    throw err;
  }
}

/** GET an object as bytes. */
export async function s3Get(cfg: S3Config, key: string): Promise<Buffer> {
  const res = await s3Request(cfg, 'GET', key);
  if (!res.ok) throw new Error(`S3 download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * GET an object straight to a file — the response stream is piped to disk
 * so a multi-GB restore never enters the heap.
 */
export async function s3GetToFile(
  cfg: S3Config,
  key: string,
  filePath: string,
  stallMs: number = S3_TIMEOUT_MS,
): Promise<void> {
  // r188: the default `AbortSignal.timeout(120s)` also covers the response
  // BODY, so a multi-GB restore was aborted mid-stream at two minutes (a
  // truncated dump and a failed restore or drill). A streamed download is
  // instead aborted only when no bytes arrive for `stallMs`.
  const controller = new AbortController();
  let stall = setTimeout(() => controller.abort(new Error('S3 download stalled')), stallMs);
  const touch = () => {
    clearTimeout(stall);
    stall = setTimeout(() => controller.abort(new Error('S3 download stalled')), stallMs);
  };
  try {
    const res = await s3Request(cfg, 'GET', key, undefined, undefined, undefined, controller.signal);
    touch();
    if (!res.ok) throw new Error(`S3 download failed (${res.status})`);
    if (!res.body) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(filePath, '', { mode: 0o600 });
      return;
    }
    const { createWriteStream } = await import('node:fs');
    const { Readable, Transform } = await import('node:stream');
    const { pipeline } = await import('node:stream/promises');
    const progress = new Transform({
      transform(chunk, _enc, done) {
        touch();
        done(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream),
      progress,
      createWriteStream(filePath, { mode: 0o600 }),
      { signal: controller.signal },
    );
  } finally {
    clearTimeout(stall);
  }
}

/** DELETE an object; missing objects (404) are treated as success. */
export async function s3Delete(cfg: S3Config, key: string): Promise<void> {
  const res = await s3Request(cfg, 'DELETE', key);
  if (!res.ok && res.status !== 404) throw new Error(`S3 delete failed (${res.status})`);
}

/** Cheap connectivity/auth probe — PUT+DELETE a tiny marker object. */
export async function s3Test(cfg: S3Config): Promise<void> {
  const marker = `.ninedeploy-test-${Date.now()}`;
  await s3Put(cfg, marker, 'ok');
  await s3Delete(cfg, marker);
}
