## Round 45 — CI log sequence and file ordering
### Summary
Scope confirmed: apps/server/src/lib/ci.ts appendLog/readLog, modules/ci.ts runner-log caller (read-only), nearest CI tests, required changelog/docs/evidence. Current implementation and existing sequential log/retry/gap tests read before runnable candidate. Initial setup before patch, final results below.
### Toolchain
Root/server package version now0.18.26 from independently committed6a3f6820; engines/scripts/dependencies unchanged: Node26.13.0, pnpm11.23.0, TypeScript7.0.2, Vitest5.0.5/V8, Biome2.5.14 formatter disabled, serialized files/isolated data/no configured race detector.
### Invariants
- Within a panel process, accepted chunk sequence order matches bytes appended to its log file, even while DB update completion is delayed.
- Replayed chunks are acknowledged without duplicate bytes; status/sequence checks use current persisted state after a prior same-file writer completes.
- Different attempt files must not block each other.
### Findings
F1065 confirmed and repaired below.
### Not reproduced (dropped)
No unrelated claim bundled.
### Validation
Pending.
### Boundaries
Real migrated SQLite and actual disposable log files; explicit DB-completion barrier with awaited SQLite read checkpoints, no sleeps/wall-clock ordering. Filesystem-write failure/metadata durability and multiple independent panel processes are separate scopes; do not claim them fixed from an in-process ordering pass.
### Working tree
round45_status_before.txt captures unrelated CHANGELOG edit. Round44 69aa2fce2ca2cd3791ac1a7784fac92801d28291 blobs verified and origin main matched; other release work remains separately owned.
### Next scope (if rounds continue)
CI log filesystem-failure acceptance/metadata durability requires its own proof after ordering scope.

### F1065 — race/ownership — Medium — accepted CI log chunks append out of sequence
- Location: lib/ci.ts appendLog conditional metadata UPDATE followed by file append after await.
- Root cause BEFORE patch: DB sequence admission and actual file append are separate async ownership windows. Chunk1 can persist seq1 while its update result is held, chunk2 reads seq1, persists seq2 and appends first; chunk1 appends last. A retry with the same stale request snapshot also rejects409 rather than acknowledging the committed sequence.
- Proof: prove_F1065_ciLogOrder.test.ts / F1065_before.log -> 2 failed / 1 sequential/replay control passed, exit1, PROBLEM CONFIRMED. Explicit first-update completion barrier; ten awaited native SQLite reads drain pending promise continuations without sleeps, then release first. EXPECTED first\\nsecond\\n ACTUAL second\\nfirst\\n; repeated-snapshot requests EXPECTED2 acknowledgements ACTUAL1. Real migrated DB and log bytes.
- Severity Medium misleading/reordered CI diagnostics and spurious replay conflicts; no live runner or filesystem durability claim.
- Planned narrow patch: serialize the complete admission+append operation by log-file path within the panel process, reread persisted attempt identity/status/sequence after acquiring that queue slot, retain existing SQL CAS and file append semantics. Always release queue state on errors. Different files remain independent. No new dependency/schema/wire/config; multi-process/file-failure durability is not patched by this finding.
- Permanent regression: apps/server/test/lib/ciLogOrdering.test.ts, three cases observed red before patch.

### Final acceptance
- Patch: lib/ci.ts per-log-path promise queue covers fresh persisted attempt lookup, existing SQL admission CAS and synchronous append. finally always releases/removes the queue tail; different files use different keys. No dependency/schema/wire/config change. File-failure durability and multi-process coordination remain explicitly outside this fix.
- Original after: F1065_after.log -> 3 passed, EXPECTED/ACTUAL first\\nsecond\\n, two retry acknowledgements, PROBLEM NOT REPRODUCED.
- Independent verifier: verify_F1065_ciLogOrder.test.ts -> 9 passed in each F1065_verify_1/2/3.log, FIX VERIFIED. Five same-snapshot duplicates append once; different sequences with one old snapshot; gated metadata completion/order and byte counts; independent file completes while another held; gap and injected fresh-read failure release queue; queued writer rereads cancellation; stale running snapshot rejected; empty chunk advances once. No sleeps: explicit promise barrier and ten awaited real native SQLite read checkpoints drain continuations before release.
- Permanent regression: apps/server/test/lib/ciLogOrdering.test.ts, 3 cases observed red then green. Log fixture job ids vary per case and runner invocation data roots are isolated.
- Scope: pnpm --dir apps/server exec vitest run test/lib/ciLogOrdering.test.ts test/lib/ciFinishCancellation.test.ts test/lib/ciClaimRevocation.test.ts test/lib/ciClaimCapacity.test.ts test/lib/ciClaimCancellation.test.ts test/lib/ciLeaseSweep.test.ts test/modules/ci.test.ts test/ciRunner.test.ts test/lib/ciDeployGate.test.ts test/lib/ciGate.test.ts test/lib/ciGate.coverage.test.ts --coverage=false --reporter=verbose -> 96 passed / 11 files (F1065_scope.log).
- Compile: child-process GOMAXPROCS=4 pnpm --dir apps/server typecheck and build -> both exit0 (F1065_typecheck.log, F1065_build.log).
- Biome: pnpm exec biome lint apps/server/src/lib/ci.ts apps/server/test/lib/ciLogOrdering.test.ts -> 2 files, no fixes, exit0 (F1065_lint.log). Formatter disabled by repo config.
- NOT RUN: full repository/server coverage, exact-commit hosted CI, live runner/Docker, native Mac bootstrap. No full-release certification inferred.
- Next scope remains filesystem-failure/metadata durability for the newly serialized log writer; proof first, no speculative durability patch included here.
- Publication preflight: guarded18-path staging, cached and working-tree diff --check, limited staged credential/runtime/line-ending scan passed. Only owned CI source/test/Mac docs/evidence and F1065 changelog hunk selected; unrelated changelog remains excluded. Final wrapper verifies every selected HEAD blob before push.
