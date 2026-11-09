## Round 44 — CI result and cancellation handoff
### Summary
Scope confirmed: apps/server/src/lib/ci.ts finishAttempt/cancelJob writes, modules/ci.ts as read-only protocol/audit caller, nearest real DB tests, required changelog/docs/evidence. Current source and existing module CI result/cancellation tests reread before candidate; initial setup before patch, final evidence below.
### Toolchain
Node26.13.0 supported by root/server engines, pnpm11.23.0, TypeScript7.0.2, Vitest5.0.5/V8, Biome2.5.14 formatter disabled; same current manifests/config, serial files/isolated data/no configured race detector. No new dependencies.
### Invariants
- A finish accepted after cancellation won must return conflict and cannot count a successful/failed result or emit a result-success audit.
- Cancellation winning the job transition retires its current attempt even if a competing result updated the attempt just before cancellation.
- A fully accepted finish remains terminal and cannot subsequently be cancelled; duplicate finishes remain conflicts.
### Findings
F1064 confirmed and repaired below.
### Not reproduced (dropped)
No unrelated candidate bundled.
### Validation
Pending.
### Boundaries
Real migrated SQLite and explicit client barriers; no live CI runner. This tests result admission and stored state, not cancellation of an already-issued container side effect.
### Working tree
round44_status_before.txt, unrelated CHANGELOG edit preserved. Round43 6c9b316c3ef0d3e296d40ebc4467184a96336e72 all owned blobs verified and origin main matched.
### Next scope (if rounds continue)
CI log sequence/budget ownership, recorded below.

### F1064 — race/ownership — Medium — cancelled CI results are acknowledged as accepted
- Location: lib/ci.ts finishAttempt attempt UPDATE and unchecked final job UPDATE; cancelJob current-attempt retirement.
- Root cause BEFORE patch: finish trusts request-read job ownership when updating an attempt, and ignores whether the final job UPDATE actually won. Cancellation can win the job before either write; the result still resolves successfully and leaves succeeded attempt history under a cancelled job. The protocol then emits ci.job_succeeded/failed from a result that did not count.
- Proof before: prove_F1064_ciFinish.test.ts / F1064_before.log and F1064_before_state.log -> 2 failed / 1 completed-finish control passed, exit1, EXPECTED conflict ACTUAL accepted, PROBLEM CONFIRMED. Explicit cancel-job-update/attempt-result-update barriers cover both orderings; final stored job cancelled / attempt succeeded, expected both cancelled.
- Severity Medium inconsistent accepted-result/history/audit behavior during cancellation; job remains cancelled, so no deployment success or live workload claim.
- Planned narrow patch: atomically require live current job ownership on attempt result UPDATE; check final job UPDATE affected count and conflict on a lost transition; cancellation that won its job update retires its current running or just-finished attempt. No transaction spanning unrelated work or new wire/schema/config/dependency.
- Permanent regression: apps/server/test/lib/ciFinishCancellation.test.ts, 3 gated/control cases observed red before patch.

### Final acceptance
- Patch: attempt result UPDATE requires persisted current/running job ownership; final job UPDATE must affect one row or the finish throws existing CiError409. A winning cancellation closes its current running/succeeded/failed attempt, covering an already-written result whose job transition had not won. No schema/wire/config/dependency change.
- Original proof after: F1064_after.log -> 3 passed, both interleavings EXPECTED conflict ACTUAL conflict and stored cancelled/cancelled, PROBLEM NOT REPRODUCED.
- Independent HTTP verifier: verify_F1064_ciFinish.test.ts -> 9 passed in each F1064_verify_1/2/3.log, FIX VERIFIED. Real Fastify runner protocol routes and migrated SQLite, Date-only fake clock; success/failure x both gated interleavings return409 with no result audit call; normal success/failure accepted once/audited once; duplicate, already-cancelled, expired-lease and superseded attempt rejected. Audit is mocked only as an observation sink; no live runner/network.
- Permanent regression: apps/server/test/lib/ciFinishCancellation.test.ts, three red/green real SQLite cases.
- Scope: pnpm --dir apps/server exec vitest run test/lib/ciFinishCancellation.test.ts test/lib/ciClaimRevocation.test.ts test/lib/ciClaimCapacity.test.ts test/lib/ciClaimCancellation.test.ts test/lib/ciLeaseSweep.test.ts test/modules/ci.test.ts test/ciRunner.test.ts test/lib/ciDeployGate.test.ts test/lib/ciGate.test.ts test/lib/ciGate.coverage.test.ts --coverage=false --reporter=verbose -> 93 passed / 10 files (F1064_scope.log).
- Compile: child-process GOMAXPROCS=4 pnpm --dir apps/server typecheck and build -> both exit0 (F1064_typecheck.log / F1064_build.log).
- Scoped Biome: pnpm exec biome lint apps/server/src/lib/ci.ts apps/server/test/lib/ciFinishCancellation.test.ts -> 2 files, no fixes, exit0 (F1064_lint.log). Formatter disabled by config.
- Source review: CI source diff contains only the proven update predicates/result check and cancellation-history ownership, plus explanatory comment. Concurrent root/server manifest changes were reread: version0.18.25->0.18.26 only, no engine/dependency/script change. README/Quickstart/About/changelog/version/package release edits belong to another writer and are not staged by this round.
- NOT RUN: full repository/server coverage, hosted CI, live CI/Docker, native Mac bootstrap. Full-release certification remains separate from this focused audit.
- Next scope: lib/ci.ts appendLog sequence/budget writes and runner log protocol; concurrent stale lease snapshots may overlap file append and metadata persistence, so write a fresh proof before any patch.
- Preflight correction: cached diff --check initially caught one extra EOF blank line in the new permanent test. Removed only that trailing blank line; assertions/source logic unchanged. Rerun of guarded staging and both diff checks follows.
- Publication preflight after EOF correction: guarded19-path staging, cached and working-tree diff --check, limited staged credential/runtime/line-ending scan passed. Only owned CI source/test/Mac docs/evidence and F1064 changelog hunk selected. Final wrapper verifies all selected HEAD blobs before push.
