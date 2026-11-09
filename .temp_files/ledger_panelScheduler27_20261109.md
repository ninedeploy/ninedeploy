## Round 27 — panel backup scheduler callback lifecycle
### Summary
Scope confirmed: apps/server/src/plugins/panelBackupScheduler.ts and its tests. One Medium lifecycle race confirmed, fixed and promoted to three permanent tests. Root CONTRIBUTING and scope source/tests read; previous round inspected this source only as the caller.

### Toolchain
Root package.json: Node ^22.23.4 || ^24.22.1 || ^26.12.1, pnpm 11.23.0, Vitest 5.0.5, Biome 2.5.14. apps/server/package.json: TypeScript 7.0.2, typecheck tsc --noEmit, build tsc. Server Vitest isolates data and disables file parallelism; no configured race detector.

### Invariants
- Closing the app stops the cron, clears listener/reload timer, and invalidates callbacks suspended in configuration reads.
- A live enabled tick starts one scheduled backup; a disabled/unreadable configuration starts none.
- Background callback errors reach the logger and do not become unhandled rejections.
- No new timer/job may be armed after close.

### Findings
#### F1051 — race/lifecycle — Medium — pending tick starts backup after application close
- Location: panelBackupScheduler.ts cron callback after getPanelBackupConfig await.
- Root cause (recorded before patch): close sets stopped=true and stops Cron, but an already-fired callback resumes after its configuration read and checks only enabled. It then calls runPanelBackup against the closed application's DB/resources.
- Proof before: F1051_before_corrected.log, EXPECTED 0 ACTUAL 1, PROBLEM CONFIRMED, exit 1; live-owner and failed-read controls passed (two controls / one failure). Permanent test also reproduced under the package runner (F1051_package_before.log).
- Fixture correction: initial root fixture did not mock server-resolved croner (ticks unavailable); diagnostic showed real Cron armed. Audit-only explicit module alias in F1051.config.ts matches dependency resolution; no production/package config change. Failed setup attempts retained, not findings.
- Planned patch: check stopped after awaited live config read before invoking backup; no cancellation of an already-started backup claimed.
- Regression: test/plugins/panelBackupSchedulerLifecycle.test.ts; explicit deferred read and real Fastify close. Event-loop checkpoint drains released continuations; no sleep determines ordering.
- Patch: a stopped check after the awaited config read, before runPanelBackup. Required changelog entry and Mac handoff table updated.
- Proof after: F1051_after.log, EXPECTED 0 ACTUAL 0, PROBLEM NOT REPRODUCED; all three tests passed.
- Independent verify_F1051_schedulerClose.test.ts: seven cases, three overlapping tick reads released in reverse order, closed/live owners, enabled/disabled/rejected reads, replacement app. Seven passed, FIX VERIFIED, three consecutive runs (F1051_verify_1/2/3.log).

### Not reproduced (dropped)
None yet.

### Validation
- Focused proof: pnpm exec vitest run --config .temp_files/audit_continuous_20261109/F1051.config.ts .temp_files/audit_continuous_20261109/prove_F1051_schedulerClose.test.ts --reporter=verbose -> before one failed/two controls passed; after three passed.
- Independent verifier: same config, verify_F1051_schedulerClose.test.ts -> seven passed x3.
- Scope: pnpm --dir apps/server exec vitest run test/panelBackupRetention.test.ts test/panelBackup.test.ts test/panelBackupLock.test.ts test/plugins/panelBackupScheduler.test.ts test/plugins/panelBackupSchedulerLifecycle.test.ts --coverage=false --reporter=verbose -> 29 passed / 5 files (F1051_scope.log).
- Build/typecheck: pnpm --dir apps/server typecheck and build -> both exit 0 (F1051_typecheck.log / F1051_build.log). Typecheck session collected successfully after its initial tool yield.
- Format/lint: pnpm exec biome lint apps/server/src/plugins/panelBackupScheduler.ts apps/server/test/plugins/panelBackupSchedulerLifecycle.test.ts -> checked two files, no fixes, exit 0. Formatter disabled in repo config.
- git diff --check -> exit 0.
- NOT RUN: full release gate, native Mac/DMG/Keychain, live S3. Bounded round; source in unrelated auth/installer paths changed concurrently.

### Boundaries
Explicit read gates and real Fastify close exercise lifecycle order. Cron and backup body/config are mocked; this proves callback dispatch ownership, not native Cron scheduling, backup cancellation or native Mac lifecycle. Before-proof fixture failures retained. One command spawn was denied before execution; retried with shorter commands, no validation inferred from that launch.

### Working tree
Snapshot audit_continuous_20261109/round27_status_before.txt. Unrelated setupAcme/auth/autoUrl/installer/env/OpenAPI/schema/SDK changes belong to the concurrent writer and are preserved. Stage only owned source/test/docs/changelog hunk and selected audit evidence. Final status retained in round27_status_after.txt.

### Next scope (if rounds continue)
apps/server/src/plugins/pitrScheduler.ts and its nearest tests: retention and callback ownership in point-in-time recovery scheduling.
