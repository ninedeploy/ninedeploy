## Round80 — watch registry-host grammar and normalized name bounds
### Summary
Scope confirmed: apps/server/src/lib/imageRef.ts and new/nearest unit/native reference tests; schemas/imageWatch/egress/callers read-only. Main921ebcd9, round80_status_before.txt clean. Read current parser after79 and existing native CLI harness before candidates. Same repository/scoped instructions/toolchain, no install.
### Toolchain
Node26.13.0/Vitest5.0.5/DockerCLI29.9.3, controlledloopbackdaemon/privatefakeconfigs. NativeCLI validates grammar/boundaries, actualappschema acceptance required. Sourceprobe effects use publicDNS/fetch seams, no liveoutboundrequests.
### Invariants
Malformed registry text must not become a different request path/query; valid DNS/port/bracketedIPv6/case references keep their parsed fields. A reference name rejected for Docker's normalized-name bound must not be treated as a moving tag. Do not infer grammar from URL alone or reject CLI-valid edge syntax without evidence. Preserve digestskip/repository/tag fixes and egresspolicy.
### Findings
Pending native matrix, no source patch.
### Boundaries
No realpull/networkattack/liveupdate, privatecredentials/globalDockerconfig or new publicAPI/schema restriction claimed.

Initial total-name255 hypothesis dropped: CLI accepts full name lengths258/259; no patch from that assumption. Read-only actual localDockerEngine29.9.3 imageinspect (knownnpipeendpoint, explicitprivateconfig, no pulls/containers/writes) distinguished validmissingrefs from repository-name>255 errors. Revised native matrix measures repository path, including officialHub libraryprefix for bareimages, at255/256. CLI reference args now use -- so a leadingdash is not mistaken for a flag. No usercredential/config modification or remoteendpoint contact.

Nativeactual boundary update: localEngine readonlyimageinspect at repositorylength254/255 returnsNoSuchImage (validmissingreference),256returnsrepositoryname>255. FreshCLI controlleddaemon matrix likewise rejects repository256 acrosscustomhost/Hubaliases/uppercase/IPv6 and bareofficiallibrarynormalization, accepts255. Hostmatrix includesnative-valid numericport99999 and publicIPv6; newgrammar mustpreserve those even if anHTTPtransport later rejects a port. Planned totalname255 cap remainsdropped; revisedcandidate is normalizedrepositorypath255. Source unchanged before exactproof.

#### F1099 — input-handling — Low — malformed registry text changes probe URI semantics
Root cause before edit: extracted registry has no grammar check, so query/fragment/backslash text rejected by nativeCLI survives parser and forms a nonmanifest URL. Exactsourceproof3failed/1ordinaryhostcontrolpassed, PROBLEM CONFIRMED, includinghttps://ghcr.io/?fixture=1/v2/web/manifests/v1 andhttps://ghcr.io/extra/v2/web/manifests/v1. No liveSSRF/originescape claim; sourceprobe uses publicDNS/fetch seam.
#### F1100 — input-handling — Low — overlong normalized repository path still probes
Root cause before edit: no repositorylengthcheck. ActuallocalEngine readonlyimageinspect and CLI both accept repository255 and reject256; exactsourceproof shows repository256stilldispatches1probe.1failed/1boundarycontrolpassed, PROBLEM CONFIRMED. Initialtotal-name255assumption wasdropped; cap is normalizedrepositorypath255, ASCII aftercomponentgrammar.
Patch plan beforeedit: add Docker-native DNS/port/bracketedIPv6 host grammar without URL-port-range restrictions; apply255repositorypathcap accounting only default/legacyIndex librarynormalization, retain existing HTTPHubaliasbehavior. No appinputschema/wire/dependency/egresspolicy changes. Combinedbefore4failed/2controls exit1.

Compatibility refinement: firstexpandedverifier41passed/1failed because nativeCLI acceptedfoo_bar.example while initialdomainregex rejected it. Read-only actuallocalEngineinspect confirmed validmissingref (NoSuchImage), while trailingunderscore registry_.example and mappedIPv6 dottedform are invalidreferenceformat. Preserve internalunderscore with alphanumericlabelends; brackethex-colon syntax remains aligned with nativeCLI, not fullIPv6semanticvalidation. Failedverifier retained, not accepted. No source-cause claim from a fixture error.

Promotion paths resolved: apps/server/test/lib/imageRefHostValidation.test.ts (44cases:42nativecorpus+2actualsourceprobecontrols), integration/imageReferenceHostValidation.test.ts (42nativeCLIcases). No permanenttest depends on .temp oracle logs or actual Engine; the Engine evidence is retained as a separate readonly acceptance corroboration. Source helper syntax/format does not claim DNS/IP/port reachability. Existing registry-1 HTTP library alias expansion preserved independently of native input-length accounting.

### Verification
Originalafter6/6passed, allcandidates PROBLEM NOT REPRODUCED. Revised repositorypathbound corroborated by actuallocalEngine29.9.3 readonlyimageinspect255validmissing/256formaterror plusCLIpullparseroracle. Independent42cases across2verifiers passed3cleanruns after internalunderscorecompatrefinement, FIX VERIFIED; validcases assert parseracceptance only (transport maystillrefuse), invalidcases dispatchnoDNS/fetch/error. Permanentunit44cases seenred22failed/22controls; nativeintegration42seenred22failed/20controls under exactguardedoldsource, repairedsource restoredafter no-driftcheck. NativecorpusincludesDNS/case/underscore,arbitrarynumericport,brackethexcolon,invaliddelimiters,255/256 acrosscustom/Hubaliases/IPv6/bareofficial libraryprefix. BothLowfindings promoted.
### Validation
Nearestscope imageRefHostValidation,imageRefValidation,registryHostClassification,imageRef,imageWatch,autoUpdate,autoUpdateEnqueueRace,autoUpdateDigestRace,tenancyIsolation,registryCredentialLogout:150tests/10files passed. GOMAXPROCS4 server typecheck/build passed. Initialconfiguredlint one template-styleinfo corrected in ownedunitfixture; finalnative3runs/lint follow. git diff --check passed. Fullserver/rootrelease/coverage/livepull/nativeMac NOT RUN; R73 nativeworkerfault unresolved.
### Boundaries
Only sourcewatchreference grammar/bounds. Not DNS/IP/port reachability validation: nativevalidsyntax99999port/[:::] is retained, downstreamprobe canrefuse. Existing registry-1 HTTPHubalias libraryexpansion retained, but formatbudget counts nativeinput repository. ActualEngineusedGETimageinspect/GETversion overknownlocalnamedpipe withprivatefixtureconfig; no pulls or Dockerimage/container/config mutations, no remoteendpoint byagent, no realcredential emission. Otherprobes used controlledAPI/fetch/DNS seams, not liveSSRF/privatepull/exfiltration/deployment proof.
### Not reproduced (dropped)
Totalreference-name255cap hypothesis dropped; actuallimit is repositorypath255 afterofficialHubnamespace normalization. No arbitraryfull-length cap added.
### Working tree
Setupclean; only scopedimageRefsource/newunit+native/docs/changelog/evidence selected. Two exec calls failedCreateProcessAccessDenied beforelaunch, identicalretry succeeded without partialmutation; no productfinding from that.
### Next scope
imageWatch manifest digest response validation before autoUpdatebaseline/enqueue; use native-valid digest controls and exactcaller effects before any patch.

Final native CLI42/42passed three times; finalunit44/44passed after style-only correction; configuredlint3files clean; git diff --check passed. No realEngine writes/pulls performed.

Publication preflight:44exact owned staged paths, F1099/F1100notes in Unreleased Fixed from HEAD, cached diff and limited staged-pattern scan passed. No full security audit. Guarded selected HEAD/remote verification follows receipt.
