# Scripts

Release tooling (`bump-version.js`, `tag-release.js`, `check-node-version.mjs`) and the smoke tests live here. See `CONTRIBUTING.md` for how changes are checked.

`check-contracts.mjs` (`pnpm check:contracts`) runs the fast contract suites
directly through the installed Vitest after workspace builds. It propagates
test failures and has a five-minute process bound. CI and `release:check`
run it before forcing the full serialized coverage suites. It does not replace
those suites or the real Docker/browser release smokes.

`generate-cli-reference.mjs` writes `docs/CLI_REFERENCE.md` from the built CLI's
own `--help` output. Run `pnpm build`, then `node scripts/generate-cli-reference.mjs`,
whenever a command, argument or option changes.

`recover-pitr-checkpoint.mjs /secure/recovery.json` is the offline operator tool
for an encrypted remote PostgreSQL checkpoint or continuous archive head/catalog. It requires a built checkout or
the packaged runtime image. See [the remote PITR runbook](../docs/PITR_REMOTE_CHECKPOINTS.md)
for the input file, passphrase custody, target-volume validation and recovery limits.

## Smoke tests

A smoke test drives real Docker, often with a built panel image. Most run in CI or in the release workflow (`.github/workflows`). The ones below do not; they are tools you run by hand, for a promotion or a focused acceptance. `apps/server/test/smokeInventory.test.ts` fails when a `smoke-*` script is neither run by a workflow nor listed here.

<!-- manual-smokes:start -->
| Script | Command or alias | What it checks | Where it runs |
|---|---|---|---|
| `smoke-capacity-baseline.mjs` | `node scripts/smoke-capacity-baseline.mjs --image=<candidate>` | N06 scheduled API reads, deploy bursts, log delivery and controlled panel restart. Use `--scenario=slow-node`, `full-disk`, or `log-outage` for the fault runs. | Local Linux Docker with private daemons, a pinned candidate and preloaded fixture images. See [capacity baseline](../docs/CAPACITY_BASELINE.md). |
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

`smoke-browser-e2e.mjs` (`pnpm smoke:browser`) drives an isolated panel in Docker-in-Docker with Playwright. The journeys cover setup, first deployment, environment changes and rollback, PostgreSQL backup and restore, approval, member permissions, domain routing configuration, Turkish, and both classic and compact layouts on desktop and phone. The restore test checks PostgreSQL data through the fixture's private Docker daemon. Install the locked browser dependencies with `pnpm --dir e2e install --frozen-lockfile && pnpm --dir e2e exec playwright install chromium`.

The Release workflow checks the candidate's image revision against the source checkout and runs the five core projects by digest. Each required project must execute and pass without skips or retries. A failed or skipped gate holds the GitHub Release and `:latest`. The separate Browser journeys workflow continues to test green main builds and runs nightly.

The compact project runs every desktop journey the classic project runs, under per-layout service, database and member names, so both layouts are measured by the same walks (N10). The N10 journeys keep what they measure in the JSON report as annotations named `n10-*`: set `PLAYWRIGHT_JSON_OUTPUT_FILE`. That is the clicks each operator task takes from the dashboard, the tabs and cards each layout hides, Tab stops, what each dialog does with the focus, controls without a name, the phone drawer and deep links, the member's seat, and what a browser that never chose a layout gets. Two limits of the runner: a `--grep` filter is not applied to a project that runs as a dependency of another, and arguments after `--` must not contain spaces, because they are passed through a shell. The record is in [Compact layout acceptance](../docs/COMPACT_LAYOUT.md).

```sh
node scripts/smoke-browser-e2e.mjs --image=<candidate-digest-reference> -- \
  --project=setup --project=desktop --project=phone --project=desktop-compact --project=phone-compact
```

Arguments after `--` go to Playwright. `--keep` leaves the disposable panel running for debugging.

The desktop project includes the Git-backed PR preview lifecycle. The smoke provisions a read-only smart HTTP server on the fixture's private network. The test turns on previews in the browser and sends locally signed PR events to the panel's webhook endpoint. It checks branch-specific HTTP content through fixture Traefik, and verifies the Failed state and Docker build output in the browser for a second branch. Closing the PRs removes the preview services, routing, and the successful preview's container and bridge. The parent keeps serving its original commit. The hostnames use the reserved `.test` domain, and the HTTP probe stays inside the fixture network.

```sh
node scripts/smoke-browser-e2e.mjs --image=<candidate-digest-reference> -- 10-pr-preview.spec.ts --project=desktop
```

On November 21, 2026, the five core projects passed all 36 journeys locally on the published v0.19.0 image at digest `sha256:113fb9e11ad3f8f94d38020e00e7744ad10c2f57c614afda89f089db2f4e51bf`. The image revision was `0a59b5ed4068334b5ee0d1ad36e43959e92525ba`. The release validator accepted the final Playwright JSON and rejected the earlier report from a fixture run that queried PostgreSQL before it was ready. The restore test now waits for a real SQL response and proves that the restored row predates the snapshot while a post-snapshot row is gone. Both phone projects verified that layout choices survive reload. Local receipts are under `.temp_files/n08-browser-20261120/`.

#### PR preview verification on November 21, 2026

The expanded gate passed **37 journeys across all five projects** on the same v0.19.0 digest, with zero skipped, failed or flaky tests. The release report validator accepted the final result and rejected a previous run whose TLS selector matched two domains. The TLS journey now chooses the controls belonging to its target hostname. The PR journey verified the exact deployed commit, error output from the broken branch, both closed routes returning HTTP 404, and continued service from the original parent container. An earlier run logged a bridge removal warning for the broken build. The final Docker inventory confirmed both preview bridges were absent after closure. The runner removed its Git directory and all its Docker fixtures. The receipts are under `.temp_files/n08-preview-20261121/`.

Before you run any smoke against a Docker daemon, check which daemon it is. A smoke that boots the panel recreates the panel's Traefik container on that daemon.
