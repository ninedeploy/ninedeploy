## Round 65 — restricted port proxy removal failure
### Summary
Scope confirmed: apps/server/src/lib/portProxy.ts and apps/server/test/portProxyRemovalFailure.test.ts; previous ordering tests/pipeline and service deletion caller read-only. Previous22ce6cc6 selected blobs/remote verified,291 scope tests passed. Setup unrelated CHANGELOG.md only at this snapshot.
### Toolchain
Existing Node26.13.0/TS7.0.2/Vitest5.0.5/Biome2.5.14; real disposable config files and controlled Docker seam. No new dependencies. Owned absolute temp root/descendant verification before all recursive disposal, reused from prior proof fixture.
### Invariants
A failed Docker removal cannot report successful removal or discard the config still owned by the surviving sidecar. The original removal error must reach callers, which already catch/log unknown failures. Successful removal still cleans and logs. This scope does not change unknown-inspect classification.
### Findings
Pending runnable proof; no source patch.
### Boundaries
Exec dependency fault/model plus real native files, no live Docker/firewall or security verdict. Same-slug queue preserved, distributed ordering not certified.
### F1083 — ownership / error-handling — Medium — failed sidecar removal drops live config and reports success
Before F1083_before.log ->2 failed/1 successful-removal control passed, exit1. Both direct remove and no-mapping sync: injected actual exec-seam rm rejection leaves modeled sidecar alive, but removal resolves, deletes native config and logs Removed. EXPECTED original error,configtrue,sidecars1,logs0; ACTUAL errorlost,configfalse,sidecars1,logs1; PROBLEM CONFIRMED.
Root cause before patch: removePortProxyNow explicitly catches and discards every Docker rm error before unconditionally logging/deleting its config. Narrow repair remove only that catch; rejection exits before success log/config deletion, and the existing per-slug queue finally still releases admission. Caller modules/services.ts already catches and warns on failed cleanup. Unknown-inspect behavior, rm preparation inside sync and resource labels remain outside this repair.
### Completed verification
Original proof F1083_after.log3 passed, both direct/no-mapping failure cases PROBLEM NOT REPRODUCED. Permanent apps/server/test/portProxyRemovalFailure.test.ts10 cases red on22ce6cc6 library:8 failed/2 unaffected controls passed (F1083_permanent_before.log); final31 tests/3port-proxy files passed (F1083_scope.log).
Independent9 failure/retry/ownership cases passed3 clean invocations, guarded FIX VERIFIED (F1083_verify1/2/3.log): Error/timeout-named/opaque rejections preserve original identity and exact config bytes, ordinary success/absence controls, gated failing remove followed by successful retry or newer sync, different-slug independence and repeated failures. Original no-mapping path is also permanent. Actual disposable files, strict owned-root disposal checks, no sleep races.
Commands: root pnpm exec vitest run --config .temp_files/audit_continuous_20261109/F1073.config.ts [proof/verify] --reporter=verbose; server pnpm exec vitest run test/portProxyRemovalFailure.test.ts test/portProxyRace.test.ts test/portProxy.test.ts --coverage=false --reporter=verbose ->31/3 passed. Compile/build/scoped lint/diff final receipt below.
### Boundaries
One catch removed from confirmed-present removal branch; unknown-inspect classification remains outside this fix. Source/persisted/wire formats and exported Promise<void> contract unchanged; rejection was already possible for native filesystem faults and caller has cleanup warning handler. Docker state modeled, not live enforcement. Full pipeline291 tests passed in immediately previous round64; NOT RERUN here for the isolated injected-rm failure change. Full root release/coverage, native Mac and live Docker NOT RUN. No TS race detector configured.
### Working tree
Unrelated CHANGELOG and active CLI importer work preserved; own library/permanent test/docs/evidence only selected.
### Next scope
Port-proxy Docker inspect errors versus confirmed absence, separately from an observed rm failure.
Final static checks: GOMAXPROCS=4 server pnpm typecheck ->exit0; build ->exit0; scoped Biome source/new permanent test ->2files passed; git diff --check ->exit0. No root/default release/native certification.
Publication preflight: own staged paths only; cached diff check and limited credential/runtime/index-line-ending scan passed. Selected source/evidence/changelog HEAD hashes verified before push; unrelated active importer changes preserved.
