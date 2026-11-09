## Round 49 — GitHub runner batch configuration snapshot
### Summary
Scope confirmed: apps/server/src/lib/githubRunners.ts drainOnce batch configuration and nearest pending-runner tests, required changelog/docs/evidence. Source/current runner fixtures reread before candidate; initial setup before patch, final evidence below.
### Toolchain
Current manifests/config unchanged: Node26.13.0, pnpm11.23.0, package0.18.26, TypeScript7.0.2, Vitest5.0.5/V8, Biome2.5.14 formatter disabled; serial files/isolated data/no configured race detector. No dependencies added.
### Invariants
- A settings update that completes while one admitted runner starts cannot let the same batch admit more jobs under its old enabled/capacity/resource snapshot.
- Stop/defer the remaining pending jobs on configuration drift; a fresh pass can re-enumerate hosts/capacity and use current configuration without losing pending work.
- Already-admitted start may finish; identical settings retain normal batch throughput.
### Findings
F1068 confirmed and repaired below.
### Not reproduced (dropped)
No unrelated candidate bundled.
### Validation
Pending.
### Boundaries
Real migrated settings and mocked GitHub/Docker with explicit first-JIT barrier. No actual resource/provider execution. This is batch snapshot fencing; full eligibility revalidation of jobs queued before a policy change requires its own proof/scope.
### Working tree
round49_status_before.txt; round48 source/evidence publication receipt retained. Unrelated CHANGELOG/release work preserved.
### Next scope (if rounds continue)
Queued-job eligibility after policy changes, recorded below.

### F1068 — race/ownership — Medium — an in-flight runner batch keeps admitting under obsolete settings
- Location: lib/githubRunners.ts drainOnce config snapshot across awaited startRunner and status checks.
- Root cause BEFORE patch: enabled/maxConcurrent/resources are read once per App, then reused for every pending job even after a settings update completed during an earlier job's asynchronous preparation.
- Before proof: prove_F1068_ghaConfig.test.ts / F1068_before.log -> 2 failed / 1 identical-config control passed, exit1, PROBLEM CONFIRMED. First JIT gated; persisted enabled=false or maxConcurrent2->1; EXPECTED starts[80], ACTUAL[80,81]. Mocked container listing reflects already-started runners for later passes; real migrated settings.
- Severity Medium stale operator policy/resource admission, no live provider/container or privilege-exposure claim.
- Planned narrow patch: fingerprint the parsed batch config and re-read it after the final optional online await before each pending-entry admission. On drift end this App's batch without consuming remaining pending entries; the next pass re-enumerates hosts/capacity/config. Identical configuration keeps throughput. No schema/wire/dependency or persisted generation needed.
- Permanent regression: apps/server/test/lib/githubRunnerConfigDrift.test.ts, three red/control cases before patch.
- Pre-execution OS spawn refusal retried identically; no source/test execution happened in that refusal.

### Independent read-window proof before the final fence
- F1068_verify_read_before.log initially showed3 failed/6 passed; two were fixture mistakes because cpus2/memory4096 already equal schema defaults. The verifier now uses valid changed cpus4/memory8192 values; no product assertion was weakened. Corrected F1068_verify_read_before_corrected.log ->1 failed/8 passed.
- The remaining failure is a product window on the initial patch: the final config query captured old enabled state, then setRunnerConfig completed enabled=false before that read resumed; the old row still matched the batch fingerprint and job81 started. EXPECTED[80], ACTUAL[80,81], PROBLEM CONFIRMED.
- Promoted that precise settings-read/JIT barrier into permanent githubRunnerConfigDrift.test.ts; F1068_regression_read_before.log ->1 failed/3 passed before final patch.
- Root cause before final edit: a value comparison cannot detect a successful same-process settings write overlapping the read that returned the old value. Track an opaque generation token per DB/App changed only after successful setRunnerConfig; compare it before/after the final read as well as comparing the parsed snapshot. Weak DB keys and opaque tokens avoid retained DB instances/counter overflow. Direct external SQL/multiple-process writes are outside this in-memory pending-owner fence.

### Final acceptance
- Final patch: parsed config fingerprint fences batch drift; a per-DB/App opaque generation changed only after successful setRunnerConfig also fences a read overlapping a completed settings write. Drift breaks this App's batch before consuming the next pending entry. No public schema/wire/config/dependency change; pending owner check remains after all awaits.
- Original final: F1068_proof_final_after.log -> 3 passed, PROBLEM NOT REPRODUCED. F1068_after.log is the intermediate value-only pass before the stronger read-window test.
- Independent final: verify_F1068_ghaConfig.test.ts -> 9 passed in each F1068_verify_final_1/2/3.log, FIX VERIFIED. Identical save, disable/capacity decrease/increase and changed CPU/memory while first JIT waits; later fresh pass retains/adopts pending work and current run args; online-status await changes; config read captured before successful disable returns. Explicit barriers, no sleeps.
- Permanent regression: apps/server/test/lib/githubRunnerConfigDrift.test.ts, original3 plus strongest settings-read race promoted/red before final fence, now4 passing in normal suite.
- Scope: pnpm --dir apps/server exec vitest run test/lib/githubRunnerConfigDrift.test.ts test/lib/githubRunnerPending.test.ts test/lib/githubRunners.test.ts test/lib/githubRunners.coverage.test.ts test/lib/githubRunnersNode.test.ts --coverage=false --reporter=verbose -> 118 passed / 5 files (F1068_scope.log).
- Compile: child-process GOMAXPROCS=4 pnpm --dir apps/server typecheck and build -> both exit0 (F1068_typecheck.log/F1068_build.log).
- Biome: pnpm exec biome lint apps/server/src/lib/githubRunners.ts apps/server/test/lib/githubRunnerConfigDrift.test.ts ->2 files, no fixes, exit0 (F1068_lint.log). Formatter disabled by repository config.
- NOT RUN: full repository/server coverage, hosted CI, live GitHub/Docker/node, native Mac bootstrap. Opaque generation covers normal same-process setter writes on the owning DB; direct external SQL/multiple-process settings mutation and a restart-durable pending queue are not certified. Already-admitted startup can finish.
- Next scope: pending job eligibility against a later repository/public/label policy in lib/githubRunners.ts; verify queued metadata/current-policy behavior before patching.
- Publication preflight: guarded22-path staging, cached and working-tree diff --check, limited staged credential/runtime/line-ending scan passed. Only owned GHA source/test/Mac docs/evidence and F1068 changelog hunk selected; final wrapper verifies every selected HEAD blob before push.
