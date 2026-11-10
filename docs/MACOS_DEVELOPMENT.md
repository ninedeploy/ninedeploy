# Developing on macOS and continuing work from another computer

Use a Mac for native desktop packaging and Keychain acceptance. Panel/API unit
tests and source audits can also run on Windows or Linux. The production
installer and systemd/UFW behavior still need Linux; a Mac is not a replacement
for those runtime checks.

This guide describes a reproducible setup, not a claim that this checkout was
tested on a physical Mac. The November 9 handoff was prepared on Windows.
The hosted macOS checkpoint below records which native CI checks subsequently passed.

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

### Further audit checkpoints through round 54

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
| F1055 | Closed GitOps schedulers stop new checks and suppress late drift/failure alerts | 21 |
| F1056 | GitOps check/apply results respect config replacement/removal, preserve cleared records and protect newer results | 31 |
| F1057 | Image scan schedulers suppress retained critical-result alerts after their application closes | 82 |
| F1058 | Working recurring jobs retain their deadlines while schedule-list refreshes wait or fail | 65 |
| F1059 | Scheduled deploy admission counts CI-waiting rows and atomically reserves shared queue capacity | 72 |
| F1060 | CI expiry sweeps preserve renewed leases and report only attempts actually transitioned to lost | 77 |
| F1061 | Concurrent CI claim/cancellation closes the current attempt and retires an unassigned losing claim | 80 |
| F1062 | Concurrent CI claims atomically reserve runner capacity and restore a losing unassigned job to its prior queue state | 83 |
| F1063 | Runner revocation fences lease creation and attempt publication; pending losses and newer owners are reconciled by attempt identity | 90 |
| F1064 | Cancellation-winning CI results return conflicts, close current attempt history and emit no result-success audit | 93 |
| F1065 | CI log admission and append serialize per file within the panel process, retaining byte order and idempotent overlapping retries | 96 |
| F1066 | Recoverable CI log file failures preserve prior bytes and roll back their sequence reservation for retry | 100 |
| F1067 | GitHub runner drains retain pending-entry identity across earlier job startup and online status awaits | 114 |
| F1068 | Changed runner settings stop further admissions in an old batch, including writes overlapping the final config read | 118 |
| F1069 | Pending GitHub jobs revalidate current repository/public/label policy before consuming runner slots | 122 |
| F1070 | Automated runner sweeps retain unreadable/unrecognized container states and keep explicit stop available | 127 |
| F1071 | Active self-hosted runners use confirmed GitHub busy/idle state instead of a hosted-runner container-age cutoff | 132 |
| F1072 | Unknown queued-job lookups retain work without a slot and force verification across later drain entry points | 138 |
| F1073 | Pending-job expiry is checked at admission after earlier startup and remote/config waits | 140 |

Counts belong to each round's recorded source snapshot and are not aggregate
or full-suite coverage. Each fix has a before-proof, an independent verifier
with three clean consecutive runs, permanent regression coverage and scoped
server typecheck/build/lint results. Failed setup/worker attempts remain in the
ledger rather than being counted as passes.

Round 39 passed ten independent SQLite capacity/error cases three times and
the same resource-bound server static checks. Its temporary root-level runner
initially loaded Drizzle through a separate alias and failed the constraint-error
identity check; removing that audit-only alias restored the package's normal
module identity. Both the unchanged original proof and permanent package tests
then passed. No deployment worker or live Docker call was exercised.

Round 40 passed 12 independently gated lease/terminal/revocation cases three
times. A heartbeat or restart extension that wins before the sweep update
preserves the running attempt; forced revocation still requeues it. These are
real migrated SQLite tests, without a live runner/container. Server static
checks used the same child-process `GOMAXPROCS=4` limit.

Round 41 passed nine independent claim/cancellation cases three times and
80 neighboring CI tests. Explicit SQLite client barriers cover cancellation
before/after the attempt insert and immediately before assignment; the next
job can claim the freed runner capacity. No live CI container was executed.

Round 42 passed nine independent capacity/rollback cases three times, including
two separate SQLite connections to one file. The first file-backed test passed
the behavior assertions but failed Windows fixture deletion; final runs retain
their disposable temp databases and record the paths. No production change was
made for cleanup timing. Scope tests and resource-bound server static checks
remain separate from full release/live runner acceptance.

Round 43's final nine-case verifier passed three consecutive runs; seven
permanent regression cases cover insertion, pending loss, revocation processing
and a newer runner claiming before the stale claim resumes. Intermediate
verification exposed gaps in the initial patches and remains in the ledger.
Final scope tests and resource-bound server static checks passed; no live
runner or secret-exposure claim is made.

Round 44 passed nine independent HTTP-level result/cancellation cases three
times. Both success and failure reports return 409 when cancellation wins;
ordinary results emit one audit and duplicate/expired/superseded reports are
rejected. The 93-test CI scope and resource-bound server static checks passed.
Concurrent release/version preparation remains separately owned and validated.

Round 45 passed nine independent ordering/retry/queue-release cases three
times. Explicit delayed-update gates and native SQLite read checkpoints use
no sleep timing; different files can still complete independently. The 96-test
scope and resource-bound server static checks passed. Filesystem-write failure
durability and multiple independent panel processes remain separate boundaries.

Round 46 passed ten independent file/error/descriptor cases three times,
including UTF-8 partial appends and a replacement-file identity check. A native
Windows probe showed append handles cannot truncate, so rollback uses a verified
read/write recovery handle. Initial failed verification remains in the ledger.
The 100-test scope and resource-bound server static checks passed. Simultaneous
write-plus-rollback failures are surfaced together and close handles; automatic
data recovery after those double failures is not certified. Multi-process
writers and abrupt process/power loss remain separate boundaries.

Round 47 found no new scheduler defect: seven gated Fastify/interval controls
and 111 existing runner fixtures passed. Round 48's independent nine-case
verifier passed three times, including later workflow events during JIT/status
waits and preparation failure controls. Its 114-test scope and resource-bound
server static checks passed. These use mocked GitHub/Docker/node boundaries;
an already-admitted runner startup can still finish under its original scope.

Round 49 passed nine independent config/read/resume cases three times and
118 neighboring tests. Successful same-process config writes change a per-App
generation token, fencing a settings read that captured the previous value.
Pending work resumes under a fresh capacity/resource pass. Intermediate fixture
mistakes and the initial stale-read gap are retained in the ledger. Direct
external SQL/multiple-process settings writes and full queued-job eligibility
revalidation remain separate scopes; server static checks used `GOMAXPROCS=4`.

Round 50 passed nine independent eligibility/status-shape cases three times
and 122 neighboring tests. Pending records retain their original validated
labels/privacy for current-policy checks; refused entries do not consume slots
ahead of eligible work. The public pending response still has four fields.
Resource-bound server static checks passed. A repository changing visibility
remotely after its webhook snapshot and live workflow execution were not tested.

Round 51 passed 25 independent state/busy/error/idle-boundary controls three
times, including a delayed uncertain node response released after the node's
current state became running. The 127-test scope and resource-bound server
static checks passed. These assert mocked stop/removal requests; no live
container was deleted. The separate maximum-lifetime policy is being checked
against current upstream self-hosted-runner limits.

Round 52 checked current [GitHub execution limits](https://docs.github.com/en/actions/reference/limits)
and [job timeout syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idtimeout-minutes),
then passed 24 independent local/node lifetime-state cases three times. The
132-test scope and resource-bound server static checks passed. Elapsed time
and provider replies were controlled fixtures; no multi-day live workflow ran.
Confirmed idle/exited cleanup and explicit operator stop remain available.

Round 53 passed 13 independent status/retry/owner cases three times and
138 neighboring tests. Uncertainty survives a later webhook or a config-drift
break; eligible later work still proceeds. The strongest two persistence cases
were promoted and seen red before the final marker patch. Initial incomplete
verification is retained in the ledger. Resource-bound server static checks
passed; no live GitHub workflow or native Mac bootstrap was exercised.

Round 54 continued into November 10 within the November 9 audit directory.
Ten independent Date-only clock/barrier cases passed three times; the
140-test scope and resource-bound server static checks passed. Expired entries
do not take slots from fresh work after long awaits. Existing strict-over-TTL
comparison and already-admitted startup behavior are retained; no real
24-hour wait or exact remote cancellation timing was tested.

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
Round 33 passed 18 independent GitOps lifecycle/interval/deduplication cases
three times, plus the bounded scope and the same resource-bound server static checks.
Round 35 passed 13 independent configuration/result-ownership cases three times,
including queued writes, identical-config recreation and SQL publication failure.
Ten permanent regression/control cases were added; a verifier-fixture deadlock
and an incomplete initial-patch edge remain recorded rather than counted as passes.
Round 36 passed 11 independent scan-callback lifecycle/overlap/failure cases
three times, plus 82 neighboring tests and resource-bound server typecheck/build.
These tests use synthetic findings and do not establish a live vulnerability verdict.
Round 37 found no cloud-scheduler defect: six gated lifecycle checks and 18
existing mocked-provider tests passed. Round 38 passed 12 real-Cron/controlled-clock
deadline, replacement, removal and close cases three times, plus its 65-test scope.

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

### Hosted desktop acceptance checkpoint — November 9, round 34

[Desktop run 42675648656](https://github.com/ninedeploy/ninedeploy/actions/runs/42675648656)
completed successfully on Linux, Windows and macOS for source commit
`9ac991cc0f1e14653db71dbc2dd22a71d9344191`. This is the independent desktop
workflow, not a full panel release gate.

The macOS job used runner image `macos-26-arm64`: frozen dependency install,
typecheck and **27 tests in five files** passed. It built both x64 and arm64
DMGs, then launched the arm64 packaged app and the copy installed from the DMG.
The native Intel launch remains unverified by this arm64 runner.

The installers were **unsigned**; signature/notarization checks were skipped.
Both Mac smoke calls explicitly set `ND_SMOKE_KEYCHAIN_UNREACHABLE=1`.
The unpacked-build smoke accepted sealed bytes that did not survive a
restart and were removed with the instance; the installed-copy smoke reported
an unavailable OS store and wrote nothing. Neither result proves ordinary
login-Keychain persistence. Keep the earlier physical-Mac/normal-Keychain
acceptance steps, with that override unset.

The run contains `ninedeploy-desktop-macOS`, `ninedeploy-desktop-Windows` and
`ninedeploy-desktop-Linux` artifacts, expiring November 23, 2026. They are CI
artifacts, not published releases. API-reported archive digests and selected
Mac log evidence are retained in
[the round 34 ledger](../.temp_files/ledger_macosHandoff34_20261109.md).
The archive digests were not independently checked against downloaded binaries.

The bootstrap helper's syntax/help/lint, unsupported-Windows rejection and
conflicting-mode rejection passed locally. Its native `--check`/`--install`
and the root workspace build on a Mac were not executed by this desktop-only
workflow; run those commands on your development Mac as described above.

### Audit continuation — November 10, rounds 55–56

Round 55 found no secret-file helper defect in eight native disposable-file and
controlled filesystem-failure checks. Cleanup is best-effort: persistent deletion
failure can leave the owned file. Windows ACLs and cross-user access were not tested.

Round 56 fixes shared-certificate scheduler admission (F1074). The scheduler now
owns its settings-read wait, preventing overlapping renewal renders, and a pending
read cannot start a render after server close. Three permanent control/regression
tests were seen red on the original source; seven neighboring tests passed after
the fix. Ten independent lifecycle/retry cases passed three times. Server typecheck
and build passed with the existing child-process `GOMAXPROCS=4` bound; scoped lint
passed. An already-admitted render can finish after close. No live ACME renewal,
proxy deployment, full release gate or native Mac setup was exercised in this round.

Round 57 (F1075) preserves restart-limit operator choices across Docker/PM2
sampling and admitted stops. A stale sample cannot enforce an older policy;
trip persistence cannot recreate a disabled limit or erase a replacement policy's
new history. Four permanent tests were seen red on original source (three defects,
one control), then 12 neighboring tests passed. Fourteen independent policy/history
cases passed three times. Fixture promotion and initial incomplete-fix failures
are retained in the ledger and excluded from passing results. No live container
stop or distributed policy lock was certified; use the physical-Mac acceptance
steps above for native behavior.

Round 58 (F1076) prevents restart-loop samples from stopping a replacement
runtime or a service whose deployment became active during sampling. The final
database admission checks current runtime/status and active deployments; rejected
trip history cannot stop a later clean runtime baseline. Seven permanent tests
were seen red on the preceding policy fix, then 19 neighboring tests passed.
Twenty-eight independent Docker/PM2, native-SQL barrier and follow-up baseline
cases passed three times. This does not cancel an external stop already admitted
before a later deployment; live runtime and native Mac acceptance remain separate.

Round 59 (F1077) prevents overlapping automatic image-update scheduler sweeps.
The actual sweep with a native SQLite gate previously queued the same image
change twice; the permanent reproduction was seen red, then 21 neighboring
tests passed. Eleven independent scheduling/lifecycle/error cases passed three
times. The initial five-minute delay and thirty-minute cadence remain. This
protects one scheduler instance; cross-process enqueue deduplication, live
registry timing and native Mac acceptance were not certified.

Round 60 (F1078) moves automatic-update enqueue eligibility and in-flight checks
into the same deployment INSERT. A completed opt-out, stop, image/digest change
or competing active deployment cannot be bypassed by a stale application read.
Eight permanent tests were seen red (seven failing cases and one control); 29
neighboring tests passed after repair. Sixteen independent native-SQL barrier,
competing-sweep and failure/retry cases passed three times. Accepted queue rows
retain the schedule trigger. This does not certify post-insert digest publication,
multiple processes, live registry/deployment or native Mac acceptance.

Round 61 (F1079) fences automatic-update digest publication against the original
opt-in/running image and previous digest. Old baseline, refused-update and
post-enqueue writes cannot restore an operator-cleared or replacement baseline.
Five permanent tests were seen red (four failing cases and one control); 34
neighboring tests passed after repair. Twenty-three independent native-write
barrier cases passed three times, including competing baseline observations and
a legacy empty-string baseline. Accepted deployment rows are retained; refusal
authorization, multi-process ABA ordering, live provider and native Mac acceptance
remain outside this bounded validation.

Round 62 (F1080) avoids an argument-count crash when computing the latest
request bucket for a long-running traffic/scale-to-zero consumer. The old code
threw RangeError on a fixed 200,000-bucket history; it now scans the maximum
without argument spreading. Three permanent tests were seen red (two failing
cases and one full-day control), then 91 neighboring tests passed. Eleven
independent arithmetic/history/idle-boundary cases passed three times. Bucket
memory retention is a separate scope; no live 23-day run or native Mac acceptance
was claimed.

Round 63 (F1081) bounds request buckets on the traffic-write path, including
consumers that never call the rate reader. Before repair, a fixed 30-day stream
retained 7.34 MB after explicit GC against a 2 MB budget (one-day control454 KB).
The original proof then retained681 KB; three independent verification runs
retained about920 KB and passed ten memory/boundary/order/jump/reset controls.
Four permanent tests were seen red (three failing cases and one control), then
95 neighboring tests passed. Retention is inclusive24 hours behind the latest
recorded event, not wall-clock cleanup with no events; distinct service-ID counts
and process RSS are not bounded by this fix. No live30-day/native Mac acceptance
or full release certification was claimed.

Round 64 (F1082) orders restricted-port sidecar sync/removal per service slug.
An old sync waiting for its image previously recreated the sidecar after a later
remove, with its config already gone. Twelve permanent cases were seen red
(seven failing races and five controls); twelve independent native-file and
explicit-gate cases then passed three times. Different slugs remain independent;
failed image/config writes release admission, and a newer sync can recreate the
sidecar after removal. Resource-bound server typecheck/build and scoped lint
passed. The broader deployment-pipeline target passed291 tests in three files; its receipt is recorded in the round64
ledger; root release/native Mac and live Docker/IP allow-list enforcement remain
separate checks.

Round 65 (F1083) preserves a surviving port sidecar's config when Docker removal
fails. The original error now reaches callers; the function cannot log successful
removal or delete config after that failure. Ten permanent cases were seen red
(eight failing cases and two controls); 31 port-proxy tests passed afterward.
Nine independent failure/retry/queue cases passed three times. Unknown-inspect
classification and live Docker enforcement remain outside this fix. The broader
291-test pipeline pass belongs to preceding round64 and was not repeated for
this isolated failure-path change; root/native acceptance remains separate.

Round 66 (F1084) distinguishes exact native Docker-inspect absence from unknown
errors. A connection/permission/timeout or unrelated diagnostic now reaches the
caller instead of deleting config or starting a replacement. Twenty permanent
cases were seen red (12 failing cases and eight controls); 51 port-proxy tests
passed after repair. Twenty independent cases passed three times, including a
real native Node subprocess validating the capture error envelope. Existing
missing-container fixtures now reproduce that actual envelope. Sync's earlier
desired-config writes, live Docker/network enforcement and native Mac acceptance
remain outside this correction; the full pipeline pass remains round64 evidence.

Round 67 found no new node-health defect in six additional migrated-database
serial controls and 27 existing health/collector tests. The actual collector
awaits each cycle, so artificial overlapping factory calls were not counted as
a production race. Registry deletion/pending transitions, refresh and age boundaries,
failed/malformed remote samples and initial unknown registry behavior passed.
No source patch was made; a cached-metric fallback observation remains unproven.
No live node/native Mac/full release acceptance was claimed.

Round 68 fixes reset replacement atomicity (F1085/F1086) and a supported memory
URI transaction adapter case (F1087). Overlapping issuances now share the existing
managed transaction order; delete/insert rollback preserves a delivered token on
precommit failure. Both `:memory:` and `file::memory:` keep their single connection
without an invalid replacement borrow. Original proofs passed after repair; ten
server regression cases were seen red (four failing cases, six controls), and
the extended DB URI regression was seen red (one failure, one control). Eighteen
independent reset/rollback/memory/savepoint cases passed three times, and 105
server auth/user/reset tests passed.

The default parallel DB coverage run hit22 existing five-second migration test
timeouts and one child-process timeout. The serial retry kept the same thresholds
and test timeouts: **85 tests in36 files passed, with100% statements, branches,
functions and lines**. This resource-bounded result is distinct from the failed
default parallel run and from a complete release gate. The initial reset after-run
that exposed the adapter defect is retained as a failure, not passing evidence.
No live reset email/account, postcommit lost-response recovery, multi-process
ordering, native Mac acceptance or full root certification was claimed.

Round 69 (F1088, High) fixes CLI database-import recovery after a caught transport
failure. The actual SDK previously either retried into an active-job conflict
or sent a second restore after losing a completion response. Retry now reconciles
its known import id, resumes uploads, waits for running work and records completed
work without restarting it. A recorded unresolved job cannot be rebound to a
different dump; the command points to explicit inspection/new-import commands.
A stronger verifier exposed and closed that different-dump gap before acceptance.

Sixteen permanent cases were seen red (ten failures, six controls); sixteen
independent SDK/transport/checkpoint/gated-running cases passed three times.
The final complete CLI suite passed **1139 tests in63 files**, with coverage
91.39% statements,88.54% branches,88.51% functions and91.68% lines against unchanged
configured floors. Resource-bound CLI typecheck/build and scoped lint passed.
Receipt serialization and a target-data marker model were tested; no real process
restart, power loss, live database loss/restore or native Mac acceptance was claimed.
A create response lost before an import id is received remains outside recovery.

Round 70 (F1089) protects an admitted database-import worker's staging file from
an older start refusal. Cleanup/failure audit now require winning the conditional
pending-to-failed transition; a loser gets conflict409, while ordinary refusal
keeps422. Ten permanent native route/SQLite/file cases were seen red (four races,
six controls), then 134 neighboring import/job/wiring tests passed. Ten independent
MySQL/MariaDB start/cancel/SQL-error/creator controls passed three times with
explicit gates. No live restore/data loss, auth bypass, multi-process or native
Mac acceptance was claimed.

Round 71 (F1090) serializes native chunk writes per import and rereads metadata
inside admission so concurrent retries cannot overwrite acknowledged bytes. Eight
permanent gated cases were seen red (five races, three controls), then passed;
eight independent controls passed three times. Different imports remain independent.
Native SQLite and disposable files were exercised; no live restore, distributed
locking or native Mac acceptance is claimed.

Round 72 (F1091) completes short native chunk writes before acknowledging upload
metadata. Buffer offsets and absolute file positions advance by bytesWritten;
zero progress or an error keeps metadata retryable. Eight permanent cases were
seen red (seven failures, one full-write control); eight independent cases passed
three times. Partial bytes were really written to disposable native files through
an injected write seam. This does not establish short-write frequency, live
restore behavior or native Mac acceptance.

Round 73 ran the full configured server unit suite on Windows at1129f4c5.
It FAILED:832/833 files passed,13934 tests passed and2 skipped; one native
worker exited0xC0000005 part-way through nodeIdleScheduler.test.ts. The first
focused repeat also crashed, then six whole-file repeats each passed24/24.
Two plain-Node controls each completed50 native DB open/migrate/read/close
cycles, including one forced-GC run. No local native root cause or fix was
established. A full retry was invalidated after an observed6h42m tool/session
pause and worker-termination timeouts, then only its verified owned processes
were stopped. It is not a passing full-suite result.

For a native Mac comparison after setup, retain stdout/stderr and exit status:

```bash
pnpm --dir apps/server exec vitest run test/lib/nodeIdleScheduler.test.ts --coverage=false --maxWorkers=1 --reporter=verbose
pnpm --dir apps/server exec vitest run --coverage=false --maxWorkers=1 --reporter=verbose
```

These commands do not enable coverage or integration/diag tests. Upstream
[libsql issue231](https://github.com/tursodatabase/libsql-js/issues/231) reports
similar Windows native faults; it is context, not proof of this local cause.
No Mac result, native crash fix, coverage or release certification is claimed.
