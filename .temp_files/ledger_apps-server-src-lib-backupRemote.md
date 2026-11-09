# Evidence ledger

Scope: apps/server/src/lib/backupRemote.ts (source); apps/server/test/lib/backupRemote.test.ts (nearest test, promotion target)

## Setup evidence
- Repository instructions: .temp_files/run_20261007/BRIEF.md; ~/.claude/skills/evidence-audit/SKILL.md + assets/ledger-template.md; hints.md lines 1 and 7 (N043 / N016 leads from F97, F180).
- Baseline: `git status --short` saved to .temp_files/run_20261007/backupRemote/baseline_status.txt (many other writers' files modified). Scope files were clean at start: `git status --short apps/server/src/lib/backupRemote.ts apps/server/test/lib/backupRemote.test.ts` printed nothing; `git diff --stat` on them empty.
- Invariants:
  - uploadBackup is best-effort: it must never reject; every failure (destination read, secret decrypt, S3, row stamp) is logged via `log`, the local backup stays the source of truth.
  - deleteRemoteBackup is best-effort (callers drop the row regardless); deleteRemoteBackupForRetention must throw on any failure except "object already gone" (404, handled in s3Delete) so the caller keeps the row.
  - fetchRemoteBackup either returns a complete, seal-checked file at localPath or throws with nothing left at localPath (callers only clean up after it returns; their temp names are unique per attempt).
  - Trust boundary: bucket contents (object bytes) are untrusted; the object key is used only as an S3 key, never as a local path (localPath comes from the caller).
  - Secrets: destination secret only enters S3Config; errors surfaced to logs must not carry it.

## Round 1 — apps/server/src/lib/backupRemote.ts
### Summary
2 confirmed (F288 bug/Medium, F289 resource-leak/Medium), both patched in scope and promoted to apps/server/test/lib/backupRemote.test.ts; 5 candidates dropped. Residual risk: the callers' own guards (backupScheduler F97, volumeBackups F180) are now redundant but harmless; s3GetToFile itself still leaves partial files for any other direct caller (none today besides fetchRemoteBackup).

### Toolchain
- TypeScript (typescript ^7.0.2, root package.json + apps/server/package.json); Node v24.13.0 on the box, engines >=22.13.0 (root package.json); pnpm workspaces + turbo.
- Tests: vitest ^5.0.1 (root package.json). Scope: `cd apps/server && node ../../node_modules/vitest/vitest.mjs run test/lib/backupRemote.test.ts --coverage=false` (apps/server/vitest.config.ts). Proofs: `node node_modules/vitest/vitest.mjs run --config .temp_files/audit.vitest.config.ts <file>`.
- Typecheck: `cd apps/server && node ../../node_modules/typescript/bin/tsc --noEmit`.
- Lint/format: `node node_modules/@biomejs/biome/bin/biome lint|format <files>` (biome.json).
- No race detector / sanitizer configured.

### Findings
#### F288 — bug — Medium — uploadBackup rejects on an undecryptable destination secret, breaking its best-effort contract
- Location: apps/server/src/lib/backupRemote.ts:60-79 `uploadBackup` (pre-patch line 66 `resolveDestination(db, null)` -> line 21 `decrypt(row.secretKeyEncrypted)` outside the try at line 70).
- Severity reason: Medium — the remaining unguarded caller (modules/backups.ts:104, manual DB backup route) flips a finished, completed dump to `failed`, answers 400 "Backup failed: Unknown master key version 7", and skips the `backup.create` audit (notification/live-feed fan-out). Two earlier callers turned the same throw into data loss (F97 scheduler, F180 volume snapshots) and now carry local guards; any future caller trusting the doc comment repeats it.
- Exposure (grep uploadBackup): modules/backups.ts:104 UNGUARDED (proven); plugins/backupScheduler.ts:124 guarded (F97); modules/volumeBackups.ts:169 and :365 guarded (F180 / .catch). deleteRemoteBackupForRetention callers (databases.ts:417, volumeBackups.ts:301, backupScheduler.ts:195) all wrap it in try/catch, and its throw-on-decrypt is the documented contract ("throws when the destination could not be read").
- Root cause: the destination (and with it the secret decrypt) is resolved before the try block that implements the best-effort contract, so only S3/stamp failures are swallowed.
- Proof (before): .temp_files/prove_F288_backupRemote_upload_throws_on_undecryptable_secret.test.ts (real crypto, real backupRemote, real route via buildTestApp; S3/engine/audit faked) → exit 1:
  `CONTROL  (S3 failure): resolved; log=["warning: remote upload failed: S3 multipart initiate failed (503)"]`
  `ACTUAL   (undecryptable secret): rejected: Unknown master key version 7 — is NINEDEPLOY_MASTER_KEYS missing this version?; log=[]`
  `ACTUAL   (route): 400, row states ["completed","failed"], audit calls=0` → `PROBLEM CONFIRMED`
- Patch: apps/server/src/lib/backupRemote.ts uploadBackup — destination resolution and key derivation moved inside the existing try; the catch logs the same `warning: remote upload failed: …` line (return type unchanged, `void`).
- Proof (after): .temp_files/verify_F288_backupRemote_upload_throws_on_undecryptable_secret.test.ts (repro + repeated call + unreadable table + stamp failure w/ secret-not-in-log + happy path + route 200/['completed']/audited) → `FIX VERIFIED`, 3/3 runs (plus one extra verbose run); original proof → `ACTUAL (undecryptable secret): resolved; log=["warning: remote upload failed: Unknown master key version 7 …"]`, `ACTUAL (route): 200, row states ["completed"], audit calls=1`, `PROBLEM NOT REPRODUCED`, exit 0.
- Regression test: apps/server/test/lib/backupRemote.test.ts — "F288: never throws when the destination secret cannot be decrypted"

#### F289 — resource-leak — Medium — fetchRemoteBackup leaves a partial download at localPath when the GET fails
- Location: apps/server/src/lib/backupRemote.ts:95-113 `fetchRemoteBackup` (pre-patch line 105 `s3GetToFile(...)` outside the cleanup try at 106-111).
- Severity reason: Medium — both restore routes (modules/backups.ts:135, modules/volumeBackups.ts:231) call it before their own try/finally with a fresh `<backup>.<uuid>.remote` path in the backups directory, and no sweeper matches that name (housekeeping's pruneDrillLeftovers only matches drill files). Each failed restore of a remote-only backup (stall abort, reset, mid-stream error) leaks a partial file up to the dump size, forever; retries accumulate. Content is the sealed envelope, so no confidentiality impact.
- Root cause: only the seal refusal is inside the unlink-on-error arm; s3GetToFile's pipeline creates the file before the stream fails and does not remove it, and fetchRemoteBackup rethrows without cleanup while its callers only own the path after it returns.
- Proof (before): .temp_files/prove_F289_backupRemote_fetch_leaves_partial_download.test.ts (real backupRemote + real s3.ts, global fetch faked with a body that errors after the first chunk) → exit 1:
  `CONTROL A (complete sealed): resolved; file present`
  `CONTROL B (refused plaintext): rejected: Refusing to restore …; file absent`
  `ACTUAL    (download dies): rejected: socket hang up; file present (0 bytes)` → `PROBLEM CONFIRMED`
- Patch: apps/server/src/lib/backupRemote.ts fetchRemoteBackup — the s3GetToFile call moved into the existing unlink-on-error try; doc comment updated.
- Proof (after): .temp_files/verify_F289_backupRemote_fetch_leaves_partial_download.test.ts (repro + 3 repeated failures leave dir empty + 403 before body + missing parent dir error not masked + success path keeps file + r645 refusal still removes) → `FIX VERIFIED`, 3/3 runs; original proof → `ACTUAL (download dies): rejected: socket hang up; file absent`, `PROBLEM NOT REPRODUCED`, exit 0.
- Regression test: apps/server/test/lib/backupRemote.test.ts — "F289: removes a partial download when the GET fails mid-stream"

### Not reproduced (dropped)
- deleteRemoteBackup throws on an undecryptable secret (same toDestination decrypt): reproducible but NOT a defect worth patching — swallowing it would let DELETE /backups/:bid drop the row and orphan the remote object (the only pointer to it); the throw keeps the row. Left as is; noted for the backups.ts owner that the local file is unlinked before the remote delete.
- Path traversal from the object key into the local tmp path: no — fetchRemoteBackup writes only to the caller-supplied localPath (unique uuid/token names in all 3 callers); the key is used only as the S3 object key, and uploadBackup derives the key from basename(localPath).
- Partial download accepted as complete: no in this file — a stream error rejects (proved in F289 prove/verify); a truncated sealed object passes the header-only seal check but fails GCM authentication in decryptBackupFile at restore/drill time. A short body WITHOUT a transport error depends on undici's Content-Length enforcement (s3.ts, out of scope, needs real network) — boundary, not tested.
- Remote delete success on 404 vs other errors: s3Delete treats only 404 as success and throws otherwise; deleteRemoteBackupForRetention propagates (existing test "surfaces an S3 failure …"), deleteRemoteBackup swallows by documented design. No defect.
- Credentials in error messages: decrypt errors carry only the key version; S3 errors carry status + ≤200 chars of response body (S3 error XML may include AWSAccessKeyId/StringToSign, never the secret); verify_F288 case 4 asserts the decrypted secret never reaches the log. No defect.

### Validation
- Focused tests: `DOCKER_HOST=tcp://127.0.0.1:9 node node_modules/vitest/vitest.mjs run --config .temp_files/audit.vitest.config.ts --reporter=verbose .temp_files/verify_F288_*.test.ts .temp_files/verify_F289_*.test.ts` ×3 → `FIX VERIFIED FIX VERIFIED  Tests 2 passed (2)` each run; prove_F288/F289 after patch → both `PROBLEM NOT REPRODUCED`, `Tests 2 passed (2)`, exit 0. Promoted tests with the source patch reverse-applied (`git apply -R`, then re-applied; diff confirmed identical) → `2 failed | 23 passed (25)`; with patch → pass.
- Scope tests: `cd apps/server && DOCKER_HOST=tcp://127.0.0.1:9 node ../../node_modules/vitest/vitest.mjs run test/lib/backupRemote.test.ts test/lib/s3.test.ts test/modules/backups.test.ts test/backups.test.ts test/plugins/backupSchedulerRemotePrune.test.ts test/lib/backupDrill.test.ts test/volumeBackupRoutes.test.ts --coverage=false` → `Test Files 7 passed (7)  Tests 159 passed (159)`
- Build/typecheck: `cd apps/server && node ../../node_modules/typescript/bin/tsc --noEmit` → exit 0, no output
- Format/lint (scoped): `node node_modules/@biomejs/biome/bin/biome lint apps/server/src/lib/backupRemote.ts apps/server/test/lib/backupRemote.test.ts` → `Checked 2 files … No fixes applied.` exit 0. `biome format` → NOT APPLICABLE: biome.json has `"formatter": { "enabled": false }` (files reported as ignored). CRLF check: 0 CR lines in both files.
- git diff --check: `git diff --check -- apps/server/src/lib/backupRemote.ts apps/server/test/lib/backupRemote.test.ts` → clean, exit 0
- NOT RUN: full apps/server suite — brief restricts runs to focused + nearest tests (shared CPU/temp dirs); live S3 / real network — forbidden by brief, seam faked (vi.mock s3.js / stubbed global fetch).

### Boundaries
- No tsc/test failures from other writers observed in this round.
- Concurrent writers modified apps/server/src/lib/selfUpdate.ts, apps/server/src/modules/sso.ts, apps/server/test/doctor.test.ts, apps/server/test/lib/selfUpdate.test.ts during the round (not touched by me).
- undici Content-Length enforcement for short bodies not testable without a real socket (see Not reproduced).
- Callers' redundant guards (backupScheduler.ts F97, volumeBackups.ts F180) left in place — outside scope, harmless.

### Working tree
- Modified by this round outside .temp_files: apps/server/src/lib/backupRemote.ts, apps/server/test/lib/backupRemote.test.ts (both clean at start). Patch saved: .temp_files/run_20261007/apps-server-src-lib-backupRemote.patch.
- Baseline vs final status: .temp_files/run_20261007/backupRemote/{baseline_status,final_status}.txt — all pre-existing entries still present; only additions are my two files and the four concurrent-writer files listed above.

### Next scope (if rounds continue)
apps/server/src/lib/s3.ts — s3GetToFile leaves its own partial file on pipeline failure and does not check Content-Length; any future direct caller inherits F289.

## Round 2 (continuous audit round 6) — backupRemote — 2026-11-09
### Summary
No new reproduced finding or source patch. Historical IDs F288/F289 retained and their promoted tests remain green. Read the full current source/tests and traced current restore callers; no new dependency or compatibility change.

### Toolchain
Current root/server package.json and configs: Node v26.13.0, pnpm 11.23.0, TypeScript ^7.0.2, Vitest ^5.0.5 with V8 coverage and serial server files; tsc build/typecheck; Biome ^2.5.14, formatter disabled. No race detector/sanitizer configured. CONTRIBUTING.md read; continuous independent scopes authorized by user. Nothing installed.

### Findings
None new. Existing F288/F289 are historical fixes, not counted as new discoveries.

### Invariants and caller checks
- Upload destination resolution/decryption stays inside the best-effort catch; primary backup status is not changed by an upload exception in this module.
- Fetch cleans a failed/refused download and returns only the caller's private path; real restore callers generate UUID paths before fetching, so they do not share their in-progress files.
- Retention deletion never guesses the active destination when the recorded destination is gone and propagates read/S3 failures to preserve the row.
- Ordinary fetch's active-destination fallback is an explicit compatibility contract and is tested; it was not silently changed during an audit.
- Envelope/provenance checks and legacy-volume exceptions were read alongside their tests. This review does not claim a live S3 tampering/exploitation result or an inferred server-upgrade chronology.

### Not reproduced (dropped)
No runnable new candidate. Arbitrary pre-existing fetch-path ownership collisions are not established in current UUID-naming callers; no speculative output/path API change. Manual-delete best-effort and legacy fetch fallback were distinguished from stricter retention semantics.

### Validation
- Focused/scope tests: cwd apps/server, `pnpm.cmd exec vitest run test/lib/backupRemote.test.ts test/lib/s3.test.ts test/modules/backups.test.ts test/backups.test.ts test/plugins/backupSchedulerRemotePrune.test.ts --coverage=false --reporter=verbose` → 5 files / 114 passed, exit 0; .temp_files/audit_continuous_20261109/round6_backup_remote_tests.log.
- Build/typecheck: NOT RUN again — no source/type changes in this round; previous changed-source build/typecheck evidence remains separate, with no new whole-tree claim.
- Format/lint (scoped): `pnpm.cmd exec biome lint apps/server/src/lib/backupRemote.ts apps/server/test/lib/backupRemote.test.ts` → exit 0; round6_backup_remote_lint.log. Formatter NOT RUN (disabled).
- git diff --check scoped to the two files: exit 0; own source/test diff empty.
- NOT RUN: full suites/coverage, live S3, hosted CI, security exploit or release certification — bounded no-patch review.

### Boundaries
Current historical behavior was rechecked rather than assumed from this older ledger. No external service or privileged boundary exercised. Transient shell creation failures were retried unchanged and never counted as findings.

### Working tree
All pre-existing service-capability/server/web/schema/SDK/support-matrix work stays outside scope; none edited or staged. Status retained in audit_continuous_20261109/round6_status.txt. No production modification or cleanup. Ledger/logs retained for the next scoped handoff commit.

### Next scope (if rounds continue)
apps/server/src/lib/s3.ts and test/lib/s3.test.ts — multipart exact-byte handling, download cleanup and object listing boundaries.
