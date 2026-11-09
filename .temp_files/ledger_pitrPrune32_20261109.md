## Round 32 — active prune ownership
### Summary
Scope confirmed: apps/server/src/lib/pitr.ts, apps/server/src/modules/pitr.ts and nearest lib/modules PITR tests, required changelog/docs/evidence. Read root instructions, sources, nearest tests and engine inArchive/retention code before candidates. One Medium ownership race confirmed, patched and promoted to five permanent regression/control cases.

### Toolchain
Root/server package.json: supported Node ^22.23.4 || ^24.22.1 || ^26.12.1 (live 26.13.0), pnpm 11.23.0, Vitest 5.0.5, TypeScript 7.0.2, Biome 2.5.14. Server test files serialize and use isolated data; no configured race detector. Resource-bound compiler calls explicitly use child-process GOMAXPROCS=4 as in previous rounds.

### Invariants
- Once destructive archive pruning starts, a new recovery/base backup/disable must not acquire that same archive until pruning finishes.
- A second maintenance pass must not dispatch another prune for the same archive.
- Ownership must release after prune failure, allowing subsequent operations.
- The base-backup HTTP route must report a conflict if it cannot admit the background operation, preserving existing authorization.
- Existing recovery/base-backup ownership must continue suppressing new pruning.

### Findings
#### F1054 — race/ownership — Medium — active prune does not exclude new archive users
- Location: lib/pitr.ts pitrMaintenance prune dispatch and archive mutators; modules/pitr.ts base-backup admission.
- Root cause (recorded before patch): prune checks recovery/base-backup sets, but reserves no identity across awaited engine work. New backups/recoveries/disables and another prune cannot see it. The engine's inArchive helper has no shared ownership lock for pruning.
- Proof before: prove_F1054_pitrPrune.test.ts, F1054_before.log -> base-backup/recovery/disable each ACTUAL operation admitted during prune, EXPECTED pitr_busy, PROBLEM CONFIRMED; three failures, one unaffected existing-backup suppression control passed, exit 1.
- HTTP proof before: package Vitest test/modules/pitr.test.ts -t 'refuses a base backup while archive retention is active' -> expected 409, actual 202; one failed/five unselected tests skipped, F1054_route_before.log.
- Severity: Medium proven mutual-exclusion/acceptance violation; no live WAL corruption/deletion consequence claimed from dependency seams.
- Planned narrow patch: prune-owned set reserved synchronously before engine dispatch, cleared in finally; recheck after row refresh; reject same-archive backup/recovery/disable with existing pitr_busy conflict, including route admission before background launch. Other archives unaffected.
- Permanent regressions: four lib gate/control cases and one real-Fastify route case in existing PITR test files, written and seen red before production patch.
- Patch: internal prunesRunning reservation with finally release; same-archive backup/recovery/disable and repeated maintenance refuse/skip while active. Recheck ownership after current-row query. Base-backup route checks prune admission before accepting its background job. Existing pitr_busy error code/409 reused; public response/schema shapes unchanged, internal pitrBusy gains prune lookup.
- Proof after: F1054_after.log -> four passed, PROBLEM NOT REPRODUCED. Original HTTP case passed in the full scope run (F1054_scope.log).
- Independent verify_F1054_pitrPrune.test.ts: ten cases per run; same-archive mutators rejected while gate held, repeated maintenance does not dispatch another prune, success/prune error/logging error all release ownership for a successful retry. Other archives and retention-only settings remain usable. Three consecutive clean runs, FIX VERIFIED (F1054_verify_1/2/3.log).

### Not reproduced (dropped)
No further defect claimed. Already-started engine work and disable operations that began before a prune reservation are not claimed cancellable or globally serialized by this patch.

### Validation
- Focused: pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts <prove_F1054_pitrPrune.test.ts or verify_F1054_pitrPrune.test.ts> --reporter=verbose -> before three failed/one control passed; after four passed; verifier ten passed x3.
- HTTP before: pnpm --dir apps/server exec vitest run test/modules/pitr.test.ts --coverage=false --reporter=verbose -t 'refuses a base backup while archive retention is active' -> expected 409/actual 202. Same unchanged case passes after patch in full scope run.
- Scope: pnpm --dir apps/server exec vitest run test/lib/pitr.test.ts test/lib/pitrDeps.test.ts test/modules/pitr.test.ts test/engine/postgresPitr.test.ts test/plugins/pitrScheduler.test.ts --coverage=false --reporter=verbose -> 58 passed / five files (F1054_scope.log).
- Typecheck/build: child-process GOMAXPROCS=4, pnpm --dir apps/server typecheck and build -> both exit 0 (F1054_typecheck_bounded.log / F1054_build_bounded.log). No repository/host environment config change.
- Lint: separate pnpm exec biome lint calls for all four changed source/test files -> each checked one file, no fixes, exit 0 (F1054_lint.log, captured successful tool outputs). Formatter disabled. Grouped launches and one individual launch failed CreateProcess Access denied before executing; successful package-cwd retry checked the remaining file.
- git diff --check and git diff --cached --check -> exit 0. Limited selected-content scan: 21 staged files, no common credential-pattern matches, runtime files/index line endings passed; not a comprehensive security audit.
- NOT RUN: full default root gate/native Mac/DMG/Keychain/live PostgreSQL/WAL deletion. Concurrent unrelated source work remains outside this scope.

### Boundaries
Real migrated SQLite, real Fastify injection and explicit prune/replay gates at engine seams verify process-local exclusion after reservation. No actual WAL/archive deletion, Docker operation or cross-process exclusion claim. Retention changes do not cancel an already-dispatched prune. Grouped lint process launches failed before execution; all four files subsequently passed individual configured Biome checks. No check threshold/config weakened or unrelated process killed.

### Working tree
Snapshots: audit_continuous_20261109/round32_status_before.txt and round32_status_after.txt. Concurrent auth/setup/installer/frontend/schema/SDK changes preserved. Stage only the two PITR source modules, their five new regression/control cases, own changelog hunk, Mac handoff table and selected evidence.

### Next scope (if rounds continue)
apps/server/src/plugins/gitopsScheduler.ts and nearest instance-GitOps tests/callers: timer ownership, overlap and shutdown after awaited synchronization.
