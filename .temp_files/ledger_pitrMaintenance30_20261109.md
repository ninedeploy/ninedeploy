## Round 30 — point-in-time recovery maintenance policy freshness
### Summary
Scope confirmed: apps/server/src/lib/pitr.ts (pitrMaintenance) and nearest lib/pitr tests, required changelog/docs/evidence. Read root CONTRIBUTING, implementation, public settings caller and nearest tests before candidate. One High race confirmed, fixed and promoted; four permanent tests.

### Toolchain
Root/server package.json: Node ^22.23.4 || ^24.22.1 || ^26.12.1 (live 26.13.0), pnpm 11.23.0, Vitest 5.0.5/V8, TypeScript 7.0.2 (tsc --noEmit/build), Biome 2.5.14. Server Vitest serializes files and isolates data. No configured race detector.

### Invariants
- A retention increase committed during maintenance must govern destructive pruning after the await.
- A database no longer running/eligible/enabled must not receive a stale maintenance/prune dispatch.
- Recovery/base-backup ownership prevents pruning an in-use WAL archive.
- Existing user settings and unrelated error reports must be preserved.

### Findings
#### F1052 — race — High — stale PITR retention after maintenance awaits
- Location: apps/server/src/lib/pitr.ts, pitrMaintenance prune dispatch.
- Root cause (before patch): pitrMaintenance forwards its input snapshot's pitrRetentionDays after archiver/baseBackup awaits; setPitr explicitly permits retention-only changes while a base backup is running. The persisted update is ignored by the next destructive prune.
- Proof before: prove_F1052_pitrRetention.test.ts, F1052_before.log -> EXPECTED 14 ACTUAL 1, PROBLEM CONFIRMED at both gated stages; two unchanged-policy controls passed, two changed-policy cases failed, exit 1. Real migrated SQLite, public setPitr commits checked independently before inspecting prune calls.
- Severity: High data-loss race. Engine retentionPlan uses the supplied days to select old base backups and WAL for deletion. Proof verifies stale dispatch at the injected prune seam, not live PostgreSQL deletion.
- Planned narrow patch: reread current row before prune dispatch, require eligibility and idle archive after the read, then pass the current row/current retention. No engine/internal deletion-format changes.
- Permanent regression: apps/server/test/lib/pitr.test.ts, four explicit archiver/baseBackup gate/control cases.
- Patch: before prune, reload the current row and require enabled, eligible, running and no recovery/base backup in flight after that read; pass current row and retention. No engine/API/storage format changed.
- Proof after: F1052_after.log, four passed; changed cases EXPECTED 14 ACTUAL 14, PROBLEM NOT REPRODUCED.
- Independent verification: verify_F1052_pitrRetention.test.ts uses migrated SQLite, real retentionPlan with two synthetic base-backup ages, 1/7/14/35 day boundaries at both gates, disabled/stopped/deleted rows and an overlapping base backup explicitly started during refresh. Twelve cases passed three consecutive times, FIX VERIFIED (F1052_verify_1/2/3.log).

### Not reproduced (dropped)
No other finding claimed. Stale policy was reproduced at the prune dispatch seam; live WAL deletion was not attempted.

### Validation
- Focused proof/verifier: pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts <prove_F1052_pitrRetention.test.ts or verify_F1052_pitrRetention.test.ts> --reporter=verbose -> before two failed/two controls passed; after four passed; verifier twelve passed x3.
- Scope: pnpm --dir apps/server exec vitest run test/lib/pitr.test.ts test/lib/pitrDeps.test.ts test/modules/pitr.test.ts test/engine/postgresPitr.test.ts test/plugins/pitrScheduler.test.ts --coverage=false --reporter=verbose -> 51 passed / five files (F1052_scope_retry.log). First run was interrupted without a final runner result and is NOT a pass (F1052_scope.log); its process session was gone after the user continuation arrived.
- Default pnpm --dir apps/server typecheck -> native TypeScript/Go VirtualAlloc errno=1455, out of memory (F1052_typecheck.log); not a TypeScript diagnostic or successful check.
- Serial resource-bounded retries: temporary process GOMAXPROCS=4, pnpm --dir apps/server typecheck / build -> both exit 0 (F1052_typecheck_bounded.log / F1052_build_bounded.log). Environment value restored in finally, no repository/runtime config change. Source assertions/thresholds unchanged. FreeVirtualMemory measured about 6.6 GiB-equivalent KB units, FreePhysicalMemory about 20.5 million KB after failure; no unrelated processes killed.
- Lint: pnpm exec biome lint apps/server/src/lib/pitr.ts apps/server/test/lib/pitr.test.ts -> checked two files, no fixes, exit 0 (F1052_lint.log). Formatter disabled by repo config.
- git diff --check -> exit 0; staged evidence checked again before commit.
- NOT RUN: full root gate, native Mac/DMG/Keychain, live PostgreSQL recovery/WAL deletion. Concurrent source work ongoing; no exact-commit certification claimed.

### Boundaries
Migrated SQLite and public setPitr updates with explicit gates establish policy freshness at prune dispatch. Real retentionPlan establishes its consequence on synthetic base-backup ages; no live archive was deleted. Checks do not cancel already-started backups or revalidate policy during the engine's own awaited inventory/deletion work; that is a separate scope. Query guards suppress pruning for newly ineligible rows and archive ownership changes during the refresh. Compile validation is resource-bounded as recorded above, not a full default-environment gate.

### Working tree
Snapshot: audit_continuous_20261109/round30_status_before.txt; final status recorded in round30_status_after.txt. Concurrent auth/setup/installer/frontend/schema/SDK changes are preserved. Stage only our lib/pitr.ts, its four new test cases, Mac handoff update, own changelog hunk and selected round 28–30 evidence. Previous no-finding round evidence is included explicitly, not the whole scratch directory.

### Next scope (if rounds continue)
apps/server/src/lib/pitr.ts recovery/prune admission and nearest tests: archive ownership while engine inventory or recovery work is suspended.
