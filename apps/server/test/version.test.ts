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

  it('VERSION is a semver-shaped string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
