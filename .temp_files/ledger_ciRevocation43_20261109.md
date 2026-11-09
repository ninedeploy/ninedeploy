## Round 43 — runner revocation and in-flight claim admission
### Summary
Scope confirmed: apps/server/src/lib/ci.ts authenticateRunner/revokeRunner/claimJob admission, nearest real DB protocol tests, required changelog/docs/evidence. Source/callers/tests read before candidate; initial setup before patch, final evidence follows.
### Toolchain
Same current root/server manifests and runner config: Node26.13.0, pnpm11.23.0, TypeScript7.0.2, Vitest5.0.5/V8, Biome2.5.14 formatter disabled, serialized files/isolated test data, no configured race detector. No dependencies/tools added.
### Invariants
- Revocation that finishes before a new attempt insert prevents a previously authenticated claim from obtaining a new live lease.
- Work not yet issued remains queued with its previous attempt count; active-attempt revocation/requeue and unaffected runners retain behavior.
### Findings
F1063 confirmed and repaired below.
### Not reproduced (dropped)
No unrelated candidate bundled.
### Validation
Pending.
### Boundaries
Disposable migrated SQLite and gated real client calls, no live runner or secrets. Admission ordering is the claim; cancellation of an already-issued response is not claimed.
### Working tree
round43_status_before.txt; round42 b5e6d6b57ed0fb0ae4cfdbcc70d04f6c0c7ebfef all blobs verified and origin main matched. Preserve unrelated docs/browser work.
### Next scope (if rounds continue)
CI finish/cancellation result ownership, recorded below.

### F1063 — race/ownership — Medium — revoked runner obtains a new lease from an in-flight claim
- Location: lib/ci.ts claimJob INSERT admission vs authenticateRunner/revokeRunner.
- Root cause BEFORE patch: route authenticates a runner once, then claim awaits capacity/queue/claim writes. revokeRunner persists revokedAt and sweeps already-existing attempts; a later INSERT checks only capacity and creates a new running lease after revocation completed.
- Proof: prove_F1063_ciRevocation.test.ts / F1063_before.log, exit1, 2 failed / 1 active-runner+assigned-revocation control passed. Barriers after queue snapshot and immediately before real attempt INSERT; authenticateRunner already returned null after completed revocation, yet EXPECTED no claim/0 attempts, ACTUAL job1/1, PROBLEM CONFIRMED.
- Severity Medium: in-flight request receives new work after runner revocation and creates an orphan lease; no live runner or secret exposure claim. Printed red-assertion lease values belong only to this disposable fixture database.
- Planned narrow patch: extend the existing atomic INSERT conditional to require a persisted non-revoked runner row. Use the already-tested constrained losing-admission rollback, preserving queued job count and cancellation fencing. No new schema/wire/config/dependency/API.
- Permanent regression: apps/server/test/lib/ciClaimRevocation.test.ts, three real SQLite cases observed red before patch.

### Verification expansion before the second narrow patch
- The initial insert-revocation predicate made the original 3-case proof pass (F1063_after.log), but is not final acceptance.
- A stronger real-client after-INSERT/before-publication gate exposed a second handoff window on that partial repair: revokeRunner marked the unassigned attempt lost, but loseAttempt refused to requeue its job because currentAttemptId was still null. claimJob then published the lost attempt into the still-running job and returned it.
- Evidence: F1063_publication_before.log and prove_F1063_publication.test.ts / F1063_publication_proof_before.log -> 1 failed / 3 controls passed, PROBLEM CONFIRMED. Retain both failed logs; do not call the initial repair complete.
- Root cause before further edit: loss reconciliation recognizes only an already-linked currentAttemptId, not the same-number attempt whose assignment is pending. Extend its ownership predicate to linked id OR unassigned same attempt number, both in the row check and atomic update. This also tolerates assignment completing between the read and loss update, without touching a newer-number attempt. Cancellation remains fenced by job status.

### Publication-owner verification expansion before final patch
- Independent verifier exposed two additional publication conditions on the partial loss-reconciliation patch: a newer runner had already claimed attempt2 when the stale claim resumed and overwrote currentAttemptId with lost attempt1; and a lost attempt could be published while its loss-to-job reconciliation was still gated. F1063_verify_owner_before.log -> 2 failed / 6 passed, PROBLEM CONFIRMED.
- Added persisted-revocation/attempt-list gate: revokedAt already committed while revoker's attempt processing is blocked; stale claim must not publish a still-running attempt to that revoked runner. F1063_verify_publication_before.log -> 3 failed / 6 passed.
- Root cause before final edit: assignment checks only job.status=running. It must atomically require the same attempt number/prior currentAttemptId, a running attempt row and an active runner. If publication loses, retire cancellation-owned work as cancelled; reconcile other still-running unassigned attempts through loseAttempt so revocation cannot leave a running/null-current job. Existing owned-pending attempt predicate and conditional writes protect a newer owner.

### Final acceptance
- Final patch: lease INSERT requires a persisted active runner. Assignment atomically requires the same attempt number/prior current owner, a live attempt, and active runner. LoseAttempt recognizes its own same-number unassigned attempt and fences either pending or linked ownership in the job update; publication losers preserve cancellation semantics or reconcile their own still-running loss. Newer attempts remain untouched. No schema/wire/config/dependency change.
- Original final proofs: F1063_proofs_final_after.log -> both original prove_F1063_ciRevocation.test.ts (3) and expanded prove_F1063_publication.test.ts (4) passed, 7 executions / 2 files, PROBLEM NOT REPRODUCED. Earlier F1063_after.log and F1063_final_after.log were intermediate passes before stronger publication gates, not final acceptance.
- Final independent verifier: verify_F1063_ciRevocation.test.ts -> 9 passed in each F1063_verify_final_1/2/3.log, FIX VERIFIED. MaxAttempts1/2 before/after INSERT; newer runner takes requeued attempt2 before stale attempt1 resumes; lost attempt with job read gated; revoked row with attempt-list processing gated; repeated revoke/other active runner and stale revoked snapshot. No sleeps.
- Permanent regression: apps/server/test/lib/ciClaimRevocation.test.ts now 7 cases. Original3 red, expanded after-insert red, then 3 strongest publication-owner cases promoted and observed red (F1063_regression_owner_before.log, 3 failed/4 passed) before the final fencing patch. Final scope includes all7 passing.
- Scope: pnpm --dir apps/server exec vitest run test/lib/ciClaimRevocation.test.ts test/lib/ciClaimCapacity.test.ts test/lib/ciClaimCancellation.test.ts test/lib/ciLeaseSweep.test.ts test/modules/ci.test.ts test/ciRunner.test.ts test/lib/ciDeployGate.test.ts test/lib/ciGate.test.ts test/lib/ciGate.coverage.test.ts --coverage=false --reporter=verbose -> 90 passed / 9 files (F1063_scope.log).
- Compile: child-process GOMAXPROCS=4 pnpm --dir apps/server typecheck and build -> both exit0 (F1063_typecheck.log, F1063_build.log).
- Biome: pnpm exec biome lint apps/server/src/lib/ci.ts apps/server/test/lib/ciClaimRevocation.test.ts -> 2 files, no fixes, exit0 (F1063_lint.log). Formatter disabled by repo config.
- A pre-execution OS access-denied spawn was retried identically; it did not execute tests or mutate source and is not a product result.
- NOT RUN: complete repository/server coverage, exact-commit hosted CI, live CI/Docker, native Mac bootstrap. Existing full-release boundary remains. No claim to revoke a response already issued before revocation.
- Next scope: lib/ci.ts finishAttempt result/cancellation handoff and nearest protocol tests; terminal result acceptance spans separate attempt/job writes and needs a current-source proof.
- Publication preflight: guarded26-path staging, cached and working-tree diff --check, limited staged credential/runtime/line-ending scan passed. Only owned CI source/test/Mac docs/evidence and F1063 changelog hunk selected; unrelated changelog edits remain excluded. Final wrapper verifies all selected HEAD blobs before push.
