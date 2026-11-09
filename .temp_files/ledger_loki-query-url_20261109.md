## Round 25 — Loki query URL path prefixes
### Setup
- Scope confirmed: apps/server/src/lib/logSearch.ts, nearest logSearch tests and adjacent URL regression if proven; required narrow CHANGELOG entry. HEAD7e8fb7b6; source/test clean; status in round25_status_before.txt. Concurrent update-channel/installer/resources work retained.
- CONTRIBUTING applies; current checked Node26.13.0/pnpm11.23.0/TypeScript7/Vitest5.0.5/V8/tsc/Biome2.5.14, serial files, formatter disabled, no race/sanitizer. No installs/config changes.
- Entire search source/nearest lib/module/auth tests read in prior rounds; current URL and delivery endpoint use reread. Dispatch posts directly to configured drain.url, so a working full push endpoint may include a reverse-proxy prefix.
- Invariants: a query derived from a standard Loki push endpoint preserves its proxy prefix and origin; legacy root-only URLs keep existing behavior; unrelated ingestion-only query/hash semantics do not silently change. Tenant/header/role/time/filter behavior remains separate.
- Candidate F1049: absolute query path passed to new URL discards the configured ingestion prefix. Local HTTP proof will accept push/query only under the selected prefix, with root-endpoint control; no live hosted Loki claim.

### F1049 root cause before patch
- bug, Medium: drains behind a path-prefixed reverse proxy ingest successfully but log search queries the wrong path and gets404. Availability/compatibility failure, not a credential-exposure claim.
- F1049_before.log exit1/PROBLEM CONFIRMED: root push/query control true; /gateway/team-a full push endpoint accepted, derived query refused404.
- Narrow patch: for recognized /loki/api/v1/push endpoints (optional final slash), replace only that endpoint suffix using URL.pathname assignment; preserve prefix/origin. Keep prior root fallback for other configured URL forms and existing ingestion-query/hash clearing. No API/schema/config/dependency change.
- Expanded permanent scope: apps/server/test/lib/logSearchUrls.test.ts; root/full/prefixed/encoded/double-leading/trailing endpoint and legacy fallback cases.

### Summary
One Medium reverse-proxy compatibility bug fixed and promoted;64 scope tests passed. Root/legacy fallback remains compatible, no hosted Loki certification.
### Toolchain
Current checked manifests/config as recorded in Setup; no changes or installs.
### Findings
#### F1049 — bug — Medium — query endpoint loses a working Loki proxy prefix
- Location: apps/server/src/lib/logSearch.ts:89, query URL derivation.
- Root cause: an absolute root path passed to new URL discards the path prefix of a configured full ingestion endpoint.
- Proof (before): audit_continuous_20261109/prove_F1049_loki_query_prefix.test.ts; F1049_before.log exit1/PROBLEM CONFIRMED. Actual local HTTP root control push/query true; prefixed push true/query false404.
- Patch: recognize standard push suffix with optional final slash, replace via URL.pathname while preserving prefix/origin; clear prior query/hash as before and retain root fallback for other URL forms. No API/schema/config/dependency change.
- Proof (after): unchanged original exit0/PROBLEM NOT REPRODUCED; independent verify_F1049_loki_query_prefix.test.ts three consecutive passes/FIX VERIFIED,28 HTTP/HTTPS/port/prefix/encoded/double-leading/trailing/auth/fallback controls.
- Regression test: apps/server/test/lib/logSearchUrls.test.ts; before4 failed/3 controls passed, after7 passed. Origin/path and existing query/hash clearing checked through public fetch boundary.
### Not reproduced (dropped)
Timestamp integer/float ambiguity was not patched: primary Loki parseTimestamp source accepts up-to10-digit integers as Unix seconds, matching current contemporary seconds values. No time-window/tenant bypass inferred from a documentation-only reading. Source: https://raw.githubusercontent.com/grafana/loki/main/pkg/loghttp/params.go .
### Validation
- Focused: root pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts with named original/verifier --reporter=verbose: after proof and verifier runs1/2/3 passed.
- Scope: pnpm --dir apps/server exec vitest run test/lib/logSearch.test.ts test/lib/logSearchAuth.test.ts test/lib/logSearchUrls.test.ts test/modules/logSearch.test.ts test/engine/logDrainHeaders.test.ts --coverage=false:64 passed/5 files.
- Build/typecheck: pnpm --dir apps/server typecheck and build each exit0; retained F1049 logs.
- Format/lint: pnpm exec biome lint apps/server/src/lib/logSearch.ts apps/server/test/lib/logSearchUrls.test.ts:2 checked/no fixes; formatter disabled.
- git diff --check on source/test/changelog:exit0.
- NOT RUN: full coverage/release on this patch, live hosted proxy/Loki, nonstandard ingestion-path query inference, native Mac acceptance. General gate remains separately incomplete after worker OOM/concurrent source work.
### Boundaries
Real local HTTP proxy fixture and fake-fetch URL matrix; provider endpoint pair checked against https://grafana.com/docs/loki/latest/reference/loki-http-api/ . No remote provider or production logs used. URL.pathname assignment explicitly preserves origin even for double-leading path separators.
### Working tree
Concurrent update/resources/installer/management/stable-channel work retained. Only own source/test/Fixed changelog line, Mac audit handoff note and selected evidence staged; no reset/stash/evidence cleanup.
### Next scope (if rounds continue)
Select the next independent source scope after publishing this bounded fix; do not repeatedly change the same module without a new executable failure.
