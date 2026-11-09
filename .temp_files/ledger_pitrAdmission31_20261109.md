## Round 31 — recovery admission ownership
### Summary
Scope confirmed: apps/server/src/lib/pitr.ts recovery admission/archive ownership and nearest tests, required changelog/docs/evidence. Read root CONTRIBUTING, startPitrRecovery, existing admission/background/maintenance tests and engine operation-lock callers before candidates. One Medium race confirmed, fixed and promoted to two permanent gate/control cases.

### Toolchain
Root/server package.json: Node ^22.23.4 || ^24.22.1 || ^26.12.1 (live 26.13.0), pnpm 11.23.0, Vitest 5.0.5, TypeScript 7.0.2, Biome 2.5.14. Server test runner serializes files and isolates data. No race detector; native compiler may need the recorded GOMAXPROCS=4 resource bound on this host.

### Invariants
- MAX_PITR_RECOVERIES=1 is a process-wide admission limit, including concurrent requests suspended during preflight lookups.
- An admitted operation reserves ownership before yielding; failed admission releases only its reservation.
- Existing sequential busy rejection and successful background completion remain unchanged.
- Engine pruning/backup ownership is a separate candidate until a runnable proof exists.

### Findings
#### F1053 — race — Medium — concurrent admissions bypass the global recovery limit
- Location: startPitrRecovery capacity check, slug/volume lookups and recoveriesRunning.add.
- Root cause (recorded before patch): capacity check precedes two awaited lookups; only after them is capacity reserved. Two requests pass the same limit check and both start resource-heavy recovery work.
- Proof before: prove_F1053_pitrAdmission.test.ts, F1053_before.log -> pending volume lookup admits the second recovery, EXPECTED rejected with pitr_recovery_busy, ACTUAL second recovery admitted, PROBLEM CONFIRMED; one failed, one sequential running-recovery control passed, exit 1.
- Severity: Medium process admission/resource budget violation. No live recovery corruption or host resource exhaustion claimed from the synthetic replay seam.
- Planned patch: reserve before the first async lookup and place both lookup refusals inside the existing admission try/catch so failed admission releases its reservation.
- Regression: two gated real-SQLite cases added to apps/server/test/lib/pitr.test.ts before patch.
- Patch: reserve source ownership before the first await, move the slug/volume checks into the existing admission try/catch. All lookup/insert failures release the reservation. No API shape/persisted-data change; existing busy error now applies during pending admission too.
- Proof after: F1053_after.log -> two passed, PROBLEM NOT REPRODUCED.
- Independent verifier: verify_F1053_pitrAdmission.test.ts, eight cases; 2/5 contenders while slug/volume lookups are gated, only one recovery row/replay; admission name/volume/lookup/foreign-key insert failures release capacity for a subsequent successful request. Three consecutive clean runs, FIX VERIFIED (F1053_verify_1/2/3.log).

### Not reproduced (dropped)
No additional finding claimed. Prune/backup exclusion during an already-dispatched engine operation remains a separate candidate for the next round.

### Validation
- Focused: pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts <prove_F1053_pitrAdmission.test.ts or verify_F1053_pitrAdmission.test.ts> --reporter=verbose -> before one failed/one control passed; after two passed; verifier eight passed x3.
- Scope: pnpm --dir apps/server exec vitest run test/lib/pitr.test.ts test/lib/pitrDeps.test.ts test/modules/pitr.test.ts test/engine/postgresPitr.test.ts test/plugins/pitrScheduler.test.ts --coverage=false --reporter=verbose -> 53 passed / five files (F1053_scope.log).
- Typecheck/build: child-process GOMAXPROCS=4, pnpm --dir apps/server typecheck and build -> both exit 0 (F1053_typecheck_bounded.log / F1053_build_bounded.log). Resource bound follows round 30's native allocation failure; no shared or repository environment setting changed.
- Lint: pnpm exec biome lint apps/server/src/lib/pitr.ts apps/server/test/lib/pitr.test.ts -> checked two files, no fixes, exit 0 (F1053_lint.log). Formatter disabled by repository config.
- git diff --check and git diff --cached --check -> exit 0. Selected-content scan: 18 staged files, no common credential-pattern matches, runtime files/index line endings passed (limited scan, not a security audit).
- NOT RUN: full root gate/default unbounded compiler retry/native Mac/live PostgreSQL recovery. Source still changes concurrently outside scope.

### Boundaries
Real migrated SQLite and explicitly blocked slug/volume/recovery seams verify process-local admission. No live container/replay or cross-process serialization claim. Engine prune ownership is not fixed by this admission patch. Two process launches failed with Access denied before execution; unchanged smaller retries ran, no approval/sandbox bypass. Verifier cleanup releases every admitted replay before closing the database.

### Working tree
Snapshots: audit_continuous_20261109/round31_status_before.txt and round31_status_after.txt. Preserve unrelated setup/auth/installer/frontend/schema/SDK work. Stage only our pitr source/test hunk, own changelog entry, Mac table and selected audit artifacts.

### Next scope (if rounds continue)
apps/server/src/lib/pitr.ts prune/backup/recovery exclusion and nearest tests: ownership while an engine prune is suspended.
