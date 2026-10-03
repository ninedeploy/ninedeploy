import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Migration-asset integrity for the Drizzle journal.
 *
 * `when` must strictly increase: Drizzle's runtime migrator — and the fallback
 * in `src/migrate.ts` (`applyToleratingExistingObjects`) — decide whether to
 * apply a migration by comparing its `folderMillis` (the journal `when`)
 * against the newest `created_at` in `__drizzle_migrations`. A migration whose
 * `when` is older than one already applied is filtered out FOREVER on every
 * existing database, and it fails *silently*: no error is thrown, so the
 * "already exists" recovery path is never reached and nothing is logged. Fresh
 * installs are unaffected, which is why the drift survives CI. That is how
 * `0052_environments` shipped broken (it carried `when: 1788978261760`, below
 * 0048–0051's `1789400000000`), leaving `CREATE TABLE environments` and
 * `ALTER TABLE services ADD environment_id` unapplied and the server logging
 * `SQLITE_ERROR: no such column: environment_id`.
 *
 * Asset checks guard the other half: a journal entry whose `<tag>.sql` is
 * missing aborts the migrator at boot, an orphan `.sql` is a migration that
 * will never run, and a missing snapshot breaks `drizzle-kit generate`, which
 * diffs the schema against the newest snapshot in `meta/`.
 *
 * RUN-TIME vs TOOLING invariants — deliberately scoped, not weakened:
 *   - The runtime migrator reads only `_journal.json` + `<tag>.sql`. Both are
 *     asserted exhaustively below, in both directions.
 *   - `idx` is NOT read by the runtime migrator; it exists for drizzle-kit.
 *     The real journal therefore asserts what drizzle-kit needs (strictly
 *     increasing, unique) rather than "exactly one" — see the known gaps note.
 *   - Snapshots are only needed for the NEWEST entry (what `generate` diffs
 *     against); every snapshot that exists must belong to a journalled entry.
 *
 * KNOWN PRE-EXISTING GAPS (verified 2026-09-10 across all 26 committed
 * revisions of the journal; reported, deliberately not asserted so this guard
 * cannot start life red and get ignored):
 *   1. The numbering is malformed, not lossy. Tag 0020 was never created, so
 *      tags 0021–0030 sit at idx 20–29 (off by one), and idx 30 is skipped
 *      (idx runs 0–19, 20–29, then 31–52). No revision ever held an idx-30
 *      entry, no revision exceeded 52 entries, and no tag ever disappeared, so
 *      nothing was deleted. `idx` is drizzle-kit metadata only — drizzle-orm's
 *      migrator never reads it — so the gap is inert; it is left as-is because
 *      renumbering the tail is unrequested churn.
 *   2. 26 entries have no committed snapshot: tags 0022–0030 and 0032–0048.
 *      `git log --diff-filter=D -- packages/db/src/migrations/meta/` is empty
 *      and `.gitignore` mentions no snapshot pattern, so these were never
 *      committed. Historical snapshots cannot be regenerated truthfully — a
 *      fabricated snapshot is a corrupt diff baseline for future `generate`.
 */

const migrationsFolder = fileURLToPath(new URL('../src/migrations', import.meta.url));
const journalPath = join(migrationsFolder, 'meta', '_journal.json');

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/**
 * Snapshot filename for a journal entry, derived from the TAG's numeric prefix.
 *
 * drizzle-kit 0.31.10 builds it as `${tag.split('_')[0]}_snapshot.json` — NOT
 * from the entry's `idx`. The two bases disagree in this repo (tag 0020 was
 * never created and idx 30 is skipped), so `0021_snapshot.json` belongs to tag
 * `0021_optimal_the_anarchist` (idx 20), not to idx 21.
 */
function snapshotFileName(tag: string): string {
  return `${tag.split('_')[0]}_snapshot.json`;
}

/**
 * One violation per entry whose `when` is not strictly greater than its
 * predecessor's. Equality is a violation too: two migrations sharing a
 * timestamp leave the applied order ambiguous.
 */
function findNonIncreasingWhen(entries: JournalEntry[]): string[] {
  const violations: string[] = [];
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]!;
    const cur = entries[i]!;
    if (!(cur.when > prev.when)) {
      violations.push(`${cur.tag} (when=${cur.when}) is not newer than ${prev.tag} (when=${prev.when})`);
    }
  }
  return violations;
}

/** One violation per entry whose `idx` does not exceed the previous one. */
function findNonIncreasingIdx(entries: JournalEntry[]): string[] {
  const violations: string[] = [];
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]!;
    const cur = entries[i]!;
    if (!(cur.idx > prev.idx)) {
      violations.push(`${cur.tag} has idx=${cur.idx}, not greater than ${prev.tag} (idx=${prev.idx})`);
    }
  }
  return violations;
}

/** Journal entries with no `<tag>.sql` on disk — the migrator would abort. */
function findMissingSql(entries: JournalEntry[], folder: string): string[] {
  return entries.filter((e) => !existsSync(join(folder, `${e.tag}.sql`))).map((e) => `${e.tag}.sql`);
}

/** `.sql` files no journal entry references — a migration that never runs. */
function findOrphanSql(entries: JournalEntry[], folder: string): string[] {
  const journalled = new Set(entries.map((e) => `${e.tag}.sql`));
  return readdirSync(folder)
    .filter((f) => f.endsWith('.sql') && !journalled.has(f))
    .sort();
}

/** Snapshots in `meta/` that belong to no journal entry. */
function findOrphanSnapshots(entries: JournalEntry[], folder: string): string[] {
  const expected = new Set(entries.map((e) => snapshotFileName(e.tag)));
  return readdirSync(join(folder, 'meta'))
    .filter((f) => f.endsWith('_snapshot.json') && !expected.has(f))
    .sort();
}

function readJournalEntries(): JournalEntry[] {
  return (JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: JournalEntry[] }).entries;
}

describe('migration journal — `when` must strictly increase', () => {
  it('parses the real journal (keeps the assertions below non-vacuous)', () => {
    const entries = readJournalEntries();
    // A bad path or a renamed key would otherwise make every check pass blindly.
    expect(entries.length).toBeGreaterThan(50);
    for (const entry of entries) {
      expect(entry.tag).toMatch(/^\d{4}_/);
      expect(Number.isFinite(entry.when)).toBe(true);
    }
  });

  it('has strictly increasing `when` values in entry order', () => {
    expect(findNonIncreasingWhen(readJournalEntries())).toEqual([]);
  });

  it('detects a back-dated migration (the 0052_environments defect)', () => {
    // The real pre-fix state: 0052 dated below 0051, so existing installs
    // skipped it permanently.
    const backDated: JournalEntry[] = [
      { idx: 51, when: 1789400000000, tag: '0051_services_compose_content' },
      { idx: 52, when: 1788978261760, tag: '0052_environments' },
    ];
    const violations = findNonIncreasingWhen(backDated);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('0052_environments');
    expect(violations[0]).toContain('0051_services_compose_content');
  });

  it('treats a duplicated `when` as a violation (strict, not merely non-decreasing)', () => {
    const duplicated: JournalEntry[] = [
      { idx: 50, when: 1789400000000, tag: '0050_fk_indexes' },
      { idx: 51, when: 1789400000000, tag: '0051_services_compose_content' },
    ];
    expect(findNonIncreasingWhen(duplicated)).toHaveLength(1);
  });
});

describe('migration journal — `idx` must strictly increase and stay unique', () => {
  it('has strictly increasing, unique `idx` values', () => {
    expect(findNonIncreasingIdx(readJournalEntries())).toEqual([]);
  });

  it('detects a duplicated idx (keeps the check non-vacuous)', () => {
    const duplicated: JournalEntry[] = [
      { idx: 0, when: 1, tag: '0000_a' },
      { idx: 0, when: 2, tag: '0001_b' },
    ];
    const violations = findNonIncreasingIdx(duplicated);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('0001_b');
  });

  it('detects a decreasing idx (keeps the check non-vacuous)', () => {
    const decreasing: JournalEntry[] = [
      { idx: 5, when: 1, tag: '0005_e' },
      { idx: 3, when: 2, tag: '0006_f' },
    ];
    expect(findNonIncreasingIdx(decreasing)).toHaveLength(1);
  });
});

describe('migration journal — migration assets', () => {
  it('has a matching `.sql` file for every entry', () => {
    // The runtime migrator reads exactly `<tag>.sql`; a gap aborts boot.
    expect(findMissingSql(readJournalEntries(), migrationsFolder)).toEqual([]);
  });

  it('has no orphan `.sql` file (a migration that would never run)', () => {
    expect(findOrphanSql(readJournalEntries(), migrationsFolder)).toEqual([]);
  });

  it('has a snapshot for the newest entry (what `drizzle-kit generate` diffs against)', () => {
    const entries = readJournalEntries();
    const newest = entries[entries.length - 1]!;
    expect(existsSync(join(migrationsFolder, 'meta', snapshotFileName(newest.tag)))).toBe(true);
  });

  it('has no orphan snapshot in `meta/`', () => {
    expect(findOrphanSnapshots(readJournalEntries(), migrationsFolder)).toEqual([]);
  });

  it('detects missing and orphaned assets (keeps the checks non-vacuous)', () => {
    const ghost: JournalEntry[] = [{ idx: 9999, when: 1, tag: '9999_does_not_exist' }];
    expect(findMissingSql(ghost, migrationsFolder)).toEqual(['9999_does_not_exist.sql']);
    // The real folder has `.sql` files, so from the ghost's perspective they
    // are all orphans — proving the orphan scan actually inspects the folder.
    expect(findOrphanSql(ghost, migrationsFolder).length).toBeGreaterThan(50);
    expect(findOrphanSnapshots(ghost, migrationsFolder).length).toBeGreaterThan(20);
  });
});
