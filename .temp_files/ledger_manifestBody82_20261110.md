## Round82 — manifest digest/body integrity
### Summary
Scope confirmed: apps/server/src/lib/imageWatch.ts, nearest imageWatch.test.ts/imageWatchDigest.test.ts and newlib/imageWatchIntegrity.test.ts. autoUpdate.ts remainsread-only unless exactproofrequirescallerchange. Maincc88e6ee, round82_status_before.txt clean. Existing producer/fixtures/caller read beforecandidate; same toolchain/instructions, no installs.
### Toolchain
Node26.13.0/Vitest5.0.5/nativeSQLite/Response/ReadableStream/createHash. DNS/fetch seams, actualoperator-ownedservice/defaultproducer/sweep. PrimaryOCI GETmanifest requirement and Distribution handler sizepolicy consulted. No new hash implementation/dependency.
### Invariants
A supported declaredhash must match returnedbytes before it can influence updatebaseline/queue. Verification must bound bodybytes and honor requestdeadline, release readers/cancel incomplete bodies. Validsyntax for unknownalgorithms is distinct from a verifiable digest; no bodyintegrity claim for algorithms not actually computed. Preserve SHA256/SHA512/hashencoding and auth/egress/CAS behavior.
### Findings
Pending exactsourcebeforeproof; no patch. Resourcebounds/supportpolicy must be made concrete from existing runtime/protocol before implementation.
### Boundaries
No live registry/networkattack/rollout/nativeMac or fullrelease claim. Previous81 providedsyntaxvalidation only; bodymismatch has not yetbeenconfirmed in thisround.
### Confirmed root cause — F1102 Medium
Current-source proof F1102_before.log exits1: one mismatch case fails, unchanged valid-body control passes. Two well-formed SHA256 headers for different bytes seed a false baseline and enqueue a scheduled deployment for an unchanged response body. fetchImageDigest cancels the body and trusts header syntax without computing its hash. Patch will verify SHA256/SHA512 incrementally; unsupported algorithms remain syntactically valid but cannot supply a verified watch digest. Bound streaming to4MiB (same size as Distribution maxManifestBodySize PUT policy, adopted locally; not a universal OCI limit), retain native fetch10sec signal, cancel incomplete reads and release reader locks. No JSON/schema validation claim.
### Neighbor fixture scope expansion
First11-file scope:153passed/14failed in two reference-validation suites whose success fixtures used empty bytes with a fabricated SHA256. No production reference parser changes. Scope expanded only to imageRefValidation.test.ts/imageRefHostValidation.test.ts fixture headers, now actual empty-body SHA256. Current regressions preserve their original URL/classification assertions.
### Initial validation
Original proof after:2passed, PROBLEM NOT REPRODUCED. Permanent integrity14cases seen red12failed/2controls on exact old imageWatch, restored only after no-drift check. First independent14case verifier passed3consecutive runs. Added15th explicit nativeHTTP/Nodefetch signal-abort test; no sleeps. Initial server GOMAXPROCS4typecheck/build and configured4fileBiome passed. Final rerun follows.
### Final verification
- Original before1failed/1control; after2passed/PROBLEM NOT REPRODUCED.
- Independent verify_F1102_manifestBody.mjs: original caller proof plus15independent integrity edges,17passed in each of3consecutive final runs, FIX VERIFIED. Includes nativeNodefetch over controlledloopbackHTTP with explicitdeadlineabort, not a live registry or elapsed10sec timing test.
- Permanent apps/server/test/lib/imageWatchIntegrity.test.ts initial14seenred12failed/2controls; final15passed. Body-byte integrity only, no schema/media-type validation.
- Finalscope11files168tests passed. Firstscope14fixturefailures retained and corrected only two fakeheaders; no parserproductionchange.
- GOMAXPROCS4 pnpm --dir apps/server typecheck/build exit0. Configured pnpm exec biome check --formatter-enabled=false sixchangedTSfiles passed. git diff --check exit0 (CRLFwarnings only). No newdependencies, rootcoverage/fullrelease/nativeMac NOT RUN; R73nativeworkerfailure unresolved.
- Supported SHA256/SHA512 retain returnedheaderidentity; opaque/BLAKE3 skip as unsupported, not invalidsyntax. 4MiB localcap is policy not OCIuniversalmaximum. Existing requestAbortSignal covers nativefetchbody; no unbounded streambuffering.
### Publication preflight:35owned stagedpaths; normalizedblob expectations, indexdiffcheck and limited stagedcredentialpatternscan passed. No unrelatedinitialdirtywork.
