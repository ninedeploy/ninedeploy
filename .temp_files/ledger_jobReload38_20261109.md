## Round 38 — recurring job reload continuity
### Summary
Scope confirmed: apps/server/src/plugins/jobScheduler.ts and nearest scheduler tests, required changelog/docs/evidence. Read root instructions, full plugin, existing pending-close/real-Cron legacy tests and runJob scheduled-row eligibility caller before candidate. One Medium lifecycle race confirmed, fixed and promoted to three permanent real-Cron cases.

### Toolchain
Root/server package.json: supported Node ^22.23.4 || ^24.22.1 || ^26.12.1 (live 26.13.0), pnpm 11.23.0, Vitest 5.0.5/V8, TypeScript 7.0.2, Biome 2.5.14, croner 10.0.1. Server files serialize and isolate data; no configured race detector.

### Invariants
- An unchanged enabled recurring job must retain its next deadline while the job-list refresh waits or fails transiently.
- Old scheduled callbacks still pass scheduled=true, so runJob rechecks enabled on the live row.
- Close stops active crons and invalidates a pending reload before it can arm new jobs.
- A successful refresh may replace the old set synchronously; invalid job definitions remain warned/skipped.

### Findings
#### F1058 — race/lifecycle — Medium — reload tears down working schedules before its query succeeds
- Location: plugins/jobScheduler.ts armJobs teardown before findMany.
- Root cause (before patch): old Cron instances are stopped before awaiting the refresh query. A pending query crossing the next deadline, or a transient read failure, leaves unchanged enabled jobs unarmed until a later successful reload.
- Proof before: prove_F1058_jobReload.test.ts, F1058_before.log -> quick reload control dispatched all six minute deadlines; pending/failed reloads dispatched five. Two failures/one passing control, PROBLEM CONFIRMED, exit 1. This is a missed-deadline functional claim, not a latency/performance benchmark.
- Time control: real installed Cron with virtual Date/timeouts; explicit UTC environment stub added and restored to remove host timezone assumptions. Rerun on unchanged source retained as F1058_before_controlled.log.
- Severity: Medium recurring work can miss a scheduled execution when a list refresh waits/fails. Actual shell/deploy/backup work was not executed.
- Planned patch: query/filter first, honor stopped, then synchronously stop/replace the old Cron set. A failed query retains existing crons; runJob scheduled=true still rechecks live enabled/deleted state.
- Permanent regressions: apps/server/test/plugins/jobSchedulerReload.test.ts, three quick/pending/failed cases written before patch.
- Patch: stop the prior Cron set only after a successful query/filter and stopped-owner check, immediately before synchronous replacement. No public API/schema/config change.
- Proof after: F1058_after.log -> all three cases dispatched six deadlines, PROBLEM NOT REPRODUCED, three passed.
- Independent verify_F1058_jobReload.test.ts: 12 cases, three consecutive clean runs, FIX VERIFIED (F1058_verify_1/2/3.log). Real Cron with explicit UTC/fake Date/timeouts; minute/hour boundaries, successful set swap without duplicates, disabled/deleted jobs, close while pending, later refresh recovery and initial pre-migration failure/retry.

### Not reproduced (dropped)
No additional finding claimed. Scheduled callbacks retain scheduled=true; existing jobRunner tests confirm disabled/deleted eligibility is checked at dispatch, so preserving old timers does not bypass the live-row guard.

### Validation
- Focused proof/verifier: pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts <prove_F1058_jobReload.test.ts or verify_F1058_jobReload.test.ts> --reporter=verbose -> before two failed/one quick control passed, same result after explicit timezone control; after three passed; independent 12 passed x3.
- Scope: pnpm --dir apps/server exec vitest run test/plugins/jobScheduler.test.ts test/plugins/jobSchedulerReload.test.ts test/lib/jobRunner.test.ts test/jobs.test.ts --coverage=false --reporter=verbose -> 65 passed / four files (F1058_scope.log).
- Typecheck/build: child-process GOMAXPROCS=4, pnpm --dir apps/server typecheck / build -> both exit 0 (F1058_typecheck.log / F1058_build.log). No repository/shared environment config change.
- Lint: pnpm exec biome lint apps/server/src/plugins/jobScheduler.ts apps/server/test/plugins/jobSchedulerReload.test.ts -> checked two files/no fixes/exit 0 (F1058_lint.log). Formatter disabled.
- git diff --check and git diff --cached --check -> exit 0. Limited selected-content scan: 25 owned files, no common credential-pattern matches, runtime files/index line endings passed; not a comprehensive security audit. Commit guard verifies the exact staged path set and every source/evidence blob before push.
- NOT RUN: full default root gate, latest exact-commit hosted server CI, actual Docker/exec/deploy/backup work, native Mac runtime. Neighboring worker/route execution collaborators are mocked.

### Boundaries
Real installed Cron, explicit UTC restored after every case, deterministic virtual Date/timeouts and deferred query gates establish missed/correct deadlines. Job execution is mocked; no actual shell command, live scheduler latency benchmark or production task launch. No sleeps choose race ordering. Failed queries preserve the previous set; invalid definitions are still replaced/skipped after a successful read as before.

### Working tree
Snapshots: audit_continuous_20261109/round38_status_before.txt and round38_status_after.txt. Include previous no-finding round 37's exact artifacts in this checkpoint, not the whole scratch directory. Stage only scheduler source/new tests, own changelog line, Mac note, owned ledgers and selected proof/check logs; guard exact paths and verify committed blobs before push.

### Next scope (if rounds continue)
apps/server/src/lib/jobRunner.ts scheduled deploy admission and deployQueue callers/tests: service queue capacity when different job IDs enqueue concurrently.
