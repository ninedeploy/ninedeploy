## Round 39 — scheduled deployment queue capacity
### Summary
Scope confirmed: apps/server/src/lib/jobRunner.ts deployment admission, deployQueue.ts as the existing policy/atomicity reference and nearest job/queue tests, required changelog/docs/evidence. Read source, callers, queue helper and relevant existing tests before candidates. Initial setup recorded before production patch; final results follow below.

### Toolchain
Root/server package.json: Node ^22.23.4 || ^24.22.1 || ^26.12.1 (live 26.13.0), pnpm 11.23.0, Vitest 5.0.5/V8, TypeScript 7.0.2, Biome 2.5.14, Drizzle/libSQL from repo lockfiles. Tests serialize files and use isolated data; no configured race detector. Recheck manifests if the concurrent browser-E2E package edit changes them.

### Invariants
- Scheduled deployments obey the same per-service cap (MAX_QUEUED_PER_SERVICE=50) as user-triggered deployments.
- Both queued and awaiting_ci rows consume that capacity, as deployQueue.ts already enforces.
- Concurrent different job IDs cannot both claim the last service slot.
- Queue rejection is audited as skipped; stored-owner privilege checks and trigger=schedule remain unchanged.

### Findings
#### F1059 — race/business-logic — Medium — scheduled enqueues bypass complete pending-capacity accounting
- Location: lib/jobRunner.ts deploy branch count/insert; deployQueue.ts is the existing reference policy.
- Root cause (before patch): scheduled count includes only queued, unlike the shared helper's queued+awaiting_ci policy, and then performs a constant-trigger insert after an await without the helper's in-insert capacity recheck.
- Proof before: prove_F1059_jobCapacity.test.ts, F1059_before.log -> queued-full control expected/actual 50 (passed); awaiting_ci-full and gated different-job last-slot cases expected 50/actual 51, PROBLEM CONFIRMED. Two failed/one unaffected control passed, exit 1. Real migrated SQLite and real stored-owner admission, no queue worker.
- Severity: Medium service capacity/resource-budget violation; no live resource exhaustion or privilege escalation claim.
- Planned narrow patch: count both existing pending statuses; use the already-established atomic SQL conditional trigger technique for the scheduled insert, preserving trigger=schedule; translate only its losing NOT NULL trigger constraint into the existing skipped audit. Unrelated DB failures propagate. Do not call the user helper because that would alter trigger/self-approval semantics.
- Permanent regressions: apps/server/test/lib/jobQueueCapacity.test.ts, three SQLite cases written and seen red before source patch.

### Not reproduced (dropped)
None. Root audit alias contamination is recorded below.

### Validation
Pending.

### Boundaries
Use real migrated SQLite and gated capacity reads; no actual deploy, shell, Docker or provider call. Existing host-privilege admission is preserved, not a new privilege-bypass claim.

### Working tree
Snapshot: audit_continuous_20261109/round39_status_before.txt. Start from published 1e5d1598; new browser-E2E workflow/script/test/package/frontend work appeared independently and is preserved.

### Next scope (if rounds continue)
apps/server/src/plugins/ciScheduler.ts and lib/ci.ts lost-attempt lease handling: verify restart/heartbeat/requeue ownership against current persisted state.


### Final validation and patch receipt
- Patch: jobRunner.ts counts queued+awaiting_ci and rechecks inside the SQLite insert through a conditional schedule trigger; only the known capacity constraint becomes job.deploy_skipped. No schema/config/dependency change.
- Original proof after: F1059_after_unaliased.log -> 3 passed, EXPECTED 50 / ACTUAL 50, PROBLEM NOT REPRODUCED. Before remains F1059_before.log (2 failed / 1 passed).
- Harness diagnosis: F1059_after.log was 1 failed / 2 passed because the root-only drizzle-orm alias split error class identity. The unchanged package-native test passed all 3 (F1059_package_after.log). F1059.config.ts removes only that alias; the original assertions then all passed. No further production change was made for this harness error.
- Independent verifier: verify_F1059_jobCapacity.test.ts -> 10 cases passed in each of F1059_verify_1/2/3.log, FIX VERIFIED. Real SQLite mixed pending counts, below-cap/empty controls, unrelated-service and terminal rows, explicitly gated 2/5 contenders, user admission filling the slot before scheduled insertion, unrelated SQL trigger failure propagation and retry-slot release. No sleeps.
- Permanent regression: apps/server/test/lib/jobQueueCapacity.test.ts, 3 real migrated SQLite cases observed red before patch and green after.
- Scope: pnpm --dir apps/server exec vitest run test/jobs.test.ts test/lib/jobRunner.test.ts test/lib/jobQueueCapacity.test.ts test/deployQueueWiring.test.ts test/plugins/jobScheduler.test.ts test/plugins/jobSchedulerReload.test.ts --coverage=false --reporter=verbose -> 72 passed / 6 files (F1059_scope.log).
- Compile: child-process GOMAXPROCS=4, pnpm --dir apps/server typecheck and build -> both exit 0 (F1059_typecheck.log, F1059_build.log). Default unbounded environment not recertified.
- Scoped Biome: pnpm exec biome lint apps/server/src/lib/jobRunner.ts apps/server/test/lib/jobQueueCapacity.test.ts -> 2 files, no fixes, exit 0 (F1059_lint.log). Formatting is disabled by repository configuration.
- NOT RUN: complete release gate, deployed queue worker, live Docker/provider, native Mac bootstrap. Earlier desktop CI evidence has its own commit/boundaries.
- Remaining unrelated browser-E2E/frontend/package/script changes are preserved; only explicit audit source/docs/evidence and the F1059 changelog hunk are selected for commit. Publication checks follow in this ledger before commit.
- Publication preflight: guarded staging selected 20 owned paths, staged diff --check and working-tree diff --check passed. Limited staged credential/runtime/line-ending scan reported no findings. Commit guard checks every selected source/evidence HEAD blob before push; unrelated browser-E2E/frontend work excluded.
- Operational preflight retry: first commit wrapper exited before staging/commit because its output was redirected to a filename matched by its own evidence normalizer (EBUSY). Redirected subsequent wrapper output outside that selection pattern; no product inference.
