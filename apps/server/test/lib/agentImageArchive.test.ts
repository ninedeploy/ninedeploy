import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dockerSaveArchive,
  EXPECT_TAG,
  IMAGE_HEX,
  IMAGE_ID,
  ociSaveArchive,
  paxRecord,
  tarArchive,
} from '../fixtures/imageArchive.js';

/**
 * Multi-node (design §6.4): the tag-smuggling refusal for image archives.
 * `docker load` applies whatever tags an archive records, so a compromised
 * build host could ship one tagged `traefik:v3.1` and replace the node's
 * proxy image. Two layers, both tested here:
 *
 *  1. a STRICT pre-check of the archive's records (anything `docker save`
 *     never writes is refused rather than interpreted — the security review's
 *     bypasses: `..` names, pax size/path, GNU long names, duplicates);
 *  2. a post-load check that cannot be parsed around: the tags Docker itself
 *     reports and the node's infrastructure tags before vs after the load.
 */

const spawnMock = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => 0));
vi.mock('../../src/lib/spawnValidated.js', () => ({ spawnValidated: spawnMock, spawnValidatedStream: vi.fn() }));

const { assertNoTagSmuggled, inspectImageArchive, readArchiveMetadata, TagSmugglingError } = await import('../../src/agentOps/images.js');

const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-imgarchive-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = (bytes: Buffer) => {
  const f = path.join(dir, `a${n++}.tar`);
  writeFileSync(f, bytes);
  return f;
};
const check = (bytes: Buffer) => () => inspectImageArchive(file(bytes), { expectTag: EXPECT_TAG, expectId: IMAGE_ID });
const manifest = (repoTags: unknown = null) => JSON.stringify([{ Config: `${IMAGE_HEX}.json`, RepoTags: repoTags, Layers: [] }]);

beforeEach(() => spawnMock.mockReset().mockResolvedValue(0));

describe('archives docker save writes pass', () => {
  it('a classic `docker save <id>` archive (no tags)', () => {
    expect(check(dockerSaveArchive())).not.toThrow();
    expect(check(dockerSaveArchive({ repoTags: [] }))).not.toThrow();
  });

  it('an archive tagged exactly the expected tag, and an OCI (containerd store) archive', () => {
    expect(check(dockerSaveArchive({ repoTags: [EXPECT_TAG] }))).not.toThrow();
    expect(check(ociSaveArchive({ 'io.containerd.image.name': `docker.io/${EXPECT_TAG}`, 'org.opencontainers.image.ref.name': 'abc1234-b7' }))).not.toThrow();
  });

  it('a `./` prefix and a legacy shared-layer symlink inside the archive', () => {
    const bytes = tarArchive([
      { name: './l1/', type: '5' },
      { name: './l1/layer.tar', data: 'x' },
      { name: './l2/', type: '5' },
      { name: './l2/layer.tar', type: '2', linkname: '../l1/layer.tar' },
      { name: './manifest.json', data: manifest() },
    ]);
    expect(readArchiveMetadata(file(bytes))['manifest.json']).toBe(manifest());
    expect(check(bytes)).not.toThrow();
  });
});

describe('tag smuggling in the records is refused', () => {
  it('a foreign tag (the node proxy), named as infrastructure', () => {
    expect(check(dockerSaveArchive({ repoTags: ['traefik:v3.1'] }))).toThrow(/"traefik:v3\.1".*node's own infrastructure/);
  });

  it('an extra tag next to the expected one, and two images', () => {
    expect(check(dockerSaveArchive({ repoTags: [EXPECT_TAG, 'ninedeploy/other:1'] }))).toThrow(/"ninedeploy\/other:1"/);
    const two = dockerSaveArchive({ manifest: [{ Config: `${IMAGE_HEX}.json` }, { Config: `${'b'.repeat(64)}.json` }] });
    expect(check(two)).toThrow(/exactly one image \(it holds 2\)/);
  });

  it('a legacy repositories file or an OCI name annotation naming another tag', () => {
    const repos = dockerSaveArchive({ extra: [{ name: 'repositories', data: JSON.stringify({ traefik: { 'v3.1': IMAGE_HEX } }) }] });
    expect(check(repos)).toThrow(/"traefik:v3\.1"/);
    const fine = dockerSaveArchive({ extra: [{ name: 'repositories', data: JSON.stringify({ 'ninedeploy/web': { 'abc1234-b7': IMAGE_HEX } }) }] });
    expect(check(fine)).not.toThrow();
    expect(check(ociSaveArchive({ 'io.containerd.image.name': 'ghcr.io/ninedeploy/ninedeploy:v0.15.1' }))).toThrow(/infrastructure/);
    expect(check(ociSaveArchive({ 'org.opencontainers.image.ref.name': 'latest' }))).toThrow(/"latest"/);
  });

  it('another image than the expected id, and an archive without manifest.json', () => {
    expect(check(dockerSaveArchive({ config: `${'b'.repeat(64)}.json` }))).toThrow(/holds image sha256:b+, not sha256:a+/);
    expect(check(tarArchive([{ name: 'repositories', data: '{}' }]))).toThrow(/no manifest\.json/);
  });
});

describe('the strict reader: records docker save never writes are refused (security review bypasses)', () => {
  const foreign = manifest(['traefik:v3.1']);

  it('a `..`-normalised manifest (foo/../manifest.json) is refused, not skipped', () => {
    expect(check(dockerSaveArchive({ extra: [{ name: 'foo/../manifest.json', data: foreign }] }))).toThrow(/"\.\." segment/);
    expect(check(dockerSaveArchive({ extra: [{ name: './x/../repositories', data: '{}' }] }))).toThrow(/"\.\." segment/);
  });

  it('a pax size override (which shifts every later offset) and a pax path', () => {
    const size = tarArchive([
      { name: 'PaxHeaders/x', type: 'x', data: paxRecord('size', '0') },
      { name: 'decoy', data: 'x'.repeat(600) },
      { name: 'manifest.json', data: manifest() },
    ]);
    expect(check(size)).toThrow(/pax "size" record/);
    const named = tarArchive([{ name: 'PaxHeaders/x', type: 'x', data: paxRecord('path', 'manifest.json') }, { name: 'innocent', data: foreign }]);
    expect(check(named)).toThrow(/pax "path" record/);
    // A pax record docker's Go writer can emit (mtime) is fine.
    const mtime = tarArchive([{ name: 'PaxHeaders/x', type: 'x', data: paxRecord('mtime', '1.5') }, { name: 'manifest.json', data: manifest() }]);
    expect(check(mtime)).not.toThrow();
  });

  it('a GNU long name (L) or long link (K), a global pax header, and a hard link', () => {
    for (const type of ['L', 'K', 'g', '1', '3', '6']) {
      const bytes = tarArchive([{ name: '././@LongLink', type, data: 'manifest.json' }, { name: 'innocent', data: foreign }]);
      expect(check(bytes), type).toThrow(/tar entry of type/);
    }
  });

  it('a duplicate manifest (tar extraction lets the later one win)', () => {
    expect(check(dockerSaveArchive({ extra: [{ name: 'manifest.json', data: foreign }] }))).toThrow(/manifest\.json twice/);
    expect(check(dockerSaveArchive({ extra: [{ name: './manifest.json', data: foreign }] }))).toThrow(/manifest\.json twice/);
  });

  it('absolute names, a metadata symlink, a link leaving the archive, a bad checksum, a cut archive', () => {
    expect(check(tarArchive([{ name: '/manifest.json', data: foreign }]))).toThrow(/entry named "\/manifest\.json"/);
    expect(check(tarArchive([{ name: 'manifest.json', type: '2', linkname: 'x.json' }]))).toThrow(/replaces a metadata file/);
    expect(check(tarArchive([{ name: 'l1/layer.tar', type: '2', linkname: '../../etc/shadow' }, { name: 'manifest.json', data: manifest() }]))).toThrow(/points outside/);
    expect(check(tarArchive([{ name: 'manifest.json', data: manifest(), badChecksum: true }]))).toThrow(/checksum/);
    const whole = dockerSaveArchive();
    expect(check(whole.subarray(0, 1024 + 256))).toThrow(/ends inside/);
    expect(check(tarArchive([{ name: 'manifest.json', type: '5' }]))).toThrow(/is a directory/);
  });
});

describe('the post-load check catches what a parser missed', () => {
  const OLD = `sha256:${'1'.repeat(64)}`;
  const EVIL = `sha256:${'e'.repeat(64)}`;
  const calls = () => spawnMock.mock.calls.map((c) => c[1] as string[]);

  it('a load that tagged the proxy image: the previous id is re-tagged, the transfer refused (SECURITY)', async () => {
    const before = new Map([['traefik:v3.1', OLD]]);
    const after = new Map([['traefik:v3.1', EVIL], [EXPECT_TAG, IMAGE_ID]]);
    const err = await assertNoTagSmuggled({ before, after, loadLines: ['Loaded image: traefik:v3.1', `Loaded image ID: ${IMAGE_ID}`], expectTag: EXPECT_TAG }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TagSmugglingError);
    expect(String((err as Error).message)).toMatch(/^SECURITY: the image archive tagged "traefik:v3\.1"/);
    expect(calls()).toEqual([['tag', OLD, 'traefik:v3.1']]);
  });

  it('a new foreign tag is removed; a reserved tag changed without a load line is restored too', async () => {
    const before = new Map([['alpine:3.21', OLD]]);
    const after = new Map([['alpine:3.21', EVIL], ['evil/x:1', EVIL]]);
    await expect(assertNoTagSmuggled({ before, after, loadLines: ['Loaded image: docker.io/evil/x:1'], expectTag: EXPECT_TAG })).rejects.toThrow(
      /"alpine:3\.21", "evil\/x:1"/,
    );
    expect(calls()).toEqual([
      ['tag', OLD, 'alpine:3.21'],
      ['image', 'rm', 'evil/x:1'],
    ]);
  });

  it('the expected tag, and a concurrent build of another service, pass untouched', async () => {
    const before = new Map([['ninedeploy/other:1', OLD]]);
    const after = new Map([['ninedeploy/other:1', EVIL], [EXPECT_TAG, IMAGE_ID]]);
    await expect(
      assertNoTagSmuggled({ before, after, loadLines: [`Loaded image: docker.io/${EXPECT_TAG}`, `Loaded image ID: ${IMAGE_ID}`], expectTag: EXPECT_TAG }),
    ).resolves.toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
