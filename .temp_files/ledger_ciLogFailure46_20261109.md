## Round 46 — CI log filesystem-failure acceptance
### Summary
Scope confirmed: apps/server/src/lib/ci.ts appendLogInOrder file acceptance/metadata rollback, nearest real-file CI tests, required changelog/docs/evidence. Current serialized writer and sequential file admission tests read; initial setup before patch, final evidence below.
### Toolchain
Node26.13.0, pnpm11.23.0, TypeScript7.0.2, Vitest5.0.5/V8, Biome2.5.14 formatter disabled, package0.18.26 current; same root/server manifests/config, serial files/isolated data/no configured race detector. No new dependency.
### Invariants
- A chunk whose file open/write fails must not be acknowledged as stored on retry merely because metadata was advanced first.
- A partial failed append preserves earlier accepted bytes and leaves the failed sequence retryable.
- Same-file queue ownership releases on failure; different files and already-full/empty chunks retain behavior.
### Findings
F1066 confirmed and repaired below.
### Not reproduced (dropped)
No unrelated candidate bundled.
### Validation
Pending.
### Boundaries
Real migrated SQLite/files, real path blocker plus injected one-shot file write fault/partial append at node:fs boundary. Single panel-process log ownership from round45; multi-process and simultaneous persistent DB+filesystem rollback failure are separate acceptance boundaries.
### Working tree
round46_status_before.txt; round45 ef0c994ed74c20be75baa53ad5a3267ee093cabc owned blobs verified and origin main matched. Preserve unrelated CHANGELOG/release work.
### Next scope (if rounds continue)
GitHub runner pool upkeep, recorded below.

### F1066 — ownership/bug — Medium — failed log append consumes its sequence and loses retry data
- Location: lib/ci.ts appendLogInOrder metadata reservation before mkdir/append.
- Root cause BEFORE patch: logSeq/logBytes advance before file creation/write. A file failure throws, but retry sees seq already committed and returns stored:false. A partial append also leaves unaccepted trailing bytes.
- Before: prove_F1066_ciLogFailure.test.ts / F1066_before.log -> 3 failed / 1 unaffected accepted-write control passed, exit1, PROBLEM CONFIRMED. One-shot pre-write and partial-write faults after accepted prefix: EXPECTED oldseq1/prefix/retry stored, ACTUAL seq2 and retry false, partial suffix retained. Real parent-path blocker: EXPECTED seq0/retry stored, ACTUAL seq1/retryfalse, no accepted bytes.
- Severity Medium permanent loss/misleading acknowledgement of CI diagnostics after recoverable filesystem errors. No live disk outage or secret exposure claim.
- Planned narrow patch: open owned append descriptor/capture prior byte length before DB reservation; retain the existing metadata CAS; on append failure truncate that descriptor to prior size and conditionally roll back only this sequence/byte reservation while holding round45's same-file queue. Close descriptor in finally. Propagate primary failure; aggregate rollback errors rather than report success. No new schema/wire/dependency/config.
- Permanent regression: apps/server/test/lib/ciLogFailure.test.ts, four real DB/file control/fault cases observed red before patch (Medium bug promoted because of file ownership/partial-byte preservation).

### Intermediate patch verification before descriptor correction
- F1066_after.log was 2 failed/2 passed: directory pre-open now preserved seq0, but rollback produced AggregateError. F1066_diagnostic.log exposed ftruncate EPERM on the append-only descriptor.
- Independent native Node probes F1066_descriptor_diagnostic.mjs and F1066_flags_diagnostic.mjs/log reproduced Windows behavior: both a/a+ append descriptors reject ftruncate EPERM, while r+ permits it. This is a concrete limitation of the initial patch, not a passing run.
- Before correction: retain append descriptor for atomic append semantics, but open a separate r+ rollback descriptor; verify its device/inode matches the still-owned append descriptor before truncating, then close it in finally. A path replacement must never truncate another file. No production assertion is weakened.

### Final acceptance
- Final patch: open/capture file before metadata reservation, then on a recoverable append failure restore the same file's prior byte length and conditionally restore this exact seq/byte reservation. Close append/recovery descriptors in finally. Windows recovery uses r+ and device/inode identity against the still-owned append descriptor, so a replacement path is not truncated. Existing CAS/status admission and round45 file queue remain intact. No schema/wire/config/dependency change.
- Original final: F1066_after_descriptor.log -> 4 passed, before/partial-write EXPECTED seq1/prefix/retry stored and ACTUAL matching; parent-blocker seq0/retry stored, PROBLEM NOT REPRODUCED. F1066_after.log was an intermediate failed patch, not acceptance.
- Independent verifier: verify_F1066_ciLogFailure.test.ts -> 10 passed in each F1066_verify_1/2/3.log, FIX VERIFIED. First-write error, repeated partial multi-byte UTF8 with byte-accurate retry, real parent blocker, pre-execution DB admission failure, gated cancellation before CAS, gated metadata rollback with queued retry, separate truncate/DB-rollback failure reporting, replacement-file identity preservation, empty chunk without writable path. All tracked append/recovery descriptors close; no sleeps.
- Dual-failure boundaries were tested for explicit AggregateError/handle closure ONLY. A truncate failure can retain partial bytes; a DB rollback failure can retain the reservation. Automatic subsequent recovery, cross-process ownership, post-commit lost responses and abrupt process/power loss are NOT certified and are not claimed fixed.
- Permanent regression: apps/server/test/lib/ciLogFailure.test.ts, four cases observed red then green on real SQLite/files.
- Scope: pnpm --dir apps/server exec vitest run test/lib/ciLogFailure.test.ts test/lib/ciLogOrdering.test.ts test/lib/ciFinishCancellation.test.ts test/lib/ciClaimRevocation.test.ts test/lib/ciClaimCapacity.test.ts test/lib/ciClaimCancellation.test.ts test/lib/ciLeaseSweep.test.ts test/modules/ci.test.ts test/ciRunner.test.ts test/lib/ciDeployGate.test.ts test/lib/ciGate.test.ts test/lib/ciGate.coverage.test.ts --coverage=false --reporter=verbose -> 100 passed / 12 files (F1066_scope.log).
- Compile: child-process GOMAXPROCS=4 pnpm --dir apps/server typecheck and build -> both exit0 (F1066_typecheck.log/F1066_build.log).
- Scoped Biome: pnpm exec biome lint apps/server/src/lib/ci.ts apps/server/test/lib/ciLogFailure.test.ts -> 2 files, no fixes, exit0 (F1066_lint.log). Formatter disabled by config.
- NOT RUN: complete repository/server coverage, exact-commit hosted CI, live CI/Docker, native Mac bootstrap. This Windows descriptor probe does not replace a native Mac acceptance run.
- Next scope: plugins/githubRunnerScheduler.ts with lib/githubRunners.ts upkeep/close ownership and nearest tests; autonomous scope selection remains authorized.
- Publication preflight: guarded25-path staging, cached and working-tree diff --check, limited staged credential/runtime/line-ending scan passed. Only owned CI source/test/Mac docs/evidence and F1066 changelog hunk selected; unrelated changelog excluded. Final wrapper verifies every selected HEAD blob before push.
