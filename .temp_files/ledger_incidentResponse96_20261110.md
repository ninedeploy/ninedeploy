# Round 96 — Incident delivery response ownership
## Setup/scope
Scope confirmed: apps/server/src/lib/incidentChannels.ts successful PagerDuty/Opsgenie response lifecycle and new test/lib/incidentResponse.test.ts if confirmed. Mainc0be1bd032abd6139f8a97e1707837e12d9190f7 clean, round96_status_before.txt. R95 Macrun42832031978 independent; no producer edit until its receipt checks close. CONTRIBUTING/manifests read R93, existing Node26/pnpm11/TS7/Vitest5/Biome2.5. Nearest notifierG37.test.ts and actual egressGuard dispatcher-close policy inspected. No install/newdependency/racedetector.
## Invariants/candidate
Unused success bodies must be released; error bodies must retain provider details. Current errorDetail consumes text on failure, success returns with body ignored. Existing10sec abort bounds retention. Native owned loopback streaming proof and unaffected error control pending; no confirmed ID yet.

## F1117 — resource-leak — Medium — incident success bodies ignored
Before proof F1117_before.log2failed/1errorcontrolpassed; actualnativeHTTP202partialJSON bodycancelled0/bodyUsedfalse for BOTH PagerDuty and Opsgenie. EXPECTED cancellationbefore sendreturns; error403 control alreadyconsumesbody andpreservesdiagnostic. Rootcause before patch: senders return after res.ok without disposingunusedsuccessbody; guardedFetch dispatcherclose waits forbodydisposal. Existing10sec timeout bounds retention, no indefinitelyleaked socket/liveproviderfailureclaim. Narrowfix adds successbodycancel after existingerrorbranch, ignorescancelrejections without altering providerdetails, endpoints orpayloaddata. Productionedit waitsforR95native receipt identity.

## Verification and validation
Originalafter3passed/PROBLEM NOT REPRODUCED forbothsenders. Permanent14cases red8failed/6controls priorpatch, promoted test/lib/incidentResponse.test.ts. Independentverifieroriginal3+permanent14 passed3consecutive/FIX VERIFIED. ActualnativeHTTP202body cancellation waits explicit serverclose event, no sleep. Trigger/resolve,US/EU,testincidentopen-close,bodylesssuccess,cancelrejection and403diagnostic controls passed. Scope26tests/2files passed. GOMAXPROCS4servertypecheck/buildexit0, scopedBiome2files nofixes, workflowYAML/manual/read-only/pinnedactions/Bashvalid, diffcheckpassed. Two productioncancel lines only, no dependency/API/schema/endpoint/payload changes. Errorbodyhandlingunchanged. No realvendorcalls/incidents/livecredentials/egresspolicy/fullreleaseclaim; retentionwas10sec-bounded. R73nativeworkerfaultstillunresolved. R95native383-testreceipt published at22d0363c before produceredit.

## Publication preflight
29ownedpaths staged; exactnormalizedexpectedblobs/indexdiff/limitedcredentialpatternscanpassed. No unrelatedworkstaged.

## Native Mac follow-up
Run42832976904 exact8895be6132dd13f9e9b9550fa5691d34d1b30ee7 successfulonmacOS26.7.2arm64. Server385/31files,CLI20/4files,MCP4/1file=409passed/36files. Frozeninstall/build/typecheckpassed. Ten diagnosticssource/eventSHAchecked, original+normalized SHA256 recorded in round96_receipt.json. ZIPdigest metadata notindependentlyverified. Backendidentityunchanged for evidencepublication; fullrootrelease/R73notcertified.
