## Round81 — manifest digest response validation
### Summary
Scope confirmed: apps/server/src/lib/imageWatch.ts, nearest apps/server/test/lib/imageWatch.test.ts and new apps/server/test/lib/imageWatchDigest.test.ts. autoUpdate.ts/nearestsweep tests/schema/OCI protocol docs read-only. Main dff9710b, round81_status_before.txt clean. Same repo/scoped instructions/toolchain, no installs.
### Toolchain
Node26.13.0/Vitest5.0.5/native libsql and nativeResponse/Headers/ReadableStream fixtures; DNS/fetch at existing seam, no realregistry requests. PrimaryOCI descriptor/distribution specs consulted to distinguish manifestdigest identifiers from localsha256imageIDs.
### Invariants
A successful manifest probe returns a syntactically valid digest rather than any nonemptyheader; malformedHTTP metadata cannot seed or advance autoUpdatebaseline/enqueue. Preserve valid registered/opaque digest forms per protocol and release/cancel responsebody on every outcome. No content-integrity verification is inferred from syntax alone.
### Findings
Pending supportedgrammar research and runnablebeforeproof; no sourcepatch. Docker localimageIDsha256 schemas are not assumed to constrain OCI manifestdigestalgorithms.
### Boundaries
NativeSQLite/HTTPseam/protocolsyntax only; no live registry trust, bodyhash verification, livepull/deploy or securitybypass claim.

PrimaryOCI descriptor grammar: lowercase algorithmcomponents separated by +._-, nonempty base64url-like encoding; unknownalgorithms SHOULD pass syntaxvalidation. Registeredsha256/blake3 require64lowerhex, sha512128lowerhex. DistributionGET usesdigestheader and separatelyrequiresbody verification whenused; syntax-only scope does not claim bodyintegrity. Potentialbody/header mismatch is a future separate candidate, not partofthispatch. Sources https://github.com/opencontainers/image-spec/blob/main/descriptor.md#digests and https://github.com/opencontainers/distribution-spec/blob/main/spec.md#pulling-manifests read via officialGitHub connector, no externalcode copied. Exactdefaultproducer+consumer beforeproof now runs againstunchangedsource.

#### F1101 — input-handling — Medium — malformed registry metadata seeds baseline and schedules work
Root cause beforeedit: fetchImageDigest checks onlyHTTPsuccess/nonemptyheader, although its contract throws on nondigests. Defaultproducer+actualsweep/nativeSQLite with anoperator-owned validtag service and unchangedresponsebody acceptedsha256:proxy-error-a/b, persistedbadbaseline and inserted1scheduleddeployment. ValidunchangedSHA256control storedonce/noqueue. Before F1101_before.log:1failed/1controlpassed, PROBLEM CONFIRMED, round81_before_exit.txt1. Medium: malformedupstreammetadata creates unnecessary deploywork; no live rollout/securityclaim. Narrowpatch validatesOCIgrammar and registeredsha256/sha512/blake3 encodings before returning, preservesgrammar-validopaquealgorithms (comparison only), retainsbodycancel/status/tokenflow. No publicschema/config/wire/dependencychange. Bodydigestverification is a separate unproven candidate for nextscope, not claimed by thisfix.

### Verification
Original after2/2passed, malformedheaders PROBLEM NOT REPRODUCED. Independent32cases repeated3times FIX VERIFIED, nativeResponse/Headers/ReadableStream cancellation and realSQLite defaultproducer/sweep. Coversregisteredsha256/sha512/blake3 encoding, grammar-validopaqueextensions/constructorname,19malformedforms, credentialed401tokenretryfinalmanifestvalidation, HTTP500status, failingcancel/no rawheader echo, unchangedbaseline, malformedbaselinepreservation, validmove enqueue. Permanentlib/imageWatchDigest.test.ts seenred23failed/9controls under exactguardedoldsource; repairedsource restoredafter no-driftcheck.
### Validation
Nearestscope newimageWatchDigest,imageWatch,autoUpdate,autoUpdateEnqueueRace,autoUpdateDigestRace,imageRefValidation,imageRefHostValidation,autoUpdateLifecycle,plugins/autoUpdateScheduler,autoUpdateSchedulerRace:153tests/10files passed. GOMAXPROCS4 server typecheck/build passed. Configured Biomecheck3changedTSfiles clean, git diff --check passed. Existing imageWatch happyfixtures used malformed shortdigest labels; replacedonly those with Nodecrypto-derived validSHA256 identifiers. Productioncaller search finds scheduler using defaultprobe, no injectedproductionprobe bypass.
### Boundaries
Syntaxvalidation only; no manifestbodyhash/contenttrust verification, livepull/rollout/exfiltration claim. RealSQLite job insertion demonstratedbefore, no worker/deploymentexecuted. Unknownalgorithms remainopaque on purpose perOCIvalidationguidance. Newunit mocks DNS/fetch/audit only; nativeHTTPbodyobjects/cryptovalues/DBactual. Fullserver/rootrelease/coverage/nativeMac NOT RUN, R73 nativeworkerfault unresolved.
### Not reproduced (dropped)
No SHA256-only restriction: localimageIDschema isnotmanifestdigestalgorithm policy; validregisteredandopaqueforms intentionallypreserved.
### Working tree
Setupclean; only scopedproducer/nearestfixtures/newregression/docs/changelog/evidence selected.
### Next scope
Manifestbody/header integrity: establish a separate runnable beforeproof before considering boundedbodyverification or any supportedalgorithm change.

First preflight stopped after owned staging/indexnote on Windows writeFileSync UNKNOWN/open while mirroring CHANGELOGworkingfile. Inspection confirmed correctcachednote, workingfile unchanged (only missingownnote), no commit/push. Retain F1101_preflight_failure.log; retry idempotentguardedprepare after inspecting partialstate. Not a productfinding or passedpreflight.

Preflight retry passed21exactownedstagedpaths, cached diff and limitedstagedpatternscan. Workingchangelog mirror nowcorrect; publisher avoids redundant rewrite when currentworkingbytesalready equaldesirednote, preserving optimistic no-drift check. No securityaudit/fullcertification implied. SelectedHEAD/remote verification followsguardedreceipt.
