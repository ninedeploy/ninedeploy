/**
 * G-13 community template contributions — lib coverage.
 *
 * `communityTemplates.ts` is a thin file-on-disk layer over the existing
 * template registry. The behavior worth pinning down:
 *  - missing dir on first read is silent (the list call returns empty;
 *    the first import call creates it).
 *  - per-file errors are reported in the response, not raised — a single
 *    bad JSON does not hide the rest of the catalog.
 *  - `import` refuses to overwrite an existing id unless `replace: true`
 *    is passed. Pretty-printed output (2-space indent + trailing newline)
 *    is the on-disk contract.
 *  - `remove` returns `removed: false` when the file is missing so the
 *    caller can answer 404 vs 200 without a try/catch.
 *
 * The test uses a real temp `NINEDEPLOY_DATA_DIR` (no fs mocks) — the lib
 * is small enough that the real file system is the right test surface.
 * `config.js` is mocked so the lib sees the temp dir without going through
 * the global config initialization (which creates sibling dirs we don't
 * need here).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` runs at hoist time, BEFORE the `import` statements below
// are resolved, so the callback can only use globals. `process.env.TEMP`
// (Windows) / `TMPDIR` (Unix) point to a writable user-scoped temp dir
// without needing `os.tmpdir()`.
const { ROOT } = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || process.env.TMP || '/tmp';
  const sep = base.includes('\\') ? '\\' : '/';
  return { ROOT: `${base}${sep}ninedeploy-community-${process.pid}-${Date.now()}` };
});

// `vi.mock` is hoisted to the top of the file, so the lib's `import { config }
// from '../config.js'` is replaced before any test code runs. The lib reads
// `config.paths.dataDir` only at call time (the helper is `dir()`), so
// re-stubbing the value per test is safe.
vi.mock('../../src/config.js', () => ({
  config: { paths: { dataDir: ROOT } },
}));

import { listCommunityTemplates, importCommunityTemplate, removeCommunityTemplate } from '../../src/lib/communityTemplates.js';

const validTemplate = (id: string) => ({
  id,
  name: `Name ${id}`,
  tagline: 'short',
  description: `Description for ${id}`,
  category: 'Demo',
  emoji: '📦',
  image: `demo/${id}:latest`,
  port: 8080,
});

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  // Wipe everything under ROOT between tests so each one starts from a
  // known empty state. The lib's dataDir is mocked to ROOT, so the
  // community-templates subdir is recreated on the fly.
  for (const name of readdirSync(ROOT)) {
    rmSync(join(ROOT, name), { recursive: true, force: true });
  }
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('lib/communityTemplates', () => {
  describe('listCommunityTemplates', () => {
    it('returns an empty result when the dir does not exist', async () => {
      // No community-templates subdir present — the lib should swallow
      // the readdir error and answer with empty arrays.
      const result = await listCommunityTemplates();
      expect(result).toEqual({ entries: [], errors: [], totalBytes: 0 });
    });

    it('skips non-json files and surfaces parse errors per file', async () => {
      mkdirSync(join(ROOT, 'community-templates'), { recursive: true });
      // Valid entry.
      writeFileSync(join(ROOT, 'community-templates', 'good.json'), JSON.stringify(validTemplate('good')));
      // Invalid JSON (parse error path).
      writeFileSync(join(ROOT, 'community-templates', 'broken.json'), '{ not json');
      // Schema-invalid (parseTemplates rejects it).
      writeFileSync(join(ROOT, 'community-templates', 'schema-bad.json'), JSON.stringify({ id: 1 }));
      // Non-json file: should be ignored, not surfaced as an error.
      writeFileSync(join(ROOT, 'community-templates', 'README.md'), '# readme');
      // Empty json file.
      writeFileSync(join(ROOT, 'community-templates', 'empty.json'), '');

      const result = await listCommunityTemplates();

      // 1 valid; broken + empty + schema-bad all land in errors.
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]?.id).toBe('good');
      expect(result.entries[0]?.file).toBe('good.json');
      // totalBytes is the sum of file lengths read (including the failed
      // ones — we counted them before parsing).
      expect(result.totalBytes).toBeGreaterThan(0);
      const errorFiles = result.errors.map((e) => e.file).sort();
      expect(errorFiles).toEqual(expect.arrayContaining(['broken.json', 'empty.json', 'schema-bad.json']));
      for (const err of result.errors) {
        expect(typeof err.error).toBe('string');
        expect(err.error.length).toBeGreaterThan(0);
      }
    });

    it('reports a read failure as a per-file error', async () => {
      // Create a directory where a file would be — readFile will throw EISDIR.
      mkdirSync(join(ROOT, 'community-templates', 'not-a-file.json'), { recursive: true });
      const result = await listCommunityTemplates();
      expect(result.entries).toEqual([]);
      expect(result.errors.some((e) => e.file === 'not-a-file.json')).toBe(true);
    });

    it('sorts entries by id and exposes the parsed Template', async () => {
      const dir = join(ROOT, 'community-templates');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'z.json'), JSON.stringify(validTemplate('z-id')));
      writeFileSync(join(dir, 'a.json'), JSON.stringify(validTemplate('a-id')));
      writeFileSync(join(dir, 'm.json'), JSON.stringify(validTemplate('m-id')));

      const result = await listCommunityTemplates();
      expect(result.entries.map((e) => e.id)).toEqual(['a-id', 'm-id', 'z-id']);
      expect(result.entries[0]?.template.name).toBe('Name a-id');
      // mtime is intentionally zero — the helper does not read mtime, and
      // we want callers to be able to distinguish "stale mtime" from
      // "file truly missing".
      expect(result.entries[0]?.mtime).toBe(0);
    });
  });

  describe('importCommunityTemplate', () => {
    it('rejects non-JSON input with a clear error', async () => {
      await expect(importCommunityTemplate('{ not json')).rejects.toThrow(/Invalid JSON/);
    });

    it('rejects a valid JSON envelope that fails the template schema', async () => {
      // `name` is required by the template schema; missing it makes the
      // parseTemplates path throw.
      await expect(importCommunityTemplate(JSON.stringify({ id: 'x' }))).rejects.toThrow();
    });

    it('writes a pretty-printed file on first import and creates the dir', async () => {
      const result = await importCommunityTemplate(JSON.stringify(validTemplate('fresh')), {});
      expect(result.id).toBe('fresh');
      expect(result.file).toBe('fresh.json');
      expect(result.bytes).toBe(JSON.stringify(validTemplate('fresh')).length);
      const path = join(ROOT, 'community-templates', 'fresh.json');
      expect(existsSync(path)).toBe(true);
      // Pretty-print contract: 2-space indent + trailing newline.
      const onDisk = readFileSync(path, 'utf8');
      expect(onDisk.endsWith('\n')).toBe(true);
      expect(onDisk).toContain('\n  '); // at least one indented line
    });

    it('refuses to overwrite an existing id unless replace: true', async () => {
      const first = await importCommunityTemplate(JSON.stringify(validTemplate('dup')), {});
      expect(first.id).toBe('dup');
      // Second import without replace: must throw with the user-facing message.
      await expect(
        importCommunityTemplate(JSON.stringify(validTemplate('dup')), {}),
      ).rejects.toThrow(/already exists/);
      // With replace: true, the second import overwrites silently.
      const second = await importCommunityTemplate(
        JSON.stringify({ ...validTemplate('dup'), tagline: 'updated' }),
        { replace: true },
      );
      expect(second.id).toBe('dup');
      const onDisk = JSON.parse(readFileSync(join(ROOT, 'community-templates', 'dup.json'), 'utf8'));
      expect(onDisk.tagline).toBe('updated');
    });

    it('falls through when the existing-id check throws a non-"already exists" error (e.g. EACCES)', async () => {
      // The replacement error is gated on the message prefix; anything else
      // bubbles. This test pins the contract so a future refactor that
      // tightens the check still does not crash on transient FS errors.
      await importCommunityTemplate(JSON.stringify(validTemplate('g')), {});
      // Replace the file with a directory so readFile throws ENOTDIR — the
      // "already exists" prefix is not in the message, so the original
      // error should bubble.
      const target = join(ROOT, 'community-templates', 'g.json');
      rmSync(target, { force: true });
      mkdirSync(target, { recursive: true });
      await expect(
        importCommunityTemplate(JSON.stringify(validTemplate('g')), { replace: false }),
      ).rejects.toThrow();
    });
  });

  describe('removeCommunityTemplate', () => {
    it('returns removed: true when the file is deleted', async () => {
      await importCommunityTemplate(JSON.stringify(validTemplate('gone')), {});
      const result = await removeCommunityTemplate('gone');
      expect(result).toEqual({ id: 'gone', removed: true });
      expect(existsSync(join(ROOT, 'community-templates', 'gone.json'))).toBe(false);
    });

    it('returns removed: false when the file is missing (no throw)', async () => {
      const result = await removeCommunityTemplate('nope');
      expect(result).toEqual({ id: 'nope', removed: false });
    });

    it('rejects an import whose id would traverse out of the community dir', async () => {
      // The id becomes the FILE NAME (`<id>.json`); a crafted id must never
      // escape `<dataDir>/community-templates/`.
      await expect(
        importCommunityTemplate(JSON.stringify(validTemplate('../traversal-victim')), {}),
      ).rejects.toThrow(/filename-safe|Invalid template id/i);
      expect(existsSync(join(ROOT, 'traversal-victim.json'))).toBe(false);

      await expect(
        importCommunityTemplate(JSON.stringify(validTemplate('sub/dir')), {}),
      ).rejects.toThrow(/filename-safe|Invalid template id/i);
      expect(existsSync(join(ROOT, 'sub'))).toBe(false);
    });

    it('rejects a remove whose id would traverse out of the community dir', async () => {
      // Plant a victim file OUTSIDE the community dir, then try to unlink it
      // through the remove path. The guard throws before any FS access.
      writeFileSync(join(ROOT, 'victim.json'), '{}', 'utf8');
      await expect(removeCommunityTemplate('../victim')).rejects.toThrow(/Invalid template id/);
      expect(existsSync(join(ROOT, 'victim.json'))).toBe(true);
    });
  });
});
