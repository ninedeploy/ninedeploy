## Round 64 — restricted port proxy sync/remove ordering
### Summary
Scope confirmed: apps/server/src/lib/portProxy.ts and apps/server/test/portProxyRace.test.ts. Existing portProxy.test.ts, pipeline callers and config helpers read-only. Currentdb028649 selected blobs and remote verified. Unrelated CHANGELOG/CLI importPlan/index/plan/importApply/test changes preserved.
### Toolchain
Existing Node26.13.0/TypeScript7.0.2, Vitest5.0.5, configured Biome2.5.14; actual disposable config files plus controlled exec/image/host-path seams, no dependency installs.
### Invariants
After a same-slug remove requested after an earlier sync completes, the earlier sync cannot leave/recreate a sidecar. Operations for different slugs remain independent. Completion ordering must cover both container model and actual config-file ownership. Image failure releases admission for a later operation; no deadlock when no restricted mappings selects remove.
### Findings
Pending current-source proof; no patch.
### Boundaries
Docker dependency model, actual native config files, explicit pull gate; no live firewall/allow-list/privilege security claim. Before every recursive disposal, resolve and verify the absolute temp root/owned descendant. No cross-process ordering certified.
### F1082 — race / ownership — Medium — pending sync recreates a port sidecar after later remove
Before F1082_before.log ->1 failed/1 sequential control passed, exit1. Actual config files plus model of existing Docker exec seam, sync held in image preparation; later remove completes, then old sync resumes. EXPECTED sidecars0/configfalse; ACTUAL sidecars1/configfalse; PROBLEM CONFIRMED. This proves command/config ordering, not live packet access or an exploit.
Root cause before patch: sync/remove independently act on the same slug/name/config directory without shared admission; asynchronous preparation lets earlier sync resume after a later completed remove. Repair serialize whole same-slug operations before any I/O, preserve parallelism for different slugs, release queue after success/failure. No-restricted-mapping sync must call internal removal directly, avoiding recursive queue acquisition. No cross-process lock or cancellation of already-admitted Docker operations.
### Focused and permanent verification
Original proof F1082_after.log ->2 passed; PROBLEM NOT REPRODUCED, final sidecars0/configfalse. Independent verifier12 cases passed3 clean runs, guarded FIX VERIFIED (F1082_verify1/2/3.log). Covers gated inspect/pull/host-path/start, sync/remove/new-sync, different-slug independence, no-mapping internal remove without recursive deadlock, image/config-write error recovery, earlier-remove/later-sync, same-fingerprint latest routes and repeated removes.
Permanent apps/server/test/portProxyRace.test.ts12 cases were seen red on originaldb028649 portProxy source:7 failed/5 unaffected controls passed (F1082_permanent_before.log). All recursive native fixture disposal checks the resolved owned temp root and config descendants before deletion. No repository temp evidence removed.
Static checks completed: GOMAXPROCS=4 pnpm --dir apps/server typecheck ->exit0; build ->exit0; pnpm exec biome check apps/server/src/lib/portProxy.ts apps/server/test/portProxyRace.test.ts ->2files passed; git diff --check ->exit0. Existing formatter disabled. No new dependency or public/wire/config/schema change; exported operations still return Promise<void>.
### Scope validation in progress
pnpm --dir apps/server exec vitest run test/portProxyRace.test.ts test/portProxy.test.ts test/pipeline.test.ts --coverage=false --reporter=verbose ->pipeline readiness cases still running, not yet a completed pass. Final receipt below when done.
### Boundaries
Same-process same-slug FIFO covers whole local config/Docker-preparation operation. Different slugs retain concurrency. No distributed lock, live Docker/Traefik/IP allow-list enforcement, unknown-inspect/removal-error policy, native Mac or full release/coverage certification. Docker seam models resource creation/removal; actual disposable native config files prove file ownership ordering. Already-admitted operations finish before later removal; no unsafe cancellation guessed.
### Working tree
Unrelated evolving CLI importApply/importPlan/index/plan/tests and importing/roadmap docs plus CHANGELOG ordering hunk preserved. Own library/permanent test/docs/evidence only selected when final validation completes.
### Next scope
Choose an independent concrete path after complete pipeline scope validation and publication.
### Final scope receipt
Completed serial scope command above ->291 tests passed/3files, exit0,223.61s (F1082_scope.log). The long duration was ordinary existing readiness/fan-out scenarios, not a timeout or skipped target. Static typecheck/build, scoped lint and diff checks already passed on this same repair. No full repository release/coverage/native/live certification inferred.
Publication preflight: own selected paths only, cached diff check and limited staged credential/runtime/index-line-ending scan passed. Selected source/evidence/changelog HEAD hashes verified before push; unrelated active CLI/docs edits preserved.
