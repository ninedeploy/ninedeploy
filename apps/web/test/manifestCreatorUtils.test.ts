/**
 * Unit tests for the Manifest Creator's pure helpers: the live zod
 * validation mapping, the YAML highlighter tokenizer, the client secret
 * lint, the persisted active-section helper, and the preset library's
 * integrity (every preset must parse against the deploy schema).
 */
import { describe, expect, it } from 'vitest';
import {
  ninedeployManifest,
  type NinedeployManifest,
} from '@ninedeploy/schemas';
import { validateManifest } from '../src/routes/manifestCreator/validation.js';
import { highlightYaml, YAML_TOKEN_CLASS } from '../src/routes/manifestCreator/highlightYaml.js';
import { lintManifest } from '../src/routes/manifestCreator/secretScan.js';
import { loadActiveSection, saveActiveSection, SECTIONS, SECTION_GROUPS } from '../src/routes/manifestCreator/state.js';
import { PRESETS } from '../src/routes/manifestCreator/presets.js';

describe('validateManifest', () => {
  it('returns no issues for a valid manifest', () => {
    const manifest: NinedeployManifest = {
      version: '1',
      runtime: { type: 'node', version: '22' },
      run: { port: 3000 },
    };
    expect(validateManifest(manifest)).toEqual([]);
  });

  it('maps a nested field issue back to its nav section', () => {
    const manifest = { version: '1', run: { port: 70_000 } } as unknown as NinedeployManifest;
    const issues = validateManifest(manifest);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.sectionId).toBe('run');
    expect(issues[0]?.path).toBe('run.port');
  });

  it('maps route array issues to the routing section', () => {
    const manifest = {
      version: '1',
      routes: [{ host: 'a', path: '/', ssl: true }],
    } as unknown as NinedeployManifest;
    const issues = validateManifest(manifest);
    expect(issues.some((i) => i.sectionId === 'routing' && i.path.startsWith('routes.0'))).toBe(
      true,
    );
  });

  it('returns sectionId null for root-level issues (bad version)', () => {
    const manifest = { version: '2' } as unknown as NinedeployManifest;
    const issues = validateManifest(manifest);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.sectionId === null)).toBe(true);
  });

  it('validates every shipped preset against the deploy schema', () => {
    for (const preset of PRESETS) {
      const result = ninedeployManifest.safeParse(preset.manifest);
      expect(
        result.success,
        `preset "${preset.id}" failed schema validation`,
      ).toBe(true);
    }
  });
});

describe('preset library integrity', () => {
  it('has unique preset ids', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every section id inside exactly one nav group', () => {
    const grouped = SECTION_GROUPS.flatMap((g) => [...g.sectionIds]);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(SECTIONS.map((s) => s.id).sort());
  });
});

describe('highlightYaml', () => {
  it('marks the emitter header comments', () => {
    const [line] = highlightYaml('# .ninedeploy — NineDeploy project manifest.');
    expect(line?.tokens).toEqual([{ text: '# .ninedeploy — NineDeploy project manifest.', kind: 'comment' }]);
    expect(YAML_TOKEN_CLASS.comment).toContain('slate-500');
  });

  it('splits keys from quoted string values', () => {
    const [line] = highlightYaml('  start: "npm start"');
    const kinds = line?.tokens.map((t) => t.kind);
    expect(kinds).toEqual(['plain', 'key', 'key', 'plain', 'string']);
  });

  it('classifies numbers and booleans', () => {
    const [port] = highlightYaml('  port: 3000');
    expect(port?.tokens.at(-1)?.kind).toBe('number');
    const [spa] = highlightYaml('  spa: true');
    expect(spa?.tokens.at(-1)?.kind).toBe('boolean');
  });

  it('leaves bare plain scalars plain', () => {
    const [line] = highlightYaml('  type: node');
    expect(line?.tokens.at(-1)?.kind).toBe('plain');
  });

  it('highlights keys inside list items via the dash recursion', () => {
    const [line] = highlightYaml('  - host: "app.example.com"');
    const kinds = line?.tokens.map((t) => t.kind);
    expect(kinds).toEqual(['plain', 'plain', 'key', 'key', 'plain', 'string']);
  });

  it('tokenizes bare list scalars', () => {
    const [line] = highlightYaml('      - python310');
    const last = line?.tokens.at(-1);
    expect(last?.kind).toBe('plain');
    expect(last?.text).toBe('python310');
  });

  it('splits trailing comments outside quotes', () => {
    const [line] = highlightYaml('  port: 3000 # the app port');
    const kinds = line?.tokens.map((t) => t.kind);
    expect(kinds).toContain('comment');
    expect(line?.tokens.at(-1)?.text).toBe(' # the app port');
  });

  it('keeps an inner # inside quoted strings', () => {
    const [line] = highlightYaml('  install: "npm ci # not a comment"');
    expect(line?.tokens.some((t) => t.kind === 'comment')).toBe(false);
  });

  it('returns an empty token list for blank lines', () => {
    const [line] = highlightYaml('');
    expect(line?.tokens).toEqual([]);
  });

  it('treats unkeyed indent-only lines as plain', () => {
    const [line] = highlightYaml('   random text');
    expect(line?.tokens).toEqual([{ text: '   random text', kind: 'plain' }]);
  });

  it('handles multi-line documents', () => {
    const lines = highlightYaml('version: "1"\nruntime:\n  type: go\n');
    expect(lines).toHaveLength(4);
  });
});

describe('lintManifest', () => {
  it('flags a GitHub PAT with the shared server pattern id', () => {
    const token = ['ghp', 'ABCDEF0123456789abcdef0123456789abcd'].join('_');
    const manifest = { version: '1', build: { install: `echo ${token}` } } as NinedeployManifest;
    const hits = lintManifest(manifest);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.patternId).toBe('github-pat-classic');
    expect(hits[0]?.path).toBe('build.install');
  });

  it('walks arrays and records the index path', () => {
    const manifest = {
      version: '1',
      routes: [{ host: 'x.com', path: '/', ssl: true, ipAllowlist: ['AKIAIOSFODNN7EXAMPLE'] }],
    } as unknown as NinedeployManifest;
    const hits = lintManifest(manifest);
    expect(hits[0]?.path).toBe('routes[0].ipAllowlist[0]');
    expect(hits[0]?.patternId).toBe('aws-access-key');
  });

  it('returns nothing for a clean manifest', () => {
    expect(lintManifest({ version: '1' })).toEqual([]);
  });
});

describe('active-section persistence', () => {
  it('returns null when nothing was saved', () => {
    window.localStorage.clear();
    expect(loadActiveSection(SECTIONS.map((s) => s.id))).toBeNull();
  });

  it('round-trips a saved section id', () => {
    saveActiveSection('routing');
    expect(loadActiveSection(SECTIONS.map((s) => s.id))).toBe('routing');
  });

  it('rejects an id that no longer matches a section', () => {
    window.localStorage.setItem('ninedeploy.manifest.section', 'nonexistent');
    expect(loadActiveSection(SECTIONS.map((s) => s.id))).toBeNull();
  });
});
