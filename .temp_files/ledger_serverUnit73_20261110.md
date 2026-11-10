## Round 73 — full configured server unit-suite evidence
### Summary
Scope confirmed: apps/server/test/**/*.test.ts using apps/server/vitest.config.ts, server package script/config read-only. Source patch scope remains empty until a runnable current-source failure is independently confirmed. Existing main 1129f4c5d5a590a291db5561cd2dcd7b5923fdb0; setup status clean. CONTRIBUTING requires broad guard visibility. Continuous scope/commit authorization retained.
### Toolchain
Node26.13.0/pnpm11.23.0/Vitest5.0.5; server config fileParallelism=false, testTimeout/hookTimeout30000, excludes integration/diag/dist/node_modules, per-invocation mkdtemp data directory. No installs. Command: GOMAXPROCS4 pnpm --dir apps/server exec vitest run --coverage=false --maxWorkers=1 --reporter=verbose. Coverage intentionally disabled to collect unit/guard behavior without overwriting shared coverage output or touching any existing coverage lock.
### Invariants
Preserve configured timeouts/exclusions. Do not interpret incomplete or environment-contaminated runs as passed or as product findings. No release/root/coverage/live/nativeMac certification inferred. Save complete output, exit code, baseline and ending HEAD/status.
### Findings
Pending full configured unit-suite run. No new bug ID allocated.
### Boundaries
Serial resource-bound unit execution only, no integration/diag/live Docker certification. No source edits or shared daemon/lock cleanup authorized by this setup.

### Run setup details
Tracked .test.ts files matching configured inclusion/exclusions: 833 (round73_expected_files.txt). GOMAXPROCS4 only bounds native Go compiler helpers; maxWorkers1 and config fileParallelismfalse serialize this unit run. No production patch during broad run; captured log remains authoritative for actual reached files/count.

### Broad run result — FAILED
round73_server_exit.txt:1. Full log:832 passed files of833;13934 passed tests,2skipped of13945;1unhandled worker error;duration2290.16s. nodeIdleScheduler.test.ts completed15cases then worker native exit3221225477 (0xC0000005) in started state. No assertion failure reported. Initial progress counts were partial line counts, not suite acceptance. Source endingHEAD1129f4c5 matches baseline; git status clean. Cause currently unknown; neither environment nor product classification inferred. No patch from this unhandled crash. Isolate exact file under unchanged timeouts/pool/config next,3serial runs.

### Isolation / native lifecycle investigation
Unchanged exact-file isolated1 reproduced native3221225477 after14/24 (exit1). Two single-case controls (late opening shutdown, slow-service lease) each1passed/23skipped. Isolated2 then24/24passed; five serial repeat logs each24/24passed. Existing fixture calls client.close() after scheduler close/engine cleanup; no missing close patch justified. Installed native libsql0.5.29. Plain Node control50 createDb/ready/runMigrations/read/finallyclose cycles passed; same50cycles with --expose-gc/forcedGC passed; bothprocess exits0. This does not reproduce or locate a native root cause. Upstream issue231 is open and describes similar Windows0xC0000005 with libsql0.5.29, but uses shared-cache URL/concurrent processes/process teardown while ours crashed mid-file serially; correlation only, NOT accepted as current cause. Related issues228/230 report statement finalization/FD concerns, not independently reproduced here. URLs https://github.com/tursodatabase/libsql-js/issues/231 /228 /230 inspected read-only; no external messages/issues posted. Historical memory pointed to native client ownership checks; current code closes its fixture client and original historical cause is not assumed.

### Bounded full retry
Six complete exact-file passes (isolated2 plus repeat1..5) do not erase first broad failure or isolated1 failure. Upstream issue231 comments include reports with file-backed DBs, explicit close, @libsql/client0.18.0 and Vitest5; still no local native stack/cause. No dependency upgrade, fixture rewrite or timeout/pool workaround applied. One whole-suite retry authorized as verification of unresolved native failure, same sourceHEAD1129f4c5, same config/pool/timeouts, coveragefalse,maxWorkers1. Firstfailedlog retained; a passing retry would not certify the intermittent native fault fixed.

### Retry invalidated by long tool/session pause
A clock.sleep45000 call returned elapsed24105.2439seconds (about6h42m); source of pause not proven. On resuming at2026-11-10T10:22+02:00 retry log had only~54files reached/3111passedlines, no assertionfailures, but two worker-termination timeouts (compose/accessGrantsEquivalence). Retry is NOT a clean verification and was terminated to avoid spending another broad run on contaminated timing. Exact owned runnerPID87292, creation03:23:07, workspace/vitestcommand and descendants rechecked before Stop-Process; selected identities recorded round73_retry_terminated_owned.txt. No unrelated process, daemon or coverage lock touched. Preserve incomplete log and termination exit; do not infer host sleep or native cause from the observed tool pause. First broad run remains FAILED832files/13934passed/2skips/nativeerror. Six focused24/24passes do not replace full acceptance.

### Findings / dropped
No new defect ID confirmed or production patch. Native root cause unlocated; client-leak hypothesis not established because fixture closes each client and plain lifecycle controls passed. Similar upstream reports are context only. No retry/skip/dependency workaround added to product/test configuration.
### Validation
Full configured suite FAILED exit1:832/833files,13934passed/2skips/1nativeerror,2290.16s. Exact file initiallyFAILEDnative, then6complete24/24passes;2individualcasecontrols passed. Native lifecycle50normal+50forcedGC exited0. Whole-suite retry INCOMPLETE/INVALID afterlongpause/workerterminationtimeouts; terminatedownedrunner, exit-1. Build/typecheck/lint NOT RERUN: no production or permanent test changes in this evidence-only scope; priorR72 source validation retained. Node --check two own mjs helpers and git diff --check follow. Full root/release/coverage/live/nativeMac NOT RUN.
### Working tree
Starting and prepublication status clean for tracked production files. Only round73 evidence/ledger/Mac handoff note selected; draft round74 proof/ledger remain separate.
### Next scope
Cross-process lock identity short-write handling, queued round74 draft; execute beforeproof only after broad runner stopped.

Evidence preflight:33exact owned staged paths, cached diff check, own mjs syntax checks and limited staged-pattern scan passed. No complete security scan inferred. No production patch or success claim; selected HEAD/remote verification follows guarded receipt.
