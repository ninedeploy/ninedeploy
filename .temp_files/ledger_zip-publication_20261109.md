## Round 20 — ZIP publication atomicity
### Setup
- Scope confirmed: apps/server/src/lib/sourceUpload.ts ZIP branch, apps/server/test/sourceUploadPublication.test.ts and required narrow CHANGELOG entry. HEADb8ab5505; source/test clean; full status in round20_status_before.txt. Other capability work retained.
- CONTRIBUTING applies; current checked toolchain Node26.13.0/pnpm11.23.0/TypeScript7/Vitest5.0.5/V8/tsc/Biome2.5.14, server serial files, formatter disabled, no race/sanitizer. No installs/config changes.
- Full source/nearest tests read in round13; current publication block and regression reread after round19. F1045 TAR cleanup left ZIP deliberately out of scope. F1046 allocated next.
- Invariants: failure before publication preserves any previous complete ZIP; failed first upload is not listed as accepted source; temporary bytes are cleaned; previous history remains unchanged; successful retries remain exact and content-addressed.
- Candidate: ZIP writes directly to final SHA filename. A partial write failure truncates an existing accepted archive or creates a corrupt final-path file that listSourceUploads exposes as a valid source upload. TAR uses staged rename and is the nearby unaffected implementation.

### F1046 root cause before patch
- bug, Medium: failed same-content ZIP reupload destroys a previously accepted source archive; later deploys can no longer extract it. Filesystem failure required; no live data-loss incident/security claim.
- F1046_before.log exit1/PROBLEM CONFIRMED: complete ZIP control accepted, injected partial write leaves7 bytes at final path and listing instead of the complete archive.
- Root cause: validated ZIP bytes are written directly to the content-addressed final file, so truncation precedes completion. Narrow patch uses request-unique staging plus rename and owned cleanup; preserve public SHA filename/metadata/retention semantics, no dependency/schema/config change.

### Summary
One Medium data-integrity bug fixed and promoted; source scope39 passed. Filesystem exception handling verified locally, not power-loss durability or live disk-full behavior.
### Toolchain
Current manifests/config as recorded in Setup; no installs/config changes.
### Findings
#### F1046 — bug — Medium — partial ZIP writes corrupt accepted source archives
- Location: apps/server/src/lib/sourceUpload.ts:303, ZIP publication branch.
- Root cause: direct final-path write truncates an existing accepted archive before a complete new copy exists, and exposes partial first uploads under valid SHA names.
- Proof (before): audit_continuous_20261109/prove_F1046_zip_publication.test.ts; F1046_before.log exit1/PROBLEM CONFIRMED, full129-byte control accepted then failed reupload leaves7-byte final/listing.
- Patch: request-unique pending ZIP, complete write then same-directory rename; owned cleanup on exceptions. Public SHA filenames/validation/metadata/retention unchanged. No API/schema/config/dependency changes.
- Proof (after): unchanged original exit0/PROBLEM NOT REPRODUCED; verify_F1046_zip_publication.test.ts three consecutive passes/FIX VERIFIED:12 partial write/rename failures with/without existing archive, prior bytes/history and unrelated pending owner preserved; retries publish/extract exact source.
- Regression test: apps/server/test/sourceUploadPublication.test.ts; two ZIP cases failed before while two TAR controls passed; after all4 passed. Includes failed first upload and failed same-content reupload, complete-byte/history assertions and successful retry.
### Not reproduced (dropped)
None additional. No abrupt-crash/filesystem fsync guarantee inferred from rename.
### Validation
- Focused: root pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts with named original/verifier --reporter=verbose: after proof passed, verifier runs1/2/3 passed.
- Scope: pnpm --dir apps/server exec vitest run test/sourceUpload.test.ts test/sourceUploadRoutes.test.ts test/sourceUploadConcurrency.test.ts test/sourceUploadPublication.test.ts --coverage=false:39 passed/4 files.
- Build/typecheck: pnpm --dir apps/server typecheck and build each exit0, retained F1046 logs.
- Format/lint: pnpm exec biome lint apps/server/src/lib/sourceUpload.ts apps/server/test/sourceUploadPublication.test.ts:2 checked/no fixes; formatter disabled.
- git diff --check on source/regression/changelog paths:exit0.
- NOT RUN: full release/coverage for this round, live disk quota/ACL errors, native Mac filesystem acceptance or abrupt-crash durability. General release gate queued as next checkpoint, not assumed green.
### Boundaries
Real ZIP bytes, CRC validation, temporary filesystem and extraction; partial write/rename errors injected at delegated node:fs seam. No live credential/database or running service touched. Windows command-launch denials occurred before execution and unchanged retry succeeded.
### Working tree
Other capability/localization/docs work preserved. Only own source/test/Fixed changelog hunk and selected evidence staged; no reset/stash/evidence cleanup.
### Next scope (if rounds continue)
General release:check checkpoint on current checkout, then next concrete audit scope; preserve unrelated work and distinguish dirty-tree local validation from exact-commit CI/release certification.

During staging, the concurrent writer committed capability work as b8b18374 and docs indexing as 8b666b61. Those existing changes were preserved; this round's staged list remains only its16 selected paths. A new untracked scripts/stable-channel.mjs is outside this round and untouched.
