## Round 12 — recorded release identity and persistence
### Setup
- Scope confirmed: apps/server/src/lib/releaseRecords.ts and apps/server/test/releaseRecords.test.ts. HEAD9ceaf094; scope files clean; status saved in audit_continuous_20261109/round12_status_before.txt. Other concurrent capability work preserved.
- CONTRIBUTING applies; no nested AGENTS. Toolchain checked in current manifests/config during preceding rounds: Node26.13.0/pnpm11.23.0/TypeScript7/Vitest5.0.5 with V8 and serial files/tsc/Biome2.5.14, formatter disabled, no race/sanitizer. No installs.
- Entire source/nearest test read, plus read-only callers in deploys/pipeline and parser/retention owner.
- Invariants: store validates and snapshots JSON before waiting on the image lock; encryption persists immutable first record; failed queue copy rolls back; corrupted ciphertext never becomes restore input; target identity is checked before changing runtimes; daemon uncertainty stays distinct from missing images and does not expose command details.
- Candidate review: store JSON is captured before await (no caller mutation window); onConflictDoNothing intentionally preserves first record; current route catches unreadable records and checks privilege/serving state before enqueue. No new proven defect from static reading.

### Summary
No new confirmed defect or source patch. Thirty scope/neighbor tests passed; bounded evidence only.
### Toolchain
Current manifests/config as recorded in Setup; no changes or installs.
### Findings
None new.
### Not reproduced (dropped)
Caller mutation during lock wait is excluded by pre-await JSON capture; no executable failing candidate produced.
### Validation
- Focused/scope: pnpm --dir apps/server exec vitest run test/releaseRecords.test.ts test/releaseImageRetention.test.ts test/lib/composeRelease.test.ts --coverage=false: 30 passed/3 files.
- Build/typecheck: NOT RUN fresh (no source/type change); preceding F1042 build/typecheck passed.
- Format/lint: pnpm exec biome lint apps/server/src/lib/releaseRecords.ts apps/server/test/releaseRecords.test.ts: 2 checked/no fixes; formatter disabled.
- git diff --check with scope paths: exit0.
- NOT RUN: full release/coverage, live Docker rollback, hosted CI or cross-platform runtime acceptance.
### Boundaries
Migrated disposable database and injected Docker seam in nearest tests; no real deployment or production secret claim.
### Working tree
Scope source/tests unchanged; concurrent capability work retained. Evidence only.
### Next scope (if rounds continue)
apps/server/src/lib/sourceUpload.ts and sourceUpload.test.ts/sourceUploadRoutes.test.ts — upload ownership, bounds and extraction cleanup.
