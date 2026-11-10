## Round 71 — acknowledged database-import chunk write ownership
### Summary
Scope confirmed: apps/server/src/modules/databaseImports.ts and apps/server/test/modules/databaseImportChunkRace.test.ts; prior admission/route/job tests and SDK uploader read-only. Current823b7924 selected blobs/remote verified, setup round71_status_before.txt clean. Same existing module instructions/toolchain as round70; no dependency install.
### Toolchain
Node26.13.0/TS7.0.2/Vitest5.0.5/Biome2.5.14, actual Fastify/native libsql/disposable file handles. Mock fs/promises.open delegates to native; only writes are gated. Gates expose an acknowledged first write, a second request's actual metadata snapshot, and the second physical write. No sleeps.
### Invariants
An acknowledged chunk must remain immutable under duplicate-index retries. Sequential duplicate with same size is already a no-op regardless of retry bytes; concurrent retry must preserve that behavior. SQL metadata CAS alone is not file ownership. Keep different import uploads independent; failed/invalid writes must release admission if serialization is required. Every recursive disposal verifies its resolved registered OS-temp root/descendants.
### Findings
Pending executable proof, no source patch.
### Boundaries
Native upload bytes and DB metadata only; no live restore/SQL execution, authentication bypass or security scan bypass claim. Check both an intermediate chunk and final pending transition. No multi-process locking guarantee inferred.

#### F1090 — race / ownership — Medium — acknowledged chunk overwritten by concurrent retry
Location: databaseImportRoutes chunk PUT. Root cause: the physical write precedes the metadata compare-and-swap, so a request holding the old receivedBytes snapshot can overwrite an acknowledged winner even when its own SQL update loses. Before: F1090_before.log, 2 failed / 1 unaffected sequential-duplicate control passed; EXPECTED SELECT 1; ACTUAL SELECT 2; PROBLEM CONFIRMED; Vitest exit 1. Patch plan: per-plugin, per-import FIFO covering fresh row validation, native file write/close, and metadata publication. Initial authorization read remains before admission; fresh row is read within it. Public API/persisted format unchanged. No distributed-lock claim.

### Verification progress
Original proof after: 3 passed, both races PROBLEM NOT REPRODUCED. Independent verifier initial run: 8 assertions passed but suite FAILED due Vitest5 afterAll fixture parsing; invalid run retained, not counted. Corrected marker hook uses existing task-error tracking. F1090_verify_clean1/2/3.log: each 8 passed, FIX VERIFIED. Native write failure and validation failures release ownership; next index uses fresh metadata; unrelated imports progress; same/different-byte retries and intermediate/final transitions preserve bytes and audit count. Permanent test seen red against guarded exact original source: 5 failed / 3 controls passed, exit1; repaired source restored only after no-drift comparison. Initial scope command accidentally named nonexistent modules/databaseImport014Wiring.test.ts: 138/4 passed, not wiring certification; corrected command follows. Resource-bound server typecheck/build passed. Initial scoped lint found two new-test unused declarations; removed, rerunning.

### Validation
Focused: original3/3 after; independent8/8 three clean runs; permanent old-source5 failures/3 controls. Scope: pnpm --dir apps/server exec vitest run test/modules/databaseImportChunkRace.test.ts test/modules/databaseImportAdmissionRace.test.ts test/modules/databaseImports.test.ts test/lib/databaseImport.test.ts test/databaseImport014Wiring.test.ts test/engine/databaseImportEngine.test.ts --coverage=false --reporter=verbose:156 tests/6files passed. Compile: GOMAXPROCS4 pnpm --dir apps/server typecheck and build passed. Configured Biome check changed two TS files: clean. git diff --check passed. Formatter disabled by repository configuration; no dependency install/race detector configured. NOT RUN: full server/root release coverage, live restore, multi-process, Mac execution; scope is native local file/SQLite admission.
### Not reproduced (dropped)
None.
### Working tree
Setup clean. Only owned module/new regression/docs/changelog/evidence selected; no unrelated modifications observed.
### Next scope
Chunk native-write result handling: verify short successful writes do not advance metadata beyond persisted bytes.

Publication preflight:21 exact owned staged paths; cached diff check and limited staged-content scanner passed. No comprehensive secret/security audit inferred. Selected blob verification and exact remote follow in guarded publication receipt.
