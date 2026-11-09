## Checkpoint after continuous round 20 — full local release gate
### Setup
- Starting HEADb86731917c3943bb530462576b16a9af9b810f36; status captured checkpoint20_status_before.txt. Concurrent untracked stable-channel workflow/script preserved; install.sh subsequently changed by that writer. No unrelated files staged or changed here.
- Command: pnpm run release:check, root package script checks Node then workspace typecheck/lint/build and serial Turbo test tasks. Complete log: audit_continuous_20261109/checkpoint20_release.log.
### Observed result
- Exit1: SDK coverage threshold failure, not a confirmed runtime defect. SDK388 tests/35 files passed, but lines99.9%, functions99.85%, statements99.91% were below configured100%; uncovered packages/sdk/src/resources/services.ts:477 is the concurrent C1 services.capabilities method.
- Broad test tasks after the failure were not completed and are not claimed green. Prior focused audit results remain separately recorded.
- Do not lower thresholds or fabricate a before-failing runtime assertion for an untested method. Add meaningful public transport coverage and rerun the configured package gate, then the general gate.

## Round 21 — service-capability SDK transport validation
### Setup
- Scope confirmed: packages/sdk/test/serviceCapabilities.test.ts; source method and packages/schemas/src/capabilities.ts are read-only context. Coverage/toolchain manifests inspected; no API/source/schema/dependency change planned.
- Root CONTRIBUTING applies; existing panelAccess.test.ts conventions inspected. Vitest/V8 with configured100% floors; TypeScript/tsc and Biome from current manifests. No new tool installed.
- Invariants: services.capabilities(id) sends authenticated GET to the selected service endpoint, returns the full capability view unchanged and propagates server refusal as NineDeployError; no request body or mutation.
- This closes a runnable release-gate coverage gap rather than declaring a new product bug finding. Original gate failure retained above.

### Test fixture correction
The first new test incorrectly supplied an async getToken callback, which the documented type in sdk/src/transport.ts:28 does not support (only synchronous string/null/undefined). The assertion correctly rejected Bearer[object Promise]. The fixture was corrected to the supported synchronous callback, keeping the exact authentication assertion; no runtime API changed and no product bug inferred. Failed test log retained as checkpoint20_sdk_fixture_failed.log.

### Summary
SDK coverage gap closed by two public transport tests. No runtime product defect claimed; full release gate must be retried after this checkpoint commit.
### Toolchain
packages/sdk/package.json: tsc typecheck/build, vitest run --coverage; sdk/vitest.config.ts: V8 with100% statements/branches/functions/lines; repository Node26.13.0/pnpm11.23.0 and existing Biome. No new dependency/config installed.
### Findings
No new product finding. Release-check failure reproduces missing SDK method coverage, and the configured package gate now passes without threshold changes.
### Not reproduced (dropped)
Async getToken fixture is unsupported usage, not a runtime SDK bug. Corrected fixture retains all authentication assertions.
### Validation
- Focused/scope: pnpm --dir packages/sdk test:390 passed/36 files; statements1157/1157, branches537/537, functions685/685, lines1071/1071 all100%; log checkpoint20_sdk_coverage_after.log.
- Build/typecheck: pnpm --dir packages/sdk typecheck and build each exit0; retained logs. Only subsequent test change was sync callback fixture correction.
- Format/lint: pnpm exec biome lint packages/sdk/test/serviceCapabilities.test.ts:1 checked/no fixes; formatter disabled.
- git diff --check with test path:exit0.
- NOT RUN yet: retry of full release gate after adding test. Original full gate failed SDK and did not complete all downstream tasks; cached task logs are not fresh executions.
### Boundaries
Fetch seam, synthetic capability view covering four statuses and nullable reasons, selected-service URL/auth/no body,403 NineDeployError propagation. No live authentication/provider or server authorization claims.
### Working tree
Concurrent install/update/resources/management/stable-channel work retained. Stage only SDK transport test and selected checkpoint evidence; no source/schema/changelog change (no operator behavior change), no reset/stash/cleanup.
### Next scope (if rounds continue)
Rerun pnpm release:check on committed SDK coverage addition; any newly observed failure becomes the next concrete validation scope.

### Full gate retry after SDK coverage commit
- Starting HEAD44e987c40a864c033089b5d46f0cfa6b6ff39161; exact starting status captured checkpoint20_retry_status_before.txt. Concurrent update/resources/installer/management/stable-channel work continued changing the checkout; no exact-commit certification claimed.
- pnpm release:check retry exit1, retained checkpoint20_release_retry.log. SDK workers aborted during starting state, exit134,16 worker errors; native messages include Zone Allocation failed/process out of memory and Worklist::Segment::Create. Only267 tests/20 files passed before incomplete run; its low coverage report is not a completed product-coverage result.
- Separate configured SDK run390 tests/36 files had already passed all100% floors. No assertion/coverage threshold was weakened or Node memory setting changed; no other writer killed.
- Read-only host snapshot after failure:64 Node processes, about595MiB resident Node memory, free physical memory~27.3GiB and free virtual memory~10GiB; parent Node heap limit4192MiB, NODE_OPTIONS absent. This supports an environment/resource boundary, not a measured product memory leak or a proven source cause.
- Full release gate remains incomplete. Continue bounded audits; retry broad certification after concurrent source work and resource pressure settle, or on fresh Mac setup. Do not describe this as a green release.
