import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { s3Delete, s3Get, s3GetToFile, s3Put, s3PutFile, s3Request, s3Test } from '../../src/lib/s3.js';

const CFG = {
  endpoint: 'https://s3.example.com',
  region: 'eu-central-1',
  bucket: 'backups',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
};

const fetchMock = vi.hoisted(() => vi.fn());

describe('s3Request signing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('sends a SigV4-signed path-style request', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    await s3Request(CFG, 'PUT', 'prefix/backup.enc', 'data', 'text/plain');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://s3.example.com/backups/prefix/backup.enc');
    expect(init.method).toBe('PUT');

    const headers = init.headers as Record<string, string>;
    expect(headers['host']).toBe('s3.example.com');
    expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    // The payload hash is the sha256 hex of the body ("data").
    expect(headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/s3\/aws4_request, SignedHeaders=(content-type;)?host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    if (init.method === 'PUT') expect(headers['content-type']).toBe('text/plain');
  });

  it('uri-encodes keys with special characters', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    await s3Request(CFG, 'GET', 'a b/c+d');
    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(decodeURIComponent(url.pathname)).toBe('/backups/a b/c+d');
    expect(url.pathname).not.toBe('/backups/a b/c+d');
  });

  it('percent-encodes reserved characters (!\'()*) in keys', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    await s3Request(CFG, 'GET', "a!b'c(d)e*f");
    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toContain('a%21b%27c%28d%29e%2Af');
  });
});

describe('s3Put/Get/Delete/Test', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('s3Put throws with the body on failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'AccessDenied' });
    vi.stubGlobal('fetch', fetchMock);
    await expect(s3Put(CFG, 'k', 'x')).rejects.toThrow('S3 upload failed (403)');
  });

  it('s3Get returns bytes', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('hello').buffer });
    vi.stubGlobal('fetch', fetchMock);
    const bytes = await s3Get(CFG, 'k');
    expect(bytes.toString()).toBe('hello');
  });

  it('s3Get throws on failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(s3Get(CFG, 'missing')).rejects.toThrow('S3 download failed (404)');
  });

  it('s3Delete tolerates 404 but not 403', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    await expect(s3Delete(CFG, 'gone')).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => '' });
    await expect(s3Delete(CFG, 'locked')).rejects.toThrow('S3 delete failed (403)');
  });

  it('s3Test PUTs and DELETEs a marker', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    await s3Test(CFG);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0] as unknown[])[1]).toMatchObject({ method: 'PUT' });
    expect((fetchMock.mock.calls[1] as unknown[])[1]).toMatchObject({ method: 'DELETE' });
  });

  it('sends Buffer bodies as bytes and string bodies as strings', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    await s3Put(CFG, 'k1', Buffer.from('bytes-body'));
    expect((fetchMock.mock.calls[0] as [URL, RequestInit])[1].body).toBeInstanceOf(Uint8Array);
    await s3Put(CFG, 'k2', 'string-body');
    expect((fetchMock.mock.calls[1] as [URL, RequestInit])[1].body).toBe('string-body');
  });

  it('sends no body for GET/DELETE/HEAD', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    await s3Get(CFG, 'k');
    await s3Delete(CFG, 'k');
    expect(((fetchMock.mock.calls[0] as [URL, RequestInit])[1].body)).toBeUndefined();
  });
});

describe('s3PutFile / s3GetToFile (streamed transfers)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('s3PutFile single-PUTs a small file below the multipart threshold', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    const file = path.join(tmpdir(), `s3-small-${Date.now()}`);
    writeFileSync(file, 'tiny-payload');

    await s3PutFile(CFG, 'k/small', file);

    // One request, and the FULL bytes travel as the body.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = (fetchMock.mock.calls[0] as [URL, RequestInit])[1].body as Uint8Array;
    expect(Buffer.from(body).toString()).toBe('tiny-payload');
    rmSync(file, { force: true });
  });

  it('s3PutFile runs a bounded multipart upload and completes with the collected ETags', async () => {
    // Inject tiny sizes so a 12-byte file drives the full multipart machine:
    // initiate → 3 parts → complete.
    const initiate = { ok: true, status: 200, text: async () => '<UploadId>up-123</UploadId>', headers: new Headers() };
    const part = { ok: true, status: 200, text: async () => '', headers: new Headers({ etag: '"part-etag-1"' }) };
    const done = { ok: true, status: 200, text: async () => '<CompleteMultipartUploadResult/>', headers: new Headers() };
    fetchMock
      .mockResolvedValueOnce(initiate)
      .mockResolvedValueOnce(part)
      .mockResolvedValueOnce(part)
      .mockResolvedValueOnce(part)
      .mockResolvedValueOnce(done);
    vi.stubGlobal('fetch', fetchMock);

    const file = path.join(tmpdir(), `s3-mpu-${Date.now()}`);
    writeFileSync(file, Buffer.from('aaabbbcccddd'));

    await s3PutFile(CFG, 'k/big', file, { partSize: 4, threshold: 10 });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const [initUrl] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(initUrl.search).toBe('?uploads=');
    // Parts 1 and 2 are full 4-byte chunks; part 3 carries the remaining 4.
    const part1 = (fetchMock.mock.calls[1] as [URL, RequestInit]);
    expect((part1[0] as URL).search).toContain('partNumber=1');
    expect((part1[0] as URL).search).toContain('uploadId=up-123');
    expect(Buffer.from(part1[1].body as Uint8Array).toString()).toBe('aaab');
    const complete = (fetchMock.mock.calls[4] as [URL, RequestInit]);
    expect((complete[0] as URL).search).toBe('?uploadId=up-123');
    expect(complete[1].body).toContain('<PartNumber>3</PartNumber>');
    expect(String(complete[1].body)).toContain('part-etag-1');
    rmSync(file, { force: true });
  });

  it('s3PutFile aborts the multipart upload when a part fails', async () => {
    const initiate = { ok: true, status: 200, text: async () => '<UploadId>up-x</UploadId>', headers: new Headers() };
    const failPart = { ok: false, status: 500, text: async () => 'boom', headers: new Headers() };
    const abort = { ok: true, status: 204, text: async () => '', headers: new Headers() };
    fetchMock.mockResolvedValueOnce(initiate).mockResolvedValueOnce(failPart).mockResolvedValueOnce(abort);
    vi.stubGlobal('fetch', fetchMock);

    const file = path.join(tmpdir(), `s3-abort-${Date.now()}`);
    writeFileSync(file, Buffer.from('aaabbbcccddd'));

    await expect(s3PutFile(CFG, 'k/big', file, { partSize: 4, threshold: 10 })).rejects.toThrow('S3 multipart part 1/3 failed (500)');
    // The third request is the DELETE ?uploadId= abort call.
    const [abortUrl, abortInit] = fetchMock.mock.calls[2] as [URL, RequestInit];
    expect(abortInit.method).toBe('DELETE');
    expect((abortUrl as URL).search).toBe('?uploadId=up-x');
    rmSync(file, { force: true });
  });

  it('s3PutFile surfaces an initiate failure', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'AccessDenied' } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const file = path.join(tmpdir(), `s3-init-${Date.now()}`);
    writeFileSync(file, Buffer.from('aaabbbcccddd'));
    await expect(s3PutFile(CFG, 'k/big', file, { partSize: 4, threshold: 10 })).rejects.toThrow('S3 multipart initiate failed (403)');
    rmSync(file, { force: true });
  });

  it('s3PutFile surfaces a malformed initiate response (no UploadId)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '<Error>nope</Error>', headers: new Headers() } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const file = path.join(tmpdir(), `s3-noid-${Date.now()}`);
    writeFileSync(file, Buffer.from('aaabbbcccddd'));
    await expect(s3PutFile(CFG, 'k/big', file, { partSize: 4, threshold: 10 })).rejects.toThrow('returned no UploadId');
    rmSync(file, { force: true });
  });

  it('s3PutFile surfaces a failed complete call', async () => {
    const initiate = { ok: true, status: 200, text: async () => '<UploadId>up-y</UploadId>', headers: new Headers() };
    const part = { ok: true, status: 200, text: async () => '', headers: new Headers({ etag: '"e1"' }) };
    const done = { ok: false, status: 400, text: async () => 'MalformedXML', headers: new Headers() };
    fetchMock.mockResolvedValueOnce(initiate).mockResolvedValueOnce(part).mockResolvedValueOnce(part).mockResolvedValueOnce(part).mockResolvedValueOnce(done);
    vi.stubGlobal('fetch', fetchMock);
    const file = path.join(tmpdir(), `s3-done-${Date.now()}`);
    writeFileSync(file, Buffer.from('aaabbbcccddd'));
    await expect(s3PutFile(CFG, 'k/big', file, { partSize: 4, threshold: 10 })).rejects.toThrow('S3 multipart complete failed (400)');
    rmSync(file, { force: true });
  });

  // r312 regression: S3 can answer CompleteMultipartUpload with HTTP 200 and
  // an <Error> document (the status line goes out before the assembly
  // finishes). That must reject — otherwise backupRemote records a remoteKey
  // for an object that does not exist — and the upload must be aborted.
  it('s3PutFile rejects and aborts when complete returns 200 with an <Error> body (r312)', async () => {
    const initiate = { ok: true, status: 200, text: async () => '<UploadId>up-z</UploadId>', headers: new Headers() };
    const part = { ok: true, status: 200, text: async () => '', headers: new Headers({ etag: '"e1"' }) };
    const done = {
      ok: true,
      status: 200,
      text: async () =>
        '<?xml version="1.0" encoding="UTF-8"?>\n\n<Error><Code>InternalError</Code><Message>We encountered an internal error. Please try again.</Message></Error>',
      headers: new Headers(),
    };
    const abort = { ok: true, status: 204, text: async () => '', headers: new Headers() };
    fetchMock
      .mockResolvedValueOnce(initiate)
      .mockResolvedValueOnce(part)
      .mockResolvedValueOnce(part)
      .mockResolvedValueOnce(part)
      .mockResolvedValueOnce(done)
      .mockResolvedValueOnce(abort);
    vi.stubGlobal('fetch', fetchMock);
    const file = path.join(tmpdir(), `s3-done200-${Date.now()}`);
    writeFileSync(file, Buffer.from('aaabbbcccddd'));
    await expect(s3PutFile(CFG, 'k/big', file, { partSize: 4, threshold: 10 })).rejects.toThrow(/S3 multipart complete failed \(200[\s\S]*InternalError/);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const [abortUrl, abortInit] = fetchMock.mock.calls[5] as [URL, RequestInit];
    expect(abortInit.method).toBe('DELETE');
    expect((abortUrl as URL).search).toBe('?uploadId=up-z');
    rmSync(file, { force: true });
  });

  it('s3GetToFile pipes the response body to disk without buffering', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('streamed-'));
          controller.enqueue(new TextEncoder().encode('bytes'));
          controller.close();
        },
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const target = path.join(tmpdir(), `s3-get-${Date.now()}`);
    await s3GetToFile(CFG, 'k', target);
    expect(readFileSync(target, 'utf8')).toBe('streamed-bytes');
    rmSync(target, { force: true });
  });

  it('r188: a slow download that keeps making progress is not cut off', async () => {
    let n = 0;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        async pull(controller) {
          await new Promise((r) => setTimeout(r, 30));
          if (n++ < 6) controller.enqueue(new TextEncoder().encode('x'));
          else controller.close();
        },
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const target = path.join(tmpdir(), `s3-slow-${Date.now()}`);
    // ~210 ms in total, well past the 80 ms stall limit — but never idle that long.
    await s3GetToFile(CFG, 'k', target, 80);
    expect(readFileSync(target, 'utf8')).toBe('xxxxxx');
    rmSync(target, { force: true });
  });

  it('r188: a download that stops sending bytes is aborted', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
          // …and then nothing, forever.
        },
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    await expect(s3GetToFile(CFG, 'k', path.join(tmpdir(), `s3-stall-${Date.now()}`), 60)).rejects.toThrow();
  });

  it('s3GetToFile throws on failure and handles an empty body', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    await expect(s3GetToFile(CFG, 'missing', path.join(tmpdir(), 'x'))).rejects.toThrow('S3 download failed (404)');

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, body: null } as unknown as Response);
    const target = path.join(tmpdir(), `s3-empty-${Date.now()}`);
    await s3GetToFile(CFG, 'k', target);
    expect(readFileSync(target, 'utf8')).toBe('');
    rmSync(target, { force: true });
  });
});
