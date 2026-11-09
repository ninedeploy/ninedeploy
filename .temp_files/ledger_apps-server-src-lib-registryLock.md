# Evidence ledger

Scope: apps/server/src/lib/registryLock.ts


## Round 4 — 20-scope follow-up

### Setup evidence
- Instructions: root/ancestor/nested discovery: no applicable instructions; .wrongstack/AGENTS.md is outside these scopes. evidence-audit skill read.
- Baseline: .temp_files/rounds20_20261004_followup/R04/status_before.txt, staged_before.patch, scope_before.patch, source_before.ts and nearest test snapshots; full dirty tree in .temp_files/rounds20_20261004_followup/baseline.
- Source scope: apps/server/src/lib/registryLock.ts. Test scope: apps/server/test/lib/registryLock.test.ts.
- Invariants: Same credential-store keys serialize; independent keys progress; release is idempotent and cannot clear a queued successor.

### Toolchain
Node v24.13.0 (package.json requires >=22.13.0), pnpm 11.23.0 (packageManager), TypeScript ^7.0.2, Vitest ^5.0.1, V8 coverage and Biome ^2.5.14 (root/package manifests). Server Vitest config serializes files; web uses jsdom/setup.ts. Package typecheck is tsc --noEmit. Formatter disabled by biome.json; no configured race detector/sanitizer in inspected configs. No tool/dependency installed.

### Analysis evidence
Pending source/test read and local checks.


### Summary
Round 4/20 completed. 0 confirmed finding(s); 0 runnable candidate(s) not reproduced. Executed validation passed.

### Findings
None — no source patch.

### Not reproduced (dropped)
None.

### Validation
- focused: cwd D:\Codebox\PROJECTS\NineDeploy; C:\Program Files\nodejs\node.exe D:\Codebox\PROJECTS\NineDeploy\node_modules\vitest\vitest.mjs run --disableConsoleIntercept --config .temp_files/audit.vitest.config.ts .temp_files/rounds20_20261004_followup/R04/probe.test.ts → exit 0.

```text
RUN  v5.0.1 D:/Codebox/PROJECTS/NineDeploy

EXPECTED: strict second/third order, independent keys and idempotent release | ACTUAL: all gated assertions passed; PROBLEM NOT REPRODUCED

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  23:45:05
   Duration  203ms (transform 57%, import 31%, tests 6%, worker 5%)
```

- scope_tests: cwd D:\Codebox\PROJECTS\NineDeploy\apps\server; C:\Program Files\nodejs\node.exe D:\Codebox\PROJECTS\NineDeploy\node_modules\vitest\vitest.mjs run test/lib/registryLock.test.ts --coverage=false → exit 0.

```text
RUN  v5.0.1 D:/Codebox/PROJECTS/NineDeploy/apps/server


 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  23:45:06
   Duration  243ms (transform 43%, tests 34%, import 17%, worker 5%)
```

- typecheck: cwd D:\Codebox\PROJECTS\NineDeploy\apps\server; C:\Program Files\nodejs\node.exe D:\Codebox\PROJECTS\NineDeploy\apps\server\node_modules\typescript\bin\tsc --noEmit → exit 0.

```text

```

- lint: cwd D:\Codebox\PROJECTS\NineDeploy; C:\Program Files\nodejs\node.exe D:\Codebox\PROJECTS\NineDeploy\node_modules\@biomejs\biome\bin\biome lint apps/server/src/lib/registryLock.ts → exit 0.

```text
Checked 1 file in 6ms. No fixes applied.
```

- diff_check: cwd D:\Codebox\PROJECTS\NineDeploy; git diff --check -- apps/server/src/lib/registryLock.ts → exit 0.

```text

```

- NOT RUN: formatter — disabled by biome.json.
- NOT RUN: complete repository test suites, coverage floors, emitted build/release check/live provider/runtime/browser validation — bounded scope audit; typecheck and configured existing scope target above.

### Boundaries
Explicit acquisition/release gates, no sleeps in new checks. Existing scope suite includes its own timing-based smoke test; no new race/ownership defect found, no live registry login/pull.

### Working tree
Source byte-identical to round baseline. Existing tests compared to round snapshots. Full dirty-tree preservation comparison will follow all 20 rounds. No commit/push/reset/stash/cleanup.

### Next scope (if rounds continue)
apps/server/src/lib/keyedOperationGuard.ts


### Final set preservation check
All 81 pre-existing dirty/new files preserved byte-for-byte, staged diff unchanged. Final git diff --check passed. Twenty-scope final report: .temp_files/ledger_twenty_scopes_followup_20261004.md; proof and startup/typecheck failure evidence retained.

## Continuous round 22 setup — 2026-11-09
- Scope confirmed: apps/server/src/lib/registryLock.ts and apps/server/test/lib/registryLock.test.ts. Starting HEAD44e987c4, source/test clean; full status in round22_status_before.txt. Historical IDs retained. General release gate was running during initial read; no product source edited.
- CONTRIBUTING/current checked toolchain: Node26.13.0/pnpm11.23.0/TypeScript7/Vitest5.0.5/V8/tsc/Biome2.5.14; formatter disabled, no race/sanitizer. No installs.
- Source/test and login caller/key-generation paths read. Invariants: same credential-store key queues FIFO; other keys progress; idempotent release cannot erase a queued successor; no credential mutation by lock helper itself.
- Candidate: aliases might share a Docker credential entry despite different lock keys. Tested actual Docker CLI logout with a disposable --config directory and synthetic auths, never the user's config or a remote registry. Native output in round22_native_aliases.log. Default logout removed the seeded legacy Hub entry, while docker.io/index.docker.io/registry-1.docker.io did not; unrelated registry control preserved it. Alias-key collision claim NOT reproduced; no normalization patch justified by this evidence. Official CLI docs: https://docs.docker.com/reference/cli/docker/logout/ .

## Round 22 — registry lock ownership review
### Summary
No new confirmed defect or patch; native alias candidate not reproduced,4 existing tests passed.
### Toolchain
Current checked manifests/config as recorded above; no install/config change.
### Findings
None new; historical IDs retained.
### Not reproduced (dropped)
Alias strings sharing the seeded Docker credential entry: native isolated-config logout experiment did not reproduce the premise; no canonicalization patch made. This does not certify all registries or credential helpers.
### Validation
- Focused/scope: pnpm --dir apps/server exec vitest run test/lib/registryLock.test.ts --coverage=false:4 passed/1 file.
- Native seam: node .temp_files/audit_continuous_20261109/inspect_registry_aliases.mjs:exit0; five isolated-config logout cases logged in round22_native_aliases.log.
- Build/typecheck: NOT RUN fresh for this unchanged scope; later F1047 server checks passed.
- Format/lint: pnpm exec biome lint apps/server/src/lib/registryLock.ts apps/server/test/lib/registryLock.test.ts:2 checked/no fixes; formatter disabled.
- git diff --check with scope paths:exit0.
- NOT RUN: actual private-registry login/pull, cross-process credential-store write races, alternate credential helpers, full coverage gate.
### Boundaries
Only a synthetic auth entry in a disposable --config directory was mutated; no user Docker credentials or remote registry used. Existing test's real5ms delay is not a new deterministic race verifier or new fix proof.
### Working tree
Scope source/tests unchanged; other concurrent work retained. Evidence only.
### Next scope (if rounds continue)
Log-search drain authentication context (round23), then header merge precedence if a new executable proof confirms it.
