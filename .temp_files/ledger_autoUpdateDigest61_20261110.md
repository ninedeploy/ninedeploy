## Round 61 — automatic update digest publication ownership
### Summary
Scope confirmed: apps/server/src/lib/autoUpdate.ts and apps/server/test/lib/autoUpdateDigestRace.test.ts. Existing enqueue/lifecycle/scheduler tests read-only. Setup main0865737f remote verified; unrelated CHANGELOG.md and apps/cli/src/lib/importers/caprover.ts preserved. Earlier F77/F1078 prevent earlier stale enqueue; this tests baseline/refused/post-admission digest writes.
### Toolchain
Existing Node26.13.0/TypeScript7.0.2, migrated libsql Vitest5.0.5, configured Biome2.5.14; GOMAXPROCS=4 static checks. No new tools/dependencies.
### Invariants
A digest writer owns only the opt-in running image/digest snapshot it probed. Once operator opt-out or image/digest replacement has completed, an older write cannot restore/replace that baseline. Already-admitted queued deployment is not cancelled by a later operator change. Refusal fixture exercises an existing denial branch, not a live privilege boundary.
### Findings
Pending executable proof; no patch.
### Boundaries
Native SQLite write barrier, fake probe and controlled refusal seam. No live authorization/registry/deployment, queued-job cancellation or distributed policy generation claim.
### F1079 — race / ownership — Medium — stale digest writer restores cleared opt-out baseline
Before F1079_before.log ->3 failed/1 control passed, exit1. Baseline, controlled refusal, accepted enqueue branches held at native digest UPDATE; operator opt-out clears digest before execution resumes. EXPECTED false/null; ACTUAL false/sha256:new for all3; PROBLEM CONFIRMED. Already-admitted enqueue correctly remains queued in its case.
Root cause before patch: all3 digest UPDATEs constrain only service ID, discarding image/digest/opt-in/status ownership accepted earlier. Repair each publication with the same persisted opt-in/running/docker/image/previous-digest predicate (NULL-aware); SQLite evaluates it at the write, so stale writers cannot mutate a replacement. No job cancellation or changed refusal policy/audit semantics.
### Completed verification
Original proof F1079_after.log4 passed; three stale opt-outs PROBLEM NOT REPRODUCED. Permanent apps/server/test/lib/autoUpdateDigestRace.test.ts5 cases: original0865737f library4 failed/1 unaffected control passed (F1079_permanent_before.log); final scope34 tests/6files passed (F1079_scope.log). Stronger permanent case holds the first baseline write while a fresh independent observation publishes; old writer cannot replace it.
Independent23 cases passed3 consecutive clean runs with guarded FIX VERIFIED (F1079_verify1/2/3.log). All baseline/refused/enqueued phases crossed with image/digest/disable/stop/type/delete native-write mutations, unchanged-owner controls, competing baselines and legacy empty-string baseline. No timing sleeps; TS has no configured race detector.
Commands: root pnpm exec vitest run --config .temp_files/audit_continuous_20261109/F1073.config.ts [prove/verify] --reporter=verbose; server pnpm exec vitest run test/lib/autoUpdateDigestRace.test.ts test/lib/autoUpdateEnqueueRace.test.ts test/plugins/autoUpdateSchedulerRace.test.ts test/plugins/autoUpdateScheduler.test.ts test/lib/autoUpdate.test.ts test/lib/autoUpdateLifecycle.test.ts --coverage=false --reporter=verbose ->34/6 passed. Static/lint/diff final results below.
### Boundaries
Only digest persistence ownership changed. Refusal audit/log semantics and probed/enqueued counters keep existing meaning; accepted enqueue stays accepted even when later digest publication is obsolete. Controlled refusal is not authorization/security boundary validation. Direct same-values ABA, multiple independent database clients/processes, live deployment/registry and native Mac NOT RUN. Full repository release/coverage NOT RUN. No wire/schema/config changes.
### Working tree
Unrelated CHANGELOG ordering, CLI CapRover importer/fixtures/tests and MySQL integration test changes preserved. Only own library/permanent test/docs/evidence plus Unreleased entry selected.
### Next scope
Select a separate library I/O/resource scope after publication.
Final static checks: GOMAXPROCS=4 pnpm --dir apps/server typecheck ->exit0; build ->exit0; scoped pnpm exec biome check apps/server/src/lib/autoUpdate.ts apps/server/test/lib/autoUpdateDigestRace.test.ts ->2files passed; git diff --check ->exit0. These are bounded server checks, not root release/native certification.
Publication preflight: own paths only, cached diff check and limited staged credential/runtime/index-line-ending scan passed. Selected source/evidence/changelog HEAD blobs verified before push.
