## Round 37 — cloud-node sweep scheduler
### Summary
Scope confirmed: apps/server/src/plugins/cloudNodeScheduler.ts and nearest Hetzner/cloud rekey tests. Root CONTRIBUTING, plugin, async sweepCloudNodes and relevant existing tests read before candidates. No source patch or confirmed finding.

### Toolchain
Root/server package.json: Node ^22.23.4 || ^24.22.1 || ^26.12.1 (live 26.13.0), pnpm 11.23.0, Vitest 5.0.5/V8, TypeScript 7.0.2, Biome 2.5.14. Server files serialize and have isolated data; no configured race detector. No new tool installation.

### Invariants
- Timer clears on close and dispatches no future sweeps.
- Busy prevents a second sweep while the first remains pending.
- Success/rejection releases busy for a later live tick.
- A sweep already dispatched to the library is not claimed cancellable by the wrapper's close hook.

### Findings
None confirmed. Unlike the earlier callback schedulers, this wrapper passes no retained business-result callback; clearing the interval and draining the single dispatched promise must be tested before treating the absence of a stopped flag as a defect.

### Not reproduced (dropped)
Close before/after a pending sweep prevented future dispatch; overlap stayed suppressed; success/rejection released busy for the next live tick. Six gate/control cases passed. No retained business-result callback existed to reproduce the previous scheduler alert bug. In-flight library cancellation was not claimed or patched.

### Validation
- Focused: pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts .temp_files/audit_continuous_20261109/inspect_round37_cloudScheduler.test.ts --reporter=verbose -> six passed (round37_gated.log).
- Scope: pnpm --dir apps/server exec vitest run test/lib/hetznerCloud.test.ts --coverage=false --reporter=verbose -> 18 passed (round37_scope.log), provider requests mocked by the existing suite.
- Build/typecheck/lint NOT RUN freshly: no production/permanent-test change in this round. Earlier source snapshots are not fresh certification.
- git diff --check and combined round 37–38 git diff --cached --check -> exit 0. Limited selected-content scan: 25 owned files, no common credential-pattern matches, runtime files/index line endings passed; not a comprehensive security audit.
- Full release/live provider/native Mac NOT RUN: bounded no-finding pass; no source repair claimed.

### Boundaries
Use real Fastify close, virtual interval clock and explicit sweep gates. Provider/rekey work is a dependency seam; no live cloud API/resource/key mutation or security verdict.

### Working tree
Snapshot: audit_continuous_20261109/round37_status_before.txt. No source edits planned without a confirmed failing proof.

### Next scope (if rounds continue)
apps/server/src/plugins/jobScheduler.ts and test/plugins/jobScheduler.test.ts: recurring task ownership, cancellation and close around awaited work.
