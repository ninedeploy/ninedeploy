## Round 13 — source upload temporary ownership
### Setup
- Scope confirmed: apps/server/src/lib/sourceUpload.ts, apps/server/test/sourceUpload.test.ts, apps/server/test/sourceUploadRoutes.test.ts and adjacent concurrency regression if proven; required narrow CHANGELOG entry. HEAD9ceaf094; source/tests clean, status in round13_status_before.txt. Concurrent service-capability work retained.
- CONTRIBUTING applies; no nested AGENTS. Current checked root/server manifests/config: Node26.13.0/pnpm11.23.0/TypeScript7/Vitest5.0.5/V8/tsc/Biome2.5.14, serial server files, formatter disabled, no race/sanitizer. No installs.
- Entire source, nearest archive tests and route test setup read before candidates. Network/tar boundary may be faked only at existing capture seam; real archive bytes and filesystem publication remain observed.
- Invariants: simultaneous valid uploads do not delete/rename another upload's staging file; a rejected upload never publishes or prunes recovery input; pending file is removed when validation or publication fails; archive bounds/path/type checks precede trusted storage. Each extraction owns its staging tree until final move.
- Candidate F1043: same-service, same-hash tar uploads share .pending-<sha>.tar.gz across awaited validation; one renames it away while the other still needs it. Serial retry is the unaffected control; explicit validation gates will force actual overlap.

### F1043 root cause before patch
- race/ownership, Medium: valid simultaneous identical uploads contend for a fixed private staging path; one request renames away the other request's input, causing a false failed upload. No production outage or corrupt published bytes claimed.
- F1043_before.log exit1: serial two-upload control passed; gated concurrent results fulfilled/rejected; PROBLEM CONFIRMED.
- Narrow patch: per-request UUID in pending filename, preserving content-addressed final name and existing validation/retention/API behavior. No dependency, schema, persisted metadata or public format change.
- Permanent scope apps/server/test/sourceUploadConcurrency.test.ts: gated overlap, pending-owner separation, repeated successful publication and failure cleanup; no sleeps.

### Summary
One Medium race/ownership defect confirmed, fixed and promoted. File identity remains content-addressed; only private temporary names change.
### Toolchain
Current Node26.13.0/pnpm11.23.0/TypeScript7/Vitest5.0.5/V8/tsc/Biome2.5.14 as recorded in Setup; formatter disabled, no race/sanitizer.
### Findings
#### F1043 — race/ownership — Medium — simultaneous identical tar uploads share one pending file
- Location: apps/server/src/lib/sourceUpload.ts:306, storeSourceUpload.
- Root cause: deterministic .pending-<sha> reused across awaited validation; another publisher or failing validator could rename/remove the still-owned file.
- Proof (before): audit_continuous_20261109/prove_F1043_source_upload_owners.test.ts; F1043_before.log exit1; serial control passed, gated concurrent results fulfilled/rejected; PROBLEM CONFIRMED.
- Patch: add per-request UUID to private pending name; final SHA name, validators, API and retention unchanged. No dependencies/schema/public format change.
- Proof (after): original exit0/PROBLEM NOT REPRODUCED; independent verify_F1043_source_upload_owners.test.ts three consecutive passes/FIX VERIFIED, 2/5 simultaneous requests, failed sibling cleanup isolation and serial retries; actual gzip bytes/filesystem publication with gated capture seam.
- Regression test: apps/server/test/sourceUploadConcurrency.test.ts. Initial two cases failed before; strengthened to assert behavioral failure isolation instead of private filename uniqueness. Final two cases also observed red against a preserved HEAD9ceaf094 source snapshot (only import paths relocated), F1043_behavior_regression_before.log: normal concurrent false failure and failed sibling causes both rejected. Current suite both pass. No production file temporarily replaced.
### Not reproduced (dropped)
No other candidate patched. Extraction staging naming and rename-publication failure cleanup remain outside this proven fix, not claimed verified for every concurrency/fault case.
### Validation
- Focused: root pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts with named proof/verifier --reporter=verbose: original after and verifier three runs passed.
- Scope: pnpm --dir apps/server exec vitest run test/sourceUpload.test.ts test/sourceUploadRoutes.test.ts test/sourceUploadConcurrency.test.ts --coverage=false: 35 passed/3 files. Existing tar path/type/size and real extraction cases included.
- Build/typecheck: pnpm --dir apps/server typecheck and build each exit0, F1043 logs retained.
- Format/lint: pnpm exec biome lint apps/server/src/lib/sourceUpload.ts apps/server/test/sourceUploadConcurrency.test.ts: 2 checked/no fixes; formatter disabled.
- git diff --check on changed source/test/changelog paths: exit0 (autocrlf warning only).
- NOT RUN: full coverage/release gate, live uploads/builds, macOS/Linux native tar acceptance or archive security certification. No race/sanitizer configured.
### Boundaries
Concurrency proofs use actual compressed empty tar bytes and filesystem state with the existing subprocess capture seam controlled by explicit validation barriers. No sleeps. Existing source-upload scope tests exercise real tar. Route inspected: upload handler calls store directly without serializing same-service uploads.
### Working tree
Pre-existing concurrent capability/localization/docs work preserved. Only own source/test/changelog hunk and selected evidence staged; no reset/stash/cleanup. Intermittent Windows command-spawn denials happened before execution and unchanged retry succeeded.
### Next scope (if rounds continue)
apps/server/src/lib/panelUpstream.ts and apps/server/test/lib/panelUpstream.test.ts — HTTP proxy request lifecycle and connection cleanup.
