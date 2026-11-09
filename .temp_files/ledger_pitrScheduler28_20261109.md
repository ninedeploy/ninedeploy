## Round 28 — point-in-time recovery scheduler ownership
### Summary
Scope confirmed: apps/server/src/plugins/pitrScheduler.ts and nearest tests. Root CONTRIBUTING, source and test/plugins/pitrScheduler.test.ts read before candidates. No new confirmed finding; no production patch.

### Toolchain
Root/server package.json: supported Node ^22.23.4 || ^24.22.1 || ^26.12.1, live Node 26.13.0, pnpm 11.23.0, Vitest 5.0.5, TypeScript 7.0.2, Biome 2.5.14. Server test configuration isolates data and serializes files; no configured race detector. No new tool installation.

### Invariants
- Busy prevents overlapping scheduled maintenance passes.
- Close invalidates a pass suspended in listing, and stops advancing to the next database after an in-flight maintenance call completes.
- Listing/maintenance failures do not permanently wedge busy.
- Close removes both initial timeout and hourly interval; already-started maintenance is not claimed cancellable.

### Findings
None. pitrMaintenance internals are outside this scheduler scope.

### Not reproduced (dropped)
Close during listing dispatched no maintenance; close during first upkeep prevented second database dispatch; overlap during listing remained suppressed; a failed listing cleared busy for the next pass. Five explicit-gate/control cases all passed.

### Validation
- Focused: pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts .temp_files/audit_continuous_20261109/inspect_round28_pitrScheduler.test.ts --reporter=verbose -> five passed (round28_gated_checks.log).
- Scope: pnpm --dir apps/server exec vitest run test/plugins/pitrScheduler.test.ts --coverage=false --reporter=verbose -> two passed (round28_scope.log).
- Compile/typecheck/build/lint NOT RUN freshly: no production/test-suite edit; prior round's passing static checks are a different snapshot, not fresh certification.
- git diff --check: exit 0; selected evidence receives another staged check before commit.
- Full release/native Mac/live PostgreSQL NOT RUN: outside bounded scheduler pass; concurrent source edits ongoing.

### Boundaries
No real PostgreSQL/WAL/Docker claims. The scheduler owns timers/dispatch only; maintenance body and database listing are dependency seams.

### Working tree
Initial snapshot: audit_continuous_20261109/round28_status_before.txt. Preserve unrelated auth/setup/installer changes from the other writer.

### Next scope (if rounds continue)
apps/server/src/lib/pitrHousekeeping.ts and its caller/tests: helper identity/age constraints and finished-history retention.
