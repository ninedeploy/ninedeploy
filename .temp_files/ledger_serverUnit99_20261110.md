# Round 99 — Configured full server unit-suite retry (prepared, not started)
## Setup and scope
Scope confirmed: apps/server/test/**/*.test.ts under apps/server/vitest.config.ts; read-only evidence collection, no production patch or new finding ID. CONTRIBUTING and actual Vitest config reread. Node26.13.0/pnpm11.23.0/Vitest5.0.5, fileParallelismfalse, maxWorkers1, existing30sec test/hook timeouts. Same bounded command as R73: GOMAXPROCS4 pnpm --dir apps/server exec vitest run --coverage=false --maxWorkers=1 --reporter=verbose. Coverage disabled to avoid shared coverage outputs/locks, not a coverage certification. Integration/diag/native live engine excluded as configured.
## Reason and boundaries
R73 original native0xC0000005 failure remains unresolved; later six focused passes did not erase it. Subsequent proven native fixture ownership repairs (R87) and source changes justify a fresh complete verification, without assuming they fixed that crash. No timeout/pool/skip/dependency workaround. Start only after R98 hosted artifact/receipt is finalized and working tree clean. Freeze tracked source/tests/commits during the full run; owned ignored evidence may grow. Capture source HEAD, expected test files, command/PIDs/starttime, full output, exit status, ending HEAD/status. A passing retry is evidence for this snapshot, not a native root-cause fix or full release certification. Root/SDK/Desktop/coverage/live production remain outside this invocation. No shared process/daemon/lock cleanup.
## State
Runner prepared and node syntax check passed. NOT STARTED pending R98 native receipt. Do not overwrite or launch duplicate runs once round99_server_started.json exists. No code verdict yet.

## Prepared environment evidence
Configured preview854trackedunitfiles under current source. Actualdependencyfiles/Node resolution confirm @libsql/client0.18.0/native libsql0.5.29, win32x64 Node26.13.0 (round99_native_runtime.json); no upgrade or assumption of fix. pnpmdependencyinventory saved separately. R73samecommand/options inspected, prior failure preserved. StillNOTSTARTED untilR98receiptpublication.

## Starting current snapshot
R98native562-testreceipt completed and pushed as e656bbd6e2e322d07aec825c629d81c93a6ad165. Trackedworkingtreeclean. Fullconfiguredunitrunstartingnow onthisexactHEAD with854expectedfiles, unchangedconfig/timeouts/pool, no coverage/sharedlockwrites. Productsource/tests/commits frozenuntilresult; onlyownignoredevidence allowed. No new finding or acceptance claim.

## Read-only upstream refresh during run
Official GitHub issue libsql-js231 remainsopen(updated2026-10-19), threecomments; officialcorePRlibsql2261 merged asd9f2f7d88823207556a2b9cfa3d766ef528538c2, addressingnativehandle doubleclose. Recorded metadata/paraphrase only in round99_upstream_refresh.json. Community experiments are not localproof. Installedbindingfixpresence and identitywithourR73crash notdemonstrated; no dependencyupgrade/nativepatch/retry/exitworkaround applied. Fullrun unchanged. SeparateR100Macfullworkflowdraft prepared only underignoredevidence, not installed/executed.

## Complete full-unit result — FAILED (one stale fixture)
Exactsourcee656bbd6, runnerexit1,853passedfiles/1failedfile of854;14268passedtests/1failed/2skipped of14271. Vitest2426.76sec, wrapper2429.523sec. Onlyfailedassertion: tenancyIsolation r514 LANregistry mockheader sha256:new/missingbody producedenqueued0/skipped2 instead1/1. Allconfiguredfilescompleted, no unhandlednativeworkererror reported. OriginalnodeIdleScheduler24cases passed inthisrun; R73nativefaultnotreproduced here, rootcause NOTfixed oridentified. EndingHEADsame/workingtreeclean, filesystemselectionmatched854trackedfiles exactly. Fullrunlog/resultmetadata retained. This isNOTa passedunitgate/coverage/rootreleasecertification. Repair missedF1101/F1102fixture underR101 next, preserveproductdigest/bodychecks.

## Concurrent hosted evidence boundary
CI42836023433 exactsamee656source: typecheck/lint/build passed, integrationjob129898487417 passed99tests/14files withrealDocker/PostgreSQL. Decodedlog/provenance/resultlines saved usingGitHubconnector afterghCLI refusedlogs whileoverallrunactive. OtherCItest/imagejobs pendingatlastsnapshot; no generalCI successclaim. RootWindowsunitfailureabove remainsauthoritative.

## Evidence publication preflight
29ownedpaths/expectednormalizedindexblobs/diffcheck/limitedcredentialpatternscanpassed. Fullresultsummary validated againstlog; originalcaptured and normalized SHA256 retainedforfullunit/completedintegrationlogs. No fullunitpassclaim; localcommit first, groupedpushaftervalidated follow-ups.
