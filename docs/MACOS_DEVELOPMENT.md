# Developing on macOS and continuing work from another computer

Use a Mac for native desktop packaging and Keychain acceptance. Panel/API unit
tests and source audits can also run on Windows or Linux. The production
installer and systemd/UFW behavior still need Linux; a Mac is not a replacement
for those runtime checks.

This guide describes a reproducible setup, not a claim that this checkout was
tested on a physical Mac. The November 9 handoff was prepared on Windows.

## Open the same source revision

On a fresh Mac checkout:

```sh
git clone https://github.com/ninedeploy/ninedeploy.git
cd ninedeploy
git status --short
git rev-parse HEAD
```

For an existing checkout, inspect `git status --short` first and preserve local
work before updating. On `main`, when clean, `git pull --ff-only origin main` gets the
pushed handoff without creating a merge. Record the commit in the Mac's results.

Install Node using the exact version in [`.node-version`](../.node-version).
The supported security range is enforced by
[`scripts/check-node-version.mjs`](../scripts/check-node-version.mjs).
Use the pnpm version in the root `package.json` (`pnpm@11.23.0` at this handoff).
If Node is installed but pnpm is missing:

```sh
npm install --global pnpm@11.23.0
node scripts/check-node-version.mjs
pnpm --version
```

Install Apple's Command Line Tools with `xcode-select --install` if
`xcode-select -p` fails, finish its installer, and retry. Use the Mac's native
terminal architecture (`uname -m`): install native Node/dependencies rather than
copying Windows `node_modules`, build output or Electron binaries.

Install/start your Linux-container Docker environment only if you will exercise
the panel's Docker runtime. Check `docker context show`, `docker info` and
`docker compose version` before any deployment smoke. The panel controls the
selected daemon; use an isolated daemon for runtime acceptance, as
[CONTRIBUTING.md](../CONTRIBUTING.md) requires.

## Check and bootstrap

The helper runs from any working directory. Its default mode only checks
prerequisites; `--install` explicitly installs the locked dependencies and
builds both projects. It does not start a panel, Docker daemon or GUI.

```sh
node scripts/dev-macos.mjs --check
node scripts/dev-macos.mjs --check --docker  # also check a Linux Docker engine
node scripts/dev-macos.mjs --install
```

The root workspace and `desktop/` have **independent lockfiles**. Root install or
build does not install/build Electron. The helper runs root
`pnpm install --frozen-lockfile` and `pnpm build`, then installs, typechecks,
tests and builds `desktop/` separately. It never updates either lockfile.

Do not copy `.env`, `.data`, master keys, database files, production backups,
tokens or signing certificates between computers as a development setup step.
Use disposable local configuration and fixtures. A copied SQLite database also
needs its original encryption keys; a clean development installation does not.

## Panel/API development

After the workspace build:

```sh
pnpm typecheck
pnpm lint
pnpm turbo run test --concurrency=1
```

Tests that write coverage must run serially. Do not launch a second full suite
while the first is writing. The server test configuration supplies a fresh data
directory for each invocation.

For a focused audit, run the relevant Vitest files in `apps/server`, for example:

```sh
cd apps/server
pnpm exec vitest run test/lib/webhooks.test.ts test/runtimeState.test.ts --coverage=false
cd ../..
```

To run the app, prepare a **local** `.env` following
[Quickstart: local development](QUICKSTART.md#-3-local-development-from-source).
Run `pnpm dev` and `pnpm dev:web` in separate terminals. This starts the panel
and its background plugins against your configured Docker daemon; do that only
after selecting your development daemon.

For the complete repository gate, run `pnpm release:check`. A successful desktop
unit suite or an individual audit scope is not a full release verdict.

## Desktop development and native acceptance

From `desktop/`, use the project's existing commands:

```sh
cd desktop
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm start                         # interactive unpackaged app
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist
pnpm smoke                        # packaged app, temporary user-data directory
```

`pnpm dist` builds Intel and Apple-silicon DMGs according to
[`electron-builder.yml`](../desktop/electron-builder.yml). Run the packaged app
matching the current Mac's architecture. Building both architectures on one
computer does not prove that both launch natively.

The smoke script uses a disposable loopback panel and the Chromium debugging
port 9339. Close any earlier smoke instance before another run. It checks the
launcher, bridge isolation, encrypted token storage, restart and instance
removal. It does not sign into a production panel.

Test the **installed copy** too, rather than only `release/mac*/NineDeploy.app`:

1. Mount the DMG matching the Mac's architecture in Finder.
2. Copy `NineDeploy.app` to your chosen Applications directory and eject the DMG.
3. Run the smoke against that copy, using its real executable path, for example:
   `pnpm smoke /Applications/NineDeploy.app/Contents/MacOS/NineDeploy`.
4. Open the installed app normally and check its instance list, adding/opening
   a development instance, sign-out, removal and Cmd+Shift+O.
5. Record macOS version, architecture, source commit, app/signing state and
   whether a token actually survived a normal quit and restart.

For unsigned local builds, follow the normal macOS Privacy & Security approval
if needed. Do not disable Gatekeeper or use a sandbox-disable flag as acceptance.
Signing/notarization is optional for local development. Certificate/Apple API
secrets belong in the existing Desktop workflow's secret inputs, not in Git or
this guide; see [Desktop signing](DESKTOP.md#installing).

### Keychain: acceptance versus fallback

Leave `ND_SMOKE_KEYCHAIN_UNREACHABLE` unset when checking a real Mac's persistence.
If the unlocked login Keychain grants access, the token must survive a normal
quit/restart and disappear after instance removal.

The existing CI workflow sets `ND_SMOKE_KEYCHAIN_UNREACHABLE=1` because its
unsigned app cannot keep its Keychain key on that runner. That mode verifies
safe fallback, **not persistent sign-in**. If a local unsigned build encounters
the same problem, record it separately; do not turn on that flag to call the
normal persistence check passed. A signed build or explicit Keychain access
may be needed to close the remaining acceptance gap.

## Handoff: audit state on November 9, 2026

The first seven requested scopes were reviewed: settings ownership, Swarm
recovery, runtime reconciliation, backup scheduling/policy, restore
verification/drills, node sleep coordination and webhook delivery.

- **F1034:** webhook delivery replay IDs now include provider and service scope.
  Previously the same ID could suppress another service's legitimate event.
- **F1035:** unreadable local/fan-out Docker inspections no longer report a
  container missing without Docker's explicit missing-container/object reply.
- Seven permanent regression cases were observed failing before the changes
  and passing afterward. The combined seven-scope run passed **519 tests in
  23 files**; server typecheck/build, scoped lint and `git diff --check` passed.
- **F1036:** failed image-removal accounting now credits an image only when
  follow-up inspection explicitly confirms absence; unknown inspect errors no
  longer claim reclaimed space. Its before-proof failed on current code and
  four new permanent regression cases were observed red before the patch.
  The expanded verifier passed three consecutive runs; all 76 tests in the
  four-file release-image scope passed afterward.
- These were Windows/local observations. Hosted CI, Linux runtime and
  physical-Mac results must be recorded separately for the pushed commit.

The user authorized continued proof-led audit rounds with independently chosen
scopes until asked to stop. The second completed scope covers
`apps/server/src/lib/releaseImageRetention.ts`, `releaseRecords.ts` and their
`imageInventory.ts` dependency, plus their tests. F1036 was fixed and verified
in that round. The next selected scope is `apps/server/src/lib/backupReplicas.ts`
and `test/lib/backupReplicas.test.ts`. Continue by recording current Git status, reading any
existing ledger, and writing a failing executable proof before editing source.

The earlier working tree also contained panel IP-access policy, portable
service settings and several focused server fixes. The user requested those
existing changes be included in the commit/push for cross-machine continuation;
their validation must not be inferred from the 519-test audit result.

### Local handoff checks and remaining boundary

The handoff also passed workspace typecheck, lint and build; the full web suite
passed **2,800 tests**, SDK **388 tests with 100% coverage**, schemas **803**,
database **84**, plugin SDK **7**, MCP **49**, and CLI **1,067**. The first SDK run
failed its coverage floor because the new panel-access methods had no tests;
authenticated read/update/lockout-error transport tests closed that gap without
lowering thresholds. A manifest UI test failed once in a complete web run;
the unchanged file passed all 139 cases in isolation and the next complete web
run passed. No assertion or timeout was weakened.

The targeted server run covering the changed features and release-image scope
passed **1,793 tests in 27 files** before F1036's narrow patch. Desktop
typecheck, **27 unit tests** and bundling passed on Windows. The macOS setup
helper passed Node syntax and Biome checks, its help command ran, and its Mac
check refused Windows as intended. Native Mac bootstrap/DMG/Keychain execution
remains unverified.

The complete `pnpm release:check` did **not** finish green: its server coverage
step was refused because another Vitest process already owned
`apps/server/coverage`. That process was left running; its lock/report directory
was not deleted, overridden or redirected. Run the full gate after that owner
finishes (or in this fresh Mac checkout) and record the result for this commit.
This is a development handoff, not a certified release.

For each next audit round, retain `prove_*`, `verify_*` and a ledger; run the
verifier three times; promote High/Critical and race/ownership findings into
the normal suite. Preserve unrelated edits. Do not commit runtime data or
credentials. The `.temp_files/` directory is ignored by default; any explicitly
committed handoff evidence is selected individually, not the entire historical
scratch directory.

### Continued audit evidence through November 9, round 14

The following additional fixes were committed and pushed after the initial
Mac handoff. Counts are per bounded scope run, not unique aggregate coverage.
Each fix includes a before-proof, three independent verifier runs, a permanent
regression and successful server typecheck/build plus scoped lint.

| Finding | Change | Commit | Scope tests |
| --- | --- | --- | --- |
| F1037 | Recheck replica retention policy before each delete | `54f9e936` | 48 |
| F1038 | Reject truncated encrypted envelopes before opening output | `ee5b225a` | 186 |
| F1039 | Fill short S3 multipart reads; abort premature EOF | `b0432ce8` | 152 |
| F1040 | Cancel unused S3 cache-miss response bodies | `3a8e9e8d` | 86 |
| F1041 | Resolve Compose workspaces under a filesystem root | `8c6d71ab` | 126 |
| F1042 | Restore absent paths during failed system-import rollback | `9ceaf094` | 27 |
| F1043 | Give concurrent source uploads separate pending files | `1881b72f` | 35 |

F1039's first six-file scope run failed an existing real-timer slow-download
test; an unchanged repeat passed all 152 tests. Both logs are retained, and
this is not claimed to be a demonstrated failure on the base revision.

Additional passes produced no new confirmed defect: file-command input (74
tests), remote backup selection (114), cross-process locks (9), release records
(30), and panel upstream reachability/sleep callers (41). Source was not changed
for these passes. The lock implementation's documented residual stale-takeover
window is not claimed resolved.

Current-round evidence is selected under
[`.temp_files/audit_continuous_20261109/`](../.temp_files/audit_continuous_20261109/).
Ledger files record exact commands, failed attempts and environment boundaries.
Use `git log` to identify any later rounds before resuming. These focused
Windows checks do not replace the still-required full release gate, native Mac
DMG/Keychain checks, Linux installer checks or live Docker/provider acceptance.

### Optional native Linux-container probe regression

The continued audit also ran the real BusyBox probe on Windows Docker Desktop's
Linux engine. F1044 covers an uncommon compatibility edge: a server emitting
informational responses despite the probe's HTTP/1.0 request. The client now
reads through them to the final status; 101 protocol switching remains unready.
This is not a claim that compliant HTTP/1.0 servers normally send Early Hints.

With Linux Docker reachable and `busybox:1.36` already available locally, run
the committed integration test explicitly from the repository root:

```sh
pnpm exec vitest run --config .temp_files/audit_continuous_20261109/F1044.integration.config.ts --reporter=verbose
```

The normal server suite excludes integration tests. This test creates only
UUID-named internal networks and fixture containers, publishes no host ports,
and removes its owned resources. Its fixture uses `--pull=never`; preload the
image intentionally before running on a fresh Mac. The independent native
verifier exercised seven final-status/error cases three times; 26 neighboring
unit tests passed. This does not exercise Electron or macOS Keychain.

### Further audit checkpoints through round 32

Additional committed evidence is under `.temp_files/audit_continuous_20261109/`:

| Finding | Behavior verified | Bounded scope tests |
| --- | --- | --- |
| F1045 | Failed TAR staging writes/final moves clean their own files and preserve history | 37 |
| F1046 | Partial ZIP writes preserve prior accepted source; retries remain extractable | 39 |
| F1047 | Loki searches retain working drain tenant/custom headers and Bearer context | 77 |
| F1048 | Log delivery/search header precedence is independent of field-name case | 110 |
| F1049 | Query endpoints retain reverse-proxy prefixes from standard Loki push URLs | 64 |
| F1050 | Panel retention rechecks destination and keep count before each delete; already-deleted objects do not consume retention slots | 26 |
| F1051 | A scheduler tick suspended in a settings read cannot start a backup after its application closes | 29 |
| F1052 | PITR maintenance reloads persisted retention before pruning after long archiver/base-backup calls | 51 |
| F1053 | Concurrent PITR admissions reserve capacity before name/volume checks and release it on admission failure | 53 |
| F1054 | Active PITR pruning excludes new same-archive users; backup HTTP admission returns a conflict while pruning | 58 |

Counts belong to each round's recorded source snapshot and are not aggregate
or full-suite coverage. Each fix has a before-proof, an independent verifier
with three clean consecutive runs, permanent regression coverage and scoped
server typecheck/build/lint results. Failed setup/worker attempts remain in the
ledger rather than being counted as passes.

Rounds 28–29 found no new defect: PITR scheduler close/overlap gates passed five
additional cases plus its two existing tests; recovery-helper housekeeping passed
12 boundary cases and 57 neighboring tests. These are bounded passes, not live
PostgreSQL or Docker cleanup certification.

Round 30's original Windows typecheck failed with a native TypeScript/Go
`VirtualAlloc` error (`errno=1455`). A serial retry with `GOMAXPROCS=4` passed
server typecheck and build; the temporary environment setting was restored.
The interrupted initial scope run was not counted; the unchanged retry passed
all 51 tests. Keep these resource limits distinct from a full default-environment
release gate on the Mac. Rounds 31–32 likewise passed server typecheck/build with
the child-process `GOMAXPROCS=4` resource bound; round 31's independent admission
verifier passed eight cases three times. Round 32's prune-ownership verifier
passed ten cases three times, including failure cleanup and other-archive controls.

At checkpoint 20 the general release gate stopped on an uncovered SDK method
from the concurrent service-capability feature. Two authenticated SDK transport
tests closed that gap: **390 tests passed with 100% in all four coverage
measures** at that snapshot. The general-gate retry then suffered native
Node/V8 worker allocation failures, so its incomplete coverage report is not a
completed coverage result. The retry did not certify the repository.

Other update-channel/installer/resources work continued concurrently and is
tracked separately. Preserve local edits, inspect the current commit/status,
then run the full release gate on the fresh Mac checkout; do not lower coverage
floors to bypass an incomplete worker run. See
[the checkpoint ledger](../.temp_files/ledger_release-checkpoint20_20261109.md)
for commands and exact boundaries. Native DMG/Keychain and Linux installer/live
provider acceptance remain separate checks.
