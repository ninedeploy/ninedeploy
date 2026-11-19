# Scripts

Release tooling (`bump-version.js`, `tag-release.js`, `check-node-version.mjs`) and the smoke tests live here. See `CONTRIBUTING.md` for how changes are checked.

`check-contracts.mjs` (`pnpm check:contracts`) runs the fast contract suites
directly through the installed Vitest after workspace builds. It propagates
test failures and has a five-minute process bound. CI and `release:check`
run it before forcing the full serialized coverage suites. It does not replace
those suites or the real Docker/browser release smokes.

`recover-pitr-checkpoint.mjs /secure/recovery.json` is the offline operator tool
for an encrypted remote PostgreSQL checkpoint or continuous archive head/catalog. It requires a built checkout or
the packaged runtime image. See [the remote PITR runbook](../docs/PITR_REMOTE_CHECKPOINTS.md)
for the input file, passphrase custody, target-volume validation and recovery limits.

## Smoke tests

A smoke test drives real Docker, often with a built panel image. Most run in CI or in the release workflow (`.github/workflows`). The ones below do not; they are tools you run by hand, for a promotion or a focused acceptance. `apps/server/test/smokeInventory.test.ts` fails when a `smoke-*` script is neither run by a workflow nor listed here.

<!-- manual-smokes:start -->
| `smoke-capacity-baseline.mjs` | `node scripts/smoke-capacity-baseline.mjs --image=<candidate>` | N06 scheduled API reads, deploy bursts, log delivery and controlled panel restart. Use `--scenario=slow-node`, `full-disk`, or `log-outage` for the fault runs. | Local Linux Docker with private daemons, a pinned candidate and preloaded fixture images. See [capacity baseline](../docs/CAPACITY_BASELINE.md). |
| Script | Alias | What it checks | Where it runs |
|---|---|---|---|
| `smoke-disaster-recovery.mjs` | `node scripts/smoke-disaster-recovery.mjs --image=<candidate>` | N05 remote recovery of the panel, app volumes and PostgreSQL. Optional `--cutover` exercises a surviving agent and private DNS. `--replace-node=<ssh-dind>` rebuilds a node from empty state. `--cloudflare-staging` uses a disposable Cloudflare record and Let’s Encrypt staging. | Labelled disposable Docker daemons and RustFS over HTTPS. See [the recovery drill](../docs/DISASTER_RECOVERY.md) for the inputs to each option. |
| `smoke-pitr-ui.mjs` | `node scripts/smoke-pitr-ui.mjs --proof=.temp_files/pitr-ui` | Actual operator archive component, authentication and SDK: configuration, admission/polled verification, passphrase custody and confirmation button bounds at 1366px/390px English and 320px Turkish. | Local source/Vite and Playwright with isolated HTTP fixtures; blocks external requests and closes its own browser/server |
| `smoke-pitr-remote.mjs` | `node scripts/smoke-pitr-remote.mjs --image=<candidate>` | Uploads a full encrypted recovery set, destroys its source host and restores selected/latest points. Add `--continuous` for incremental WAL, overlapping generations, retention, orphan collection and corrupt-data refusal. Add `--node` for a sealed node agent and both archive modes. Add `--rustfs` to run continuous mode against RustFS over HTTPS. | Labelled disposable Docker daemons with an independent S3 server |
| `smoke-proxy-settings.mjs` | `node scripts/smoke-proxy-settings.mjs --image=<candidate>` | Public forward-auth, maintenance and error-page changes through real Traefik, failed atomic writes/acknowledgements, and a hard-killed apply restored at boot. | A labelled disposable Docker daemon; removes only owned fixtures |
| `smoke-database-clients.mjs` | `pnpm smoke:database-clients` | The database client terminals and Studio against disposable databases of every engine (`--case=postgres\|engines`, `--engine=`). Needs `--image=<candidate>`. | Isolated Docker daemons it starts itself |
| `smoke-node-operations.mjs` | `pnpm smoke:node-operations` | Node container, Compose and file operations through the built agent (`--image=` to reuse a local image). | **The Docker daemon you point it at.** Use a disposable daemon (Docker-in-Docker), never a host shared with other projects |
| `smoke-registry-recovery.mjs` | `pnpm docker:smoke-registry-recovery` | Every runtime-certified Hub template recovered straight from its registry, imported fresh and started (`--ids=`, `--timeout=`). Linux only. | The local daemon; removes only its own smoke-tagged resources |
| `smoke-runtime-mutations.mjs` | `pnpm smoke:runtime-mutations` | The native node runtime mutation protocol (R2), without the panel producers (`--image=`, `--host=`, `--tls=`, `--controller-only`). | Isolated daemons it starts itself |
| `smoke-template-runtime.mjs` | `pnpm templates:smoke-runtime` | Deploys template stacks before they are promoted into the catalog (`--registry=<mirror bundle>`, `--ids=`). See docs/TEMPLATE_MIRRORS.md. | **The local Docker daemon.** Use a disposable one |
| `smoke-volume-file-helper.mjs` | `pnpm smoke:volume-files` | The volume file browser's helper container (`--image=<built candidate>`). | An isolated daemon; no host volumes are mounted |
<!-- manual-smokes:end -->

### Browser journeys

`smoke-pitr-ui.mjs` checks the remote PostgreSQL archive screen from the local source checkout. Install the workspace dependencies and the separate `e2e/` Playwright/Chromium dependencies using the command below, then run it from the repository root. It starts Vite on an ephemeral loopback port, mounts the actual component/authentication/SDK, and replaces only HTTP responses with a closed protocol fixture. It checks both page overflow and clipping of individual confirmation buttons. It writes screenshots and a receipt to a new run directory under `--proof` (default `.temp_files/pitr-ui`) and always closes its browser/server. It needs no Docker, live panel credentials or S3 account; this is UI acceptance, not a storage-provider or recovery-engine drill.

`smoke-browser-e2e.mjs` (`pnpm smoke:browser`) drives the web panel with Playwright. It covers the setup form, the deploy wizard, the Turkish locale and a phone-width pass. It runs against an image in Docker-in-Docker, which it starts and removes by name. `.github/workflows/browser-e2e.yml` runs it after each green main CI run, on that run's `main-<sha>` image. Playwright lives in `e2e/`, with its own lockfile, outside the panel workspace. Install it once with `pnpm --dir e2e install && pnpm --dir e2e exec playwright install chromium`. Then run `node scripts/smoke-browser-e2e.mjs --image=<image>`. `--keep` leaves the panel running, and arguments after `--` go to Playwright.

Before you run any smoke against a Docker daemon, check which daemon it is. A smoke that boots the panel recreates the panel's Traefik container on that daemon.
