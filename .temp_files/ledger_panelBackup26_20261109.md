## Round 26 — panel backup retention during settings changes
### Summary
Investigation in progress. Scope confirmed: apps/server/src/lib/panelBackup.ts and nearest panel-backup tests; required changelog and audit artifacts included.

### Toolchain
Root package.json pins pnpm 11.23.0, Node ^22.23.4 || ^24.22.1 || ^26.12.1, Vitest 5.0.5, Biome 2.5.14. apps/server/package.json uses TypeScript 7.0.2, tsc --noEmit/build; server vitest.config.ts serializes test files and provides isolated data roots. No race detector configured for this TypeScript scope.

### Invariants
- A successfully uploaded backup remains available even if retention fails.
- Retention must honor the operator's increased retention or changed destination before dispatching another destructive delete after an await.
- Only matching panel objects are eligible; never delete the just-uploaded object or unrelated objects.
- The run owns its scratch archive and sealed file and releases busy on every exit.
- Settings PUT permits changes while a run is active; manual backup is permitted while the schedule is disabled.

### Findings
None confirmed yet. Candidate: runPanelBackup captures retain/destination before archive/upload and reuses them after upload/list/delete awaits.

### Not reproduced (dropped)
None yet.

### Validation
Pending runnable proof. Read source and panelBackup.test.ts, panelBackupLock.test.ts, panelBackupScheduler.test.ts, and route caller before candidate. No production patch yet.

### Boundaries
Real macOS development/Keychain/DMG remains unverified. Full root gate remains incomplete as recorded in ledger_release-checkpoint20_20261109.md. No external S3 access planned.

### Working tree
Snapshot: audit_continuous_20261109/round26_status_before.txt. Pre-existing stable-channel and installer work belongs to another writer and will be preserved.

### Next scope (if rounds continue)
apps/server/src/plugins/panelBackupScheduler.ts and nearest tests: callback ownership across configuration reads, re-arm and close.

#### F1050 — race — High — stale panel retention deletes backups after settings changes
- Location: apps/server/src/lib/panelBackup.ts, runPanelBackup and prunePanelBackups.
- Root cause (recorded before production patch): runPanelBackup snapshots cfg before archive/encryption/upload; prunePanelBackups snapshots the keep set before awaited deletes. Neither rechecks the operator's committed retention/destination before destructive work resumes. Settings PUT explicitly permits changes during a run.
- Impact/severity: irreversible deletion of old recovery artifacts despite an increased keep count or destination switch; High data-loss race.
- Proof before: audit_continuous_20261109/prove_F1050_panelRetention.test.ts -> EXPECTED no old objects deleted after retain=4; ACTUAL three deleted; PROBLEM CONFIRMED; 3 failed / 1 unaffected control passed, exit 1 (F1050_before_corrected.log).
- Fixture correction: first run assumed oldest-first deletion; production sorts newest-first. Corrected only order expectations before rerunning against unchanged production. Initial F1050_before.log retained; it is not the qualifying proof.
- Planned narrow patch: keep exported prune signature; internal policy-aware pruning rereads current settings before each delete, skips former destination, recomputes keep set from current retain. In-flight already-dispatched delete cannot be canceled. Manual disabled-schedule backups remain supported.
- Permanent regression: apps/server/test/panelBackupRetention.test.ts; explicit upload/delete gates, synthetic settings/S3/archive seams, real file encryption and cleanup. Does not prove real S3 or database concurrency.
Additional gated edge (F1050_partial_patch_edge.log): raising keep count to 2 after the first dispatched deletion still deleted all three old objects in the initial patch; 1 failed / 4 passed. Root cause: recomputed keep set counted already-deleted names. Track successful deletions in the live name set before computing the next keep set. This extends the same stale-retention finding; initial patch is not accepted.

### Final summary and validation
One High race fixed; five permanent regressions protect the branch. Private policy-aware pruning preserves the exported prunePanelBackups signature. Before each deletion it rereads retain/destination and recomputes the keep set from surviving objects. An already-dispatched deletion cannot be recalled.

- Original proof after final patch: F1050_original_final.log -> four passed, PROBLEM NOT REPRODUCED.
- Independent verify_F1050_panelRetention.test.ts: 16 tests per run, three consecutive clean runs, FIX VERIFIED. Explicit upload/list/delete gates, increased retention, changed/cleared destination and failed upload. F1050_verify_1/2/3.log.
- Scope: pnpm --dir apps/server exec vitest run test/panelBackupRetention.test.ts test/panelBackup.test.ts test/panelBackupLock.test.ts test/plugins/panelBackupScheduler.test.ts --coverage=false --reporter=verbose -> 26 passed / 4 files (F1050_scope_final.log). Repeated after removing diagnostic console output from permanent tests.
- pnpm --dir apps/server typecheck / build -> both exit 0 (F1050_typecheck.log / F1050_build.log).
- pnpm exec biome lint apps/server/src/lib/panelBackup.ts apps/server/test/panelBackupRetention.test.ts -> checked two files, no fixes, exit 0 (F1050_lint_final.log). Formatter disabled by repository configuration.
- git diff --check -> exit 0. Full release gate/native Mac/DMG/Keychain/live S3 NOT RUN in this bounded round.

### Final boundaries and working tree
Settings/S3/archive seams are synthetic in the race proof; encryption and file cleanup are real. Existing broader panel tests use real SQLite/tar. Same-process configuration is checked at the last awaited read before dispatch; no cross-process transaction or cancellation of already-dispatched deletes is claimed.

The other writer committed stable-channel work as 63f814ec during this round, including the already-written F1050 changelog line. Reread production diff: no external changes to the panel-backup source. Our final dirty paths are panelBackup.ts, new panelBackupRetention.test.ts and the Mac handoff table; no previous work was reverted. Initial snapshot remains round26_status_before.txt. Two long command launches were rejected with CreateProcess Access denied before executing; short commands worked. Selected evidence only will be staged for the authorized commit/push.
