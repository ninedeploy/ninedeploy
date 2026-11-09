## Round 48 — GitHub runner pending-job snapshot ownership
### Summary
Scope confirmed: apps/server/src/lib/githubRunners.ts drainOnce/handleWorkflowJob pending ownership and nearest runner tests, required changelog/docs/evidence. Current source/callers/existing runner fixture tests read before candidate; initial setup before patch, final results below.
### Toolchain
Node26.13.0, pnpm11.23.0, package0.18.26, TypeScript7.0.2, Vitest5.0.5/V8, configured Biome2.5.14 formatter disabled; serial files/isolated data/no configured race detector. No added dependency.
### Invariants
- A pending job removed by a later workflow_job event cannot be started from a previously captured drain snapshot after another job's awaited startup.
- A new pending generation under the same App/job key must not be deleted or launched by the older snapshot entry.
- An already-admitted start can finish; unrelated current pending jobs retain throughput/capacity behavior.
### Findings
F1067 confirmed and repaired below.
### Not reproduced (dropped)
No unrelated candidate bundled.
### Validation
Pending.
### Boundaries
Real migrated SQLite with mocked GitHub/Docker boundaries and explicit JIT barrier. No actual runner, provider, network isolation or job execution acceptance. This scope covers not-yet-admitted snapshot entries, not cancellation of a runner start already in progress.
### Working tree
round48_status_before.txt, unrelated CHANGELOG preserved; start at published580944d4. Round47 passing/no-finding controls and 111 fixture tests retained for combined evidence publication.
### Next scope (if rounds continue)
Current batch enabled/capacity settings, recorded below.

### F1067 — race/ownership — Medium — stale runner drain snapshot starts a job removed by a later event
- Location: lib/githubRunners.ts drainOnce byApp/jobs snapshot through awaited startRunner and stillQueued.
- Root cause BEFORE patch: handleWorkflowJob later actions delete pending correctly, but drainOnce continues its captured array after another job's startup await and deletes/starts each snapshot entry without checking current pending identity.
- Before proof: prove_F1067_ghaPending.test.ts / F1067_before_resolved.log -> 2 failed / 1 unchanged control passed, exit1, PROBLEM CONFIRMED. Real migrated app/config/installation and explicit first JIT gate: jobs80/81 snapshot, later job81 in_progress/completed event, EXPECTED launches[80], ACTUAL[80,81]. No Docker/provider action actually executed (mocked boundaries).
- Severity Medium unnecessary/wrong runner resource admission after authoritative later job update; no live job execution or security isolation bypass claim.
- Setup boundary: F1067_before.log ran no tests because root audit config lacked @ninedeploy/schemas alias. F1067.config.ts resolves the already-built workspace package; assertions/source unchanged. A pre-execution OS spawn refusal was retried identically.
- Planned narrow patch: evaluate optional online recheck, then confirm pending.get(key) is this exact snapshot entry before any deletion/admission. Drop only owned non-queued entries; start only owned current entries. Already-admitted starts retain their existing semantics. No API/schema/config/dependency change.
- Permanent regression: apps/server/test/lib/githubRunnerPending.test.ts, three JIT-gated cases observed red before patch.

### Final acceptance
- Patch: drainOnce evaluates optional status recheck, then compares current pending entry identity with its captured job before deleting/admitting. No public API/schema/config/dependency change; already-admitted start semantics retained.
- Original after: F1067_after.log -> 3 passed, unchanged control [80,81], in_progress/completed [80], PROBLEM NOT REPRODUCED.
- Independent verifier: verify_F1067_ghaPending.test.ts -> 9 passed in each F1067_verify_1/2/3.log, FIX VERIFIED. JIT gates with next/current/unrelated job events, online queued response arriving after completed event, online completed control, and first-preparation failures with/without subsequent removal. Explicit promise barriers, no sleeps. No live provider effects.
- Permanent regression: apps/server/test/lib/githubRunnerPending.test.ts, 3 cases observed red then green.
- Scope: pnpm --dir apps/server exec vitest run test/lib/githubRunnerPending.test.ts test/lib/githubRunners.test.ts test/lib/githubRunners.coverage.test.ts test/lib/githubRunnersNode.test.ts --coverage=false --reporter=verbose -> 114 passed / 4 files (F1067_scope.log).
- Compile: child-process GOMAXPROCS=4 pnpm --dir apps/server typecheck and build -> both exit0 (F1067_typecheck.log/F1067_build.log). First pre-execution OS spawn refusal retried identically; no product inference.
- Scoped Biome: pnpm exec biome lint apps/server/src/lib/githubRunners.ts apps/server/test/lib/githubRunnerPending.test.ts -> 2 files, no fixes, exit0 (F1067_lint.log). Formatter disabled by repository config.
- NOT RUN: complete repository/server coverage, hosted CI, live runner/Docker/GitHub/node, native Mac bootstrap. These fixture runs do not certify network/firewall isolation or already-admitted start cancellation.
- Next scope: current enabled/capacity settings versus an in-flight batch's configuration snapshot in drainOnce. Prove a not-yet-admitted second job before editing.
- Publication preflight: guarded24-path staging including round47 no-finding evidence, cached and working-tree diff --check, limited staged credential/runtime/line-ending scan passed. Only owned GHA source/test/Mac docs/evidence and F1067 changelog hunk selected; final wrapper verifies all selected HEAD blobs before push.
