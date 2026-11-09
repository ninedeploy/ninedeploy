# Evidence audit — file-to-command input — 2026-11-09

## Round 5 — File-to-stdin child streaming
### Summary
No reproduced finding or production patch. The small helper and nearest tests were read in full; source is unchanged. Binary transfer, unreadable-input cleanup and a non-draining child's timeout are covered by real child-process fixtures; this is not a general process-isolation certification.

### Toolchain
Root/server package.json and configs: TypeScript ^7.0.2, Node v26.13.0, pnpm 11.23.0, Vitest ^5.0.5 with V8 coverage and serial server files, tsc build/typecheck, Biome ^2.5.14 (formatter disabled). No race detector/sanitizer configured. CONTRIBUTING.md applies; no nested instructions found. No dependencies installed.

### Findings
None. No prove_/verify_ or source change manufactured for an unproven observation.

### Invariants inspected
- Spawn uses an argv array and the existing sanitized buildEnv, not a shell.
- The child is tracked for deploy cancellation, with listeners registered before event-loop delivery of spawn error/close.
- Input pipeline errors kill and drain the child; timeout is distinguished from generic input/exit/spawn failures; no dump bytes or stderr are retained in the returned error.
- Pipeline owns and destroys the file/stdin streams; the timer is cleared in finally. Closed child completion can precede pipeline failure without losing the close result, because closed is registered first.
- Callers in backupRestoreVerification.ts use fixed finite timeouts and generated private backup paths. Arbitrary invalid timeout values/untrusted executables were not established as reachable caller inputs.

### Not reproduced (dropped)
No runnable failing candidate. Synchronous spawn failure before a child exists, early child close and caller cancellation were inspected against real event ordering/trackDeployChild; no unsupported product or security claim.

### Validation
- Focused/scope tests: cwd apps/server, `pnpm.cmd exec vitest run test/lib/fileCommandInput.test.ts test/lib/backupRestoreVerification.test.ts --coverage=false --reporter=verbose` → 2 files / 74 passed, exit 0 (audit_continuous_20261109/round5_file_input_tests.log). Nearest helper tests transfer 1 MiB of exact binary bytes into a real child, reject missing input and time out a child that does not consume stdin.
- Build/typecheck: NOT RUN again — no production/type changes in this scope; the previous round's project build/typecheck passed. No fresh whole-tree compilation claim for concurrently edited unrelated modules.
- Format/lint (scoped): `pnpm.cmd exec biome lint apps/server/src/lib/fileCommandInput.ts apps/server/test/lib/fileCommandInput.test.ts` → exit 0 (round5_file_input_lint.log). Formatter NOT RUN, disabled.
- git diff --check: exit 0. Scope-only git diff is empty.
- NOT RUN: full suites/coverage, live Docker restore and hosted CI — no patch and bounded helper review. Existing timeout tests are validation, not a new timing/performance proof.

### Boundaries
Several shell spawns were denied before execution and succeeded unchanged on retry; these are host environment behavior, not product findings. Service-capability work continues outside scope. No live providers or privileged boundary exercised.

### Working tree
Baseline/current shared status recorded during review; final listing retained in audit_continuous_20261109/round5_status.txt. All dirty service-capability/server/web/schema/SDK paths belong to concurrent work and were not edited, staged, reverted or committed in this round. Own source/test diff is empty. Ledger/logs are retained; no cleanup.

### Next scope (if rounds continue)
apps/server/src/lib/backupRemote.ts and test/lib/backupRemote.test.ts — remote-object provenance, missing destinations and failed-fetch cleanup.
