## Round 41 — CI claim and cancellation ownership
### Summary
Scope confirmed: apps/server/src/lib/ci.ts cancelJob and claimJob handoff, nearest real SQLite CI tests, required changelog/docs/evidence. Source/callers/current tests read; initial setup before patch, final results below.
### Toolchain
Same manifests/config reread at round40: Node26.13.0 supported by root/server engines, pnpm11.23.0, Vitest5.0.5/V8 serialized files/isolated data, TypeScript7.0.2, configured Biome2.5.14 formatter disabled. No configured race detector or new dependency.
### Invariants
- Cancellation closes the attempt current when the job transitions, even if initial read observed a queued job.
- A claim that has not published its attempt cannot attach/return that attempt after cancellation already won.
- Neither ordering leaves a running orphan consuming runner capacity; unrelated accepted claims and terminal jobs retain behavior.
### Findings
F1061 confirmed and repaired below.
### Not reproduced (dropped)
None bundled; next admission scope requires its own proof.
### Validation
Pending.
### Boundaries
Real migrated SQLite and gated query/client completion, no live containers or service secrets.
### Working tree
round41_status_before.txt. Round40 c36ddd8d405d56a426d21bb28ee73caae57823ff blobs verified and remote main matched. Unrelated browser-E2E/frontend/package/docs changes preserved.
### Next scope (if rounds continue)
CI runner capacity admission, recorded below.

### F1061 — race/ownership — Medium — claim/cancel handoff leaves live orphan attempts
- Location: lib/ci.ts cancelJob earlier job snapshot and claimJob unconditional currentAttemptId publication.
- Root cause BEFORE patch: cancellation chooses the attempt from its initial read, so a claim completed during that await remains running. Conversely a claim inserting an attempt during cancellation unconditionally attaches/returns it after the job was cancelled. Both orderings leave a running attempt consuming runner capacity until eventual expiry.
- Before proof: prove_F1061_ciClaim.test.ts / F1061_before.log, exit 1, 2 failed / 1 ordinary claim+cancel control passed. Gated queued cancellation snapshot then completed claim -> EXPECTED cancelled, ACTUAL running, PROBLEM CONFIRMED. Gated real attempt INSERT completion, cancellation wins, claim resumes -> EXPECTED no offer/cancelled attempt, ACTUAL offered job1/running, PROBLEM CONFIRMED.
- Severity Medium: cancelled work can be offered/executed until next heartbeat, with orphan capacity retained; no live workload/secret exposure claim. Lease token printed in the red assertion is generated for this disposable synthetic database and never belongs to a live runner.
- Planned patch: use UPDATE RETURNING's authoritative currentAttemptId for cancellation; publish a claim only with conditional job status=running, retire its own running attempt if publication loses, and return no offer. Preserve existing successful claims and terminal-attempt conditional guards. No schema/wire/config/dependency change.
- Permanent regression: apps/server/test/lib/ciClaimCancellation.test.ts, same three cases observed red before patch.

### Final validation and publication preparation
- Patch: cancelJob uses the currentAttemptId returned by the cancellation UPDATE; claimJob assignment is conditional on the job still running and a losing claim retires only its own running attempt and returns null. No schema/wire/config/dependency change.
- Original after: F1061_after.log -> 3 passed, both defect prints PROBLEM NOT REPRODUCED with expected/actual cancelled and null/cancelled.
- Independent: verify_F1061_ciClaim.test.ts -> 9 passed in each of F1061_verify_1/2/3.log, FIX VERIFIED. Client barriers before/after INSERT and before assignment UPDATE; cancellation update held while claim completes; capacity available to next job; repeated cancellation single winner, terminal succeeded/failed control, cancelled queued no attempt, ordinary live claim capacity and heartbeat stop after cancellation.
- Permanent regression: apps/server/test/lib/ciClaimCancellation.test.ts, 3 cases observed red then green on real SQLite.
- Scope: pnpm --dir apps/server exec vitest run test/lib/ciClaimCancellation.test.ts test/lib/ciLeaseSweep.test.ts test/modules/ci.test.ts test/ciRunner.test.ts test/lib/ciDeployGate.test.ts test/lib/ciGate.test.ts test/lib/ciGate.coverage.test.ts --coverage=false --reporter=verbose -> 80 passed / 7 files (F1061_scope.log).
- Compile: child-process GOMAXPROCS=4 pnpm --dir apps/server typecheck and build -> exit 0 both (F1061_typecheck.log, F1061_build.log).
- Biome: pnpm exec biome lint apps/server/src/lib/ci.ts apps/server/test/lib/ciClaimCancellation.test.ts -> 2 files, no fixes, exit 0 (F1061_lint.log). Formatter disabled by repository config.
- NOT RUN: full repository/server coverage, exact-commit hosted CI, live CI/Docker, native Mac bootstrap. Prior full-release boundary retained.
- Shared checkout: concurrent browser-E2E work was independently committed as 734a8821 during scope checks. Its source paths do not overlap the CI library/tests; root script addition is unrelated. Audit source was re-read in git diff and unchanged through checks. Do not attribute that feature's validation to the CI test count.
- Next scope: CI runner claim capacity admission in lib/ci.ts and protocol callers, with an explicit last-slot overlap proof before any change.
- Publication preflight: guarded 18-path staging, cached diff --check, working-tree diff --check and limited staged credential/runtime/line-ending scan passed. New unrelated e2e/playwright.config.ts edit remains excluded. Final wrapper verifies all selected source/evidence HEAD blobs before push.
