# Evidence ledger

Scope: apps/server/src/lib/s3.ts


## Round 13 — second 20-scope follow-up

### Setup evidence
- Instructions: root/ancestor/nested discovery: no applicable instructions; .wrongstack/AGENTS.md is outside these scopes. evidence-audit skill read.
- Baseline: .temp_files/rounds20_20261005_second/R13/status_before.txt, staged_before.patch, scope_before.patch, source_before.ts and nearest test snapshots; full dirty tree in .temp_files/rounds20_20261005_second/baseline.
- Source scope: apps/server/src/lib/s3.ts. Test scope: apps/server/test/lib/s3.test.ts.
- Invariants: Request signing and bucket/key resolution preserve exact path/query inputs; failed storage responses reach callers.

### Toolchain
Node v24.13.0 (package.json requires >=22.13.0), pnpm 11.23.0 (packageManager), TypeScript ^7.0.2, Vitest ^5.0.1, V8 coverage and Biome ^2.5.14 (root/package manifests). Server Vitest config serializes files; web uses jsdom/setup.ts. Package typecheck is tsc --noEmit. Formatter disabled by biome.json; no configured race detector/sanitizer in inspected configs. No tool/dependency installed.

### Analysis evidence
Pending source/test read and local checks.

F83 before patch: Query canonicalization reuses the object-key encoder that deliberately restores %2F to slash, violating the SigV4 query encoding contract.
Reference: https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-query-string-auth.html (slash is encoded except in object key).
Proposed repair: Retain object-key slash behavior and use full percent encoding for query names and values.
C:\Program Files\nodejs\node.exe node_modules/vitest/vitest.mjs run --disableConsoleIntercept --config .temp_files/audit.vitest.config.ts .temp_files/prove_F83_s3_query_slashes.test.ts; exit 1; .temp_files/rounds20_20261005_second/R13/F83_before.log

 RUN  v5.0.1 D:/Codebox/PROJECTS/NineDeploy

CONTROL: ?uploadId=plain-id /backups/folder/object
EXPECTED: ?uploadId=opaque%2Fid%2Btoken ACTUAL: ?uploadId=opaque/id%2Btoken
PROBLEM CONFIRMED
 ❯ .temp_files/prove_F83_s3_query_slashes.test.ts (1 test | 1 failed) 17ms
   × encodes query slashes while preserving object-key separators 17ms

 Test Files  1 failed (1)
      Tests  1 failed (1)
   Start at  00:52:20
   Duration  161ms (transform 44%, tests 29%, import 23%, worker 4%)


⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  .temp_files/prove_F83_s3_query_slashes.test.ts > encodes query slashes while preserving object-key separators
AssertionError: expected '?uploadId=opaque/id%2Btoken' to be '?uploadId=opaque%2Fid%2Btoken' // Object.is equality

Expected: "?uploadId=opaque%2Fid%2Btoken"
Received: "?uploadId=opaque/id%2Btoken"

 ❯ .temp_files/prove_F83_s3_query_slashes.test.ts:19:18
     17|   console.log('EXPECTED:', expected, 'ACTUAL:', actual);
     18|   console.log(actual === expected ? 'PROBLEM NOT REPRODUCED' : 'PROBLE…
     19|   expect(actual).toBe(expected);
       |                  ^
     20| });
     21|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯



### Summary
Round 13/20 completed. 1 confirmed finding(s); 0 runnable candidate(s) not reproduced. Executed validation passed.

### Findings
#### F83 — bug — Medium — S3 query values incorrectly retain slash separators
- Location: apps/server/src/lib/s3.ts:40, canonicalQueryString
- Root cause: Query canonicalization reuses the object-key encoder that deliberately restores %2F to slash, violating the SigV4 query encoding contract.
- Impact: Opaque multipart upload IDs containing slashes produce noncanonical signed query strings; actual provider rejection is not claimed.
- Patch: Retain object-key slash behavior and use full percent encoding for query names and values.
- Proof (before): C:\Program Files\nodejs\node.exe node_modules/vitest/vitest.mjs run --disableConsoleIntercept --config .temp_files/audit.vitest.config.ts .temp_files/prove_F83_s3_query_slashes.test.ts → exit 1; .temp_files/rounds20_20261005_second/R13/F83_before.log.

```text
RUN  v5.0.1 D:/Codebox/PROJECTS/NineDeploy

CONTROL: ?uploadId=plain-id /backups/folder/object
EXPECTED: ?uploadId=opaque%2Fid%2Btoken ACTUAL: ?uploadId=opaque/id%2Btoken
PROBLEM CONFIRMED
 ❯ .temp_files/prove_F83_s3_query_slashes.test.ts (1 test | 1 failed) 17ms
   × encodes query slashes while preserving object-key separators 17ms

 Test Files  1 failed (1)
      Tests  1 failed (1)
   Start at  00:52:20
   Duration  161ms (transform 44%, tests 29%, import 23%, worker 4%)


⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  .temp_files/prove_F83_s3_query_slashes.test.ts > encodes query slashes while preserving object-key separators
AssertionError: expected '?uploadId=opaque/id%2Btoken' to be '?uploadId=opaque%2Fid%2Btoken' // Object.is equality

Expected: "?uploadId=opaque%2Fid%2Btoken"
Received: "?uploadId=opaque/id%2Btoken"

 ❯ .temp_files/prove_F83_s3_query_slashes.test.ts:19:18
     17|   console.log('EXPECTED:', expected, 'ACTUAL:', actual);
     18|   console.log(actual === expected ? 'PROBLEM NOT REPRODUCED' : 'PROBLE…
     19|   expect(actual).toBe(expected);
       |                  ^
     20| });
     21|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
```
- Proof (after): C:\Program Files\nodejs\node.exe D:\Codebox\PROJECTS\NineDeploy\node_modules\vitest\vitest.mjs run --disableConsoleIntercept --config .temp_files/audit.vitest.config.ts .temp_files/prove_F83_s3_query_slashes.test.ts → exit 0; unchanged .temp_files/prove_F83_s3_query_slashes.test.ts.

```text
RUN  v5.0.1 D:/Codebox/PROJECTS/NineDeploy

CONTROL: ?uploadId=plain-id /backups/folder/object
EXPECTED: ?uploadId=opaque%2Fid%2Btoken ACTUAL: ?uploadId=opaque%2Fid%2Btoken
PROBLEM NOT REPRODUCED

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  00:52:41
   Duration  204ms (transform 46%, import 28%, tests 20%, worker 5%)
```
- Verifier: C:\Program Files\nodejs\node.exe D:\Codebox\PROJECTS\NineDeploy\node_modules\vitest\vitest.mjs run --disableConsoleIntercept --config .temp_files/audit.vitest.config.ts .temp_files/verify_F83_s3_query_slashes.test.ts → FIX VERIFIED, exit 0 three consecutive runs.

```text
RUN  v5.0.1 D:/Codebox/PROJECTS/NineDeploy

FIX VERIFIED

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  00:52:41
   Duration  362ms (transform 44%, tests 27%, import 25%, worker 4%)
```


```text
RUN  v5.0.1 D:/Codebox/PROJECTS/NineDeploy

FIX VERIFIED

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  00:52:42
   Duration  192ms (transform 45%, import 28%, tests 24%, worker 3%)
```


```text
RUN  v5.0.1 D:/Codebox/PROJECTS/NineDeploy

FIX VERIFIED

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  00:52:43
   Duration  155ms (transform 47%, import 24%, tests 24%, worker 5%)
```

- Regression test: not promoted (ordinary Medium/Low bug; expanded verifier retained)


### Not reproduced (dropped)
None.

### Validation
- focused: cwd D:\Codebox\PROJECTS\NineDeploy; C:\Program Files\nodejs\node.exe D:\Codebox\PROJECTS\NineDeploy\node_modules\vitest\vitest.mjs run --disableConsoleIntercept --config .temp_files/audit.vitest.config.ts .temp_files/prove_F83_s3_query_slashes.test.ts .temp_files/verify_F83_s3_query_slashes.test.ts → exit 0.

```text
RUN  v5.0.1 D:/Codebox/PROJECTS/NineDeploy

CONTROL: ?uploadId=plain-id /backups/folder/object
EXPECTED: ?uploadId=opaque%2Fid%2Btoken ACTUAL: ?uploadId=opaque%2Fid%2Btoken
PROBLEM NOT REPRODUCED
FIX VERIFIED

 Test Files  2 passed (2)
      Tests  2 passed (2)
   Start at  00:52:45
   Duration  285ms (transform 34%, tests 32%, import 27%, worker 6%)
```

- scope_tests: cwd D:\Codebox\PROJECTS\NineDeploy\apps\server; C:\Program Files\nodejs\node.exe D:\Codebox\PROJECTS\NineDeploy\node_modules\vitest\vitest.mjs run test/lib/s3.test.ts --coverage=false → exit 0.

```text
RUN  v5.0.1 D:/Codebox/PROJECTS/NineDeploy/apps/server


 Test Files  1 passed (1)
      Tests  21 passed (21)
   Start at  00:52:45
   Duration  554ms (tests 86%, transform 9%, import 4%, worker 1%)
```

- typecheck: cwd D:\Codebox\PROJECTS\NineDeploy\apps\server; C:\Program Files\nodejs\node.exe D:\Codebox\PROJECTS\NineDeploy\apps\server\node_modules\typescript\bin\tsc --noEmit → exit 0.

```text

```

- lint: cwd D:\Codebox\PROJECTS\NineDeploy; C:\Program Files\nodejs\node.exe D:\Codebox\PROJECTS\NineDeploy\node_modules\@biomejs\biome\bin\biome lint apps/server/src/lib/s3.ts → exit 0.

```text
Checked 1 file in 8ms. No fixes applied.
```

- diff_check: cwd D:\Codebox\PROJECTS\NineDeploy; git diff --check -- apps/server/src/lib/s3.ts → exit 0.

```text
warning: in the working copy of 'apps/server/src/lib/s3.ts', LF will be replaced by CRLF the next time Git touches it
```

- NOT RUN: formatter — disabled by biome.json.
- NOT RUN: complete repository test suites, coverage floors, emitted build/release check/live provider/runtime/browser validation — bounded scope audit; typecheck and configured existing scope target above.

### Boundaries
Mock fetch captures signed request URL only; no AWS/S3 request or actual upload performed. Contract checked against official AWS S3 SigV4 documentation.

### Working tree
Source changed only for the finding above; original bytes retained in source_before.ts. Existing tests compared to round snapshots. Full dirty-tree preservation comparison will follow all 20 rounds. No commit/push/reset/stash/cleanup.

### Next scope (if rounds continue)
apps/server/src/modules/labels.ts


### Final set preservation check
All 90 initial dirty/new files byte-identical; staged diff unchanged. All 20 scopes finalized, final git diff --check exit 0. Master ledger: .temp_files/ledger_twenty_scopes_second_20261005.md.


## Round L02 — follow-up (run_20261007, lead from N043 backupRemote F289) — apps/server/src/lib/s3.ts

### Setup evidence
- Instructions: .temp_files/run_20261007/BRIEF.md; evidence-audit SKILL.md + ledger template. Reserved IDs F848–F851 (used F848, F849).
- Baseline: .temp_files/run_20261007/L02/status_before.txt; scope snapshots s3_before.ts, s3.test_before.ts (git diff of both files was empty at start — earlier F83 hunk is already in HEAD).
- Source scope: apps/server/src/lib/s3.ts. Test scope: apps/server/test/lib/s3.test.ts.
- Callers of s3GetToFile (grep apps/server/src): only lib/backupRemote.ts:109 fetchRemoteBackup, which since F289 unlinks localPath on any failure. Its callers (modules/backups.ts:135, modules/volumeBackups.ts:252, lib/backupDrill.ts:225) all pass a fresh unique path (randomUUID / token+Date.now). So no product caller currently inherits the leak; the defect is in the exported function's contract (and in its own suite: the r188 stall test leaves an `s3-stall-*` partial file in tmpdir every run).
- Invariants: once s3GetToFile rejects, no truncated object remains at filePath; a request that never opened filePath (404 / fetch failure) must not touch a pre-existing file; a short body must never resolve as success.

### Toolchain
Node v24.13.0 (engines >=22.13 in root package.json), pnpm 11 + turbo, Vitest 5.0.1 (apps/server/vitest.config.ts; proofs via .temp_files/audit.vitest.config.ts), tsc --noEmit (apps/server), Biome lint (biome.json; formatter disabled). No race detector/sanitizer. Proofs use a local 127.0.0.1 node:http server (.temp_files/run_20261007/L02/s3_local_server.ts); no external network, no mocks of product imports.

### Summary
1 confirmed (F848, Low, regression test added though not required); 1 candidate dropped (F849: undici already enforces framing). Residual risk: none known in scope; an explicit Content-Length byte check was deliberately NOT added — it would reject valid Content-Encoding (gzip) objects because fetch decodes them.

### Findings
#### F848 — resource-leak — Low — s3GetToFile leaves a partial destination file when its download stream fails
- Location: apps/server/src/lib/s3.ts s3GetToFile (pre-patch lines 236–262: createWriteStream truncates/creates filePath, pipeline rejection propagated with no cleanup).
- Root cause: the function opens (and truncates) the destination before the body is known to be complete, and its only error path is `finally { clearTimeout }` — it never removes what it created, so ownership of the partial file silently passes to every caller. Masked today only by backupRemote's F289 caller-side unlink.
- Severity reason: Low — the single current caller already deletes the file; impact is the exported contract (any new caller, and the module's own stall test, leaks a truncated file).
- Proof (before): `DOCKER_HOST=tcp://127.0.0.1:9 node node_modules/vitest/vitest.mjs run --disableConsoleIntercept --config .temp_files/audit.vitest.config.ts .temp_files/prove_F848_s3_get_partial_file.test.ts` → exit 1 (log run_20261007/L02/prove_F848_s3_get_partial_file_before.log):
  ```
  CONTROL: full body ok = true | 404 keeps existing file = true
  rejected with: terminated
  EXPECTED: no file | ACTUAL: file present (0 bytes)
  PROBLEM CONFIRMED
  Tests  1 failed (1)
  ```
- Patch: apps/server/src/lib/s3.ts:236–237 (`opened` flag), :256 (`opened = true` just before createWriteStream), :263–271 (catch: if opened, rmSync(filePath, {force:true}) with its own error swallowed so the download error propagates; rethrow). 404/fetch-failure paths never set `opened`, so a pre-existing file is untouched. No API/signature change.
- Proof (after): same command → exit 0: `EXPECTED: no file | ACTUAL: no file` / `PROBLEM NOT REPRODUCED` (log ..._after.log).
- Verifier: `DOCKER_HOST=tcp://127.0.0.1:9 node node_modules/vitest/vitest.mjs run --disableConsoleIntercept --config .temp_files/audit.vitest.config.ts .temp_files/verify_F848_s3_get_partial_file.test.ts` → 3 consecutive runs exit 0, `Tests 7 passed (7)`, `FIX VERIFIED` (logs verify_F848_run1..3.log). Cases: truncated Content-Length body; truncated chunked body; stall-timer abort mid-body; pre-existing destination overwritten by a failed stream is removed (not left truncated); 404 keeps an existing file; missing destination dir → ENOENT, nothing created; full + gzip bodies succeed and a retry after a failure succeeds.
- Regression test: apps/server/test/lib/s3.test.ts:315 `F848: a stream that fails mid-body leaves no partial file; a 404 keeps an existing one` (fetchMock convention of the file). Checked against the pre-patch snapshot (copy of the test importing L02/s3_before.ts, `-t F848`): `× F848 … AssertionError: expected true to be false` → fails on old code, passes on new (scratch copy removed afterwards).

### Not reproduced (dropped)
- F849 — short body accepted as complete: Node 24 fetch (undici) rejects a body shorter than Content-Length (`terminated; Response body length does not match content-length header`) and a chunked body cut before the 0-chunk (`terminated; other side closed`); prove_F849_s3_get_short_body.test.ts → PROBLEM NOT REPRODUCED before and after the patch (control: gzip-encoded object with decoded length ≠ Content-Length downloads intact, showing an explicit length check would be wrong). No patch.
- Mid-stream RST before headers are consumed rejects in fetch() itself (`fetch failed; read ECONNRESET`) before the destination is opened — no file created even pre-patch (exploration run, scratch file removed).

### Validation
- Focused: prove_F848 (exit 0, PROBLEM NOT REPRODUCED), prove_F849 (exit 0, PROBLEM NOT REPRODUCED), verify_F848 ×3 (exit 0, 7/7, FIX VERIFIED).
- Scope tests: `cd apps/server && DOCKER_HOST=tcp://127.0.0.1:9 node ../../node_modules/vitest/vitest.mjs run test/lib/s3.test.ts test/lib/backupRemote.test.ts --coverage=false` → `Test Files 2 passed (2)`, `Tests 47 passed (47)`.
- Typecheck: `cd apps/server && node <typescript>/bin/tsc --noEmit` → exit 0, 0 errors (L02/tsc.log).
- Lint: `node node_modules/@biomejs/biome/bin/biome lint apps/server/src/lib/s3.ts apps/server/test/lib/s3.test.ts` → `Checked 2 files … No fixes applied.` Format: formatter disabled in biome.json (NOT RUN as a gate). Both files LF-only (grep -c $'\r' → 0); s3.test.ts BOM preserved.
- git diff --check -- both files → exit 0 (only the autocrlf working-copy warning).
- NOT RUN: whole apps/server suite (brief: focused + nearest tests only; shared CPU/temp dirs); live S3 (no network by rule).

### Boundaries
- Another writer modified apps/server/src/modules/auth.ts during this round (appears in status_after.txt, not in status_before.txt) — not touched.
- Patch saved: .temp_files/run_20261007/apps-server-src-lib-s3.patch.

### Working tree
status_before vs status_after differ only by: ` M apps/server/src/lib/s3.ts`, ` M apps/server/test/lib/s3.test.ts` (this round) and ` M apps/server/src/modules/auth.ts` (other writer). No commit/push/reset/stash/cleanup.

### Next scope (if rounds continue)
none from this lead; backupRemote's F289 caller-side unlink is now redundant but harmless (kept).

## Continuous audit round 7 — multipart exact-byte handling — 2026-11-09
### Setup and invariants
- Scope confirmed: apps/server/src/lib/s3.ts, apps/server/test/lib/s3.test.ts, additional permanent multipart-read regression tests beside it if needed, and the required narrow CHANGELOG.md entry. Existing F83/F848 ledger history and IDs retained. Next free finding F1039.
- Scope source and nearest tests read; both are clean relative to ee5b225a at start. Pre-existing concurrent service-capability work stays outside scope. CONTRIBUTING.md applies; no applicable AGENTS.md found.
- Toolchain from current root/server manifests and configs: Node v26.13.0, pnpm 11.23.0, TypeScript ^7.0.2, Vitest ^5.0.5 with V8 coverage/serial server files; tsc build/typecheck; Biome ^2.5.14, formatter disabled; no race detector/sanitizer. No dependency installed.
- Invariant: completed multipart objects contain exactly the source bytes, never zero-filled or reused-buffer bytes that were not read. A partial positive read must fill the requested part; premature EOF must reject and abort, not complete. All opened descriptors close on success/failure.
- Request signing and listing behavior are read-only context unless a separate candidate reproduces; no unproven protocol rewrite.
- Primary contract checked: https://nodejs.org/api/fs.html#fsreadsyncfd-buffer-offset-length-position — readSync returns bytesRead and refers to fs.read, which explicitly permits fewer bytes than requested and recommends looping when a minimum is required. This is a filesystem API contract, not a live-provider rejection claim.

### Candidate
s3PutFile ignores readSync's return count, but signs/uploads a buffer of the requested length. A short read can therefore publish zero or previous-part bytes and report completion. Awaiting an executable proof with full-read control, delegated real short reads and early EOF.

### F1039 confirmed before patch
- bug, High: s3PutFile ignores bytesRead, uploads the requested buffer length and completes corrupt recovery objects. A completed remote copy may later be the retained recovery point; no live data-loss incident claimed.
- Root cause: one readSync call is assumed to fill each part despite the API permitting short reads. Fill each part using actual bytesRead and fail on zero before its expected end, letting existing finally/catch close and abort.
- Before proof: F1039_before.log exit 1, control ABCDEFGHIJKL exact; shortHex 4142000045460000494a0000 vs expected 4142434445464748494a4b4c; EOF completed=true/rejected=false/aborted=false; PROBLEM CONFIRMED.
- Permanent test scope: apps/server/test/lib/s3MultipartReads.test.ts; short reads, nonmultiple tail, early EOF at initiation/after a part, read failure, empty/small single PUT, descriptor closure.

## Round 7 — S3 multipart exact-byte handling
### Summary
One High bug confirmed and promoted. Local client byte corruption is fixed; no live S3 or recovery acceptance claimed.
### Toolchain
Node v26.13.0; pnpm 11.23.0; root/server package.json, apps/server/vitest.config.ts: Vitest 5.0.5, tsc build/typecheck, Biome 2.5.14. Formatter disabled; no race/sanitizer configured.
### Findings
#### F1039 — bug — High — short filesystem reads complete corrupted multipart backups
- Location: apps/server/src/lib/s3.ts, s3PutFile part read loop (line 160).
- Root cause: the requested read length was treated as bytesRead; unread buffer bytes were signed and uploaded.
- Proof (before): audit_continuous_20261109/prove_F1039_s3_short_reads.test.ts; F1039_before.log exit 1, PROBLEM CONFIRMED; full-read control exact, short read corrupted, EOF completed without abort.
- Patch: fill the intended part using actual read counts and source/buffer offsets; zero before completion throws into existing close/abort paths. No API, schema, wire format, configuration or dependency changes.
- Proof (after): unchanged proof exit 0, PROBLEM NOT REPRODUCED; verify_F1039_s3_short_reads.test.ts runs 1/2/3 each exit 0, 56 binary/boundary/EOF cases, FIX VERIFIED.
- Regression test: apps/server/test/lib/s3MultipartReads.test.ts; before 5 failed/4 passed on behavioral assertions, after all 9 passed. Includes delegated real filesystem reads, nonmultiple tail, EOF before/after first upload, propagated read error, empty/small single PUT and descriptor closure.
### Not reproduced (dropped)
None; no speculative signing/listing changes made.
### Validation
- Focused: root pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts with each named proof/verifier path --reporter=verbose; original after passed, verifier three consecutive passes.
- Scope: pnpm --dir apps/server exec vitest run test/lib/s3.test.ts test/lib/s3MultipartReads.test.ts test/lib/backupRemote.test.ts test/lib/backupReplicas.test.ts test/lib/backupRestoreVerification.test.ts test/kernel/s3BuildCache.test.ts --coverage=false: first run 151 passed/1 failed in existing r188 real-timer slow-download test (S3 download stalled); unchanged repeat 152 passed/6 files. Both logs retained; timing contamination suspected, not a proven pre-existing base failure.
- Initial narrower command accidentally supplied three nonexistent test paths alongside three valid paths: only 58 tests/3 files ran; not represented as six-file validation. Correct command above used for final scope result.
- Build/typecheck: pnpm --dir apps/server typecheck and build each exit 0 (F1039_typecheck.log, F1039_build.log).
- Format/lint (scoped): pnpm exec biome lint apps/server/src/lib/s3.ts apps/server/test/lib/s3MultipartReads.test.ts, 2 checked/no fixes; formatter disabled.
- git diff --check: exit 0 on changed scope paths.
- NOT RUN: fresh full release gate/whole server coverage/live S3/macOS acceptance — bounded round; previous full release attempt remained incomplete due to competing coverage lock. No hosted CI success inferred.
### Boundaries
Network fake at fetch seam; actual filesystem operations delegated with controlled read caps. No provider outage/exploit or production data loss claimed. Intermittent Windows command-spawn Access denied occurred before execution; unchanged retry succeeded.
### Working tree
Concurrent service-capability/localization/docs edits preserved. CHANGELOG has a pre-existing capability feature hunk; only the F1039 Fixed entry is staged for this round. No cleanup/reset/stash. Round 5/6 evidence is retained separately.
### Next scope (if rounds continue)
apps/server/src/lib/crossProcessLock.ts and its nearest tests — exclusive-file ownership, stale owner checks and release cleanup.
