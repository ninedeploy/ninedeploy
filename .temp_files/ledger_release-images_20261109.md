# Evidence audit — release image retention — 2026-11-09

## Authorization and scope
User explicitly authorized independently chosen, continuous audit scopes until asked to stop. The subsequent macOS setup and commit/push request steers the active task; continuous auditing resumes after that handoff.

Scope confirmed: apps/server/src/lib/releaseImageRetention.ts, releaseRecords.ts, imageInventory.ts, their nearest tests (test/releaseImageRetention.test.ts, test/releaseRecords.test.ts, test/lib/imageInventory.test.ts and test/lib/r057-imageInventory-keepLast.test.ts), and required CHANGELOG.md entries. imageInventory.ts is included because the retained-record prune delegates the actual image deletion/accounting to it. No other production files may be patched in this round.

## Setup
- Root CONTRIBUTING.md read; no applicable root/nested AGENTS.md found in apps/server. Existing dirty/staged changes, including the previous audit fixes, are preserved.
- Toolchain from root/server package.json, tsconfig.base.json, apps/server/vitest.config.ts and biome.json: TypeScript ^7.0.2, Node ^22.23.4 || ^24.22.1 || ^26.12.1 (current v26.13.0), pnpm@11.23.0, Vitest ^5.0.5, tsc build/typecheck, Biome ^2.5.14 lint, formatter disabled, V8 coverage. Server test files serialize. No configured race detector/sanitizer. No dependency added.
- Existing source and nearest tests read before candidates. Historical ledger scan found no ledger for this combined release-image scope. Last completed finding F1035; next free ID F1036.
- Read-only callers traced in deploys.ts, pipeline.ts, autoPrune.ts, housekeeping.ts and images.ts. A suspected nested-lock deadlock was ruled out by reading the real Compose restore route: storeReleaseRecord is called in a DB transaction but not inside withReleaseImageLock. No proof or patch for that observation.

## Invariants
- Every retained Docker artifact and encrypted Compose record protects its immutable image IDs; malformed/unreadable retained records refuse cleanup rather than silently returning an incomplete protection set.
- Publication and cleanup share one process-local FIFO lock, released on both success and failure.
- A restore availability read distinguishes missing images from an unavailable daemon and does not expose decrypted content or private connection errors.
- Prune dry-run and real deletion honor release protection and in-use images.
- A failed deletion can credit only images independently confirmed absent; an inspect permission/transport/timeout failure is not proof of successful deletion.

## Current state
The handoff's targeted server run passed 1,793 tests in 27 files, including all four existing release/image-inventory test files. Full root typecheck/lint/build and the other package suites passed; server coverage could not acquire its report directory because another Vitest owner (pid 138464) was active. That process was not interrupted and no alternate report directory was substituted.

## Findings
### F1036 — bug — Medium — Failed deletion and unreadable image inspection report false reclaimed space
- Location: apps/server/src/lib/imageInventory.ts, pruneImages/stillExists, original lines 271–278.
- Invariant: only successful deletion or an independently confirmed missing image may be credited in removed/removedLabels/freedBytes.
- Root cause (recorded before patch): stillExists converts every image-inspect exception to false, so daemon, permission, API and timeout failures are interpreted as proof that a failed image removal succeeded.
- Impact: the API, CLI and automatic-prune summaries report removed images and reclaimed bytes when neither operation confirmed deletion. Medium: incorrect cleanup outcome/accounting; no data loss or live-daemon claim.
- Before proof: .temp_files/audit_continuous_20261109/prove_F1036_unconfirmed_image_removal.test.ts, command `pnpm.cmd exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts .temp_files/audit_continuous_20261109/prove_F1036_unconfirmed_image_removal.test.ts --reporter=verbose` → exit 1.
  CONTROL EXPECTED: successful removal / explicit absence credited | ACTUAL: both credited
  EXPECTED: removed=[] freedBytes=0 | ACTUAL: removed=[sha256:aaaa…], freedBytes=1048576
  PROBLEM CONFIRMED
  Full stdout/stderr retained in audit_continuous_20261109/F1036_before.log. Date fixed in Vitest; all Docker calls supplied through the production ImageCommands seam, no network/real daemon.
- Planned patch: retain unknown inspection outcomes (credit no deletion); only an explicit missing-image/object response returns false. No schema/API/config/persisted format change.

## Round 2 — Release image retention and removal accounting
### Summary
One Medium bug confirmed, patched and promoted to four regression cases. No defect proved in release-record encryption, serialization or locking. The source change corrects outcome accounting only; no live Docker deletion claim.

### Toolchain
From package.json/apps/server/package.json: Node v26.13.0 (supported range above), pnpm 11.23.0, TypeScript ^7.0.2, test `vitest run --coverage`, build `tsc`, typecheck `tsc --noEmit`, lint `biome lint .`. apps/server/vitest.config.ts configures V8 coverage and serial files; biome.json disables formatting. No race detector/sanitizer configured. No dependencies installed.

### Findings
#### F1036 — bug — Medium — Unknown inspect errors credit failed image removal
- Location: apps/server/src/lib/imageInventory.ts:275, pruneImages/stillExists.
- Root cause: catch-all returned false (absent) for any follow-up inspect error after a failed removal.
- Proof (before): .temp_files/audit_continuous_20261109/prove_F1036_unconfirmed_image_removal.test.ts → successful removal/explicit absence controls passed; EXPECTED removed=[] freedBytes=0; ACTUAL removed=[sha256:aaaa…] freedBytes=1048576; PROBLEM CONFIRMED, exit 1. F1036_before.log retained.
- Patch: imageInventory.ts catch returns absent only for an explicit missing-image/object error. CHANGELOG.md records the corrected operator-visible outcome. Four parameterized regression cases added in test/lib/imageInventory.test.ts.
- Proof (after): .temp_files/audit_continuous_20261109/verify_F1036_unconfirmed_image_removal.test.ts → FIX VERIFIED three consecutive times; unchanged original proof → PROBLEM NOT REPRODUCED, exit 0. Verifier includes permission/daemon/timeout/API errors, repeated calls, confirmed absence, known-presence, mixed partial deletion, no images and retained-release protection. No sleeps, external services or live Docker calls.
- Regression test: apps/server/test/lib/imageInventory.test.ts, failed-removal confirmation → four failures before production patch; all four passed after. Medium finding promoted voluntarily.

### Not reproduced (dropped)
- Nested release-lock deadlock was ruled out by actual caller tracing; no runnable failing candidate, no patch.

### Validation
- Focused tests: original proof command above → exit 1 before, exit 0 after. Verifier command below → three exits 0 and FIX VERIFIED. Permanent regression command below → four failures before, four passes as part of scope after.
- Scope tests: cwd apps/server, `pnpm.cmd exec vitest run test/lib/imageInventory.test.ts test/lib/r057-imageInventory-keepLast.test.ts test/releaseImageRetention.test.ts test/releaseRecords.test.ts --coverage=false --reporter=verbose` → 4 files / 76 tests passed, exit 0 (F1036_scope_after.log).
- Build/typecheck: `pnpm.cmd --filter @ninedeploy/server typecheck`; `pnpm.cmd --filter @ninedeploy/server build` → both exit 0, F1036_typecheck.log/F1036_build.log.
- Format/lint (scoped): `pnpm.cmd exec biome lint apps/server/src/lib/imageInventory.ts apps/server/test/lib/imageInventory.test.ts scripts/dev-macos.mjs packages/sdk/test/panelAccess.test.ts` → Checked 4 files, exit 0, F1036_lint.log; formatter NOT RUN, disabled in biome.json.
- git diff --check: exit 0; staged diff check also passed before handoff.
- NOT RUN: live Docker deletion and hosted CI. Complete root gate reached server coverage but was refused by another owner's report-directory lock. That process and lock were left untouched; no alternate report directory/threshold changes used.

### Boundaries
Controlled production ImageCommands seam with fake Date. The full handoff otherwise passed the workspace static gates and seven other package test targets; see docs/MACOS_DEVELOPMENT.md for the exact independent Windows results and physical-Mac boundary. User explicitly authorized commit/push of all current work for the cross-machine handoff; that supersedes the audit's default no-commit restriction. Unrelated pre-existing code edits are preserved and included under that authorization.

### Working tree
Round source was clean before patch (both staged and unstaged source diffs were empty). Own round diff is imageInventory.ts, its nearest test and the narrow changelog line. Existing staged work from the seven-scope audit and other features is preserved and included in the explicitly authorized handoff commit. No reset/stash/revert/cleanup occurred. Commit identity and remote confirmation are reported separately after push.

### Next scope (if rounds continue)
apps/server/src/lib/backupReplicas.ts and test/lib/backupReplicas.test.ts — best-effort replication, cleanup and persisted outcomes.

### Exact focused commands
```powershell
pnpm.cmd exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts .temp_files/audit_continuous_20261109/prove_F1036_unconfirmed_image_removal.test.ts --reporter=verbose
pnpm.cmd exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts .temp_files/audit_continuous_20261109/verify_F1036_unconfirmed_image_removal.test.ts --reporter=verbose
# Before promotion check, cwd apps/server; exit 1, four failures
pnpm.cmd exec vitest run test/lib/imageInventory.test.ts -t failed-removal --coverage=false --reporter=verbose
```
