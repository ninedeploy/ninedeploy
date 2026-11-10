## Round79 — malformed image reference probes
### Summary
Scope confirmed: apps/server/src/lib/imageRef.ts, nearest/new unit/native reference tests; imageWatch.ts/autoUpdate.ts/schema read-only to prove caller behavior. Main1420048c, round79_status_before.txt clean; root/scoped instructions/toolchain unchanged. Existing parser and watch tests read first, no installs.
### Toolchain
Node26.13.0/Vitest5.0.5/nativeDockerCLI29.9.3. Native oracle uses controlledloopbackdaemon/privatefixtureconfigs; actualschema acceptance+parser+imageWatch probe uses mocked DNS/publicaddress/globalfetch and nativeURL normalization. No realregistry outbound calls or private-network security claim.
### Invariants
A structurally invalid repository/tag rejected by DockerCLI must be skipped by the watch parser. A valid tag probe must remain a v2 manifest request; malformed dot/empty/path components and invalid tags must not be interpreted as a moving image. Preserve accepted separators and boundary tags. Scope does not promise full Dockerreference validation beyond proved input classes.
### Findings
Pending freshnativeCLI matrix and exact beforeproofs; no production patch.
### Boundaries
Fake manifest responses prove source probe dispatch/URL construction only, not a live SSRF/auth bypass, realpull, persisteddeployment or liveupdate result.

#### F1097 — input-handling — Low — malformed repository components dispatch invalid probes
Root cause before edit: repository regex permits arbitrary dots/slashes/punctuation placement rather than nonempty valid name components. FreshDockerCLI oracle rejects7cases while createService accepts; parser+actualimageWatch/egressGuard with mockedpublicDNS/fetch dispatch them, including normalizedhttps://ghcr.io/outside/manifests/v1 fromacme/../../outside. Before prove_F1097_imageRepository:7failed/1validseparatorcontrolpassed. PROBLEM CONFIRMED, combinedexit1. Low: invalidconfig causes unintended/nonmanifestprobes; no liveSSRF/authbypass claim.
#### F1098 — input-handling — Low — malformed tag syntax and length dispatch invalid probes
Root cause before edit: tagregex accepts leadingdot/dash and unboundedlength. FreshCLI rejects ..,-bad,.bad,129chars while128 andunderscorestart pass; parserprobe currentlydispatchesall, including parentpathnormalization for ... Before prove_F1098_imageTag:4failed/2boundarycontrols passed, PROBLEM CONFIRMED, combinedexit1. Lowfunctional/inputvalidation, no liveattackor update/deployclaim.
Patch plan: validate eachrepositorycomponent with native-verified separators and alphanumeric ends; tag startswordchar and length1..128. No appinputschema/wire/persistedformat/dependency/egressguard change; only watch acceptance of these proven malformedclasses changes. Rootinvalidrun totals11failed/3controls.

Verifier harness correction: expandednative matrix generator initially emitted missing whitespace (ofcases), syntaxfailed before anyDockerfixture ran. Invalid output retained round79_dockerValidation_invalidExpansion.log, not counted as verification. Corrected exactowned script and regenerateCLIoracle before verifier.

### Verification
Original after14/14passed, all candidates PROBLEM NOT REPRODUCED. Expanded freshnativeCLI corpus26cases:16repository/10tag, accepted separator variants, nesting, underscore/digit tag starts,128boundary and129rejection. Separate verifiers26cases across2files repeated3times FIX VERIFIED; malformedcases dispatch neither DNSlookup norfetch; validURLs matchnativeAPI normalizedrepository/tag metadata. NativeURL normalization for tagtwo dots (..) removes the manifests path segment; no other origin involved. Permanentunit and nativeintegration both seenred13failed/13controls under exact guarded oldsource, then repairedsource restored after no-drift comparison. Two Low inputhandling findings promoted despite not being mandatory.
### Validation
Nearestscope imageRefValidation,registryHostClassification,imageRef,imageWatch,autoUpdate,autoUpdateEnqueueRace,autoUpdateDigestRace,tenancyIsolation,registryCredentialLogout:106tests/9files passed. GOMAXPROCS4 server typecheck/build passed. Initialconfiguredlint one template-styleinfo corrected in ownednativefixture, finalcheck/native3runs follow. git diff --check passed. No newdependency/racedetector. Fullserver/rootrelease/coverage/live/nativeMac NOT RUN; R73 nativeworkerfault unresolved.
### Boundaries
Only repositorycomponent grammar and tagprefix/length are certified here; not a complete Dockerreference validator (for example totalname/registryhost grammar not newly certified). API createService schema staysunchanged; malformedconfiguredimages are skipped by watch. Fetch/DNS seam proves source dispatch/normalizedURL, not a realnetworkattack, credentialexfiltration, livepull, liveupdate or persisteddeployment result.
### Not reproduced (dropped)
None among the two proven classes.
### Working tree
Setupclean, only imageRef source/newunit+native/docs/changelog/ownevidence selected.
### Next scope
Registry-host syntax and total reference length versus nativeCLI, without widening acceptance or egress policy absent proof.

Final native integration corpus26/26 passed three times on current bytes; final configuredlint3files clean and git diff --check passed. Template-only harness style correction retained exact behavior.

Publication preflight:35exact owned staged paths; both F1097/F1098 notes staged in Unreleased Fixed from HEAD and mirrored only into owned working notes; cached diff/limited staged-pattern scan passed. No full security audit. Guarded selected HEAD/remote checks follow receipt.
