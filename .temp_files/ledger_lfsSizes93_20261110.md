# Round 93 — LFS shared-object size consistency
## Setup/scope
Scope confirmed: apps/server/src/lib/gitLfs.ts object deduplication and new test/lib/gitLfsObjectSizes.test.ts; changelog and owned evidence. Existing main ba7045abd8a6e97668037d039c70695c5ba0f997 clean (round93_status_before.txt). CONTRIBUTING read. Node26.13.0/pnpm11.23.0, TypeScript7/Vitest5/Biome2.5 from root/server manifests and existing configs. No race detector configured for this TS scope. No dependencies installed.
## Invariants
Every hydrated path must agree with the verified object size. Deduplication must not silently discard a conflicting pointer declaration based on lexical path order. Invalid declarations should fail before network/write, leaving tracked pointers intact. Matching duplicates still download only once. Owned native Git LFS3.8.1 oracle rejects wrong-size cached object smudges while canonical cached content works; empty pointer smudges locally without transfer. No live remote access; explicit loopback port9 endpoint for unavailable transfer. Empty-object optimization is not a confirmed finding and is deferred.
## Candidate
Same-OID differing sizes are currently collapsed by last-write-wins Map; runnable application proof pending, no production edit yet.

## F1114 — input-handling — Medium — conflicting duplicate sizes silently discarded
Before proof F1114_before.log:1failed/1control passed, EXPECTED rejection/no writes; ACTUAL no error, first pointer replaced with verified shared content,2HTTP-seam requests. Root cause before patch: objects.set(oid,size) overwrites a prior size without validating equality, then every path uses the last declaration's verified content. Operator-visible wrong-size pointer accepted; not arbitrary content/hash bypass. Narrow fix compares any existing size before overwrite and throws before network/store/write. Same-OID same-size behavior stays deduplicated. Native wrong-size oracle fails, but this is primarily the code's explicit per-pointer size invariant, no fullnative parity assertion.

## Verification and validation
Original proof after patch2passed/PROBLEM NOT REPRODUCED. Permanent nine-case regression seen red against exact old producer:6failed/3controls. No-drift checked restoration. Independent verifier original2+permanent9 passed three consecutive runs/FIX VERIFIED. Final LFS scope43tests/4files passed. GOMAXPROCS4 server typecheck/build exit0. Configured scoped Biome2files clean; YAML/read-only/manual/pinned-action and Bash steps valid after adding new regression. diffcheck passed. No dependencies or API/schema/persisted format changes. Native Mac follow-up pending, full release/server R73 failure unresolved. Repeated shell CreateProcess os5 failures happened before launch and identical retries succeeded; no product finding.

## Publication preflight
33owned paths staged; expected normalized blobs, index diffcheck and limited staged credential-pattern check passed. Prior working tree clean; only owned scope staged.
