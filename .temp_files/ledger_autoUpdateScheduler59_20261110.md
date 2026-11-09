## Round 59 — automatic image-update scheduler overlap
### Summary
Scope confirmed: apps/server/src/plugins/autoUpdateScheduler.ts and apps/server/test/plugins/autoUpdateSchedulerRace.test.ts. lib/autoUpdate.ts and existing scheduler/lifecycle tests read-only. Setup status: unrelated CHANGELOG.md only; previous4901bfeb source/evidence and remote verified. Earlier F77 probe-lifecycle check already exists and is not relabeled as a new finding.
### Toolchain
Existing Node26.13.0/TypeScript7.0.2, Vitest5.0.5 migrated libsql, configured Biome2.5.14; no installs. Actual Fastify plugin and actual sweep; only registry probe/audit seam controlled. Fake timer interval plus explicit native SQLite result gate, no timing sleeps.
### Invariants
An interval cannot admit a second automatic-update sweep while its previous interval sweep is pending. Unchanged sequential operation still enqueues exactly once. Close prevents future ticks; errors release admission.
### Findings
Pending current-source proof; no source change.
### Boundaries
No live registry/provider/deploy. First delayed sweep followed by interval remains the existing scheduling contract. Single plugin instance; distributed sweep admission is not certified.
### F1077 — race — Medium — overlapping periodic sweeps enqueue duplicate deployments
Before proof F1077_before.log: 1 failed/1 sequential control passed, Vitest exit1. Actual Fastify plugin + actual auto-update sweep on migrated SQLite, registry digest seam only; first interval's completed empty in-flight query held, next interval enqueued and advanced digest, then stale first interval also enqueued. EXPECTED1 admitted interval sweep/1 deployment; ACTUAL2/2; PROBLEM CONFIRMED.
Root cause before patch: tick checks running but does not reserve busy during an admitted sweep; after initial timeout, periodic setInterval can dispatch while the preceding sweep still awaits I/O. Repair only scheduler: reserve busy synchronously on entry and release in finally across success/error; preserve initial-delay/interval/close behavior. This does not claim cross-instance library enqueue deduplication.
### Completed verification
Original proof after F1077_after.log ->2 passed; actual interval sweep and deployment counts1/1, PROBLEM NOT REPRODUCED. Permanent apps/server/test/plugins/autoUpdateSchedulerRace.test.ts ->before1 failed/1 control passed (F1077_permanent_before.log). After21 tests/4 files passed with scheduler, auto-update and F77 lifecycle neighbors (F1077_scope.log).
Independent verify_F1077_autoUpdateOverlap.test.ts ->11 gated lifecycle/retry/owner cases x3 clean runs, guarded FIX VERIFIED and exit0 (F1077_verify1/2/3.log). Includes initial-delay/interval cadence, held initial and periodic sweep success/rejection, busy release, close before/during either phase, retained timeout/interval callback after close, independent plugin owners. Already-admitted sweep may finish after close; no timer installed afterward.
Commands: root pnpm exec vitest run --config .temp_files/audit_continuous_20261109/F1073.config.ts [proof/verify] --reporter=verbose; server pnpm exec vitest run test/plugins/autoUpdateSchedulerRace.test.ts test/plugins/autoUpdateScheduler.test.ts test/lib/autoUpdate.test.ts test/lib/autoUpdateLifecycle.test.ts --coverage=false --reporter=verbose ->21/4 passed. Static check/lint/diff results recorded below after completion.
### Boundaries
No wire/schema/config change or library deduplication guarantee. Real native SQLite barrier proves duplicate side effects for one overlapping scheduler instance; interval fake clock deliberately represents a long I/O pass. No performance claim or live registry30-minute wait. Full root release/coverage, multiple panel processes, native Mac and actual deployments NOT RUN. Existing F77 unchanged.
### Working tree
Unrelated CHANGELOG.md ordering change preserved. Own source/permanent test/docs/evidence and HEAD-derived Unreleased note only selected.
### Next scope
Automatic update library final enqueue ownership after its last awaited precondition, distinct from same-scheduler overlap.
Final static results: GOMAXPROCS=4 server pnpm typecheck ->exit0; build ->exit0; scoped biome check source/permanent test ->2files passed; git diff --check ->exit0. Existing configured formatter disabled, no new tool. Bounded check success is not a complete release gate.
Publication preflight: own paths only; cached diff check and limited staged credential/runtime/index-line-ending check passed. Selected source/evidence/changelog HEAD blobs verified before remote push.
