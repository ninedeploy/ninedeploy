## Round 33 — instance GitOps scheduler lifecycle
### Summary
Scope confirmed: apps/server/src/plugins/gitopsScheduler.ts and its scheduler tests, required changelog/docs/evidence. Read root CONTRIBUTING, source and nearest instanceGitops/coverage/cleanup tests and getConfig/getLastCheck/runCheck callers. No direct scheduler tests existed. One Medium lifecycle race confirmed, fixed and promoted to six permanent gate/control cases.

### Toolchain
Root/server package.json: supported Node ^22.23.4 || ^24.22.1 || ^26.12.1 (live 26.13.0), pnpm 11.23.0, Vitest 5.0.5, TypeScript 7.0.2, Biome 2.5.14. Server files serialize and use isolated data; no configured race detector. Compiler checks explicitly resource-bound to child-process GOMAXPROCS=4 after the recorded native allocation failure.

### Invariants
- Close invalidates a suspended tick before it starts a new Git check or publishes a drift/failure alert.
- Live enabled ticks retain drift/error deduplication and configured interval behavior.
- Busy suppresses overlapping ticks; failure releases busy for later ticks.
- Already-started library checkout/state writes are not claimed cancellable by this scheduler-only scope.

### Findings
#### F1055 — race/lifecycle — Medium — suspended GitOps ticks publish work after close
- Location: plugins/gitopsScheduler.ts tick and onClose.
- Root cause (recorded before patch): onClose clears future interval ticks but does not invalidate an existing tick across its config/last-check/check awaits. It starts a new check or publishes late drift/failure alerts after owner close.
- Proof before: prove_F1055_gitopsClose.test.ts, F1055_before.log -> three live-owner controls passed; three closed-owner cases failed. Config/last reads expected zero runs/alerts, actual one/one; check-result wait expected one already-started run/zero alerts, actual one/one. PROBLEM CONFIRMED, exit 1.
- Severity: Medium lifecycle violation; post-close dispatch/audit calls are reproduced, not external channel delivery or actual closed-database corruption.
- Planned patch: local stopped flag set by close; check it at tick entry and after every awaited scheduler seam. Existing interval, busy and live alert semantics preserved. No cancellation of library work already started.
- Permanent regression: apps/server/test/plugins/gitopsScheduler.test.ts, six gated live/closed cases written before patch.
- Patch: stopped flag set on close; check at entry and after config/last/check awaits. No interval, alert payload or library operation changes.
- Proof after: F1055_after.log -> six passed, PROBLEM NOT REPRODUCED with zero post-close dispatch/alerts at each gate.
- Independent verify_F1055_gitopsClose.test.ts -> 18 cases, three consecutive clean runs, FIX VERIFIED (F1055_verify_1/2/3.log). Covers drift/error late results at all three gates, live alerts, disabled/manual/recent settings, unchanged/error/empty deduplication, busy overlap/failure release and replacement owner identity.

### Not reproduced (dropped)
No other defect claimed. Already-started runGitopsCheck may still finish its own checkout/state bookkeeping; the scheduler patch does not cancel library operations.

### Validation
- Focused proof/verifier: pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts <prove_F1055_gitopsClose.test.ts or verify_F1055_gitopsClose.test.ts> --reporter=verbose -> before three failed/three live controls passed; after six passed; verifier 18 passed x3.
- Scope: pnpm --dir apps/server exec vitest run test/plugins/gitopsScheduler.test.ts test/instanceGitops.test.ts test/instanceGitops.coverage.test.ts test/gitopsCleanup.test.ts --coverage=false --reporter=verbose -> 21 passed / four files (F1055_scope.log).
- Typecheck/build: child-process GOMAXPROCS=4, pnpm --dir apps/server typecheck and build -> both exit 0 (F1055_typecheck_bounded.log / F1055_build_bounded.log). Environment setting affects only those spawned shell/compiler processes.
- Lint: pnpm exec biome lint apps/server/src/plugins/gitopsScheduler.ts apps/server/test/plugins/gitopsScheduler.test.ts -> checked two files, no fixes, exit 0 (F1055_lint.log). Formatter disabled in repo configuration.
- git diff --check and git diff --cached --check -> exit 0. Limited staged-content scan: 18 files, no common credential-pattern matches, runtime files/index line endings passed; not a comprehensive security audit.
- NOT RUN: full default release gate, native Mac/DMG/Keychain, live Git clone/notification delivery. Concurrent source work remains outside scope.

### Boundaries
Real Fastify close plus explicit config/check gates; mocked library/audit seams, no actual remote clone or delivery to external channels. Fixed clock used only for verifier interval controls; deferred gates decide race ordering, no sleeps. Live alerts/interval/deduplication controls passed. No claim of cancellation for already-dispatched library work.

### Working tree
Snapshots: audit_continuous_20261109/round33_status_before.txt and round33_status_after.txt. Unrelated auth/setup/installer/doctor edits remain the other writer's work. Stage only scheduler source, its new permanent tests, own changelog entry, Mac handoff update and selected audit evidence.

### Next scope (if rounds continue)
scripts/dev-macos.mjs, docs/MACOS_DEVELOPMENT.md and desktop build workflow/callers: native developer bootstrap and available hosted CI evidence for cross-machine continuation.
