## Round 52 — self-hosted runner age versus active job ownership
### Summary
Scope confirmed: apps/server/src/lib/githubRunners.ts MAX_RUNNER_AGE_MS/sweepGithubRunners active-runner admission to reaping and nearest expiry tests, required changelog/docs/evidence. Current source and existing max-age fixture tests read before candidate; initial setup before patch, final evidence below.
### Toolchain
Current Node26.13.0, pnpm11.23.0, package0.18.26, TypeScript7.0.2, Vitest5.0.5/V8, Biome2.5.14 formatter disabled; serial files/isolated data/no configured race detector. No dependencies added.
### Primary upstream contract checked 2026-11-09
- https://docs.github.com/en/actions/reference/limits — self-hosted job execution allowance is five days; GitHub-hosted jobs have a six-hour allowance.
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idtimeout-minutes — job timeout defaults to360 minutes and the runner execution limit bounds a configured longer timeout. The six-hour default is not a universal self-hosted execution ceiling.
- These are current primary docs, not a live five-day job execution test. Do not infer actual long-run/provider behavior from a fixture.
### Invariants
- A valid active self-hosted job cannot be killed solely because its container is older than six hours15 minutes.
- Container creation time is not job execution start time; current confirmed busy/idle state owns normal cleanup decisions.
- Confirmed idle/404, exited-state cleanup and explicit operator stop remain available. Unknown busy state remains fail-closed.
### Findings
F1071 confirmed and repaired below.
### Not reproduced (dropped)
No unrelated candidate bundled.
### Validation
Pending.
### Boundaries
Real migrated metadata plus controlled elapsed now and mocked provider/node/Docker busy state; no wall-clock waiting or live workflow execution. Upstream contract researched separately from executable local stop-request evidence.
### Working tree
round52_status_before.txt. Start at published776f1160df43a5fa862129e9d4b8a0f4e33d921c; one owned round51 receipt update staged, unrelated CHANGELOG and new e2e/tests/04-env-rollback.spec.ts preserved. Redundant wrapper refusal is recorded in round51 receipt, not a source regression.
### Next scope (if rounds continue)
Queued-job status uncertainty, recorded below.

### F1071 — business-logic/ownership — Medium — hosted-runner age assumption stops valid active self-hosted work
- Location: lib/githubRunners.ts MAX_RUNNER_AGE_MS and unconditional age reaping before runnerBusy.
- Root cause BEFORE patch: a container older than6h15m is stopped without checking whether GitHub still reports it busy, based on a comment incorrectly applying the hosted-job ceiling to self-hosted runners. Container age also does not identify when its current job began.
- Before: prove_F1071_ghaLifetime.test.ts / F1071_before.log ->3 failed/2 controls passed, exit1, PROBLEM CONFIRMED. Mock provider busy=true at7h/24h/120h: EXPECTED0 stops ACTUAL1;5h busy and7h idle controls match. Local elapsed-time/data-flow proof, not actual long-running workflow execution.
- Severity Medium valid CI work may be terminated by routine upkeep; no production workload was stopped or live provider contract execution claimed.
- Planned narrow patch: remove the internal hosted-age cutoff and rely on existing confirmed-idle/404 cleanup plus explicit operator stop. Unknown busy state remains retained. GitHub owns configured job-timeout/execution-limit cancellation; no local age guessed from container creation can substitute for that state. No API/schema/config/dependency change.
- Nearest old tests that intentionally exercise the obsolete age branch must be updated to explicit confirmed-idle fixtures or active-busy retention expectations, keeping their actual removal-failure/registration protection assertions.
- Permanent regression: apps/server/test/lib/githubRunnerLifetime.test.ts,5 cases observed red/control before patch.
- Scope extension before patch: docs/GITHUB_APP.md documents the same erroneous six-hour cutoff in its runner lifecycle bullet (line280). Update that operator-facing statement with this finding; other unrelated six-hour backup/stream schedules are outside scope and unchanged.
- Scope verification follow-up: F1071_scope.log ->131 passed/1 failed. One older node-reaping fixture implicitly depended on age overriding an unknown busy response; it now explicitly returns busy:false, preserving all node-stop/callback/deregistration/failure assertions. The two active/unknown age fixtures intentionally change expected behavior because they codified F1071. No assertion timeout or external protection was weakened. Scope retry follows.

### Final acceptance
- Patch: remove the internal hosted-age constant/branch. Existing idle/404 reaping checks current busy state for old running containers too; busy/unknown is retained and explicit stop/exited cleanup remain. No public API/schema/config/dependency change. docs/GITHUB_APP.md now describes actual state/timeout ownership with primary links.
- Original after: F1071_after.log ->5 passed, PROBLEM NOT REPRODUCED. Before3 failures/2 controls preserved in F1071_before.log.
- Independent: verify_F1071_ghaLifetime.test.ts ->24 passed in each F1071_verify_1/2/3.log, FIX VERIFIED. Panel host and node paths; busy at7h/24h/120h; idle/unknown at7h/144h;404/transport error; explicitly delayed busy response gates all removal; old explicit operator stop and exited cleanup controls. Real migrated DB/adapters with mocked action boundaries, controlled elapsed time, no sleeps/live workflow.
- Permanent regression: apps/server/test/lib/githubRunnerLifetime.test.ts,5 cases observed red/control then green. Updated two old retention assertions that encoded the defect and made two removal-failure fixtures explicitly idle; their failure/deregistration/transport assertions remain.
- Scope final: pnpm --dir apps/server exec vitest run test/lib/githubRunnerLifetime.test.ts test/lib/githubRunnerReaping.test.ts test/lib/githubRunnerEligibility.test.ts test/lib/githubRunnerConfigDrift.test.ts test/lib/githubRunnerPending.test.ts test/lib/githubRunners.test.ts test/lib/githubRunners.coverage.test.ts test/lib/githubRunnersNode.test.ts --coverage=false --reporter=verbose ->132 passed/8 files (F1071_scope_retry.log). Initial F1071_scope.log was131 passed/1 stale-fixture failure, not accepted final evidence.
- Compile: child-process GOMAXPROCS=4 pnpm --dir apps/server typecheck and build ->both exit0 (F1071_typecheck.log/F1071_build.log).
- Scoped Biome: pnpm exec biome lint apps/server/src/lib/githubRunners.ts apps/server/test/lib/githubRunnerLifetime.test.ts apps/server/test/lib/githubRunners.test.ts apps/server/test/lib/githubRunners.coverage.test.ts ->4 files, no fixes, exit0 (F1071_lint.log). Formatter disabled by repository config.
- Publication maintenance: local tag v0.18.26 is6a3f6820a0168224099e5c3dc0c1090ab1986a37, before F1064–F1071. Earlier audit stage helpers wrongly targeted the first Fixed heading in HEAD (the release section). This round moves only our F1064–F1070 bullets plus new F1071 to Unreleased, preserving unrelated working-tree edits, and uses a section-bounded stage helper thereafter. This is a documentation placement correction, not a new release or runtime claim.
- NOT RUN: full repository/server coverage, exact-commit hosted CI, live multi-day GitHub workflow, native Mac bootstrap. Provider assignment changes after an idle response and ambiguous resource-start/remove outcomes are separate boundaries.
- Next scope: lib/githubRunners.ts stillQueued uncertainty: its catch says keep waiting but returns true to an admission branch. Write a current-source proof before changing that behavior.
- Publication preflight: guarded24-path staging, cached and working-tree diff --check, limited staged credential/runtime/line-ending scan passed. Only owned source/tests/docs/evidence, round51 receipt and owned post-tag changelog bullet relocation selected. Final wrapper checks every HEAD blob including the full staged changelog and verifies F1064–F1071 are under Unreleased before push.
