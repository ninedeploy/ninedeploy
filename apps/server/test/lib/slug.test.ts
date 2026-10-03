import { describe, expect, it } from 'vitest';
import { createProject, createService, slug, updateService } from '@ninedeploy/schemas';
import { slugify, slugifyWithSuffix } from '../../src/lib/slug.js';

describe('slugify', () => {
  it('lowercases and trims input', () => {
    expect(slugify('  My App  ')).toBe('my-app');
  });

  it('replaces runs of non-alphanumeric characters with a single dash', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('a--b__c')).toBe('a-b-c');
  });

  it('strips leading and trailing dashes', () => {
    expect(slugify('--leading--')).toBe('leading');
    expect(slugify('---trailing---')).toBe('trailing');
  });

  it('caps at 63 characters', () => {
    expect(slugify('a'.repeat(100))).toHaveLength(63);
  });

  it('falls back to "service" for input that slugs to nothing', () => {
    expect(slugify('')).toBe('service');
    expect(slugify('!!!')).toBe('service');
    expect(slugify('   ')).toBe('service');
  });

  // r028 regression: truncation ran AFTER the leading/trailing-dash strip, so a
  // name whose 63rd character is a separator stranded it there. Callers store
  // the result unvalidated (modules/services.ts, modules/databases.ts) and reuse
  // it as the nd-svc-<slug> / nd-db-<slug> container name and bridge DNS label,
  // and a DNS label may not end with '-'.
  describe('output satisfies the canonical slug contract (r028)', () => {
    const LONG = [
      'Customer Data Platform Integration Service - staging environment alpha',
      `${'a'.repeat(62)}- b`,
      `${'x'.repeat(62)} y z`,
      'nightly reconciliation job runner for the accounting ledger - v2',
      `${'q'.repeat(63)}----`,
      `${'w'.repeat(60)} and more words here`,
    ];

    it('never strands a trailing hyphen when the name truncates at 63', () => {
      for (const name of LONG) {
        const out = slugify(name);
        expect(out.endsWith('-'), `slugify(${JSON.stringify(name)}) = ${JSON.stringify(out)}`).toBe(false);
      }
    });

    it('emits a slug the canonical @ninedeploy/schemas slug validator accepts', () => {
      for (const name of LONG) {
        const out = slugify(name);
        expect(slug.safeParse(out).success, `slug schema rejected ${JSON.stringify(out)}`).toBe(true);
      }
    });

    it('keeps the 63-char cap and the documented exact values', () => {
      // The cap itself must not regress for input that truncates cleanly.
      expect(slugify('a'.repeat(100))).toBe('a'.repeat(63));
      expect(slugify('a'.repeat(100))).toHaveLength(63);
      // Boundary: exactly 63 usable characters are preserved verbatim.
      expect(slugify('b'.repeat(63))).toBe('b'.repeat(63));
      // A dash run beyond the cap is dropped with the cut, not left behind.
      expect(slugify(`${'q'.repeat(63)}----`)).toBe('q'.repeat(63));
      // Short/unchanged behaviour is untouched by the reordering.
      expect(slugify('  My App  ')).toBe('my-app');
    });
  });

  // r029 regression: the canonical `slug` contract requires 2..63 characters,
  // but createService/createDatabase take `name` at min(1) and the routes
  // persist `slugify(input.name)` WITHOUT re-validating it (modules/services.ts
  // :228 and :693, modules/databases.ts:138, modules/projects.ts:84). A
  // one-character name therefore produced a slug the server's own
  // updateService/createProject schema rejects, and 'a!' collapses to 'a' even
  // though createProject.name is min(2) — which is why the guard lives in the
  // generator and not as a larger input minimum.
  describe('output meets the canonical minimum length (r029)', () => {
    it('pads a one-character slug so it satisfies the 2-char minimum', () => {
      expect(slugify('a')).toBe('aa');
      expect(slugify('7')).toBe('77');
      // The collapse case: two characters in, one usable character out.
      expect(slugify('a!')).toBe('aa');
    });

    it('accepts a createService name and returns a slug updateService accepts', () => {
      for (const name of ['a', 'x', '7', 'a!']) {
        // The route only runs if the payload validates...
        expect(createService.safeParse({ name, type: 'docker' }).success, `name ${name} rejected`).toBe(true);
        // ...so the slug it derives must validate on the same column.
        const derived = slugify(name);
        const back = updateService.safeParse({ slug: derived });
        expect(back.success, `updateService rejected server-derived slug ${derived}`).toBe(true);
      }
    });

    it('keeps createProject self-consistent for a two-character name that slugs to one', () => {
      const name = 'a!';
      expect(createProject.safeParse({ name }).success).toBe(true);
      const derived = slugify(name);
      expect(createProject.safeParse({ name, slug: derived }).success).toBe(true);
      expect(slug.safeParse(derived).success).toBe(true);
    });

    it('padding introduces no collisions and stays idempotent', () => {
      const short = ['a', 'b', 'z', '0', '9'];
      const out = short.map((n) => slugify(n));
      // Distinct names must not collapse onto one another, or two services
      // would fight over the same nd-svc-<slug> bridge.
      expect(new Set(out).size).toBe(short.length);
      for (const s of out) {
        expect(s, `slug ${s} is not a legal DNS label`).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
        // Re-slugging stored data (clone/rename paths) must not drift again.
        expect(slugify(s)).toBe(s);
      }
    });

    it('still falls back to "service" when nothing usable survives', () => {
      // Length 1 is padded; length 0 keeps the pre-existing sentinel.
      expect(slugify('')).toBe('service');
      expect(slugify('!!!')).toBe('service');
      expect(slugify('   ')).toBe('service');
    });
  });
});

// r032 regression: the collision-suffix callers append `-<n>` to an ALREADY
// truncated 63-char base and persist the result verbatim — services.ts:782/785
// (clone loop), serviceMigration.ts:129, composeStacks.ts:137/146 and
// workspaces.ts:86. A service whose slug is 62-63 chars collides with its own
// clone's re-derived base ("<name> (Copy)" clips away at the cap), so the
// suffix push stored 64-72 char slugs the canonical `slug` schema rejects —
// the same generator↔validator pairing gap as r028/r029, now on the suffix
// paths. slugifyWithSuffix reserves room for the suffix BEFORE truncating and
// re-runs the join through slugify, so the result stays canonical even when
// the cut lands on a hyphen or the suffix carries base64url separators.
describe('slugifyWithSuffix', () => {
  // slugify(NAME) is 62 chars — and a service with this name OCCUPIES that
  // slug, which is exactly what makes its own clone's base collide.
  const NAME = 'Customer Data Platform Integration Service - staging environment alpha';
  const BASE = slugify(NAME);

  it('appends verbatim for short names (byte-identical to the old append)', () => {
    expect(slugifyWithSuffix('my-app', 'xyz')).toBe('my-app-xyz');
    expect(slugifyWithSuffix('my-app', '1')).toBe('my-app-1');
  });

  it('keeps a max-length base plus counter suffix within the canonical cap', () => {
    for (const suffix of ['1', '9', '10', '50']) {
      const out = slugifyWithSuffix(BASE, suffix);
      expect(out.length, `suffix -${suffix} produced ${out.length} chars`).toBeLessThanOrEqual(63);
      expect(out.endsWith(`-${suffix}`), `suffix -${suffix} was not preserved verbatim`).toBe(true);
      expect(slug.safeParse(out).success, `slug schema rejected ${JSON.stringify(out)}`).toBe(true);
    }
  });

  it('keeps the 8-char Date.now().toString(36) escape suffix within the cap', () => {
    const stamp = Date.now().toString(36);
    const out = slugifyWithSuffix(BASE, stamp);
    expect(out.length).toBeLessThanOrEqual(63);
    expect(out.endsWith(`-${stamp}`)).toBe(true);
    expect(slug.safeParse(out).success).toBe(true);
  });

  it('normalises base64url token suffixes to the canonical shape', () => {
    // composeStacks.ts:146 rerolls with randomToken(3).slice(0, 4), whose
    // alphabet includes '_' and '-' — both illegal in a stored slug.
    const out = slugifyWithSuffix(BASE, 'ab_c');
    expect(out).not.toContain('_');
    expect(out.length).toBeLessThanOrEqual(63);
    expect(slug.safeParse(out).success).toBe(true);
  });

  it('stays canonical when the truncated base ends in a hyphen', () => {
    // 'x'.repeat(59) + '-y' slugifies to 61 chars; a '-1' suffix reserves 61
    // chars of room, so the base cut lands exactly ON the separator. The
    // join then carries a double dash, which the final slugify() run must
    // collapse instead of storing 'xx…--1'.
    const spiky = slugify(`${'x'.repeat(59)}-y`);
    for (const suffix of ['1', '22', '333']) {
      const out = slugifyWithSuffix(spiky, suffix);
      expect(out.endsWith('-'), `trailing hyphen stranded with suffix -${suffix}`).toBe(false);
      expect(out, `double hyphen left behind with suffix -${suffix}`).not.toContain('--');
      expect(slug.safeParse(out).success).toBe(true);
    }
  });

  it('preserves uniqueness: distinct suffixes never collapse onto one slug', () => {
    const outs = ['1', '2', '3'].map((n) => slugifyWithSuffix(BASE, n));
    expect(new Set(outs).size).toBe(3);
    for (const out of outs) expect(out).not.toBe(BASE);
  });

  it('degenerate suffixes still yield a canonical slug', () => {
    // A token of pure separators slugifies to ''; the result must remain a
    // legal slug rather than growing an orphan separator.
    const out = slugifyWithSuffix(BASE, '___');
    expect(slug.safeParse(out).success).toBe(true);
    // A pathological suffix is capped instead of squeezing the base away.
    const huge = slugifyWithSuffix('my-app', 'z'.repeat(80));
    expect(huge.length).toBeLessThanOrEqual(63);
    expect(slug.safeParse(huge).success).toBe(true);
  });

  it('pins the generator↔validator pair on the real clone-loop shape', () => {
    // Deterministic clone trigger: the source occupies BASE; the default
    // clone name re-derives it; the loop stores base + '-1'. The persisted
    // value must satisfy the same schema the API validates slug with.
    let newSlug = slugify(`${NAME} (Copy)`);
    expect(newSlug).toBe(BASE); // the collision the r032 proof turned on
    let counter = 1;
    while (counter <= 3) {
      newSlug = slugifyWithSuffix(`${NAME} (Copy)`, String(counter++));
      const back = updateService.safeParse({ slug: newSlug });
      expect(back.success, `updateService rejected clone slug ${newSlug}`).toBe(true);
    }
  });
});
