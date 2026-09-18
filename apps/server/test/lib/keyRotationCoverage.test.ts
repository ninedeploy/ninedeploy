/**
 * r178 — wiring guard: every settings row written through `encrypt()` must be
 * in keyRotation's SETTINGS_ENCRYPTED_KEYS, or rotating the master key leaves
 * it on the retired key (the AI diagnosis key was silently lost this way).
 * Scans the source rather than trusting a hand-kept list.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SETTINGS_ENCRYPTED_KEYS } from '../../src/lib/keyRotation.js';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('r178: key rotation covers every encrypted settings row', () => {
  it('finds no encrypt()-ed setting that rotation would skip', () => {
    const missing: string[] = [];
    for (const file of tsFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      // setSettingString(db, <KEY>, …encrypt(…) — KEY is a literal or a const.
      // The value argument is `encrypt(…)` or `cond ? encrypt(…) : …`.
      for (const m of src.matchAll(/setSettingString\(\s*[\w.]+\s*,\s*([\w'"]+)\s*,\s*(?:[\w.!]+\s*\?\s*)?encrypt\(/g)) {
        let key = m[1]!;
        if (!/^['"]/.test(key)) {
          const decl = new RegExp(`consts+${key}s*=s*['"]([^'"]+)['"]`).exec(src);
          if (!decl) continue; // resolved elsewhere; the literal-key rows are the risk
          key = decl[1]!;
        } else {
          key = key.slice(1, -1);
        }
        if (!(SETTINGS_ENCRYPTED_KEYS as readonly string[]).includes(key)) {
          missing.push(`${path.relative(SRC, file)}: ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
