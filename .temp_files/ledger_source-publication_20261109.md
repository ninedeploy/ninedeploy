## Round 19 — source upload publication failure cleanup
### Setup
- Scope confirmed: apps/server/src/lib/sourceUpload.ts publication stage, apps/server/test/sourceUploadPublication.test.ts and required narrow CHANGELOG entry. HEADe8eca7c9; source clean. Status in round19_status_before.txt. Other capability work preserved.
- CONTRIBUTING applies; current checked Node26.13.0/pnpm11.23.0/TypeScript7/Vitest5.0.5/V8/tsc/Biome2.5.14; serial files, formatter disabled, no race/sanitizer. No installs/config changes.
- Full source/nearest archive and route tests read in round13; current storage/publication block and permanent concurrency tests reread. Existing round13 IDs retained; F1045 next.
- Invariants: every failed validation/publication removes its owned temporary archive, preserves an already published copy, does not refresh/prune history on failure, and propagates the original filesystem error.
- Candidate: renameSync is outside the existing cleanup catch. A publication error leaves a validated full archive under .pending. After F1043 unique staging names, repeated same-byte failures can accumulate distinct leaked files. This is a new follow-up concern; previous concurrency proof did not certify publication failure cleanup.

### F1045 root cause before patch
- resource-leak, Medium: filesystem publication failure leaves request-owned archive bytes on disk, permitting repeated failed retries to accumulate storage. Before proof retains previous valid final bytes but observes one leaked pending file; F1045_before.log exit1/PROBLEM CONFIRMED with passing successful-publication control.
- Root cause: cleanup catch encloses only validation, not pending write or final rename. The write can also leave a partial file before throwing; permanent red tests will inject this adjacent failure before changing production.
- Narrow patch: put pending write and final rename inside the existing owned-file cleanup try/catch. No API/schema/config/public filename/dependency change; no broad ZIP rewrite.

### Validation follow-up — deterministic F1043 regression ordering
First four-file scope run had 36 passed/1 failed: prior F1043 regression expected input order to equal gzip/validation arrival order, but actual statuses were rejected/fulfilled instead of fulfilled/rejected. Required behavior (one survivor, one injected failure) occurred; the test's ordering assumption is invalid. Expand test scope to sourceUploadConcurrency.test.ts and gate the first request at validation before starting the second, preserving all assertions and real overlap. Recheck the strengthened test against the preserved pre-F1043 source snapshot before calling it deterministic. No product ordering behavior changed for this issue.

### Summary
One Medium resource leak fixed; permanent tests promoted and previous concurrency test made deterministic with explicit admission gating. Current four-file scope 37 passed. ZIP publication is not covered by this TAR-only fix.
### Toolchain
Current manifests/config as recorded in Setup; no changes/dependencies added.
### Findings
#### F1045 — resource-leak — Medium — failed TAR uploads leave pending archive bytes
- Location: apps/server/src/lib/sourceUpload.ts:307, storeSourceUpload TAR branch.
- Root cause: pending write and final rename were outside the cleanup catch around tar validation, allowing partial/full request files to remain after exceptions.
- Proof (before): audit_continuous_20261109/prove_F1045_upload_publication_cleanup.test.ts; F1045_before.log exit1/PROBLEM CONFIRMED, successful publication control and prior final bytes intact, pending count1 instead of0.
- Patch: include pending write/final rename in existing request-owned-file cleanup try/catch; no API/schema/config/final filename/dependency changes.
- Proof (after): unchanged original exit0/PROBLEM NOT REPRODUCED. Independent verify_F1045_upload_publication_cleanup.test.ts three consecutive passes/FIX VERIFIED: 24 controlled write/rename/validation failures with/without a previous archive, unrelated pending owner preserved, history unchanged, retry succeeds.
- Regression test: apps/server/test/sourceUploadPublication.test.ts, before2 failed (rename/partial write), after2 passed. SourceUploadConcurrency.test.ts was additionally gated without changing assertions; final version failed both cases on preserved pre-F1043 source (F1045_gated_regression_old_source.log), then two regression files passed4 tests three consecutive runs on current code.
### Not reproduced (dropped)
The initial scope ordering failure was traced to test setup, not relabeled a product defect or hidden. No ZIP publication safety inferred.
### Validation
- Focused: root pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts with named original/verifier --reporter=verbose: after proof passed/verifier3x passed.
- Regressions: pnpm --dir apps/server exec vitest run test/sourceUploadConcurrency.test.ts test/sourceUploadPublication.test.ts --coverage=false: 4 passed/2 files, three runs after deterministic gate.
- Scope: pnpm --dir apps/server exec vitest run test/sourceUpload.test.ts test/sourceUploadRoutes.test.ts test/sourceUploadConcurrency.test.ts test/sourceUploadPublication.test.ts --coverage=false: initial36 passed/1 ordering-assumption failure; final37 passed/4 files. Both logs retained.
- Build/typecheck: pnpm --dir apps/server typecheck and build each exit0 on final product source; subsequent change was test gate only.
- Format/lint: pnpm exec biome lint with source and both changed regression files: 3 checked/no fixes; formatter disabled.
- git diff --check on source/regression/changelog paths: exit0.
- NOT RUN: full release/coverage, real disk quota/Windows ACL fault, native Mac acceptance. Filesystem failures injected at real delegated fs boundary; no live disk-full or security claim.
### Boundaries
Actual gzip bytes/temp filesystem, fake existing tar capture seam. Native archive semantics remain covered by existing source scope tests. Intermittent Windows command-launch Access denied retried unchanged; no product error inferred.
### Working tree
Pre-existing capability/localization/docs work retained. Only this source, both audit-owned tests, own Fixed changelog line and selected evidence staged. No reset/stash/evidence cleanup.
### Next scope (if rounds continue)
apps/server/src/lib/sourceUpload.ts ZIP publication branch — partial final write and preservation of a previously accepted source archive.
