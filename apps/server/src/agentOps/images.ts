import { closeSync, mkdirSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { AGENT_LONG_OP_TIMEOUT_MS, agentChildTimeoutMs } from '../lib/agentClient.js';
import { spawnValidated, spawnValidatedStream } from '../lib/spawnValidated.js';
import type { AgentOpModule } from './index.js';
import {
  intOperand,
  isRegistryQualified,
  isReservedImage,
  type Params,
  RE_IMAGE,
  RE_IMAGE_ID,
  RE_SERVICE_IMAGE_TAG,
  str,
  TRANSFER_DIR,
  validated,
} from './operands.js';
import type { PreparedStream, StreamKindHandler } from './stream.js';

/**
 * Image ops on a node (multi-node, capability `image.manage`, design §1.1,
 * §6.4), and the two image stream kinds. Plain ops, not sealed-only: none
 * carries a secret (a push authenticates through the existing `docker.login`).
 *
 * Writing a tag is the dangerous part: a tag named like the node's proxy
 * (`traefik:v3.1`), the helper sidecar or the NineDeploy image would replace
 * what the node's infrastructure runs on its next start. Every op that writes
 * a tag refuses those ({@link isReservedImage}); `image.load` additionally
 * reads the archive's own tag records before `docker load` ever sees it.
 */

const MAX_IMAGE_REF = 255;
const imageRef = (value: string | undefined, what: string): string => {
  const ref = validated(value, RE_IMAGE, what);
  if (ref.length > MAX_IMAGE_REF) throw new Error(`Invalid ${what}`);
  return ref;
};

/** A tag the node may write: a service tag (`ninedeploy/<slug>:<tag>`) or a registry-qualified one, never infrastructure. */
function writableTag(value: string | undefined, what: string): string {
  const ref = imageRef(value, what);
  if (ref.includes('@') || !/:[A-Za-z0-9_.-]+$/.test(ref.split('/').pop() as string)) throw new Error(`Invalid ${what}: name a tag`);
  if (!RE_SERVICE_IMAGE_TAG.test(ref) && !isRegistryQualified(ref)) {
    throw new Error(`Invalid ${what}: only ninedeploy/<slug>:<tag> or a registry-qualified tag can be written`);
  }
  if (isReservedImage(ref)) throw new Error(`Refusing ${what} ${ref}: that name belongs to the node's own infrastructure`);
  return ref;
}

/** `docker image inspect --format '{{.Id}}|{{.Size}}'`: the existence probe (callers read the exit code). */
async function imageInspectOp(params: Params, onLine: (line: string) => void): Promise<number> {
  const image = imageRef(str(params, 'image'), 'image');
  return spawnValidated('docker', ['image', 'inspect', '--format', '{{.Id}}|{{.Size}}', image], onLine);
}

/** `docker image rm <tag>` (never `-f`: an image a container uses stays). Build-host retention (design §6.3). */
async function imageRmOp(params: Params, onLine: (line: string) => void): Promise<number> {
  const image = writableTag(str(params, 'image'), 'image');
  return spawnValidated('docker', ['image', 'rm', image], onLine);
}

/** `docker tag <source> <target>`: the target must be writable (see {@link writableTag}). */
async function tagOp(params: Params, onLine: (line: string) => void): Promise<number> {
  const source = imageRef(str(params, 'source'), 'source image');
  const target = writableTag(str(params, 'target'), 'target tag');
  return spawnValidated('docker', ['tag', source, target], onLine);
}

/** `docker push <registry>/<repo>:<tag>` with the build budget (a LONG_AGENT_OPS member). */
async function pushOp(params: Params, onLine: (line: string) => void): Promise<number> {
  const image = writableTag(str(params, 'image'), 'image');
  if (!isRegistryQualified(image)) throw new Error('Invalid image: a push needs a registry-qualified tag');
  return spawnValidated('docker', ['push', image], onLine, { timeoutMs: agentChildTimeoutMs('docker.push') as number });
}

export const imageOps: AgentOpModule = {
  name: 'agentOps/images.ts',
  caps: ['image.manage'],
  ops: {
    'docker.imageInspect': { cap: 'image.manage', sealedOnly: false, run: (p, onLine) => imageInspectOp(p, onLine) },
    'docker.imageRm': { cap: 'image.manage', sealedOnly: false, run: (p, onLine) => imageRmOp(p, onLine) },
    'docker.tag': { cap: 'image.manage', sealedOnly: false, run: (p, onLine) => tagOp(p, onLine) },
    'docker.push': { cap: 'image.manage', sealedOnly: false, run: (p, onLine) => pushOp(p, onLine) },
  },
};

// ── stream kinds ─────────────────────────────────────────────────────────────

/** The image's id, or null when it does not exist on this node. */
async function inspectImageId(image: string): Promise<string | null> {
  const lines: string[] = [];
  const code = await spawnValidated('docker', ['image', 'inspect', '--format', '{{.Id}}', image], (l) => lines.push(l));
  const id = lines.join('').trim();
  return code === 0 && RE_IMAGE_ID.test(id) ? id : null;
}

/**
 * `image.save {image}` (agent→panel): `docker save <imageId>` through gzip.
 * Saved BY ID, so the archive carries no tag at all (design §6.4); the end
 * frame's result names the id the receiver must end up with.
 */
export const imageSaveKind: StreamKindHandler = {
  keys: ['image'],
  async prepare(params) {
    const image = imageRef(str(params, 'image'), 'image');
    const imageId = await inspectImageId(image);
    if (!imageId) throw new Error(`Image ${image} does not exist on this node`);
    return {
      direction: 'agent-to-panel',
      async start() {
        const child = spawnValidatedStream('docker', ['save', imageId], { timeoutMs: AGENT_LONG_OP_TIMEOUT_MS });
        const gzip = createGzip();
        child.stdout.on('error', (err) => gzip.destroy(err));
        child.stdout.pipe(gzip);
        return {
          stream: gzip,
          done: child.exit.then(({ code, stderr }) => {
            if (code !== 0) throw new Error(`docker save exited with ${code}: ${stderr.trim().slice(-500)}`);
            return { imageId };
          }),
          abort: () => {
            child.kill();
            gzip.destroy();
          },
        };
      },
    } satisfies PreparedStream;
  },
};

/** Free space headroom kept on the node beyond the archive itself. */
const DISK_HEADROOM_BYTES = 256 * 1024 * 1024;

/** Free bytes on the filesystem holding `dir` (`df -kP`), or null when df did not answer. */
async function freeBytes(dir: string): Promise<number | null> {
  const lines: string[] = [];
  const code = await spawnValidated('df', ['-kP', dir], (l) => lines.push(l));
  // POSIX format: a header line (translated under some locales), then one line per fs.
  const fields = lines[1]?.trim().split(/\s+/);
  const available = Number(fields?.[3]);
  return code === 0 && Number.isFinite(available) ? available * 1024 : null;
}

/**
 * `image.load {expectTag, expectId, sizeBytes?}` (panel→agent): the verified
 * archive is inspected ({@link inspectImageArchive}), loaded, checked to have
 * produced `expectId`, and tagged `expectTag` by the node itself. An image the
 * load produced under another id is removed again.
 */
export const imageLoadKind: StreamKindHandler = {
  keys: ['expectTag', 'expectId', 'sizeBytes'],
  async prepare(params, { maxBytes }) {
    const expectTag = validated(str(params, 'expectTag'), RE_SERVICE_IMAGE_TAG, 'expected tag');
    if (expectTag.length > MAX_IMAGE_REF) throw new Error('Invalid expected tag');
    if (isReservedImage(expectTag)) throw new Error(`Refusing expected tag ${expectTag}: that name belongs to the node's own infrastructure`);
    const expectId = validated(str(params, 'expectId'), RE_IMAGE_ID, 'expected image id');
    const sizeBytes = params['sizeBytes'] === undefined ? 0 : intOperand(params['sizeBytes'], 1, maxBytes, 'sizeBytes');
    const dir = path.resolve(process.cwd(), TRANSFER_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const free = await freeBytes(dir);
    if (free !== null && free < sizeBytes + DISK_HEADROOM_BYTES) {
      throw new Error(`Not enough free disk space on the node for this image (${free} bytes free, ${sizeBytes + DISK_HEADROOM_BYTES} needed)`);
    }
    return {
      direction: 'panel-to-agent',
      gunzip: true,
      async apply(file) {
        // 1. The strict pre-check: the archive's own records, before Docker sees it.
        inspectImageArchive(file, { expectTag, expectId });
        // 2. The post-load check (cannot be parsed around): what Docker itself
        //    tagged, and every infrastructure tag before vs after the load.
        const before = await imageTagSnapshot();
        const loadLines: string[] = [];
        const load = await spawnValidated('docker', ['load', '-i', file], (l) => loadLines.push(l), { timeoutMs: AGENT_LONG_OP_TIMEOUT_MS });
        await assertNoTagSmuggled({ before, after: await imageTagSnapshot(), loadLines, expectTag });
        if (load !== 0) throw new Error(`docker load exited with ${load}: ${loadLines.join(' ').slice(-500)}`);
        if ((await inspectImageId(expectId)) !== expectId) {
          // The archive's records said expectId; what Docker made of it did not. Undo it.
          const loaded = loadLines.map((l) => /Loaded image(?: ID)?: (\S+)/.exec(l)?.[1]).filter((v): v is string => v !== undefined);
          for (const ref of loaded) {
            if (RE_IMAGE_ID.test(ref) || ref === expectTag) await spawnValidated('docker', ['image', 'rm', ref], () => undefined);
          }
          throw new Error(`The loaded image's id does not match ${expectId}; it was removed`);
        }
        const tagLines: string[] = [];
        const tag = await spawnValidated('docker', ['tag', expectId, expectTag], (l) => tagLines.push(l));
        if (tag !== 0) throw new Error(`docker tag exited with ${tag}: ${tagLines.join(' ').slice(-500)}`);
        return { imageId: expectId, tag: expectTag };
      },
    } satisfies PreparedStream;
  },
};

// ── the tag-smuggling check (design §6.4) ────────────────────────────────────

/** `ref` in Docker's familiar form (`docker.io/library/` and `docker.io/` dropped), for comparing tags. */
export function familiarRef(ref: string): string {
  return ref.replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '').replace(/^library\//, '');
}

/** Every tag on the node → its image id (`docker image ls`, a literal format string). Dangling images are skipped. */
export async function imageTagSnapshot(): Promise<Map<string, string>> {
  const tags = new Map<string, string>();
  const code = await spawnValidated('docker', ['image', 'ls', '--no-trunc', '--format', '{{.Repository}}:{{.Tag}}|{{.ID}}'], (line) => {
    const m = /^(\S+):([^\s:|]+)\|(sha256:[0-9a-f]{64})$/.exec(line.trim());
    if (m && m[1] !== '<none>' && m[2] !== '<none>') tags.set(familiarRef(`${m[1]}:${m[2]}`), m[3] as string);
  });
  if (code !== 0) throw new Error("Refusing to load the image: could not list the node's image tags to guard them");
  return tags;
}

/** Thrown when a load wrote a tag it must not: audit-worthy (the sending host may be compromised). */
export class TagSmugglingError extends Error {
  constructor(readonly tags: string[]) {
    super(
      `SECURITY: the image archive tagged ${tags.map((t) => `"${t}"`).join(', ')} on this node, outside the expected image. ` +
        'Each such tag was restored or removed and the transfer was refused; treat the sending host as compromised until it is checked.',
    );
    this.name = 'TagSmugglingError';
  }
}

/**
 * The post-load verification (design §6.4, defence in depth behind
 * {@link inspectImageArchive}): whatever a crafted archive made a parser
 * believe, Docker itself reports every tag it applied (`Loaded image: <ref>`),
 * and the node's infrastructure tags are compared before and after the load.
 *
 * - every tag the load reports must be exactly `expectTag`;
 * - every reserved tag (the proxy, the helper, NineDeploy's images, the
 *   host-shell image) must point where it pointed before.
 *
 * Each violation is undone — the previous id re-tagged where one existed,
 * otherwise the tag removed — and the load fails with {@link TagSmugglingError}.
 * Only tags the load itself reported, and reserved ones, are touched, so a
 * concurrent build on the node is never reverted.
 */
export async function assertNoTagSmuggled(input: {
  before: Map<string, string>;
  after: Map<string, string>;
  loadLines: string[];
  expectTag: string;
}): Promise<void> {
  const expected = familiarRef(input.expectTag);
  const suspect = new Set<string>();
  for (const line of input.loadLines) {
    const ref = /^Loaded image: (\S+)$/.exec(line.trim())?.[1];
    if (ref !== undefined && familiarRef(ref) !== expected) suspect.add(familiarRef(ref));
  }
  for (const [ref, id] of input.after) {
    if (ref !== expected && isReservedImage(ref) && input.before.get(ref) !== id) suspect.add(ref);
  }
  if (suspect.size === 0) return;
  for (const ref of [...suspect].sort()) {
    if (!RE_IMAGE.test(ref)) continue;
    const previous = input.before.get(ref);
    if (previous !== undefined) await spawnValidated('docker', ['tag', previous, ref], () => undefined);
    else await spawnValidated('docker', ['image', 'rm', ref], () => undefined);
  }
  throw new TagSmugglingError([...suspect].sort());
}

/** Largest metadata file read from an archive. */
const MAX_ARCHIVE_METADATA_BYTES = 1024 * 1024;
const METADATA_FILES = ['manifest.json', 'index.json', 'repositories'] as const;
type MetadataFile = (typeof METADATA_FILES)[number];

const refuse = (why: string): Error => new Error(`Refusing the image archive: ${why}`);

const cString = (buf: Buffer, from: number, to: number, enc: BufferEncoding = 'utf8'): string => {
  const text = buf.toString(enc, from, to);
  const nul = text.indexOf('\0');
  return nul === -1 ? text : text.slice(0, nul);
};

const parseOctal = (buf: Buffer): number => {
  const text = cString(buf, 0, buf.length, 'latin1').trim();
  if (!/^[0-7]*$/.test(text)) return Number.NaN;
  return text === '' ? 0 : Number.parseInt(text, 8);
};

/** pax keys that change what an entry IS (its name, size or link target): docker save never writes them. */
const REFUSED_PAX_KEYS = new Set(['path', 'linkpath', 'size']);

function assertPaxRecords(body: Buffer): void {
  let at = 0;
  while (at < body.length) {
    if (body[at] === 0) break;
    const space = body.indexOf(0x20, at);
    if (space === -1) throw refuse('a pax header is malformed');
    const len = Number.parseInt(body.toString('latin1', at, space), 10);
    if (!Number.isSafeInteger(len) || len <= space - at || at + len > body.length) throw refuse('a pax header is malformed');
    const record = body.toString('utf8', space + 1, at + len - 1);
    const key = record.slice(0, Math.max(0, record.indexOf('=')));
    if (REFUSED_PAX_KEYS.has(key) || key.startsWith('GNU.sparse')) throw refuse(`it uses a pax "${key}" record, which docker save never writes`);
    at += len;
  }
}

/** The entry's name, normalised with `path.posix.normalize`; refuses absolute names and `..` segments. */
function entryName(header: Buffer): string {
  const name = cString(header, 0, 100);
  const ustar = header.toString('latin1', 257, 262) === 'ustar';
  const prefix = ustar ? cString(header, 345, 500) : '';
  const raw = prefix ? `${prefix}/${name}` : name;
  if (raw === '' || raw.startsWith('/') || raw.includes('\\')) throw refuse(`it has an entry named "${raw}"`);
  if (raw.split('/').includes('..')) throw refuse(`the entry "${raw}" has a ".." segment`);
  return path.posix.normalize(raw).replace(/\/+$/, '').replace(/^(?:\.\/)+/, '');
}

/** The header checksum: the sum of the header's bytes with the checksum field read as spaces. */
function checksumOk(header: Buffer): boolean {
  const stored = parseOctal(header.subarray(148, 156));
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] as number);
  return stored === sum;
}

/**
 * Read the archive's metadata files, STRICTLY (design §6.4, security review).
 * A crafted archive must not read one way here and another way to Docker, so
 * anything `docker save` never writes is refused rather than interpreted:
 * absolute names, `..` segments, GNU long-name/long-link records (`L`/`K`),
 * pax `path`/`linkpath`/`size` records, global pax headers, hard links,
 * devices and FIFOs, a base-256 size, a bad header checksum, and a second
 * copy of a metadata file. Names are compared after `path.posix.normalize`.
 * Symbolic links are allowed (a legacy `docker save` links shared layers)
 * only when they stay inside the archive and are not a metadata name. File
 * data is skipped, never read, except the metadata files (≤ 1 MiB each).
 */
export function readArchiveMetadata(file: string): Partial<Record<MetadataFile, string>> {
  const fd = openSync(file, 'r');
  const out: Partial<Record<MetadataFile, string>> = {};
  try {
    const header = Buffer.alloc(512);
    let offset = 0;
    for (;;) {
      if (readSync(fd, header, 0, 512, offset) < 512) throw refuse('it ends inside a tar header');
      if (header.every((b) => b === 0)) break;
      if (!checksumOk(header)) throw refuse('a tar header checksum is wrong');
      if ((header[124] as number) & 0x80) throw refuse('it uses a base-256 size, which docker save never writes');
      const size = parseOctal(header.subarray(124, 136));
      if (!Number.isSafeInteger(size) || size < 0) throw refuse('a tar header is malformed');
      const type = String.fromCharCode(header[156] as number);
      const dataAt = offset + 512;
      const readBody = (): Buffer => {
        if (size > MAX_ARCHIVE_METADATA_BYTES) throw refuse('a metadata record is too large');
        const body = Buffer.alloc(size);
        if (readSync(fd, body, 0, size, dataAt) < size) throw refuse('it ends inside an entry');
        return body;
      };
      if (type === 'x') {
        assertPaxRecords(readBody());
      } else if (type === '0' || type === '\0' || type === '5' || type === '2') {
        const name = entryName(header);
        const isMetadata = (METADATA_FILES as readonly string[]).includes(name);
        if (type === '2') {
          const target = cString(header, 157, 257);
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
          if (isMetadata || target === '' || target.startsWith('/') || resolved === '..' || resolved.startsWith('../')) {
            throw refuse(`the link "${name}" points outside the archive or replaces a metadata file`);
          }
        } else if (isMetadata) {
          if (type === '5') throw refuse(`${name} is a directory`);
          if (out[name as MetadataFile] !== undefined) throw refuse(`it carries ${name} twice`);
          out[name as MetadataFile] = readBody().toString('utf8');
        }
      } else {
        throw refuse(`it has a tar entry of type "${type === '\0' ? 'NUL' : type}", which docker save never writes`);
      }
      offset = dataAt + Math.ceil(size / 512) * 512;
    }
  } finally {
    closeSync(fd);
  }
  return out;
}

const parseJson = (text: string, what: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Refusing the image archive: its ${what} is not valid JSON`);
  }
};

/** The digest a config path names: `blobs/sha256/<hex>` (OCI) or `<hex>.json` (docker). */
const configDigest = (config: unknown): string | null => {
  if (typeof config !== 'string') return null;
  const m = /^(?:blobs\/sha256\/([0-9a-f]{64})|([0-9a-f]{64})\.json)$/.exec(config);
  return m ? `sha256:${m[1] ?? m[2]}` : null;
};

/** Why a tag the archive carries is refused, naming infrastructure explicitly. */
const foreignTag = (tag: string, expectTag: string): Error =>
  new Error(
    `Refusing the image archive: it carries the tag "${tag}", not the expected ${expectTag}` +
      (isReservedImage(tag) ? " — that name belongs to the node's own infrastructure (the proxy or NineDeploy's images)" : '') +
      '. An image archive may tag only the image it ships.',
  );

/**
 * The tag-smuggling refusal (design §6.4). `docker load` applies whatever tags
 * the archive records, so a compromised build host could ship an archive
 * tagged `traefik:v3.1` and replace the node's proxy image. Before anything is
 * loaded the archive must hold exactly ONE image whose config digest is
 * `expectId`, and every tag it records — `manifest.json` RepoTags, a legacy
 * `repositories` file, OCI `index.json` name annotations — must be absent or
 * exactly `expectTag`. Throws with the refusal; returns nothing on success.
 */
export function inspectImageArchive(file: string, expect: { expectTag: string; expectId: string }): void {
  const meta = readArchiveMetadata(file);
  if (meta['manifest.json'] === undefined) throw new Error('Refusing the image archive: it has no manifest.json');
  const manifest = parseJson(meta['manifest.json'], 'manifest.json');
  if (!Array.isArray(manifest) || manifest.length !== 1) {
    throw new Error(`Refusing the image archive: it must hold exactly one image (it holds ${Array.isArray(manifest) ? manifest.length : 'none'})`);
  }
  const entry = manifest[0] as { Config?: unknown; RepoTags?: unknown } | null;
  if (!entry || typeof entry !== 'object') throw new Error('Refusing the image archive: its manifest entry is malformed');
  const repoTags = entry.RepoTags ?? [];
  if (!Array.isArray(repoTags)) throw new Error('Refusing the image archive: its RepoTags are malformed');
  for (const tag of repoTags) if (tag !== expect.expectTag) throw foreignTag(String(tag), expect.expectTag);

  let indexDigest: string | null = null;
  if (meta['index.json'] !== undefined) {
    const index = parseJson(meta['index.json'], 'index.json') as { manifests?: unknown } | null;
    const manifests = index?.manifests;
    if (!Array.isArray(manifests) || manifests.length !== 1) throw new Error('Refusing the image archive: its index.json must name exactly one image');
    const m = manifests[0] as { digest?: unknown; annotations?: Record<string, unknown> } | null;
    indexDigest = typeof m?.digest === 'string' ? m.digest : null;
    const annotations = m?.annotations ?? {};
    const name = annotations['io.containerd.image.name'];
    if (name !== undefined && name !== expect.expectTag && name !== `docker.io/${expect.expectTag}`) throw foreignTag(String(name), expect.expectTag);
    const refName = annotations['org.opencontainers.image.ref.name'];
    const expectedRef = expect.expectTag.slice(expect.expectTag.lastIndexOf(':') + 1);
    if (refName !== undefined && refName !== expectedRef && refName !== expect.expectTag) throw foreignTag(String(refName), expect.expectTag);
  }
  if (meta.repositories !== undefined) {
    const repos = parseJson(meta.repositories, 'repositories file');
    if (typeof repos !== 'object' || repos === null || Array.isArray(repos)) throw new Error('Refusing the image archive: its repositories file is malformed');
    for (const [repo, tags] of Object.entries(repos as Record<string, unknown>)) {
      if (typeof tags !== 'object' || tags === null) throw new Error('Refusing the image archive: its repositories file is malformed');
      for (const tag of Object.keys(tags)) if (`${repo}:${tag}` !== expect.expectTag) throw foreignTag(`${repo}:${tag}`, expect.expectTag);
    }
  }
  const config = configDigest(entry.Config);
  if (config !== expect.expectId && indexDigest !== expect.expectId) {
    throw new Error(`Refusing the image archive: it holds image ${config ?? 'with an unreadable config'}, not ${expect.expectId}`);
  }
}
