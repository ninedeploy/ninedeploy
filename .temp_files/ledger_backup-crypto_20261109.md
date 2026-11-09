# Evidence audit — backup crypto — 2026-11-09

## Setup
- Continuous audit authorized until user stops. Scope confirmed: apps/server/src/lib/backupCrypto.ts, apps/server/test/lib/backupCrypto.test.ts, the permanent real-stream regression file apps/server/test/lib/backupCryptoTruncation.test.ts and required narrow CHANGELOG.md entry.
- Starting HEAD: pushed 54f9e9361b25fa4f0c15bc70cd3ad880f9367c4f. git status --short empty; no pre-existing edits.
- CONTRIBUTING.md, full scope source and nearest tests read. No applicable AGENTS.md. Toolchain unchanged and verified from root/server package.json, tsconfig.base.json, server Vitest config and biome.json: Node v26.13.0, pnpm 11.23.0, TypeScript ^7.0.2, Vitest ^5.0.5 with V8 coverage and serial files; tsc build/typecheck; Biome ^2.5.14, formatter disabled. No race detector/sanitizer. Nothing installed.
- Historical ledger scan found only backupCrypto paths in old dirty-tree snapshots, not a matching active finding/ledger. Next free ID F1038.
- Callers read: backupDrill stages decrypted files with a unique per-drill name. crypto.ts owns the AES-GCM cipher/tag contract. Those files are read-only context.

## Invariants
- Source backups survive failure unchanged; malformed/truncated envelopes never produce accepted plaintext.
- Every stream/file descriptor created by decryption must finish or be destroyed on every exit path, including a synchronous error before pipeline registration.
- Output cleanup must happen after file creation is settled; malformed input must not create a late output after cleanup.
- Empty authenticated envelopes remain valid. Idempotent encryption and binary boundary round-trips retain the existing envelope format.

## Candidate
A header-bearing envelope with less than 16 trailing tag bytes can make createReadStream reject its start/end range synchronously after createWriteStream has scheduled its output open. Confirmed as F1038 below.

## Findings
### F1038 — resource-leak — Medium — Truncated encrypted envelopes open an orphan output after rejection
- Location: apps/server/src/lib/backupCrypto.ts, decryptBackupFile, dataStart/dataEnd range and output/pipeline setup.
- Root cause (before patch): the function constructs the output WriteStream before checking whether the ciphertext range exists. A valid header plus fewer than 16 trailing bytes yields end < start - 1; createReadStream throws synchronously before pipeline owns the output. The catch's unlink runs before asynchronous output open and never destroys the orphan stream.
- Impact: each such malformed backup can leave an open file descriptor and a late empty plaintext-staging file. Medium: repeated malformed drills can exhaust descriptors; no recovered-data disclosure/live service claim.
- Before proof: `.temp_files/audit_continuous_20261109/prove_F1038_truncated_backup_output.test.ts` via the continuous Vitest config → exit 1 (F1038_before.log).
  CONTROL EXPECTED: valid envelope finishes and closes output | ACTUAL: plaintext correct, stream closed
  EXPECTED: orphan streams=0 outputExists=false | ACTUAL: leaked=1 outputExists=true
  PROBLEM CONFIRMED
- Real files, real AES-GCM and real Node streams. The Node fs mock only observes/delegates createWriteStream; an explicit open event forces observation after the failed cleanup. Proof finally destroys observed streams to avoid contaminating later tests.
- Planned narrow patch: reject end < start - 1 while the input handle is still managed by finally, before creating decipher/output streams. Preserve the exactly-empty authenticated envelope (end == start - 1). No envelope format/schema/API change.

## Round 4 — Streaming backup decryption
### Summary
One Medium resource leak confirmed, fixed with an envelope-range guard and promoted to four truncation regressions plus an empty-envelope control. Expanded verification passed three consecutive runs. No live service/exploit or platform-wide descriptor-count claim.

### Toolchain
Node v26.13.0, pnpm 11.23.0, TypeScript ^7.0.2 from runtime/root/server package.json; Vitest ^5.0.5 and V8 coverage/serial server files from server config; `tsc --noEmit` and `tsc` from server scripts; Biome ^2.5.14 with formatter disabled from root package.json/biome.json. No race detector/sanitizer configured. Nothing installed.

### Findings
#### F1038 — resource-leak — Medium — Rejected truncated backups leak an output descriptor and leave a late empty file
- Location: apps/server/src/lib/backupCrypto.ts:148, decryptBackupFile.
- Root cause: an invalid ciphertext byte range threw before pipeline owned the already-created WriteStream; asynchronous file open occurred after cleanup, leaving it undestroyed.
- Proof (before): .temp_files/audit_continuous_20261109/prove_F1038_truncated_backup_output.test.ts → valid-envelope control closed; EXPECTED orphan streams=0/outputExists=false; ACTUAL leaked=1/outputExists=true; PROBLEM CONFIRMED, exit 1 (F1038_before.log).
- Patch: one guard inside the existing managed input-handle block refuses an incomplete tag before output setup. CHANGELOG.md records the resource fix. Existing cipher/envelope format and authenticated-empty behavior preserved.
- Proof (after): .temp_files/audit_continuous_20261109/verify_F1038_truncated_backup_output.test.ts → FIX VERIFIED three times; original proof → PROBLEM NOT REPRODUCED, exit 0. Verifier exercises all 0–15 missing-tag boundaries twice, valid 0/1/65537-byte plaintext, a corrupted authentication tag and plaintext rejection.
- Regression test: apps/server/test/lib/backupCryptoTruncation.test.ts:25 → four incomplete-tag cases failed before and the authenticated-empty control passed; all five passed after. Real filesystem and streams, with output-open/close events as explicit completion barriers. Observer delegates real Node fs implementation; proof cleanup closes any observed leak only after asserting the failure.

### Not reproduced (dropped)
None. Concurrent encryption temp-name collisions and same-file input/output aliases were observations only; no patch or product-impact claim for them in this bounded round.

### Validation
- Focused tests: proof command below → exit 1 before / exit 0 after; verifier command → 3 consecutive exits 0, FIX VERIFIED. Permanent regression before: 4 failed / 1 passed; after: 5 passed in the scope run.
- Scope tests: cwd apps/server, `pnpm.cmd exec vitest run test/lib/backupCrypto.test.ts test/lib/backupCryptoTruncation.test.ts test/lib/backupDrill.test.ts test/lib/backupDrill.coverage.test.ts test/lib/backupRestoreVerification.test.ts --coverage=false --reporter=verbose` → 5 files / 186 tests passed, exit 0 (F1038_scope_after.log).
- Build/typecheck: `pnpm.cmd --filter @ninedeploy/server typecheck`; `pnpm.cmd --filter @ninedeploy/server build` → exits 0 (F1038_typecheck.log/F1038_build.log).
- Format/lint (scoped): `pnpm.cmd exec biome lint apps/server/src/lib/backupCrypto.ts apps/server/test/lib/backupCryptoTruncation.test.ts` → Checked 2 files, exit 0 (F1038_lint.log); formatter NOT RUN, disabled.
- git diff --check: exit 0 (shared tree has only LF-to-CRLF notices, no whitespace errors).
- NOT RUN: full monorepo/server coverage, live restore, Mac native acceptance and hosted CI for this patch — bounded source/resource audit.

### Boundaries
Real files and Node streams, fixed Date and configured test key; no network or daemon. Several shell spawns received transient OS Access denied before execution; unchanged commands succeeded on retry. No failed shell spawn was counted as a bug proof. Shared source drift appeared outside scope during this round: service-capability schemas/modules/SDK and route guards. Those files were never edited or staged by this audit. Static checks describe their invocation snapshot, not a certification of concurrent work after that snapshot.

### Working tree
Started clean at pushed 54f9e936. Own changes: CHANGELOG.md, apps/server/src/lib/backupCrypto.ts and new apps/server/test/lib/backupCryptoTruncation.test.ts. Concurrent service-capability changes remain outside this commit. No reset/stash/revert/cleanup; selected evidence retained. User-authorized commit/push is scoped to this completed round.

### Next scope (if rounds continue)
apps/server/src/lib/fileCommandInput.ts and its tests — stdin streaming, child-process errors and resource release.

### Exact focused commands
```powershell
pnpm.cmd exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts .temp_files/audit_continuous_20261109/prove_F1038_truncated_backup_output.test.ts --reporter=verbose
pnpm.cmd exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts .temp_files/audit_continuous_20261109/verify_F1038_truncated_backup_output.test.ts --reporter=verbose
# Before permanent regression, cwd apps/server: 4 failed / 1 passed
pnpm.cmd exec vitest run test/lib/backupCryptoTruncation.test.ts --coverage=false --reporter=verbose
```
