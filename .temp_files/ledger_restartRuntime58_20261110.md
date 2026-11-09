## Round 58 — restart limiter runtime and deployment admission
### Summary
Scope confirmed: apps/server/src/lib/restartLimit.ts and apps/server/test/lib/restartLimitRuntimeRace.test.ts. Read-only schema/runtime replica and existing restartLimit/policy tests. Previous policy fix3124bb90 selected blobs/remote verified. Unrelated CLI importer/index/tests/docs/README/IMPORTING and CHANGELOG changes preserved (round58_status_before.txt).
### Toolchain
Same existing server Node26.13.0/TS7.0.2, Vitest5.0.5 migrated libsql fixture, scoped configured Biome2.5.14; resource-bound static checks use GOMAXPROCS=4. No new dependencies.
### Invariants
The runtime sampled before an await cannot stop a replacement runtime or mark it stopped. A deployment starting during sampling must be left alone, per the existing documented restart-limit contract. A later fresh sweep must not apply rejected old-runtime restart history to the replacement. Unchanged eligible service still trips normally.
### Findings
Pending executable proof; no source patch.
### Boundaries
Dependency-injected Docker/PM2, actual SQLite, explicit gates. No runtime operation already admitted before a later deployment is cancelled; no external atomic Docker/database transaction claimed.
### F1076 — race / ownership — Medium — stale runtime sample clobbers replacement or active deployment
Before proof: F1076_before.log ->2 failed/1 control passed, exit1. Runtime replacement and deployment inserted during sample both returned stopped[5], mutated current service status to stopped and invoked stop once, instead of leaving current running service untouched. PROBLEM CONFIRMED.
Root cause before patch: service runtime/status and active deployment set are checked before asynchronous sampling; final UPDATE only checks service ID plus policy ownership, so runtime/deployment changes remain unguarded. Narrow repair: make final status mutation conditional on sampled runtime/type/local orchestration and current running status, and absence of queued/building/deploying deployment at SQL admission. Rejecting a provisional trip must discard only its same-owner history so it cannot be replayed into the replacement on the next pass. No already-admitted external stop is cancelled.
### Completed proof/verification
Original proof after F1076_after.log ->3 passed, both PROBLEM NOT REPRODUCED. Independent verifier28 cases passed cleanly three times (F1076_verify1/2/3.log), each guarded FIX VERIFIED +exit0. Seven permanent regression/control tests in apps/server/test/lib/restartLimitRuntimeRace.test.ts were seen red on prior F1075 source (6 failed/1 control passed, F1076_permanent_before.log), then all19 tests/3files passed with existing restartLimit and policy races (F1076_scope.log).
Explicit sample gates cover Docker/PM2 runtime replacement, type/status/orchestration changes and deletion, every active deployment status; native SQLite execution gates prove final admission after earlier reads. Follow-up baseline and real threshold checks cover discarded provisional history. Terminal/unrelated deployment controls still trip normally. No sleeps.
Patch: final conditional service UPDATE checks sampled runtime/type/local orchestration/running state and active deployment absence; failed admission drops only same-policy same-history provisional state. Existing per-policy SQL/current-generation guards preserved. No wire/schema/config format change.
Commands: root pnpm exec vitest run --config .temp_files/audit_continuous_20261109/F1073.config.ts [prove/verify] --reporter=verbose; server pnpm exec vitest run test/lib/restartLimitRuntimeRace.test.ts test/lib/restartLimitPolicyRace.test.ts test/lib/restartLimit.test.ts --coverage=false --reporter=verbose. Compile/build/scoped lint/diff results recorded below after completion.
### Working tree
Independent writer committed CLI import work7fa67970 and plan status4309541f during this round; source fixes here were not part of those commits. Remaining unrelated CHANGELOG.md ordering hunk preserved. Only own source/test/docs/evidence/changelog entry are staged.
### Boundaries
Full root release/coverage gate, native Mac and live Docker/PM2 NOT RUN. This fences state changes before the conditional database admission. A deployment/runtime change after admission can still overlap the already-admitted external stop; no distributed lock or atomic database+runtime transaction claimed. Replica capacity changes under an unchanged runtime name were not certified in this scope. Static checks cover current shared snapshot, not independent CLI feature acceptance.
### Next scope
Select an independent I/O/ownership path after publishing this round.
Final static checks: child-process GOMAXPROCS=4 pnpm --dir apps/server typecheck ->exit0; build ->exit0. Scoped pnpm exec biome check apps/server/src/lib/restartLimit.ts apps/server/test/lib/restartLimitRuntimeRace.test.ts ->2files passed (formatter configured disabled). git diff --check exit0. No full release certification.
Publication preflight: selected owned paths, cached diff check and limited staged credential/runtime/index-line-ending scan passed; unrelated changes not staged. Selected source/evidence/CHANGELOG HEAD hashes will be verified before push.
