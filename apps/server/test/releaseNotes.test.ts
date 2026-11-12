/**
 * A6 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): user-facing release notes.
 * Each CHANGELOG.md version section opens with **Highlights** (at most three
 * bullets) and an **Action needed:** line; scripts/release-notes.mjs turns that
 * into the GitHub release body, the release workflow uses it, and the tag gate
 * refuses a version without it.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Summary = { highlights: string[]; action: string; markers: string[] };
const notes = (await import(new URL('../../../scripts/release-notes.mjs', import.meta.url).href)) as {
  changelogSection: (text: string, version: string) => string | null;
  releaseSummary: (section: string) => Summary;
  releaseBody: (o: { tag: string; repo: string; summary: Summary | null }) => string;
};
const root = fileURLToPath(new URL('../../../', import.meta.url));
const changelog = readFileSync(`${root}CHANGELOG.md`, 'utf8');

const section = (body: string) => `\n${body}\n\n### Added\n\n- a thing\n`;

describe('the release summary block', () => {
  it('reads Highlights, Action needed and stable markers from the top of a section', () => {
    const s = notes.releaseSummary(section('**Highlights**\n- one\n- two\n\n**Action needed:** Yes: update the agents.\n<!-- stable: security -->'));
    expect(s).toEqual({ highlights: ['one', 'two'], action: 'Yes: update the agents.', markers: ['<!-- stable: security -->'] });
    expect(notes.releaseSummary(section('**Highlights**\n- one\n\n**Action needed:** No.')).action).toBe('No.');
    expect(notes.releaseSummary(section('**Highlights**\n- one\n\n**Action needed:** No. Node agents can be updated later.')).action).toMatch(/^No\. Node/);
  });

  it('refuses a section without the block, or one that is not a summary', () => {
    const cases: Array<[string, RegExp]> = [
      ['', /does not start with a \*\*Highlights\*\*/],
      ['**Highlights**\n\n**Action needed:** No.', /has no bullet/],
      ['**Highlights**\n- 1\n- 2\n- 3\n- 4\n\n**Action needed:** No.', /4 bullets; keep at most 3/],
      ['**Highlights**\n- one', /no \*\*Action needed:\*\* line/],
      ['**Highlights**\n- one\n\n**Action needed:** maybe', /must read "No\."/],
      ['**Highlights**\n- one\n\n**Action needed:** Yes:', /must read "No\."/],
      [`**Highlights**\n- ${'x'.repeat(301)}\n\n**Action needed:** No.`, /longer than 300/],
    ];
    for (const [body, error] of cases) expect(() => notes.releaseSummary(section(body)), body).toThrow(error);
    // A block below the first ### heading does not count.
    expect(() => notes.releaseSummary('\n### Added\n\n**Highlights**\n- one\n\n**Action needed:** No.\n')).toThrow(/does not start/);
  });

  it('the release in progress already carries its block, so tagging it is not held up', () => {
    const s = notes.releaseSummary(notes.changelogSection(changelog, 'Unreleased')!);
    expect(s.highlights.length).toBeGreaterThan(0);
    expect(s.highlights.length).toBeLessThanOrEqual(3);
  });
});

describe('the GitHub release body', () => {
  it('leads with the highlights and the action, then the pull, verify and desktop notes, and carries the markers', () => {
    const body = notes.releaseBody({ tag: 'v9.9.9', repo: 'acme/nd', summary: { highlights: ['one', 'two'], action: 'No.', markers: ['<!-- stable: hold -->'] } });
    expect(body.startsWith('## Highlights\n\n- one\n- two\n\n**Action needed:** No.\n')).toBe(true);
    for (const part of ['docker pull ghcr.io/ninedeploy/ninedeploy:v9.9.9', '**Verify it:**', '**Desktop app:**', 'https://github.com/acme/nd/blob/v9.9.9/CHANGELOG.md']) expect(body).toContain(part);
    expect(body.trimEnd().endsWith('<!-- stable: hold -->')).toBe(true);
  });

  it('a release from before the block keeps the plain notes, and the CLI says why', () => {
    const plain = notes.releaseBody({ tag: 'v0.18.26', repo: 'acme/nd', summary: null });
    expect(plain.startsWith('See [CHANGELOG.md](https://github.com/acme/nd/blob/v0.18.26/CHANGELOG.md) for the full release notes.')).toBe(true);
    const run = spawnSync(process.execPath, ['scripts/release-notes.mjs', 'v0.18.26', 'CHANGELOG.md'], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'acme/nd' } });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('for the full release notes');
    expect(run.stderr).toMatch(/warning: the section does not start with a \*\*Highlights\*\*/);
    const check = spawnSync(process.execPath, ['scripts/release-notes.mjs', '--check', '0.18.26', 'CHANGELOG.md'], { cwd: root, encoding: 'utf8' });
    expect(check.status).toBe(1);
    expect(check.stderr).toMatch(/CHANGELOG ## \[0\.18\.26\]: the section does not start/);
  });
});

describe('wiring', () => {
  it('the release workflow builds the notes with the script, keeping the plain notes for a tag without it', () => {
    const wf = readFileSync(`${root}.github/workflows/release-publish.yml`, 'utf8').replace(/\r\n/g, '\n');
    expect(wf).toContain('if [ -f scripts/release-notes.mjs ]; then\n                node scripts/release-notes.mjs "$RELEASE_TAG" CHANGELOG.md > "$notes"');
    expect(wf).toMatch(/else\n\s+\{\n\s+printf 'See \[CHANGELOG\.md\]/);
  });

  it('the tag gate refuses a version whose section lacks the block', () => {
    const gate = readFileSync(`${root}scripts/tag-release.js`, 'utf8');
    expect(gate).toContain("sh('node', ['scripts/release-notes.mjs', '--check', bare, 'CHANGELOG.md']");
  });
});
