import { describe, expect, it } from 'vitest';
import { doctorActionKind, doctorFindingKind } from '@ninedeploy/schemas';
import {
  auditAllSlugs,
  auditSlugRows,
  isCanonicalSlug,
  proposeRepair,
  slugTableInfo,
} from '../../src/lib/slugAudit.js';

// r030: slugify() was fixed for NEW rows in r028 (stranded trailing hyphen) and
// r029 (one-character slug). Both fixes are forward-only, so rows already
// written by older builds still hold slugs the canonical `slug` contract
// rejects — and such a row is one its own API refuses to round-trip. This
// module audits those rows; the grammar lives in the schema, not a copy here.

describe('isCanonicalSlug', () => {
  it('accepts what the canonical schema accepts', () => {
    expect(isCanonicalSlug('web')).toBe(true);
    expect(isCanonicalSlug('a'.repeat(63))).toBe(true);
    expect(isCanonicalSlug('my-app-2')).toBe(true);
  });

  it('rejects the two legacy classes and illegal shapes', () => {
    expect(isCanonicalSlug('a')).toBe(false); // r029 single char
    expect(isCanonicalSlug(`${'a'.repeat(62)}-`)).toBe(false); // r028 stranded hyphen
    expect(isCanonicalSlug('')).toBe(false);
    expect(isCanonicalSlug(null)).toBe(false);
    expect(isCanonicalSlug('Foo_Bar')).toBe(false);
    expect(isCanonicalSlug('a'.repeat(64))).toBe(false);
  });
});

describe('auditSlugRows', () => {
  it('reports nothing for a healthy table', () => {
    expect(auditSlugRows('projects', [{ id: 1, slug: 'web', name: 'Web' }])).toEqual([]);
  });

  it('flags a row whose stored slug violates the contract', () => {
    const [v] = auditSlugRows('projects', [{ id: 7, slug: 'a', name: 'Alpha' }]);
    expect(v).toMatchObject({ table: 'projects', id: 7, current: 'a', dockerBound: false });
    expect(v?.reason).toContain('single-character');
    // The repair prefers the row's real name (what the fixed create route would
    // have stored) and only falls back to doubling when no name is usable.
    expect(v?.recommended).toBe('alpha');
    expect(proposeRepair({ id: 7, slug: 'a', name: null }, new Set())).toBe('aa');
  });

  it('detects the r028 stranded-hyphen class at the 63-char boundary', () => {
    const bad = `${'a'.repeat(62)}-`;
    const [v] = auditSlugRows('workspaces', [{ id: 3, slug: bad, name: 'Team' }]);
    expect(v?.current).toBe(bad);
    // Repair re-derives from the name through the fixed slugify.
    expect(v?.recommended).toBe('team');
  });

  it('never proposes a slug already taken by a sibling row', () => {
    const rows = [
      { id: 1, slug: 'aa', name: 'First' },
      { id: 2, slug: 'a', name: 'a' },
    ];
    const [v] = auditSlugRows('projects', rows);
    expect(v?.recommended).toBe('aa-2');
    expect(isCanonicalSlug(v?.recommended ?? '')).toBe(true);
  });

  it('refuses to auto-repair a Docker-bound slug, which is also a volume name', () => {
    // Renaming only the row would orphan nd-svc-<slug>-data and its bridge.
    const [v] = auditSlugRows('services', [{ id: 11, slug: 'a', name: 'Api' }]);
    expect(v?.dockerBound).toBe(true);
    expect(v?.recommended).toBeNull();
    expect(slugTableInfo('services').dockerBound).toBe(true);
    expect(slugTableInfo('projects').dockerBound).toBe(false);
  });

  it('proposeRepair returns null when no collision-free candidate exists', () => {
    expect(proposeRepair({ id: 1, slug: 'a', name: 'a' }, new Set(['aa', 'aa-1']))).toBeNull();
  });
});

describe('auditAllSlugs', () => {
  it('scans only the tables handed to it', () => {
    const out = auditAllSlugs({
      projects: [{ id: 1, slug: 'x', name: 'X' }],
      databases: [{ id: 2, slug: 'ok-db', name: 'DB' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ table: 'projects', id: 1, dockerBound: false });
  });
});

describe('doctor contract', () => {
  it('exposes the invalid_slug finding and the repair_slug action', () => {
    expect(doctorFindingKind.options).toContain('invalid_slug');
    expect(doctorActionKind.options).toContain('repair_slug');
  });
});
