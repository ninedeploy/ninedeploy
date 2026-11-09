## Round 35 — GitOps check publication after configuration removal
### Summary
Scope confirmed: apps/server/src/lib/instanceGitops.ts config/check publication, apps/server/src/modules/instanceGitops.ts callers and nearest instanceGitops tests, required changelog/docs/evidence. Root instructions, setters/runGitopsCheck, DELETE/check/apply callers and existing tests read before candidates. One Medium ownership race confirmed, fixed and promoted to ten permanent regression/control cases.

### Toolchain
Root/server package.json: Node ^22.23.4 || ^24.22.1 || ^26.12.1 (live 26.13.0), pnpm 11.23.0, Vitest 5.0.5/V8, TypeScript 7.0.2, Biome 2.5.14. Serial test files with isolated data; no configured race detector. Compiler uses explicit child-process GOMAXPROCS=4 as recorded in previous rounds.

### Invariants
- DELETE /gitops clears config and lastCheck; an older in-flight check must not resurrect the cleared row after deletion has completed.
- Unchanged configurations still store their successful/failed check result.
- A check may not publish a late result as the current result after its configuration is replaced/removed/recreated.
- Existing completed history and already-started API apply side effects require separate consideration; do not assume cancellation/rollback.

### Findings
#### F1056 — race/ownership — Medium — old GitOps results resurrect removed state
- Location: lib/instanceGitops.ts config/check setters and runGitopsCheck; modules/instanceGitops.ts apply result publication.
- Root cause (before patch): check and apply read a config, await checkout/work, and unconditionally publish CHECK_KEY. DELETE independently clears both rows but carries no ownership revision or write-order fence.
- Proof before: prove_F1056_gitopsDeletion.test.ts, F1056_before.log -> one unchanged-config control passed/one deleted-config case failed; cleared lastCheck reappeared after gated checkout, PROBLEM CONFIRMED, exit 1.
- Expanded publisher proof before: prove_F1056_gitopsPublishers.test.ts, F1056_publishers_before.log -> check/apply each resurrected the cleared row; two failures/two unchanged-config controls passed, exit 1. Original proof retained unchanged.
- Severity: Medium stale persisted state/ownership violation. No deployment rollback/cancellation or external alert delivery claimed.
- Planned patch: per-DB in-memory config revision and a short settings read/write queue; config writes invalidate revisions, check/apply capture a serialized config snapshot and publish only under the captured revision. Queue publications with config/clear writes so a DELETE that completes cannot be overtaken by an older pending publication. Check rejects stale publication with a standard conflict to suppress scheduler alerts; apply returns its completed step result to its caller but skips stale shared-state publication. No persisted format/schema/dependency change.
- Permanent regressions: four check/apply gate/control cases in apps/server/test/instanceGitops.test.ts, seen red before patch.
- Final patch: a per-DB WeakMap owns the config revision and short settings read/write queue. The revision increments inside the serialized config write (not when queued). Config snapshots capture a matching revision; conditional setLastCheck returns whether it published. runGitopsCheck rejects a stale result with the existing conflict error shape (HTTP 409); apply still returns its completed step report while skipping stale shared-state publication. No persisted config/schema/dependency change. Existing completed history is not cleared merely by PUT; DELETE continues clearing both rows.
- Original proofs after final code: F1056_original_final.log -> six executions across the two original/expanded proof files passed, PROBLEM NOT REPRODUCED. The duplicate control executions are not aggregate coverage.
- Independent final verification: verify_F1056_gitopsOwnership.test.ts -> 13 passed, FIX VERIFIED, three consecutive clean runs (F1056_verify_fenced_1/2/3.log). Tests cover removal/replacement/identical-config recreation, newer result protection, failed checkout, writer/delete ordering, SQL insert failure recovery and queued-read revision ordering.
- Final permanent coverage: eight endpoint/config-change gate/control cases, one real SQLite trigger-induced publication failure/retry and one gated queued-snapshot ordering case in apps/server/test/instanceGitops.test.ts. Ten new tests, source parsing/SQLite/HTTP behavior real; checkout/API apply calls are controlled fixtures.

### Not reproduced (dropped)
No further finding claimed. Old completed history may remain after an ordinary PUT, as before. Already-admitted apply side effects are not canceled/rolled back; their step report remains available to the requesting client. Cross-process/external SQL config mutation is not fenced by the in-memory revision.

### Validation
- Original proofs after initial patch: F1056_after.log -> six passed across the original and expanded publisher proofs, PROBLEM NOT REPRODUCED.
- First independent verifier attempt timed out: its replacement scenario awaited another API apply while an older checkout was deliberately blocked. Existing readSpecFromRepo readQueue already serializes checkouts, so this was a fixture deadlock, not a product regression. Kept F1056_verify_1.log and F1056_verifier_fixture_before.ts, corrected only that scenario to publish a current-owner result through the real setLastCheck seam.
- Stopped only the owned stuck Vitest process tree (PID 92672), revalidated node.exe/unique verify_F1056_gitopsOwnership.test.ts command line immediately before taskkill /T. No unrelated process terminated. Verifier retry logs use new names; no failure log overwritten.
- This was an intermediate incomplete checkpoint; the final checks are listed below.
- Additional permanent queued-snapshot edge exposed an incomplete initial repair (F1056_partial_patch_snapshot.log): expected stale publication rejected/false, actual true, one failure/16 unselected tests skipped. Revision increment occurred when a config write was queued, letting an earlier queued read capture a future revision with old config. Move the increment into the serialized config write itself so revision and stored config share the same ordering. This is a defect in the unaccepted initial patch, not a separate baseline finding.
- Earlier 10-case and 12-case verifier checkpoints passed three times each, then were extended when the queued snapshot edge was found. Only the final 13-case fenced runs certify the final patch.
- Final focused commands: pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts <original proof paths or verify_F1056_gitopsOwnership.test.ts> --reporter=verbose -> original six passed, independent 13 passed x3.
- Final scope: pnpm --dir apps/server exec vitest run test/plugins/gitopsScheduler.test.ts test/instanceGitops.test.ts test/instanceGitops.coverage.test.ts test/gitopsCleanup.test.ts --coverage=false --reporter=verbose -> 31 passed / four files (F1056_scope_final.log). Earlier 30-case run predates the final queued-snapshot repair and is retained separately.
- Final typecheck/build: child-process GOMAXPROCS=4, pnpm --dir apps/server typecheck / build -> both exit 0 (F1056_typecheck_final.log / F1056_build_final.log). No repository/shared environment config changed. Default compiler environment was not recertified.
- Final lint: separate pnpm exec biome lint calls on lib/instanceGitops.ts, modules/instanceGitops.ts and test/instanceGitops.test.ts -> each checked one file/no fixes/exit 0 (F1056_lint_final.log). Formatter disabled by repo config.
- git diff --check and git diff --cached --check -> exit 0. Limited selected-content scan: 35 staged files, no common credential-pattern matches, runtime files/index line endings passed; not a comprehensive security audit.
- NOT RUN: full root release gate/latest exact-commit hosted server CI, live Git/provider/deployment/notification proof. Earlier Desktop run 42675648656 certifies only its own 9ac991cc desktop source, not this server patch.

### Boundaries
Real migrated SQLite and repository-file parsing with gated checkout; actual Fastify injection and SQLite trigger failure prove persistence/conflict behavior. No remote git, live deployment or cross-process serialization claim. Queue slots contain only short settings reads/writes; checkout and apply API work stay outside them. The first verifier's readQueue deadlock was a fixture error and was corrected without changing the existing checkout queue. One owned process tree was stopped only after PID/command-line revalidation. Repeated CreateProcess Access denied launches were environment failures before execution; their retries were not counted until actual runner/check completion.

### Working tree
Snapshots: audit_continuous_20261109/round35_status_before.txt and round35_status_after.txt. Concurrent auth/setup/installer/doctor work was committed by the other writer as f192c575 and 9a3668e7, then README work as 76d05698; no external changes to the GitOps scope were observed on reread. After the after-snapshot, unrelated old_website deletions plus Biome/issue-template/roadmap/changelog work appeared; all remain unstaged by this audit. Stage only the two GitOps source files, their ten added tests, own changelog hunk, Mac table and selected evidence; retain failed fixture/partial-repair artifacts too. No reset/stash/clean or blanket staging.

### Next scope (if rounds continue)
apps/server/src/plugins/imageScanScheduler.ts and nearest image-scan tests: periodic-scan ownership, overlap, failure handling and close after awaited work.
