# NineDeploy — Architecture

> **Doc status.** Written against the tree at `v0.3.5`. Every count in it
> (tables, migrations, routes, tests, templates) was read out of the source, not
> carried over from a previous revision. Where the implementation does not yet
> match the intent, that is stated in the text rather than smoothed over — see
> [§16 Known gaps](#16-known-gaps-implementation-vs-intent), which is part of the
> architecture, not an appendix to it. Most of them were closed in 0.3.5
> (§16.1, §16.2, §16.3 in part, §16.4, §16.5, §16.7); what remains is marked as
> such, with the product decision each one needs.

A self-hosted deployment platform with optional multi-server support. The core
server runs bare-metal (systemd) for direct PM2 + Docker daemon access; a
container image is also published for Docker-based installs (host socket
mounted, `DOCKER_GID` supplied so the non-root image user can reach it). Remote
hosts run the same binary in agent mode (`NINEDEPLOY_AGENT=1`) and execute a
fixed table of typed, validated operations for the core — network management,
and (since 0.7.0) docker and compose deploys to a node through
`engine/builders/remoteDocker.ts` / `remoteCompose.ts`, each node fronted by its
own Traefik. What a node cannot run faithfully is refused up front with a reason
(`lib/remoteDeploy.ts`) rather than deployed half-configured: PM2 and Nixpacks
source builds, containers that need a template command, the Docker socket or
extra volume attachments, repositories cloned with a Git credential, and
services backed by a panel-local managed database. App containers live on
a shared Docker network (`ninedeploy`); Traefik is the intended sole public
listener on :80/:443, with an explicit, operator-gated escape hatch for direct
host port publishing (`services.published_port`).

- **Runtime**: Node ≥ 22.13, pnpm 11 workspace, Turborepo (`turbo run build/dev/lint/typecheck/test/clean/db:*`)
- **Language**: TypeScript 7 strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`), Biome for lint/format
- **Testing**: Vitest 5 + `@vitest/coverage-v8`, Testing Library. Server: 308 files / 4 647 tests, green. Monorepo: 7 498 tests across 470 files, all green (0.10.8). Coverage gates are **tiered**, not uniformly 100 — see [§13](#13-testing)

## 1. System diagram

```
                        ┌──────────────────────────────────────────────────┐
                        │            NineDeploy Core (Fastify 5)            │
                        │            apps/server (systemd or image)         │
   User ──────── WebUI ─┤                                                  │
   (React 19+Vite)      │  ┌───────────────┐  ┌────────────────────────┐   │
   CLI ─────────────────┤  │ Auth          │  │ Deploy Engine           │   │
   (commander 15)       │  │ JWT+sessions  │  │  Git clone → Insights    │   │
   MCP ─────────────────┤  │ API tokens    │  │  → Manifest → Deps      │   │
   (stdio, 36 tools)    │  │ Passkeys/TOTP │  │  → Build → Run → Health │   │
   SDK ─────────────────┤  │ OIDC SSO      │  │  → Proxy swap → Cleanup │   │
                        │  ├───────────────┤  ├────────────────────────┤   │
                        │  │ Workspaces    │  │ Builders                │   │
                        │  │ members/invites│ │  ├─ Docker (buildx/     │   │
                        │  │ labels, tags  │  │  │   nixpacks, blue-green)│  │
                        │  ├───────────────┤  │  ├─ PM2 (host process)  │   │
                        │  │ Secrets       │  │  └─ Compose (ndcmp-)    │   │
                        │  │ AES-256-GCM   │  ├────────────────────────┤   │
                        │  │ key ring      │  │ Database Engine          │   │
                        │  ├───────────────┤  │  PG/MySQL/Redis/Mongo/  │   │
                        │  │ EventBus      │  │  Valkey/ClickHouse      │   │
                        │  │ (lib/events)  │  │  + volumes + backups    │   │
                        │  │ WS push to UI │  │  + Studio containers    │   │
                        │  ├───────────────┤  ├────────────────────────┤   │
                        │  │ Microkernel   │  │ Fastify plugins          │   │
                        │  │ audit-bridged │  │  worker · traefik ·     │   │
                        │  │ registry/hooks│  │  collector · schedulers │   │
                        │  │ configCenter  │  │  housekeeping · runtime │   │
                        │  │ menuRegistry  │  │  State · rateLimit ·    │   │
                        │  │ pluginLoader  │  │  rawBody · secHeaders   │   │
                        └──┬──────┬──┬──────┴──┴────────────────────────┴───┘
                           │      │  │
              ┌────────────▼┐  ┌──▼───────────────┐  ┌─────────────────────┐
              │  Traefik v3 │  │ SQLite (.data/)   │  │ Remote agents       │
              │  :80 / :443 │  │ libsql + Drizzle  │  │ (NINEDEPLOY_AGENT=1)│
              │  auto-HTTPS │  │ 40 tables         │  │ typed ops, plain    │
              │  middlewares│  │ self-migrating    │  │ HTTP transport §7   │
              └──────┬──────┘  └───────────────────┘  └──────────┬──────────┘
                     │
          ┌──────────┼──────────────────────────┐
          ▼          ▼                          ▼
   ┌────────────┐  ┌────────────┐  ┌────────────────────┐
   │ App        │  │ App        │  │ Database           │
   │ (PM2 on    │  │ (Docker /  │  │ containers         │
   │  host)     │  │  Compose)  │  │ + named volumes    │
   └────────────┘  └────────────┘  └────────────────────┘
          │          │                          │
          └──────────┴── ninedeploy network ────┘
             (Traefik resolves containers by name)
```

## 2. Monorepo structure

```
ninedeploy/                       pnpm 11 workspace + Turborepo
├── apps/
│   ├── server/                    Fastify 5 API + deploy engine (163 .ts files)
│   │   ├── src/
│   │   │   ├── engine/     (~4.9k LOC) pipeline, builders (docker/pm2/compose),
│   │   │   │               database, proxy, tunnel, logs, containerFiles,
│   │   │   │               volumeFiles, logDrainManager, autoPrune, magicVars,
│   │   │   │               repoInsights, templateDependencies, serverProvisioner
│   │   │   ├── modules/    (~10.8k LOC) 51 route modules — see §5
│   │   │   ├── lib/        (~7.2k LOC) crypto, jwt, sessions, totp(+replay),
│   │   │   │               webauthn, oauth/OIDC, loginLockout, passwordReset,
│   │   │   │               keyRotation, resourceAccess (authz choke point),
│   │   │   │               hostPrivilege, hostPort, egressGuard, gitEgress,
│   │   │   │               agentClient, spawnValidated, exec, git, vault,
│   │   │   │               s3, backupRemote, cloudflare, firewall, frameworks,
│   │   │   │               ninedeployManifest/-Apply/-ToNixpacks, selfUpdate
│   │   │   ├── kernel/     (~2.1k LOC) microkernel: EventBus, HookPipeline,
│   │   │   │               ServiceRegistry, ConfigCenter, MenuRegistry,
│   │   │   │               auditBridge, pluginLoader + 3 built-in plugins
│   │   │   ├── plugins/    (~1.2k LOC) fastify plugins — see §6
│   │   │   ├── templates/  89-entry registry bundle + Coolify compose mirror
│   │   │   ├── agent.ts    remote-host agent mode
│   │   │   └── version.ts  VERSION + changelog
│   │   ├── scripts/        buildTemplateMirror.ts (compose→template converter)
│   │   ├── test/           186 unit/route files, 2 589 cases
│   │   └── test/integration/  testcontainers (real PG/MySQL/Redis/Mongo/
│   │                          Valkey/ClickHouse + deploy e2e), RUN_INTEGRATION=1
│   │
│   ├── web/                       React 19.2 + Vite 8 + Tailwind v4 (~29.6k LOC)
│   │   ├── src/routes/            27 top-level pages + service/ (16 tabs & cards),
│   │   │                          settings/ (12 sections), manifestCreator/
│   │   │                          (15 section editors), database/
│   │   ├── src/components/        24 components: Layout, DeployWizard,
│   │   │                          DatabaseWizard, NotificationWizard,
│   │   │                          CommandPalette, ContainerTerminal,
│   │   │                          ContainerFileBrowser, VolumeBrowser,
│   │   │                          VolumeBackupsPanel, TopBarFilters,
│   │   │                          WorkspaceSwitcher, PipelineStepper, ui.tsx
│   │   └── src/lib/               api (SDK + 401→refresh→retry), auth, workspace,
│   │                              projects, mode (simple/advanced), theme,
│   │                              useDeployLogs, usePanelUpdate, cron, autofill
│   │
│   └── cli/                       `ninedeploy` CLI — 40+ commands (commander 15)
│
├── packages/
│   ├── db/          Drizzle ORM schema (40 tables) + 37 SQL migrations;
│   │                server self-migrates at startup (drizzle-kit is dev-only)
│   ├── schemas/     Zod v4 DTOs shared by server, web, CLI, SDK, MCP
│   ├── sdk/         Typed API client over an injectable FetchLike; 40+ namespaces
│   ├── plugin-sdk/  definePlugin + scopedConfig helpers for kernel plugins
│   └── mcp/         MCP server (`ninedeploy-mcp`, stdio) — 36 tools
│
├── website/                       Marketing + docs site
├── docs/                          11 operator guides (QUICKSTART, DEPLOYMENTS,
│                                  WORKSPACES_RBAC, NINEDEPLOY_MANIFEST,
│                                  PLUGINS_MICROKERNEL, TRAEFIK_INGRESS, …)
├── .github/workflows/             ci.yml (typecheck/lint/build/test/schema-drift/
│                                  deprecated-deps/image build/integration),
│                                  release.yml, website.yml
├── Dockerfile                     multi-stage; docker CLI + git + tini +
│                                  checksum-pinned Nixpacks 1.41.0; non-root
├── docker-compose.yml             development environment
├── docker-compose.prod.yml        standalone container install (DOCKER_GID)
├── systemd/                       ninedeploy.service unit
├── install.sh                     1 458-line one-click installer
└── ARCHITECTURE.md                This file
```

## 3. Clients

Four first-class clients consume the same REST API (`/v1`) through the shared
typed SDK and Zod schemas:

- **Web** (`apps/web`) — React 19 dashboard; server state via TanStack Query 5,
  no Redux/Zustand (local state is React context only: auth, workspace,
  projects, theme, experience mode). Realtime is purpose-specific: deploy log
  streaming over `WS /v1/services/:id/deployments/:id/logs` (backlog replay +
  live tail), a container exec terminal over `WS /v1/services/:id/exec`
  (xterm.js, binary frames), and a global audit stream over `WS /v1/events`.
  Auth is JWT access+refresh in localStorage with a single-flight
  401→refresh→retry fetch wrapper. A **simple/advanced experience mode**
  (`lib/mode.tsx`, default *simple*) hides advanced nav and controls
- **CLI** (`apps/cli`) — `ninedeploy` (commander 15); token stored 0600 in
  `~/.ninedeploy/config.json`; WebSocket log streaming via `ws`. Commands cover
  login/setup, services, deploys, logs, env, domains, databases, backups,
  volumes, networks, sources, webhooks, workspaces, users, sessions, alerts,
  firewall, plugins/marketplace, config-center, templates, system/prune,
  update-check, manifest `init`/`validate`, `doctor`, `demo seed`
- **MCP** (`packages/mcp`) — Model Context Protocol server (stdio). **36 tools**:
  read-only inspection (`list_services`, `get_service`, `service_logs`,
  `list_deploys`, `list_domains`, `list_databases`, `list_projects`,
  `list_workspaces`, `get_workspace`, `list_alerts`, `activity_log`,
  `system_stats`, `topology`, `health`, `list_log_drains`, `list_menus`,
  `list_configs`, `get_config`, `inspect_container`, `list_container_files`,
  `get_container_compose`, `list_plugins`, `marketplace_plugins`), guarded
  actions (`deploy_service`, `restart_service`, `rollback_deploy`,
  `update_service`, `system_autoprune`, `seed_demo`), and configuration writes
  (`set_config`, `delete_config`, `install_plugin`, `enable_plugin`,
  `disable_plugin`, `uninstall_plugin`). Authenticated with an API token via
  `NINEDEPLOY_URL` / `NINEDEPLOY_TOKEN`.
  ⚠ The MCP surface is **wider than read-only**: an MCP token can mutate config
  and services. Scope it accordingly (see §16.5 on token scopes)
- **Anything else** — the REST API is Zod-documented; the SDK
  (`createClient({ baseUrl, token, fetch? })`) exposes typed namespaces with a
  `NineDeployError` type and injectable fetch

## 4. Database schema (40 tables, migrations 0000–0039)

Storage: **SQLite** via `@libsql/client` (dialect `turso`, local file
`.data/ninedeploy.db`). PRAGMAs at boot: `foreign_keys=ON`,
`busy_timeout=5000`. WAL is deliberately **off** — the system export handler and
`install.sh`'s pre-update backup tar the single db file, and a WAL sidecar would
silently drop recently committed state from those archives
(`packages/db/src/client.ts`).

### 4.1 Identity, teams and access

```
users                  id, email, password_hash, name, token_version
                       (JWT revocation counter), totp_secret_encrypted,
                       totp_enabled, totp_last_step, is_instance_operator.
                       NOTE: the global `role` column is GONE. Team access is
                       workspace-derived; instance-operator rights are the
                       explicit flag above, never inferred (§8.1)
sessions               id, user_id, jti (unique), ip, user_agent, last_used_at,
                       expires_at, revoked_at — one row per refresh token
api_tokens             id, user_id, name, hash(sha256), scopes, last_used_at,
                       expires_at — `scopes` is enforced in plugins/auth.ts
                       (read | write | operator; empty = legacy unrestricted)
webauthn_credentials   id, user_id, credential_id, public_key, counter,
                       transports, name — passkeys
password_reset_tokens  id, user_id, token_hash, expires_at, used_at, requested_from
workspaces             id, name, slug, description, owner_id
workspace_members      id, workspace_id, user_id, role(owner|admin|member|viewer)
workspace_invitations  id, workspace_id, email, role, token, expires_at, accepted_at
oidc_providers         id, name, slug, issuer_url, client_id,
                       client_secret_encrypted, scopes, enabled, auto_enroll,
                       default_role
```

### 4.2 Scoping (N-N, replaces the old single `services.project_id`)

```
projects            id, name, slug, description, workspace_id
labels              id, workspace_id (nullable = global), name, color
service_projects    (service_id, project_id)   PK pair
service_workspaces  (service_id, workspace_id) PK pair
service_labels      (service_id, label_id)     PK pair
```

The top-bar filter composes the three dimensions: ids **OR** within a group,
groups **AND** across each other (`?tagWorkspaceIds=1,2&tagProjectIds=3`).

### 4.3 Services and delivery

```
services       id, owner_user_id, name, slug, type(docker|pm2|compose),
               status(idle|deploying|running|stopped|error|deleting),
               repo_url, branch, commit_sha, source_id, server_id, image,
               volume_mount, port, published_port, health_path, runtime_id,
               cpu_shares, mem_limit_mb, cmd(json), docker_socket,
               template_id, template_database_env(json), compose_service,
               preview_deployments_enabled, preview_auto_destroy_on_close,
               preview_domain_pattern, preview_max_active,
               is_ephemeral_preview, preview_parent_service_id, pr_number
build_configs  id, service_id, build_pack(auto|nixpacks|dockerfile), base_dir,
               install/build/start_cmd, dockerfile_path,
               pre_deploy_cmd, post_deploy_cmd, pre_stop_cmd,
               restart_policy, stop_grace_seconds
deployments    id, service_id,
               status(queued|building|deploying|running|superseded|failed|cancelled),
               commit_sha, image_digest (exact rollback pin), config_snapshot,
               message, author, trigger(user|webhook|cli|schedule), log_path,
               started_at, finished_at
env_vars       id, service_id, key, value_encrypted, is_secret
repo_insights  id, service_id, framework_id, data(json) — framework analysis
sources        id, type(github|gitlab|gitea|bitbucket|custom|registry), name,
               token_encrypted, deploy_key_encrypted, registry_username
webhooks       id, source_id, service_id, branch, events, secret_encrypted,
               active, watch_paths (monorepo path globs)
domains        id, service_id, hostname, path, ssl, redirect_www, status,
               headers, basic_auth, ip_allowlist, rate_limit_average,
               rate_limit_burst
tunnels        id, name, slug, token_encrypted, status, container_name
```

### 4.4 Data services, storage and operations

```
databases              id, project_id, owner_user_id, name, slug, engine,
                       version, status, container_name, internal_host,
                       internal_port, username, password_encrypted, db_name,
                       volume_name, cpu_shares, mem_limit_mb
database_attachments   id, service_id, database_id, env_alias
service_volume_attachments  id, service_id, volume_name, mount_path, read_only
backups                id, database_id, scope(db|scheduled|volumes|full), status,
                       path, size_bytes, remote_key, labels
backup_destinations    id, name, endpoint, region, bucket, prefix,
                       access_key_id, secret_key_encrypted, active
log_drains             id, name, type, endpoint, active — external log shipping
metrics                id, service_id, kind(cpu|memory), value, ts
audit_log              id, user_id, action, entity, meta(json), ts
settings               key, value(json)
config_entries         key, value, is_secret, category, plugin_id — Config Center
installed_plugins      id, name, version, enabled, manifest(json), is_official
notification_channels  id, name, type(telegram|webhook|discord|slack|ntfy|email),
                       target_encrypted, event_filter, active
notification_log       id, channel_id, event, entity, status, attempts, error, ts
alert_rules            id, service_id (null = host-wide),
                       metric(cpu|memory|cert-expiry), operator, threshold,
                       duration_windows, enabled
alert_state            rule_id (unique), status(ok|breaching|firing),
                       breach_since, fired_at, last_notified_at, last_value
scheduled_jobs         id, service_id, name, cron(5-field),
                       kind(deploy|exec|backup), command, enabled, last_run_at
job_runs               id, job_id, status, output, exit_code, started/finished_at
servers                id, name, host, port, status(offline|online|error|pending),
                       token_encrypted, last_seen_at
```

### 4.5 Migration history

`packages/db/src/migrations/`, drizzle-kit generated, forward-only and additive.
39 journalled migrations, `0000` → `0039`. **`0020` does not exist** — the tag
was skipped; the journal (`meta/_journal.json`) is authoritative and does not
reference it, so this is cosmetic.

The journal is not, on its own, proof that the schema is reachable: `0039` had
to be written by hand because drizzle-kit's snapshot already claimed
`log_drains` existed (§16.17). `packages/db/test/schema-drift.test.ts` is the
check that would have caught it, and now does.

Notable later migrations: `0024` domain middlewares · `0025` extended databases ·
`0026` lifecycle hooks + preview deployments · `0027` workspaces + OIDC ·
`0028`/`0029` template database env + durable template recovery · `0030` TOTP
replay + enrolment · `0031` repo insights · `0032` workspace invitations ·
`0033` service volume attachments · **`0034` tags & team overhaul** (drops
`services.project_id` and the global `users.role`; introduces the three N-N join
tables) · `0035` volume backups · `0036` `databases.owner_user_id` ·
`0037` volume backup labels · **`0038` `users.is_instance_operator`** (separates
instance-operator rights from workspace roles — see §8.1) · `0039` `log_drains`
(the table the schema always declared and no migration created — §16.17).

The runtime migrator (`packages/db/src/migrate.ts`) additionally tolerates
"object already exists" failures by re-applying statement-by-statement — this
exists because releases up to 0.2.36 patched columns in at boot outside the
journal, and a batch migrator would abort the whole upgrade on those installs.

## 5. Server request lifecycle

`server.ts` → `buildApp()` (`app.ts`): listen and handle graceful SIGINT/SIGTERM
shutdown. Registration order:

```
cors → websocket → securityHeaders → rateLimit → rawBody → db → kernel → auth
  → error handler → health → events(WS) → /v1 (51 route modules)
  → worker → traefik → runtimeState → collector → backupScheduler
  → housekeeping → jobScheduler → staticFiles (SPA catch-all, LAST)
```

Body limit 256 MB (system import tarballs). CORS allowlist (`publicUrl`, dev
ports, `NINEDEPLOY_CORS_ORIGINS`). Zod failures map to `400 validation_error`
envelopes; 5xx messages are suppressed in production.

### 5.1 Route modules

| Module | Prefix | Routes |
|---|---|---|
| auth | /auth | setup, register (gated), login (lockout + TOTP), passkey register/login, sessions list/revoke, forgot/reset password, 2FA setup/enable/disable, refresh (jti-enforced), logout, password, me, status, API tokens CRUD, **OIDC provider CRUD + SSO start/callback** |
| workspaces | /workspaces | workspace CRUD, member add/role-update/remove, ownership transfer |
| invitations | /workspaces, / | invite create/list/revoke; public token lookup + authenticated accept |
| users | /users | list, password reset, one-time reset link, delete — operator-only |
| projects | /projects | project CRUD (workspace-scoped) |
| labels | /labels | label CRUD (workspace-scoped or global) |
| serviceTags | /services/:id/tags | GET/PUT the service's project/workspace/label tag sets |
| services | /services | CRUD, update (incl. build config PATCH), stop/start/restart, limits, logs, export/import |
| metrics | /services/:id/metrics | historical CPU/memory series (24 h retention) |
| deploys | /services/:id/deploys | trigger, list, rollback, cancel, remove (admin; refuses in-flight and the live one), config diff vs previous, WS logs, WS exec (operator-only, audited) |
| serviceVolumes | /services/:id/volumes | named-volume attachments CRUD + config-repair |
| serviceMigration | /services/:id/export+import | per-service bundle, server-to-server moves |
| insights | /insights, /services/:id/insights | repo framework analysis + on-demand refresh |
| domains | /services/:id/domains | add (Cloudflare record auto-provision + ownership proof), list, remove, per-domain SSL / headers / basicAuth / IP allowlist / rate limit |
| domainIndex | /domains | list all (scoped), SSL toggle |
| databases | /databases | CRUD, limits, wizard, credentials (operator), **Studio container start/stop** |
| databaseBackup | /databases/:id | storage, backups, restore (ownership-checked) |
| backups | /backups | list, delete (incl. remote object), download |
| backupDestinations | /backup-destinations | S3-compatible CRUD + connectivity test |
| volumes | /volumes | inventory, delete, browse |
| volumeBackups | /volumes/:name/backups | snapshot create/list/restore/download (labelled) |
| containers | /containers/:name | inspect, compose, file browser (list/read/write/mkdir/delete) |
| env | /services/:id/env, /projects/:id/env, /env/search | service + project-scope env CRUD, cross-scope key search |
| hooks | /hooks, /services | receive (HMAC + branch + watch-path globs + replay dedup + **PR preview create/destroy**), manage CRUD; public, rate-limited |
| templates | /templates | list, detail, deploy — schema-validated registry (89 entries; bundled JSON, DB/env source override with 6 h cache + offline fallback) |
| topology | /topology | graph (services + DBs + domains + attachments) |
| stats | /stats, /services/:id/metrics | live snapshot, time series |
| dashboard | /dashboard | aggregate stats + health probes + recent |
| sources | /sources | CRUD (PAT, deploy keys, registry creds) |
| tunnels | /tunnels | CRUD (cloudflared) |
| networks | /networks | list with members, create/delete, container attach/detach (local + typed-agent remote) |
| traefik | / | status, certificates, logs, config, restart, backup-certs, version, update |
| firewall | /firewall | UFW status, toggle, rule CRUD, recommended ruleset |
| resources (system) | /system | resources, docker-events feed, prune-images, **update-check / update-status / update-start (self-update)**, export, import (tar-slip guarded, rollback) |
| housekeeping | /housekeeping | prune config get/patch, manual prune |
| jobs | /services/:id/jobs | cron deploy/exec/backup jobs, run-now, run history |
| servers | /servers | remote agent registry, one-time token on register, connectivity test (one deliberately unauthenticated write: agent self-announce). Nodes drive `docker.network*` today; **deploying a service to a node is not implemented** — `runDeployment` refuses it (`lib/remoteDeploy.ts`) rather than building on the panel host |
| logDrains | /log-drains | CRUD + test |
| settings | /settings | registration toggle, ACME email, template source, DNS-01, vault provider (Infisical/Doppler), Cloudflare DNS |
| configCenter | /config | typed config entries get/set/delete with secret reveal |
| plugins | /plugins | list, marketplace, install, uninstall, enable, disable, inspect, reload  ⚠ §16.3 |
| menus | /menus | plugin-contributed nav items (consumed by `Layout.tsx`) |
| notifications | /notifications | channels CRUD, test, delivery log |
| alerts | /alerts | alert rule CRUD + state |
| activity | /activity | audit log feed |
| about | /about | version, changelog, tech stack (public); counts when authenticated |
| demo | /demo | seed demo data |
| health | /health | liveness + DB ping (public) |
| events | /v1/events (WS) | global real-time audit stream (backlog replay, per-user delivery scoping) |

## 6. Fastify plugins

| Plugin | Function |
|---|---|
| securityHeaders | CSP / frame / referrer / nosniff response headers |
| rateLimit | Global + per-route IP rate limiting (auth/setup/webhook tighter) |
| rawBody | Captures raw body for HMAC + binary uploads |
| db | Decorates `fastify.db`; enables PRAGMAs; **applies pending migrations via the runtime migrator** |
| kernel | Instantiates the microkernel, registers drivers + 3 built-in plugins, loads DB-installed plugins on `onReady`, and bridges the audit stream into the kernel event bus (§16.3) |
| auth | `authenticate` (JWT access or API token; `isOperator` recomputed per request) + `requireOperator` / `requireAdmin` (alias) |
| worker | Polls queued deployments (2 s) and runs the pipeline. Claims are atomic (`queued→building` verified via rowsAffected) and skip services already `building`. Concurrency is **partitioned per target server**, each partition getting `NINEDEPLOY_DEPLOY_CONCURRENCY` slots (default 1, max 8). Sweeps `building` rows older than 45 min back to `queued` on boot; 60 s stop grace |
| traefik | Ensures `ninedeploy` network + Traefik v3.3 container (config **directory** bind mount) + writes dynamic config atomically; DNS-01 when a provider+token are configured, else HTTP-01 |
| runtimeState | Reconciles panel status against live containers/processes |
| collector | Samples container + host stats every 30 s → metrics table; prunes metrics older than 24 h; feeds the alert evaluator (cpu %, memory MiB, host, cert-expiry days) |
| backupScheduler | Daily database backups (`scheduled` scope), keeps last 7 per DB — never prunes manual backups; pushes to S3-compatible destinations via the dependency-free SigV4 client |
| housekeeping | Hourly retention: deploy logs (30 d), audit log (90 d), notification log (30 d), expired reset tokens (24 h), dangling Docker images |
| jobScheduler | Cron-scheduled per-service jobs via croner; re-reads the jobs table every 5 min; run history in `job_runs` |

## 7. Deploy engine

Everything goes through the **Docker CLI** via validated spawn — no dockerode.
All process spawning funnels through `lib/spawnValidated.ts` (operand regexes,
arg-array exec, never a shell string); `lib/exec.ts` adds hard timeouts +
tree-kill (SIGTERM→SIGKILL) and a whitelisted env inheritance (never
`NINEDEPLOY_*`).

### 7.1 Pipeline (`engine/pipeline.ts`)

```
 1. Trigger (manual / webhook / CLI / cron job / template) → deployment row (queued);
    a [skip ci]/[skip cd] head-commit marker skips webhook auto-deploys
 2. A worker slot claims it atomically → status: building. The row stores a
    config snapshot (build config + env-key fingerprint — values never),
    powering the per-deploy config diff
 3. Crash recovery: `building` rows older than 45 min are requeued on boot
 4. PREPARE — image deploy: pull (rollback pins an exact digest).
    Repo deploy: resolve source creds → checkout commit (token/SSH key
    scrubbed) → framework analysis into `repo_insights` (best-effort)
    → load `.ninedeploy` manifest and apply its OPERATIONAL sections
      (routes, database, alerts). The build-shaping sections are folded in at
      step 8 under `panel > manifest > auto-detect` (§16.2)
 5. DEPENDENCIES — for template services, reconcile managed DB dependencies
    idempotently (durable via `services.template_id`)
 6. Gather env: project-scope shared vars ← service vars ← attached-DB
    connection strings / template `databaseEnv` mapping (later wins), then
    resolve ${{infisical:KEY}} / ${{doppler:KEY}} vault refs at deploy time
    (never stored; a missing key fails the deploy). Registry auth from
    registry-type sources. A deploy fails if any attached DB is not running
 7. Pre-deploy hook (if configured) — runs on the HOST
 8. BUILD — the manifest's `build`/`run`/`resources` fill in whatever the panel
    left empty, `env.required` gaps become warnings, and `runtime`/`phases` are
    rendered into a `nixpacks.toml`. Then builder dispatch: Docker (Dockerfile
    via buildx, or Nixpacks for Dockerfile-less repos) / PM2 (install + build
    with the service env) / Compose (`docker compose up -d --build`, prefix
    ndcmp-)
 9. BOOT — start the NEW runtime with env-file secrets (0600 temp file, deleted
    after start) + network + volume attachments + limits + restart policy.
    The previous Docker container keeps serving (blue-green)
10. HEALTHCHECK — container alive (docker inspect) AND HTTP probe against the
    container's network IP (fresh per attempt, per-attempt AbortSignal; up to
    5 min). Post-deploy hook afterwards (failure is a warning, not fatal)
11. SUCCESS (outside the try — a post-success hiccup can never kill the healthy
    container): finalize the deployment row conditionally on still being
    `building` (a late cancel wins), warn on managed-env value drift, persist
    the image digest, demote older `running` rows to `superseded`, auto-assign
    the wildcard domain, flip Traefik routing, and ONLY THEN (after a 2 s
    settle) run the pre-stop hook and retire the previous container
12. FAILURE — stop the NEW runtime; if the previous is still healthy (Docker
    blue-green), the service keeps serving it and only the deployment is marked
    failed. PM2 has no previous (stop-then-start), so it goes down
13. CANCEL — the pipeline re-reads the row status at every checkpoint and tears
    down the partial runtime (`DeploymentCancelled`). In-place compose
    redeploys are detected and NOT torn down (their id is the live instance)
14. REMOTE — a `docker` service with `server_id` is built and started ON THAT
    NODE by `engine/builders/remoteDocker.ts`, which drives the typed agent
    protocol (git.ensure/checkout/reset, docker.build|pull, file.writeEnv,
    docker.runEnv, file.deleteEnv). The node runs its own Traefik, so it
    terminates TLS for its own services and traffic never hairpins through the
    panel; `lib/nodeProxy.ts` ships the panel-rendered configs. A `compose`
    service goes through `engine/builders/remoteCompose.ts` — inline YAML or a
    checkout, then `.env` + volume override, then composeConfig/composePull
    preflight BEFORE `up`, then the restart policy. PM2 and Nixpacks source
    builds on a node are still refused with a reason (`lib/remoteDeploy.ts`) —
    the agent has no operation for them, and a container on the wrong host is
    worse than a readable failure
15. Every subprocess has a hard timeout + tree-kill. Audit + EventBus +
    notification dispatch throughout; logs stream over WebSocket and persist to
    disk (engine/logs.ts LogBus), stage-tagged as `##[stage:NAME:state]`
```

### 7.2 Builders

- **docker.ts** — build (Dockerfile or Nixpacks) + run on the shared
  `ninedeploy` network, secrets via 0600 temp env-file, healthchecks against
  container IPs. Optional `-p published_port:container_port` host publish
  (operator-gated, reserved ports refused). Blue-green switch + auto rollback
- **pm2.ts** — Node runtime managed by PM2 on the host, stop-then-start (brief
  gap, auto-rollback on failure). Host-privileged — operator-only
- **compose.ts** — `docker compose up -d --build` with the `ndcmp-` project
  prefix; no blue-green (compose controls the lifecycle). Host-privileged —
  operator-only

### 7.3 Reverse proxy (`engine/proxy.ts`)

Traefik v3.3 as the intended sole exposed container (:80/:443), shared
`ninedeploy` network, atomic dynamic-config writes (temp+rename, directory bind
mount — a single-file mount would pin the inode and never see renames), strict
sanitizing of Host/Path rule operands (anti rule/YAML injection). Per-domain
middlewares: www→apex redirect, custom response headers, basicAuth,
`ipAllowList`, `rateLimit`. ACME email + DNS-01 wildcard support from settings;
certificate expiry is parsed out of `acme.json` and fed to the alert evaluator.

## 8. Auth, RBAC and account security

- **JWT** (jose, HS256): access 15 m + refresh 7 d; `ver` claim matched against
  `users.token_version` — logout, password change/reset bump it, revoking every
  outstanding session statelessly
- **Sessions**: every refresh token carries a `jti` referencing a live row (ip,
  user agent, last used, expiry, revoked). `/auth/refresh` enforces the row on
  every rotation, so one device can be signed out without touching others
- **Passkeys**: WebAuthn registration + passwordless login via
  `@simplewebauthn/server`; RP derives from the public URL hostname, challenges
  are single-use with a 5-minute TTL, signature counters track clone detection
- **API tokens**: opaque, sha256-hashed at rest, optional expiry +
  `last_used_at`, and **enforced scopes** (`read` / `write` / `operator`) applied
  centrally in `plugins/auth.ts`. A scope can only narrow the owner's authority;
  an empty list is a pre-0.3.5 token and stays unrestricted (§16.5)
- **2FA**: dependency-free RFC 6238 TOTP, secret encrypted at rest; codes are
  **consumed**, not just verified, so a replay inside the drift window fails
- **SSO**: OIDC providers (`oidc_providers`), auto-enrolment into a personal
  workspace with a configurable default workspace role
- **Passwords**: Argon2id; self-service change + operator reset + single-use
  30-minute reset links
- **Lockout**: in-memory per-account — 5 consecutive failures → 15 min lock, on
  top of per-IP rate limits
- **Registration gate**: `allow_registration` (default **off**); bootstrap
  (zero users) always permitted
- **WebSocket auth**: auth subprotocol header, with `?token=` back-compat (query
  strings are stripped from request logs)

### 8.1 The authorization model — and its central weakness

`lib/resourceAccess.ts` is the single authorization choke point. The intended
model is workspace-scoped:

- **service** → caller is a member of a workspace the service is tagged into,
  or is the service's `owner_user_id`
- **project** → caller is a member of the project's workspace; a NULL-workspace
  project is operator-only
- **database** → `owner_user_id` match, or membership of the owning project's
  workspace

Above that sits **`isOperator`**, read from the dedicated
`users.is_instance_operator` column and recomputed on every request. It bypasses
every resource loader and gates every system-wide route (`requireOperator`,
aliased `requireAdmin`): users, OIDC, system import/export, self-update, volumes,
sources, tunnels, firewall, config center, plugins, containers/file browser,
database credentials, exec, backups.

It also gates the **host-privilege boundary** (`lib/hostPrivilege.ts`): PM2
services, Compose deploys, pre/post/pre-stop lifecycle hooks and
`docker_socket` templates all execute code on the host and are therefore
operator-only — as is publishing a privileged host port (`lib/hostPort.ts`).

The flag is **deliberately not derived from workspace membership**. Until 0.3.4
`isOperator` meant "holds `owner`/`admin` in at least one workspace"; because
`POST /v1/workspaces` has no role gate and inserts the caller as `owner` (and
`GET /v1/workspaces` auto-creates an owned workspace for a user with no seats),
any authenticated user could promote themselves to full instance operator with
one request — and, through the host-privilege boundary, reach arbitrary code
execution on the host. Migration `0038` moved the flag onto the user row:

- the bootstrap user (first `/setup`, first `/auth/register`, or the first SSO
  auto-enrolment on an empty instance) receives it;
- everyone else is granted it explicitly by an existing operator via
  `PATCH /v1/users/:id/operator` (Settings → Users);
- the last remaining operator cannot be demoted or deleted;
- creating a workspace confers nothing at instance level.

`test/operatorEscalation.test.ts` pins this against a real database — it fails
against the pre-0.3.5 implementation.

Within a workspace, the four roles are a real hierarchy
(`owner > admin > member > viewer`) enforced by `assertWorkspaceRole` and, for
service-scoped writes, **`assertServiceRole`**. The effective role on a service
is the highest seat the caller holds across the workspaces that service is
tagged into, with the service's `ownerUserId` and the operator flag both
counting as `owner`. The convention across the routes is:

| Action | Required |
|---|---|
| read a service, its deploys, logs, env keys | any seat (incl. `viewer`) |
| deploy, rollback, cancel, restart/stop/start | `member` |
| edit the service or build config, write env, manage domains, set limits | `member` |
| delete the service, re-tag it into other workspaces | `admin` |
| host-privileged shapes (PM2, compose, lifecycle hooks, docker socket), instance-wide routes | instance operator |

## 9. Multi-server (agent mode)

Remote hosts run the same server binary with `NINEDEPLOY_AGENT=1`, which boots a
minimal HTTP agent instead of the full API (`src/agent.ts`, `src/agentApp.ts`):

- Registered in the `servers` table via a one-time token (printed once); the
  shared token is stored encrypted and compared as sha256 (timing-safe).
  `last_seen_at` tracks health; connectivity is testable from the Servers page.
  An agent may also self-announce to `NINEDEPLOY_MASTER_URL` — this is the one
  deliberately unauthenticated write in the product
- The core talks to agents through `lib/agentClient.ts` → `POST /agent/exec`
  with a **typed operation name** from a fixed table (~24 ops: docker
  pull/build/run/runEnv/stop/rm/inspect/logs/login/logout, network
  create/rm/connect/disconnect, compose up/down, git
  clone/fetch/checkout/rev-parse/reset, file writeEnv/deleteEnv), never a
  program name or raw argv
- Every operand (names, paths, URLs, refs, SHAs) is validated by strict regexes
  on both ends; all spawning funnels through `lib/spawnValidated.ts`
- **Transport is plain `http://` but the payload is sealed** (`lib/agentSeal.ts`,
  0.3.5). Both ends derive a per-message key with HKDF-SHA256 from the shared
  secret — `sha256(agentToken)`, the only value both sides hold — and the body
  travels as AES-256-GCM with the timestamp bound in as AAD. So the token stops
  crossing the network entirely (opening the envelope *is* the authentication),
  and so do the decrypted service secrets `file.writeEnv` carries. Envelopes
  older than ±5 min are refused, so a captured one stops being useful
- The core learns whether it may seal from `GET /agent/ping` (`sealed: true`).
  An agent that has not been upgraded still gets the legacy plaintext request,
  with a warning naming the host in the deploy log. Set
  `NINEDEPLOY_AGENT_REQUIRE_SEALED=1` on the core once the fleet is upgraded and
  that fallback — the one downgrade an on-path attacker could force — is refused
- ⚠ Still **no TLS**: this hides the payload, not the metadata (which host, when,
  how often, roughly how large), and it gives no forward secrecy and no defence
  against an attacker who already owns the agent host. Agents belong on a private
  network. Real mTLS remains the long-term answer (§16.6)

## 10. Scoping: workspaces, projects, labels

Three independent, optional tag dimensions replace the old single-parent
project hierarchy (migration `0034`):

- **Workspace** — the team/tenancy unit. Carries membership and roles
- **Project** — a grouping inside (or across) workspaces
- **Label** — free cross-cutting tagging ("production", "team-x"), workspace-
  scoped or global

A service may belong to many of each. The web UI keeps the active workspace in
`lib/workspace.tsx` (localStorage-persisted) and the composed tag filter in the
top bar; the API accepts `?tagWorkspaceIds=&tagProjectIds=&tagLabelIds=`.

All list endpoints share one visibility rule — `visibleServiceIdSet` in
`lib/resourceAccess.ts`: owned services ∪ services tagged into a workspace the
caller belongs to, unrestricted for instance operators. `GET /v1/services`,
`/dashboard`, `/domains` and the per-service loader used to disagree, so a
teammate could deploy a shared service by id but never saw it in their own list
(§16.7).

## 11. Web UI

- **Stack**: React 19.2 + react-router 8, Vite 8, Tailwind CSS v4 (CSS-first
  `@theme`, no tailwind.config), TanStack Query 5, xterm.js 6, @xyflow/react 12,
  lucide-react
- **Theming**: dark/light via `data-theme` + 6 accent colors via `data-accent`;
  persisted in localStorage; dark + indigo default
- **Experience mode**: `simple` (default) vs `advanced` — hides advanced nav
  groups and controls for first-time operators
- **Layout**: icon rail with collapsible groups + secondary panel, workspace
  switcher, top-bar tag filters, Ctrl-K CommandPalette, panel self-update banner
- **Service Detail** (`routes/service/`) — tabs: **Overview** (status header,
  live CPU/memory sparklines, runtime metadata, deployment history with
  rollback, WS live deploy logs, runtime log tail, exec terminal), **Deploys**
  (live WS logs, rollback, cancel, config diff, `PipelineStepper` stage view),
  **Environment** (env vars with write-only secrets, DB attachments, webhooks
  with one-time secret reveal, cron jobs), **Network** (domains, per-domain SSL,
  basicAuth, IP allowlist, rate limit), **Volumes** (named-volume attachments +
  browser + backups), **Framework** (repo insights), **Manifest**
  (`.ninedeploy` view), **Architecture**, **Settings** (service fields, build
  config incl. lifecycle hooks and restart policy, limits, preview deployments),
  **Activity**, **Danger zone**
- **Other pages** — Dashboard, Hub (89-template gallery), Services, Databases
  (+ detail, topology, Studio), Projects, Labels, Workspaces, Domains, Tunnels,
  Networks, Volumes, Topology, Backups, Sources, Servers, Users, Monitoring,
  Docker, Traefik, Activity, **Manifest Creator** (15 section editors + secret
  scan), Settings (Account / Appearance / Security / System / Notifications /
  Integrations / Storage / LogDrains / SSO / Firewall / ConfigCenter / Plugins /
  Migration), About

## 12. Alerting

Threshold rules (`alert_rules`) evaluated by the collector on every 30 s sample:

```
ok → breaching (first breach, breach_since = now)
   → firing  (breach sustained ≥ duration_windows × 30s → ONE notification)
   → ok      (clears → recovery notification, only if it had fired)
```

- Metrics: `cpu` (% per container or host), `memory` (MiB), `cert-expiry` (days
  remaining across issued Let's Encrypt certificates)
- Notifications ride the existing channels via `audit()` → `notifyEvent`
  (`alert.fired` / `alert.recovered`, filterable per channel)
- Anti-spam: 30-minute cooldown before re-notifying; state reset on rule edits

## 13. Testing

| Package | Files | Statements / Branches / Functions / Lines |
|---|---|---|
| apps/server | 186 (2 589 tests) | **95 / 90 / 95 / 95** |
| apps/web | 82 (1 389 tests) | **99 / 95 / 99 / 99** |
| apps/cli | 23 (460 tests) | 100 / 100 / 100 / 100 |
| packages/db | 8 (27 tests) | 100 |
| packages/schemas | 4 (257 tests) | 100 |
| packages/sdk | 3 (122 tests) | 100 |
| packages/mcp | 2 (28 tests) | 100 |
| packages/plugin-sdk | 1 (7 tests) | 100 |

The server and web floors were deliberately lowered from 100 with the reasoning
recorded inline in their `vitest.config.ts`. Integration tests (testcontainers,
real PostgreSQL/MySQL/Redis/MongoDB/Valkey/ClickHouse + deploy e2e) are opt-in
via `RUN_INTEGRATION=1` and run as a separate CI job.

CI (`ci.yml`) runs typecheck → lint → build → test, plus a **schema-drift check**
(regenerating migrations must produce no diff) and a **deprecated-dependency
check**, then a Docker image build and the integration job.

The schema-drift gate is **functional** as of 0.6.0. The snapshot chain was
broken from `0032`–`0048`, so `drizzle-kit generate` diffed against a stale
schema and aborted on a column-rename prompt with no TTY; the chain was rebuilt
by introspection and the CI step now *requires* the literal
`No schema changes, nothing to migrate` line plus a clean `git status`, so a
tool that fails for any other reason can no longer pass the gate silently.
`packages/db/test/schema-drift.test.ts` remains the second line of defence:
it applies every migration to a fresh in-memory database and compares both
directions against the Drizzle schema.

## 14. Installation, updates and supervision

- **`install.sh`** (1 458 lines): checks/installs Node ≥ 22.13 and Docker via
  signed APT repos, installs a **checksum-verified Nixpacks** binary, resolves
  the target version via release channels (`--channel=release` default,
  `--channel=main`, `--version vX.Y.Z`), supports both **bare-metal** and
  `--docker` (compose) modes, renders the systemd unit from placeholders,
  installs a migration safety override, snapshots `.data` before upgrading,
  rebuilds + migrates + restarts and gates on `/health`. Builds a Traefik
  fallback image when the upstream one is unusable
- **Update check** (`lib/updateCheck.ts`): GitHub-Releases-format feed, semver
  compare, 6 h cache; offline → `updateAvailable: null`
- **Self-update** (`lib/selfUpdate.ts`): `POST /v1/system/update-start` with
  progress polling — one-click panel upgrade from the dashboard
- **systemd**: `Type=simple`, `WatchdogSec=0`, `Restart=always`, hardening
  (`ProtectSystem=full`, explicit `ReadWritePaths`, `NoNewPrivileges`,
  `PrivateTmp`); readiness verified through the HTTP `/health` gate so
  long-running Docker children are not killed by a watchdog

## 15. Security model

- **Containers**: healthchecks probe container network IPs; Traefik routes by
  name over the shared network. Host ports are *not* published by default, but
  `services.published_port` is a real, operator-gated feature — reserved ports
  (panel, 80, 443, 22) are refused for everyone, sub-1024 for non-operators
- **Traefik**: the intended sole public listener; dynamic config written
  atomically with a directory bind mount; Host/Path operands sanitized
- **Secrets**: AES-256-GCM in versioned envelopes (`v<ver>:iv:tag:ct`). Master
  key rotatable via the `NINEDEPLOY_MASTER_KEYS` ring +
  `POST /v1/settings/master-key/rotate` (or `ninedeploy system rotate-keys`);
  legacy envelopes stay readable (key version 0). Backup envelopes carry their
  own key version and are *not* rewritten by a rotation — see §16.9
- **Backups encrypted at rest** — dumps are sealed with the master key on write;
  restore and download decrypt transparently, legacy plaintext restores as-is
- **Webhooks**: HMAC-SHA256 (GitHub/Gitea) or token (GitLab) + branch match +
  watch-path globs + replay dedup; public receiver rate-limited 60/min
- **SSRF egress guard** (`lib/egressGuard.ts`): outbound operator-supplied URLs
  (notification webhooks, OIDC issuer, S3 endpoint, template source, log drains,
  git remotes, insights) are refused when they resolve into private, loopback or
  link-local space — closing the metadata-service (`169.254.169.254`) and
  internal-container reach. DNS rebinding is explicitly *not* solved; escape
  hatch `NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1`
- **Domain ownership proof** (`lib/domainVerification.ts`): non-operators must
  prove control of a hostname before attaching it
- **Subprocess hygiene**: whitelisted env inheritance (never `NINEDEPLOY_*`);
  runtime secrets via temp `--env-file` (0600, deleted after start); tree-killed
  on timeout
- **DB ops**: idempotent container start; backup/restore via arg-array
  `docker exec` + `docker cp` (no host shell); restore ownership-checked
- **Imports**: tar members validated before extraction (tar-slip); system import
  rolls back on mid-flight failure; per-service bundles operator-only
- **Logs**: request serializer strips query strings
- **Production guards**: refuses to boot with a known-insecure JWT secret, or
  with a weak/short master key (checked for both `NINEDEPLOY_MASTER_KEY` and
  every version in `NINEDEPLOY_MASTER_KEYS`)

## 16. Known gaps (implementation vs. intent)

These are load-bearing facts about the current architecture. They are listed
here so the rest of this document can be read as accurate.

### 16.1 ~~Operator privilege is self-granting~~ — FIXED in 0.3.5

`isOperator` used to mean "owner/admin in at least one workspace", and any
authenticated user could create a workspace they own. One request therefore
promoted any member to full instance operator — including the host-privileged
deploy paths, i.e. arbitrary code execution on the host.

Resolved by migration `0038` + `users.is_instance_operator`: the flag is now an
explicit column, granted at bootstrap or by an existing operator
(`PATCH /v1/users/:id/operator`), never by workspace membership. The last
operator cannot be demoted or deleted. See §8.1;
`test/operatorEscalation.test.ts` fails against the old implementation.

Backfill on upgrade is deliberately narrow: the bootstrap user (lowest id) plus
owners/admins of the OLDEST workspace. Anyone who had become an "operator" by
creating their own workspace is **not** carried over — an operator re-grants the
flag from Settings → Users if that was legitimate.

### 16.2 ~~The `.ninedeploy` manifest is ~20 % wired~~ — mostly FIXED in 0.3.5

Only `routes`, `database` and `alerts` reached a deploy; `build`, `run`,
`runtime`, `phases`, `resources` and `env.required` were parsed, validated,
covered by tests and offered in a 15-section Manifest Creator — then dropped.
`lib/ninedeployToNixpacks.ts` (234 LOC) and `lib/ninedeployApply.ts` (63 LOC)
had no importers, while `docs/NINEDEPLOY_MANIFEST.md` §6.1 described a
`nixpacks.toml` that nothing generated.

Now wired, under the documented `panel > manifest > auto-detect` rule:

| Section | Effect |
|---|---|
| `build.install/build/start/baseDir/dockerfile` | folded into the effective `BuildConfig` for this deploy (never persisted — the manifest travels with the commit) |
| `run.port`, `run.healthcheck` | fill `services.port` / `health_path` when unset |
| `run.restart` | fills `build_configs.restart_policy` when still at the default |
| `resources.cpuShares`, `resources.memMb` | fill the limits when the panel left them at 0 (unlimited) |
| `env.required` | each missing key is a deploy-log warning (not fatal — the value may come from the image) |
| `runtime`, `phases` | rendered into a real `nixpacks.toml` next to the source by the Docker builder; a repo that already ships one keeps it |

**`hooks` is deliberately still ignored**, and now says so in the deploy log.
Deploy lifecycle hooks execute on the HOST, which is exactly what
`lib/hostPrivilege.ts` gates behind the instance-operator flag — and that gate
reads the STORED build config before the deploy starts. Honouring a
manifest-supplied hook would let anyone with push access to the repository run
commands on the host, bypassing the boundary and breaking container isolation
for ordinary Docker services. Hooks stay a panel-only setting.

Still unwired (each emits a deploy-log warning): `volume.backups`,
`notifications`, `previews`, `static`, `watch`, `network`.

### 16.3 The microkernel was inert; the marketplace lied — partly FIXED in 0.3.5

Two separate defects lived under one heading.

**The event bus was dead.** NineDeploy carries two unrelated buses:
`lib/events.ts` (real — `audit()` publishes to it, `/v1/events` serves it) and
`kernel/eventBus.ts` (typed, what plugins subscribe to). Nothing ever emitted
into the second. The three built-in plugins that ship *enabled* listened for
`deployment.status_changed`, `service.health_changed` and `backup.completed` —
names no code emitted — so they ran on every install and did nothing.

Fixed by `kernel/auditBridge.ts`: one subscription to the audit stream that
already sees every state change, republished as the raw `audit.recorded`
firehose plus a typed domain event where the action maps unambiguously.
Bridging at `audit()` rather than sprinkling `kernel.events.emit(...)` through
51 route modules means a new route is covered the day it is added.

**The marketplace pretended to install things.** Nothing in `pluginLoader.ts`
ever `import()`s code: an npm/git/local "install" became a DB row plus a shell
whose `init` emits one event, and the panel then reported it *active*. Worse,
several of the 16 catalog entries shadow features that already ship under
another name — an operator who installed "Amazon S3 & Cloudflare R2 Sync",
entered a bucket and secret key and saw it active would reasonably believe their
backups were being copied off-site. They were not, and they would find out at
restore time.

Now:

- `npm` / `git` / `local` installs are **refused** with an explanation instead
  of creating an inert row.
- Every catalog entry carries `implemented` (all 16 are `false` today) and,
  where it shadows a shipped feature, a `builtIn` pointer. Installing an
  unimplemented entry is refused with a message naming the real feature; the
  panel renders the pointer as a link instead of an Install button.
- Rows installed by an older build from an unsupported source are skipped at
  boot with a one-line warning naming the row, rather than restored as shells
  reporting themselves active.

**Still open — the product decision.** The catalog is now an honest roadmap
index, not an installable marketplace. Either implement real plugin loading
(fetch, integrity verification, sandboxing, an upgrade story) or drop the
marketplace UI and keep `ConfigCenter` + `MenuRegistry`, which are the parts
that were always real. The `notification.queued` event the built-in
notifications plugin emits stays an extension point on purpose: `lib/notifier`
owns channel delivery, and wiring the plugin into it would send every alert
twice.

### 16.4 ~~The role hierarchy is documented but not enforced~~ — FIXED in 0.3.5

`assertWorkspaceRole` / `roleAtLeast` existed with zero call sites, so a
`viewer` could create services, edit environment variables and trigger deploys
exactly like an `owner`.

`assertServiceRole` (in `resourceAccess.ts`) is now the enforcement point and is
applied across the service, deploy, env, domain and tag routes. Reads need any
seat; writes need `member`; destroy and re-tag need `admin`. See the table in
§8.1 and `test/workspaceRoleEnforcement.test.ts`.

`assertDatabaseRole` extends the same hierarchy to managed databases, whose
workspace comes from their project: reads need any seat, lifecycle and limits
need `member`, and deletion, backups, restores and credential reveal need
`admin`. Service volumes and cron jobs follow the service role.

Two deliberate exceptions stay instance-operator-only regardless of workspace
role, because they reach past the workspace boundary: **database Studio** (binds
a host port) and the **volume-scope backups** at `/backups/:bid` (no owning
database to derive a role from).

Relaxing the credential and backup routes from operator-only also required
adding the per-database ownership check that `DELETE /backups/:bid` and
`GET /backups/:bid/download` never had — while only operators could reach them
an id-based lookup was safe; with workspace admins in scope it is not.

### 16.5 ~~API token scopes are stored but never checked~~ — FIXED in 0.3.5

`api_tokens.scopes` was written as `[]` on every create and read by nothing, so
every token carried its owner's full authority, operator flag included. A CI or
MCP token was an instance-root credential.

Scopes are now a real, enforced vocabulary — `read` (safe methods only),
`write` (mutate, but always as a NON-operator) and `operator` — applied in one
place, `plugins/auth.ts`, so new routes are covered the day they are added. A
token can never outrank its owner: requesting `operator` as a non-operator is
refused at creation. Tokens also accept an optional `expiresInDays`.

An EMPTY scope list still means unrestricted. That is deliberate back-compat for
tokens already deployed in someone's CI; the CLI now prompts for a scope and
`ninedeploy token list` labels the legacy ones `unrestricted`. Auditing and
re-issuing those is an operator task, not something an upgrade should do
silently.

### 16.6 ~~Agent transport is unencrypted~~ — FIXED in 0.3.5 (partly)

Was: `http://` only, carrying the agent token (unrestricted remote execution on
the agent host) and, via `file.writeEnv`, the service's decrypted secrets — all
readable by anyone on the path.

Fixed by `lib/agentSeal.ts`: an authenticated envelope over the transport that
already exists. HKDF-SHA256 derives a fresh key per message from
`sha256(agentToken)`; the body is AES-256-GCM with `version.timestamp` as AAD, so
the timestamp cannot be edited to widen the ±5-minute replay window. Every
failure — wrong secret, tampered ciphertext, stale timestamp, unknown version,
malformed field — raises the *same* error, and `/agent/exec` answers a bad
envelope byte-for-byte like a bad token, so the endpoint is not a decryption
oracle. Capability is negotiated through `GET /agent/ping`; the legacy plaintext
path stays for un-upgraded agents and is refused outright under
`NINEDEPLOY_AGENT_REQUIRE_SEALED=1`.

TLS was the obvious answer and is still the right long-term one, but it needs an
X.509 certificate on every agent — Node can parse certificates without being able
to generate them, so that means a new dependency or hand-rolled DER, plus a
distribution and rotation story, for a feature that is optional to begin with.

*Still open*: metadata is unprotected (which agent, when, how often, message
size), there is no forward secrecy, and an attacker who owns the agent host holds
the key anyway. Agents still belong on a private network. mTLS remains the fix.

### 16.7 ~~Three different list-scoping implementations~~ — FIXED in 0.3.5

`GET /v1/services` (owner-only), `/dashboard` and `/domains`
(owner ∪ workspace-tagged) and `loadServiceForUser` (…∪ operator) disagreed. The
visible symptom was a teammate seeing an empty services list while the dashboard
counted those same services.

All four now call `visibleServiceIdSet(db, user)` in `resourceAccess.ts`
(`null` = unrestricted, for operators). The inline copies in `dashboard.ts` and
`domainIndex.ts` are gone.

Note the trade-off: `GET /v1/services` now loads the visible rows and filters in
memory rather than pushing the owner match into SQL. That matches what the tag
filter already did, and matters only at a scale a self-hosted panel does not
reach — but see §16.8.

### 16.8 ~~A deploy's outcome was never recorded~~ — FIXED

`deploy.trigger` was written by the route when a deployment was queued, and it
was the **only** deploy action anything emitted. `engine/pipeline.ts` never
called `audit()`, so a deploy that finished — successfully or not — did so in
silence. Three consumers hang off `audit()` and all three were blind to the
result an operator actually cares about:

- `lib/notifier.notifyEvent`, i.e. **every** Slack / Telegram / Discord /
  webhook / email channel. A failed production deploy notified nobody, and the
  Settings → Notifications event filter had no `deploy.failed` to match.
- the `/v1/events` socket behind the panel's live activity feed, which showed
  deploys starting and never finishing.
- `kernel/auditBridge`, whose `deployment.status_changed` could therefore only
  ever carry `trigger` / `rollback` / `cancel`. §16.3 rebuilt the bridge so the
  built-in plugins would finally see real events; the one event they exist to
  react to was still missing.

The pipeline now records `deploy.success`, `deploy.failed` (with the reason in
`meta`) and `deploy.cancelled` as `"<service name> #<deployment id>"` — the
entity shape the bridge already decomposes. The actor is the service **owner**
rather than `null`, because `canReceiveEvent` treats a null actor as a system
event and shows it to operators only, which would hide a member's own deploy
result from them.

### 16.9 ~~Master-key rotation had no caller~~ — FIXED

`lib/keyRotation.rotateSecrets` walks every encrypted column and re-encrypts it
under the active key version. It was implemented, covered by tests, and
**imported by nothing**. Meanwhile `.env.example` instructed operators to
"run `ninedeploy rotate-keys`" — a command that did not exist, and
`ARCHITECTURE.md` itself described a "`rotateSecrets` re-encryption job".

An operator who followed the documented procedure would add a new key version,
restart, find no way to run step 3, and then perform step 4 — remove the old
version — leaving every stored secret sealed under a key the process no longer
holds.

Now `GET /v1/settings/master-key` + `POST /v1/settings/master-key/rotate`
(operator-only, like the rest of that plugin), the SDK's
`settings.masterKey.{get,rotate}`, and `ninedeploy system rotate-keys`. Rotating
with a single key version in the ring is refused with an explanation instead of
being a no-op that looks like success.

The rotation response also carries the warning the procedure was missing:
**backups are not re-encrypted.** Dumps are sealed by `createBackupCipher` under
an `NDBK1:v<version>` header and `createBackupDecipher` throws for a version
outside the ring, so retiring a key makes every backup taken under it
permanently unrestorable. The old version has to stay in
`NINEDEPLOY_MASTER_KEYS` until those backups age out of retention.

### 16.10 ~~A compose template skipped the host-privilege gate~~ — FIXED

`POST /v1/templates/:id/deploy` called
`assertMayUseHostPrivilege(user, { type: 'docker', … })` with the type
hard-coded. A template carrying `composeContent` becomes a `type: 'compose'`
service (`modules/composeStacks.ts`), and `lib/hostPrivilege.ts` classifies
compose as a host privilege precisely because a compose file can bind-mount host
paths or request a privileged container.

So a `member` could stand up a compose stack and queue its deploy through this
route — while `assertMayDeployStoredService` correctly refused them the *next*
deploy of that very same service. The gate now keys off the type that will
actually be created; the Deploy wizard shows the same reason up front rather
than letting a member fill in five steps and collect a 403.

### 16.11 ~~The sealed agent transport could be downgraded by one lost packet~~ — FIXED

`agentClient.supportsSealed` cached its answer per server, which is right — but
it cached a `false` produced by a *failed* probe just as readily as one the
agent actually gave. An agent restarting, a dropped packet, or an on-path
attacker killing exactly one `GET /agent/ping` therefore pinned that server to
the legacy cleartext transport for the rest of the process's life. Only a
definitive answer is cached now; an unreachable probe re-probes next call.
`NINEDEPLOY_AGENT_REQUIRE_SEALED=1` remains the way to close the fallback
outright.

### 16.12 Smaller things found in the same sweep — FIXED

- **`alerts: [{ when: deployFailed }]` wrote a rule that could never fire.**
  `applyManifestToService` mapped the two event-shaped triggers
  (`deployFailed`, `restartLoop`) onto `metric: 'cert-expiry', threshold: 0` —
  the module's own comment said it skipped the insert; it did not. The rule
  rendered in Monitoring like a configured alert. Both are now reported as
  skipped in the deploy log instead.
- **`static`, `watch` and `network` were dropped in complete silence.** They are
  accepted by the strict manifest schema and consumed by nothing. Every other
  unwired section already warned; §16.2 claimed these did too. They do now.
- **The deploy worker leaked one Timeout per poll.** `plugins/worker.ts` pushed
  every 2-second poll timer into an append-only array that only `stop()` ever
  drained — roughly 43 000 dead handles per slot per day of uptime. It is a Set
  each timer removes itself from.
- **`lib/auth.ts` no longer reads the legacy `users.role` column.** Migration
  `0034` rebuilds `users` without it, so the `role === 'admin'` → operator
  branch was unreachable in production and survived only to satisfy its own test
  fixtures — a second, dead grant path inside the auth core, and one that would
  have quietly widened exactly the narrow backfill `0038` was written to impose.
- **`lib/agentSeal.secretsMatch` is gone.** Exported, tested, called by nothing;
  `agentClient.tokenMatches` already does that comparison.
- **The marketplace's "use this instead" links pointed at the wrong page.**
  §16.3 replaced the install button with a pointer at the feature that already
  ships — and five of those pointers used `/settings?tab=…` while Settings
  selects its page with `?section=` (`routes/settings/index.tsx` reads
  `searchParams.get('section')`), so they landed on the default page. The
  Cloudflare entry also named "Settings → System" for DNS records, which live
  under Integrations. `test/kernelHonesty.test.ts` now checks every pointer
  against the real route table and the real section ids.
- **Two dead operator guards are gone.** `resourceAccess.assertOperator` and a
  second `resourceAccess.requireOperator()` prehandler had no call sites — and
  both re-read `users.is_instance_operator` from the database, which is exactly
  what `plugins/auth.ts` warns against: it has already narrowed the flag for a
  scope-restricted API token (a `write` token owned by an operator runs as a
  non-operator), and a fresh read hands that authority back. `requireOperator()`
  also still documented the pre-0.3.5 self-granting definition ("owner/admin in
  at least one workspace"). A future route following either would have silently
  reopened §16.1 and §16.5. The escalation assertion they carried now runs
  against `app.requireOperator`, the gate the routes actually use.
- **The self-update state directory is owner-only.** `run-update.sh` was
  deliberately written `0700`, but the log beside it was created at the default
  `0644` while capturing the installer's entire output stream — and
  `errorTail` surfaces the tail of that through the API. `install.sh` chmods the
  `.env` it writes to `600`; the directory its output lands in now gets the same
  treatment (`0700` dir, `0600` log).
- **One QR implementation instead of two.** `components/QrCode.tsx` was written,
  tested and imported by nobody, while Settings → Account carried its own copy of
  the same `QRCode.toDataURL` effect (the `QrCode` symbol it imports is the
  lucide *icon*). The card now uses the shared component — which also renders at
  2× the CSS size, so the code is sharper on a HiDPI screen.

### 16.13 ~~Deployments could be started but never removed~~ — FIXED

A deployment had no delete path anywhere in the product. The only thing that
ever aged out was the deploy-log FILE (30 days, `plugins/housekeeping.ts`); the
`deployments` table itself was swept by nothing, so it grew for the life of the
instance and the older half of every service's Deploys tab listed builds whose
logs had already been deleted — history you can click and learn nothing from.

Three changes:

- `DELETE /v1/services/:id/deploys/:depId` (role `admin`, like the other
  destructive verbs) removes one row and its log. In-flight deployments are
  refused with "cancel it first" — the worker and the pipeline still write to
  them — and so is the `running` one, which records what is serving traffic,
  carries the digest a rollback re-deploys, and is the baseline the next
  deploy's config diff is taken against.
- The housekeeping sweep now ages finished deployment rows out on the **same**
  30-day window as their logs, skipping the in-flight and `running` statuses, so
  a row and its log disappear together instead of one outliving the other.
- Deleting a service, and auto-destroying a PR preview, now delete the deploy
  log files the FK cascade leaves behind. Build logs routinely echo
  configuration; they should not outlive the service they describe.

`cancel` was already implemented in the route, the SDK and the panel — the CLI
was the one surface without it, so a deploy started from CI could only be
stopped from a browser. `ninedeploy deploys cancel` and `ninedeploy deploys rm`
close that.

### 16.14 ~~`job_runs` grew forever, output and all~~ — FIXED

`job_runs` had no retention of any kind, and every row stores up to 60 KB of the
command's captured output (`lib/jobRunner.ts`) *inside the SQLite file that gets
backed up whole*. A per-minute cron job writes roughly 525 000 rows a year while
the panel only ever renders the newest 20 per job — everything older was
unreadable weight in the backup path. Swept on the same 30-day window as the
other logs.

### 16.15 ~~PR previews leaked a Docker network each~~ — FIXED

Every deployed service gets a private bridge network (`ensureServiceBridge`,
called by the Docker builder). Only the panel's `DELETE /v1/services/:id` ever
reaped it. The preview auto-destroy path in `modules/hooks.ts` deleted the
service row and stopped the container but left the network behind — in the one
feature designed for high churn, one preview environment per pull request. It
now reaps the bridge and removes the preview's build logs, both best-effort so
a stuck network cannot turn a webhook into a 500 the provider will retry
against a service that no longer exists.

### 16.16 ~~Historical metrics were unreachable~~ — FIXED

`GET /v1/services/:id/metrics` returned **404**. `metricRoutes` is a second
export from `modules/stats.ts`, its own comment says *"Mounted under /services"*,
and `modules/api.ts` never registered it. So the CPU and memory charts on the
Monitoring page and on every service's Overview tab had nothing to read, while
the collector wrote two rows per service every 30 seconds and swept them at 24 h.
`test/api.test.ts` even carried a stub for the module — nothing ever asked it a
question.

The route is registered. The regression guard is the interesting part:
`api.test.ts` used to spot-check two modules, so it now asserts that **every**
module it stubs answers on its prefix. Reverting the registration turns that
case red with a 404.

### 16.17 ~~`log_drains` existed in the schema and in no migration~~ — FIXED

The `log_drains` table is declared in `schema.ts` and recorded in drizzle-kit's
`0031_snapshot.json`, but **no migration ever created it**. Every database built
by replaying the migrations — i.e. every fresh install — simply had no such
table, and Settings → Log Drains (Syslog / Datadog / Vector shipping) failed at
runtime with `no such table: log_drains`.

The snapshot is what makes this nasty: because drizzle-kit already believed the
table existed, `drizzle-kit generate` would never emit the missing file. The
drift was invisible to the tool whose job is to catch it, and invisible to the
tests, which type-check every query against `schema.ts` and mock the database.

Added as migration `0039_log_drains` (`IF NOT EXISTS` throughout, so an instance
whose schema came from `drizzle-kit push` still upgrades cleanly).

The guard is `packages/db/test/schema-drift.test.ts`: it applies the whole
migration chain to a fresh database and compares every declared table and column
against `PRAGMA table_info`, **in both directions** — a column the migrations
still create but the schema has dropped is a NOT NULL insert failure waiting to
happen. `schema.test.ts` migrates and then round-trips four tables out of forty;
that is what let this through.

While fixing it: adding `0039` silently disarmed
`test/migrate-recovery.test.ts`, which forgot "the newest migration" to
reproduce an unjournalled upgrade. That only exercised the recovery path while
the newest file happened to be an `ALTER TABLE … ADD COLUMN`; a
`CREATE TABLE IF NOT EXISTS` replays cleanly, so the suite stayed green without
reaching the code it exists to test. It now selects the newest migration whose
replay actually conflicts.

### 16.18 ~~Six environment variables were documented nowhere~~ — FIXED

`.env.example` is the only configuration reference this project has, and half
the knobs it describes are set on a host the panel never sees (the agent). It
had drifted, and nothing checked it:

- `NINEDEPLOY_ALLOW_PRIVATE_EGRESS` — the SSRF escape hatch. Named in the error
  message an operator actually hits ("Set NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1 if
  this instance really must reach internal addresses") and in no config file, so
  the fix for a legitimate LAN webhook was undiscoverable.
- `NINEDEPLOY_UPDATE_CHECK_URL` — the panel's only unprompted outbound call, and
  `=disabled` is the only way to switch it off.
- `NINEDEPLOY_BACKUP_VOLUME_RETAIN_COUNT`, `NINEDEPLOY_DOMAIN`,
  `NINEDEPLOY_WEB_DIST`, `NINEDEPLOY_AGENT_RAW_TOKEN`.

The guard is `apps/server/test/envExample.test.ts`: it collects every
`process.env[...]` read in the server plus every key of the zod schema in
`env.ts`, and fails when one is missing from `.env.example` (commented-out
entries count as documented — that is how the agent block is written). It is
scoped to the server on purpose: the CLI's and MCP server's own
`NINEDEPLOY_URL` / `NINEDEPLOY_TOKEN` / `NINEDEPLOY_MCP_READONLY` are client
credentials and live in `docs/AI_MCP_CLI.md`.

Nothing was documented-but-unread, which is the failure mode that would have
been worse.

### 16.19 Smaller items

- `GET /v1/services` loads every visible row and filters tags **in memory**;
  same for `visibleDatabaseIds`, which reads the whole `databases` table. Fine
  at self-hosted scale, but it is an O(n) full scan per request
- Migration tag `0020` is skipped (journal-authoritative, cosmetic)
- `DELETE /v1/projects/:id` is scoped to projects the caller can see, but is not
  role-gated the way services and databases are (§16.4) — any seat in the
  workspace can delete a project. Services survive (the join rows cascade, the
  services do not), so the blast radius is the grouping, not the workloads
- WAL is off by design (§4) — this serializes writers behind readers under the
  worker + collector + two schedulers. It is the right trade for single-file
  backups, but it caps concurrency and should be revisited together with the
  export path if throughput ever matters

## 17. Key design decisions

- **Single SQLite database** — no PostgreSQL/MongoDB/Redis dependency; libsql
  client on a local file; `foreign_keys = ON`, `busy_timeout = 5000`, WAL off
  for safe single-file backups; hot paths indexed
- **Self-migrating server** — startup applies pending SQL migrations via
  Drizzle's runtime migrator, tolerating pre-journal hand-patched columns;
  drizzle-kit stays a devDependency
- **Core runs bare-metal (systemd) or as a socket-mounted container** — PM2 and
  UFW features require the bare-metal install
- **Docker CLI, not dockerode** — every engine operation is a validated
  arg-array spawn through one choke point, shared by local and agent execution
- **Traefik file provider** — dynamic config regenerated atomically on every
  deploy/domain change; directory-mounted
- **Container-name routing** — Traefik reaches containers by name over the
  shared network; host ports are an explicit, gated exception
- **Blue-green (Docker) + rollback (PM2/Compose)** — two versions run side by
  side; PM2 can't (port conflict) so it auto-rolls back. In-flight deploys can
  be cancelled at every stage checkpoint
- **Typed agent protocol** — remote execution is a fixed operation table with
  regex-validated operands, not arbitrary shell
- **Image digest pinning** — each deployment records the exact digest it ran, so
  rollback redeploys that precise image
- **Deployment history is honest** — a superseded build is marked `superseded`,
  not left `running` forever
- **Fire-and-forget notifications** — `audit()` → DB write + EventBus +
  notifier, never blocks the request
- **Bounded retention** — metrics 24 h, deploy logs *and their deployment rows*
  30 d (the live and in-flight rows are never swept), scheduled-job runs 30 d,
  audit 90 d, notification log 30 d, dangling images hourly; scheduled backups
  keep 7 (manual untouched), volume backups keep
  `NINEDEPLOY_BACKUP_VOLUME_RETAIN_COUNT`
- **Forward-only, additive migrations** — no down-SQL; a bad migration leaves an
  unused object rather than losing data
- **Tiered coverage gates** — 100 % where it is achievable (db, schemas, sdk,
  mcp, plugin-sdk, cli), 99 % web, 95 % server, each floor justified in its
  config rather than silently ratcheted
- **TypeScript strict** — `noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
  `isolatedModules`; Node ≥ 22.13
