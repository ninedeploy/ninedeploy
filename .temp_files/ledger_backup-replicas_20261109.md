# Evidence audit — backup replicas — 2026-11-09

## Setup
- User authorized continuous independent scopes until stopped. Scope confirmed: apps/server/src/lib/backupReplicas.ts, apps/server/test/lib/backupReplicas.test.ts and a required narrow CHANGELOG.md entry.
- Starting HEAD: 2294b6fe3a56a50f4c9d6c0e399d2716555bcf34, pushed to origin/main. git status --short was empty. All prior user/audit work is committed and preserved.
- CONTRIBUTING.md and source/test files read; no applicable source AGENTS.md found in previous scan. TypeScript ^7.0.2, Node v26.13.0, pnpm 11.23.0, Vitest ^5.0.5 (V8 coverage configured, serial server files), tsc build/typecheck, Biome ^2.5.14 lint, formatting disabled. Sources: root and server package.json, tsconfig.base.json, server Vitest config, biome.json. No race detector/sanitizer configured; nothing installed.
- No prior ledger for backupReplicas.ts found. Last finding F1036; next F1037.
- Callers: plugins/backupScheduler.ts serializes backup work per database; modules/backupPolicy.ts permits an operator to replace/remove replica destinations while an upload is in flight. Those callers are read-only context, not patch scope.

## Invariants
- An upload failure at one destination never prevents other destinations from being attempted.
- Failed remote deletes keep their copy log entry; a copy is not credited as removed before confirmation.
- Copies at a destination removed from the replica list stay in its bucket and leave the log, as setBackupReplicas explicitly documents.
- After every asynchronous upload/delete, destructive retention uses the currently authorized destination list and retention count; a policy raised during a pending upload must not lose the newly retained recovery point.
- Publishing upload results must preserve policy edits made during that upload; opaque credentials never enter stored error/public views unnecessarily.

## Candidates
- Stale retention policy after an upload: confirmed as F1037 below.

## Findings
### F1037 — race — High — Replica retention deletes under a policy withdrawn during upload
- Location: apps/server/src/lib/backupReplicas.ts, replicateBackup, retention loop after await put().
- Root cause (recorded before patch): destructive retention uses the initial replica list and retainCount captured before asynchronous upload. The final reread protects only list publication; it occurs after remote deletion and cannot restore the deleted recovery point.
- Impact: an operator removing a replica destination (whose documented copies must stay) or raising retainCount while upload is pending still loses the old remote recovery point. High: confirmed destructive backup retention under stale policy; no live external-bucket test/exploit claim.
- Before proof: `.temp_files/audit_continuous_20261109/prove_F1037_stale_replica_retention.test.ts` via `pnpm.cmd exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts .temp_files/audit_continuous_20261109/prove_F1037_stale_replica_retention.test.ts --reporter=verbose` → exit 1 (F1037_before.log).
  CONTROL EXPECTED unchanged keep=1 deletes old.dump | ACTUAL [nd/old.dump]
  EXPECTED removed-policy deletes=[]; raised-policy deletes=[] | ACTUAL both [nd/old.dump]
  PROBLEM CONFIRMED
- Proof uses real migrated SQLite, real settings helpers and crypto, injected put/remove functions and explicit entered/release promises. No sleeps or network. No source changed before this evidence.
- Planned patch: reread the currently listed replica and its retention count before each delete, stop if removed, and recompute which locally recorded copies remain stale after each completed delete. Already-started remote deletion is not claimed cancellable. No persisted/API/config changes.

## Round 3 — Backup replica retention
### Summary
One High race confirmed, fixed and promoted to three permanent gated regression cases. The verifier passed three consecutive runs, including edits during upload and between deletes. In-flight deletes already submitted before a policy edit cannot be undone.

### Toolchain
TypeScript ^7.0.2, Node v26.13.0, pnpm 11.23.0 (root/server package.json and runtime checks); Vitest ^5.0.5 with V8 coverage and serial server files (server Vitest config); build `tsc`, typecheck `tsc --noEmit` (server package.json); Biome ^2.5.14, formatter disabled (root package.json/biome.json). No configured race detector/sanitizer. No dependency installed.

### Findings
#### F1037 — race — High — Withdrawn or raised replica retention still deletes old recovery points
- Location: apps/server/src/lib/backupReplicas.ts:120, replicateBackup.
- Root cause: the pre-upload replica snapshot authorized every subsequent remote deletion, even after the policy changed. A final reread could preserve the list but not recover the deleted object.
- Proof (before): .temp_files/audit_continuous_20261109/prove_F1037_stale_replica_retention.test.ts → unchanged-policy control deletes old.dump; removing the destination or raising retention during the gated upload still deletes old.dump; PROBLEM CONFIRMED, exit 1 (F1037_before.log).
- Patch: reread current membership/count before each delete and recompute the next stale copy after each completion. Only backupReplicas.ts, its nearest test and CHANGELOG.md changed.
- Proof (after): .temp_files/audit_continuous_20261109/verify_F1037_stale_replica_retention.test.ts → FIX VERIFIED three times; original proof → PROBLEM NOT REPRODUCED, exit 0. Eight gated phase/policy combinations (unchanged/remove/raise/lower, during put or during first delete), empty-list and failed-destination controls.
- Regression test: apps/server/test/lib/backupReplicas.test.ts:32, two upload edit cases and one gated delete edit case. Before patch: 3 failed / 4 passed; after patch: all 7 passed within scope. Real migrated SQLite; all ordering explicit barriers, no sleeps.

### Not reproduced (dropped)
None. Concurrent duplicate uploads are not claimed covered: the current scheduler serializes per-database jobs. No unrelated concurrency refactor.

### Validation
- Focused tests: proof command below → exit 1 before, exit 0 after; verifier command below → three exits 0 / FIX VERIFIED. All outputs retained with F1037 prefixes.
- Scope tests: cwd apps/server, `pnpm.cmd exec vitest run test/lib/backupReplicas.test.ts test/backupPolicyRoutes.test.ts test/plugins/backupSchedulerPolicy.test.ts test/plugins/backupScheduler.test.ts test/plugins/backupSchedulerRemotePrune.test.ts --coverage=false --reporter=verbose` → 5 files / 48 tests passed, exit 0 (F1037_scope_after.log).
- Build/typecheck: `pnpm.cmd --filter @ninedeploy/server typecheck`; `pnpm.cmd --filter @ninedeploy/server build` → both exit 0 (F1037_typecheck.log/F1037_build.log).
- Format/lint (scoped): `pnpm.cmd exec biome lint apps/server/src/lib/backupReplicas.ts apps/server/test/lib/backupReplicas.test.ts` → Checked 2 files, exit 0 (F1037_lint.log). Formatter NOT RUN, disabled.
- git diff --check: exit 0.
- NOT RUN: full monorepo/server coverage, live S3 deletion, hosted CI and release gate for this new patch — bounded scope, previous handoff's shared-coverage boundary remains separately recorded. No real remote objects deleted.

### Boundaries
The fake S3 seam models completed uploads/deletes; persisted configuration and copy logs use the real database. An already-started remote delete is not cancelled by an edit that arrives afterward; the next delete rechecks. No distributed/multi-process guarantee inferred. A PowerShell profile startup failure (oh-my-posh process access denied) occurred before one command; the unchanged test command was rerun without profile and produced the actual regression failures. No threshold weakened.

### Working tree
Started clean at pushed 2294b6fe. Final source status: M CHANGELOG.md; M apps/server/src/lib/backupReplicas.ts; M apps/server/test/lib/backupReplicas.test.ts. No unrelated edits appeared or were overwritten. User's commit/push authorization for cross-machine continuation remains in force; selected proof/verifier/ledger artifacts are retained and included individually. No reset/stash/cleanup.

### Next scope (if rounds continue)
apps/server/src/lib/backupCrypto.ts and test/lib/backupCrypto.test.ts — encrypted stream validation, temporary-file ownership and failed writes.

### Exact focused commands
```powershell
pnpm.cmd exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts .temp_files/audit_continuous_20261109/prove_F1037_stale_replica_retention.test.ts --reporter=verbose
pnpm.cmd exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts .temp_files/audit_continuous_20261109/verify_F1037_stale_replica_retention.test.ts --reporter=verbose
# Before permanent regression, cwd apps/server: 3 failed / 4 passed
pnpm.cmd exec vitest run test/lib/backupReplicas.test.ts --coverage=false --reporter=verbose
```
