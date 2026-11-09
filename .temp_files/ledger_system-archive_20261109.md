## Round 11 — system archive rollback ownership
### Setup
- Scope confirmed: apps/server/src/lib/systemArchive.ts, apps/server/test/systemArchiveRace.test.ts and adjacent rollback regression test if needed; required narrow CHANGELOG entry. HEAD8c6d71ab; source/race test clean. Status captured in audit_continuous_20261109/round11_status_before.txt. Other capability/localization/docs work retained.
- CONTRIBUTING applies; no nested AGENTS. Current root/server manifests/config: Node26.13.0, pnpm11.23.0, TypeScript7, Vitest5.0.5/V8 serial files, tsc build/typecheck, Biome2.5.14/formatter disabled, no race/sanitizer. No dependencies installed.
- Entire source, nearest race test and panelBackup integration test read; callers export/import APIs and panel backups share this helper.
- Invariants: import/export refuse overlapping state swaps; rollback restores both original contents and original absence; worker resumes only after rollback; failed imports remove scratch files. Imported files must not survive as mixed state after an explicit failed operation.
- Candidate F1042: restoreFrom only moves originals that exist in backupDir. If a destination was absent, a newly installed key/Traefik dir survives a later env-write failure even though DB is rolled back. Local proof uses real tar and disposable directories, injected copyFileSync error at env write, existing-file control, no real panel state.

### F1042 root cause recorded before patch
- ownership, High: failed full-state restore publishes a mixture of old database and imported credentials/routing. Explicit failure must not leave imported files behind; this is local rollback evidence, not a live data-loss incident.
- F1042_before.log exit1, existing DB/key/routes control restored; absent key/routes both present after injected late failure; PROBLEM CONFIRMED.
- Narrow patch: track successfully installed members (and attempted env copy, which may be partial); on rollback remove an installed member only when no original was backed up, otherwise use the existing original-file restore. Preserve unmentioned pre-existing paths. No API/config/schema/archive format or dependency change.
- Expanded permanent scope: apps/server/test/systemArchiveRollback.test.ts; gated worker stop/release, real tar, existing/absent/mixed destinations, partial env failure, worker resume and scratch cleanup.

### Summary
One High ownership defect confirmed, narrowly fixed and promoted. Local rollback evidence covers contents and absence; no live restore or cross-platform certification.
### Toolchain
Node26.13.0, pnpm11.23.0, TypeScript7, Vitest5.0.5/V8, tsc, Biome2.5.14 from current manifests/config; formatter disabled, no race/sanitizer. System tar used on disposable fixtures.
### Findings
#### F1042 — ownership — High — failed imports retain newly installed files
- Location: apps/server/src/lib/systemArchive.ts:280, importSystemArchive/restoreFrom.
- Root cause: rollback restored only backed-up originals, ignoring destinations originally absent; late failure left imported key/routes (or DB/env) beside restored original state.
- Proof (before): audit_continuous_20261109/prove_F1042_archive_rollback.test.ts, F1042_before.log exit1; existing-file control passed; absent key/routes present after failure; PROBLEM CONFIRMED.
- Patch: track successful installed members and attempted potentially partial env copy; remove those paths if no backup existed, otherwise restore originals as before. Unmentioned existing paths retained. No API/schema/config/archive-format/dependency change.
- Proof (after): unchanged original exit0/PROBLEM NOT REPRODUCED. Independent verify_F1042_archive_rollback.test.ts ran three consecutive times, FIX VERIFIED: absent-file rollback, omitted-original preservation, successful install, malformed archive cleanup. Worker stop/release gates force completion; no sleeps.
- Regression test: apps/server/test/systemArchiveRollback.test.ts; before 3 failed/1 passed, after 4 passed. All-present, all-absent, DB-only and key-only original states; partial env write, gated stop, original contents/absence, scratch/lock cleanup and worker resume.
### Not reproduced (dropped)
None additional; no speculative archive schema or trust-boundary rewrite.
### Validation
- Focused: root pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts with named proof/verifier --reporter=verbose: original after passed and verifier runs1/2/3 passed.
- Scope: pnpm --dir apps/server exec vitest run test/systemArchiveRollback.test.ts test/systemArchiveRace.test.ts test/panelBackup.test.ts test/panelBackupLock.test.ts test/plugins/panelBackupScheduler.test.ts --coverage=false: 27 passed/5 files (F1042_scope.log).
- Build/typecheck: pnpm --dir apps/server typecheck and build each exit0; retained logs.
- Format/lint: pnpm exec biome lint apps/server/src/lib/systemArchive.ts apps/server/test/systemArchiveRollback.test.ts: 2 checked/no fixes; formatter disabled.
- git diff --check on source/regression/changelog paths: exit0.
- NOT RUN: full repository/release/coverage, live panel restore, Linux/macOS native filesystem acceptance, filesystem faults at every rollback step. Failed rollback still surfaces and leaves the worker stopped as before.
### Boundaries
Real tar and filesystem data in disposable directories; controlled copyFileSync error/partial write and fake audit seam. Native process cwd restored. No real credentials/database/panel touched or production incident claimed.
### Working tree
Other service-capability/localization/docs work retained. Only own source/test/changelog hunk and audit evidence selected for commit. No reset/stash/evidence cleanup.
### Next scope (if rounds continue)
apps/server/src/lib/releaseRecords.ts and apps/server/test/releaseRecords.test.ts — release identity persistence and rollback targeting.
