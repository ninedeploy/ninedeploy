# Evidence ledger

Scope: apps/server/src/lib/deployQueue.ts; apps/server/src/lib/crossProcessLock.ts

## Setup evidence
- Instructions: root/ancestor and nested AGENTS.md/CONTRIBUTING.md/CLAUDE.md discovery found no applicable instructions. evidence-audit skill read.
- Baseline: .temp_files/setup_all_20261004/status.txt, unstaged.patch, staged.patch and byte copies under files/. Previous setup retained.
- Source scope: the two library files. Tests: apps/server/test/lib/crossProcessLock*.test.ts, deployQueueWiring.test.ts, deploys.test.ts, deploysPromote.test.ts, serviceVolumes.test.ts; prior F63 proofs read.
- Invariants: atomic admission never exceeds 50 queued rows; unrelated insertion errors propagate; exclusive holders release only their token; a filesystem probe error must not be classified as a busy lock; only ENOENT justifies retry after disappearance.
- ID allocation: recursive proof/verifier filenames and all ledgers inspected; maximum existing ID F67. F68 reserved here.

## Round 1 — deployment admission and lock errors
### Summary
In progress.
### Toolchain
TypeScript ^7.0.2, Node v24.13.0 (required >=22.13.0), pnpm 11.23.0 from root package.json and live --version. Vitest ^5.0.1, V8 coverage and serial server files from package.json/apps/server/vitest.config.ts. tsc --noEmit and tsc build from apps/server/package.json; Biome ^2.5.14 lint, formatter disabled in biome.json. No race detector/sanitizer configured in inspected configs.
### Findings
#### F68 — bug — Medium — Lock probing masks filesystem errors
- Location: apps/server/src/lib/crossProcessLock.ts, acquireCrossProcessLock, stale probe catch.
- Root cause: catch-all around statSync/takeOverStaleLock discards access/I/O failures as if the lock vanished; caller receives a misleading contention error and retry instead of the actual failure.
- Proposed patch: retry only ENOENT; propagate other errors unchanged. No API/config/schema change.
- Proof before: pending execution of .temp_files/prove_F68_lock_probe_error.test.ts.
### Not reproduced (dropped)
Pending.
### Validation
Pending.
### Boundaries
Mocks inject filesystem errors; no host permission failure or live storage claim. Prior F63 is existing work, not a new finding.
### Working tree
Baseline saved; final comparison pending.
### Next scope (if rounds continue)
apps/server/src/lib/{agentClient,agentSeal}.ts — transport error and response lifecycle.

F68 proof command: pnpm.cmd exec vitest run --disableConsoleIntercept --config .temp_files/audit.vitest.config.ts .temp_files/prove_F68_lock_probe_error.test.ts; exit 1. Control passed; EXPECTED EACCES / ACTUAL LockUnavailableError; PROBLEM CONFIRMED. Full output: .temp_files/F68_before.log. Root cause and narrow patch recorded above before editing.


---

## Completed Round 1 report — supersedes pending setup entries

Scope: apps/server/src/lib/deployQueue.ts; apps/server/src/lib/crossProcessLock.ts

### Summary
One Medium bug reproduced and fixed (F68); one confirmed finding, no new permanent test. Scope has 122 passing existing tests. Verification is limited to the executed local seams.

### Toolchain
TypeScript ^7.0.2; Node v24.13.0 (required >=22.13.0); pnpm 11.23.0 from package.json and live version commands. Vitest ^5.0.1 and V8 coverage from package.json and package Vitest configs. Server files serialize via fileParallelism:false. Package manifests invoke tsc --noEmit for typecheck, tsc for server/SDK build and tsc --noEmit && vite build for web. Biome ^2.5.14 lint from package.json; formatter disabled in biome.json. No race detector/sanitizer configured in inspected configs. Nothing installed.

### Findings
#### F68 — bug — Medium — Lock probe errors are masked as contention
- Location: apps/server/src/lib/crossProcessLock.ts:111, acquireCrossProcessLock.
- Root cause: Catch-all around statSync/takeOverStaleLock discarded non-ENOENT errors.
- Impact: An access or I/O failure was misreported as another holder rather than reaching the caller.
- Patch: Retry only ENOENT and propagate every other probe error unchanged.
- Proof (before): pnpm.cmd exec vitest run --disableConsoleIntercept --config .temp_files/audit.vitest.config.ts .temp_files/prove_F68_lock_probe_error.test.ts → exit 1, unaffected control passed, PROBLEM CONFIRMED.

```text
RUN  v5.0.1 D:/Codebox/PROJECTS/NineDeploy

CONTROL: a readable live lock correctly reports LockUnavailableError
EXPECTED: EACCES | ACTUAL: LockUnavailableError
PROBLEM CONFIRMED
 ❯ .temp_files/prove_F68_lock_probe_error.test.ts (1 test | 1 failed) 5ms
   × reports filesystem probe failures instead of claiming another holder 5ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  .temp_files/prove_F68_lock_probe_error.test.ts > reports filesystem probe failures instead of claiming another holder
AssertionError: expected undefined to be 'EACCES' // Object.is equality

- Expected:
"EACCES"

+ Received:
undefined

 ❯ .temp_files/prove_F68_lock_probe_error.test.ts:26:23
     24|   console.log(`EXPECTED: EACCES | ACTUAL: ${actual.code ?? actual.name…
     25|   console.log(actual.code === 'EACCES' ? 'PROBLEM NOT REPRODUCED' : 'P…
     26|   expect(actual.code).toBe('EACCES');
       |                       ^
     27| });
     28|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed (1)
   Start at  22:51:47
   Duration  206ms (transform 51%, import 35%, tests 10%, worker 4%)
```
- Proof (after): unchanged pnpm.cmd exec vitest run --disableConsoleIntercept --config .temp_files/audit.vitest.config.ts .temp_files/prove_F68_lock_probe_error.test.ts → exit 0, PROBLEM NOT REPRODUCED.

```text
RUN  v5.0.1 D:/Codebox/PROJECTS/NineDeploy

CONTROL: a readable live lock correctly reports LockUnavailableError
EXPECTED: EACCES | ACTUAL: EACCES
PROBLEM NOT REPRODUCED

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  22:52:15
   Duration  150ms (transform 52%, import 37%, tests 6%, worker 5%)
```
- Verifier: pnpm.cmd exec vitest run --disableConsoleIntercept --config .temp_files/audit.vitest.config.ts .temp_files/verify_F68_lock_probe_error.test.ts → exit 0 three consecutive runs. Cases: EACCES, EIO, readable live lock, deterministic ENOENT retry, idempotent release.

Verifier run 1 — FIX VERIFIED, exit 0:

```text
RUN  v5.0.1 D:/Codebox/PROJECTS/NineDeploy

EXPECTED: EACCES | ACTUAL: EACCES
EXPECTED: EIO | ACTUAL: EIO
FIX VERIFIED
FIX VERIFIED: ENOENT retry and idempotent release

 Test Files  1 passed (1)
      Tests  2 passed (2)
   Start at  22:52:15
   Duration  139ms (transform 52%, import 34%, tests 10%, worker 4%)
```

Verifier run 2 — FIX VERIFIED, exit 0:

```text
RUN  v5.0.1 D:/Codebox/PROJECTS/NineDeploy

EXPECTED: EACCES | ACTUAL: EACCES
EXPECTED: EIO | ACTUAL: EIO
FIX VERIFIED
FIX VERIFIED: ENOENT retry and idempotent release

 Test Files  1 passed (1)
      Tests  2 passed (2)
   Start at  22:52:16
   Duration  132ms (transform 51%, import 34%, tests 10%, worker 4%)
```

Verifier run 3 — FIX VERIFIED, exit 0:

```text
RUN  v5.0.1 D:/Codebox/PROJECTS/NineDeploy

EXPECTED: EACCES | ACTUAL: EACCES
EXPECTED: EIO | ACTUAL: EIO
FIX VERIFIED
FIX VERIFIED: ENOENT retry and idempotent release

 Test Files  1 passed (1)
      Tests  2 passed (2)
   Start at  22:52:17
   Duration  132ms (transform 53%, import 33%, tests 10%, worker 4%)
```

- Regression test: not promoted; Medium ordinary bug, no new High/Critical/race/ownership finding. The strongest expanded verifier remains at .temp_files/verify_F68_lock_probe_error.test.ts; skill permits Medium/Low to remain evidence artifacts.

### Not reproduced (dropped)
None. Existing invariants that passed were not counted as findings.

### Validation
- Focused tests: proof after + verifier ×3 above; final combined proof/verifier run → 14 files, 37 tests passed, exit 0 (.temp_files/all_scopes_final_proofs.log).
- Scope tests: cwd apps/server; pnpm.cmd exec vitest run test/lib/crossProcessLock.test.ts test/lib/crossProcessLock-r314.test.ts test/deployQueueWiring.test.ts test/deploys.test.ts test/deploysPromote.test.ts test/serviceVolumes.test.ts --coverage=false → 122 passed, exit 0.

```text
RUN  v5.0.1 D:/Codebox/PROJECTS/NineDeploy/apps/server


 Test Files  6 passed (6)
      Tests  122 passed (122)
   Start at  22:52:35
   Duration  5.53s (tests 59%, import 31%, transform 10%)

    Isolate  6 workers spawned · ~90ms startup each (spawn + environment, per file)
             at least ~448ms faster with isolate: false — reuses workers across files instead of one per file
```
- Build/typecheck: cwd repo; pnpm.cmd --filter @ninedeploy/server typecheck → tsc --noEmit, exit 0.

```text
$ tsc --noEmit
```
- Format/lint (scoped): pnpm.cmd exec biome lint apps/server/src/lib/deployQueue.ts apps/server/src/lib/crossProcessLock.ts → exit 0.

```text
Checked 2 files in 5ms. No fixes applied.
```
- git diff --check -- apps/server/src/lib/deployQueue.ts apps/server/src/lib/crossProcessLock.ts → exit 0; final full git diff --check → exit 0, .temp_files/all_scopes_diff_check_final.log.
- NOT RUN: formatter — disabled by repository config.
- NOT RUN: complete server/web suites, coverage thresholds, emitted build, release:check, live providers, deployed Docker/Loki/browser/WebSocket behavior — this is seven bounded audit rounds; typechecks and scoped existing targets were run. Entire SDK target ran without coverage.

### Boundaries
No installations or network-dependent correctness proofs. All injected failures are intentional local fakes, not host contamination. F69 uses controlled fetch/known fixture key; F70 pure serialization; F71 no live authentication bypass; F73 fake location/env; F74 real Fastify/parser with captured fake DB inserts, volume check mocked. Existing agent long-op suite includes loopback HTTP. No third-party exploitation tested. Newline styles corrected only after comparing normalized current content against baseline plus exact recorded patches. Source inputs/API/schema unchanged except correcting the proven serialized field behavior for F70/F72.

### Working tree
78 pre-existing dirty/new files snapshotted. 74 remained byte-identical; four pre-existing edited files reconstruct byte-identically after reversing ONLY this round's own edits in memory. Two additional clean pre-edit copies agree with HEAD after Git newline normalization. Preservation script checked 80 records, zero mismatches (.temp_files/setup_all_20261004/preservation.json). Staged patch hash equals baseline. Original status:

```text
M apps/cli/src/commands/manifest.ts
 M apps/cli/src/config.ts
 M apps/cli/src/lib/format.ts
 M apps/cli/src/lib/serverRunner.ts
 M apps/cli/src/prompts.ts
 M apps/cli/test/manifest.test.ts
 M apps/server/src/engine/autoPrune.ts
 M apps/server/src/engine/builders/remoteDocker.ts
 M apps/server/src/engine/containerFiles.ts
 M apps/server/src/engine/logDrainManager.ts
 M apps/server/src/engine/logShipper.ts
 M apps/server/src/engine/logs.ts
 M apps/server/src/engine/magicVars.ts
 M apps/server/src/engine/pipeline.ts
 M apps/server/src/engine/volumeFiles.ts
 M apps/server/src/lib/backupCrypto.ts
 M apps/server/src/lib/buildCacheKey.ts
 M apps/server/src/lib/cloudflare.ts
 M apps/server/src/lib/crossProcessLock.ts
 M apps/server/src/lib/deployHints.ts
 M apps/server/src/lib/deployQueue.ts
 M apps/server/src/lib/diff.ts
 M apps/server/src/lib/dnsStatus.ts
 M apps/server/src/lib/dnsimple.ts
 M apps/server/src/lib/domainTransfer.ts
 M apps/server/src/lib/emailTemplates.ts
 M apps/server/src/lib/events.ts
 M apps/server/src/lib/glob.ts
 M apps/server/src/lib/hostPath.ts
 M apps/server/src/lib/imageInventory.ts
 M apps/server/src/lib/imageRef.ts
 M apps/server/src/lib/imageWatch.ts
 M apps/server/src/lib/logSearch.ts
 M apps/server/src/lib/loginLockout.ts
 M apps/server/src/lib/managedNamespace.ts
 M apps/server/src/lib/namecheap.ts
 M apps/server/src/lib/ninedeployApply.ts
 M apps/server/src/lib/pgbouncer.ts
 M apps/server/src/lib/previewDomain.ts
 M apps/server/src/lib/probeUrl.ts
 M apps/server/src/lib/registryBinding.ts
 M apps/server/src/lib/secretFile.ts
 M apps/server/src/lib/sessions.ts
 M apps/server/src/lib/settings.ts
 M apps/server/src/lib/slugAudit.ts
 M apps/server/src/lib/stats.ts
 M apps/server/src/lib/totp.ts
 M apps/server/src/lib/totpReplay.ts
 M apps/server/src/lib/updateCheck.ts
 M apps/server/src/lib/webhooks.ts
 M apps/server/src/lib/xml.ts
 M apps/server/src/modules/networks.ts
 M apps/server/src/plugins/jobScheduler.ts
 M apps/server/test/deploymentHistory.test.ts
 M apps/server/test/engine/logDrainManager.test.ts
 M apps/server/test/engine/remoteDocker.test.ts
 M apps/server/test/installReleaseIntegrity.test.ts
 M apps/server/test/lib/backupCrypto.test.ts
 M apps/server/test/lib/logSearch.test.ts
 M apps/server/test/lib/selfUpdate.test.ts
 M apps/server/test/lib/volumeFiles.test.ts
 M apps/server/test/plugins/jobScheduler.test.ts
 M apps/web/src/lib/autofill.ts
 M apps/web/src/lib/cron.ts
 M apps/web/src/lib/format.ts
 M apps/web/src/lib/pluginMenus.ts
 M apps/web/src/routes/manifestCreator/state.ts
 M apps/web/test/App.test.tsx
 M apps/web/test/manifestCreatorUtils.test.ts
 M packages/schemas/src/secretScan.ts
 M packages/schemas/src/service.ts
 M packages/sdk/src/errors.ts
 M packages/sdk/src/manifest.ts
?? apps/server/test/bashFixture.test.ts
?? apps/server/test/bashFixture.ts
?? apps/server/test/lib/sessionRotation.test.ts
?? packages/schemas/test/volumeFileWrite.test.ts
?? packages/sdk/test/manifestRoundTrip.test.ts
```
Final status:

```text
M apps/cli/src/commands/manifest.ts
 M apps/cli/src/config.ts
 M apps/cli/src/lib/format.ts
 M apps/cli/src/lib/serverRunner.ts
 M apps/cli/src/prompts.ts
 M apps/cli/test/manifest.test.ts
 M apps/server/src/engine/autoPrune.ts
 M apps/server/src/engine/builders/remoteDocker.ts
 M apps/server/src/engine/containerFiles.ts
 M apps/server/src/engine/logDrainManager.ts
 M apps/server/src/engine/logShipper.ts
 M apps/server/src/engine/logs.ts
 M apps/server/src/engine/magicVars.ts
 M apps/server/src/engine/pipeline.ts
 M apps/server/src/engine/volumeFiles.ts
 M apps/server/src/lib/agentClient.ts
 M apps/server/src/lib/backupCrypto.ts
 M apps/server/src/lib/buildCacheKey.ts
 M apps/server/src/lib/cloudflare.ts
 M apps/server/src/lib/crossProcessLock.ts
 M apps/server/src/lib/deployHints.ts
 M apps/server/src/lib/deployQueue.ts
 M apps/server/src/lib/diff.ts
 M apps/server/src/lib/dnsStatus.ts
 M apps/server/src/lib/dnsimple.ts
 M apps/server/src/lib/domainTransfer.ts
 M apps/server/src/lib/emailTemplates.ts
 M apps/server/src/lib/events.ts
 M apps/server/src/lib/glob.ts
 M apps/server/src/lib/hostPath.ts
 M apps/server/src/lib/imageInventory.ts
 M apps/server/src/lib/imageRef.ts
 M apps/server/src/lib/imageWatch.ts
 M apps/server/src/lib/logSearch.ts
 M apps/server/src/lib/loginLockout.ts
 M apps/server/src/lib/managedNamespace.ts
 M apps/server/src/lib/namecheap.ts
 M apps/server/src/lib/ninedeployApply.ts
 M apps/server/src/lib/pgbouncer.ts
 M apps/server/src/lib/previewDomain.ts
 M apps/server/src/lib/probeUrl.ts
 M apps/server/src/lib/registryBinding.ts
 M apps/server/src/lib/secretFile.ts
 M apps/server/src/lib/sessions.ts
 M apps/server/src/lib/settings.ts
 M apps/server/src/lib/slugAudit.ts
 M apps/server/src/lib/stats.ts
 M apps/server/src/lib/totp.ts
 M apps/server/src/lib/totpReplay.ts
 M apps/server/src/lib/updateCheck.ts
 M apps/server/src/lib/webhooks.ts
 M apps/server/src/lib/xml.ts
 M apps/server/src/modules/networks.ts
 M apps/server/src/modules/services.ts
 M apps/server/src/plugins/jobScheduler.ts
 M apps/server/test/deploymentHistory.test.ts
 M apps/server/test/engine/logDrainManager.test.ts
 M apps/server/test/engine/remoteDocker.test.ts
 M apps/server/test/installReleaseIntegrity.test.ts
 M apps/server/test/lib/backupCrypto.test.ts
 M apps/server/test/lib/logSearch.test.ts
 M apps/server/test/lib/selfUpdate.test.ts
 M apps/server/test/lib/volumeFiles.test.ts
 M apps/server/test/plugins/jobScheduler.test.ts
 M apps/web/src/lib/api.ts
 M apps/web/src/lib/autofill.ts
 M apps/web/src/lib/cron.ts
 M apps/web/src/lib/format.ts
 M apps/web/src/lib/pluginMenus.ts
 M apps/web/src/routes/manifestCreator/state.ts
 M apps/web/test/App.test.tsx
 M apps/web/test/manifestCreatorUtils.test.ts
 M packages/schemas/src/secretScan.ts
 M packages/schemas/src/service.ts
 M packages/sdk/src/errors.ts
 M packages/sdk/src/manifest.ts
?? apps/server/test/bashFixture.test.ts
?? apps/server/test/bashFixture.ts
?? apps/server/test/lib/sessionRotation.test.ts
?? packages/schemas/test/volumeFileWrite.test.ts
?? packages/sdk/test/manifestRoundTrip.test.ts
```
No commit, push, reset, stash, branch switch or evidence cleanup.

### Next scope (if rounds continue)
agentClient.ts/agentSeal.ts — endpoint cache and transport.

## Continuous round 8 setup — 2026-11-09
- Scope confirmed: apps/server/src/lib/crossProcessLock.ts and apps/server/test/lib/crossProcessLock.test.ts, crossProcessLock-r314.test.ts; CHANGELOG only if a proven patch needs it.
- Starting identity b0432ce823d57bc893c7420617b034a985618b69; status saved in audit_continuous_20261109/round8_status_before.txt; concurrent capability/localization/docs work preserved.
- Current CONTRIBUTING, source, both nearest tests and callers read; historical F68 retained. Node v26.13.0, pnpm11.23.0, TypeScript7.0.2, Vitest5.0.5/V8 coverage, tsc typecheck/build, Biome2.5.14/formatter disabled; root/server manifests and vitest config inspected. No race/sanitizer configured.
- Invariants: successful acquisition owns an exclusive lock; failed contenders preserve another holder's file; release is idempotent and refuses a replacement token; heartbeats update the held inode; ordinary probe errors propagate. Current lease design explicitly documents a residual fresh-lock displacement window, which is not resolved or claimed safe by passing nearest tests.

## Round 8 — cross-process lock review
### Summary
No new confirmed finding or patch. Existing nine tests pass; this is bounded evidence, not proof that the documented residual stale-takeover window is eliminated.
### Toolchain
Current toolchain recorded in setup above; no installation or config changes.
### Findings
None new. Historical F68 unchanged.
### Not reproduced (dropped)
No executable new failing candidate was produced within this bounded pass. Token-preserving release, fresh replacement, genuine stale recovery, contention and real-child crash recovery are exercised by nearest tests.
### Validation
- Focused/scope: pnpm --dir apps/server exec vitest run test/lib/crossProcessLock.test.ts test/lib/crossProcessLock-r314.test.ts --coverage=false: 9 passed/2 files (round8_lock_tests.log).
- Build/typecheck: NOT RUN fresh, no source/type changes; preceding round build/typecheck passed.
- Format/lint: pnpm exec biome lint with the three scope paths: 3 checked/no fixes; formatter disabled.
- git diff --check with the three paths: exit 0.
- NOT RUN: full coverage/release, filesystem fault injection across every mutation, proof/fix of the documented residual lease-steal window, Linux/macOS filesystem semantics.
### Boundaries
Existing tests include real-timer waits and a real child process. No new sleep-based race verifier added; no newly verified race-fix claim. A subsequent read-only command used the wrong S3 build-cache path and failed to read it; corrected by discovered path, unrelated to lock validation.
### Working tree
Scope source/tests unchanged; pre-existing concurrent work retained. Evidence only, no product commit for this round.
### Next scope (if rounds continue)
apps/server/src/kernel/drivers/s3BuildCache.ts and apps/server/test/kernel/s3BuildCache.test.ts — exact restoration and failed-cache cleanup.
