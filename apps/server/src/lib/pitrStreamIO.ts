import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decryptPanelBackupFile, encryptPanelBackupFile } from './panelBackup.js';
import { s3Delete, s3GetToFile, s3PutFile, s3Request, type S3Config } from './s3.js';
import { hashCheckpointFile } from '../engine/pitrCheckpoint.js';
import { PitrRefusal } from '../engine/postgresPitr.js';
import { listPitrObjects } from './pitrOrphans.js';
import { STREAM_METADATA_MAX_BYTES, streamHead, validateStreamCatalog, type StreamCatalog, type StreamObject } from './pitrStreamCatalog.js';

function requiredEtag(value: string | null): string {
  if (!value || value.length > 256 || /[\r\n]/.test(value)) throw new Error('Remote PITR requires S3 ETags and conditional PUT support');
  return value;
}

export function pitrStreamStorage(cfg: S3Config, root: string, archiveId: string, passphrase: string, directory: string) {
  const endpoint = new URL(cfg.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(cfg.bucket)) throw new Error('Unsafe continuous archive destination');
  const file = () => path.join(directory, randomUUID());
  const download = async (key: string, output: string, maximum: number) => {
    let etag: string | null = null;
    await s3GetToFile(cfg, key, output, undefined, { maxBytes: maximum, onResponse: (r) => { etag = r.headers.get('etag'); } });
    return requiredEtag(etag);
  };
  const getObject = async (ref: StreamObject, output: string) => {
    await download(ref.key, output, ref.bytes);
    if ((await stat(output)).size !== ref.bytes || await hashCheckpointFile(output) !== ref.sha256) throw new Error('Remote PITR object integrity failed');
  };
  const upload = async (plain: string, key: string): Promise<StreamObject> => {
    const sealed = file(), checked = file();
    await encryptPanelBackupFile(plain, sealed, passphrase);
    const sha256 = await hashCheckpointFile(sealed), bytes = (await stat(sealed)).size;
    await s3PutFile(cfg, key, sealed);
    const etag = await download(key, checked, bytes);
    if ((await stat(checked)).size !== bytes || await hashCheckpointFile(checked) !== sha256) throw new Error('Remote PITR read-back differs');
    return { key, bytes, sha256, etag };
  };
  const metadata = async (value: unknown, key: string) => {
    const plain = file();
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > STREAM_METADATA_MAX_BYTES - 512) throw new Error('Remote PITR catalog is too large');
    await writeFile(plain, text, { mode: 0o600, flag: 'wx' });
    return upload(plain, key);
  };
  const readCatalog = async (key: string, expected?: StreamObject): Promise<StreamCatalog> => {
    if (!key.startsWith(`${root}catalog/`) || !/^[a-f0-9-]{36}\.ndcat$/.test(key.slice(`${root}catalog/`.length))) throw new Error('Remote catalog is outside its namespace');
    const sealed = file(), plain = file();
    if (expected) {
      if (expected.bytes > STREAM_METADATA_MAX_BYTES) throw new Error('Remote catalog exceeds its size limit');
      await getObject(expected, sealed);
    } else await download(key, sealed, STREAM_METADATA_MAX_BYTES);
    await decryptPanelBackupFile(sealed, plain, passphrase);
    if ((await stat(plain)).size > STREAM_METADATA_MAX_BYTES) throw new Error('Remote catalog exceeds its size limit');
    const c = validateStreamCatalog(JSON.parse(await readFile(plain, 'utf8')), root, archiveId);
    if (`${root}catalog/${c.revision}.ndcat` !== key) throw new Error('Remote catalog identity does not match its key');
    return c;
  };
  const load = async () => {
    const key = `${root}head.ndpi`;
    const probe = await s3Request(cfg, 'HEAD', key);
    if (probe.status === 404) return null;
    if (!probe.ok) throw new Error(`Remote PITR index probe failed (${probe.status})`);
    const sealed = file(), plain = file();
    const etag = await download(key, sealed, 1024 * 1024);
    await decryptPanelBackupFile(sealed, plain, passphrase);
    const head = streamHead.parse(JSON.parse(await readFile(plain, 'utf8')));
    if (head.archiveId !== archiveId) throw new Error('Remote index belongs to another archive');
    const catalog = await readCatalog(head.catalog.key, head.catalog);
    if (catalog.sequence !== head.sequence) throw new Error('Remote index sequence does not match');
    return { etag, catalog, catalogRef: head.catalog };
  };
  const publish = async (catalog: StreamCatalog, previousEtag: string | null) => {
    validateStreamCatalog(catalog, root, archiveId);
    const ref = await metadata(catalog, `${root}catalog/${catalog.revision}.ndcat`);
    const head = { format: 'NDPITR-HEAD1', archiveId, sequence: catalog.sequence, catalog: ref };
    const plain = file(), sealed = file();
    await writeFile(plain, JSON.stringify(head), { mode: 0o600, flag: 'wx' });
    await encryptPanelBackupFile(plain, sealed, passphrase);
    const res = await s3Request(cfg, 'PUT', `${root}head.ndpi`, await readFile(sealed), undefined, undefined, undefined,
      previousEtag === null ? { ifNoneMatch: '*' } : { ifMatch: previousEtag });
    if (res.status === 412 || res.status === 409) throw new PitrRefusal('The remote archive index changed during this pass; retry from its newer state.');
    if (!res.ok) throw new Error(`Remote index publication failed (${res.status})`);
    const etag = requiredEtag(res.headers.get('etag'));
    const checked = file();
    if (await download(`${root}head.ndpi`, checked, 1024 * 1024) !== etag || await hashCheckpointFile(checked) !== await hashCheckpointFile(sealed)) throw new Error('Remote index read-back changed before confirmation');
    return { etag, catalogRef: ref, headSha256: await hashCheckpointFile(sealed), headBytes: (await stat(sealed)).size };
  };
  const verifyReference = async (ref: StreamObject) => {
    const res = await s3Request(cfg, 'HEAD', ref.key);
    if (!res.ok || res.headers.get('etag') !== ref.etag || Number(res.headers.get('content-length')) !== ref.bytes) throw new PitrRefusal('A retained remote recovery object is missing or has changed; remote deletion is held.');
  };
  const assertConditionalWrites = async () => {
    // Test only a private nonce key: a provider that ignores conditions must never be probed against HEAD itself.
    const key = `${root}probe/${randomUUID()}`, body = randomUUID();
    let created = false;
    try {
      const first = await s3Request(cfg, 'PUT', key, body, undefined, undefined, undefined, { ifNoneMatch: '*' });
      if (!first.ok) throw new Error('The destination refused a conditional archive probe');
      created = true;
      const tag = requiredEtag(first.headers.get('etag'));
      const duplicate = await s3Request(cfg, 'PUT', key, body, undefined, undefined, undefined, { ifNoneMatch: '*' });
      const stale = await s3Request(cfg, 'PUT', key, body, undefined, undefined, undefined, { ifMatch: `"absent-${randomUUID()}"` });
      if (duplicate.status !== 412 || stale.status !== 412) throw new PitrRefusal('The destination does not enforce conditional S3 writes; publication and retention are held.');
      const valid = await s3Request(cfg, 'PUT', key, body, undefined, undefined, undefined, { ifMatch: tag });
      if (!valid.ok) throw new Error('The destination refused a matching conditional archive probe');
    } finally { if (created) await s3Delete(cfg, key); }
  };
  return { upload, getObject, load, readCatalog, publish, verifyReference, assertConditionalWrites, listPage: (cursor?: string) => listPitrObjects(cfg, root, cursor), remove: (key: string) => s3Delete(cfg, key), open: (input: string, output: string) => decryptPanelBackupFile(input, output, passphrase) };
}
export type PitrStreamStorage = ReturnType<typeof pitrStreamStorage>;
