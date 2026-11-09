## Round 56 — shared certificate scheduler admission
### Summary
Scope confirmed: apps/server/src/plugins/sharedCertificateSync.ts and apps/server/test/lib/sharedCertificateSync.test.ts; lib/sharedCertificates.ts and engine/proxy.ts read-only consumers/dependencies. Setup status: unrelated CHANGELOG.md and untracked apps/cli/src/lib/importers/ preserved. User authorized independent continuous scopes and commit/push.
### Toolchain
apps/server/package.json: Node supported ^22.23.4 || ^24.22.1 || ^26.12.1, TypeScript7.0.2, server typecheck/build tsc; root configured Vitest5.0.5 and Biome2.5.14. Existing audit config uses isolated temp data and serial files. No new dependency.
### Invariants
One admitted tick owns the entire async settings-read/render path. After owner close, a pending settings read cannot admit a new proxy render. Already-admitted renders may finish. Failed/disabled/missing-file ticks release admission for retry; unchanged mtime does not render.
### Findings
Pending runnable proof; no source patch.
### Validation
Pending.
### Boundaries
Controlled dependency seams and actual Fastify lifecycle; no live proxy/provider/ACME mutation, multi-process lock or in-flight render cancellation claim.
### F1074 — race / lifecycle — Medium — scheduler admission begins too late
Location: sharedCertificateSync.ts tick: busy is tested before sharedCertificatesEnabled await, but reserved only immediately before writeDynamicConfig. Two interval callbacks can therefore both cross the same changed-mtime check and render concurrently. Close clears only future timer ticks, allowing a settings-read already waiting to start a new render after close.
Before proof: pnpm exec vitest run --config .temp_files/audit_continuous_20261109/F1073.config.ts .temp_files/audit_continuous_20261109/prove_F1074_sharedCertificate.test.ts --reporter=verbose -> Vitest exit1, 2 failed / 1 unaffected control passed (F1074_before.log). EXPECTED1 settings admission/1 render ACTUAL2/2; EXPECTED0 renders after close ACTUAL1; PROBLEM CONFIRMED for both.
Root cause recorded before patch: admission ownership excludes the first async suspension, and owner liveness is never checked after that suspension. Narrow repair: reserve busy synchronously for the entire tick under finally; closed guard at entry and immediately after enabled read; close flips closed before clearing timer. Already admitted render can complete.
### Patch and completed verification
F1074: busy now reserved before any await and released through finally; closed flag checked before work and after enabled read, flipped by onClose before clearInterval. No wire/config/persistence/public API changes.
Original proof after: F1074_after.log ->3 passed; PROBLEM NOT REPRODUCED for both cases. Independent verifier10 cases x3 clean invocations (F1074_verify1/2/3.log), each FIX VERIFIED. Includes disabled/missing/read-failure/unchanged retry, failed render preserving retry, gated rendering with later renewal, gated settings overlap, close-before-tick/retained callback, close-during-settings, admitted-render-after-close.
Permanent apps/server/test/lib/sharedCertificateSync.test.ts: before source patch 2 failed /1 control passed (F1074_permanent_before.log); narrow owned source bytes restored immediately after deliberate red run. After7 passed/2 files with lib/sharedCertificates.test.ts (F1074_scope_final.log).
Commands: pnpm --dir apps/server exec vitest run test/lib/sharedCertificateSync.test.ts test/lib/sharedCertificates.test.ts --coverage=false --reporter=verbose ->7 passed/2files. GOMAXPROCS=4 pnpm --dir apps/server typecheck and build ->exit0 (F1074_typecheck.log/F1074_build.log). pnpm exec biome check apps/server/src/plugins/sharedCertificateSync.ts apps/server/test/lib/sharedCertificateSync.test.ts ->2files passed (formatter configured disabled). git diff --check ->exit0.
Full coverage/repository release gate, live certificate renewal, Docker, native Mac bootstrap NOT RUN: this is isolated scheduler behavior, not release/native acceptance. Fake interval clock with explicit promise gates; no sleep races; no race detector configured for TS.
### Working tree preservation
Unrelated CHANGELOG.md ordering hunk and CLI importers remain untouched; own changelog entry staged from HEAD via Unreleased-only helper. Owned source/test/docs/evidence only are selected for publication.
### Next scope
Select another concrete independent lifecycle/I/O path after publishing this bounded round.
Publication preflight: initial cached diff check caught an extra blank EOF in own newly created permanent test; only that whitespace normalized. Repeated selected-scope diff and limited staged credential/runtime/index-line-ending scan passed (23 owned paths); no unrelated files staged. No comprehensive security certification implied.
