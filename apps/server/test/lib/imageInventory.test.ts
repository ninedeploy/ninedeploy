/**
 * G-47 image inventory + retention � lib coverage.
 *
 * `imageInventory.ts` is the engine behind
 * `ninedeploy images {ls,prune}`. The behaviour worth pinning
 * down:
 *  - `listImages` parses `docker image ls --format '{{json .}}'`
 *    output, computes `ageHours` from `createdAt`, marks
 *    `dangling` when both repo and tag are `<none>`, and
 *    sets `inUse` from a second `docker ps` pass.
 *  - `parseHumanBytes` handles B / KB / MB / GB / TB and the
 *    space-less variant the kernel's docker daemon returns
 *    (`1.2GB` vs `1.2 GB`).
 *  - `parseReclaimedBytes` reads docker's `Total reclaimed
 *    space: ...` summary.
 *  - `pruneImages`:
 *    - `danglingOnly` runs `docker image prune -f` (no
 *      candidate building).
 *    - `keepLast` keeps the newest N images per repository
 *      (a repo:tag reference maps to exactly one image id, so
 *      the retention group must be the repository) and marks
 *      the rest as candidates (r017 regression: grouping by
 *      repo:tag made the prune a silent no-op).
 *    - `olderThanHours` filters candidates by age.
 *    - `dryRun` returns the would-delete set without
 *      `docker image rm`.
 *    - real delete chunks ids (50 per `docker image rm`).
 *    - `inUse` images are skipped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execState = vi.hoisted(() => ({
  /** Maps a docker args fingerprint to the (stdout|throw) pair. */
  byArgs: new Map<string, { stdout?: string; throw?: Error }>(),
  /** Recorded `run` calls (for the rm chunk assertions). */
  rmCalls: [] as Array<{ args: string[] }>,
}));

vi.mock('../../src/lib/exec.js', () => ({
  capture: vi.fn(async (tool: string, args: string[] = []) => {
    const key = `${tool} ${args.join(' ')}`;
    const r = execState.byArgs.get(key);
    if (r?.throw) throw r.throw;
    return r?.stdout ?? '';
  }),
  run: vi.fn(async (tool: string, args: string[] = []) => {
    if (tool === 'docker' && args[0] === 'image' && args[1] === 'rm') {
      execState.rmCalls.push({ args });
    }
    const key = `${tool} ${args.join(' ')}`;
    const r = execState.byArgs.get(key);
    if (r?.throw) throw r.throw;
  }),
}));

import {
  formatBytes,
  listImages,
  parseHumanBytes,
  parseReclaimedBytes,
  pruneImages,
} from '../../src/lib/imageInventory.js';

beforeEach(() => {
  execState.byArgs.clear();
  execState.rmCalls.length = 0;
});

const IMG_LS_JSON = [
  JSON.stringify({
    Repository: 'nginx',
    Tag: '1.27-alpine',
    ID: 'sha256:aaaa',
    Size: '142MB',
    CreatedAt: new Date(Date.now() - 3_600_000).toISOString(),
  }),
  JSON.stringify({
    Repository: 'nginx',
    Tag: '1.26-alpine',
    ID: 'sha256:bbbb',
    Size: '150MB',
    CreatedAt: new Date(Date.now() - 7_200_000).toISOString(),
  }),
  JSON.stringify({
    Repository: 'nginx',
    Tag: '1.25-alpine',
    ID: 'sha256:cccc',
    Size: '130MB',
    CreatedAt: new Date(Date.now() - 86_400_000).toISOString(),
  }),
  JSON.stringify({
    Repository: '<none>',
    Tag: '<none>',
    ID: 'sha256:dddd',
    Size: '12MB',
    CreatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  }),
].join('\n');

/**
 * r311: fake the container side the way a REAL docker answers it. The old
 * fixture had `docker ps --format {{.Image}}` print `sha256:…` ids, which is
 * exactly what hid the bug — real docker prints the REFERENCE the container
 * was started from (`nginx:1.27-alpine`). Only `docker inspect` on the
 * container yields the image id. Every shape is registered so a regression
 * to the `ps --format {{.Image}}` query sees realistic output and fails.
 */
function fakeContainers(list: Array<{ container: string; ref: string; imageId: string }>): void {
  execState.byArgs.set('docker ps --no-trunc --format {{.Image}}', {
    stdout: list.map((c) => `${c.ref}\n`).join(''),
  });
  execState.byArgs.set('docker ps -aq --no-trunc', { stdout: list.map((c) => `${c.container}\n`).join('') });
  execState.byArgs.set(`docker inspect --format {{.Image}} ${list.map((c) => c.container).join(' ')}`, {
    stdout: list.map((c) => `${c.imageId}\n`).join(''),
  });
  for (const c of list) {
    execState.byArgs.set(`docker inspect --format {{.Image}} ${c.container}`, { stdout: `${c.imageId}\n` });
  }
}

describe('listImages', () => {
  it('parses docker image ls JSON output, marks in-use from the containers', async () => {
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', { stdout: IMG_LS_JSON });
    fakeContainers([{ container: 'c0ffee01', ref: 'nginx:1.27-alpine', imageId: 'sha256:aaaa' }]);
    const rows = await listImages();
    expect(rows).toHaveLength(4);
    const nginx1 = rows.find((r) => r.id === 'sha256:aaaa')!;
    expect(nginx1.repository).toBe('nginx');
    expect(nginx1.tag).toBe('1.27-alpine');
    expect(nginx1.sizeBytes).toBe(142 * 1024 * 1024);
    expect(nginx1.inUse).toBe(true);
    expect(nginx1.dangling).toBe(false);
    expect(nginx1.ageHours).toBeGreaterThan(0);
    const dang = rows.find((r) => r.id === 'sha256:dddd')!;
    expect(dang.dangling).toBe(true);
    expect(dang.inUse).toBe(false);
  });

  it('tolerates bad lines in the docker ls output (skips them)', async () => {
    const noisy = `${IMG_LS_JSON}\n{not json}\n`;
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', { stdout: noisy });
    execState.byArgs.set('docker ps -aq --no-trunc', { stdout: '' });
    const rows = await listImages();
    expect(rows).toHaveLength(4);
  });

  it('throws a friendly error when docker image ls fails', async () => {
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', {
      throw: new Error('Cannot connect to the Docker daemon'),
    });
    await expect(listImages()).rejects.toThrow(/docker image ls failed/);
  });

  it('returns an empty list when there are no images', async () => {
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', { stdout: '' });
    execState.byArgs.set('docker ps -aq --no-trunc', { stdout: '' });
    const rows = await listImages();
    expect(rows).toEqual([]);
  });
});

describe('pruneImages', () => {
  it('runs `docker image prune -f` for danglingOnly and parses the freed bytes', async () => {
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', { stdout: IMG_LS_JSON });
    execState.byArgs.set('docker ps -aq --no-trunc', { stdout: '' });
    execState.byArgs.set('docker image prune -f', {
      stdout: 'Deleted Images:\ndeleted: sha256:dddd\nTotal reclaimed space: 12.0MB',
    });
    const result = await pruneImages({ danglingOnly: true });
    expect(result.dryRun).toBe(false);
    expect(result.removed).toEqual([]); expect(result.freedBytes).toBe(12 * 1024 * 1024); expect(result.output).toContain('Total reclaimed space: 12.0MB');
  });

  it('passes olderThanHours as a `until=` filter on the dangling prune', async () => {
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', { stdout: '' });
    execState.byArgs.set('docker ps -aq --no-trunc', { stdout: '' });
    execState.byArgs.set('docker image prune -f --filter until=24h', { stdout: '' });
    const result = await pruneImages({ danglingOnly: true, olderThanHours: 24 });
    expect(result.output).toBe('');
  });

  it('keeps the newest N images per repository and prunes the rest on dryRun', async () => {
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', { stdout: IMG_LS_JSON });
    execState.byArgs.set('docker ps -aq --no-trunc', { stdout: '' });
    const result = await pruneImages({ keepLast: 1, dryRun: true });
    expect(result.dryRun).toBe(true);
    // One nginx repository with three tags (1.27 / 1.26 / 1.25-alpine —
    // a real docker host never shows two images under one repo:tag).
    // keepLast=1 keeps the newest (aaaa); the two older versions
    // (bbbb, cccc) are the prune candidates.
    expect(result.removed.sort()).toEqual(['sha256:bbbb', 'sha256:cccc']);
    // No docker rm call on dryRun.
    expect(execState.rmCalls).toEqual([]);
  });

  // r017 regression: retention groups must be per REPOSITORY. A repo:tag
  // reference maps to exactly one image id in docker (re-tagging moves
  // it), so grouping by repo:tag yielded singleton groups and keepLast>=1
  // protected the whole tagged inventory — the prune deleted nothing.
  it('keeps the N newest versions of a repo and retires only older ones (r017)', async () => {
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', { stdout: IMG_LS_JSON });
    execState.byArgs.set('docker ps -aq --no-trunc', { stdout: '' });
    const result = await pruneImages({ keepLast: 2, dryRun: true });
    // keepLast=2 protects the two newest nginx versions (aaaa, bbbb);
    // only the oldest (cccc) is a candidate.
    expect(result.removed).toEqual(['sha256:cccc']);
    expect(result.removedLabels).toEqual(['nginx:1.25-alpine']);
  });

  it('skips in-use images even when they would otherwise be candidates', async () => {
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', { stdout: IMG_LS_JSON });
    fakeContainers([{ container: 'c0ffee01', ref: 'nginx:1.27-alpine', imageId: 'sha256:aaaa' }]);
    const result = await pruneImages({ keepLast: 1, dryRun: true });
    // aaaa is the newest nginx image → protected, AND in use.
    // bbbb and cccc are older versions → candidates (neither
    // is in use).
    expect(result.removed).not.toContain('sha256:aaaa');
    expect(result.removed).toEqual(['sha256:bbbb', 'sha256:cccc']);
  });

  // r311 regression: with keepLast=0 nothing is protected by retention, so
  // the ONLY thing keeping an in-use image out of the candidate set is the
  // in-use check. It compared container image REFERENCES to sha256 ids and
  // never matched, so the dry-run offered the running nginx image.
  it('never offers an image a container runs from, even with keepLast=0 (r311)', async () => {
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', { stdout: IMG_LS_JSON });
    fakeContainers([
      { container: 'c0ffee01', ref: 'nginx:1.27-alpine', imageId: 'sha256:aaaa' },
      // started from a tag that has since moved — still pins bbbb
      { container: 'c0ffee02', ref: 'nginx:1.26-alpine', imageId: 'sha256:bbbb' },
    ]);
    const rows = await listImages();
    expect(rows.find((r) => r.id === 'sha256:aaaa')!.inUse).toBe(true);
    expect(rows.find((r) => r.id === 'sha256:bbbb')!.inUse).toBe(true);
    expect(rows.find((r) => r.id === 'sha256:cccc')!.inUse).toBe(false);
    const result = await pruneImages({ keepLast: 0, dryRun: true });
    expect(result.removed).toEqual(['sha256:cccc']);
  });

  it('a container that vanishes between ps and inspect does not blind the rest (r311)', async () => {
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', { stdout: IMG_LS_JSON });
    fakeContainers([
      { container: 'c0ffee01', ref: 'nginx:1.27-alpine', imageId: 'sha256:aaaa' },
      { container: 'deadbeef', ref: 'nginx:1.25-alpine', imageId: 'sha256:cccc' },
    ]);
    // the batch inspect fails (one id is gone); the per-id retry for it too
    execState.byArgs.set('docker inspect --format {{.Image}} c0ffee01 deadbeef', { throw: new Error('No such object: deadbeef') });
    execState.byArgs.set('docker inspect --format {{.Image}} deadbeef', { throw: new Error('No such object: deadbeef') });
    const rows = await listImages();
    expect(rows.find((r) => r.id === 'sha256:aaaa')!.inUse).toBe(true);
    expect(rows.find((r) => r.id === 'sha256:cccc')!.inUse).toBe(false);
  });

  it('no containers at all: no docker inspect is issued (r311)', async () => {
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', { stdout: IMG_LS_JSON });
    fakeContainers([]);
    const { capture } = await import('../../src/lib/exec.js');
    const calls = (capture as unknown as { mock: { calls: Array<[string, string[]]> } }).mock.calls;
    const before = calls.length;
    const rows = await listImages();
    expect(rows.every((r) => !r.inUse)).toBe(true);
    expect(calls.slice(before).some(([, args]) => args[0] === 'inspect')).toBe(false);
  });

  it('filters by olderThanHours on the candidate set', async () => {
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', { stdout: IMG_LS_JSON });
    execState.byArgs.set('docker ps -aq --no-trunc', { stdout: '' });
    // With keepLast=1, the protected set is {aaaa}. Candidates
    // by age: bbbb is 2h old (too young for 12h), cccc is 24h
    // old (old enough) → only cccc is pruned.
    const result = await pruneImages({ keepLast: 1, olderThanHours: 12, dryRun: true });
    expect(result.removed).toEqual(['sha256:cccc']);
  });

  it('performs the real delete via `docker image rm` in 50-id chunks', async () => {
    // 60 repositories, each with 3 tagged versions (newest,
    // middle, oldest). keepLast=1 protects the newest of each
    // → 2 candidates per repo × 60 repos = 120 candidates.
    // 120 ids / 50 per chunk = 3 chunks (50 + 50 + 20).
    const lines: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      for (let v = 0; v < 3; v += 1) {
        const id = `sha256:${(i * 3 + v).toString().padStart(4, '0')}`;
        lines.push(
          JSON.stringify({
            Repository: `x${i}`,
            Tag: `v${v}`,
            ID: id,
            Size: '1MB',
            // v=0 newest (1h ago), v=1 middle (2h ago), v=2 oldest (3h ago).
            CreatedAt: new Date(Date.now() - (v + 1) * 3_600_000).toISOString(),
          }),
        );
      }
    }
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', {
      stdout: lines.join('\n'),
    });
    execState.byArgs.set('docker ps -aq --no-trunc', { stdout: '' });
    const result = await pruneImages({ keepLast: 1, dryRun: false });
    expect(result.removed).toHaveLength(120);
    expect(execState.rmCalls).toHaveLength(3);
    expect(execState.rmCalls[0]?.args.length).toBe(52); // 50 ids + 'image' + 'rm'
    expect(execState.rmCalls[2]?.args.length).toBe(22); // 20 ids + 2
  });

  it('treats keepLast=0 as "keep nothing" — every non-dangling image is a candidate', async () => {
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', { stdout: IMG_LS_JSON });
    execState.byArgs.set('docker ps -aq --no-trunc', { stdout: '' });
    // The fixture has 3 non-dangling images (aaaa, bbbb, cccc)
    // and 1 dangling (dddd). keepLast=0 protects none of the
    // non-dangling images → all 3 are candidates.
    const result = await pruneImages({ keepLast: 0, dryRun: true });
    expect(result.removed.sort()).toEqual(['sha256:aaaa', 'sha256:bbbb', 'sha256:cccc']);
    // 142 + 150 + 130 = 422 MB.
    expect(result.freedBytes).toBe((142 + 150 + 130) * 1024 * 1024);
  });

  it('clamps keepLast to the per-group size — never deletes the only image of a tag', async () => {
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', { stdout: IMG_LS_JSON });
    execState.byArgs.set('docker ps -aq --no-trunc', { stdout: '' });
    // The nginx repository has 3 images; keepLast=10 exceeds the
    // group size, so keep=min(10,3)=3 protects all of them.
    // Nothing is removed.
    const result = await pruneImages({ keepLast: 10, dryRun: true });
    expect(result.removed).toEqual([]);
  });
});

describe('parseHumanBytes / parseReclaimedBytes', () => {
  it('parses human-readable sizes through listImages', async () => {
    // The lib has no public export for the helpers, but `sizeBytes`
    // on the result row reflects the same parser. Cover the
    // size-suffix branches via docker JSON output.
    const lines = [
      JSON.stringify({
        Repository: 'a',
        Tag: 't',
        ID: 'sha256:1',
        Size: '1.5GB',
        CreatedAt: new Date().toISOString(),
      }),
      JSON.stringify({
        Repository: 'b',
        Tag: 't',
        ID: 'sha256:2',
        Size: '512B',
        CreatedAt: new Date().toISOString(),
      }),
    ].join('\n');
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', {
      stdout: lines,
    });
    execState.byArgs.set('docker ps -aq --no-trunc', { stdout: '' });
    const rows = await listImages();
    const one = rows.find((r) => r.id === 'sha256:1')!;
    expect(one.sizeBytes).toBe(Math.round(1.5 * 1024 * 1024 * 1024));
    const two = rows.find((r) => r.id === 'sha256:2')!;
    expect(two.sizeBytes).toBe(512);
  });

  it('returns ageHours=0 when the createdAt date is unparseable', async () => {
    const lines = JSON.stringify({
      Repository: 'a',
      Tag: 't',
      ID: 'sha256:bad',
      Size: '1B',
      CreatedAt: 'not a date',
    });
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', {
      stdout: lines,
    });
    execState.byArgs.set('docker ps -aq --no-trunc', { stdout: '' });
    const rows = await listImages();
    expect(rows[0]?.ageHours).toBe(0);
  });

  it('falls back to the empty in-use set when docker ps throws', async () => {
    const lines = JSON.stringify({
      Repository: 'a',
      Tag: 't',
      ID: 'sha256:1',
      Size: '1B',
      CreatedAt: new Date().toISOString(),
    });
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', {
      stdout: lines,
    });
    execState.byArgs.set('docker ps -aq --no-trunc', {
      throw: new Error('Cannot connect to the Docker daemon'),
    });
    // No throw — the lib swallows the ps error and treats every
    // image as not in use.
    const rows = await listImages();
    expect(rows[0]?.inUse).toBe(false);
  });
});

describe('pruneImages error + edge branches', () => {
  it('throws a friendly error when docker image prune fails (danglingOnly)', async () => {
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', { stdout: '' });
    execState.byArgs.set('docker ps -aq --no-trunc', { stdout: '' });
    execState.byArgs.set('docker image prune -f', {
      throw: new Error('No such image'),
    });
    await expect(pruneImages({ danglingOnly: true })).rejects.toThrow(
      /docker image prune failed/,
    );
  });

  it('continues with the remaining chunks when one docker image rm fails', async () => {
    // 60 repositories, each with 2 tagged versions. With
    // keepLast=1: 1 protected per repo, 1 candidate per repo
    // → 60 candidates → 2 chunks (50 + 10). The first chunk
    // throws; the second still goes through.
    const lines: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      for (let v = 0; v < 2; v += 1) {
        const id = `sha256:${(i * 2 + v).toString().padStart(4, '0')}`;
        lines.push(
          JSON.stringify({
            Repository: `x${i}`,
            Tag: `v${v}`,
            ID: id,
            Size: '1MB',
            CreatedAt: new Date(Date.now() - (v + 1) * 3_600_000).toISOString(),
          }),
        );
      }
    }
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', {
      stdout: lines.join('\n'),
    });
    execState.byArgs.set('docker ps -aq --no-trunc', { stdout: '' });
    // Throw for the first chunk's docker image rm, succeed for the second.
    const originalRun = execState.toolResults;
    void originalRun;
    let rmCount = 0;
    // Re-route run to throw on the first call, succeed after.
    const { run } = await import('../../src/lib/exec.js');
    (run as { mockImplementation: (fn: (...a: unknown[]) => Promise<void>) => void }).mockImplementation(
      async (tool: string, args: string[]) => {
        if (tool === 'docker' && args[0] === 'image' && args[1] === 'rm') {
          rmCount += 1;
          if (rmCount === 1) throw new Error('first chunk failed');
        }
      },
    );
    try {
      const result = await pruneImages({ keepLast: 1, dryRun: false });
      // Only the second chunk's ids land in `removed`.
      expect(rmCount).toBe(2);
      expect(result.removed).toHaveLength(10);
    } finally {
      // Restore the simple mock by re-importing + resetting the mock.
      (run as { mockReset: () => void }).mockReset();
      (run as { mockImplementation: (fn: (...a: unknown[]) => Promise<void>) => void }).mockImplementation(
        async (tool: string, args: string[]) => {
          if (tool === 'docker' && args[0] === 'image' && args[1] === 'rm') {
            execState.rmCalls.push({ args });
          }
        },
      );
    }
  });
});

describe('formatBytes via listImages / pruneImages output', () => {
  it('formats the freed-bytes summary in MB when candidates are small', async () => {
    execState.byArgs.set('docker image ls --no-trunc --format {{json .}}', { stdout: IMG_LS_JSON });
    execState.byArgs.set('docker ps -aq --no-trunc', { stdout: '' });
    const result = await pruneImages({ keepLast: 1, dryRun: true });
    // The dryRun output is `dryRun: would remove N images (X<unit>)`.
    expect(result.output).toMatch(/dryRun: would remove \d+ images \(\d/);
  });
});

describe('parseHumanBytes', () => {
  it.each([
    ['0B', 0],
    ['100B', 100],
    ['1KB', 1024],
    ['1.5KB', Math.round(1.5 * 1024)],
    ['1MB', 1024 * 1024],
    ['1.5MB', Math.round(1.5 * 1024 * 1024)],
    ['1GB', 1024 * 1024 * 1024],
    ['1.5GB', Math.round(1.5 * 1024 * 1024 * 1024)],
    ['1TB', 1024 ** 4],
    ['1.5TB', Math.round(1.5 * 1024 ** 4)],
    ['1PB', 1024 ** 5],
    ['1.5PB', Math.round(1.5 * 1024 ** 5)],
    ['  1KB  ', 1024], // surrounding whitespace is trimmed
  ])('parses %s', (input, expected) => {
    expect(parseHumanBytes(input)).toBe(expected);
  });

  it('returns 0 for empty / unparseable input', () => {
    expect(parseHumanBytes('')).toBe(0);
    expect(parseHumanBytes('garbage')).toBe(0);
  });
});

describe('parseReclaimedBytes', () => {
  it.each([
    ['Total reclaimed space: 12.0MB', 12 * 1024 * 1024],
    ['Total reclaimed space: 1.5GB (something)', Math.round(1.5 * 1024 ** 3)],
    ['Total reclaimed space: 1TB', 1024 ** 4],
    ['Total reclaimed space: 0B', 0],
  ])('parses %s', (input, expected) => {
    expect(parseReclaimedBytes(input)).toBe(expected);
  });

  it('returns 0 when the summary line is missing', () => {
    expect(parseReclaimedBytes('no summary here')).toBe(0);
    expect(parseReclaimedBytes('')).toBe(0);
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0B'],
    [100, '100B'],
    [1024, '1.0KB'],
    [1024 * 1024, '1.0MB'],
    [1024 * 1024 * 1024, '1.0GB'],
    [1024 ** 4, '1.0TB'],
    // Above 100 → no decimal.
    [100 * 1024 ** 3, '100GB'],
    [1500, '1.5KB'],
  ])('formats %i as %s', (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });
});











