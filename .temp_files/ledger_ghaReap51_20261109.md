## Round 51 — runner sweep state uncertainty and idle reaping
### Summary
Scope confirmed: apps/server/src/lib/githubRunners.ts sweepGithubRunners/runnerBusy/listNodeRunnerContainers and nearest node/pool fixtures, required changelog/docs/evidence. Current source, existing malformed-state normalization, busy/error and expiry tests read before candidate; initial setup before patch, final evidence below.
### Toolchain
Node26.13.0, pnpm11.23.0, package0.18.26, TypeScript7.0.2, Vitest5.0.5/V8, Biome2.5.14 formatter disabled; serial files/isolated data/no configured race detector. No dependency additions.
### Invariants
- Missing/malformed/unrecognized container state cannot itself authorize automatic runner removal.
- Recognized non-running cleanup and existing explicit operator stop remain available.
- Unknown GitHub busy status preserves a running runner; recognized idle/404 and explicit age policy retain behavior.
### Findings
F1070 confirmed and repaired below.
### Not reproduced (dropped)
Independent uncertainty/busy/idle controls passed; maximum-lifetime contract is a separate next scope.
### Validation
Pending.
### Boundaries
Real migrated app/config/server rows and real node-list adapter; GitHub/node/Docker boundaries mocked. Asserts requested stop/removal actions, not live resource deletion, actual sealed capability enforcement or firewall isolation. Known-state values already appear in repository lifecycle/runtime validators.
### Working tree
round51_status_before.txt; round50 a034de999d395f6b51ffaa50a415d3046b72d810 owned blobs verified and origin main matched. Preserve unrelated CHANGELOG/release work.
### Next scope (if rounds continue)
Self-hosted runner maximum-lifetime policy, recorded below.

### F1070 — input-handling/ownership — Medium — malformed runner state authorizes automatic node stop
- Location: lib/githubRunners.ts listNodeRunnerContainers normalizes invalid state to unknown; sweepGithubRunners treats every non-running string as removable.
- Root cause BEFORE patch: an uncertain/empty/unrecognized container state is classified as a confirmed non-running runner and directly sent to gha.runner.stop, without a trustworthy state observation.
- Corrected before proof: prove_F1070_ghaReap.test.ts / F1070_before_corrected.log ->4 failed/1 explicit exited control passed, exit1, EXPECTED0 stop calls ACTUAL1, PROBLEM CONFIRMED for missing, blank, oversized and unexpected state values. Real node-list adapter and migrated rows; external stop calls mocked.
- Initial F1070_before.log was5 failed: its exited control incorrectly expected a GitHub DELETE, but the existing non-running branch removes the container only. Corrected that unrelated control expectation before patch; malformed-state stop assertions unchanged. No claim of GitHub deregistration on this branch.
- Severity Medium unsafe automated resource-stop request from unknown state; no live container was removed and no host/provider boundary bypass claimed.
- Planned narrow patch: allow existing automatic non-running cleanup only for recognized container state values already used by repository runtime/lifecycle handling. Unknown values remain listed/count toward capacity and are retained; explicit operator stop remains available. No public API/schema/config/dependency change.
- Permanent regression: apps/server/test/lib/githubRunnerReaping.test.ts,5 cases observed red/control before patch.
- Separate age-contract research: the source's six-hour blanket claim requires checking current upstream self-hosted limits; do not certify that policy from this state-uncertainty finding. Official docs research is retained for the next bounded scope.

### Final acceptance
- Patch: only recognized non-running state values authorize the existing immediate container cleanup branch; unreadable/unrecognized values are retained and counted. Explicit operator stop and known state handling remain available. No schema/wire/config/dependency change.
- Original after: F1070_after.log ->5 passed, PROBLEM NOT REPRODUCED. Corrected pre-patch4 failures/1 exited control remain F1070_before_corrected.log; the initial5-failure fixture run is not accepted evidence for the control.
- Independent final: verify_F1070_ghaReap.test.ts ->25 passed in each F1070_verify_final_1/2/3.log, FIX VERIFIED. Five uncertain states, six recognized non-running controls, five busy-response shapes,404/500/transport errors, exact/next-millisecond idle boundary, invalid creation timestamp, explicit unknown-state stop, failed node-stop preserving registration, and explicitly gated stale malformed node response after node state becomes running. Earlier24-case clean passes are retained separately; no sleeps or live provider/container effects.
- Permanent regression: apps/server/test/lib/githubRunnerReaping.test.ts,5 cases observed red/control then green on real node-list adapter and migrated DB.
- Scope: pnpm --dir apps/server exec vitest run test/lib/githubRunnerReaping.test.ts test/lib/githubRunnerEligibility.test.ts test/lib/githubRunnerConfigDrift.test.ts test/lib/githubRunnerPending.test.ts test/lib/githubRunners.test.ts test/lib/githubRunners.coverage.test.ts test/lib/githubRunnersNode.test.ts --coverage=false --reporter=verbose ->127 passed/7 files (F1070_scope.log).
- Compile: child-process GOMAXPROCS=4 pnpm --dir apps/server typecheck and build ->both exit0 (F1070_typecheck.log/F1070_build.log).
- Biome: pnpm exec biome lint apps/server/src/lib/githubRunners.ts apps/server/test/lib/githubRunnerReaping.test.ts ->2 files, no fixes, exit0 (F1070_lint.log). Formatter disabled by repository config.
- NOT RUN: complete repository/server coverage, exact-commit hosted CI, live GitHub/Docker/node/capability boundary, native Mac bootstrap. Existing known-state cleanup controls are compatibility checks, not global certification of every retention policy.
- Separate next scope: maximum runner lifetime uses a GitHub-hosted six-hour assumption for these self-hosted runners. Current official limits and workflow syntax have been consulted; record primary links and a runnable elapsed-time proof before any age-policy patch. No such patch is bundled here.
- Publication preflight: guarded22-path staging, cached and working-tree diff --check, limited staged credential/runtime/line-ending scan passed. Only owned GHA source/test/Mac docs/evidence and F1070 changelog hunk selected; final wrapper verifies every selected HEAD blob before push.
