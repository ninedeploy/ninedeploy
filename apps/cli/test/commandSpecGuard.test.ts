import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * r200 guard: commander treats every word after the command name as an
 * ARGUMENT — a bare word is a required argument, so `.command('add namecheap')`
 * handed the action the string "namecheap" in place of its options object.
 * Subcommand words must be nested `.command()` calls; arguments need <> or [].
 */
describe('CLI command specs', () => {
  it('declares every argument with <required> or [optional] brackets', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const bad: string[] = [];
    for (const m of src.matchAll(/\.command\('([^']+)'\)/g)) {
      const [, ...args] = m[1]!.split(/\s+/);
      if (args.some((a) => !/^[<[]/.test(a))) bad.push(m[1]!);
    }
    expect(bad).toEqual([]);
  });
});
