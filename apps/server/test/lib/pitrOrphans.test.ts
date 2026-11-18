import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listPitrObjects, PITR_ORPHAN_MIN_AGE_MS, stagePitrOrphans } from '../../src/lib/pitrOrphans.js';
import { STREAM_DELETE_GRACE_MS, type StreamCatalog } from '../../src/lib/pitrStreamCatalog.js';

const cfg = { endpoint: 'https://store.test', bucket: 'archive', region: 'eu', accessKeyId: 'fixture', secretAccessKey: 'fixture' };
const root = `nine/pitr-streams/${randomUUID()}/`;
const now = new Date('2026-11-17T09:00:00Z');
const old = new Date(now.getTime() - PITR_ORPHAN_MIN_AGE_MS).toISOString();
const key = () => `${root}g/${randomUUID()}/anchor-${randomUUID()}.ndpc`;
const entry = (name = key(), modified = old) =>
  `<Contents><Key>${encodeURIComponent(name)}</Key><LastModified>${modified}</LastModified><Size>1</Size></Contents>`;
const xml = (entries = '', extra = '', count = (entries.match(/<Contents>/g) ?? []).length) =>
  `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>archive</Name><Prefix>${encodeURIComponent(root)}</Prefix><EncodingType>url</EncodingType><KeyCount>${count}</KeyCount><MaxKeys>200</MaxKeys><IsTruncated>false</IsTruncated>${entries}${extra}</ListBucketResult>`;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(xml()));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('bounded PITR object inventory', () => {
  it('signs an exact-prefix URL-encoded page and preserves opaque continuation tokens', async () => {
    const name = key();
    fetchMock.mockResolvedValueOnce(
      new Response(
        xml(entry(name)).replace(
          '<IsTruncated>false</IsTruncated>',
          '<IsTruncated>true</IsTruncated><NextContinuationToken>a&amp;b+/%2F</NextContinuationToken>',
        ),
      ),
    );
    expect(await listPitrObjects(cfg, root)).toEqual({ objects: [{ key: name, lastModified: old }], cursor: 'a&b+/%2F' });
    fetchMock.mockResolvedValueOnce(new Response(xml('', '<ContinuationToken>a&amp;b+/%2F</ContinuationToken>')));
    expect(await listPitrObjects(cfg, root, 'a&b+/%2F')).toEqual({ objects: [], cursor: null });
    const [url, opts] = fetchMock.mock.calls[1]!;
    expect(new URL(url).searchParams.get('continuation-token')).toBe('a&b+/%2F');
    expect(new URL(url).searchParams.get('max-keys')).toBe('200');
    expect(new URL(url).searchParams.get('prefix')).toBe(root);
    expect(opts.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  });
  it.each([
    'malformed XML',
    'foreign bucket',
    'foreign prefix',
    'missing encoding',
    'duplicate fields',
    'wrong count',
    'overfull page',
    'missing token',
    'unexpected token',
    'repeated token',
    'bad date',
    'bad percent',
    'doctype',
    'invalid entity',
    'nested key',
  ])('refuses %s before returning candidate objects', async fault => {
    let body = xml(entry()),
      cursor: string | undefined;
    if (fault === 'malformed XML') body = body.slice(0, -8);
    if (fault === 'foreign bucket') body = body.replace('<Name>archive', '<Name>other');
    if (fault === 'foreign prefix') body = body.replace(encodeURIComponent(root), 'another%2F');
    if (fault === 'missing encoding') body = body.replace('<EncodingType>url</EncodingType>', '');
    if (fault === 'duplicate fields') body = body.replace('</Name>', '</Name><Name>archive</Name>');
    if (fault === 'wrong count') body = body.replace('<KeyCount>1', '<KeyCount>0');
    if (fault === 'overfull page') body = xml(Array.from({ length: 201 }, () => entry()).join(''));
    if (fault === 'missing token') body = body.replace('<IsTruncated>false', '<IsTruncated>true');
    if (fault === 'unexpected token') body = xml(entry(), '<NextContinuationToken>extra</NextContinuationToken>');
    if (fault === 'repeated token') {
      cursor = 'same';
      body = xml(entry(), '<ContinuationToken>same</ContinuationToken><NextContinuationToken>same</NextContinuationToken>').replace(
        '<IsTruncated>false',
        '<IsTruncated>true',
      );
    }
    if (fault === 'bad date') body = xml(entry(key(), 'yesterday'));
    if (fault === 'bad percent') body = body.replace(/<Key>[^<]+/, '<Key>%ZZ');
    if (fault === 'doctype') body = body.replace('<ListBucketResult', '<!DOCTYPE x><ListBucketResult');
    if (fault === 'invalid entity') body = body.replace('<Name>archive', '<Name>&entity;');
    if (fault === 'nested key') body = body.replace('<Key>', '<Key><Nested/>');
    fetchMock.mockResolvedValue(new Response(body));
    await expect(listPitrObjects(cfg, root, cursor)).rejects.toThrow();
  });
  it('rejects duplicate keys instead of repeatedly staging them', async () => {
    const value = entry();
    fetchMock.mockResolvedValue(new Response(xml(value + value)));
    await expect(listPitrObjects(cfg, root)).rejects.toThrow();
  });
  it('cancels an oversized body and propagates a mid-response failure', async () => {
    let cancelled = false;
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    await expect(listPitrObjects(cfg, root)).rejects.toThrow();
    expect(cancelled).toBe(true);
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('connection lost'));
          },
        }),
      ),
    );
    await expect(listPitrObjects(cfg, root)).rejects.toThrow('connection lost');
  });
  it('holds on permission failures and invalid cursors without listing another namespace', async () => {
    fetchMock.mockResolvedValue(new Response('denied', { status: 403 }));
    await expect(listPitrObjects(cfg, root)).rejects.toThrow('403');
    await expect(listPitrObjects(cfg, root, '\r\n')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('orphan retirement planning', () => {
  it('protects live data, the current catalog, existing grace, fresh objects and foreign layout', () => {
    const live = key(),
      current = `${root}catalog/${randomUUID()}.ndcat`,
      queued = key(),
      orphan = key(),
      catalogKey = `${root}catalog/${randomUUID()}.ndcat`;
    const c = {
      revision: randomUUID(),
      generations: [{ anchor: { key: live }, wal: [] }],
      garbage: [{ key: queued, kind: 'data', notBefore: '2026-11-18T00:00:00Z' }],
    } as StreamCatalog;
    const all = [
      live,
      current,
      queued,
      orphan,
      catalogKey,
      `${root}head.ndpi`,
      `${root}probe/${randomUUID()}`,
      `${root}notes.txt`,
      `${root}catalog/${'-'.repeat(36)}.ndcat`,
      `other/${orphan}`,
      key(),
    ];
    const objects = all.map((name, i) => ({ key: name, lastModified: i === all.length - 1 ? now.toISOString() : old }));
    expect(stagePitrOrphans(c, root, current, { objects, cursor: null }, now)).toBe(2);
    expect(c.garbage).toEqual([
      { key: queued, kind: 'data', notBefore: '2026-11-18T00:00:00Z' },
      ...[orphan, catalogKey].map((name, i) => ({
        key: name,
        kind: i ? 'catalog' : 'data',
        notBefore: new Date(now.getTime() + STREAM_DELETE_GRACE_MS).toISOString(),
      })),
    ]);
  });
  it('does not classify an invalid modification time as an old abandoned object', () => {
    const c = { revision: randomUUID(), generations: [], garbage: [] } as unknown as StreamCatalog;
    expect(
      stagePitrOrphans(
        c,
        root,
        `${root}catalog/${randomUUID()}.ndcat`,
        { objects: [{ key: key(), lastModified: 'invalid' }], cursor: null },
        now,
      ),
    ).toBe(0);
    expect(c.garbage).toEqual([]);
  });
});
