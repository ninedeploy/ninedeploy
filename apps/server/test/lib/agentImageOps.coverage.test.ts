import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dockerSaveArchive, EXPECT_TAG, IMAGE_HEX, IMAGE_ID, ociSaveArchive, paxRecord, tarArchive } from '../fixtures/imageArchive.js';

/**
 * agentOps/images.ts beyond agentImageArchive.test.ts: the plain image ops
 * (argv and the writable-tag refusals), the image.save stream kind (gzip of
 * `docker save <id>`, its failure and abort), the image.load stream kind (the
 * disk-space gate, the load / id / tag checks and the undo of a mismatched
 * load) and the strict archive reader's remaining refusals. Docker is never
 * reached: argv is captured at the spawnValidated seam.
 */

const h = vi.hoisted(() => ({
  calls: [] as string[][],
  handler: null as null | ((argv: string[], onLine: (l: string) => void) => number),
  streams: [] as string[][],
  child: null as null | { stdout: import('node:stream').PassThrough; exit: Promise<{ code: number; stderr: string }>; kill: () => void },
}));

vi.mock('../../src/lib/spawnValidated.js', () => ({
  spawnValidated: vi.fn(async (_exe: string, argv: string[], onLine: (l: string) => void) => {
    h.calls.push(argv);
    return h.handler ? h.handler(argv, onLine) : 0;
  }),
  spawnValidatedStream: vi.fn((_exe: string, argv: string[]) => {
    h.streams.push(argv);
    return h.child;
  }),
}));

const { imageOps, imageSaveKind, imageLoadKind, imageTagSnapshot, assertNoTagSmuggled, familiarRef, inspectImageArchive, readArchiveMetadata } = await import(
  '../../src/agentOps/images.js'
);

const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-imgops-cov-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = (bytes: Buffer) => {
  const f = path.join(dir, `a${n++}.tar`);
  writeFileSync(f, bytes);
  return f;
};
const check = (bytes: Buffer) => () => inspectImageArchive(file(bytes), { expectTag: EXPECT_TAG, expectId: IMAGE_ID });

const OTHER_ID = `sha256:${'b'.repeat(64)}`;

beforeEach(() => {
  h.calls.length = 0;
  h.streams.length = 0;
  h.handler = null;
  h.child = null;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const runOp = async (op: string, params: Record<string, unknown>) => {
  const lines: string[] = [];
  const code = await imageOps.ops[op]!.run(params, (l) => void lines.push(l), { sealed: false } as never);
  return { code, lines };
};

describe('plain image ops', () => {
  it('registers four non-sealed image.manage ops', () => {
    expect(Object.keys(imageOps.ops)).toEqual(['docker.imageInspect', 'docker.imageRm', 'docker.tag', 'docker.push']);
    for (const op of Object.values(imageOps.ops)) expect(op).toMatchObject({ cap: 'image.manage', sealedOnly: false });
  });

  it('imageInspect: the id|size probe; refuses a ref docker would read as an option or an oversized one', async () => {
    h.handler = (_argv, onLine) => {
      onLine(`${IMAGE_ID}|1234`);
      return 0;
    };
    expect(await runOp('docker.imageInspect', { image: 'nginx:1.27' })).toEqual({ code: 0, lines: [`${IMAGE_ID}|1234`] });
    expect(h.calls).toEqual([['image', 'inspect', '--format', '{{.Id}}|{{.Size}}', 'nginx:1.27']]);
    await expect(runOp('docker.imageInspect', { image: '-v' })).rejects.toThrow('Invalid image');
    await expect(runOp('docker.imageInspect', { image: `a${'b'.repeat(255)}` })).rejects.toThrow('Invalid image');
    await expect(runOp('docker.imageInspect', {})).rejects.toThrow('Invalid image');
  });

  it('imageRm and tag write only a service tag or a registry-qualified tag', async () => {
    expect((await runOp('docker.imageRm', { image: 'ninedeploy/web:abc' })).code).toBe(0);
    expect((await runOp('docker.tag', { source: IMAGE_ID, target: 'registry.example.com/team/web:1' })).code).toBe(0);
    expect((await runOp('docker.tag', { source: 'ninedeploy/web:abc', target: 'localhost/web:2' })).code).toBe(0);
    expect(h.calls).toEqual([
      ['image', 'rm', 'ninedeploy/web:abc'],
      ['tag', IMAGE_ID, 'registry.example.com/team/web:1'],
      ['tag', 'ninedeploy/web:abc', 'localhost/web:2'],
    ]);
  });

  it.each([
    ['ninedeploy/web', /target tag: name a tag/],
    [`ninedeploy/web@sha256:${IMAGE_HEX}`, /target tag: name a tag/],
    ['registry.example.com:5000/web', /target tag: name a tag/],
    ['library/nginx:1', /only ninedeploy\/<slug>:<tag> or a registry-qualified tag can be written/],
    ['nginx:1', /only ninedeploy\/<slug>:<tag>/],
    ['ghcr.io/ninedeploy/ninedeploy:v0.18.9', /Refusing target tag ghcr\.io\/ninedeploy\/ninedeploy:v0\.18\.9: that name belongs to the node's own infrastructure/],
    ['docker.io/library/traefik:v3.1', /node's own infrastructure/],
  ])('tag refuses the target %s', async (target, why) => {
    await expect(runOp('docker.tag', { source: 'nginx:1', target })).rejects.toThrow(why);
    expect(h.calls).toEqual([]);
  });

  it('push: a registry-qualified tag with the long budget; a service tag is not pushable', async () => {
    expect((await runOp('docker.push', { image: 'registry.example.com/team/web:1' })).code).toBe(0);
    await expect(runOp('docker.push', { image: 'ninedeploy/web:abc' })).rejects.toThrow('Invalid image: a push needs a registry-qualified tag');
    await expect(runOp('docker.imageRm', { image: 'traefik:v3.1' })).rejects.toThrow(/only ninedeploy/);
    expect(h.calls).toEqual([['push', 'registry.example.com/team/web:1']]);
    const { spawnValidated } = await import('../../src/lib/spawnValidated.js');
    expect(vi.mocked(spawnValidated).mock.calls.at(-1)?.[3]).toEqual({ timeoutMs: 30 * 60 * 1000 });
  });
});

describe('the image.save stream kind', () => {
  const inspectAnswers = (id: string, code = 0) => {
    h.handler = (argv, onLine) => {
      if (argv[0] === 'image' && argv[1] === 'inspect') {
        onLine(id);
        return code;
      }
      return 0;
    };
  };
  const child = (exit: Promise<{ code: number; stderr: string }>) => {
    const kill = vi.fn();
    h.child = { stdout: new PassThrough(), exit, kill };
    return h.child;
  };
  const prepareSave = async () => {
    const prepared = await imageSaveKind.prepare({ image: 'ninedeploy/web:abc' }, { maxBytes: 1 << 20 });
    if (prepared.direction !== 'agent-to-panel') throw new Error('direction');
    return prepared;
  };

  it('saves by id through gzip; done names the id', async () => {
    inspectAnswers(IMAGE_ID);
    const c = child(Promise.resolve({ code: 0, stderr: '' }));
    const source = await (await prepareSave()).start();
    expect(h.streams).toEqual([['save', IMAGE_ID]]);
    c.stdout.end(Buffer.from('TAR-BYTES'));
    const chunks: Buffer[] = [];
    for await (const chunk of source.stream) chunks.push(chunk as Buffer);
    expect(gunzipSync(Buffer.concat(chunks)).toString()).toBe('TAR-BYTES');
    expect(await source.done).toEqual({ imageId: IMAGE_ID });
  });

  it('refuses an image the node does not have (non-zero inspect, or an answer that is not an id)', async () => {
    inspectAnswers(IMAGE_ID, 1);
    await expect(prepareSave()).rejects.toThrow('Image ninedeploy/web:abc does not exist on this node');
    inspectAnswers('Error: No such image');
    await expect(prepareSave()).rejects.toThrow(/does not exist on this node/);
    await expect(imageSaveKind.prepare({ image: '$(x)' }, { maxBytes: 1 })).rejects.toThrow('Invalid image');
    expect(h.streams).toEqual([]);
  });

  it('a failed docker save fails done with the stderr tail', async () => {
    inspectAnswers(IMAGE_ID);
    child(Promise.resolve({ code: 1, stderr: 'Error response from daemon: boom\n' }));
    const source = await (await prepareSave()).start();
    await expect(source.done).rejects.toThrow('docker save exited with 1: Error response from daemon: boom');
  });

  it('an error on the docker stdout destroys the gzip stream; abort kills the child', async () => {
    inspectAnswers(IMAGE_ID);
    const c = child(new Promise(() => undefined));
    const source = await (await prepareSave()).start();
    const failed = new Promise((resolve) => source.stream.once('error', resolve));
    c.stdout.emit('error', new Error('EPIPE'));
    expect(await failed).toMatchObject({ message: 'EPIPE' });
    source.abort();
    expect(c.kill).toHaveBeenCalledOnce();
  });
});

describe('the image.load stream kind', () => {
  const DF_HEADER = 'Filesystem     1024-blocks      Used Available Capacity Mounted on';
  const tagLines = (tags: Array<[string, string]>) => tags.map(([ref, id]) => `${ref}|${id}`);

  /** A docker that answers df, image ls, load, inspect and tag from the given script. */
  function node(script: {
    df?: number | string;
    dfCode?: number;
    before?: Array<[string, string]>;
    after?: Array<[string, string]>;
    lsCode?: number;
    load?: string[];
    loadCode?: number;
    inspectId?: string;
    tagCode?: number;
  }) {
    let listed = 0;
    h.handler = (argv, onLine) => {
      if (argv[0] === '-kP') {
        if (script.df === undefined) return 1;
        onLine(DF_HEADER);
        onLine(`/dev/sda1  100  50  ${script.df}  5% /`);
        return script.dfCode ?? 0;
      }
      if (argv[0] === 'image' && argv[1] === 'ls') {
        const tags = listed++ === 0 ? (script.before ?? []) : (script.after ?? script.before ?? []);
        for (const l of tagLines(tags)) onLine(l);
        onLine('<none>:<none>|' + OTHER_ID);
        onLine('garbage line');
        return script.lsCode ?? 0;
      }
      if (argv[0] === 'load') {
        for (const l of script.load ?? [`Loaded image ID: ${IMAGE_ID}`]) onLine(l);
        return script.loadCode ?? 0;
      }
      if (argv[0] === 'image' && argv[1] === 'inspect') {
        onLine(script.inspectId ?? IMAGE_ID);
        return 0;
      }
      if (argv[0] === 'tag') {
        onLine('tag says');
        return script.tagCode ?? 0;
      }
      return 0;
    };
  }

  const prepareLoad = async (params: Record<string, unknown> = {}, maxBytes = 1 << 30) => {
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const prepared = await imageLoadKind.prepare({ expectTag: EXPECT_TAG, expectId: IMAGE_ID, ...params }, { maxBytes });
    if (prepared.direction !== 'panel-to-agent') throw new Error('direction');
    return prepared;
  };

  it('prepare: creates the transfer dir, reads free space with df, refuses when the image would not fit', async () => {
    node({ df: 10_000_000 });
    const prepared = await prepareLoad({ sizeBytes: 1024 });
    expect(prepared.gunzip).toBe(true);
    expect(existsSync(path.join(dir, '.agent-work', '.transfer'))).toBe(true);
    expect(h.calls).toEqual([['-kP', path.resolve(dir, '.agent-work/.transfer')]]);
    node({ df: 1000 });
    await expect(prepareLoad({ sizeBytes: 1024 })).rejects.toThrow(`Not enough free disk space on the node for this image (1024000 bytes free, ${1024 + 256 * 1024 * 1024} needed)`);
    // df without an answer (or one that is not a number) does not block the transfer.
    node({});
    await expect(prepareLoad()).resolves.toMatchObject({ direction: 'panel-to-agent' });
    node({ df: 'n/a' });
    await expect(prepareLoad()).resolves.toMatchObject({ direction: 'panel-to-agent' });
  });

  it('prepare refuses a reserved, oversized or malformed expected tag, a bad id and a bad size', async () => {
    node({ df: 10_000_000 });
    await expect(prepareLoad({ expectTag: 'traefik:v3.1' })).rejects.toThrow('Invalid expected tag');
    await expect(prepareLoad({ expectTag: `ninedeploy/${'a'.repeat(250)}:1` })).rejects.toThrow('Invalid expected tag');
    await expect(prepareLoad({ expectId: 'sha256:xyz' })).rejects.toThrow('Invalid expected image id');
    await expect(prepareLoad({ sizeBytes: 0 })).rejects.toThrow('Invalid sizeBytes');
    await expect(prepareLoad({ sizeBytes: 2048 }, 1024)).rejects.toThrow('Invalid sizeBytes');
    expect(h.calls).toEqual([]);
  });

  it('prepare refuses an expected tag in a reserved repository named by the host-shell image', async () => {
    vi.stubEnv('NINEDEPLOY_HOST_SHELL_IMAGE', 'ninedeploy/shell:1');
    try {
      await expect(prepareLoad({ expectTag: 'ninedeploy/shell:2' })).rejects.toThrow("Refusing expected tag ninedeploy/shell:2: that name belongs to the node's own infrastructure");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('apply: checks the archive, loads it, verifies the id and tags it', async () => {
    node({ df: 10_000_000, before: [['traefik:v3.1', OTHER_ID]] });
    const prepared = await prepareLoad();
    h.calls.length = 0;
    expect(await prepared.apply(file(dockerSaveArchive()))).toEqual({ imageId: IMAGE_ID, tag: EXPECT_TAG });
    expect(h.calls.map((c) => c.slice(0, 2))).toEqual([
      ['image', 'ls'],
      ['load', '-i'],
      ['image', 'ls'],
      ['image', 'inspect'],
      ['tag', IMAGE_ID],
    ]);
    expect(h.calls.at(-1)).toEqual(['tag', IMAGE_ID, EXPECT_TAG]);
  });

  it('apply refuses an archive before docker load sees it', async () => {
    node({ df: 10_000_000 });
    const prepared = await prepareLoad();
    h.calls.length = 0;
    await expect(prepared.apply(file(dockerSaveArchive({ repoTags: ['traefik:v3.1'] })))).rejects.toThrow(/"traefik:v3\.1"/);
    expect(h.calls).toEqual([]);
  });

  it('apply fails when the tags cannot be listed, when load fails, and when the tag fails', async () => {
    node({ df: 10_000_000, lsCode: 1 });
    const prepared = await prepareLoad();
    await expect(prepared.apply(file(dockerSaveArchive()))).rejects.toThrow("Refusing to load the image: could not list the node's image tags to guard them");
    node({ df: 10_000_000, load: ['open /x: no space left on device'], loadCode: 1 });
    await expect(prepared.apply(file(dockerSaveArchive()))).rejects.toThrow('docker load exited with 1: open /x: no space left on device');
    node({ df: 10_000_000, tagCode: 125 });
    await expect(prepared.apply(file(dockerSaveArchive()))).rejects.toThrow('docker tag exited with 125: tag says');
  });

  it('apply undoes a load whose id is not the expected one (the loaded id and the expected tag only)', async () => {
    node({ df: 10_000_000, load: [`Loaded image ID: ${OTHER_ID}`, `Loaded image: ${EXPECT_TAG}`, 'The image was loaded'], inspectId: OTHER_ID });
    const prepared = await prepareLoad();
    h.calls.length = 0;
    await expect(prepared.apply(file(dockerSaveArchive()))).rejects.toThrow(`The loaded image's id does not match ${IMAGE_ID}; it was removed`);
    const removed = h.calls.filter((c) => c[0] === 'image' && c[1] === 'rm');
    expect(removed).toEqual([
      ['image', 'rm', OTHER_ID],
      ['image', 'rm', EXPECT_TAG],
    ]);
  });

  it('apply refuses a load that smuggled a tag (and reverts it) even when docker load failed', async () => {
    node({
      df: 10_000_000,
      before: [['traefik:v3.1', OTHER_ID]],
      after: [['traefik:v3.1', IMAGE_ID]],
      load: ['Loaded image: traefik:v3.1'],
      loadCode: 1,
    });
    const prepared = await prepareLoad();
    h.calls.length = 0;
    await expect(prepared.apply(file(dockerSaveArchive()))).rejects.toThrow(/^SECURITY: the image archive tagged "traefik:v3\.1"/);
    expect(h.calls.at(-1)).toEqual(['tag', OTHER_ID, 'traefik:v3.1']);
  });
});

describe('the tag snapshot and the post-load check helpers', () => {
  it('imageTagSnapshot: familiar refs → ids; dangling and malformed lines skipped', async () => {
    h.handler = (_argv, onLine) => {
      onLine(`docker.io/library/nginx:1.27|${IMAGE_ID}`);
      onLine(`registry.example.com:5000/team/web:1|${OTHER_ID}`);
      onLine(`<none>:<none>|${IMAGE_ID}`);
      onLine(`web:<none>|${IMAGE_ID}`);
      onLine('nginx:1.27|not-an-id');
      return 0;
    };
    expect(await imageTagSnapshot()).toEqual(
      new Map([
        ['nginx:1.27', IMAGE_ID],
        ['registry.example.com:5000/team/web:1', OTHER_ID],
      ]),
    );
  });

  it('familiarRef drops the Docker Hub prefixes only', () => {
    expect(familiarRef('index.docker.io/library/alpine:3')).toBe('alpine:3');
    expect(familiarRef('registry-1.docker.io/foo/bar:1')).toBe('foo/bar:1');
    expect(familiarRef('ghcr.io/library/x:1')).toBe('ghcr.io/library/x:1');
  });

  it('a suspect ref that is not a valid image ref is reported but never passed to docker', async () => {
    await expect(assertNoTagSmuggled({ before: new Map(), after: new Map(), loadLines: ['Loaded image: -evil:1'], expectTag: EXPECT_TAG })).rejects.toThrow(/"-evil:1"/);
    expect(h.calls).toEqual([]);
  });
});

describe('the strict archive reader: the remaining refusals', () => {
  const manifest = JSON.stringify([{ Config: `${IMAGE_HEX}.json`, RepoTags: null, Layers: [] }]);

  it('a base-256 size, a non-octal size, and an oversized metadata record', () => {
    const base256 = tarArchive([{ name: 'manifest.json', data: manifest }]);
    base256[124] = 0x80;
    // Fix the checksum so the size check is what refuses it.
    base256.write('        ', 148, 'latin1');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += base256[i] as number;
    base256.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    expect(check(base256)).toThrow(/base-256 size/);

    const big = tarArchive([{ name: 'manifest.json', data: Buffer.alloc(1024 * 1024 + 1, 0x20) }]);
    expect(check(big)).toThrow(/a metadata record is too large/);
    const cut = tarArchive([{ name: 'manifest.json', data: manifest }]).subarray(0, 512 + 4);
    expect(check(cut)).toThrow(/it ends inside an entry/);
  });

  it('malformed pax records and GNU sparse keys', () => {
    expect(check(tarArchive([{ name: 'PaxHeaders/x', type: 'x', data: 'nospace' }, { name: 'manifest.json', data: manifest }]))).toThrow(/a pax header is malformed/);
    expect(check(tarArchive([{ name: 'PaxHeaders/x', type: 'x', data: '99 mtime=1\n' }, { name: 'manifest.json', data: manifest }]))).toThrow(/a pax header is malformed/);
    expect(check(tarArchive([{ name: 'PaxHeaders/x', type: 'x', data: 'x mtime=1\n' }, { name: 'manifest.json', data: manifest }]))).toThrow(/a pax header is malformed/);
    expect(check(tarArchive([{ name: 'PaxHeaders/x', type: 'x', data: paxRecord('GNU.sparse.map', '0') }, { name: 'manifest.json', data: manifest }]))).toThrow(
      /pax "GNU\.sparse\.map" record/,
    );
    // A NUL-padded pax body ends at the padding.
    const padded = Buffer.concat([Buffer.from(paxRecord('mtime', '1')), Buffer.alloc(8)]);
    expect(check(tarArchive([{ name: 'PaxHeaders/x', type: 'x', data: padded }, { name: 'manifest.json', data: manifest }]))).not.toThrow();
  });

  it('an empty or backslashed entry name, and a link to an empty target', () => {
    expect(check(tarArchive([{ name: '', data: 'x' }, { name: 'manifest.json', data: manifest }]))).toThrow(/entry named ""/);
    expect(check(tarArchive([{ name: 'l1\\manifest.json', data: 'x' }, { name: 'manifest.json', data: manifest }]))).toThrow(/entry named "l1\\manifest\.json"/);
    expect(check(tarArchive([{ name: 'l1/layer.tar', type: '2' }, { name: 'manifest.json', data: manifest }]))).toThrow(/points outside the archive/);
  });

  it('a NUL type flag is a regular file (old tar)', () => {
    const bytes = tarArchive([{ name: 'manifest.json', data: manifest }]);
    bytes[156] = 0;
    bytes.write('        ', 148, 'latin1');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += bytes[i] as number;
    bytes.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    expect(readArchiveMetadata(file(bytes))['manifest.json']).toBe(manifest);
  });

  it('a ustar prefix field joins the name', () => {
    const bytes = tarArchive([{ name: 'manifest.json', data: manifest }]);
    bytes.write('sub', 345, 'utf8');
    bytes.write('        ', 148, 'latin1');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += bytes[i] as number;
    bytes.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    // `sub/manifest.json` is not a metadata name: the archive has no manifest.
    expect(check(bytes)).toThrow(/no manifest\.json/);
  });
});

describe('inspectImageArchive: malformed metadata', () => {
  const withManifest = (data: string, extra: Array<{ name: string; data: string }> = []) => tarArchive([{ name: 'manifest.json', data }, ...extra]);

  it('invalid JSON, a non-array or empty manifest, a malformed entry, malformed RepoTags', () => {
    expect(check(withManifest('{nope'))).toThrow('Refusing the image archive: its manifest.json is not valid JSON');
    expect(check(withManifest('{}'))).toThrow('it must hold exactly one image (it holds none)');
    expect(check(withManifest('[]'))).toThrow('(it holds 0)');
    expect(check(withManifest('[null]'))).toThrow('its manifest entry is malformed');
    expect(check(withManifest('[7]'))).toThrow('its manifest entry is malformed');
    expect(check(withManifest(JSON.stringify([{ Config: `${IMAGE_HEX}.json`, RepoTags: 'x' }])))).toThrow('its RepoTags are malformed');
  });

  it('an unreadable config path names it; an OCI index digest that matches is enough', () => {
    expect(check(withManifest(JSON.stringify([{ Config: 7 }])))).toThrow(`it holds image with an unreadable config, not ${IMAGE_ID}`);
    expect(check(withManifest(JSON.stringify([{ Config: 'config.json' }])))).toThrow(/unreadable config/);
    const index = JSON.stringify({ manifests: [{ digest: IMAGE_ID }] });
    expect(check(withManifest(JSON.stringify([{ Config: 'config.json' }]), [{ name: 'index.json', data: index }]))).not.toThrow();
    expect(check(withManifest(JSON.stringify([{ Config: `blobs/sha256/${IMAGE_HEX}` }])))).not.toThrow();
  });

  it('index.json: invalid JSON, not exactly one manifest, a non-string digest, a matching ref name', () => {
    const m = JSON.stringify([{ Config: `${IMAGE_HEX}.json` }]);
    expect(check(withManifest(m, [{ name: 'index.json', data: '[' }]))).toThrow('its index.json is not valid JSON');
    expect(check(withManifest(m, [{ name: 'index.json', data: 'null' }]))).toThrow('its index.json must name exactly one image');
    expect(check(withManifest(m, [{ name: 'index.json', data: JSON.stringify({ manifests: [{}, {}] }) }]))).toThrow(/exactly one image/);
    expect(check(withManifest(m, [{ name: 'index.json', data: JSON.stringify({ manifests: [null] }) }]))).not.toThrow();
    expect(check(withManifest(m, [{ name: 'index.json', data: JSON.stringify({ manifests: [{ digest: 5, annotations: { 'org.opencontainers.image.ref.name': EXPECT_TAG } }] }) }]))).not.toThrow();
    expect(check(ociSaveArchive({ 'io.containerd.image.name': EXPECT_TAG }))).not.toThrow();
  });

  it('a repositories file that is not an object of objects', () => {
    const m = JSON.stringify([{ Config: `${IMAGE_HEX}.json` }]);
    expect(check(withManifest(m, [{ name: 'repositories', data: '[1]' }]))).toThrow('its repositories file is malformed');
    expect(check(withManifest(m, [{ name: 'repositories', data: 'null' }]))).toThrow('its repositories file is malformed');
    expect(check(withManifest(m, [{ name: 'repositories', data: JSON.stringify({ 'ninedeploy/web': 'x' }) }]))).toThrow('its repositories file is malformed');
    expect(check(withManifest(m, [{ name: 'repositories', data: '{' }]))).toThrow('its repositories file is not valid JSON');
  });
});
