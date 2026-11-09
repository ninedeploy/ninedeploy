## Round 42 — CI runner claim capacity
### Summary
Scope confirmed: apps/server/src/lib/ci.ts claimJob capacity admission and nearest CI tests, required changelog/docs/evidence. Current source/callers/claim/cancel/lease tests reviewed before candidate. Initial setup recorded before patch, final results below.
### Toolchain
Root/server manifests and Vitest config unchanged: Node26.13.0, pnpm11.23.0, TypeScript7.0.2, Vitest5.0.5/V8, Biome2.5.14 formatter disabled; serialized files, invocation-isolated data, no configured race detector. CONTRIBUTING.md applies; no new tools/dependencies.
### Invariants
- A runner cannot obtain more live attempts than its configured capacity by overlapping claim requests with reported running=0.
- An admission losing capacity leaves its job queued with its prior attempt count, without an orphan attempt or claim response.
- Successful claims, cancellations, forced revocation and label selection retain behavior.
### Findings
F1062 confirmed and repaired below.
### Not reproduced (dropped)
No other claim bundled; revocation race requires a separate proof.
### Validation
Pending.
### Boundaries
Real migrated SQLite, gated claim reads; no live runner/container. Avoid a process-only lock as the only resource authority because the library promises database-owned durability.
### Working tree
round42_status_before.txt retains unrelated screenshot/E2E edits. Round41 e8219427259d52776cc3ced9c41878202bb02611 source/evidence blobs and origin main verified. Preserve unrelated CHANGELOG hunk/order and screenshot additions.
### Next scope (if rounds continue)
Runner revocation vs claim ownership, recorded below.

### F1062 — race — Medium — overlapping runner claims exceed configured capacity
- Location: lib/ci.ts claimJob live-attempt precheck vs later attempt INSERT.
- Root cause BEFORE patch: capacity is read before queued-job and claim awaits; three simultaneous requests all observe zero and independently claim three different jobs. CAS protects one job from two owners but does not reserve the runner's shared capacity.
- Proof: prove_F1062_ciCapacity.test.ts / F1062_before.log, exit1, 2 failed / 1 unaffected sequential control passed. Explicit three-reader barrier after all capacity checks; capacity1 EXPECTED1 ACTUAL3, capacity2 EXPECTED2 ACTUAL3, PROBLEM CONFIRMED. Real migrated SQLite, no runner/container.
- Severity Medium resource-budget violation; no actual host exhaustion or exploit against an external system claimed.
- Planned narrow patch: recheck running-attempt count atomically inside INSERT using the existing NOT NULL conditional-value technique. Recognize only the specific capacity constraint, return no offer, and conditionally restore that claim's still-running/unassigned job to its earlier queue/attempt-count/start state. Cancellation/newer ownership must not be restored. No transaction spanning async source/secret work, no process-only lock, no new schema/wire/dependency.
- Permanent regression: apps/server/test/lib/ciClaimCapacity.test.ts, three SQLite cases observed red before patch.

### Final validation
- Patch: lib/ci.ts attempt INSERT uses a conditional leaseHash to reject an over-capacity request atomically. Only its specific NOT NULL lease_hash constraint is handled; unrelated errors propagate. The loser restores prior attempts/start fields only while its same claim remains running/unassigned, preventing cancellation revival.
- Original after: F1062_after.log -> 3 passed, EXPECTED/ACTUAL1 and2 with PROBLEM NOT REPRODUCED.
- Independent final verifier: verify_F1062_ciCapacity.test.ts -> 9 passed in each F1062_verify_final_1/2/3.log, FIX VERIFIED. Five contenders with budgets1/2/3, reported-at-cap control, separate runners, prior failed-attempt count/start restoration and successful retry, capacity failure delivered only after cancellation, unrelated injected SQL trigger error, and two independent SQLite clients on the same file with overlapping prechecks.
- Earlier F1062_verify_1.log was 8 passed before the shared-file edge was added. F1062_verify_shared_1.log was 8 passed/1 failed: all capacity assertions passed, but Windows native libSQL file handles made final rmSync EPERM. No product change; the final verifier closes clients and retains/logs each exact disposable temp fixture path. That cleanup-failed run is not counted as an accepted pass.
- One first process spawn was refused with OS access denied before command execution; identical retry started successfully. No product inference or permission bypass.
- Permanent regression: apps/server/test/lib/ciClaimCapacity.test.ts, three SQLite sequential/overlap cases observed red then green.
- Scope: pnpm --dir apps/server exec vitest run test/lib/ciClaimCapacity.test.ts test/lib/ciClaimCancellation.test.ts test/lib/ciLeaseSweep.test.ts test/modules/ci.test.ts test/ciRunner.test.ts test/lib/ciDeployGate.test.ts test/lib/ciGate.test.ts test/lib/ciGate.coverage.test.ts --coverage=false --reporter=verbose -> 83 passed / 8 files, F1062_scope.log.
- Compile: child-process GOMAXPROCS=4 pnpm --dir apps/server typecheck and build -> both exit 0, F1062_typecheck.log and F1062_build.log.
- Biome: pnpm exec biome lint apps/server/src/lib/ci.ts apps/server/test/lib/ciClaimCapacity.test.ts -> 2 files, no fixes, exit0, F1062_lint.log. Formatter disabled by repo config.
- NOT RUN: complete repository/server coverage, exact-commit hosted CI, live runner/Docker, native Mac bootstrap. Full-release boundary remains.
- Concurrent work: b83f3e8b committed the browser screenshot/E2E work independently. Its paths do not overlap this CI source/test repair; no claim that 83 CI tests validate those browser assets.
- Next scope: runner revocation vs in-flight claim ownership in lib/ci.ts; authenticate/revoke/claim publication spans awaits, so reproduce current behavior first.
- Publication preflight: guarded20-path staging, cached and working-tree diff --check, and limited staged credential/runtime/line-ending scan passed. Only owned CI source/tests/docs/evidence and F1062 changelog hunk selected; final wrapper checks all HEAD blobs before push.
