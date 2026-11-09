## Round 15 — node database lifecycle admission
### Setup
- Scope confirmed: apps/server/src/lib/nodeDatabaseLifecycle.ts and apps/server/test/lib/nodeDatabaseLifecycle.test.ts. HEAD7e3a9572, both clean; full status in round15_status_before.txt. Concurrent capability changes retained.
- CONTRIBUTING applies; current checked root/server manifests/config: Node26.13.0, pnpm11.23.0, TypeScript7, Vitest5.0.5/V8 serial files, tsc build/typecheck, Biome2.5.14/formatter disabled; no race/sanitizer. No installs/config changes.
- Entire source and nearest test read; database mutation and nodeStudio callers checked read-only.
- Invariants: reject invalid IDs before filesystem effects; reserve same-resource in-process admission before await; reject overlap without executing it; allow unrelated databases; release disk/local admission on success, operation error and acquisition failure; preserve ordinary filesystem errors; translate actual lock contention to 409.
- Candidate review: return awaits the operation inside try/finally, so local/disk ownership survives through operation completion and is released after rejection. No new executable failing candidate from this bounded pass.

### Summary
No new confirmed defect or patch; 18 tests passed. Disk-lock implementation's previously documented residual stale-takeover window is not claimed fixed.
### Toolchain
Current manifests/config as recorded in Setup; no dependency or runner changes.
### Findings
None new.
### Not reproduced (dropped)
No new failing candidate. Existing tests force same-resource overlap with explicit gates, allow another database and verify failed-operation/acquisition recovery.
### Validation
- Focused/scope: pnpm --dir apps/server exec vitest run test/lib/nodeDatabaseLifecycle.test.ts test/lib/crossProcessLock.test.ts test/lib/crossProcessLock-r314.test.ts --coverage=false: 18 passed/3 files.
- Build/typecheck: NOT RUN fresh (source/types unchanged); preceding F1043 checks passed.
- Format/lint: pnpm exec biome lint apps/server/src/lib/nodeDatabaseLifecycle.ts apps/server/test/lib/nodeDatabaseLifecycle.test.ts: 2 checked/no fixes; formatter disabled.
- git diff --check with scope paths: exit0.
- NOT RUN: full release/coverage, actual multi-panel database mutation, Linux/macOS filesystem semantics or new cross-process race proof.
### Boundaries
Real temp filesystem and fake timer contention cases in nearest tests. Two command-launch attempts were rejected with Windows Access denied before execution; unchanged retry passed. No product failure inferred.
### Working tree
Scope source/tests unchanged; concurrent capability work retained. Evidence only, no product commit.
### Next scope (if rounds continue)
apps/server/src/lib/nodeStudio.ts and its three nearest lib/nodeStudio*.test.ts files — durable preparing receipts and failed remote preparation cleanup.
