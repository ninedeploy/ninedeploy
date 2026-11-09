## Round 62 — long-running request bucket latest timestamp
### Summary
Scope confirmed: apps/server/src/lib/requestRate.ts and apps/server/test/lib/requestRateLargeHistory.test.ts. sleep.ts, trafficAnalytics.ts and autoscaler.ts plus nearest tests read-only. Setup status: unrelated CHANGELOG, CLI importer/fixtures/tests/docs and MySQL integration work preserved. Previous2ff6f69a selected blobs and remote verified.
### Toolchain
Existing Node26.13.0, TS7.0.2, Vitest5.0.5, configured Biome2.5.14. Pure library tests plus existing migrated scope tests; no installs.
### Invariants
Every valid request-bucket sequence accepted by recordServiceRequest must allow lastServiceRequestAt and scale-to-zero's sleepHoldReason to return a value rather than throw from argument-count limits. Control24-hour bucket history versus fixed200000 distinct ten-second buckets (about23.15 days), representing a long-running traffic/sleep-only consumer that does not call serviceRequestRate's pruning path.
### Findings
Pending executable proof; no source patch.
### Boundaries
This scope tests deterministic arithmetic/call-stack failure, not memory-retention/performance claims. No live traffic wait, Docker or native Mac acceptance.
### F1080 — bug — Medium — large valid request history throws during idle decisions
Before F1080_before.log ->2 failed/1 full-day control passed, Vitest exit1. Fixed200000 accepted ten-second buckets (~23.15days); lastServiceRequestAt and actual sleepHoldReason both throw RangeError: Maximum call stack size exceeded instead of returning latest timestamp/idle decision; PROBLEM CONFIRMED. No benchmark/performance conclusion drawn.
Root cause before patch: Math.max(...m.keys()) turns each retained bucket into a function argument, exceeding Node's argument/call-stack limit. Retention is currently pruned only by serviceRequestRate; traffic/sleep-only caller paths need not call it. Narrow fix: iterate keys and accumulate the maximum without spreading into arguments; preserves bucket arithmetic and out-of-order timestamps. Memory retention policy is explicitly a separate scope, not silently changed here.
### Completed verification
Original proof F1080_after.log3 passed, latest timestamp and idle decision PROBLEM NOT REPRODUCED. Permanent apps/server/test/lib/requestRateLargeHistory.test.ts3 cases were red on original2ff6f69a requestRate source (2 failed/1 day-sized control passed, F1080_permanent_before.log). Final scope91 tests/4files passed including autoscaler, sleep and trafficAnalytics (F1080_scope.log).
Independent11 arithmetic/history/consumer cases passed3 times, guarded FIX VERIFIED and exit0 (F1080_verify1/2/3.log). Empty/null-service, bucket boundary, repeated bucket, out-of-order insertion, negative epoch, independent services, large reverse order, existing rate pruning, reset and exact idle threshold. No sleeps, new dependencies or public API changes.
Commands: root pnpm exec vitest run --config .temp_files/audit_continuous_20261109/F1073.config.ts [prove/verify] --reporter=verbose; server pnpm exec vitest run test/lib/requestRateLargeHistory.test.ts test/lib/autoscaler.test.ts test/lib/sleep.test.ts test/lib/trafficAnalytics.test.ts --coverage=false --reporter=verbose ->91/4 passed. Static/lint/diff final results below.
### Boundaries
This removes argument-count failure only; it does not bound stored bucket memory or change last-request aging policy. The fixed input represents accepted bucket events, not live23-day telemetry. No claimed speedup/memory improvement, live Docker, native Mac, full root release/coverage or platform-specific call-stack threshold certification. No race detector applicable to synchronous arithmetic. Unrelated active CLI/MySQL/docs changes preserved.
### Next scope
Request bucket retention on write-only/idle consumers: establish a bounded memory proof separately.
Final static results: child-process GOMAXPROCS=4 pnpm --dir apps/server typecheck ->exit0; build ->exit0; scoped biome check requestRate source/new permanent test ->2files passed; git diff --check ->exit0. Full/default release and native acceptance remain unrun.
Publication preflight: own selected paths only; cached diff check and limited staged credential/runtime/index-line-ending scan passed. All selected HEAD source/evidence/changelog blobs checked before remote push.
