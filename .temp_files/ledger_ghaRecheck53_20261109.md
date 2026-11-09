## Round 53 — queued-job status uncertainty
### Summary
Scope confirmed: apps/server/src/lib/githubRunners.ts stillQueued/drainOnce recheck outcome handling and nearest pool tests, required changelog/docs/evidence. Current helper/caller and existing online recheck fixtures read before candidate; initial setup before patch, final evidence below.
### Toolchain
Node26.13.0, pnpm11.23.0, package0.18.26, TypeScript7.0.2, Vitest5.0.5/V8, Biome2.5.14 formatter disabled; serial files/isolated data/no configured race detector. No new dependencies.
### Invariants
- A failed or missing job-state read keeps eligible work waiting; it cannot authorize a new runner or silently discard the pending job.
- Confirmed queued work can start; confirmed non-queued/local revoked installation work can be dropped.
- Unknown entries consume no slot and do not prevent still-verifiable later work; later events/config changes retain owner fencing.
### Findings
F1072 confirmed and repaired below.
### Not reproduced (dropped)
No unrelated candidate bundled.
### Validation
Pending.
### Boundaries
Real migrated queue/config/installation, mocked GitHub/Docker responses and explicit response gates; no live workflow execution or provider authorization test. Pending TTL behavior remains its separate existing bound.
### Working tree
round53_status_before.txt. Round52 244e7824ef94086e16950ebab4c6e4e74d7cc979 all selected blobs/changelog and remote main verified. Unrelated CHANGELOG F1061 ordering and e2e/tests/05-database-backup.spec.ts (as recorded in the current snapshot) preserved.
### Next scope (if rounds continue)
Pending TTL across asynchronous admission, recorded below.


### F1072 — business-logic/input-handling — Medium — uncertain job lookup either starts or discards pending work
- Location: lib/githubRunners.ts stillQueued catch/missing-status comparison and drainOnce boolean admission/deletion.
- Root cause BEFORE patch: true conflates confirmed queued with a failed read, authorizing runner creation after an API error; false conflates confirmed non-queued with missing response status, discarding pending work. The helper's keep-waiting comment contradicts its caller-visible action.
- Before: prove_F1072_ghaRecheck.test.ts / F1072_before.log ->2 failed/2 queued/completed controls passed, exit1, PROBLEM CONFIRMED. API error EXPECTED starts[]/pending[80,81], ACTUAL starts[80,81]/pending[]; missing status EXPECTED pending[80,81], ACTUAL[]. Real migrated pending/config/installation and mocked provider/command boundaries.
- Severity Medium incorrect resource admission or missed CI runner provisioning during a transient/invalid read; no live workflow/provider authorization claim.
- Planned narrow patch: private tri-state return true=queued, false=confirmed in_progress/completed or locally unavailable installation, null=unknown/error/unrecognized status. Preserve eligible unknown entries without a slot; drop only owned confirmed non-queued or current-policy-refused entries. Keep existing pending/config fences after awaits. No public API/schema/wire/dependency change.
- Permanent regression: apps/server/test/lib/githubRunnerRecheck.test.ts,4 cases observed red/control before patch. Existing coverage case that expected unknown status to start will be changed to retain and subsequently retry, preserving its known-queued start assertion.
- Concurrent e2e-only commits add012d5/1d2d70f4 appeared around publication; current GHA source was reread and the before-proof runs on their inherited unchanged library. Their browser validation is separately owned.
- Scope includes the existing Queue and upkeep bullet in docs/GITHUB_APP.md for the user-visible deferred-recheck behavior.

### Independent persistence proof before final patch
- Initial tri-state patch passed original4 (F1072_after.log) but was incomplete across caller entry points. F1072_verify_persistence_before.log ->2 failed/11 passed: a subsequent queued webhook's default drain bypassed the prior unknown lookup; configuration drift broke before uncertainty was remembered, so the next default drain started the old unknown job.
- Root cause before further edit: lookup certainty lived only in the local waiting result, while default drains intentionally skip remote queries for fresh webhook entries. Retain a recheckRequired marker on the owning in-memory PendingJob. Mark it immediately after an unknown result while pending identity still matches, before the following config await can break the batch; every later drain must re-query that marked entry.
- Promoted both persistence cases into permanent githubRunnerRecheck.test.ts and ran them red before the marker patch (F1072_regression_persistence_before.log ->2 failed/4 passed). No sleeps; the config-drift case gates the remote status response.

### Final acceptance
- Final patch: private tri-state recheck separates queued/non-queued/unknown; eligible unknown entries stay pending without a slot. A recheckRequired marker is recorded on the current pending owner before the following config await, and all future drain entry points query marked jobs. Confirmed local suspension/non-queued status or current policy refusal drops only owned entries. No public API/schema/wire/dependency change; docs/GITHUB_APP.md explains deferred lookup.
- Original final: F1072_proof_final_after.log ->4 passed, PROBLEM NOT REPRODUCED. F1072_after.log was the initial tri-state pass before the persistence gap was proved.
- Independent final: verify_F1072_ghaRecheck.test.ts ->13 passed in each F1072_verify_final_1/2/3.log, FIX VERIFIED. Queued/in_progress/completed, missing/null/wrong-type/unrecognized data, failure/recovery, mixed verified/unknown slots, gated completed owner during unknown reply, new webhook default-drain bypass prevention, gated config-drift persistence, locally suspended installation no remote read. Explicit gates, no sleeps/live actions.
- Permanent regression: apps/server/test/lib/githubRunnerRecheck.test.ts now6 cases; original4 red/control and two stronger re-entry/config persistence cases promoted and seen red before final marker patch. Existing coverage keeps known queued start and now proves unknown retention plus later successful retry.
- Scope: pnpm --dir apps/server exec vitest run test/lib/githubRunnerRecheck.test.ts test/lib/githubRunnerLifetime.test.ts test/lib/githubRunnerReaping.test.ts test/lib/githubRunnerEligibility.test.ts test/lib/githubRunnerConfigDrift.test.ts test/lib/githubRunnerPending.test.ts test/lib/githubRunners.test.ts test/lib/githubRunners.coverage.test.ts test/lib/githubRunnersNode.test.ts --coverage=false --reporter=verbose ->138 passed/9 files (F1072_scope.log).
- Compile: child-process GOMAXPROCS=4 pnpm --dir apps/server typecheck and build ->both exit0 (F1072_typecheck.log/F1072_build.log).
- Biome: pnpm exec biome lint apps/server/src/lib/githubRunners.ts apps/server/test/lib/githubRunnerRecheck.test.ts apps/server/test/lib/githubRunners.coverage.test.ts ->3 files, no fixes, exit0 (F1072_lint.log). Formatter disabled by config.
- NOT RUN: full repository/server coverage, hosted CI, live GitHub/workflow/Docker/node, native Mac bootstrap. Unknown entries retain existing pending TTL; provider assignment changes after an idle response remain separate from queued lookup certainty.
- Current unrelated E2E work is separately committed/dirty as observed, including newer member journey work; this round does not stage it or infer browser certification from these runner fixtures.
- Next scope: pending TTL expiration across earlier runner preparation/late config or status reads; controlled clock and explicit barriers before any patch.
- Publication preflight: guarded23-path staging, cached and working-tree diff --check, limited staged credential/runtime/line-ending scan passed. Only owned source/tests/docs/evidence and F1072 Unreleased bullet selected; final wrapper verifies every selected HEAD blob including the full staged changelog before push.
