import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ABOUT, CHANGELOG, VERSION } from '../src/version.js';

describe('version', () => {
  it('ABOUT exposes the expected identity fields', () => {
    expect(ABOUT.name).toBe('NineDeploy');
    expect(ABOUT.version).toBe(VERSION);
    expect(ABOUT.description).toContain('Self-hosted deployment platform');
    expect(ABOUT.license).toBe('MIT');
    expect(ABOUT.repo).toMatch(/^https:\/\/github\.com\//);
    expect(ABOUT.docs).toMatch(/^https:\/\//);
  });

  it('ABOUT lists a tech stack with category/item pairs', () => {
    expect(ABOUT.techStack.length).toBeGreaterThan(0);
    for (const entry of ABOUT.techStack) {
      expect(typeof entry.category).toBe('string');
      expect(Array.isArray(entry.items)).toBe(true);
      expect(entry.items.length).toBeGreaterThan(0);
    }
  });

  it('ABOUT links to the changelog and the current release entry', () => {
    expect(ABOUT.changelog).toBe(CHANGELOG);
    expect(CHANGELOG.length).toBeGreaterThan(0);
    // The newest entry always documents the running version; its title changes
    // per release, so only assert it is a non-empty string.
    expect(CHANGELOG[0]?.version).toBe(VERSION);
    expect(typeof CHANGELOG[0]?.title).toBe('string');
    expect(CHANGELOG[0]!.title!.length).toBeGreaterThan(0);
    expect(CHANGELOG[0]?.changes.length).toBeGreaterThan(0);
  });

  it('ships no placeholder or duplicate changelog entries', () => {
    // v0.10.0 went out with two "Placeholder — fill in …" stubs on the About
    // page: the bump script stacked one per run and nothing checked.
    for (const entry of CHANGELOG) {
      for (const change of entry.changes) expect(change, entry.version).not.toMatch(/Placeholder/);
    }
    const versions = CHANGELOG.map((e) => e.version);
    expect(versions.filter((v, i) => versions.indexOf(v) !== i)).toEqual([]);
  });

  it('every changelog.json entry has the ChangelogEntry shape', () => {
    // changelog.json is plain data imported into a typed array, so tsc does not
    // check it field by field — a hand edit with a typo'd key, an empty title or
    // a non-string change would only surface as a broken About page.
    // Read the raw file (not the typed CHANGELOG) so extra keys are visible too.
    const raw: unknown = JSON.parse(readFileSync(new URL('../src/changelog.json', import.meta.url), 'utf8'));
    expect(Array.isArray(raw)).toBe(true);
    const entries = raw as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    entries.forEach((entry, i) => {
      const where = `changelog.json[${i}] (${String(entry?.version)})`;
      expect(entry, where).toBeTypeOf('object');
      expect(Object.keys(entry).sort(), where).toEqual(['changes', 'date', 'title', 'version']);
      expect(entry.version, where).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.date, where).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(String(entry.date))), `${where}: date`).toBe(false);
      expect(typeof entry.title, where).toBe('string');
      expect(String(entry.title).trim(), `${where}: title`).not.toBe('');
      expect(Array.isArray(entry.changes), `${where}: changes`).toBe(true);
      const changes = entry.changes as unknown[];
      expect(changes.length, `${where}: changes`).toBeGreaterThan(0);
      for (const change of changes) {
        expect(typeof change, `${where}: change`).toBe('string');
        expect(String(change).trim(), `${where}: change`).not.toBe('');
      }
    });
  });

  it('changelog.json is ordered newest first (strictly descending versions)', () => {
    const parts = (v: string) => v.split('.').map(Number) as [number, number, number];
    for (let i = 1; i < CHANGELOG.length; i++) {
      const [a, b] = [parts(CHANGELOG[i - 1]!.version), parts(CHANGELOG[i]!.version)];
      const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      expect(cmp, `${CHANGELOG[i - 1]!.version} must be newer than ${CHANGELOG[i]!.version}`).toBeGreaterThan(0);
    }
  });

  it('VERSION is a semver-shaped string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
