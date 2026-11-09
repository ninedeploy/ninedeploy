## Round 24 — case-insensitive log drain header precedence
### Setup
- Scope confirmed: apps/server/src/engine/logDrainManager.ts, apps/server/src/lib/logSearch.ts, their nearest tests and an adjacent header regression if proven. A small internal header-merge helper may be introduced only if the proof requires shared behavior; required narrow CHANGELOG entry.
- HEADc0a6c925; source/test paths clean, full status in round24_status_before.txt. Other concurrent update/resources/installer/management/stable-channel work retained.
- CONTRIBUTING applies; current checked toolchain Node26.13.0/pnpm11.23.0/TypeScript7/Vitest5.0.5/V8/tsc/Biome2.5.14; serial server files, formatter disabled, no race/sanitizer. No installs/config changes.
- Full manager/query sources and nearest tests read. Invariants: custom headers override defaults independent of field-name case; explicit API credentials override the same custom auth field under the existing policy; unrelated tenant/custom fields survive; inputs are not mutated. HTTP field-name case must not create comma-joined duplicate credential/content-type values.
- Candidate F1048: record spreading/assignment merges by case-sensitive JS keys, but fetch combines those keys as one HTTP field. Differently cased custom Authorization and Content-Type can therefore break otherwise equivalent working configurations. Test with actual local HTTP before patching; no auth-bypass/security claim.

### F1048 root cause before patch
- bug, Medium: valid differently cased header configurations yield duplicate comma-joined credentials/content-type values, breaking log delivery/search. Not a credential-exposure or bypass claim.
- F1048_before.log exit1/PROBLEM CONFIRMED: native local HTTP canonical control push/query true; equivalent lowercase headers push/query false.
- Primary field-name contract checked: https://www.rfc-editor.org/rfc/rfc9110.html#section-5.1 .
- Narrow patch: shared internal case-insensitive last-source-wins merge, keeping last spelling and input records unchanged; use only in affected query/delivery header construction. Add apps/server/src/lib/httpHeaders.ts and apps/server/test/engine/logDrainHeaders.test.ts to explicit scope. No public SDK/API/schema/config/dependency change.

### Verifier boundary correction
Initial verifier completed the credential/content-type cases but failed an extra __proto__ wire-header expectation. Independent raw Node control without product code (F1048_native_header_control.mjs/log) shows new Headers(JSON.parse(...)) drops __proto__ already, while preserving constructor and ordinary opaque custom header. That unrelated platform behavior is not claimed fixed or introduced here. Replace the opaque fixture name with X-Opaque-Context, retaining exact value/input-preservation assertions; keep the failed verifier log. Product source unchanged for this correction.

### Summary
One Medium header-precedence bug fixed and promoted;110 scope tests pass. Current native __proto__ conversion behavior remains a separate unmodified platform boundary.
### Toolchain
Current checked manifests/config as recorded in Setup; no installs/config changes.
### Findings
#### F1048 — bug — Medium — differently cased custom headers break delivery/search precedence
- Location: apps/server/src/engine/logDrainManager.ts:163, postToDrain; apps/server/src/lib/logSearch.ts:96, searchLogs.
- Root cause: case-sensitive record merges leave equivalent HTTP field names side by side; fetch joins values instead of applying intended custom/default/API-key precedence.
- Proof (before): audit_continuous_20261109/prove_F1048_header_precedence.test.ts, F1048_before.log exit1/PROBLEM CONFIRMED; real local HTTP canonical control push/query true, lowercase equivalents push/query false.
- Patch: internal mergeHttpHeaders in lib/httpHeaders.ts applies last-source precedence by lowercase name while preserving last spelling and inputs; use in affected delivery/search construction only. No external API/schema/config/dependency changes or new auth policy.
- Proof (after): unchanged original exit0/PROBLEM NOT REPRODUCED. Initial verifier failed an unrelated native __proto__ fixture assumption; independent baseline and failed log retained. Corrected opaque-name fixture verifier retry1/2/3 each exit0/FIX VERIFIED,34 controls across single/batch HTTP/Datadog/NewRelic/Splunk/Elasticsearch auth, content-type overrides and query custom fields/input preservation.
- Regression test: apps/server/test/engine/logDrainHeaders.test.ts; before8 failed/4 controls passed; after12 passed. API-key precedence, custom content-type case variants, provider-key fields, query auth and no-key custom credential control.
### Not reproduced (dropped)
Native Headers(record) __proto__ loss exists without product helper; no repository fix or new security finding claimed for it. No unrelated URL/filter/window policy changed.
### Validation
- Focused: root pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts with named proof/verifier --reporter=verbose: original after passed; final retry verifier three consecutive passes.
- Scope: pnpm --dir apps/server exec vitest run test/engine/logDrainManager.test.ts test/engine/logDrainHeaders.test.ts test/engine/logDrainTargets.test.ts test/engine/logShipper.test.ts test/plugins/logShipper.test.ts test/logDrains.test.ts test/lib/logSearch.test.ts test/lib/logSearchAuth.test.ts test/modules/logSearch.test.ts --coverage=false:110 passed/9 files.
- Build/typecheck: pnpm --dir apps/server typecheck and build each exit0; retained F1048 logs.
- Format/lint: pnpm exec biome lint apps/server/src/lib/httpHeaders.ts apps/server/src/lib/logSearch.ts apps/server/src/engine/logDrainManager.ts apps/server/test/engine/logDrainHeaders.test.ts:4 checked/no fixes; formatter disabled.
- git diff --check on source/test/changelog paths:exit0.
- NOT RUN: full coverage/release on this patch, live hosted drain providers, native Mac or security penetration testing. General checkpoint remains incomplete after native worker OOM; no threshold lowered.
### Boundaries
Real local HTTP for wire regression, fake-fetch provider controls using synthetic credentials, raw Node Headers baseline for fixture correction. No production logs or credentials used and no remote provider contacted.
### Working tree
Concurrent update/resources/installer/management/stable-channel work preserved. Stage only this source/helper/test/Fixed changelog hunk and selected evidence; no reset/stash/evidence cleanup.
### Next scope (if rounds continue)
Loki reverse-proxy URL prefix handling — compare a successful configured ingestion endpoint with the derived query URL before changing URL behavior.
