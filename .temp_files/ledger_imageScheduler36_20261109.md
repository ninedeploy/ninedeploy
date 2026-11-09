## Round 36 — image scan scheduler callback ownership
### Summary
Scope confirmed: apps/server/src/plugins/imageScanScheduler.ts and its scheduler tests, required changelog/docs/evidence. Root CONTRIBUTING, plugin, rescanRunningImages caller/callback semantics and nearest imageScan/concurrency/coverage tests read before candidates. One Medium lifecycle race confirmed, fixed and promoted to two permanent gate/control tests.

### Toolchain
Root/server package.json: Node ^22.23.4 || ^24.22.1 || ^26.12.1 (live 26.13.0), pnpm 11.23.0, Vitest 5.0.5/V8, TypeScript 7.0.2, Biome 2.5.14. Server files serialize, isolated data roots; no configured race detector. Compiler checks explicitly use child-process GOMAXPROCS=4 after the prior native allocation failure.

### Invariants
- A scan result callback retained by an in-flight rescan may publish alerts only while its scheduler's application is live.
- Close clears the hourly interval; a live owner's alert metadata remains unchanged.
- Busy prevents overlapping rescan dispatch and releases after success/failure.
- Already-dispatched scanner processes/library state writes are not claimed cancellable by this plugin-only scope.

### Findings
#### F1057 — race/lifecycle — Medium — completed scans alert after scheduler close
- Location: plugins/imageScanScheduler.ts retained onNewCritical callback and onClose.
- Root cause (before patch): close clears future interval ticks but the rescan callback retains the old application's DB/logger context without a stopped guard.
- Proof before: prove_F1057_imageScanClose.test.ts, F1057_before.log -> live owner EXPECTED 1 ACTUAL 1 (passed); closed owner EXPECTED 0 ACTUAL 1, PROBLEM CONFIRMED, one failed/one control passed, exit 1.
- Severity: Medium lifecycle/late audit-dispatch violation. Synthetic finding callback only; no actual vulnerability, external channel delivery or closed-database corruption claimed.
- Planned patch: stopped flag set on close; tick refuses stopped owners and the retained critical callback returns before audit/summary work. Existing rescan operation is not canceled.
- Permanent regressions: apps/server/test/plugins/imageScanScheduler.test.ts, two explicit gate/control cases written and seen red before patch.
- Patch: stopped flag on close, tick entry guard and retained critical callback guard before summary/audit work. No scan-library/process behavior or public API change.
- Proof after: F1057_after.log -> two passed, PROBLEM NOT REPRODUCED, closed-owner expected/actual zero audit calls.
- Independent verifier: verify_F1057_imageScanClose.test.ts -> 11 passed, FIX VERIFIED, three consecutive clean runs (F1057_verify_1/2/3.log). Covers 0/1/3 late callbacks, overlap release, rejected rescan, pre-close alert retention, post-close interval removal and replacement owner identity.

### Not reproduced (dropped)
No further defect claimed. Already-started scanner/library work is not canceled by the scheduler callback guard.

### Validation
- Focused proof/verifier: pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts <prove_F1057_imageScanClose.test.ts or verify_F1057_imageScanClose.test.ts> --reporter=verbose -> before one failed/one live control passed; after two passed; verifier 11 passed x3.
- Scope: pnpm --dir apps/server exec vitest run test/lib/imageScan test/imageScans.coverage.test.ts test/plugins/imageScanScheduler.test.ts --coverage=false --reporter=verbose -> 82 passed / eight files (F1057_scope.log). Existing Vitest path-substring filter covers imageScan library/concurrency/node/receipt/process tests.
- Typecheck/build: child-process GOMAXPROCS=4, pnpm --dir apps/server typecheck / build -> both exit 0 (F1057_typecheck.log / F1057_build.log). No repository/shared environment change.
- Lint: pnpm exec biome lint apps/server/src/plugins/imageScanScheduler.ts apps/server/test/plugins/imageScanScheduler.test.ts -> checked two files/no fixes/exit 0 (F1057_lint.log). Formatter disabled.
- git diff --check and git diff --cached --check -> exit 0. Limited staged-content scan: 20 owned files, no common credential-pattern matches, runtime files/index line endings passed; not a comprehensive security audit. Commit guard rechecks the owned path set and every committed source/evidence blob before push.
- Full main CI for the previous published repair 276ce57e was observed separately (round36_ci_observed.json); only its captured conclusion applies, and no in-progress/cancelled run counts as a pass.
- NOT RUN: full default root gate for this scheduler patch, live Docker/Trivy/CVE/notification delivery, native Mac runtime for this server change. Earlier Desktop CI is an independent source checkpoint.

### Boundaries
Real Fastify close with explicit rescan callback gates and synthetic finding metadata; fake clock controls intervals, no sleeps decide ordering. No live Docker/Trivy/CVE/notification-channel claim. A pending scan can continue its existing library/process work; only scheduler dispatch/notification ownership is changed.

### Working tree
Snapshots: audit_continuous_20261109/round36_status_before.txt and round36_status_after.txt. Main was clean at setup after actual F1056 repair 276ce57e was pushed and verified. Previous round's ledger receives its final publication receipt. Select only scheduler source/test, own changelog line, Mac table, the two owned ledgers and specific evidence. Require an exact owned-path staged guard and HEAD blob verification after the previous round's shared-index race.

### Next scope (if rounds continue)
apps/server/src/plugins/cloudNodeScheduler.ts and nearest cloud-node tests: reconciliation ownership, overlap and shutdown around awaited provider work; no real provider resource mutations.
