import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchImageDigest } from '../../src/lib/imageWatch.js';
const limit = 4 * 1024 * 1024;
const digest = (bytes: Uint8Array | string, algorithm = 'sha256') => `${algorithm}:${createHash(algorithm).update(bytes).digest('hex')}`;
const probe = () => fetchImageDigest('example.test', 'acme/web', 'latest', undefined, { allowPrivateEgress: true });
afterEach(() => vi.unstubAllGlobals());
function fixture(chunks: Uint8Array[], declared: string, headers: Record<string, string> = {}, fault?: Error, cancelFails = false) {
  let cancellations = 0;
  let position = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[position++];
      if (chunk) controller.enqueue(chunk);
      else if (fault) controller.error(fault);
      else controller.close();
    },
    cancel() { cancellations++; if (cancelFails) throw new Error('cleanup failed'); },
  }, { highWaterMark: 0 });
  const response = new Response(stream, { headers: { 'docker-content-digest': declared, ...headers } });
  vi.stubGlobal('fetch', vi.fn(async () => response));
  return { stream, cancellations: () => cancellations };
}
for (const algorithm of ['sha256', 'sha512']) it(`verifies ${algorithm} across binary chunk boundaries`, async () => {
  const bytes = new Uint8Array([0, 255, 195, 169, 10, 13]);
  const f = fixture([bytes.slice(0, 3), bytes.slice(3)], digest(bytes, algorithm));
  expect(await probe()).toBe(digest(bytes, algorithm));
  expect(f.stream.locked).toBe(false); expect(f.cancellations()).toBe(0);
});
it('rejects a validly encoded SHA256 for different bytes and releases its reader', async () => {
  const f = fixture([new TextEncoder().encode('actual')], digest('other'));
  await expect(probe()).rejects.toThrow('body does not match'); expect(f.stream.locked).toBe(false);
});
it('rejects a validly encoded SHA512 for different bytes', async () => {
  fixture([new TextEncoder().encode('actual')], digest('other', 'sha512'));
  await expect(probe()).rejects.toThrow('body does not match');
});
it('accepts exactly the local byte cap without a content-length header', async () => {
  const bytes = new Uint8Array(limit); fixture([bytes], digest(bytes)); expect(await probe()).toBe(digest(bytes));
});
for (const claimed of [undefined, '1']) it(`bounds actual streamed bytes with declared length ${claimed}`, async () => {
  const bytes = new Uint8Array(limit);
  const f = fixture([bytes, new Uint8Array([0]), new Uint8Array([1])], digest(bytes), claimed ? { 'content-length': claimed } : {});
  await expect(probe()).rejects.toThrow('size limit'); expect(f.cancellations()).toBe(1); expect(f.stream.locked).toBe(false);
});
it('rejects oversized declared bodies before reading and cancels them', async () => {
  const f = fixture([], digest(''), { 'content-length': String(limit + 1) });
  await expect(probe()).rejects.toThrow('size limit'); expect(f.cancellations()).toBe(1); expect(f.stream.locked).toBe(false);
});
it('cleanup errors cannot mask an overflow rejection', async () => {
  const f = fixture([new Uint8Array(limit + 1)], digest(''), {}, undefined, true);
  await expect(probe()).rejects.toThrow('size limit'); expect(f.cancellations()).toBe(1); expect(f.stream.locked).toBe(false);
});
for (const fault of [new Error('fixture read failure'), new DOMException('fixture deadline', 'TimeoutError')]) it(`propagates body read failure ${fault.name} and releases the lock`, async () => {
  const f = fixture([new Uint8Array([1])], digest(''), {}, fault);
  await expect(probe()).rejects.toThrow(fault.message); expect(f.stream.locked).toBe(false);
});
it('preserves a fetch timeout signal for body consumption', async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return new Response('body', { headers: { 'docker-content-digest': digest('body') } });
  }));
  expect(await probe()).toBe(digest('body')); expect(signal).toBeInstanceOf(AbortSignal); expect(signal?.aborted).toBe(false);
});
it('does not accept a null body even when the declared digest hashes empty bytes', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'docker-content-digest': digest('') } })));
  await expect(probe()).rejects.toThrow('no manifest body');
});
it('reports an opaque algorithm as unsupported and cancels its unread body', async () => {
  const f = fixture([new Uint8Array([1])], 'future.hash:ABC123');
  await expect(probe()).rejects.toThrow('algorithm is unsupported'); expect(f.cancellations()).toBe(1);
});
it('native fetch aborts an incomplete manifest body when the probe deadline fires', async () => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const nativeFetch = globalThis.fetch;
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'docker-content-digest': digest('complete body') });
    response.write('incomplete');
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const response = await nativeFetch(`http://127.0.0.1:${address.port}/manifest`, init);
      deadline.abort(new DOMException('fixture deadline', 'TimeoutError'));
      return response;
    }));
    await expect(probe()).rejects.toThrow();
    expect(timeout).toHaveBeenCalledWith(10_000);
  } finally {
    timeout.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
