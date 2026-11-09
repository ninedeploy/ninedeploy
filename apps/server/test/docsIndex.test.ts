/**
 * C3 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): docs/README.md indexes every
 * document under docs/, so a new guide is never left unfindable and every
 * link in the index points at a file that exists.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const docs = new URL('../../../docs/', import.meta.url);
const index = readFileSync(new URL('README.md', docs), 'utf8');
const linked = new Set([...index.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)].map((m) => m[1]!));

describe('docs/README.md', () => {
  it('links every document in docs/ and docs/plans/', () => {
    const files = [
      ...readdirSync(docs).filter((f) => f.endsWith('.md') && f !== 'README.md'),
      ...readdirSync(new URL('plans/', docs)).filter((f) => f.endsWith('.md')).map((f) => `plans/${f}`),
    ];
    expect(files.filter((f) => !linked.has(f))).toEqual([]);
  });

  it('links only files that exist', () => {
    expect([...linked].filter((f) => !existsSync(new URL(f, docs)))).toEqual([]);
  });
});
