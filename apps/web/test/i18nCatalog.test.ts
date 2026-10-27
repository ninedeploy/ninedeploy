import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TR } from '../src/locales/tr.js';
import { translate } from '../src/lib/i18n.js';

/**
 * G4.6: the English source text is the message key, so the catalogue can only
 * drift two ways — a `t('…')` / `msg('…')` literal with no Turkish entry
 * (renders English on a Turkish screen) or an entry no code asks for any more
 * (dead weight after a wording change). Both fail here.
 */

const SRC = resolve(__dirname, '../src');
const LITERAL = /\b(?:t|msg)\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !path.includes(`${join('src', 'locales')}`) ? [path] : [];
  });
}

function usedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    for (const m of readFileSync(file, 'utf8').matchAll(LITERAL)) {
      keys.add((m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1'));
    }
  }
  return keys;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n catalogue', () => {
  const used = usedKeys();

  it('finds the extracted strings', () => {
    expect(used.size).toBeGreaterThan(100);
  });

  it('has a Turkish entry for every t()/msg() literal', () => {
    const missing = [...used].filter((k) => !(k in TR)).sort();
    expect(missing).toEqual([]);
  });

  it('has no Turkish entry that no code uses', () => {
    const unused = Object.keys(TR).filter((k) => !used.has(k)).sort();
    expect(unused).toEqual([]);
  });

  it('keeps the same placeholders in every translation', () => {
    const mismatched = Object.entries(TR)
      .filter(([en, tr]) => placeholders(en).join() !== placeholders(tr).join())
      .map(([en]) => en);
    expect(mismatched).toEqual([]);
  });

  it('has no empty or untranslated-looking entries', () => {
    expect(Object.entries(TR).filter(([, tr]) => tr.trim() === '').map(([en]) => en)).toEqual([]);
  });

  it('fills placeholders and falls back to English', () => {
    expect(translate('tr', 'Sign out')).toBe(TR['Sign out']);
    expect(translate('en', '{n} running', { n: 3 })).toBe('3 running');
    expect(translate('tr', 'not in the catalogue {x}', { x: 1 })).toBe('not in the catalogue 1');
  });
});
