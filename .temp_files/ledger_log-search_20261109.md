## Round 23 — log search drain authentication context
### Setup
- Scope confirmed: apps/server/src/lib/logSearch.ts, nearest lib/module logSearch tests and adjacent auth regression if proven; required narrow CHANGELOG entry. Starting HEAD44e987c4; source/tests clean, status in round23_status_before.txt. Concurrent update-channel/resources/installer/management work retained.
- CONTRIBUTING applies; current checked Node26.13.0/pnpm11.23.0/TypeScript7/Vitest5.0.5/V8/tsc/Biome2.5.14; formatter disabled, serial server files, no race/sanitizer. No installs/config changes.
- Full source, nearest lib/module tests and route read; read-only logDrainManager/logShipper dispatch context checked. Historical F70/r008/r287/r654 behavior retained, no renumbering.
- Invariants: search uses the selected authorized drain's own configured authentication context at its own host; drain tenant/custom headers and existing Bearer prefix must behave consistently with successful outbound log dispatch; unscoped members cannot select other tenants' drains; failed upstream auth is not an empty successful search.
- Candidate F1047: outgoing dispatch preserves headersJson and avoids duplicate Bearer prefix; search ignores headersJson and prefixes Bearer unconditionally. A tenant/authenticated drain may ingest successfully while search is rejected. Proof will use real local HTTP with synthetic credentials and a plain-token/no-custom-header control. No live Loki or credential-exposure claim.

### F1047 root cause before patch
- bug, Medium: working configured Loki drains reject searches because the query drops tenant/custom authentication headers or sends Bearer twice. Query availability failure, not a tenant-isolation bypass claim.
- F1047_before.log exit1/PROBLEM CONFIRMED: plain-token control push/query true; existing production dispatch succeeds for prefixed token and tenant-header configurations, while search against same real local HTTP upstream is refused in both cases.
- Primary provider contract: https://grafana.com/docs/loki/latest/operations/multi-tenancy/ documents X-Scope-OrgID for tenant API requests and401 when required header is absent. No live provider queried.
- Narrow patch: seed query headers from stored headersJson, then apply the same existing-Bearer handling as outbound dispatch. Retain drain selection, role scoping, URL/query/time/limit behavior. No API/schema/config/dependency change.
- Expanded permanent scope: apps/server/test/lib/logSearchAuth.test.ts, covering raw/prefixed tokens, tenant/custom authorization and null headers.

### Summary
One Medium authentication-context bug fixed and promoted. Local HTTP proof and77 scope tests pass; no live Loki/security-isolation or full release certification claimed.
### Toolchain
Current manifests/config as recorded in Setup; no changes or installs.
### Findings
#### F1047 — bug — Medium — log search drops working drain authentication context
- Location: apps/server/src/lib/logSearch.ts:95, searchLogs request headers.
- Root cause: query rebuilt headers without configured custom headers and unconditionally added Bearer to a decrypted key, unlike the successful delivery path.
- Proof (before): audit_continuous_20261109/prove_F1047_log_search_auth.test.ts; F1047_before.log exit1/PROBLEM CONFIRMED. Real local HTTP: plain control push/query true, prefixed token and tenant header push true/query false.
- Patch: merge stored header object, retain existing Bearer prefix. Drain selection/permission/time/query/URL behavior unchanged; no API/schema/config/dependency change.
- Proof (after): original exit0/PROBLEM NOT REPRODUCED. Independent verifier first two passes followed by worker crash/no tests (exit3221226505); contaminated run retained and not counted. Unchanged verifier retry1/2/3 each exit0/FIX VERIFIED,12 configured-auth/operator/service-scope cases plus foreign-drain pre-fetch rejection and upstream401 propagation.
- Regression test: apps/server/test/lib/logSearchAuth.test.ts; before3 failed/2 controls passed, after5 passed. Raw/prefixed token, tenant header, custom Authorization with no key, JSON-null headers.
### Not reproduced (dropped)
No URL/filter/ordering rewrite made without a new proof. Existing drain restrictions and historic escaping/window behavior retained. Case-insensitive duplicate-header precedence is not exhaustively claimed by these cases.
### Validation
- Focused: root pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts with original/verifier --reporter=verbose: after proof passed; final retry verifier three consecutive passes.
- Scope: pnpm --dir apps/server exec vitest run test/lib/logSearch.test.ts test/lib/logSearchAuth.test.ts test/modules/logSearch.test.ts test/engine/logDrainManager.test.ts test/engine/logShipper.test.ts --coverage=false:77 passed/5 files.
- Build/typecheck: pnpm --dir apps/server typecheck and build each exit0; retained F1047 logs.
- Format/lint: pnpm exec biome lint apps/server/src/lib/logSearch.ts apps/server/test/lib/logSearchAuth.test.ts:2 checked/no fixes; formatter disabled.
- git diff --check on scope/changelog paths:exit0.
- NOT RUN: full coverage/release gate on this patch, live hosted Loki, native Mac or a tenant-isolation penetration test. General gate remains separately incomplete after environment worker OOM.
### Boundaries
Synthetic credentials, real local HTTP authentication fixture and existing fake-fetch seams; no remote log host queried. Worker fast-fail3221226505 occurred before any test result, followed by unchanged successful retries; no source failure inferred from that run.
### Working tree
Concurrent update/resources/installer/management/stable-channel source work retained. Only this source/test/Fixed changelog hunk and selected audit evidence staged; no reset/stash/evidence cleanup.
### Next scope (if rounds continue)
HTTP header precedence in log delivery/query paths — test differently cased custom headers before changing merge behavior.
