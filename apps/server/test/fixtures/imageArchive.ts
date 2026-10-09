/**
 * A minimal tar writer for the multi-node image-archive tests: the shapes
 * `docker save` writes (ustar regular files and directories), plus the
 * records a crafted archive would use to read differently to Docker (pax,
 * GNU long names, links, `..` names). Never used outside tests.
 */

export interface TarEntry {
  name: string;
  data?: Buffer | string;
  /** Tar type flag: '0' file (default), '5' directory, '2' symlink, '1' hard link, 'x' pax, 'L' GNU long name. */
  type?: string;
  linkname?: string;
  /** Write this size into the header instead of the data's length. */
  sizeOverride?: number;
  /** Corrupt the header checksum. */
  badChecksum?: boolean;
}

function header(e: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(e.name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  h.write(`${(e.sizeOverride ?? size).toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write('00000000000\0', 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(e.type ?? '0', 156, 'latin1');
  if (e.linkname) h.write(e.linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  if (e.badChecksum) sum += 1;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

/** The tar bytes of `entries`, terminated by two zero blocks. */
export function tarArchive(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    parts.push(header(e, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** One pax record (`<len> key=value\n`, the length counting itself). */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (`${len}${body}`.length !== len) len += 1;
  return `${len}${body}`;
}

export const IMAGE_HEX = 'a'.repeat(64);
export const IMAGE_ID = `sha256:${IMAGE_HEX}`;
export const EXPECT_TAG = 'ninedeploy/web:abc1234-b7';

/** What a classic `docker save <id>` writes: one image, no tags. */
export function dockerSaveArchive(over: { repoTags?: unknown; config?: string; extra?: TarEntry[]; manifest?: unknown } = {}): Buffer {
  const manifest = over.manifest ?? [{ Config: over.config ?? `${IMAGE_HEX}.json`, RepoTags: over.repoTags ?? null, Layers: ['l1/layer.tar'] }];
  return tarArchive([
    { name: 'l1/', type: '5' },
    { name: 'l1/layer.tar', data: Buffer.alloc(700, 1) },
    { name: `${IMAGE_HEX}.json`, data: '{"architecture":"amd64"}' },
    { name: 'manifest.json', data: JSON.stringify(manifest) },
    ...(over.extra ?? []),
  ]);
}

/** What `docker save` writes with the containerd image store: an OCI layout plus manifest.json. */
export function ociSaveArchive(annotations: Record<string, string> = {}): Buffer {
  return tarArchive([
    { name: 'blobs/', type: '5' },
    { name: 'blobs/sha256/', type: '5' },
    { name: `blobs/sha256/${IMAGE_HEX}`, data: '{}' },
    { name: 'oci-layout', data: '{"imageLayoutVersion":"1.0.0"}' },
    { name: 'index.json', data: JSON.stringify({ schemaVersion: 2, manifests: [{ digest: `sha256:${'c'.repeat(64)}`, annotations }] }) },
    { name: 'manifest.json', data: JSON.stringify([{ Config: `blobs/sha256/${IMAGE_HEX}`, RepoTags: [EXPECT_TAG], Layers: [] }]) },
  ]);
}
