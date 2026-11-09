## Round 47 — GitHub runner pool scheduler lifecycle
### Summary
Scope confirmed: apps/server/src/plugins/githubRunnerScheduler.ts, lib/githubRunners.ts as read-only upkeep boundary, nearest GitHub runner tests and audit evidence. Source/plugin and existing pool/node/coverage fixtures read before candidates. No source patch proposed.
### Toolchain
Node26.13.0, pnpm11.23.0, package0.18.26, Vitest5.0.5/V8, TypeScript7.0.2, configured Biome2.5.14 formatter disabled, serial files/isolated data/no configured race detector. No dependencies added. Root/scope instructions unchanged.
### Invariants
- First sweep starts on the one-minute cadence, not at registration.
- A pending sweep excludes subsequent ticks, releases busy on success/failure and allows later active-owner retries.
- Closing prevents new periodic or retained-callback dispatch; an already-admitted sweep can finish at its library boundary.
### Findings
No finding without a failing executable proof.
### Not reproduced (dropped)
Seven lifecycle controls passed; no finding.
### Validation
Pending.
### Boundaries
Real Fastify lifecycle and fake interval time, explicit promise gates, mocked sweep boundary. Existing runner tests mock GitHub/Docker/node boundaries; no actual provider or container. This scope does not cancel an already-admitted sweep or certify its external effects.
### Working tree
round47_status_before.txt; round46 580944d4f43004f45ccf75e1b10993d904cfeef4 owned blobs and origin main verified. Preserve unrelated CHANGELOG/release work.
### Next scope (if rounds continue)
Runner pool pending-job draining configuration/ownership in lib/githubRunners.ts, after current controls.

### Final bounded result — no new finding
- inspect_round47_ghaScheduler.test.ts / round47_controls.log -> 7 passed. Real Fastify registration/close; fake interval cadence; explicitly held success/failure; overlap suppression and busy release; close before/during sweep; retained callback after close. Already-admitted library work is allowed to finish at this boundary.
- Scope: pnpm --dir apps/server exec vitest run test/lib/githubRunners.test.ts test/lib/githubRunners.coverage.test.ts test/lib/githubRunnersNode.test.ts --coverage=false --reporter=verbose -> 111 passed / 3 files (round47_scope.log). GitHub/Docker/node operations mocked by existing fixtures; no live acceptance inferred.
- No source patch, new Finding ID, changelog entry or permanent test promotion from these passing controls. Scope is not claimed globally bug-free.
- NOT RUN anew: server compile/build/lint/full coverage; no production/test-suite source changed in this round. Prior round46 static checks belong to their recorded snapshot. Evidence diff checks/publication will be included with the next bounded scope.
- Next scope: lib/githubRunners.ts drainOnce's pending snapshot versus workflow_job updates while an earlier runner start is awaiting. The webhook contract drops later-action jobs from pending; reproduce before any edit.
