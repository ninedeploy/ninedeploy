## Round 18 — readiness receipt interpretation
### Setup
- Scope confirmed: apps/server/src/lib/nodeProbeReceipt.ts and apps/server/test/lib/nodeProbeReceipt.test.ts. HEADe8eca7c9; source/test clean, status in round18_status_before.txt. Other capability work retained.
- CONTRIBUTING applies; current checked Node26.13.0/pnpm11.23.0/TypeScript7/Vitest5.0.5/V8/tsc/Biome2.5.14; server serial files, formatter disabled, no race/sanitizer. No installs/config changes.
- Entire source and nearest tests read; local/remote builder and readiness-agent consumers inspected by call site.
- Invariants: exactly one bounded frame, operation exit0, object JSON, literal ready=true and matching requested protocol; HTTP needs integer final status200..399. Missing/malformed/duplicate/oversized/failed-operation evidence must not pass.
- Candidate review: code enforces each listed success condition. Extra unrelated logs are intentionally ignored; no unproven parser rewrite or security claim.

### Summary
No new confirmed finding or patch; 28 tests passed, bounded receipt/readiness evidence only.
### Toolchain
Current manifests/config as recorded in Setup; no changes or installs.
### Findings
None new.
### Not reproduced (dropped)
No executable new failure produced; controls cover missing/malformed/contradictory/duplicate/oversized frames and nonzero operation exits.
### Validation
- Focused/scope: pnpm --dir apps/server exec vitest run test/lib/nodeProbeReceipt.test.ts test/engine/remoteReadinessDeadline.test.ts test/agentReadiness.test.ts --coverage=false: 28 passed/3 files.
- Build/typecheck: NOT RUN fresh (source/types unchanged); preceding F1044 checks passed.
- Format/lint: pnpm exec biome lint apps/server/src/lib/nodeProbeReceipt.ts apps/server/test/lib/nodeProbeReceipt.test.ts: 2 checked/no fixes; formatter disabled.
- git diff --check with scope paths: exit0.
- NOT RUN: full release/coverage, actual remote agent/Docker pipeline or additional adversarial protocol acceptance.
### Boundaries
Existing subprocess/agent seams and fake deadline controls; no real deployment, security certification or environment parity claim.
### Working tree
Scope source/tests unchanged; concurrent capability work retained. Evidence only.
### Next scope (if rounds continue)
apps/server/src/lib/sourceUpload.ts publication stage — cleanup after an injected rename failure, preserving an already stored archive.
