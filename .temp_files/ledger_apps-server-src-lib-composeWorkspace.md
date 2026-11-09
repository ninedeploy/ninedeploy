# Evidence ledger

Scope: apps/server/src/lib/composeWorkspace.ts


## Round 4 — second 20-scope follow-up

### Setup evidence
- Instructions: root/ancestor/nested discovery: no applicable instructions; .wrongstack/AGENTS.md is outside these scopes. evidence-audit skill read.
- Baseline: .temp_files/rounds20_20261005_second/R04/status_before.txt, staged_before.patch, scope_before.patch, source_before.ts and nearest test snapshots; full dirty tree in .temp_files/rounds20_20261005_second/baseline.
- Source scope: apps/server/src/lib/composeWorkspace.ts. Test scope: apps/server/test/lib/composeWorkspace.test.ts.
- Invariants: Workspace resolution stays usable under the configured repository root; file errors propagate and repeated materialization repairs its cache.

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
- focused: cwd D:\Codebox\PROJECTS\NineDeploy; C:\Program Files\nodejs\node.exe D:\Codebox\PROJECTS\NineDeploy\node_modules\vitest\vitest.mjs run --disableConsoleIntercept --config .temp_files/audit.vitest.config.ts .temp_files/rounds20_20261005_second/R04/probe.test.ts → exit 0.

```text
RUN  v5.0.1 D:/Codebox/PROJECTS/NineDeploy

EXPECTED: nested repository workspace, repeated replacement, write failure propagated | ACTUAL: all assertions passed; PROBLEM NOT REPRODUCED

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  00:41:35
   Duration  125ms (transform 55%, import 34%, tests 6%, worker 5%)
```

- scope_tests: cwd D:\Codebox\PROJECTS\NineDeploy\apps\server; C:\Program Files\nodejs\node.exe D:\Codebox\PROJECTS\NineDeploy\node_modules\vitest\vitest.mjs run test/lib/composeWorkspace.test.ts --coverage=false → exit 0.

```text
RUN  v5.0.1 D:/Codebox/PROJECTS/NineDeploy/apps/server


 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  00:41:36
   Duration  143ms (transform 50%, import 28%, tests 16%, worker 6%)
```

- typecheck: cwd D:\Codebox\PROJECTS\NineDeploy\apps\server; C:\Program Files\nodejs\node.exe D:\Codebox\PROJECTS\NineDeploy\apps\server\node_modules\typescript\bin\tsc --noEmit → exit 0.

```text

```

- lint: cwd D:\Codebox\PROJECTS\NineDeploy; C:\Program Files\nodejs\node.exe D:\Codebox\PROJECTS\NineDeploy\node_modules\@biomejs\biome\bin\biome lint apps/server/src/lib/composeWorkspace.ts → exit 0.

```text
Checked 1 file in 5ms. No fixes applied.
```

- diff_check: cwd D:\Codebox\PROJECTS\NineDeploy; git diff --check -- apps/server/src/lib/composeWorkspace.ts → exit 0.

```text

```

- NOT RUN: formatter — disabled by biome.json.
- NOT RUN: complete repository test suites, coverage floors, emitted build/release check/live provider/runtime/browser validation — bounded scope audit; typecheck and configured existing scope target above.

### Boundaries
Normal nested repository root and local filesystem seam. No symlink/host escape workflow or POSIX permission guarantee on Windows; existing real-fixture scope target also run.

### Working tree
Source byte-identical to round baseline. Existing tests compared to round snapshots. Full dirty-tree preservation comparison will follow all 20 rounds. No commit/push/reset/stash/cleanup.

### Next scope (if rounds continue)
apps/server/src/lib/hostPort.ts


### Final set preservation check
All 90 initial dirty/new files byte-identical; staged diff unchanged. All 20 scopes finalized, final git diff --check exit 0. Master ledger: .temp_files/ledger_twenty_scopes_second_20261005.md.

## Continuous round 10 setup — 2026-11-09
- Scope confirmed: apps/server/src/lib/composeWorkspace.ts and apps/server/test/lib/composeWorkspace.test.ts; required narrow CHANGELOG line if a finding is proven. HEAD3a8e9e8d; scope source/test clean. Status in round10_status_before.txt; concurrent capability work preserved. Historical ledger retained; F1041 allocated.
- Current CONTRIBUTING/toolchain as checked in prior rounds: Node26.13.0/pnpm11.23.0/TypeScript7/Vitest5.0.5/Biome2.5.14; formatter disabled; no race/sanitizer. No installs.
- Source, nearest tests and callers read. Implementation materializes one YAML cache file, not a general directory-copy/exclusion engine; progress scope description corrected here.
- Invariants: any configured absolute repos root must resolve a valid integer child workspace; invalid/traversal IDs rejected; write errors propagate; repeat materialization repairs the cached YAML. POSIX permission preservation for an existing file cannot be proved on this Windows host; no security claim or patch for that line.
- Candidate: startsWith(STACK_ROOT + separator) adds a second trailing separator when repos root is already a filesystem root, rejecting every valid child. Test uses current host native drive root without writing at root; nested root control.

### F1041 root cause before patch
- input-handling, Low: stackWorkspace appends a separator to an already-terminated drive/filesystem root, so startsWith rejects valid child paths. Scope is uncommon root configuration; nested defaults unaffected.
- F1041_before.log exit1: nested control passes; EXPECTED D:\42 / ACTUAL invalid workspace id; PROBLEM CONFIRMED.
- Narrow patch: use exactly one trailing separator in the containment prefix; retain the integer and child-path checks. No root writes or public API/config/schema changes.

## Round 10 — inline Compose workspace root paths
### Summary
One Low input-handling bug confirmed, patched and promoted. Native Windows path resolution verified; no macOS/POSIX permission or live deployment claim.
### Toolchain
Current manifests/config: Node26.13.0, pnpm11.23.0, TypeScript7, Vitest5.0.5, Biome2.5.14; formatter disabled; no race/sanitizer.
### Findings
#### F1041 — input-handling — Low — filesystem-root repositories reject valid workspace IDs
- Location: apps/server/src/lib/composeWorkspace.ts:29, stackWorkspace.
- Root cause: doubled trailing separator in the containment prefix when reposDir is a filesystem root.
- Proof (before): audit_continuous_20261109/prove_F1041_compose_root.test.ts; F1041_before.log exit1; nested control passed, expected D:\42, actual invalid workspace id; PROBLEM CONFIRMED.
- Patch: normalize rootPrefix to exactly one trailing separator; preserve ID/containment checks. No API/schema/config/data-format/dependency changes.
- Proof (after): unchanged original exit0/PROBLEM NOT REPRODUCED; independent verify_F1041_compose_root.test.ts three consecutive runs FIX VERIFIED; 9 valid children and 21 invalid-ID checks.
- Regression test: apps/server/test/lib/composeWorkspace.test.ts; before 1 failed/5 passed; after 6 passed.
### Not reproduced (dropped)
No additional executable finding. POSIX existing-file permission behavior is outside this Windows boundary; no security claim inferred.
### Validation
- Focused: root pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts with each named proof/verifier --reporter=verbose; original after and verifier runs1/2/3 passed.
- Scope: pnpm --dir apps/server exec vitest run test/lib/composeWorkspace.test.ts test/lib/composeRelease.test.ts test/builders/compose.test.ts test/engine/remoteCompose.test.ts test/composeStacks.test.ts test/modules/composeStacks.test.ts --coverage=false: 126 passed/6 files.
- Build/typecheck: pnpm --dir apps/server typecheck and build each exit0, retained F1041 logs.
- Format/lint: pnpm exec biome lint apps/server/src/lib/composeWorkspace.ts apps/server/test/lib/composeWorkspace.test.ts: 2 checked/no fixes; formatter disabled.
- git diff --check on changed source/test/changelog paths: exit0 (autocrlf notices only).
- NOT RUN: full release/coverage, live Compose/Docker, Linux/macOS native filesystem acceptance and POSIX permission security tests.
### Boundaries
Root resolution tests write nothing at root. Materialization controls use disposable test directories. Intermittent Windows command-spawn Access denied happened before execution; unchanged retries succeeded, not product failures.
### Working tree
Concurrent capability/localization/docs work preserved. Only this scope and its Fixed changelog hunk staged; audit evidence retained, no cleanup/reset/stash.
### Next scope (if rounds continue)
apps/server/src/lib/systemArchive.ts and apps/server/test/systemArchiveRace.test.ts — export/restore staging ownership and rollback.
