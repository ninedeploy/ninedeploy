# Scripts

Release tooling (`bump-version.js`, `tag-release.js`, `check-node-version.mjs`) and the smoke tests live here. See `CONTRIBUTING.md` for how changes are checked.

## Smoke tests

A smoke test drives real Docker, often with a built panel image. Most run in CI or in the release workflow (`.github/workflows`). The ones below do not; they are tools you run by hand, for a promotion or a focused acceptance. `apps/server/test/smokeInventory.test.ts` fails when a `smoke-*` script is neither run by a workflow nor listed here.

<!-- manual-smokes:start -->
| Script | Alias | What it checks | Where it runs |
|---|---|---|---|
| `smoke-database-clients.mjs` | `pnpm smoke:database-clients` | The database client terminals and Studio against disposable databases of every engine (`--case=postgres\|engines`, `--engine=`). Needs `--image=<candidate>`. | Isolated Docker daemons it starts itself |
| `smoke-node-operations.mjs` | `pnpm smoke:node-operations` | Node container, Compose and file operations through the built agent (`--image=` to reuse a local image). | **The Docker daemon you point it at.** Use a disposable daemon (Docker-in-Docker), never a host shared with other projects |
| `smoke-registry-recovery.mjs` | `pnpm docker:smoke-registry-recovery` | Every runtime-certified Hub template recovered straight from its registry, imported fresh and started (`--ids=`, `--timeout=`). Linux only. | The local daemon; removes only its own smoke-tagged resources |
| `smoke-runtime-mutations.mjs` | `pnpm smoke:runtime-mutations` | The native node runtime mutation protocol (R2), without the panel producers (`--image=`, `--host=`, `--tls=`, `--controller-only`). | Isolated daemons it starts itself |
| `smoke-template-runtime.mjs` | `pnpm templates:smoke-runtime` | Deploys template stacks before they are promoted into the catalog (`--registry=<mirror bundle>`, `--ids=`). See docs/TEMPLATE_MIRRORS.md. | **The local Docker daemon.** Use a disposable one |
| `smoke-volume-file-helper.mjs` | `pnpm smoke:volume-files` | The volume file browser's helper container (`--image=<built candidate>`). | An isolated daemon; no host volumes are mounted |
<!-- manual-smokes:end -->

Before you run any smoke against a Docker daemon, check which daemon it is. A smoke that boots the panel recreates the panel's Traefik container on that daemon.
