## Round 67 — node health cache ownership controls
### Summary
Scope confirmed: apps/server/src/lib/nodeHealth.ts read-only, callers plugins/collector.ts/modules/servers.ts and nearest nodeHealth.test.ts. Audit controls/evidence only unless current-source failing proof establishes a violation. Current6d2c6304 selected blobs/remote verified; setup round67_status_before.txt preserves unrelated active CLI changes.
### Toolchain
Existing Node26.13.0/TS7.0.2/Vitest5.0.5/Biome2.5.14. Migrated in-memory SQLite plus injected ping/stats/panel-disk and decrypt seam, no network/Docker. No new dependencies.
### Invariants
Actual collector serially awaits nodeHealth.cycle before scheduling the next tick. Pending/deleted nodes drop out on the next registry snapshot. Failed remote measurements preserve a prior reading only through its inclusive15-minute age boundary; ordinary cycles poll no faster than5minutes. Initial node-registry failure must not emit a false fleet recovery/offline sample.
### Findings
No finding without a failing proof of the actual caller contract.
### Not reproduced / dropped
- Overlapping cycle publication candidate: dropped as a product reproduction at the caller boundary. The only production caller is collector.tick, which awaits the cycle and schedules its next timeout in finally; overlapping direct factory calls would not establish a reachable concurrent collector path.
- Deleted-during-sample result: cycle receives a sample-time now and starts from one registry snapshot; an in-flight observation does not by itself prove a contract violation. Require next-cycle removal/age controls instead of redefining metrics snapshot semantics.
- Registry read failure currently evicts cached remote readings: recorded as an observation, not patched without a clear required cached-metric fallback contract; server_offline deliberately suppresses unknown-registry publication. No security or availability verdict inferred.
### Validation
Pending bounded serial controls and nearest tests. Source unchanged.
### Boundaries
No live node/authorization/collector overlap or native Mac/full release claim. Direct injected operations are not evidence of a production path unless callers can reach their completion order.
### Completed validation
Six actual-migrated-database serial controls passed (inspect_round67_nodeHealth.test.ts /round67_controls.log). Nearest nodeHealth and collector tests27 passed/2files (round67_scope.log). Commands: root pnpm exec vitest run --config .temp_files/audit_continuous_20261109/F1073.config.ts .temp_files/audit_continuous_20261109/inspect_round67_nodeHealth.test.ts --reporter=verbose; server pnpm exec vitest run test/lib/nodeHealth.test.ts test/plugins/collector.test.ts --coverage=false --reporter=verbose.
No source patch/finding ID/permanent test promotion; build/typecheck/scoped production lint NOT RUN for read-only inspection because no production/permanent source changed. Full root release/coverage/live node/native Mac NOT RUN. Prior round66 statics do not certify a separate live health deployment. git diff --check checked during evidence publication.
### Working tree
Only own ledger/inspector/control/scope/status evidence and audit handoff note selected; all evolving unrelated importer work remains untouched.
### Next scope
Choose a separate concrete library scope after publishing the bounded no-finding result.
Publication preflight: own six evidence/handoff paths only; cached diff and limited staged credential/runtime/index-line-ending check passed. No CHANGELOG/production file staged; selected HEAD blobs verified before push.
