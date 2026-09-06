<div align="center">

# NineDeploy

**A self-hosted PaaS for servers you actually own.**

Push a branch, get a healthy container behind TLS. NineDeploy builds from Git or pulls from a
registry, keeps the previous container serving until the new one passes its healthcheck, and manages
the databases, certificates, secrets, backups and access rules around it — from a web panel, a
terminal CLI, a typed SDK, or an AI agent over MCP.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Release](https://img.shields.io/badge/Release-0.7.2-blue.svg)](./CHANGELOG.md)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.13-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-blue.svg)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Docker-required-blue.svg)](https://docker.com)
[![Tests](https://img.shields.io/badge/Tests-4%2C882%20passing-brightgreen.svg)](#testing)
[![CI](https://github.com/NineDeploy/NineDeploy/actions/workflows/ci.yml/badge.svg)](https://github.com/NineDeploy/NineDeploy/actions/workflows/ci.yml)

[Website](https://ninedeploy.com) · [Quickstart](./docs/QUICKSTART.md) · [Architecture](./ARCHITECTURE.md) · [Templates](https://ninedeploy.com/templates) · [Changelog](./CHANGELOG.md)

</div>

---

## What it is

One Node process, one SQLite file, and the Docker socket on a machine you control. That process
builds your repositories, runs them as containers (or PM2 processes, or Compose stacks), writes
Traefik's routing config, provisions Postgres/MySQL/Redis/Mongo/ClickHouse and friends, encrypts
every secret and every backup it stores, and exposes the whole surface as a REST API that the
dashboard, the CLI, the SDK and the MCP server all speak.

**What it replaces:** a hand-rolled pile of `docker run` invocations, nginx vhosts, certbot cron
jobs, `pg_dump | gzip | aws s3 cp` scripts, and a wiki page nobody has updated since the last
migration.

**What it is not:** a Kubernetes distribution, a multi-region control plane, or a hosted service.
There is no scheduler, no service mesh and no cluster consensus — just one panel that knows how to
drive Docker on one host, and optionally on a handful of remote ones.

---

## Requirements

| | |
| :--- | :--- |
| **Host** | Linux. The installer handles Debian/Ubuntu end to end (signed APT repos for Node and Docker); other distributions work if Node and Docker are already present. |
| **Runtime** | Node.js ≥ 22.13 (bare-metal mode only), Docker Engine + the Compose plugin. |
| **Ports** | `80`/`443` free for Traefik. The panel binds `127.0.0.1:3000` by default — put it behind Traefik or a tunnel rather than exposing it directly. |
| **Privileges** | `sudo` for the bare-metal installer (systemd unit, firewall, optional PM2). Docker mode only needs membership in the `docker` group. |

---

## Install

### Bare metal (recommended for production)

```bash
curl -fsSL https://raw.githubusercontent.com/NineDeploy/NineDeploy/main/install.sh | bash
```

Installs Node and Docker if missing, drops a checksum-verified Nixpacks binary in place, clones the
repository to `~/ninedeploy`, generates a 32-byte JWT secret and a master key into a `0600` `.env`,
runs the SQLite migrations, and starts a hardened `systemd` unit (`ProtectSystem=full`,
`NoNewPrivileges`, `PrivateTmp`, `Restart=always`) gated on `/health`.

Re-running the same command is the upgrade path; it snapshots `.data` before touching anything.

```bash
./install.sh --version v0.7.2     # pin an exact tag
./install.sh --channel main       # track edge
./install.sh --force              # discard local edits + stale build artifacts, then rebuild
```

> **Where `main` stands:** the default channel installs the newest release tag (**0.7.2**).
> The newest work (doctor mode, retained-volume re-keying) lands on `main` before it is tagged —
> see [`CHANGELOG.md`](./CHANGELOG.md) under *Unreleased*, or run `--channel main` to get it today.

### Docker

Same installer, container mode — no host Node.js, no systemd, no PM2:

```bash
curl -fsSL https://raw.githubusercontent.com/NineDeploy/NineDeploy/main/install.sh | bash -s -- --docker
```

Or bring your own compose file (it refuses to boot without a strong `NINEDEPLOY_JWT_SECRET`):

```bash
echo "NINEDEPLOY_JWT_SECRET=$(openssl rand -hex 32)" >> .env
echo "DOCKER_GID=$(getent group docker | cut -d: -f3)" >> .env
docker compose -f docker-compose.prod.yml up -d
```

Or run the image directly:

```bash
docker run -d --name ninedeploy \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(getent group docker | cut -d: -f3)" \
  -v ninedeploy-data:/data \
  -p 3000:3000 \
  -e NINEDEPLOY_DATA_DIR=/data \
  -e NINEDEPLOY_DB_PATH=/data/ninedeploy.db \
  -e NINEDEPLOY_JWT_SECRET="$(openssl rand -hex 32)" \
  -e NINEDEPLOY_PUBLIC_URL=https://panel.example.com \
  ghcr.io/ninedeploy/ninedeploy:latest
```

> **Docker mode trade-off:** PM2 services (host processes) and UFW firewall management need the
> bare-metal installer. Docker/Compose deploys, managed databases, Traefik ingress and encrypted S3
> backups behave identically — the panel drives them as sibling containers through the mounted socket.

### From source (development)

```bash
git clone https://github.com/NineDeploy/NineDeploy.git && cd NineDeploy
corepack enable && pnpm install && pnpm build
pnpm dev        # API + built dashboard on :3000
pnpm dev:web    # Vite dashboard on :5173 against that API
```

### First boot

1. Open `http://<host>:3000`. **The first account created becomes the instance operator** and owns a
   personal workspace; every later signup is an ordinary member until someone grants more.
2. Point a wildcard DNS record (`*.apps.example.com`) at the host and set the ACME email under
   **Settings → System**; Traefik issues certificates from there on, DNS-01 wildcards included.
3. `ninedeploy doctor` from your laptop, or the **About** page in the panel, reports what is missing.

Full matrix — environment variables, upgrade paths, systemd internals — in
[**docs/QUICKSTART.md**](./docs/QUICKSTART.md).

---

## How the pieces fit

```
   browser · ninedeploy CLI · SDK · MCP agent          git push / PR event
                    │                                          │
                    │ HTTPS                                    │ HMAC-signed webhook
                    ▼                                          ▼
        ┌───────────────────────────┐              ┌────────────────────────┐
        │  Traefik v3               │              │  POST /v1/hooks/:id    │
        │  :80 / :443 · ACME certs  │              │  branch + path match   │
        │  per-domain middlewares   │              └───────────┬────────────┘
        └─────────────┬─────────────┘                          │
                      │ routes by hostname                     │
                      ▼                                        ▼
      ╔═════════════════════════════════════════════════════════════════════╗
      ║  NineDeploy panel — Fastify 5 API + React 19 dashboard, one process ║
      ║ ─────────────────────────────────────────────────────────────────── ║
      ║  48 route modules under /v1       deploy engine (queue + worker)    ║
      ║  microkernel: events · hooks      builders: docker · pm2 · compose  ║
      ║  SQLite (41 tables, Drizzle)      AES-256-GCM vault + key ring      ║
      ╚═══╤═══════════════╤═══════════════════╤══════════════════╤══════════╝
          │ docker.sock   │ docker.sock       │ HTTP + token     │ S3 API
          ▼               ▼                   ▼                  ▼
    app workloads    managed data        remote agents      off-site backups
    containers       Postgres · MySQL    (typed op calls;   R2 · AWS · MinIO ·
    PM2 processes    MariaDB · Redis     networks today,    Wasabi — db dumps
    Compose stacks   Valkey · Mongo      deploys not yet)   and volume tars
    89 templates     ClickHouse ·
                     Meilisearch ·
                     RabbitMQ

    Cloudflare Tunnel ┄┄┄▶ reaches workloads on hosts with no inbound ports
```

Every workload joins a shared `ninedeploy` Docker network. Host ports are **not** published unless an
operator explicitly asks for one, and reserved ports (the panel, 80, 443, 22) are refused outright.

---

## What a deploy actually does

Triggered by the panel, a webhook, the CLI, a cron job or a template install:

1. A deployment row is queued; a worker slot claims it atomically and snapshots the build config plus
   an env-key fingerprint — **never** the values — so the UI can diff deploy against deploy.
2. `building` rows older than 45 minutes are requeued on boot, so a panel restart mid-build recovers
   instead of leaving a ghost.
3. **Prepare** — image deploys pull (a rollback pins the exact digest). Repo deploys resolve source
   credentials, check out the commit with the token or SSH key scrubbed from every log line, run a
   best-effort framework analysis, and load `.ninedeploy` from the tree.
4. **Environment** — project-shared vars ← service vars ← attached-database connection strings, then
   `${{infisical:KEY}}` / `${{doppler:KEY}}` references resolved at deploy time and never stored. A
   deploy fails if an attached database is not running.
5. **Build** — the manifest fills in whatever the panel left empty (`panel > manifest > auto-detect`),
   `runtime`/`phases` render into a real `nixpacks.toml`, then the builder runs: Dockerfile via
   buildx, Nixpacks for Dockerfile-less repos, install-and-build under PM2 on the host, or
   `docker compose up -d --build`.
6. **Boot** — the new runtime starts with secrets injected through a `0600` temp env-file that is
   deleted immediately after start, plus networks, volume attachments, CPU/memory limits and the
   restart policy. **The old container keeps serving.**
7. **Healthcheck** — container liveness *and* an HTTP probe against the new container's network IP,
   retried with a fresh abort signal per attempt for up to five minutes.
8. **Cut over** — only after the probe passes: finalize the row, persist the image digest, demote
   older `running` deploys to `superseded`, assign the wildcard domain, flip Traefik, wait two
   seconds, then retire the previous container.
9. **On failure** — the new runtime is torn down and the old one keeps serving; only the deployment is
   marked failed. (PM2 is stop-then-start, so it has no blue-green window.)
10. **Cancel** — the pipeline re-reads its own status at every checkpoint and tears down partial work.

Logs stream over WebSocket while this happens, are stage-tagged (`##[stage:BUILD:running]`) for the
stepper UI, and persist to disk. Every subprocess has a hard timeout and is tree-killed.

Watch paths, `[skip ci]` handling, cancellation and PR previews: [**docs/DEPLOYMENTS.md**](./docs/DEPLOYMENTS.md).

---

## Features

### Deployments

- **Blue-green with automatic rollback** for Docker services, plus one-click rollback to any prior
  deploy by pinned digest.
- **Three runtimes:** containers, PM2 host processes, and Compose stacks (`ndcmp-` prefixed). PM2 and
  Compose are host-privileged and therefore operator-only.
- **Ephemeral PR previews** — a pull request spins up `service-pr-123` with the parent's non-secret
  config (secrets are deliberately withheld, and the webhook response reports how many), capped by a
  max-active limit and destroyed when the PR closes.
- **Watch paths, branch filters and `[skip ci]`**, so a docs commit does not rebuild the API.
- **Scheduled jobs** — 5-field cron attached to any service, with preset editors, human-readable
  schedule descriptions and per-job run history.
- **Per-deploy config diff** — what changed in the build config and which env keys moved, without
  ever storing a value.

### Ingress and TLS

- Traefik v3 as the single public listener; dynamic config written atomically into a directory bind
  mount, with Host/Path operands sanitized against rule and YAML injection.
- Let's Encrypt HTTP-01 and DNS-01 (wildcards), with certificate expiry parsed out of `acme.json` and
  fed into the alert evaluator.
- Per-domain middlewares: www→apex redirect, custom response headers, basic auth, IP allowlists, rate
  limits.
- **Cloudflare Tunnels** for hosts with no inbound ports.
- Non-operators must **prove control of a hostname** before attaching it.

### Data services

- One-click **Postgres** (with `pgvector`), **MySQL**, **MariaDB**, **Redis**, **Valkey**, **MongoDB**,
  **ClickHouse**, **Meilisearch** and **RabbitMQ**.
- Attach a database to a service and its connection string is injected as environment on every
  deploy — resolved fresh from the vault rather than pasted into a `.env` once and forgotten.
- Database Studio (binds a host port, operator-only), topology view, per-database resource limits.

### Backups

- Streaming **AES-256-GCM** encryption on write for database dumps *and* volume archives; restore and
  download decrypt transparently, and legacy plaintext dumps still restore.
- Off-site sync to **Cloudflare R2, AWS S3, MinIO or Wasabi**, with retention pruning.
- Snapshots carry labels (`manual`, `schedule-…`, operator tags) that surface on the Backups page
  alongside scope and volume names.
- Restores are tar-slip validated before extraction and ownership-checked before they run.

### Access control

- **Workspaces** carry membership and four roles (`owner` / `admin` / `member` / `viewer`), enforced
  at the route layer: reads need any seat, writes need `member`, deletion and re-tagging need `admin`.
- **Instance operator** is a separate, explicitly granted flag — not something you can hand yourself
  by creating a workspace — and it gates the host-privilege boundary: PM2, Compose, deploy lifecycle
  hooks, Docker-socket templates and published ports.
- **API tokens carry scopes** (`read` / `write` / `operator`) applied centrally in the auth plugin, so
  a CI or MCP token can never outrank its owner. Tokens support expiry.
- Services can be tagged into many **workspaces, projects and labels** at once, and the whole panel
  filters by all three — AND across the groups, OR inside one.

### Secrets and hardening

- AES-256-GCM in versioned envelopes with a rotatable master-key ring and a re-encryption job; older
  envelopes stay readable.
- **SSRF egress guard** on the operator-supplied outbound URLs whose targets are normally public:
  notification channels, log drains, push delivery, git remotes, OAuth token exchange, the
  marketplace catalog and `templates_source`. Private, loopback and link-local targets are refused,
  closing the `169.254.169.254` metadata path. It is deliberately **not** applied to the OIDC issuer,
  the S3 endpoint, Vault, the log-search backend or the telemetry endpoint — self-hosted Keycloak,
  MinIO and Loki normally *are* on a private address, so guarding those would break working installs.
  Those settings are operator-only, and an operator can already run host commands through a service.
- Subprocesses inherit a whitelisted environment (never `NINEDEPLOY_*`), and the panel refuses to boot
  in production with a known-insecure JWT secret or a weak master key.
- **SSO and 2FA:** OpenID Connect (Google, GitHub, Keycloak, Okta), WebAuthn passkeys, TOTP with
  replay protection, login lockout, and per-session revocation.

### Fleet

- Remote hosts run the same binary with `NINEDEPLOY_AGENT=1` and register with a one-time token. The
  panel drives them through **typed operations** from a fixed table (~24 ops) rather than a command
  line, with every operand regex-validated on both ends.
- **Deploy to a node, not through the panel.** A `docker` service pinned to a `server_id` is built
  and started on that host through the typed agent protocol: the repo is checked out in a
  per-service workspace on the node, the image is built or pulled there, and the environment
  arrives as a 0600 env-file that is deleted the moment the container has taken it.
- **Each node runs its own Traefik.** The node terminates TLS for the services that live on it, so
  you point the domain at the *node* and production traffic never hairpins through the panel. The
  panel stays the source of truth for domains, middlewares and certificate policy: it renders both
  Traefik configs and ships them to the node, which only writes them to a fixed path. A routing
  change refreshes every node automatically; the proxy is only recreated when the *static* config
  changed, so a domain edit is not an ingress interruption.
- **Compose stacks run on a node too**, which matters because most of the one-click template
  catalogue is compose-shaped: the panel ships an inline stack's YAML (or the node checks the repo
  out), writes the `.env` and any volume-attachment override, and then runs the same
  preflight-then-up ordering the local builder uses — `compose config` and `compose pull` complete
  while the previous revision is still serving, so a broken `${VAR}` or a bad tag fails the deploy
  without ever tearing the live stack down. The platform restart policy is applied afterwards,
  because a compose file with no `restart:` leaves every container dead after a reboot.
- PM2 and Nixpacks (Dockerfile-less) builds on a node are **refused at queue time** with a reason
  naming the missing capability — the node agent has no operation for them, and a container on the
  wrong host is worse than a deployment you can read. See *Known limits*.

### Observability

- Live deploy logs and a container **exec terminal** over WebSocket, plus a container file browser and
  a volume browser.
- 30-second metric samples feeding threshold **alert rules** (CPU, memory, certificate expiry) with a
  breaching → firing → recovered state machine and a 30-minute anti-spam cooldown.
- **Log drains** to syslog, Loki, Vector, Datadog or plain HTTP.
- An audit trail with a global event stream, and per-repository framework insights.

### Extensibility

- A **microkernel** with an event bus, waterfall hook pipeline, service registry, config center and
  dynamic menu registry; plugins are written against `@ninedeploy/plugin-sdk`.
- **89 one-click templates** (n8n, Directus, PocketBase, Ollama, Hasura, …) across ten categories.
- **One-click panel self-update:** a dashboard banner runs *this install's own* `install.sh` for the
  pinned tag, detached through `systemd-run` so it survives stopping its own unit, and reports the
  installer output tail when it fails.

---

## The `.ninedeploy` manifest

Keep the deployment shape next to the code. The pipeline applies it under a strict
`panel > manifest > auto-detect` precedence and announces every value it contributed in the deploy
log.

```yaml
version: "1"

runtime:
  type: node
  version: "22"

build:
  install: pnpm install --frozen-lockfile
  build: pnpm build
  start: node dist/server.js

run:
  port: 3000
  healthcheck: /healthz
  restart: on-failure:3

env:
  required: [DATABASE_URL, STRIPE_KEY]

watch:
  paths: [apps/api/**, packages/shared/**]

routes:
  - host: api.example.com
    path: /
    ssl: true

previews:
  enabled: true
  pattern: pr-{n}.previews.example.com

alerts:
  - when: highMemory
    thresholdPct: 85
    channel: ops-slack
```

Sixteen configurable sections beyond `version` — `runtime`, `build`, `run`, `static`, `env`, `phases`,
`resources`, `hooks`, `watch`, `routes`, `previews`, `volume`, `database`, `network`, `notifications`
and `alerts` — each with an editor in the panel's Manifest Creator, which also secret-scans what you
are about to commit.

```bash
ninedeploy manifest init       # scaffold one from the repo
ninedeploy manifest validate   # schema-check + block credential-shaped values before they reach git
ninedeploy manifest show
```

`hooks` is the one section deliberately **not** honoured from the repo: lifecycle hooks execute on the
host, so accepting them from a commit would hand host execution to anyone with push access. A manifest
declaring `hooks` gets a warning in the deploy log instead of an execution.

Full reference: [**docs/NINEDEPLOY_MANIFEST.md**](./docs/NINEDEPLOY_MANIFEST.md).

---

## Clients

### CLI

```bash
npm install -g ninedeploy

ninedeploy init                    # set up and auto-start a local Docker server
ninedeploy login                   # or authenticate against an existing panel
ninedeploy doctor                  # environment and connectivity diagnostics

ninedeploy services list
ninedeploy services create         # interactive wizard
ninedeploy services deploy 12
ninedeploy watch 12 480            # stream a running deployment's logs
ninedeploy deploys cancel 12 480   # stop a queued or in-flight deployment
ninedeploy deploys rm 12 479       # drop a finished deployment from history
ninedeploy env set 12 NODE_ENV production
ninedeploy domains add 12 api.example.com
ninedeploy backups create 3
ninedeploy system dashboard        # live health board
```

40+ commands across services, deploys, env, domains, databases, backups, volumes, networks, sources,
webhooks, workspaces, users, sessions, alerts, firewall, plugins, config-center, templates and system
tooling. The token is stored `0600` in `~/.ninedeploy/config.json`.

### SDK

```ts
import { createClient } from '@ninedeploy/sdk';

const nd = createClient({ baseUrl: 'https://panel.example.com', token: process.env.ND_TOKEN });

const services = await nd.services.list();
await nd.deploys.trigger(services[0].id);
```

Typed namespaces over an injectable `fetch`, built from the same Zod schemas the server validates
with.

### MCP (AI assistants)

```json
{
  "mcpServers": {
    "ninedeploy": {
      "command": "npx",
      "args": ["-y", "@ninedeploy/mcp"],
      "env": {
        "NINEDEPLOY_URL": "https://panel.example.com",
        "NINEDEPLOY_TOKEN": "nd_tok_xxxxxxxxxxxx",
        "NINEDEPLOY_MCP_READONLY": "1"
      }
    }
  }
}
```

**35 tools** over stdio, each mapping 1:1 onto the typed SDK so the MCP wire can never express
anything the HTTP API could not: inspection (`list_services`, `service_logs`, `list_deploys`,
`inspect_container`, `topology`, `system_stats`, `activity_log`, …), guarded actions
(`deploy_service`, `restart_service`, `rollback_deploy`, `update_service`, `system_autoprune`), and
configuration writes (`set_config`, `install_plugin`, `enable_plugin`, …).

The default surface **mutates**. `NINEDEPLOY_MCP_READONLY=1` exposes only the non-mutating,
non-secret allowlist — and pair it with a `read`-scoped token so the restriction is enforced by the
server rather than by the client.

---

## Repository layout

```
NineDeploy/                    pnpm 11 workspace + Turborepo
├── apps/
│   ├── server/                Fastify 5 API, deploy engine, microkernel, agent mode
│   │   ├── src/engine/        pipeline · builders (docker/pm2/compose) · database ·
│   │   │                      proxy · tunnel · logs · autoPrune · repoInsights
│   │   ├── src/modules/       48 route modules + one aggregator
│   │   ├── src/lib/           crypto · jwt · sessions · totp · webauthn · oidc ·
│   │   │                      resourceAccess (the authz choke point) · hostPrivilege ·
│   │   │                      egressGuard · s3 · cloudflare · manifest apply
│   │   ├── src/kernel/        event bus · hook pipeline · config center · menus
│   │   └── src/templates/     89-entry template registry
│   ├── web/                   React 19 + Vite 8 + Tailwind v4 dashboard
│   └── cli/                   `ninedeploy` (commander 15)
├── packages/
│   ├── db/                    Drizzle schema (41 tables) + SQL migrations
│   ├── schemas/               Zod v4 DTOs shared by server, web, CLI, SDK and MCP
│   ├── sdk/                   typed API client over an injectable fetch
│   ├── mcp/                   Model Context Protocol server (35 tools, stdio)
│   └── plugin-sdk/            definePlugin + scoped config helpers
├── website/                   marketing site, docs and template hub
├── docs/                      11 operator guides
├── install.sh                 one-command installer and upgrader
├── Dockerfile                 multi-stage, non-root, checksum-pinned Nixpacks
└── ARCHITECTURE.md            the full internal design spec
```

---

## Testing

```bash
pnpm test           # every package
pnpm release:check  # typecheck → lint → build → test
RUN_INTEGRATION=1 pnpm --filter @ninedeploy/server test   # testcontainers: real PG/MySQL/Redis/Mongo/ClickHouse
```

| Package | Files | Tests | Coverage floor (stmts/branch/func/lines) |
| :--- | ---: | ---: | :--- |
| `apps/server` | 254 | 3,848 | 95 / 90 / 95 / 95 |
| `apps/web` | 89 | 1,479 | 99 / 95 / 99 / 99 |
| `apps/cli` | 33 | 612 | 100 |
| `packages/schemas` | 5 | 275 | 100 |
| `packages/sdk` | 4 | 178 | 100 |
| `packages/mcp` | 2 | 33 | 100 |
| `packages/db` | 8 | 28 | 100 |
| `packages/plugin-sdk` | 1 | 7 | 100 |
| **Total** | **396** | **6,460** | |

Unit and route suites only — the server's six testcontainers integration files (real Postgres, MySQL,
Redis, MongoDB, Valkey, ClickHouse and a deploy end-to-end) are opt-in behind `RUN_INTEGRATION=1` and
run as their own CI job.

The server and web floors were deliberately lowered from 100 with the reasoning recorded inline in
their `vitest.config.ts` — an enforced gate beats an aspirational one that gets bypassed. CI runs
typecheck → lint → build → test, a schema-drift check, a deprecated-dependency check, a Docker image
build, and the integration job.

---

## Documentation

| Guide | What is in it |
| :--- | :--- |
| [Quickstart & upgrading](./docs/QUICKSTART.md) | Install modes, environment variables, systemd internals, in-place upgrades |
| [Private repositories](./docs/PRIVATE_REPO_GUIDE.md) | GitHub PATs, server-generated SSH deploy keys, build-pack choice, auto-deploy webhooks |
| [`.ninedeploy` manifest](./docs/NINEDEPLOY_MANIFEST.md) | Every section, precedence rules, and the `manifest init/validate/show` CLI |
| [Deployments & pipelines](./docs/DEPLOYMENTS.md) | Blue-green, cancellation, watch paths, PR preview environments |
| [Workspaces & RBAC](./docs/WORKSPACES_RBAC.md) | Tenancy, invitations, the role matrix, the instance-operator flag |
| [Security & SSO](./docs/SECURITY_SSO.md) | Vault design, OIDC, passkeys, TOTP, session handling |
| [Databases & backups](./docs/DATABASES_BACKUPS.md) | Engines, injected connection strings, encryption, S3 destinations, restores |
| [Ingress & tunnels](./docs/TRAEFIK_INGRESS.md) | Dynamic routing, ACME HTTP-01/DNS-01, middlewares, Cloudflare Tunnels |
| [Plugins & microkernel](./docs/PLUGINS_MICROKERNEL.md) | Lifecycle hooks, dynamic menus, driver registries |
| [AI, MCP, CLI & SDK](./docs/AI_MCP_CLI.md) | Tool reference, CLI reference, SDK usage |
| [Troubleshooting](./docs/TROUBLESHOOTING.md) | Socket permissions, database locking, healthcheck tuning |
| [Architecture](./ARCHITECTURE.md) | The full internal spec — schema, lifecycle, security model, known gaps |

---

## Known limits

Stated plainly, because finding these out during an incident is worse than reading them here:

- **Agent transport is sealed, but falls back to cleartext.** Operations are encrypted end-to-end
  with the shared agent token when the agent advertises `sealed` on `GET /agent/ping`; a core that
  is newer than its agents silently falls back to plain HTTP, which an on-path attacker can force by
  stripping that flag. Set `NINEDEPLOY_AGENT_REQUIRE_SEALED=1` once the whole fleet is upgraded to
  close that door. There is still no TLS on the transport itself, so keep worker nodes same-LAN or
  same-VPN.
- **Remote deployments cover `docker` and `compose` services.** PM2 (a host process with no agent
  operation) and Nixpacks source builds (no nixpacks on the node) are refused with a reason rather
  than silently run on the panel host. Add a Dockerfile, or clear the target server, to deploy
  those here.
- **Remote health is container state, not an HTTP probe.** The panel sits outside the node's Docker
  network, and publishing a host port purely to be probed would expose every remote service on the
  node's public interface. A remote `docker` deploy is healthy when the container reaches — and
  stays in — `running`; a remote `compose` stack additionally has to pass its own declared
  healthcheck, and fails fast on a crash loop. Both are weaker signals than the local builder's HTTP
  check, and the deploy log says so.
- **The plugin marketplace is inert.** The microkernel, hook pipeline and config center are real and
  drive the built-in plugins; the *remote* marketplace listing is not yet a live index.
- **DNS rebinding is not solved** by the egress guard; it validates at resolve time only.
- **PM2 services have no blue-green window** — they stop, then start, with auto-rollback on failure.

`ARCHITECTURE.md` §16 tracks these against the code, and marks each one as it is closed.

---

## Contributing

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

Biome handles formatting and linting, Vitest handles tests, Turborepo caches both. Changes that touch
the database go through a hand-written migration in `packages/db/src/migrations` plus a case in
`test/schema-drift.test.ts`. Please keep `CHANGELOG.md` honest — it is a load-bearing document here.

---

## License

MIT — see [LICENSE](./LICENSE).
