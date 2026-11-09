## Round 34 — macOS developer bootstrap and desktop CI evidence
### Summary
Scope confirmed: scripts/dev-macos.mjs, docs/MACOS_DEVELOPMENT.md, desktop manifests/build/test callers and .github/workflows/desktop.yml. Root CONTRIBUTING, helper, desktop package/workspace/build/electron-builder config, credential tests and workflow read before candidates. No product defect confirmed or source patch planned from observation alone.

### Toolchain
Root .node-version/package.json: Node 26.12.1 pin, supported ^22.23.4 || ^24.22.1 || ^26.12.1, pnpm 11.23.0. Live local Node 26.13.0. Desktop package.json has independent pnpm lockfile, TypeScript 7.0.2, Vitest 5.0.1, Electron 44.9.0, electron-builder 26.17.0 and esbuild 0.25.12. Its workspace allowBuilds explicitly allows Electron/esbuild postinstall. Existing Desktop CI uses pinned Node 26.12.1 and three OS runners. No tools installed by this audit.

### Invariants
- Bootstrap installs both frozen dependency graphs only on supported native macOS, without starting a panel/GUI/Docker daemon.
- Root/desktop pnpm pins and documented command order must match the actual manifests.
- Packaging and installed-DMG smoke may be attributed only to the run's exact source/OS/steps.
- Unsigned CI Keychain-unavailable fallback is distinct from ordinary login-Keychain restart persistence.
- Desktop CI is not full monorepo release certification or physical Intel/Apple-silicon acceptance.

### Findings
None confirmed; no production code or workflow patch. Updated the Mac handoff with concrete hosted evidence and remaining acceptance boundaries.

### Not reproduced (dropped)
No missing Electron build allowance: desktop/pnpm-workspace.yaml explicitly allows Electron/esbuild builds. Current root and desktop pnpm pins agree. Native bootstrap execution remains unavailable on Windows.

### Validation
- Existing latest successful Desktop run before this round: 42513944937, e85dbf45f08d2792bd4279d383037398384f6c9d, November 8. Historical evidence only.
- User-authorized Mac preparation/commit/push includes verification through the existing read-only-contents Desktop workflow. Triggered workflow_dispatch on main, run 42675648656: https://github.com/ninedeploy/ninedeploy/actions/runs/42675648656 . Exact source 9ac991cc0f1e14653db71dbc2dd22a71d9344191, confirmed by gh run view (round34_desktop_run.json).
- GitHub connector's commit-run wrapper lists PR runs only, so gh listed/dispatched the main/manual run. Connected GitHub workflow-job tools read subsequent jobs/steps.
- Final Desktop workflow conclusion: completed/success for the exact source above. All three jobs completed/success: Linux 129356172584, Windows 129356172614, macOS 129356172709 (round34_jobs_final.json).
- macOS image macos-26-arm64: frozen dependencies, typecheck and 27 unit tests/five files passed. Built both x64 and arm64 DMGs; unpacked arm64 client and installed-DMG arm64 copy smoke steps passed. Selected masked/ANSI-normalized evidence in round34_mac_log_excerpt.log; full signing logs were not copied into the repository.
- macOS signing/notarization steps skipped; log says installers unsigned. Both smoke calls used ND_SMOKE_KEYCHAIN_UNREACHABLE=1. Unpacked smoke accepted sealed/nonpersistent storage; installed copy reported no available OS store and no writes. Ordinary login-Keychain persistence NOT verified.
- Artifacts: macOS 13699453695 (263914933 bytes), Windows 13699433820 (120605264), Linux 13700945862 (224785787). All unexpired and bound to the exact run/source. Expire November 23. API metadata/digests retained in round34_artifacts.json; archives were not downloaded or independently hashed.
- API-reported macOS archive digest: sha256:f803beec497bde51250557ffaee4ed4c7ebe161f3ce19ef7df9cf1de874f5b81. Windows: sha256:d77134f366161e1123d0cd28e83edb752ba351c6dca8e0d798c4d844823fdcc5. Linux: sha256:97f2ad0e25064aa426b1ac5efd7a94592fd794fb8767ca6ff5f646cd079f64b2.
- node --check scripts/dev-macos.mjs -> exit 0 (round34_helper_syntax.log). --help -> exit 0, documented flags printed (round34_helper_help.log).
- node scripts/dev-macos.mjs --check on Windows -> expected/actual exit 1 before installation (round34_helper_platform.log). --check --install -> expected/actual exit 2 (round34_helper_args.log).
- pnpm exec biome lint scripts/dev-macos.mjs -> checked one file, no fixes, exit 0 (round34_helper_lint.log). No formatter changes.
- git diff --check and git diff --cached --check -> exit 0. Limited staged-content scan: 14 files, no common credential-pattern matches, runtime files/index line endings passed; not a comprehensive security audit. Tested desktop tree object: 6082a4bd9e56e1d901cb2a8f267feb501d71a11b.
- NOT RUN: native helper --check/--install and root build on the user's Mac; full monorepo release gate; signed/notarized/normal-Keychain/Intel-native acceptance. Hosted desktop-only run does not certify these.

### Boundaries
Workflow explicitly sets ND_SMOKE_KEYCHAIN_UNREACHABLE=1 on macOS, including installed-DMG smoke. This green job proves the recorded unsigned arm64 launch/fallback paths, not ordinary login-Keychain persistence, signatures/notarization, both architectures launching natively or root helper --install on a physical Mac. No release/publication workflow invoked; Desktop dist uses --publish never. Main CI's full panel gate was not evaluated from Desktop success.

### Working tree
Snapshots: audit_continuous_20261109/round34_status_before.txt and round34_status_after.txt. Concurrent auth/setup/installer/doctor edits preserved. Only handoff documentation and selected concrete CI/helper evidence will be committed/pushed, as authorized; no source/workflow change needed for this no-finding round.

### Next scope (if rounds continue)
apps/server/src/lib/instanceGitops.ts config/check ownership and nearest GitOps tests: stale check completion after configuration removal/replacement.
