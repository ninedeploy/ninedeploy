/**
 * S8 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): every scripts/smoke-* file is
 * either run by a workflow or listed as a manual tool in scripts/README.md, and
 * every package.json alias points at a script that exists. Six smokes had sat
 * unreferenced, and one had no way to run it short of reading its source.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');

const smokes = readdirSync(new URL('scripts/', root)).filter((f) => /^smoke-.+\.m?[jt]s$/.test(f) || /^smoke-.+\.mts$/.test(f));
const workflows = readdirSync(new URL('.github/workflows/', root))
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((f) => read(`.github/workflows/${f}`))
  .join('\n');
const readme = read('scripts/README.md');
const manualBlock = readme.slice(readme.indexOf('<!-- manual-smokes:start -->'), readme.indexOf('<!-- manual-smokes:end -->'));
const manual = new Set([...manualBlock.matchAll(/^\| `(smoke-[^`]+)` \|/gm)].map((m) => m[1]!));

describe('smoke inventory', () => {
  it('finds the scripts and the manual list', () => {
    expect(smokes.length).toBeGreaterThan(20);
    expect(manual.size).toBeGreaterThan(0);
  });

  it('every smoke script is run by a workflow or listed as manual', () => {
    const orphans = smokes.filter((f) => !workflows.includes(f) && !manual.has(f));
    expect(orphans).toEqual([]);
  });

  it('every manual entry names a script that exists and is not also run by a workflow', () => {
    for (const f of manual) {
      expect(smokes, `${f} is listed in scripts/README.md but does not exist`).toContain(f);
      expect(workflows.includes(f), `${f} runs in a workflow; remove it from the manual list`).toBe(false);
    }
  });

  it('every smoke alias in package.json points at an existing script', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    for (const [name, command] of Object.entries(scripts)) {
      for (const m of command.matchAll(/scripts\/(smoke-[\w.-]+)/g)) {
        expect(existsSync(new URL(`scripts/${m[1]}`, root)), `${name} → ${m[1]}`).toBe(true);
      }
    }
  });
});
