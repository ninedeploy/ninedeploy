# Evidence ledger

Scope: apps/server/src/kernel/drivers/s3BuildCache.ts (source) + apps/server/test/kernel/s3BuildCache.test.ts (nearest test)

## Setup evidence
- Repository instructions: .temp_files/run_20261007/BRIEF.md; C:\Users\ersin\.claude\skills\evidence-audit\SKILL.md + assets/ledger-template.md. No AGENTS.md in scope dir.
- Baseline: `git status --short` for both scope files was empty (unmodified vs HEAD) at round start; sha256 snapshot saved in
  .temp_files/run_20261007/apps-server-src-kernel-drivers-s3BuildCache.baseline.txt
  (s3BuildCache.ts 19f6a4c9…, s3BuildCache.test.ts b0a91a87…). Tree has many other writers' modifications (not touched).
- Invariants:
  - key → object-key mapping must be injective: lookup() trusts any parseable marker at objectKeyFor(prefix,key) as THIS key's content (no DB row to cross-check, unlike the registry driver).
  - Object keys must stay within S3's 1024-byte limit for every accepted key.
  - lookup() never reports a hit for anything but a parsed `sha256:` marker; non-200 / non-marker = miss.
  - store() counts a store only after a 2xx PUT (r186).
  - Trust boundary: keys arrive verbatim from POST /v1/build-cache/store (operator-gated, any non-empty string) and from buildCacheKey() (`ndbuild:<24 hex>`).
  - No suspension-point ownership state: counters are synchronous; no DB row; S3 PUT is last-writer-wins on one object.

## Round 1 — apps/server/src/kernel/drivers/s3BuildCache.ts (run N039, 2026-10-07)
### Summary
1 confirmed (F272, Low, input-handling), patched, verified 3x, promoted. 10 candidates dropped/not pursued. Reserved F273–F275 unused.
Residual risk: store() of a marker whose digest is not `sha256:`-prefixed returns a ref lookup() can never resolve (lead below, cross-scope contract).

### Toolchain
- TypeScript, Node >=22.13 (root package.json engines; dev box Node 24), pnpm workspaces + turbo.
- Tests: vitest 5.0.1 (apps/server/vitest.config.ts); proofs via `.temp_files/audit.vitest.config.ts`.
- Typecheck: `cd apps/server && node ../../node_modules/typescript/bin/tsc --noEmit -p .`
- Lint: biome (biome.json; linter enabled, formatter `"enabled": false`).
- No race detector / sanitizer configured.
- S3 seam: lib/s3.ts s3Request() calls GLOBAL fetch → faked by replacing globalThis.fetch
  (.temp_files/run_20261007/s3BuildCache/fakeS3.ts refuses any non-fake origin; proofs assert the fake served the calls). No network.

### Findings
#### F272 — input-handling — Low — objectKeyFor() aliases distinct cache keys onto one S3 marker object (foreign digest read as a hit; cross-key eviction; long keys overflow S3's 1024-byte limit)
- Location: apps/server/src/kernel/drivers/s3BuildCache.ts `objectKeyFor()` (pre-fix lines 187–193).
- Severity reason: Low — keys from the deploy pipeline are canonical `ndbuild:<hex>` and never alias each other; aliasing needs a non-canonical key via the operator-gated /store route (same rating as sibling F188).
- Root cause: `key.replace(/[^A-Za-z0-9._-]/g, '_')` folds every disallowed char to `_` without escaping `_` itself, so the mapping is many-to-one (`ndbuild:abc`≡`ndbuild_abc`, `svc/1`≡`svc:1`, `café`≡`cafè`), and it is unbounded (key length passes straight into the object key). lookup() trusts whatever marker sits at the mapped key.
- Proof (before): .temp_files/prove_F272_s3_object_key_alias.test.ts
  cmd: `DOCKER_HOST=tcp://127.0.0.1:9 node node_modules/vitest/vitest.mjs run --config .temp_files/audit.vitest.config.ts .temp_files/prove_F272_s3_object_key_alias.test.ts` → EXIT=1
  ```
  CONTROL: canonical hit=true unrelated miss=true
  case1 EXPECTED: lookup('ndbuild_abc') = null (never stored)
  case1 ACTUAL:   lookup('ndbuild_abc') = sha256:aaaa…
  case2 EXPECTED: lookup('svc/1') = sha256:aaaa…
  case2 ACTUAL:   lookup('svc/1') = sha256:bbbb…
  case3 EXPECTED: lookup('cafè') = null (never stored)
  case3 ACTUAL:   lookup('cafè') = sha256:cccc…
  case4 EXPECTED: store(<1108-char key>) ok, lookup = sha256:dddd…
  case4 ACTUAL:   store error=S3 build-cache PUT failed (HTTP 400) lookup=null
  PROBLEM CONFIRMED (case1, case2, case3, case4)
  ```
- Patch: apps/server/src/kernel/drivers/s3BuildCache.ts — added `CANONICAL_KEY = /^ndbuild:[A-Za-z0-9._-]{1,200}$/`; objectKeyFor() maps canonical keys to `ndbuild_<suffix>` (unchanged object name → live caches stay warm) and every other key to `h-<sha256(key)>`. Namespaces disjoint (`ndbuild_` vs `h-`); canonical part injective (fixed `ndbuild:`→`ndbuild_`, suffix untouched); hashed part fixed length. Mirrors the F188 fix in registryBuildCache.tagFor(). No API/config/wire change; non-canonical keys' object names change (one cold miss for those keys only).
- Proof (after): .temp_files/verify_F272_s3_object_key_alias.test.ts (repro + edges: canonical pre-fix object name preserved and pre-fix marker still readable; 200-char suffix boundary vs 201 → hashed; raw key spelled like a hashed name does not alias; repeated store = one object; prefixes still isolate)
  3 consecutive runs: `Tests 5 passed (5)` EXIT=0 ×3, prints `FIX VERIFIED` (afterAll gated on 5/5).
  Original proof re-run: all cases ACTUAL==EXPECTED, `PROBLEM NOT REPRODUCED`, EXIT=0.
- Regression test: apps/server/test/kernel/s3BuildCache.test.ts, describe "S3BuildCache key → object-key mapping (F272 regression)" (2 tests). Promoted although Low (consistent with F188: guards the injectivity invariant lookup() relies on). Both fail against the git-HEAD driver:
  `node node_modules/vitest/vitest.mjs run --config .temp_files/run_20261007/s3BuildCache/vitest.orig.config.ts` → `Tests 2 failed | 13 passed (15)` (log: run_20261007/s3BuildCache/promoted_vs_HEAD.log).

### Not reproduced (dropped)
- Lead (not proven this round, not pursued): buildkit stores `{digest: RepoDigests[0]}` (`repo@sha256:…`) when present; S3 parseMarker rejects non-`sha256:` digests, so store() returns a placeholder ref + counts a store while lookup() misses forever (violates IBuildCache "returned ref valid for lookup()"). Existing test "records a miss when the stored body is not one of our markers" codifies non-marker→miss; the fix (accept image refs vs canonicalise the body) is a buildkit.ts/types.ts contract decision — lead for those files.
- Concurrent first store → divergence: no DB row; one S3 object, last-writer-wins; nothing to diverge (by construction).
- Errors read as hits: non-200 → miss, 200 non-marker → miss, only parsed `sha256:` markers hit; no path found.
- S3 credentials in logs/errors: messages carry only HTTP status; supplier errors swallowed; creds never in URL/object key.
- Missing timeout: s3Request applies AbortSignal.timeout(120 s) to every call incl. body read.
- Partial upload accepted: single PUT, `!res.ok` throws (r186); S3 PUT is atomic.
- Eviction deleting another key's object: driver never deletes (lifecycle is operator's); cross-key overwrite is F272 case2.
- lookup().storedAt is Last-Modified HTTP-date, not ISO — no consumer of lookup().storedAt today; not pursued.
- Prefix without trailing `/` concatenates into the key; a cross-prefix collision needs contrived prefixes; not pursued.
- lookup() throws on transport error (registry swallows) — buildkit catches; contract only forbids throwing on a missing key.

### Validation
- Focused tests: prove_F272 + verify_F272 (audit config, --reporter=verbose) → `Test Files 2 passed (2) Tests 6 passed (6)`; verify ×3 → 5/5 each; PROBLEM NOT REPRODUCED.
- Scope tests: `cd apps/server && DOCKER_HOST=tcp://127.0.0.1:9 node ../../node_modules/vitest/vitest.mjs run test/kernel/s3BuildCache.test.ts --coverage=false` → `Tests 15 passed (15)`.
- Build/typecheck: `cd apps/server && node ../../node_modules/typescript/bin/tsc --noEmit -p .` → exit 0, no output.
- Format/lint (scoped): `node node_modules/@biomejs/biome/bin/biome lint <2 files>` → `Checked 2 files … No fixes applied.`; `biome format` → NOT RUN effectively: formatter disabled in biome.json (`"formatter": {"enabled": false}`), biome reports paths ignored.
- git diff --check -- <2 files>: clean (exit 0).
- NOT RUN: full server suite (shared CPU/temp dirs with concurrent agents, per brief); live S3 (no network by rule).

### Boundaries
- Working copy uses core.autocrlf=true (CRLF in worktree, LF in index); appended test lines normalised to CRLF to match the file (264 CRLF / 264 LF). No tsc errors from other writers observed.
- Patch saved: .temp_files/run_20261007/apps-server-src-kernel-drivers-s3BuildCache.patch.

### Working tree
- Modified by this round (outside .temp_files): apps/server/src/kernel/drivers/s3BuildCache.ts, apps/server/test/kernel/s3BuildCache.test.ts (both clean vs HEAD at start; diff: 44 insertions, 5 deletions).
- Created: .temp_files/prove_F272_s3_object_key_alias.test.ts, .temp_files/verify_F272_s3_object_key_alias.test.ts, .temp_files/run_20261007/s3BuildCache/{fakeS3.ts,s3BuildCache.orig.ts,vitest.orig.config.ts,promoted_vs_HEAD.log}, baseline + patch files, this ledger. No other file touched.

### Next scope (if rounds continue)
apps/server/src/engine/builders/buildkit.ts ↔ IBuildCache digest contract — image-ref markers vs `sha256:`-only parsers make S3/registry caches unusable for --cache-from.

## Continuous round 9 setup — 2026-11-09
- Scope confirmed: apps/server/src/kernel/drivers/s3BuildCache.ts, apps/server/test/kernel/s3BuildCache.test.ts, required narrow CHANGELOG entry if a finding is proven. Starting HEAD b0432ce8; status in round9_status_before.txt. Both scope files clean. Historical F272 retained; F1040 allocated next.
- CONTRIBUTING and current toolchain inherited from immediately preceding checked manifests: Node26.13.0/pnpm11.23.0/TypeScript7/Vitest5.0.5/Biome2.5.14; server serial files, V8 coverage configured, formatter disabled, no race/sanitizer. No installs.
- Source, nearest tests, historical ledger and lookup callers read. This is a marker cache, not file restoration; the initial progress description was broader than the actual implementation.
- Invariants: one lookup is a hit only for a valid marker; non-200 means miss; every response body is consumed or canceled before the call relinquishes ownership; errors while discarding a miss body must not turn a miss into a build failure.
- Candidate: non-200 lookup returns without reading/canceling its body. Official transport ownership reference: https://github.com/nodejs/undici#garbage-collection (consume or cancel rather than relying on Node garbage collection). Local seam proof claims only unreleased response ownership, not measured live pool exhaustion.

### F1040 root cause before patch
- resource-leak, Medium: lookup owns a non-200 fetch Response but returns null without releasing its body; repeated misses can retain transport resources. Proof establishes open stream ownership only, not measured live saturation.
- F1040_before.log: full-hit control bodyUsed=true; 404 cancelled=false/bodyUsed=false; PROBLEM CONFIRMED, assertion exit1.
- Narrow patch: await optional body.cancel with rejection swallowed on the existing non-200 branch, then retain the existing miss counter/return behavior. No API/config/schema change or dependency. Promote lifecycle coverage with gated cancel completion.

## Round 9 — S3 build-cache response ownership
### Summary
One Medium resource leak confirmed, patched and promoted; proof is local response-body ownership, not live connection-pool exhaustion.
### Toolchain
Current toolchain recorded above from checked manifests/config. No dependencies or tool configuration changed.
### Findings
#### F1040 — resource-leak — Medium — cache misses abandon response bodies
- Location: apps/server/src/kernel/drivers/s3BuildCache.ts:113, S3BuildCache.lookup non-200 branch.
- Root cause: lookup returned null without consuming/canceling the fetch body it owned. Node transport ownership reference: https://github.com/nodejs/undici#garbage-collection.
- Proof (before): audit_continuous_20261109/prove_F1040_s3_cache_body.test.ts, F1040_before.log exit1: hit control bodyUsed=true; 404 cancelled=false/bodyUsed=false; PROBLEM CONFIRMED.
- Patch: await optional body cancellation and ignore cancellation rejection before the existing miss count/return. No API/schema/config/wire change, no dependency.
- Proof (after): unchanged original exit0, cancelled=true/bodyUsed=true, PROBLEM NOT REPRODUCED. Independent verify_F1040_s3_cache_body.test.ts runs 1/2/3 first passed; then strengthened gated verifier ran three consecutive times (F1040_gated_verify_1..3.log), each FIX VERIFIED. Six statuses with ordinary/rejected/null-body cleanup, successful marker consumption, explicit cancel-enter/release gates; 19 final misses/one hit.
- Regression test: apps/server/test/kernel/s3BuildCache.test.ts, four new cases: 403/404/500 cancellations and gated rejected cancellation preserving the miss. Before 4 failed/16 passed; after 20 passed. No sleeps in new lifecycle checks.
### Not reproduced (dropped)
None new; previous mapping finding F272 retained, no speculative rewrite.
### Validation
- Focused: root pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts with named proof/verifier --reporter=verbose: original after and gated verifier three times passed.
- Scope: pnpm --dir apps/server exec vitest run test/kernel/s3BuildCache.test.ts test/kernel/buildCachePlugin.test.ts test/kernel/inlineBuildCache.test.ts test/kernel/registryBuildCache.test.ts test/modules/buildCache.test.ts test/lib/buildCacheKey.test.ts --coverage=false: 86 passed/6 files.
- Build/typecheck: pnpm --dir apps/server typecheck and build each exit0, retained F1040 logs.
- Format/lint: pnpm exec biome lint apps/server/src/kernel/drivers/s3BuildCache.ts apps/server/test/kernel/s3BuildCache.test.ts: 2 checked/no fixes; formatter disabled.
- git diff --check on changed paths: exit0.
- NOT RUN: fresh full repository/coverage/release gate, live S3/connection saturation, macOS acceptance. This bounded fix is not full release certification.
### Boundaries
Fake fetch supplies actual WHATWG Response/ReadableStream bodies. No external S3, network saturation, timing benchmark, security exploit or production outage claims. An rg command used a Windows-invalid wildcard path; corrected with discovered test paths, not a product failure.
### Working tree
Only driver/tests and the F1040 changelog entry are product scope; concurrent capability/localization/docs changes preserved. Evidence retained without cleanup.
### Next scope (if rounds continue)
apps/server/src/lib/composeWorkspace.ts and its nearest test — workspace copy/exclusion and failure cleanup.
