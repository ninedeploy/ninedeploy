## Round 16 — panel node Studio preparation and cleanup
### Setup
- Scope confirmed: apps/server/src/lib/nodeStudio.ts and apps/server/test/lib/nodeStudio.test.ts, nodeStudioRuntime.test.ts, nodeStudioNetwork.test.ts. HEAD7e3a9572; source/nearest tests clean; status in round16_status_before.txt. Other capability work preserved.
- CONTRIBUTING applies; current checked root/server manifests/config: Node26.13.0/pnpm11.23.0/TypeScript7/Vitest5.0.5/V8/tsc/Biome2.5.14; serial server files; formatter disabled; no race/sanitizer. No installs/config changes.
- Entire scope source and nearest lifecycle/relay tests read; runtime/network test controls read as neighboring boundary evidence. Routes/database callers were read in the preceding lifecycle pass.
- Invariants: preparing receipt is durable before remote start; lock survives browser cancellation until remote reply/cleanup; only validated candidate enables access; late result cannot overwrite retargeted database; cleanup preserves unconfirmed receipt and disables access; existing identity is reused without deleting it; relay socket receives cleanup/error handlers and credentials are resolved before allocation.
- Candidate review: source checks abort before/after admission, conditional target identity on database write, strict resource receipts and candidate-specific cleanup. No new executable failing candidate yet; no unproven security or live helper-cleanup assertion.

### Summary
No new confirmed finding or patch; 141 tests passed. No live Studio, multi-host isolation or end-to-end browser claim.
### Toolchain
Current manifests/config as recorded in Setup; no changes or installs.
### Findings
None new.
### Not reproduced (dropped)
No new executable failure produced. Existing tests cover lost/malformed replies, refusal, target changes, cancellation, cleanup uncertainty, replacement identities, private-network attachment, proxy authentication and credential revocation.
### Validation
- Focused/scope: pnpm --dir apps/server exec vitest run test/lib/nodeStudio.test.ts test/lib/nodeStudioRuntime.test.ts test/lib/nodeStudioNetwork.test.ts test/modules/nodeStudioProxy.test.ts --coverage=false: 141 passed/4 files.
- Build/typecheck: NOT RUN fresh (scope source/types unchanged); preceding F1043 checks passed.
- Format/lint: pnpm exec biome lint with scope source and three named lib tests: exit0, 4 checked/no fixes, 11 informational existing diagnostics; formatter disabled.
- git diff --check on the four paths: exit0.
- NOT RUN: full coverage/release, live agent/helper/network, browser restart/lost-response acceptance against Docker, Linux/macOS native behavior or security certification.
### Boundaries
Migrated disposable database and mocked agent/Docker/WebSocket boundaries in existing tests. Existing suites contain fake timers/controlled completion; no new timing-based race claim.
### Working tree
Scope source/tests unchanged; other capability work retained. Evidence only.
### Next scope (if rounds continue)
apps/server/src/lib/containerProbe.ts and apps/server/test/lib/containerProbeAddress.test.ts — probe address selection under multi-network and malformed-inspection inputs.
