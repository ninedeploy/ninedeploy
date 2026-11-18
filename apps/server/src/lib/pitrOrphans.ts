/** Bounded discovery of abandoned managed objects. Discovery only stages intents; it never deletes. */
import { z } from 'zod';
import { s3Request, type S3Config } from './s3.js';
import { parseXml, type XmlElement } from './xml.js';
import { generationObjects, STREAM_DELETE_GRACE_MS, type StreamCatalog } from './pitrStreamCatalog.js';

export const PITR_ORPHAN_MIN_AGE_MS = 24 * 60 * 60_000;
export const PITR_ORPHAN_PAGE_SIZE = 200;
const MAX_LIST_BYTES = 1024 * 1024;
const uuid = z.string().uuid();
export interface PitrObjectPage {
  objects: Array<{ key: string; lastModified: string }>;
  cursor: string | null;
}
const invalid = () => new Error('Invalid or unsupported remote archive object listing');
function field(node: XmlElement, name: string, optional = false): string | undefined {
  const found = node.children.filter(c => c.name === name);
  if (!found.length && optional) return undefined;
  if (found.length !== 1 || found[0]!.children.length) throw invalid();
  return found[0]!.text;
}
function token(value: string): string {
  if (!value || value.length > 8192 || /[\r\n]/.test(value)) throw invalid();
  return value;
}

/** One signed ListObjectsV2 page, URL-encoded keys and a bounded, complete XML response. */
export async function listPitrObjects(cfg: S3Config, root: string, cursor?: string): Promise<PitrObjectPage> {
  const query = new URLSearchParams({ 'list-type': '2', prefix: root, 'encoding-type': 'url', 'max-keys': String(PITR_ORPHAN_PAGE_SIZE) });
  if (cursor !== undefined) query.set('continuation-token', token(cursor));
  const response = await s3Request(cfg, 'GET', '', undefined, undefined, query);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Remote archive listing failed (${response.status})`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > MAX_LIST_BYTES) {
        await reader.cancel();
        throw invalid();
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const xml = new TextDecoder('utf-8', { fatal: true })
    .decode(Buffer.concat(chunks))
    .replace(/^\s*<\?xml[^>]*\?>/, '')
    .trim();
  if (!/^<ListBucketResult(?:\s|>)/.test(xml) || !xml.endsWith('</ListBucketResult>') || /<!|&(?!(?:amp|lt|gt|quot|apos);)/.test(xml))
    throw invalid();
  const document = parseXml(xml);
  if (
    document.name !== 'ListBucketResult' ||
    document.text.trim() ||
    document.children.some(
      c =>
        ![
          'Name',
          'Prefix',
          'KeyCount',
          'MaxKeys',
          'EncodingType',
          'IsTruncated',
          'ContinuationToken',
          'NextContinuationToken',
          'Contents',
        ].includes(c.name),
    )
  )
    throw invalid();
  if (
    field(document, 'Name') !== cfg.bucket ||
    field(document, 'EncodingType') !== 'url' ||
    decodeURIComponent(field(document, 'Prefix')!) !== root ||
    field(document, 'MaxKeys') !== String(PITR_ORPHAN_PAGE_SIZE)
  )
    throw invalid();
  if (field(document, 'ContinuationToken', true) !== cursor) throw invalid();
  const entries = document.children.filter(c => c.name === 'Contents');
  if (entries.length > PITR_ORPHAN_PAGE_SIZE || field(document, 'KeyCount') !== String(entries.length)) throw invalid();
  const objects = entries.map(c => {
    const key = decodeURIComponent(field(c, 'Key')!);
    const lastModified = z.string().datetime({ offset: true }).parse(field(c, 'LastModified'));
    return { key, lastModified };
  });
  if (new Set(objects.map(o => o.key)).size !== objects.length) throw invalid();
  const truncated = field(document, 'IsTruncated');
  const next = field(document, 'NextContinuationToken', true);
  if ((truncated !== 'true' && truncated !== 'false') || (truncated === 'false' && next !== undefined)) throw invalid();
  const nextCursor = truncated === 'true' ? token(next ?? '') : null;
  if (nextCursor !== null && nextCursor === cursor) throw invalid();
  return { objects, cursor: nextCursor };
}

/** Only the immutable layout owned by this archive UUID; head, probes and foreign files never qualify. */
function managedKind(key: string, root: string): 'data' | 'catalog' | null {
  if (!key.startsWith(root)) return null;
  const suffix = key.slice(root.length);
  const catalog = /^catalog\/([a-f0-9-]{36})\.ndcat$/.exec(suffix);
  if (catalog && uuid.safeParse(catalog[1]).success) return 'catalog';
  const data = /^g\/([a-f0-9-]{36})\/(?:anchor-([a-f0-9-]{36})\.ndpc|wal\/[0-9A-F]{24}-([a-f0-9-]{36})\.ndwal)$/.exec(suffix);
  return data && uuid.safeParse(data[1]).success && uuid.safeParse(data[2] ?? data[3]).success ? 'data' : null;
}

/** The caller must CAS-publish this catalog before any of these new intents can be consumed. */
export function stagePitrOrphans(c: StreamCatalog, root: string, currentCatalogKey: string, page: PitrObjectPage, now: Date): number {
  const protectedKeys = new Set([
    `${root}head.ndpi`,
    currentCatalogKey,
    `${root}catalog/${c.revision}.ndcat`,
    ...c.generations.flatMap(g => generationObjects(g).map(o => o.key)),
    ...c.garbage.map(o => o.key),
  ]);
  let found = 0;
  for (const object of page.objects) {
    const kind = managedKind(object.key, root);
    const modified = Date.parse(object.lastModified);
    if (
      !kind ||
      protectedKeys.has(object.key) ||
      !Number.isFinite(modified) ||
      modified > now.getTime() - PITR_ORPHAN_MIN_AGE_MS ||
      c.garbage.length >= 200_000
    )
      continue;
    c.garbage.push({ key: object.key, kind, notBefore: new Date(now.getTime() + STREAM_DELETE_GRACE_MS).toISOString() });
    protectedKeys.add(object.key);
    found++;
  }
  return found;
}
