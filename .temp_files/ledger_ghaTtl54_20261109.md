## Round 54 — pending-job TTL across awaited admission
### Summary
Scope confirmed: apps/server/src/lib/githubRunners.ts pending TTL in drainOnce and nearest pending/expiry tests, required changelog/docs/evidence. Current early clock snapshot and per-job admission awaits, plus existing expiry fixtures read before candidate; initial setup before patch, final evidence below.
### Toolchain
Node26.13.0, pnpm11.23.0, package0.18.26, TypeScript7.0.2, Vitest5.0.5/V8, Biome2.5.14 formatter disabled; serial files/isolated data/no configured race detector. No dependencies added.
### Invariants
- A still-pending entry beyond existing PENDING_TTL_MS at actual admission cannot start from an earlier drain clock snapshot.
- An already-admitted runner start can finish; expired later entries consume no slot ahead of fresh work.
- Preserve existing strict-over-TTL boundary and pending-owner/config fences.
### Findings
F1073 confirmed and repaired below.
### Not reproduced (dropped)
No unrelated candidate bundled.
### Validation
Pending.
### Boundaries
Real migrated pending/config with Date-only fake clock and explicit JIT/status/config/list gates; no wall-clock waits or live GitHub/Docker actions. This validates local TTL admission, not exact remote job cancellation timing.
### Working tree
round54_status_before.txt; round53 b7a5898829281eec1ef86003b6610a801599c6f9 selected blobs/changelog and remote main verified. Unrelated E2E/browser/CHANGELOG work remains separately owned.
### Next scope (if rounds continue)
Environment secret-file cleanup ownership, recorded below.

### F1073 — race/ownership — Medium — pending TTL expires during an await but stale clock still admits work
- Location: lib/githubRunners.ts drainOnce early now snapshot versus later per-job admission.
- Root cause BEFORE patch: expiration is checked only using a timestamp captured before container enumeration and all startup/status/config awaits. A later pending entry may be beyond the existing24h TTL by the time it is admitted, yet the captured batch still starts it.
- Before: prove_F1073_ghaTtl.test.ts / F1073_before.log ->1 failed/1 inside-TTL control passed, exit1, PROBLEM CONFIRMED. Real pending timestamps, Date-only fake clock near deadline, first JIT explicitly held then clock advanced: EXPECTED only admitted[80], ACTUAL[80,81]. No wall-clock waiting or real provider action.
- Severity Medium obsolete job resource admission and lost slot fairness; no claim that a live GitHub job was cancelled at an exact millisecond.
- Planned narrow patch: after final async config/status validation and current pending identity check, use current Date.now against existing strict-over-TTL rule; delete only the still-owned expired entry before slot consumption. Retain already-admitted start semantics, existing initial prune and boundary comparison. No public API/schema/config/dependency change.
- Permanent regression: apps/server/test/lib/githubRunnerPendingTtl.test.ts,2 explicit clock/JIT cases observed red/control before patch.
- Execution date note: this round began2026-11-09 and continued across midnight into2026-11-10 (environment update received). The20261109 directory/ledger suffix is the continuous audit session start, not a claim that every validation ran on November9.

### Final acceptance
- Patch: drainOnce rechecks Date.now against the existing pending TTL after all async status/config checks and current-entry identity validation, dropping only that expired pending entry before slot use. Four source lines; no API/schema/config/dependency change.
- Original after: F1073_after.log ->2 passed, PROBLEM NOT REPRODUCED. Inside-TTL starts[80,81]; expired later entry starts only previously-admitted[80].
- Independent: verify_F1073_ghaTtl.test.ts ->10 passed in each F1073_verify_1/2/3.log, FIX VERIFIED. Date-only fake clock and explicit JIT/online queued/missing/error/host-list/final-settings-read barriers; inside/exact/after strict TTL boundary; expired middle entry versus fresh third job; initial prune control. No sleeps or exact live provider deadline claim.
- Permanent regression: apps/server/test/lib/githubRunnerPendingTtl.test.ts,2 cases observed red/control then green. Only trailing EOF whitespace normalized before static checks.
- Scope: pnpm --dir apps/server exec vitest run test/lib/githubRunnerPendingTtl.test.ts test/lib/githubRunnerRecheck.test.ts test/lib/githubRunnerLifetime.test.ts test/lib/githubRunnerReaping.test.ts test/lib/githubRunnerEligibility.test.ts test/lib/githubRunnerConfigDrift.test.ts test/lib/githubRunnerPending.test.ts test/lib/githubRunners.test.ts test/lib/githubRunners.coverage.test.ts test/lib/githubRunnersNode.test.ts --coverage=false --reporter=verbose ->140 passed/10 files (F1073_scope.log).
- Compile: child-process GOMAXPROCS=4 pnpm --dir apps/server typecheck and build ->both exit0 (F1073_typecheck.log/F1073_build.log).
- Biome: pnpm exec biome lint apps/server/src/lib/githubRunners.ts apps/server/test/lib/githubRunnerPendingTtl.test.ts ->2 files, no fixes, exit0 (F1073_lint.log). Formatter disabled by config.
- Shared checkout: newer unrelated engine/database.ts, database.test.ts and database web-page changes appeared after setup; preserved and excluded from this commit. Static commands ran in that shared snapshot, not an independent certification of the database feature.
- NOT RUN: full repository/server coverage, hosted CI, live24h workflow/Docker/node, native Mac bootstrap. An already-admitted startup may finish after TTL; this fix fences pending admission only.
- Next scope: secretFile.ts and runner environment-file cleanup callers, including panel/agent start success versus cleanup error. Read implementations/callers/tests and prove any defect before patch.
- Publication preflight: guarded18-path staging, cached and working-tree diff --check, limited staged credential/runtime/line-ending scan passed. Only owned GHA source/test/Mac docs/evidence and F1073 Unreleased bullet selected. Final wrapper rechecks HEAD stability after staging and every selected committed blob before push.
