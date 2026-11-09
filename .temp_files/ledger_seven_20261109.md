# Evidence audit — seven scopes — 2026-11-09

User authorization: all seven scopes from the selection card, sequentially. No delegated agents.
Scope confirmed: apps/server/src/lib/{ownedSettings,settingRows}.ts; apps/server/src/{engine,plugins}/swarmRecovery.ts; apps/server/src/plugins/runtimeState.ts; apps/server/src/plugins/backupScheduler.ts and apps/server/src/lib/backupPolicy.ts; apps/server/src/lib/{backupRestoreVerification,backupDrill}.ts; apps/server/src/lib/{nodeSleepCoordinator,nodeSleepController}.ts; apps/server/src/lib/{webhooks,webhookDispatch}.ts; matching server tests. Evidence in .temp_files/audit_seven_20261109/.

## Setup
- CONTRIBUTING.md read. No root/nested AGENTS.md found in the seven scopes; .wrongstack/AGENTS.md is outside scope.
- Starting status and patch retained in audit_seven_20261109/status_before.txt and diff_before.patch. Shared tree changed between initial scope-selection turn and audit authorization; latest baseline recorded before any production edits. No pre-existing content reverted.
- package.json: Node ^22.23.4 || ^24.22.1 || ^26.12.1; pnpm@11.23.0; TypeScript ^7.0.2; Vitest ^5.0.5; Biome ^2.5.14; Turbo ^2.11.2. Live Node v26.13.0 and approved pinned pnpm 11.23.0.
- apps/server/package.json: tests `vitest run --coverage`, build `tsc`, typecheck `tsc --noEmit`, lint `biome lint .`.
- apps/server/vitest.config.ts: node environment, fileParallelism:false, V8 coverage and thresholds. No race detector/sanitizer configured. biome.json disables formatter. No packages installed.
- pnpm version sandbox access to the package-manager store lock denied; exact command rerun with user approval succeeded. PowerShell Get-FileHash unavailable; baseline hashes captured with Node crypto instead (no validation substituted).
- Historical findings reach F1033; new finding IDs start at F1034. Historical ledgers retained unchanged.

## Invariants
1. Settings ownership: exact prefix and owner boundaries; malformed keys and live owners survive orphan sweeping; zero prefixes returns zero rows.
2. Swarm recovery: lease token/generation and manager identity must remain valid before native mutation; shutdown aborts and drains the active loop; unknown runtime state is retained for review.
3. Runtime reconciliation: unavailable inspections do not prove runtime absence; stale work cannot overwrite a stopped/replaced row or publish alerts after close.
4. Backups: failed attempts never evict completed recovery points; unknown policy/read errors never trigger default retention; shutdown unregisters policy listeners and drains work.
5. Restore verification: only this operation's container/files are cleaned; unsupported/environment failures cannot become successful restore claims; truncated input fails structural validation.
6. Node sleep: no Stop before confirmed catcher routing; every async effect is fenced by current admission; closed coordinator dispatches no new work; recovery does not consume fresh idle evidence.
7. Webhooks: replay suppression is isolated by provider and dispatch scope; same-scope duplicate signed bodies remain suppressed even with changed delivery IDs; unrelated services can accept the same repository push.

## Findings
### F1034 — bug — Medium — Delivery ID replay keys suppress other services and providers
- Location: apps/server/src/lib/webhooks.ts, isReplayedDelivery, bare `keys.push(id)`.
- Root cause (recorded before production patch): delivery IDs are in a global namespace while body hashes are scoped by provider/service. A legitimate delivery for service 2 collides with service 1's ID despite a different scoped body key. Provider IDs collide too.
- Impact: a repository push accepted for one configured service may be ignored by another; unrelated providers can suppress each other's deliveries. Medium: missed automatic deployments, no live exploit claim.
- Before proof: audit_seven_20261109/prove_F1034_webhook_replay_scope.test.ts → control first=false duplicate=true; EXPECTED sibling replay=false | ACTUAL true; PROBLEM CONFIRMED, exit 1. Full output in proofs_before.log.
- Before permanent regression: test/lib/webhooks.test.ts, delivery replay isolation: two failures on cross-service and cross-provider assertions (regressions_before.log). Existing tests passed.
- Planned narrow patch: namespace delivery IDs with provider and optional caller scope, keeping existing body-hash checks and expiry. Only process-local keys change; no API, config, wire or persisted format changes.

### F1035 — bug — Medium — Unknown Docker inspect failures are treated as missing runtimes
- Location: apps/server/src/plugins/runtimeState.ts, containerState catch and patrolTargets nonzero-exit branch.
- Root cause (recorded before production patch): every non-daemon-classified local exception returns `gone`, and every fan-out nonzero exit writes `error`; neither branch requires Docker to report a missing object. Node-primary patrol already checks explicitly for missing-object text.
- Impact: permission/API/timeout errors falsely set service or target status to error; local path emits a service-down alarm. Medium: incorrect persisted state and alerts during observation failures.
- Before proof: audit_seven_20261109/prove_F1035_runtime_unknown_inspect.test.ts → healthy control updates=[] alerts=0; permission failure EXPECTED updates=[] alerts=0 | ACTUAL updates=[{status:error}] alerts=1; fan-out EXPECTED updates=[] | ACTUAL [{status:error}]; PROBLEM CONFIRMED, exit 1. proofs_before.log retained.
- Before permanent regression: five new assertions fail, 95 existing tests pass across runtime/webhooks (regressions_before.log; seven total failures including F1034).
- Planned narrow patch: classify gone only on an explicit no-such-object/container diagnostic; propagate other local exceptions to existing per-service warning/skip catch, and skip unknown fan-out failures.

## Validation
### Scope review coverage
1. Settings ownership — ownedSettings.ts/settingRows.ts and ownedSettings.test.ts read. Checked exact owner boundaries, prefix wildcard escaping, live-owner preservation during sweep, malformed IDs, refused route deletion, empty prefix list. No new reproduced defect; source unchanged.
2. Swarm recovery — engine and plugin source and both nearest tests read. Checked live-lease exclusion, manager/native identity fencing, revision conflicts, cancellation/Stop, unreadable journal, recover-before/after submission, loop shutdown. No new reproduced defect; source unchanged.
3. Runtime reconciliation — full source and nearest runtimeState/runtimeStateSwarm/runtimePatrolShutdown tests read. F1035 fixed and promoted; existing stale-state/lifecycle guards retained.
4. Backup scheduler/policy — full source and scheduler/policy/remote-prune tests read. Checked failed/completed retention separation, unavailable policy reads, remote-delete failure/budget, local/remote limits and policy re-arm. No new reproduced defect; source unchanged.
5. Restore verification/drill — source and structural/restore/staging/cleanup tests read. Checked bounded helper capacity, strict restore/probe errors, caller-owned backup preservation, encrypted/remote staging, lost-create cleanup, corrupt/truncated archive controls. No new reproduced defect; source unchanged. Real Docker restores are NOT RUN.
6. Node sleep — coordinator/controller source and admission/recovery/concurrency/controller tests read. Checked opaque evidence admission, four-slot bound, lost Stop receipts, superseding deploy/Stop, routing restoration and close during a gated callback. No new reproduced defect; source unchanged.
7. Webhook delivery — webhooks/webhookDispatch source, hooks/GitHub App/utility tests read. F1034 fixed and promoted; existing signature, branch/watch-path/skip, preview privilege and SHA-dedup gates retained.

### After evidence
- Unchanged prove_F1034/prove_F1035 rerun: three assertions passed, PROBLEM NOT REPRODUCED on sibling-service, local-inspect and fan-out cases, exit 0. proofs_after.log.
- verify_F1034: cross-service duplicate, changed-ID/same-body duplicate, cross-provider, empty-body ID, no-ID/no-body, legacy unscoped ID, fake epoch-zero timestamp and 24h+1ms expiry.
- verify_F1035: healthy, permission, internal API error, timeout, daemon-down and explicit missing-container/object responses; local and fan-out paths; next-service continuation and absence of spurious starts/alerts. First expanded verifier attempt exposed a fake-DB fixture returning a target for both primary services; the fixture was corrected, with production unchanged. The final verifier passed three consecutive runs.
- Both verifiers: three consecutive executions, exit 0 each, FIX VERIFIED (two per run); verify_1.log/verify_2.log/verify_3.log.
- Permanent regression tests: apps/server/test/lib/webhooks.test.ts (two tests) and apps/server/test/runtimeState.test.ts (five parameter cases). Before: seven failed and 95 passed. After: 102 passed, exit 0 (regressions_before.log/regressions_after.log).
- The initial scope test command accidentally named two nonexistent paths (test/runtimePatrolShutdown.test.ts and test/githubAppHooks.test.ts); actual test paths are test/plugins/runtimePatrolShutdown.test.ts and test/modules/githubAppHooks.test.ts. Vitest ran 19 matching files, 440 passed and two newly added F1034 tests failed; test files were edited while this source-unmodified baseline was running. This is not used as a pristine original-test baseline. Final scope command fixes both paths and explicitly adds nodeSleepAuthority and edgeCasesWebhooksAndAlerting.
- Final scope target: 23 files, 519 tests passed, exit 0; scope_tests_after.log (158.72s). Tests serialize via project fileParallelism:false. No coverage output written by this audit.
- Typecheck: pnpm.cmd --filter @ninedeploy/server typecheck → exit 0, `tsc --noEmit`; typecheck.log.
- Build: pnpm.cmd --filter @ninedeploy/server build → exit 0, `tsc`; build.log.
- Scoped lint: pnpm.cmd exec biome lint apps/server/src/lib/webhooks.ts apps/server/src/plugins/runtimeState.ts apps/server/test/lib/webhooks.test.ts apps/server/test/runtimeState.test.ts → exit 0, Checked 4 files. No fixes applied; lint.log.
- git diff --check → exit 0. Git reported only configured LF-to-CRLF notices, no whitespace errors. Formatter NOT RUN (disabled in biome.json).

### Exact commands
All commands run at repo root unless cwd stated. Output redirected to audit_seven_20261109/<log> under .temp_files.

```powershell
# Original before/after proof (proofs_before.log exit 1; proofs_after.log exit 0)
pnpm.cmd exec vitest run --config .temp_files/audit_seven_20261109/vitest.config.ts .temp_files/audit_seven_20261109/prove_F1034_webhook_replay_scope.test.ts .temp_files/audit_seven_20261109/prove_F1035_runtime_unknown_inspect.test.ts --reporter=verbose
# Expanded verification, run three consecutive times, exits 0/0/0
pnpm.cmd exec vitest run --config .temp_files/audit_seven_20261109/vitest.config.ts .temp_files/audit_seven_20261109/verify_F1034_webhook_replay_scope.test.ts .temp_files/audit_seven_20261109/verify_F1035_runtime_unknown_inspect.test.ts --reporter=verbose
# Regression tests, cwd apps/server (regressions_before.log exit 1; regressions_after.log exit 0)
pnpm.cmd exec vitest run test/lib/webhooks.test.ts test/runtimeState.test.ts --coverage=false --reporter=verbose
# Seven-scope target, cwd apps/server (scope_tests_after.log exit 0)
pnpm.cmd exec vitest run test/ownedSettings.test.ts test/swarmRecovery.test.ts test/plugins/swarmRecovery.test.ts test/runtimeState.test.ts test/runtimeStateSwarm.test.ts test/plugins/runtimePatrolShutdown.test.ts test/lib/backupPolicy.test.ts test/plugins/backupScheduler.test.ts test/plugins/backupSchedulerPolicy.test.ts test/plugins/backupSchedulerRemotePrune.test.ts test/lib/backupDrill.test.ts test/lib/backupDrill.coverage.test.ts test/lib/backupRestoreVerification.test.ts test/lib/nodeSleepCoordinator.test.ts test/lib/nodeSleepCoordinatorConcurrency.test.ts test/lib/nodeSleepController.test.ts test/lib/nodeSleepRecovery.test.ts test/lib/nodeSleepAuthority.test.ts test/lib/webhooks.test.ts test/hooks.test.ts test/modules/githubAppHooks.test.ts test/webhookPanelUrl.test.ts test/edgeCasesWebhooksAndAlerting.test.ts --coverage=false --reporter=verbose
pnpm.cmd --filter @ninedeploy/server typecheck
pnpm.cmd --filter @ninedeploy/server build
pnpm.cmd exec biome lint apps/server/src/lib/webhooks.ts apps/server/src/plugins/runtimeState.ts apps/server/test/lib/webhooks.test.ts apps/server/test/runtimeState.test.ts
git diff --check
```

## Not reproduced (dropped)
- No failed runnable candidate was converted into a speculative patch. The five unchanged scopes have bounded review/test coverage, not a guarantee of defect absence.
- Settings Unicode upper-bound overflow: production callers use declared ASCII prefixes, so no reachable product defect was established; no patch.
- Backup scheduler close not draining an active dump: reviewed against historical ledger and actual server lifetime; no new impact proof established this round, no patch. This is not a lifecycle certification.

## Boundaries
- Local controlled proofs and project tests only. Real daemon/provider deployment, broad security assessment, full monorepo/server coverage, release certification and hosted CI NOT RUN (bounded seven-scope audit).
- Another owner ran server coverage concurrently. This audit did not stop it, reset/stash anything, or write coverage. Audit scope tests use isolated fixture data and serialized files.
- A single process-spawn attempt received OS Access denied and the unchanged read command succeeded on retry; not evidence of a product failure.
- No dependency, public API/schema/config/persisted-format changes. F1034 changes only process-local replay key construction. No commit, push or cleanup.
- CONTRIBUTING.md's changelog update remains outside the user's concrete source/test scopes. CHANGELOG.md already has unrelated concurrent edits and was not edited by this audit; findings and operator effects are recorded here.

## Working tree
- Own modifications: apps/server/src/lib/webhooks.ts; apps/server/src/plugins/runtimeState.ts; apps/server/test/lib/webhooks.test.ts; apps/server/test/runtimeState.test.ts. All four were clean at baseline; no overlap with dirty-file baseline.
- Preservation check: 41/44 baseline files byte-identical; portableSettings.ts, CHANGELOG.md and COMPETITIVE_ROADMAP_2026-11.md changed concurrently and were never written by this audit. preservation.json records exact paths. Final git status is retained verbatim in audit_seven_20261109/status_after.txt. The four audit files were clean at baseline; no pre-existing hunk was edited.

## Round 1 — Seven authorized source/test scopes
### Summary
Seven scopes reviewed; two Medium bugs confirmed, patched and promoted to seven permanent regression cases. Five scopes had no new reproduced finding. Both verifiers passed three consecutive runs. This is bounded local audit evidence, not live/release certification.

### Toolchain
Node v26.13.0; pnpm 11.23.0; TypeScript ^7.0.2; Vitest ^5.0.5 with V8 coverage configured; Biome ^2.5.14, formatter disabled. Sources: package.json, .node-version, apps/server/package.json, apps/server/vitest.config.ts, biome.json. No race detector/sanitizer configured. Nothing installed.

### Findings
#### F1034 — bug — Medium — Replay delivery keys collide across services/providers
- Location: apps/server/src/lib/webhooks.ts:132, isReplayedDelivery.
- Root cause: a process-global delivery ID key omitted provider and service identity.
- Proof (before): .temp_files/audit_seven_20261109/prove_F1034_webhook_replay_scope.test.ts → EXPECTED sibling replay=false; ACTUAL true; PROBLEM CONFIRMED, exit 1; same-service control passed.
- Patch: apps/server/src/lib/webhooks.ts:132 namespaces IDs using provider, optional scope and ID.
- Proof (after): .temp_files/audit_seven_20261109/verify_F1034_webhook_replay_scope.test.ts → FIX VERIFIED, three runs; original proof → PROBLEM NOT REPRODUCED, exit 0.
- Regression test: apps/server/test/lib/webhooks.test.ts:7; two cases, observed red then green.

#### F1035 — bug — Medium — Unreadable Docker inspect is recorded as missing runtime
- Location: apps/server/src/plugins/runtimeState.ts:95 and :282, containerState/patrolTargets.
- Root cause: generic exceptions and nonzero inspection replies were treated as confirmed container absence.
- Proof (before): .temp_files/audit_seven_20261109/prove_F1035_runtime_unknown_inspect.test.ts → healthy control passed; EXPECTED no changes/alerts; ACTUAL status=error and local alerts=1; fan-out status=error; PROBLEM CONFIRMED, exit 1.
- Patch: apps/server/src/plugins/runtimeState.ts:95 and :282 require an explicit missing-object/container reply; unknown local errors reach the existing warning/skip handler, unknown target errors are skipped.
- Proof (after): .temp_files/audit_seven_20261109/verify_F1035_runtime_unknown_inspect.test.ts → FIX VERIFIED, three runs; original proof → PROBLEM NOT REPRODUCED, exit 0.
- Regression test: apps/server/test/runtimeState.test.ts:111 and :119; five cases, observed red then green.

### Not reproduced (dropped)
No executable candidate failed to reproduce. Unicode-prefix overflow and backup-close draining were unsubstantiated leads; no production changes. Other five scopes' reviewed boundaries are listed above.

### Validation
- Focused tests: exact proof and verifier commands above → original proofs green; verifiers green 3x; permanent test command → 102 passed.
- Scope tests: exact 23-file Vitest command above → 23 files / 519 tests passed, exit 0 (scope_tests_after.log).
- Build/typecheck: pnpm.cmd --filter @ninedeploy/server typecheck; pnpm.cmd --filter @ninedeploy/server build → both exit 0.
- Format/lint (scoped): exact four-file Biome command above → exit 0; formatter NOT RUN because disabled.
- git diff --check: exit 0.
- NOT RUN: full monorepo/server coverage, hosted CI, release gate and real Docker/provider deployment — bounded audit scope, with a concurrent coverage owner left undisturbed.

### Boundaries
No live exploitation or deployment claim. Controlled fake boundaries plus existing loopback/process fixtures. Shared checkout received unrelated concurrent edits; no unrelated content, dependencies or persisted formats changed by this audit. Changelog remains outside source/test scope.

### Working tree
git status --short recorded in .temp_files/audit_seven_20261109/status_after.txt. Own diff is four previously clean files. Pre-existing work was not edited: 41/44 original file hashes unchanged; three changed externally (paths in preservation.json). No commit, push, reset, stash or cleanup.

### Next scope (if rounds continue)
None — all seven requested scopes completed.

Awaiting instructions for the next turn.
