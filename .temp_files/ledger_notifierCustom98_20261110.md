# Round 98 — Notification custom-response ownership (exploration)
## Setup/scope
Scope confirmed: apps/server/src/lib/notifier.ts sendTeams/sendResend success and sendLark HTTP-failure bodies, plus test/lib/notifierCustomResponse.test.ts if proof confirms. Main73fecd8a1a8d8b12ba8afbd31f85ce3195521bba clean; round98_status_before.txt. R97nativeMac run is independent. No producer edits until R97receipt identity closes. Existing Node26/pnpm11/TS7/Vitest5/Biome2.5 and CONTRIBUTING read R93; nearest notifier.test.ts/customresponsebranches read. No dependency/install/racedetector.
## Invariants
Dispose unused responses but preserve Teams text diagnostics, Resend JSON diagnostics and Lark semantic JSON status. Native loopback source-before proof pending. Existing timeout bounds retention; no indefinite leak/livevendorfailure claim. This scope was excluded from F1118 to retain body semantics explicitly.

## F1119 — resource-leak — Medium — custom delivery unused bodies
Before F1119_before.log3failed/3controls: nativeTeams201,Resend201 andLark503 allsettlewithcancelled0; nativeownedHTTPstreams helduntilprooffinally. LarksemanticJSONsuccess,Teams403textdetail,Resend403JSONdetail controlsconsumeandpass. Rootcausebeforepatch: successendofTeams/Resend ignoresbody, LarkHTTPerror throwsbeforeconsumption. Narrowfix cancelsunusedTeams/Resendsuccess AFTERdiagnosticbranches andcancelsLarkHTTPfailure BEFOREthrow; mustleaveLarkJSONsemanticsunchanged. Existingtimeoutboundsresourcepressure, noindefiniteleak/livevendornotificationclaim. ProducereditwaitsR97receiptidentity.

## Verification and validation
Originalafter6passed/PROBLEM NOT REPRODUCED. Permanent13cases capturedred3failed/10controls beforepatch; promoted test/lib/notifierCustomResponse.test.ts. Verifieroriginal6+permanent13passed3consecutive/FIX VERIFIED. NativeownedHTTP streamingusesexplicitresponseclosebarriers,no sleeps; allnativefixturesfinallyclosed. Teams/Resenddiagnostics,LarkbusinessrejectionJSON/bodylessresponse/cancelrejection controls passed. Fullnotification scope179tests/5filespassed. GOMAXPROCS4servertypecheck/buildexit0, configuredscopedBiome2filesnofixes; workflowmanual/read-only/pinnedactions/YAML/bashvalid; diffcheckpassed. Threeunusedbodypaths changed, existingsemanticdatareads preserved; no API/endpoint/auth/payload/schema/dependencychanges. R97native549-testreceipt published atfb769ff0 beforeproduceredit. No livevendor/credential/egresspolicy/fullrootreleaseclaim. Retentionwasboundedbyexistingtimeout; R73nativeworkerfaultstillunresolved. NewMacexpectation538server/34files plusCLI20/MCP4=562tests/39files,pendingactualrun.

## Publication preflight
29ownedpaths staged; exactnormalizedexpectedblobs/indexdiff/limitedcredentialpatternscanpassed. No unrelatedstagedwork.

## Native Mac follow-up
Run42835290267 exact328ba3fbfe3f34993326c6ffea22bf5925250df8 successfulonmacOS26.7.2arm64. Server538/34files,CLI20/4files,MCP4/1file=562passed/39files. Frozeninstall/build/typecheckpassed. Ten diagnosticssource/eventSHAchecked, original+normalized SHA256 recorded in round98_receipt.json. ZIPdigestmetadata notindependentlyverified. Backendidentityunchanged for evidencepublication; fullrootrelease/R73notcertified. Fullserverunitretry next at clean evidencecommit.
