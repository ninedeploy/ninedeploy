## Round 40 — CI lease-loss sweep ownership
### Summary
Scope confirmed: apps/server/src/plugins/ciScheduler.ts and apps/server/src/lib/ci.ts lease sweep/heartbeat/revocation paths, nearest CI tests, required changelog/docs/evidence. Source and existing migrated-SQLite CI protocol tests read before candidates. Initial setup recorded before patch; final evidence follows.

### Toolchain
Root/server manifests and apps/server/vitest.config.ts checked: Node supported ^22.23.4 || ^24.22.1 || ^26.12.1, live 26.13.0; pnpm 11.23.0; TypeScript 7.0.2; Vitest 5.0.5/V8; configured Biome 2.5.14 with formatting disabled. Serial test files and invocation-isolated data directories; no configured race detector. Use existing tools only. CONTRIBUTING.md reviewed; no applicable root/scope AGENTS.md.

### Invariants
- A sweep may lose an attempt only if its persisted lease is still expired when it wins the conditional update.
- A heartbeat or restart extension that wins before the sweep update preserves the lease and current job.
- Forced runner revocation still loses running attempts irrespective of their future lease.
- Terminal attempts and superseded/current job ownership remain protected by conditional updates.
- Reported sweep count reflects attempts actually transitioned, not a stale read set.

### Findings
F1060 confirmed and repaired below.
### Not reproduced (dropped)
None; separate admission concerns are deferred to a new proof.
### Validation
Final results below.
### Boundaries
Real migrated in-memory SQLite and explicit promise barriers; no live runner/container/provider. Existing scheduler pre-start/close overlap behavior read, no speculative lifecycle patch.
### Working tree
round40_status_before.txt captures unrelated browser-E2E/frontend/package/script changes. Round39 commit 1dcb5141bae883b3530bd11ea1fd4bc250a8b6d0 source/evidence blobs verified and origin main matched after push. Preserve all unrelated work.
### Next scope (if rounds continue)
CI claim admission/cancellation, as recorded below.

### F1060 — race/ownership — Medium — stale expiry sweeps lose renewed CI attempts
- Location: lib/ci.ts sweepLostAttempts -> loseAttempt conditional update.
- Root cause BEFORE patch: the sweep selects expired running attempts, awaits, and loseAttempt checks only status=running. A heartbeat/restart that extends the persisted expiry before that update still loses the attempt and requeues/fails its job. sweep count also returns stale selection length instead of actual transitioned attempts.
- Before proof: prove_F1060_ciLease.test.ts / F1060_before.log -> 2 failed / 1 unaffected expired control passed, exit 1. Both gated renewals expected running/0 lost, ACTUAL lost/1, PROBLEM CONFIRMED. The persisted expiry was already extended to NOW+60000 while status became lost.
- Severity: Medium, valid running CI work is cancelled/retried or prematurely fails at its attempt limit. Real DB ownership race proven; no live runner outage/secret claim.
- Planned narrow patch: optional expiry cutoff in loseAttempt's atomic UPDATE, used only by expiry sweeps. Forced revocation keeps unconditional running-status loss. Return actual won-transition boolean and count winners. No schema/wire/config/dependency change.
- Permanent regression: apps/server/test/lib/ciLeaseSweep.test.ts (three cases, observed red before source patch).

### Final validation
- Patch: lib/ci.ts adds an optional atomic lease-expiry predicate to loseAttempt only for expiry sweeps, returns won-transition status, and counts actual losses. revokeRunner keeps the existing forced-loss behavior. No public type/schema/config/dependency change.
- Original proof after: F1060_after.log -> 3 passed, renewed heartbeat/restart EXPECTED running/0 lost and ACTUAL running/0, PROBLEM NOT REPRODUCED.
- Independent verifier: verify_F1060_ciLease.test.ts -> 12 passed in each of F1060_verify_1/2/3.log, FIX VERIFIED. Gated heartbeat/restart for maxAttempts 1/2; two concurrent sweeps count only one winner, exact/future cutoff, revoke after renewal and during stale sweep, valid earlier finish during suspended sweep, and a later genuine expiry. Explicit promise barriers, no sleep timing.
- Permanent suite: apps/server/test/lib/ciLeaseSweep.test.ts, 3 real SQLite controls/races observed red before patch and green after.
- Scope: pnpm --dir apps/server exec vitest run test/lib/ciLeaseSweep.test.ts test/modules/ci.test.ts test/ciRunner.test.ts test/lib/ciDeployGate.test.ts test/lib/ciGate.test.ts test/lib/ciGate.coverage.test.ts --coverage=false --reporter=verbose -> 77 passed / 6 files (F1060_scope.log).
- Compile: child-process GOMAXPROCS=4 pnpm --dir apps/server typecheck and build -> both exit 0, F1060_typecheck.log / F1060_build.log.
- Lint: pnpm exec biome lint apps/server/src/lib/ci.ts apps/server/test/lib/ciLeaseSweep.test.ts -> 2 files, no fixes, exit 0 (F1060_lint.log). Formatter disabled by repository config.
- NOT RUN: full repository/server coverage suite, live runner/Docker, native Mac bootstrap, exact-commit hosted CI. Existing complete-release-gate boundary remains.
- Not reproduced: no additional confirmed defect is bundled; cancellation/claim/finish admission races require a separate proof/scope.
- Next scope: lib/ci.ts claimJob admission/cancellation and its current attempt ownership; these writes span multiple awaits and deserve a separate current-source proof.

- Publication preflight: git diff --check, cached diff --check and guarded 18-path staging passed. Limited staged credential/runtime/line-ending scan found no matches. Unrelated browser-E2E/frontend/package/docs edits remain unstaged and untouched. Final commit wrapper verifies every selected source/evidence HEAD blob before push.
