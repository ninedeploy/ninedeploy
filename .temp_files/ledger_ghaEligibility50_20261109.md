## Round 50 — queued GitHub job eligibility under current policy
### Summary
Scope confirmed: apps/server/src/lib/githubRunners.ts PendingJob/handleWorkflowJob/drainOnce jobRefusal policy, nearest runner tests, required changelog/docs/evidence. Current admission/queue/status serialization and existing matching tests reread before candidate; initial setup before patch, final evidence below.
### Toolchain
Current Node26.13.0, pnpm11.23.0, package0.18.26, TypeScript7.0.2, Vitest5.0.5/V8, Biome2.5.14 formatter disabled; serial files/isolated data/no configured race detector. No dependency additions.
### Invariants
- A queued job must still meet current repository/public-repo/label policy when a fresh batch admits it.
- Policy changes do not starve still-eligible later jobs; refused entries consume no runner slot.
- Keep original validated matching metadata in the in-memory pending owner; public status response shape stays unchanged.
### Findings
F1069 confirmed and repaired below.
### Not reproduced (dropped)
No unrelated candidate bundled.
### Validation
Pending.
### Boundaries
Real migrated settings/queued app/installation with mocked GitHub/Docker. Proves local admission requests only; no live workflow execution, network isolation, provider authorization or host escape claim. Repository visibility changing remotely after its webhook snapshot is a different boundary.
### Working tree
round50_status_before.txt; round49 7f7c9bc1d6e24b2e322badcb118ce37b6dfc6345 owned blobs verified and origin main matched; unrelated CHANGELOG edits preserved.
### Next scope (if rounds continue)
Runner reaping unknown-busy/expiry boundaries, recorded below.

### F1069 — business-logic/ownership — Medium — queued runner jobs bypass later repository/public/label restrictions
- Location: lib/githubRunners.ts handleWorkflowJob pending metadata and drainOnce eligibility.
- Root cause BEFORE patch: jobRefusal runs only on initial webhook admission. The pending record discards labels/privacy, and a later fresh drain checks enabled/capacity but never current matching policy. Round49 correctly reloads a batch config but cannot revalidate an old queued job without its matching metadata.
- Before proof: prove_F1069_ghaEligibility.test.ts / F1069_before.log ->3 failed/1 unchanged control passed, exit1, PROBLEM CONFIRMED. Saturated queue released only after current repo allow-list excludes acme/api, labels switch away from ninedeploy, or allowPublicRepos flips true->false. EXPECTED no starts, ACTUAL[80,81] or public[82]. Real migrated settings, mocked external actions only.
- Severity Medium queued-work policy violation/resource admission; no live public workflow, provider privilege bypass or host escape claim.
- Planned narrow patch: retain validated labels/isPrivate in internal PendingJob, capture on enqueue, rerun existing jobRefusal using the current fenced config just before slot consumption. Drop only owned refused pending entries and continue to eligible later jobs. runnerStatus explicitly projects four public pending fields; internal metadata adds no wire/schema/persisted-data change or dependency.
- Permanent regression: apps/server/test/lib/githubRunnerEligibility.test.ts, 4 red/control cases observed before source patch.

### Final acceptance
- Patch: in-memory PendingJob retains validated labels/isPrivate, and the current fenced config reruns existing jobRefusal before slot consumption. runnerStatus still explicitly projects jobId/repo/jobName/queuedAt; no public wire/schema/persisted-data/dependency change.
- Original after: F1069_after.log ->4 passed, PROBLEM NOT REPRODUCED; unchanged[80,81], repo/label/public restriction starts[].
- Independent: verify_F1069_ghaEligibility.test.ts ->9 passed in each F1069_verify_1/2/3.log, FIX VERIFIED. Mixed refused/eligible repository, label and public/private queues with one slot; case-insensitive repo/additive-label/public-allowed controls; four-field status response; original payload array/privacy mutation cannot alter copied pending metadata; gated policy change during admitted start followed by fresh-pass filtering. No sleeps or live provider actions.
- Permanent regression: apps/server/test/lib/githubRunnerEligibility.test.ts, four cases observed red then green. Only an extra trailing EOF blank line was normalized before static/publication checks; assertions unchanged.
- Scope: pnpm --dir apps/server exec vitest run test/lib/githubRunnerEligibility.test.ts test/lib/githubRunnerConfigDrift.test.ts test/lib/githubRunnerPending.test.ts test/lib/githubRunners.test.ts test/lib/githubRunners.coverage.test.ts test/lib/githubRunnersNode.test.ts --coverage=false --reporter=verbose ->122 passed /6 files (F1069_scope.log).
- Compile: child-process GOMAXPROCS=4 pnpm --dir apps/server typecheck and build ->both exit0 (F1069_typecheck.log/F1069_build.log).
- Biome: pnpm exec biome lint apps/server/src/lib/githubRunners.ts apps/server/test/lib/githubRunnerEligibility.test.ts ->2 files, no fixes, exit0 (F1069_lint.log). Formatter disabled by repository config.
- NOT RUN: full repository/server coverage, hosted CI, live GitHub/Docker/node/workflow execution, native Mac bootstrap. Snapshot privacy is the original validated webhook metadata; later remote visibility changes and provider trust are not certified by these fixtures.
- Next scope: lib/githubRunners.ts sweep/reaping unknown-busy and expiry boundaries with nearest tests; prove any new defect before edits.
- Publication preflight: guarded18-path staging, cached and working-tree diff --check, limited staged credential/runtime/line-ending scan passed. Only owned GHA source/test/Mac docs/evidence and F1069 changelog hunk selected; final wrapper verifies every selected HEAD blob before push.
