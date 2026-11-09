## Round 14 — panel wake upstream reachability
### Setup
- Scope confirmed: apps/server/src/lib/panelUpstream.ts and apps/server/test/lib/panelUpstream.test.ts. HEAD1881b72f; scope clean, full status in round14_status_before.txt. Concurrent capability changes including forwardAuth/maintenance callers retained.
- CONTRIBUTING applies; current checked Node26.13.0/pnpm11.23.0/TypeScript7/Vitest5.0.5/V8/tsc/Biome2.5.14 toolchain, serial server files, formatter disabled, no race/sanitizer. No install/config changes.
- Entire source/test and caller references read. Module owns reachability probes and network alias choice, not generic HTTP stream forwarding; initial scope progress description corrected.
- Invariants: success requires a probe from inside Traefik; failed host probe may join panel container then probe alias; failed join rereads attachment; host process never attempts container join; cached result is reused only for the same upstream with distinct success/failure TTLs; subprocess details do not enter hold text.

### Summary
No new confirmed defect or patch; 41 tests passed. This bounded pass does not certify every concurrent probe ordering or live network state change.
### Toolchain
Current manifests/config as recorded in Setup; no dependency or runner changes.
### Findings
None new.
### Not reproduced (dropped)
No new executable failing candidate produced. Nearest tests cover cache reuse/expiry, join success/failure with attachment readback, unreachable hold reason and non-container behavior.
### Validation
- Focused/scope: pnpm --dir apps/server exec vitest run test/lib/panelUpstream.test.ts test/lib/sleep.test.ts test/sleepRoutes.test.ts --coverage=false: 41 passed/3 files.
- Build/typecheck: NOT RUN fresh, no source/type changes; preceding F1043 build/typecheck passed.
- Format/lint: pnpm exec biome lint apps/server/src/lib/panelUpstream.ts apps/server/test/lib/panelUpstream.test.ts: 2 checked/no fixes; formatter disabled.
- git diff --check with source/test paths: exit0.
- NOT RUN: full release/coverage, live Traefik/Docker, forward-auth/maintenance acceptance on concurrent edits, exhaustive in-flight probe ordering and Linux/macOS behavior.
### Boundaries
Docker commands and container presence are faked at existing seams. No proxy socket/stream cleanup claim applies to this module. Actual network attachment and reachable wake after sleep remain live-test boundaries.
### Working tree
Scope source/test unchanged; other service-capability work retained. Audit evidence only.
### Next scope (if rounds continue)
apps/server/src/lib/nodeDatabaseLifecycle.ts and apps/server/test/lib/nodeDatabaseLifecycle.test.ts — local admission and lock release after operation failures.
