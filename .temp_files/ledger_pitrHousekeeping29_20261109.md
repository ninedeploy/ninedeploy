## Round 29 — point-in-time recovery housekeeping
### Summary
Scope confirmed: apps/server/src/lib/pitrHousekeeping.ts and nearest tests. Root CONTRIBUTING and source/callers inspected; read relevant engine/postgresPitr and lib/pitr tests before candidates.

### Toolchain
Root/server package.json: Node supported ^22.23.4 || ^24.22.1 || ^26.12.1 (live 26.13.0), pnpm 11.23.0, Vitest 5.0.5/V8, TypeScript 7.0.2/tsc, Biome 2.5.14. Server tests serialize files with isolated data roots. No configured race detector; no new tools.

### Invariants
- Helper cleanup targets only IDs from the role-label filter, with exact generated helper names and known sufficiently old creation times.
- Uncertain inspect/delete results must not be credited as removals or stop cleanup of other helpers.
- Retention removes only completed/failed recovery rows older than the configured window; running rows survive.
- No archive volume/database user container may be removed by the helper sweep.

### Findings
None confirmed. No production changes.

### Not reproduced (dropped)
Malformed IDs, invalid/future/young timestamps, unrelated names, uncertain inspect/delete failures and ps failure behaved as expected. Twelve boundary/control tests passed. Finished/running row distinction passed existing real migrated SQLite tests.

### Validation
- Boundary checks: pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts .temp_files/audit_continuous_20261109/inspect_round29_pitrHousekeeping.test.ts --reporter=verbose -> 12 passed (round29_boundary.log).
- Scope: pnpm --dir apps/server exec vitest run test/engine/postgresPitr.test.ts test/lib/pitr.test.ts test/plugins/housekeeping.test.ts --coverage=false --reporter=verbose -> 57 passed / 3 files (round29_scope.log).
- Build/typecheck/lint NOT RUN freshly: no source/test-suite edits in this round. Prior passing checks are different source snapshots.
- git diff --check -> exit 0 (normal autocrlf notices on concurrent edits).
- Full release gate/native Mac/live Docker cleanup/PostgreSQL NOT RUN: bounded pass, no production change, concurrent work ongoing.

### Boundaries
Docker identity/age behavior will use the capture seam, not a live destructive sweep. Database SQL retention is covered by the existing migrated-database tests; native recovery/WAL correctness is outside this helper scope.

### Working tree
Snapshot: audit_continuous_20261109/round29_status_before.txt. Preserve concurrent setupAcme/auth/installer edits.

### Next scope (if rounds continue)
apps/server/src/lib/pitr.ts pitrMaintenance and nearest tests: policy freshness after long archiver/base-backup awaits.
