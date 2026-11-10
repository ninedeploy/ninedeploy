## Round 74 — cross-process lock identity write completion
### Summary
Scope confirmed: apps/server/src/lib/crossProcessLock.ts and apps/server/test/lib/crossProcessLockWrite.test.ts. Existing main1129f4c5, round74_status_before.txt clean. CONTRIBUTING and nearest crossProcessLock / r314 ownership tests and database/nodeLifecycle callers read. Initial work is read-only analysis and temporary proof authoring; no production edit or proof subprocess runs while round73 full retry is active, to preserve its source and avoid native-process contention.
### Toolchain
Existing Node26.13.0 TypeScript/Vitest5.0.5; configured Biome formatter disabled. No new dependencies. Native node:fs calls delegated through a fault-injection seam in a disposable OS-temp root; no live database/operation lock touched.
### Invariants
The successful exclusive file must contain the complete per-acquisition token that release compares. A legal short successful write must not return a holder whose own release can never recognize its file. Release must remain idempotent and preserve a later holder's token. Actual callers back up/restore or manage node database lifecycle using this helper.
### Findings
Candidate only: single writeSync return is ignored. Draft proof deferred until round73 retry completes. No finding ID confirmed or production patch yet.
### Boundaries
No conclusions about native-short-write frequency or distributed lock algorithm completeness. Separate error/zero-progress cleanup and stale-rename residual windows require their own proof; no expansion assumed.

Round73 broad runner has ended; evidence-only b4ef7e41 pushed, source crossProcessLock unchanged, current tree clean. Draft beforeproof executes now; no production patch has occurred.

#### F1092 — ownership / resource-leak — Medium — incomplete holder identity cannot be released
Root cause recorded before edit: acquireCrossProcessLock ignores writeSync returned bytecount. Actual native write limited to3bytes leaves only prefix of token; acquisition returns a holder but release compares against full token and leaves an orphan until stale recovery. Before F1092_before.log:1failed/1fullwritecontrolpassed, EXPECTED removed ACTUAL orphan remains, PROBLEM CONFIRMED, exit1. Narrow patch: encode ASCII token once, complete partial writes before starting heartbeat/returning ownership; zero progress throws via existing close/rethrow path. No API/schema/lock format change. Error-path cleanup of partially initialized files and existing stale-takeover residual windows remain outside this finding; no distributed-lock completeness claim.

### Verification
Originalafter2passed, PROBLEM NOT REPRODUCED. Independent verifier10cases repeated3times, FIX VERIFIED. Covers1/2/3/7/fullsize limits, unevenoffsetsequence, releaseafterreplacementbarrier, double-release/newowner, zero progress/errorafterpartial close/rethrow. Permanenttest apps/server/test/lib/crossProcessLockWrite.test.ts against exact guarded oldsource:8failed/2controls, exit1, fixedsource restored only after no-drift comparison. Zero/error cases verify refusal+descriptorclose, not path cleanup (existing residual explicitly retained).
### Validation
Initial scope typo nonexistent test/engine/database.test.ts meant4files/28passed and did not certify database tests; corrected final command with test/database.test.ts:5files/120tests passed. GOMAXPROCS4 pnpm --dir apps/server typecheck/build passed. Configured Biome check two changed TS files clean. git diff --check passed. Fullserver NOT RERUN for this patch: round73 native worker failure remains unresolved, whole retry invalidated afterlongtoolpause; no full acceptance/rootrelease/coverage/live/nativeMac claim. No dependencies installed, no race detector configured.
### Not reproduced (dropped)
None in this scope.
### Working tree
Scoped source/new regression/docs/changelog/evidence only; no unrelated edits observed.
### Next scope
Cross-process lock failed initialization cleanup: determine with native file evidence whether failed acquire obstructs a fresh retry and preserve a later owner.

Preflight:19exact owned staged paths; cached diff check/limited staged scanner passed. No complete security audit implied. Selected HEAD/remote checks follow guarded receipt.
