## Round 72 — native database-import write completion
### Summary
Scope confirmed: apps/server/src/modules/databaseImports.ts and apps/server/test/modules/databaseImportShortWrite.test.ts. Existing main c66ec1cf; round72_status_before.txt clean. CONTRIBUTING reread; no nested agent instructions changed. Neighbor route/chunk tests read before candidate.
### Toolchain
Same installed Node26.13.0/pnpm11.23.0/TS7.0.2/Vitest5.0.5/Biome2.5.14 as package manifests and configured runners. fs/promises FileHandle.write typed bytesWritten in apps/server/node_modules/@types/node/fs/promises.d.ts:511. No dependencies added.
### Invariants
Only acknowledge the full requested chunk once all bytes have been written. The write promise can report bytesWritten independently of requested length. Native positional writes must advance both source offset and target position; zero progress must not spin or publish completion. Existing per-import FIFO remains owner until success/failure.
### Findings
Pending proof; source unchanged.
### Boundaries
Fault injected at real FileHandle seam, delegating actual partial bytes to native file IO. Not a claim about short-write frequency on this Windows filesystem or live restore corruption.

#### F1091 — bug — Medium — short native writes acknowledged as complete
Location: databaseImportRoutes chunk PUT, fh.write. Root cause recorded before patch: handler ignores bytesWritten and increments receivedBytes by requested body.length after a single successful call. Native partial-write injection persists exactly3 bytes but HTTP200 acknowledges10 and pending. Before F1091_before.log:1 failed/1 full-write control passed; PROBLEM CONFIRMED, exit1. Node official API corroborates actual bytesWritten result (https://github.com/nodejs/node/blob/main/doc/api/fs.md?plain=1). Patch: await successive writes with advancing buffer offset/target position until complete; zero progress throws and leaves metadata unchanged, finally closes handle. No API/schema change.

### Verification
Original proof after:2passed, PROBLEM NOT REPRODUCED. Independent8cases repeated three clean runs F1091_verify1/2/3.log, FIX VERIFIED. Covers1/3/9/10byte progress, variable2/1/4/3 native writes at second chunk absoluteoffset10, zero first, zero afterpartial, error afterpartial; no metadata/audit on failure and native retry succeeds. Permanent apps/server/test/modules/databaseImportShortWrite.test.ts seen red against exact guarded oldsource:7failed/1fullwritecontrolpassed.
### Validation
Scope7files/164tests passed (shortWrite,chunkRace,admissionRace,modules/databaseImports,lib/databaseImport,databaseImport014Wiring,engine/databaseImportEngine). GOMAXPROCS4 server typecheck/build passed. Initial scopedlint unused fixturegate removed; final check follows. git diff --check passed. NOT RUN fullserver/rootreleasecoverage, live restore, nativeMac; injected partial-write seam proves completion handling, not host short-write frequency.
### Not reproduced (dropped)
None.
### Working tree
Setup clean, only scoped source/new regression/docs/changelog/own evidence selected; unrelated changes absent.
### Next scope
Full configured server unit suite without coverage: collect broader behavioral/guard failures before choosing the next reproducible repair.

Final scopedlint clean; final permanent8tests passed after unused-fixture removal. Publication preflight:20exact owned paths; cached diff check/limited staged content scanner passed. No comprehensive security scan inferred; guarded selected blob/remote receipt follows.
