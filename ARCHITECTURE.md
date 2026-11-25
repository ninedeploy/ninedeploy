# NineDeploy — Architecture

> **Current contract:** [Current status](docs/CURRENT_STATUS.md) separates
> implementation, scoped acceptance and publication. The generated
> [support matrix](docs/SUPPORT_MATRIX.md) evaluates current runtime limits.
> This guide was reconciled against the code on **November 23, 2026** and reviewed against
> `65a5af1e` (0.19.0 plus the unreleased commits on `main`) on November 24:
> counts, route tables and schema groups were read from the source tree named
> in each section.
> §16 keeps the historical findings with their original scope; they are not a
> current release certificate. Where this guide and a topical guide differ,
> the code wins — report the drift.

A self-hosted deployment platform with optional multi-server support. The core
server runs bare-metal (systemd) for direct PM2 + Docker daemon access; a
container image is also published for Docker-based installs (host socket
mounted, `DOCKER_GID` supplied so the non-root image user can reach it). Remote
hosts run the same binary in agent mode (`NINEDEPLOY_AGENT=1`) and execute a
fixed table of typed, validated operations for the panel (§9); each node runs
its own Traefik. PM2 stays on the panel host. Docker and Compose run on the
panel host or on nodes; source builds, credentials, hooks and volume
attachments depend on build placement, same-host resources, the agent's
advertised capabilities and its owner's switches. What a node cannot run
faithfully is refused up front with a reason (`lib/remoteDeploy.ts`) rather
than deployed half-configured. Docker services use private `nd-svc-<slug>`
bridges with Traefik attached, and their databases join the service's bridge.
The shared `ninedeploy` bridge remains for platform plumbing and standalone
databases; Compose and Swarm have their own network paths. Traefik is the sole
public listener on :80/:443 by default. Publishing a host port is an explicit,
operator-gated exception (`services.published_port`, port mappings).

- **Runtime**: Node 22.23.4+, 24.22.1+ or 26.12.1+ (supported majors only),
  pnpm 11.23, Turborepo (`turbo run build/dev/lint/typecheck/test/clean/db:*`)
- **Language**: TypeScript 7 strict (`noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `isolatedModules`), Biome 2 for lint and format
- **Testing**: Vitest 5 + `@vitest/coverage-v8`, Testing Library, Playwright
  (browser journeys), testcontainers (integration). Coverage gates are
  **tiered**, not uniformly 100 — see [§13](#13-testing). Measured results
  belong to their recorded source and acceptance scope in
  [Current status](docs/CURRENT_STATUS.md).

## 1. System diagram

```
   browser (React SPA) · ninedeploy CLI · SDK · MCP (stdio / HTTP+OAuth) · desktop
                                     │  HTTPS  /v1  (JWT, API token, OAuth token)
                                     ▼
   ┌──────────────────── NineDeploy panel — Fastify 5, one Node process ────────────────────┐
   │ auth: JWT + sessions · API tokens · OIDC / SAML SSO · SCIM · 2FA policy · allow-list    │
   │ tenancy: workspaces · roles · access grants · protected lanes · deploy freezes           │
   │ 118 route modules (/v1) · /scim/v2 · public hooks, status pages, wake, maintenance       │
   │ deploy engine: queue → worker → PREPARE → DEPENDENCIES → BUILD → HEALTHCHECK             │
   │   → CANARY → PROXY_SWAP → CLEANUP → COMPLETE                                             │
   │   builders: docker (buildx · Nixpacks · Railpack · buildpacks · static) · pm2 · compose  │
   │   remote docker / compose / replicas · swarm · canary · autoscale · sleep and wake       │
   │ data: 11 managed engines · backups · restore verification · PITR · major upgrades        │
   │ observability: collector · alert evaluator · uptime · log shipper · traffic analytics    │
   │ microkernel: event bus · hook pipeline · registries · 12 built-in plugins · sandbox      │
   │ SQLite (.data/ninedeploy.db · 98 tables · Drizzle) · AES-256-GCM vault and key ring      │
   └────┬──────────────┬───────────────────┬────────────────────────┬───────────────┬───────┘
        │ docker.sock  │ file provider     │ sealed agent transport │ S3 API        │ HTTPS
        ▼              ▼                   ▼                        ▼               ▼
   app workloads   Traefik v3          remote nodes              off-site       Git hosts,
   Docker · PM2    sole public         (same binary,            backups,       GitHub App,
   Compose · Swarm listener :80/:443   NINEDEPLOY_AGENT=1,      PITR archives  registries, CI
                                      own Traefik per node)
```

## 2. Monorepo structure

```
ninedeploy/                         pnpm 11.23 workspace + Turborepo
├── apps/
│   ├── server/                     Fastify 5 API, deploy engine, agent mode
│   │   ├── src/modules/            118 route modules mounted by the api.ts aggregator (123 files) — §5.1
│   │   ├── src/lib/                353 shared libraries: auth, resourceAccess (the authz
│   │   │                           choke point), hostPrivilege, egressGuard, agentClient /
│   │   │                           agentSeal / agentFrameCipher, node*, pitr*, backup*,
│   │   │                           database*, proxy*, persistentPort*, secretRefs, vault, …
│   │   ├── src/engine/             pipeline (2,400 lines), builders/ (12), database, proxy,
│   │   │                           swarm*, pitr*, canary, fanout, recovery, logs, logDrain*,
│   │   │                           volumeFiles, serverProvisioner
│   │   ├── src/agentOps/           36 source files registering 37 modules and 86 operations — §9
│   │   ├── src/kernel/             microkernel core, drivers/ (16), plugins/ (12 built-in),
│   │   │                           sandbox/ (isolated plugin host)
│   │   ├── src/plugins/           40 Fastify plugins: request guards, worker, schedulers — §6
│   │   ├── src/openapi/            OpenAPI 3.1 builder, specs/ (21 files), MCP tool generation
│   │   ├── src/templates/          bundled template registry (322 entries) and mirrors
│   │   ├── src/agent.ts            the remote agent (plus agentApp.ts, wakeCatcher.ts,
│   │   │                           pageServer.ts, ciRunner.ts)
│   │   ├── scripts/                buildTemplateMirror, buildDokployMirror,
│   │   │                           generateMcpSpecTools, verifyManifest
│   │   └── test/                   903 test files; test/integration/ (14 files, opt-in)
│   ├── web/                        React 19.2 + Vite 8 + Tailwind 4 (278 source files)
│   │   ├── src/routes/             33 top-level pages; service/ (15 tabs and their cards),
│   │   │                           settings/ (20 sections), manifestCreator/ (16 sections),
│   │   │                           database/, traefik/, workspaces/
│   │   ├── src/components/         57 component files
│   │   ├── src/lib/                api (SDK + 401→refresh→retry), auth, workspace, mode,
│   │   │                           layout, i18n, deployLauncher, …
│   │   └── src/locales/tr.ts       Turkish interface, keyed by the English source text
│   └── cli/                        `ninedeploy` (commander 15): 66 top-level commands and
│                                   248 subcommands across 61 command files
├── packages/
│   ├── db/          Drizzle schema (98 tables) + 126 hand-written SQL migrations;
│   │                the server self-migrates at startup (drizzle-kit is dev-only)
│   ├── schemas/     Zod v4 DTOs shared by server, web, CLI, SDK and MCP (65 files)
│   ├── sdk/         typed API client: 19 resource namespaces, terminal, manifest
│   │                and import helpers
│   ├── mcp/         `ninedeploy-mcp` server package (64 tools)
│   └── plugin-sdk/  definePlugin + scopedConfig helpers for kernel plugins
├── desktop/         Electron 44 desktop client (outside the pnpm workspace, own lockfile)
├── e2e/             Playwright 1.64 browser journeys (own lockfile)
├── examples/        Next.js, Laravel and FastAPI starters
├── scripts/         release tooling, contract preflight, 35 smoke scripts
├── docs/            operator guides and dated records — index in docs/README.md
├── .github/workflows/   ci.yml, release-publish.yml, browser-e2e.yml, desktop.yml,
│                        stable-channel.yml, framework-starters.yml, runtime-readiness.yml, …
├── Dockerfile       multi-stage, non-root; pinned Nixpacks 1.41.0, Railpack 0.39.0,
│                    pack 0.40.9, Compose 5.5.1, buildx 0.37.1
├── docker-compose.yml           development environment
├── docker-compose.prod.yml      standalone container install (DOCKER_GID)
├── systemd/          ninedeploy.service, ninedeploy-pm2.service
├── install.sh        one-click installer and upgrader
└── ARCHITECTURE.md   this file
```

## 3. Clients

Five clients consume the same REST API (`/v1`):

- **Web** (`apps/web`) — React 19 dashboard; server state via TanStack Query 5,
  no Redux or Zustand (local state is React context: auth, workspace,
  projects, theme, experience mode). Realtime is purpose-specific: deploy log
  streaming over WebSocket (backlog replay plus live tail), a container
  terminal (`WS /v1/terminals/:id/attach`, xterm.js, binary frames), database
  and service tunnels (`WS /v1/databases/:id/tunnel`,
  `WS /v1/services/:id/tunnel`), and a global audit stream over
  `WS /v1/events`.
  Auth is
  JWT access + refresh in localStorage with a single-flight 401→refresh→retry
  fetch wrapper. A **simple/advanced experience mode** (`lib/mode.tsx`,
  default *simple*) hides advanced navigation and controls, and a
  **classic/compact layout** (`lib/layout.ts`; a browser gets *compact* until
  it chooses, and a stored *classic* choice is kept — an unreleased change)
  changes the sidebar and the service page's tab set
- **CLI** (`apps/cli`) — `ninedeploy` (commander 15); the token is stored 0600
  in `~/.ninedeploy/config.json`; WebSocket log streaming via `ws`. 66
  top-level commands and 248 subcommands cover login and setup, services, deploys, canaries,
  autoscaling, sleep, previews, lanes and approvals, CI, sources and GitHub
  Apps, databases, backups, PITR, panel backup, import from other platforms,
  domains, proxy and certificates, terminals, tunnels, uptime, servers, Swarm,
  secrets, SSO, access grants, workspaces, notifications, log drains, plugins,
  templates and system tooling — see [docs/AI_MCP_CLI.md](docs/AI_MCP_CLI.md)
- **MCP** (`packages/mcp`) — Model Context Protocol server over stdio and
  over Streamable HTTP served by the panel itself (`/v1/mcp`, with OAuth 2.1
  authorization and an operator policy). 64 tools: 42 hand-written ones that
  map onto the typed SDK, and 22 read-only ones generated from the OpenAPI
  route specs (`mcpSpecToolsDrift.test.ts` fails on drift). Read-only
  inspection, guarded actions (deploy, restart, cancel, rollback, prune) and
  configuration writes are all present; `NINEDEPLOY_MCP_READONLY=1` exposes
  only the non-mutating allowlist, and pairing it with a `read`-scoped token
  makes the server enforce the restriction. ⚠ The default surface **mutates**
  (§16.5)
- **SDK** (`packages/sdk`) — `createClient({ baseUrl, getToken, fetch? })`
  over an injectable transport; 19 typed namespaces (`auth`, `services`,
  `deploys`, `env`, `domains`, `network`, `traefik`, `databases`, `volumes`,
  `sources`, `servers`, `templates`, `settings`, `system`, `plugins`, `logs`,
  `terminals`, `uptime`, `ci`), a `NineDeployError` type, terminal connection
  helpers and manifest parsing
- **Desktop** (`desktop/`) — Electron client that embeds the panel, keeps
  credentials in the OS credential store and manages several instances; see
  [docs/DESKTOP.md](docs/DESKTOP.md)

The REST API is documented by an **OpenAPI 3.1 document** at
`GET /v1/openapi.json` (behind login, with an ETag) built from the live route
table. Agents that should not mutate anything can search that document with
the MCP `search_api` tool; there is no generated write tool and no
"call any endpoint" tool.

## 4. Database schema (source: packages/db/src/schema.ts)

Storage: **SQLite** via `@libsql/client` on a local file
(`NINEDEPLOY_DB_PATH`, default `./.data/ninedeploy.db`). PRAGMAs at boot:
`foreign_keys=ON`, `busy_timeout=5000`. WAL is deliberately **off** — the
system export handler and `install.sh`'s pre-update backup copy the single
database file, and a WAL sidecar would silently drop recently committed state
from those archives (`packages/db/src/client.ts`). The schema declares 98
tables; they group as follows (key columns only — `schema.ts` is the
authority).

### 4.1 Identity, teams and access

```
users                  id, email, password_hash, name, token_version (JWT revocation counter),
                       totp_secret_encrypted, totp_enabled, totp_last_step, scim_external_id,
                       deactivated_at, deactivated_by_workspace_id, is_instance_operator.
                       No global `role` column: team access is workspace-derived and
                       instance-operator rights are the explicit flag (§8.1)
sessions               id, user_id, jti (unique), ip, user_agent, last_used_at, expires_at,
                       revoked_at — one row per refresh token
api_tokens             id, user_id, name, hash (sha256), scopes, last_used_at, expires_at
webauthn_credentials   id, user_id, credential_id, public_key, counter, transports, name
password_reset_tokens  id, user_id, token_hash, expires_at, used_at, requested_from
user_recovery_codes    id, user_id, code_hash, used_at
workspaces             id, name, slug, description, owner_id
workspace_members      id, workspace_id, user_id, role (owner|admin|member|viewer)
workspace_invitations  id, workspace_id, email, role, token, invited_by_user_id, expires_at,
                       accepted_at, accepted_by_user_id, revoked_at
email_template_overrides  id, workspace_id, name, subject, text
environments           id, workspace_id, name, slug, protected, require_approval  (lanes)
access_grants          id, workspace_id, user_id, project_id, environment_id, target_key,
                       role (viewer|member|admin), suspended_at, created_by_user_id
oidc_providers         id, name, slug, issuer_url, client_id, client_secret_encrypted,
                       scopes, enabled, auto_enroll, default_role
sso_providers          id, type (oidc|saml), name, config_json
oauth_identities       id, provider_id, subject, user_id, provider_fingerprint
scim_tokens            id, name, token_hash, workspace_id, last_used_at, revoked_at
```

### 4.2 Scoping (N-N, replaces the old single `services.project_id`)

```
projects            id, workspace_id, name, slug, description
labels              id, workspace_id (nullable = global), name, color
service_projects    (service_id, project_id)   PK pair
service_workspaces  (service_id, workspace_id) PK pair
service_labels      (service_id, label_id)     PK pair
```

The top-bar filter composes the three dimensions: ids **OR** within a group,
groups **AND** across each other (`?tagWorkspaceIds=1,2&tagProjectIds=3`).

### 4.3 Services and delivery

```
services       id, owner_user_id, name, slug, type (docker|pm2|compose), status, repo_url,
               branch, commit_sha, source_id, image, auto_update, volume_mount, port,
               published_port, port_mappings, health_path, health_check, health_command,
               health_timeout_seconds, docker_labels, git_lfs, runtime_options, canary,
               autoscale, sleep_after_minutes, runtime_id, replicas, runtime_replicas, cmd,
               docker_socket, template_id, server_id, compose_service, compose_content,
               preview_* (deployments, auto-destroy, database copy, forks, domain pattern,
               max active, parent service, pr number), environment_id, build_on (target|panel|
               server), build_server_id, push_registry_source_id, push_repository,
               orchestrator (container|swarm), badge_token, deploy_hook_token
build_configs  id, service_id, build_pack (auto|nixpacks|dockerfile|railpack|static|paketo|
               heroku), base_dir, install_cmd, build_cmd, start_cmd, dockerfile_path,
               output_dir, static_spa, build_args, build_target, pre_deploy_cmd,
               post_deploy_cmd, pre_stop_cmd, restart_policy, stop_grace_seconds
deployments    id, service_id, status (queued|building|deploying|running|superseded|failed|
               cancelled|awaiting_approval|awaiting_ci), commit_sha, ci_gate, artifact,
               promotion_source_deployment_id, image_digest (exact rollback pin),
               config_snapshot, restored_from_deployment_id, build_host, image_id,
               reviewed_by, reviewed_at, message, author, trigger (user|webhook|cli|
               schedule), log_path, started_at, finished_at
deployment_release_records  id, deployment_id, payload_encrypted  (recorded Compose releases)
env_vars       id, service_id, scope (service|project), scope_key, key, value_encrypted, is_secret
preview_env_vars  id, service_id, key, value_encrypted, is_secret  (preview-only values)
service_files  id, service_id, container_path, content_encrypted, size  (file mounts)
repo_insights  id, service_id, framework_id, data, commit_sha
sources        id, type (github|gitlab|gitea|bitbucket|custom|registry|github_app), name,
               token_encrypted, deploy_key_encrypted, registry_username, default_branch,
               base_url, allow_on_nodes, pin_host_keys, host_keys
webhooks       id, source_id, service_id, branch, events, watch_paths, secret_encrypted, active
github_apps, github_app_installations, service_github_links, github_pr_comments
               App registration, installations, per-service links (token scope, watch paths,
               status reporting, PR comments, required workflows), PR comment receipts
domains        id, service_id, hostname, path, ssl, redirect_www, headers, basic_auth,
               ip_allowlist, rate_limit_average, rate_limit_burst, redirects, status,
               verification_token, verified_at, dns_record_id
domain_transfers  id, domain_id, source_user_id, target_email, target_user_id, …
tunnels        id, name, slug, token_encrypted, status, container_name
scheduled_jobs id, service_id, name, cron (5-field), kind (deploy|exec|backup), command, enabled
job_runs       id, job_id, status, output, exit_code, started_at, finished_at
ci_runners, ci_jobs, ci_attempts   self-hosted runners, jobs (awaiting_approval|queued|running|
               succeeded|failed|cancelled) and leased attempts
image_transfers  id, deployment_id, service_id, source_server_id, target_server_id,
               method (stream|registry|preload), image_ref, bytes, sha256, status
servers        id, name, host, port, status (offline|online|error|pending), token_encrypted,
               last_seen_at, agent_version, agent_caps, agent_checked_at, is_build_server,
               build_concurrency, swarm_node_id, swarm_role
service_targets, swarm_stacks   per-node runtime targets; recorded Swarm stacks
host_ips       id, ip, label, is_primary, service_id
```

Durable transition state, so that a panel restart resumes or safely aborts the
operation: `primary_transitions`, `fanout_transitions`, `swarm_transitions`
and `node_lifecycle_intents` carry an owner token, a lease and a retry
counter; `node_sleep_transitions`, `node_wake_maintenance` and
`node_autoscale_transitions` carry a worker token and a lease;
`node_autoscale_capacity`, `node_deployment_preparations`,
`node_serving_traffic_receipts`, `node_proxy_write_heads`,
`service_runtime_owners` and `deployment_runtime_owners` are epochs, receipts
and bookkeeping without a lease (§9, §7.1).

### 4.4 Data services, storage and operations

```
databases              id, project_id, owner_user_id, name, slug, engine (postgres|mysql|mariadb|
                       redis|mongo|valkey|clickhouse|meilisearch|rabbitmq|keydb|dragonfly),
                       version, status, container_name, internal_host, internal_port,
                       username, password_encrypted, db_name, volume_name, cpu_shares,
                       cpu_limit_milli, mem_limit_mb, web_gui_enabled, extensions,
                       pgbouncer_enabled, server_id, preview_copy_of, pitr_enabled,
                       pitr_retention_days, pitr_base_backup_at
database_attachments   id, service_id, database_id, env_alias
service_volume_attachments  id, service_id, volume_name, container_path, read_only
backups                id, database_id, volume_name, label, scope (db|scheduled|volumes|full),
                       status, path, remote_key, destination_id, size_bytes, server_id
backup_drills          id, database_id, backup_id, status, engine, duration_ms, error, details_json
backup_destinations    id, name, endpoint, region, bucket, prefix, access_key_id,
                       secret_key_encrypted, active
database_backup_policies  database_id, enabled, cron, retain_count, retain_remote_count,
                       destination_id, local_only
database_public_access, tls_certificates, database_imports, volume_imports,
                       database_upgrades, pitr_recoveries
secret_providers       id, kind (vault|aws|gcp|azure|onepassword|exec), enabled, config_json,
                       credential_encrypted, last_tested_at
terminal_sessions      id, user_id, target_kind (service|database|container|host), …,
                       ticket_hash, auth_kind, bytes_in, bytes_out, end_reason, exit_code
traffic_rollups        granularity, bucket_start, scope_key, domain_id, service_id, requests,
                       status_1xx…5xx, bytes_out, duration_sum_ms, duration_max_ms, latency_hist
metrics, metric_rollups   raw samples and 5-minute / 1-hour rollups
audit_log              id, user_id, action, entity, meta, ts
alert_rules            id, service_id (null = host-wide), name, metric, operator, threshold,
                       duration_windows, enabled
alert_state            rule_id (unique), status (ok|breaching|firing), breach_since, fired_at,
                       last_notified_at, last_value
uptime_monitors, uptime_checks, uptime_daily, status_pages
notification_channels  id, name, type, target_encrypted, event_filter, active, config_json
service_notification_channels  id, service_id, channel_id, scope (deploy|failure|alert)
notification_log       id, channel_id, event, entity, status, attempts, error, ts
log_drains, log_drain_cursors, log_drain_batches   drain config, durable cursors and queued batches
error_issues, error_events   Sentry-compatible ingest, grouped by fingerprint
settings               key, value, updated_at  (per-entity feature state is stored in
                       owned, schema-checked key prefixes: lib/ownedSettings.ts)
config_entries         key, plugin_id, value, is_secret, category, tags, description
installed_plugins      id, name, version, enabled, is_official, status
                       (active|disabled|errored|installing), error, manifest
cache_registry_blobs   build-cache bookkeeping
```

### 4.5 Migration history

`packages/db/src/migrations/`, forward-only, additive and hand-written; the
journal (`meta/_journal.json`) holds **126** entries (`0000`–`0126`; tag `0020`
does not exist — it was skipped and the journal does not reference it).
`packages/db/test/schema-drift.test.ts` applies every migration to a fresh
database and compares both directions against the Drizzle schema (§16.17),
and CI additionally requires a clean `drizzle-kit generate`.

Milestones: `0024`–`0039` domain middlewares, extended engines, lifecycle
hooks and previews, workspaces and OIDC, the tag and team overhaul (`0034`),
volume backups, the instance-operator flag (`0038`) and `log_drains` (`0039`) ·
`0040`–`0048` build cache, Swarm stacks, SSO providers, backup drills, domain
transfers, PgBouncer, email templates · `0052`–`0064` environments, CPU
limits, replicas, SCIM, OAuth identities, backup destinations ·
`0067`–`0068` backup policies and preview-only environment · `0069`–`0085`
GitHub App, multi-node (`0072`), host keys, build and runtime options, status
badges, domain redirects, port mappings, host IPs, deploy hooks, recovery
codes, service files, health commands, Docker labels, Git LFS ·
`0086`–`0100` uptime, canary, autoscale, sleep, environment protection,
preview copies and forks, Compose release records, required CI, artifact
promotion, observability, fan-out / primary / Swarm recovery ·
`0101`–`0113` node lifecycle intents, runtime owners, error ingest, node
autoscale, proxy write heads, ordered retirement · `0117`–`0122` CI runners
and the CI deploy gate, serving-traffic receipts, node sleep and wake ·
`0123`–`0126` PostgreSQL PITR, volume imports, database upgrades.

The runtime migrator (`packages/db/src/migrate.ts`) tolerates "object
already exists" failures by re-applying statement by statement — releases up
to 0.2.36 patched columns in at boot outside the journal, and a batch
migrator would abort the whole upgrade on those installs.

## 5. Server request lifecycle

`server.ts` → `buildApp()` (`app.ts`): listen and handle graceful SIGINT and
SIGTERM shutdown. `trustProxy` defaults to one hop (the panel sits behind its
own Traefik), `pluginTimeout` is 30 s, and the default body limit is **1 MiB**
— the large uploads declare their own limits (system import 256 MiB, source
upload 100 MiB, container and node file writes 2 MiB, chunked imports
chunk + 1 KiB).

Registration order:

```
cors → websocket → securityHeaders → rateLimit → rawBody → db → panelAccess
  → kernel → githubFeedback → auth → error handler
  → health → events (WS) → /v1 (route modules) → public status pages → wake
  → maintenance pages → forwardAuth verify → error ingest → MCP OAuth discovery
  → /scim/v2 → worker → traefik → publicDatabaseAccess → databaseImports
  → terminals → trafficAnalytics → nodeDatabases → runtimeState
  → fanoutRecovery → primaryRecovery → nodeLifecycle → swarmRecovery
  → collector → observability → uptime → autoscaler → sleeper
  → backupScheduler → pitrScheduler → autoUpdateScheduler → githubRunnerScheduler
  → ciScheduler → cloudNodeScheduler → imageScanScheduler → gitopsScheduler
  → sharedCertificateSync → restartLimiter → housekeeping → logShipper
  → jobScheduler → panelBackupScheduler → staticFiles (SPA catch-all, LAST)
```

CORS is restricted to a known allowlist (`publicUrl`, dev ports,
`NINEDEPLOY_CORS_ORIGINS`), never a reflected origin. Zod failures map to
`400 validation_error` envelopes; 5xx messages are suppressed in production.
The request logger never persists query strings.

### 5.1 Route modules

Everything below is mounted under `/v1` by `modules/api.ts`. Guards follow
§8: `requireOperator` (aliased `requireAdmin`) for instance-wide and
host-privileged routes, `assertServiceRole` / `assertDatabaseRole` /
`assertWorkspaceRole` for workspace-scoped writes.

| Prefix | Modules | What they serve |
|---|---|---|
| `/setup` | api.ts | create the first operator; only works while no user exists; needs the installer's setup token; rate-limited |
| `/auth` | auth, twoFactorPolicy, samlLogin | login (lockout + TOTP), passkeys, sessions, password reset, 2FA setup, refresh (jti-enforced), API tokens, OIDC providers, SSO start and callback, SAML sign-in, the session's 2FA requirement |
| `/hooks`, `/hooks/github-app` | hooks, githubAppHooks | public auto-deploy receiver (HMAC or token, branch and watch-path match, replay dedup, PR preview create and destroy); GitHub App deliveries |
| `/workspaces`, `/access` | workspaces, invitations, emailTemplates, accessGrants, twoFactorPolicy | workspace CRUD and roles, invitations (public token lookup, authenticated accept), email templates, project and environment access grants, the caller's own grants |
| `/users`, `/demo` | users, demo | user list, operator flag, reset links, delete (operator only); demo seed (operator only) |
| `/projects`, `/labels`, `/env` | projects, env, accessGrants, labels | project CRUD and project-scope env, the cross-scope env key search, who reaches a project, labels, a service's tag sets |
| `/services` | services, deploys, env, domains, serviceVolumes, serviceFiles, serviceMigration, serviceMoveWithData, sourceUploads, hostAddresses, inlineDockerfile, manifest, hooks, deployHooks, serviceGithub, databases (attachments), jobs, badges, commitStatus, insights, stats, traffic, servicePlacement, imageTransfers, serviceTags, imageScans, pendingChanges, restartLimit, serviceCapabilities, maintenance, errorIngest, ci, serviceTunnel, volumeImports | the service surface: CRUD, runtime commands, deploys (trigger, list, rollback, cancel, remove, diff, WS logs and exec), environment, domains, volumes and files, export/import and moves with data, source upload, inline Dockerfile, manifest, hooks and GitHub links, scheduled jobs, status badges, commit statuses, insights, metrics, traffic, build placement, image scans, the pending-changes tray, restart limit, capabilities, maintenance pages and error pages, error ingest, CI, tunnels, volume imports |
| `/databases` | databases, backups, backupPolicy, databasePublicAccess, databaseTunnel, databaseImports, databaseUpgrades, studioProxy, pgbouncer, pitr | CRUD, limits, credentials, Studio proxy, backups and restore, backup policy, public access, tunnels, dump imports, major upgrades, PgBouncer, PITR |
| `/backups`, `/backup-destinations` | backups, backupDestinations | list, delete, download; S3-compatible destinations |
| `/volumes`, `/servers/:serverId/volumes` | volumes, volumeBackups, nodeVolumeFiles | inventory, delete, browse, volume backups; node volume files |
| `/containers`, `/servers/:serverId/containers` | containers | inspect, compose, file browser (panel host and nodes) |
| `/domains`, `/domain-transfers`, `/domain-presets` | domainIndex, domainTransfers, domainPresets, composeRoutes, forwardAuth | all domains, transfers, DNS record presets, a domain per compose service, panel sign-in in front of a domain |
| `/forward-auth` | forwardAuth | one-time grants for the forward-auth flow |
| `/traefik`, `/traffic` | traefik, traefikCustom, traffic | status, certificates, logs, config, restart, custom dynamic config and certificates, traffic analytics |
| `/terminals`, `/tunnels`, `/networks`, `/topology` | terminals, tunnels, networks, topology | terminal sessions, Cloudflare tunnels, Docker networks, the topology graph |
| `/sources`, `/github-apps` | sources, githubApps | repository credentials, GitHub App registration and installations |
| `/templates`, `/build-cache`, `/orchestrators` | templates, buildCache, orchestrators | template registry, build-cache statistics, Docker and Swarm |
| `/servers`, `/swarm` | servers, serverRoles, swarm, osUpdates | node registry, enrolment and connectivity, build-server role, Swarm join and leave, node OS updates |
| `/cloud`, `/host-ips`, `/os-updates` | cloud, hostIps, osUpdates | Hetzner, DigitalOcean and Vultr provisioning; host IP inventory; panel-host OS updates |
| `/ci/runners`, `/ci/runner` | ci | runner administration and the runner lease protocol |
| `/mcp`, `/mcp/policy`, `/oauth` | mcpHttp, mcpOAuth | the remote MCP endpoint, its operator policy, OAuth authorization, token and consent |
| `/gitops` | instanceGitops | the instance as a file in a repository |
| `/settings`, `/settings/secret-providers`, `/settings/panel-access` | settings, secretProviders, panelAccess | registration, ACME and DNS, vault, update channel; secret managers; the panel IP allow-list |
| `/sso`, `/scim` | sso, scim | the list of configured SSO providers for the sign-in page; SCIM token management (the IdP endpoint itself is at `/scim/v2`) |
| `/firewall`, `/egress`, `/deploy-freezes`, `/image-scanning` | firewall, egress, deployFreezes, imageScans | UFW rules, per-project egress IPs, deploy freezes, the image-scanning policy |
| `/config`, `/config-presets`, `/plugins`, `/menus` | configCenter, configPresets, plugins, menus | Config Center, named config bundles, plugin and marketplace management, plugin menus |
| `/notifications`, `/alerts`, `/monitors`, `/status-pages`, `/status` | notifications, alerts, uptime | channels and delivery log, alert rules, uptime monitors, status pages (public JSON) |
| `/log-drains` | logDrains, logSearch | drain CRUD and test, cluster log search |
| `/housekeeping`, `/doctor` | housekeeping, images, doctor | prune configuration, image inventory and retention (under `/housekeeping`), the host health report and guarded repairs |
| `/system`, `/system/panel-backup` | resources, panelBackup | resources, Docker events, update check and self-update, export and import; the panel's own backups |
| `/stats`, `/metric-history`, `/usage`, `/dashboard`, `/onboarding` | stats, metricHistory, usage, dashboard, onboarding | live and historical metrics, Prometheus and OTLP export, usage and cost, the dashboard aggregate, the getting-started checklist |
| `/environments` | environments | deployment lanes and their protection |
| `/deployments` | imageTransfers | the image transfers of a deployment |
| `/ai`, `/insights`, `/activity`, `/about`, `/branding`, `/badges`, `/deploy-hooks`, `/registry-hooks` | ai, insights, activity, about, branding, badges, deployHooks, registryHooks | AI diagnosis and fixes, framework insights, the audit feed, version and changelog, branding overrides, public status badges, public deploy-hook and registry-hook receivers |
| `/openapi.json` | openapi | the OpenAPI 3.1 document |

Outside `/v1` (registered in `app.ts`): `/health` (liveness and database
ping), `WS /v1/events` (global audit stream), public status-page HTML, the
wake endpoint Traefik calls for a sleeping service, the maintenance and error
pages Traefik serves, the forward-auth verification endpoint, the public error
ingest, MCP OAuth discovery at the origin root, and `/scim/v2`.

## 6. Fastify plugins

Registered in `plugins/` in the order of §5.

| Plugin | Function |
|---|---|
| securityHeaders | Hand-rolled CSP and baseline headers (no helmet) |
| rateLimit | Global bucket of 1,000 requests per minute per principal (user or IP), with tighter per-route limits on auth, setup and webhook routes |
| rawBody | Captures the raw JSON body for HMAC verification while keeping Fastify's prototype-poisoning guard |
| db | Decorates `fastify.db`; applies PRAGMAs and **pending migrations** through the runtime migrator; repairs a few essential columns on an old database |
| panelAccess | Enforces the panel IP allow-list on every request, WebSocket upgrades included |
| kernel | Builds the microkernel, registers the drivers, build caches, orchestrators and 12 built-in plugins, restores DB-installed plugins on `onReady`, and bridges the audit stream into the kernel event bus (§16.3, [docs/PLUGINS_MICROKERNEL.md](docs/PLUGINS_MICROKERNEL.md)) |
| githubFeedback | Commit statuses and PR comments for GitHub App links, and commit statuses for GitLab, Gitea and Bitbucket |
| auth | `authenticate` (JWT access token or API token; `isOperator` recomputed per request and narrowed for scope-restricted tokens) + `requireOperator` / `requireAdmin`; the single enforcement point for token scopes |
| worker | The deploy worker — §7 |
| traefik | Ensures the `ninedeploy` network, the Traefik container and the dynamic routing config at boot, and heals the proxy |
| publicDatabaseAccess | Boot reconcile and a 5-minute watchdog for public database sidecars |
| databaseImports | Boot recovery and an hourly expiry sweep for dump and volume imports |
| terminals | Boot recovery and a 60-second reaper for terminal sessions |
| trafficAnalytics | Access-log tailer (10 s) into minute and hour rollups; idle while analytics is off |
| nodeDatabases | Every 60 s, reconciles the status of databases hosted on nodes |
| runtimeState | Reconciles panel status against live containers and processes every 60 s |
| fanoutRecovery, primaryRecovery, nodeLifecycle, swarmRecovery | Resume or safely abort interrupted fan-out, primary, node lifecycle and Swarm transitions (every 60 s) |
| collector | Samples container and host stats every 30 s; feeds metrics, history and the alert evaluator |
| observability | Prometheus and OTLP export on the configured interval |
| uptime | Runs due uptime monitors (5 s scheduler tick) |
| autoscaler | Every 30 s, scales services with an autoscale configuration; resumes expired node scale work |
| sleeper | Every minute, sleeps eligible services whose domains stayed idle; the wake endpoint wakes them |
| backupScheduler | Per-database backup policies; databases without one keep the last 7 daily backups; pushes to destinations and replicas |
| pitrScheduler | Hourly upkeep of local PostgreSQL PITR archives (first pass 10 minutes after boot) |
| autoUpdateScheduler | Every 30 minutes, re-deploys opt-in image services whose tag's digest moved |
| githubRunnerScheduler, ciScheduler | Just-in-time GitHub Actions runners; CI lease sweep that requeues jobs whose runner disappeared |
| cloudNodeScheduler | Finishes the rekey of cloud-provisioned nodes (every 2 minutes) |
| imageScanScheduler | Hourly rescan of running images when image scanning is on |
| gitopsScheduler | Reads the instance file on its interval and alerts on drift |
| sharedCertificateSync | Pushes renewed panel certificates to node proxies |
| restartLimiter | Stops services that keep crashing past their opt-in limit |
| housekeeping | Hourly retention: deploy logs **and finished deployment rows** 30 d, audit 90 d, notification log 30 d, job runs 30 d, dead sessions 7 d, expired reset tokens, drills 90 d, retired invitations and transfers 30 d, cold build-cache rows 90 d, CI jobs 30 d, error events 30 d, plus scratch files |
| logShipper | Forwards container output to configured drains every 10 s over a durable queue |
| jobScheduler | Cron-scheduled per-service jobs via croner; reloads the job set every 5 minutes |
| panelBackupScheduler | Arms one cron job for the panel's own encrypted backup when enabled |
| staticFiles | Serves the built SPA; registered last, so API routes win over the catch-all |

## 7. Deploy engine

Everything goes through the **Docker CLI** via validated spawn — no dockerode.
All process spawning funnels through `lib/spawnValidated.ts` (operand regexes,
arg-array execution, never a shell string); `lib/exec.ts` adds hard timeouts
with tree-kill (SIGTERM → SIGKILL) and a whitelisted environment (never
`NINEDEPLOY_*`). Guides: [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md),
[docs/ROLLBACK.md](docs/ROLLBACK.md), and the generated
[support matrix](docs/SUPPORT_MATRIX.md) for what each runtime supports.

### 7.1 Pipeline (`engine/pipeline.ts`)

```
 1. Trigger (panel, webhook, GitHub App, CLI, cron job, deploy hook, registry
    push, template, image auto-update) → a deployment row (queued). A deploy
    into a lane with require_approval waits as awaiting_approval and a deploy
    gated on required GitHub workflows waits as awaiting_ci; the worker claims
    only `queued`. A deploy freeze holds rows as queued until it ends. A
    [skip ci]/[skip cd] head-commit marker skips webhook auto-deploys
 2. The worker (plugins/worker.ts) polls every 2 s with
    NINEDEPLOY_DEPLOY_CONCURRENCY claim loops (1–8, default 1). A claim is
    atomic (queued → building guarded by rowsAffected), a service is never
    deployed twice at once, and builds wait for a slot on their build host
    (the panel's sized by the deploy concurrency, a build server's by its
    build_concurrency). `building` rows older than 45 min are requeued (at
    boot and every 5 min); an interrupted remote deploy fails after its grace
    window and is never resumed behind the operator's back; stop grace 60 s
 3. The row stores a config snapshot (build config plus an env-key
    fingerprint — values never), which powers the per-deploy diff
 4. PREPARE — image deploy: pull (rollback pins an exact digest). Repo deploy:
    resolve source creds → checkout the commit (token or SSH key scrubbed from
    every log line; a GitHub App repository uses a short-lived installation
    token; a fork's PR is cloned with no credential) → Git LFS → framework
    analysis into repo_insights (best effort) → load `.ninedeploy`. An
    uploaded archive replaces the checkout; an inline Dockerfile replaces the
    repository's
 5. DEPENDENCIES — for template services, reconcile managed database
    dependencies idempotently
 6. Environment — project-scope vars ← service vars ← preview-only vars ←
    attached-database connection strings, then secret-manager references
    (${{infisical:…}}, ${{doppler:…}}, ${{vault:…}}, ${{aws:…}} and the other
    configured secret managers, [docs/SECRET_MANAGERS.md](docs/SECRET_MANAGERS.md))
    are resolved at deploy time and never stored; a missing
    key fails the deploy. Registry auth comes from registry-type sources
 7. Pre-deploy hook — on the panel host; on a node it runs in a one-off
    container from the release's own image
 8. BUILD — build packs: auto, dockerfile (BuildKit through buildx, with an
    inline, registry or S3 build cache), nixpacks, railpack, paketo and heroku
    (Cloud Native Buildpacks through `pack`, panel host only), static. Build
    placement (`build_on`): on the target, on the panel, or on a dedicated
    build server, with the image moved by sealed stream, a pinned registry or
    preload. What a placement cannot do is refused at save, queue and deploy
    time (lib/remoteDeploy.ts, lib/serviceCapabilities.ts)
 9. BOOT — start the new runtime with secrets through a 0600 temp env-file
    (deleted after start), its own `nd-svc-<slug>` bridge with Traefik
    attached, database bridges, volume and file mounts, limits, runtime
    options and the restart policy. The previous runtime keeps serving
10. HEALTHCHECK — modes http (the default), running, http-strict, tcp and
    command; 10–3600 s per service, 300 s by default. On a node the probe
    runs inside the workload's network namespace on capable agents; otherwise
    container state is the signal, and the deploy log says so. Post-deploy
    hook afterwards (failure is a warning, not fatal)
11. CANARY (optional) — Traefik sends the new release `steps[0]` percent of
    the requests, then each further step; every step waits for the healthcheck
    and, with traffic analytics on, for the error-rate and latency gates
12. PROXY_SWAP — finalize the row conditionally on still being in flight (a
    late cancel wins), persist the image digest, demote older `running` rows
    to `superseded`, write Traefik's dynamic config and confirm the routing is
    live (on a node the agent acknowledges the loaded config). A failed swap
    reverts the previous routing
13. CLEANUP → COMPLETE — after a settle, run the pre-stop hook and retire the
    previous runtime
14. FAILURE — stop the new runtime; if the previous one is still healthy
    (Docker blue-green) the service keeps serving it and only the deployment
    is marked failed. PM2 has no previous runtime (stop-then-start), so it
    goes down. CANCEL — the pipeline re-reads its status at every checkpoint
    and tears down the partial runtime
15. Durability — a primary swap, a fan-out, a Swarm update or a node lifecycle
    command is journalled with an owner token, an epoch and a lease. A panel
    restart resumes or safely aborts it (the recovery plugins of §6); stale
    work from an earlier generation loses its authority
16. Every subprocess has a hard timeout and tree-kill. Audit, kernel events
    and notifications run throughout; logs stream over WebSocket and persist
    to disk (engine/logs.ts LogBus), stage-tagged as `##[stage:NAME:state]`
```

### 7.2 Builders

- **docker.ts** — build and run on the panel host: Dockerfile via buildx or
  Nixpacks / Railpack / buildpacks, the service's own `nd-svc-<slug>` bridge,
  secrets through a 0600 temp env-file, probes against the container's
  primary-network address, replicas (hard ceiling 10), port mappings
  (operator-gated, reserved ports refused), blue-green switch and automatic
  rollback
- **buildkit.ts** — the BuildKit build path and its cache events; caches come
  from the kernel's build-cache registry (inline, registry, S3)
- **staticSite.ts** — the static pack: builds the project and serves the
  output directory through a generated nginx image, with or without SPA
  fallback
- **pm2.ts** — a Node runtime managed by PM2 on the host; stop-then-start
  with auto-rollback on failure. Host-privileged, operator-only
- **compose.ts** — `docker compose config`, `pull` and `build` while the
  previous revision serves, then `down` and `up -d`, with the `ndcmp-` project
  prefix; the build is skipped when the commit and the resolved model are
  unchanged; a recorded release restores pinned images and the encrypted
  resolved configuration. Host-privileged, operator-only
- **remoteDocker.ts, remoteRun.ts, remoteReplicas.ts, remoteCompose.ts** —
  the node builders: the panel drives the typed agent protocol (clone,
  build, pull, write env, run, replicas, compose preflight and up). Nixpacks,
  Railpack and Dockerfile builds run on the node when the service allows it;
  Paketo and Heroku build on the panel and ship the image
- **swarmDeploy.ts, swarmServiceSpec.ts, swarmArtifact.ts, swarmPreload.ts** —
  the Swarm builder: a stateless deployer for services without volumes,
  databases, host ports or fan-out
- **nodeAutoscaleBinding.ts, nodeAutoscaleDeployment.ts, nodeAutoscalePrepare.ts** —
  immutable serving and spare replicas for node autoscaling (§12)

### 7.3 Reverse proxy (`engine/proxy.ts`)

Traefik v3 is the intended sole exposed container (:80/:443). The panel runs
`traefik:3` as `ninedeploy-traefik`; each node runs a pinned `traefik:v3.1`
proxy that the panel configures remotely. Dynamic configuration is written
atomically (temp file + rename) into a **directory** bind mount — a single-file
mount would pin the inode and never see renames — and Host and Path rule
operands are strictly sanitized against rule and YAML injection. The panel
itself is exposed through the proxy (the panel domain, the forward-auth and
maintenance endpoints, status pages and the wake route).

Per domain: www → apex and custom redirects, response headers, basicAuth,
`ipAllowList`, `rateLimit`, sticky sessions, panel sign-in (forward auth),
maintenance mode and custom error pages, compose-service targets. Settings
that change routing — panel sign-in, maintenance and error pages — succeed
only after the proxy confirms the change; a failed apply restores the previous
value and routing, and an unconfirmed state stays visible and is retried at
boot and by the proxy watchdog. ACME supports HTTP-01 and DNS-01 (wildcards)
through Cloudflare, DNSimple, Namecheap, Route 53, OVH, Porkbun and Hetzner
DNS; uploaded and shared certificates are honored and feed the expiry alert.
Custom dynamic configuration is validated in a throwaway Traefik before the
live one sees it. Opt-in traffic analytics reads a JSON access log that keeps
no client address, path or header. See
[docs/TRAEFIK_INGRESS.md](docs/TRAEFIK_INGRESS.md).

## 8. Auth, RBAC and account security

- **JWT** (jose, HS256): access 15 m + refresh 7 d by default
  (`NINEDEPLOY_JWT_ACCESS_TTL`, `NINEDEPLOY_JWT_REFRESH_TTL`); the `ver`
  claim is matched against `users.token_version` — logout and password
  change or reset bump it, revoking every outstanding session statelessly
- **Sessions**: every refresh token carries a `jti` referencing a live row
  (ip, user agent, last used, expiry, revoked). `/auth/refresh` enforces the
  row on every rotation, so one device can be signed out without touching
  the others
- **Passkeys**: WebAuthn registration and passwordless login via
  `@simplewebauthn/server`; challenges are single-use with a 5-minute TTL;
  signature counters track clone detection
- **API tokens**: opaque, sha256-hashed at rest, optional expiry and
  `last_used_at`, and **enforced scopes** applied centrally in
  `plugins/auth.ts`: the coarse scopes `read` (safe methods only), `write`
  (mutating, always as a non-operator) and `operator`, plus fine-grained URI
  scopes of the form `nd://scope/<read|write|admin>/…` issued for remote MCP.
  A scope can only narrow the owner's authority; an empty list is a pre-0.3.5
  token and stays unrestricted (§16.5)
- **2FA**: dependency-free RFC 6238 TOTP (30-second period, ±1 step), the
  secret encrypted at rest and codes **consumed**, so a replay inside the
  drift window fails; one-time recovery codes; a per-workspace policy that
  requires a second factor (with a per-provider SSO exemption); step-up
  re-checks for sensitive actions
- **SSO**: OIDC providers and SAML providers (SP-initiated, verified with
  `@node-saml/node-saml`), account linking, SCIM 2.0 provisioning at
  `/scim/v2` with per-workspace tokens, and auto-enrolment into a personal
  workspace. See [docs/SECURITY_SSO.md](docs/SECURITY_SSO.md)
- **Passwords**: Argon2id; self-service change, operator reset, single-use
  30-minute reset links
- **Lockout**: in-memory — 5 failures lock that account-and-IP
  pair for 15 minutes, and 25 failures from more than one source lock the
  account; on top of per-IP and per-principal rate limits
- **Registration gate**: `allow_registration` (default **off**). The first
  account is the instance operator and needs the installer's one-time setup
  token (`NINEDEPLOY_SETUP_TOKEN`, or a generated one kept under the data
  directory)
- **Panel allow-list**: an operator-managed IP allow-list enforced on every
  request and WebSocket upgrade; `NINEDEPLOY_PANEL_ACCESS=off` is the
  lock-out recovery
- **WebSocket auth**: an auth subprotocol header, with `?token=` back-compat
  (query strings are stripped from request logs)

### 8.1 The authorization model — and its central weakness

`lib/resourceAccess.ts` is the single authorization choke point. The intended
model is workspace-scoped:

- **service** → the caller is a member of a workspace the service is tagged
  into, or is the service's `owner_user_id`
- **project** → the caller is a member of the project's workspace; a
  NULL-workspace project is operator-only
- **database** → `owner_user_id` match, or membership of the owning
  project's workspace
- **access grants** (0.15) raise one user's role on a project, an environment
  or both, on top of their seat, or give a seatless guest just that; they
  never lower a role and can be suspended (SCIM holds them)

Above that sits **`isOperator`**, read from the dedicated
`users.is_instance_operator` column and recomputed on every request. It
bypasses every resource loader and gates every system-wide route
(`requireOperator`, aliased `requireAdmin`): users, SSO providers, system
import and export, self-update, volumes, sources, tunnels, firewall, Config
Center, plugins, containers and the file browser, database credentials,
terminals, backups.

It also gates the **host-privilege boundary** (`lib/hostPrivilege.ts`): PM2
services, Compose deploys, pre/post/pre-stop lifecycle hooks and
`docker_socket` templates all execute code on the host and are therefore
operator-only — as is publishing a privileged host port (`lib/hostPort.ts`).

The flag is **deliberately not derived from workspace membership**. Until
0.3.4 `isOperator` meant "holds `owner`/`admin` in at least one workspace";
because `POST /v1/workspaces` has no role gate and inserts the caller as
`owner` (and `GET /v1/workspaces` auto-creates an owned workspace for a user
with no seats), any authenticated user could promote themselves to full
instance operator with one request — and, through the host-privilege
boundary, reach arbitrary code execution on the host. Migration `0038` moved
the flag onto the user row:

- the first account (created with the setup token) receives it;
- everyone else is granted it explicitly by an existing operator via
  `PATCH /v1/users/:id/operator` (Settings → Users);
- the last remaining operator cannot be demoted or deleted;
- creating a workspace confers nothing at instance level.

`test/operatorEscalation.test.ts` pins this against a real database — it
fails against the pre-0.3.5 implementation.

Within a workspace, the four roles are a real hierarchy
(`owner > admin > member > viewer`) enforced by `assertWorkspaceRole` and,
for service-scoped writes, **`assertServiceRole`**. The effective role on a
service is the highest seat the caller holds across the workspaces that
service is tagged into, with the service's `ownerUserId` and the operator
flag both counting as `owner`. The convention across the routes is:

| Action | Required |
|---|---|
| read a service, its deploys, logs, env keys | any seat (incl. `viewer`) |
| deploy, rollback, cancel, restart/stop/start | `member` |
| edit the service or build config, write env, manage domains, set limits | `member` |
| delete the service, re-tag it into other workspaces, delete a project | `admin` |
| host-privileged shapes (PM2, compose, lifecycle hooks, docker socket), instance-wide routes | instance operator |

The full matrix, with databases, volumes, backups and lanes, is in
[docs/WORKSPACES_RBAC.md](docs/WORKSPACES_RBAC.md).

## 9. Multi-server (agent mode)

Remote hosts run the same server binary with `NINEDEPLOY_AGENT=1`, which
boots a minimal HTTP agent instead of the full API (`src/agent.ts`,
`src/agentApp.ts`, default port 4600). The agent keeps its state relative to its own
working directory (`.agent-work/`, including `.agent-work/.lifecycle` and
`.agent-work/.transfer`), so in a container install that directory is mounted
at the same path inside and outside: every path it hands the host's Docker
daemon is real. Guides:
[docs/MULTI_NODE.md](docs/MULTI_NODE.md),
[docs/NODE_OPERATIONS.md](docs/NODE_OPERATIONS.md).

- **Enrolment.** A node registers with a one-time token (the shared token is
  stored encrypted and compared as sha256, timing-safe), can self-announce to
  `NINEDEPLOY_MASTER_URL` with an admin-issued enrolment token (the one
  deliberately unauthenticated write in the product), can be bootstrapped
  over SSH, or created through the Hetzner, DigitalOcean or Vultr API and
  rekeyed (`agent.rekey`) as soon as it answers. `servers` records
  `agent_version`, `agent_caps` and `last_seen_at`
- **Typed operations.** The panel talks to agents through `lib/agentClient.ts`
  → `POST /agent/exec` with a **typed operation name**, never a program name
  or raw argv. The agent accepts **125 operations**: 27 in the core table of
  `agent.ts` (docker pull, build, run, runEnv, stop, start, rm, inspect, logs,
  login, logout; network create, remove, connect, disconnect; volume inspect
  and remove; compose up, config, pull, down, ps; git clone, fetch, checkout,
  rev-parse, reset), 12 more handled directly there (ping, stats, env-file and
  workspace writes, the compose restart policy, `git.ensure`, proxy write and
  ensure, terminal open, workspace removal), and 86 registered in 37 modules
  under `agentOps/`:

| Module | Operations |
|---|---|
| agentRekey | `agent.rekey` |
| builds | `build.nixpacks`, `build.railpack`, `docker.buildWith` |
| containerIdentity | `docker.identity`, `docker.retire` |
| containerLifecycle | `docker.lifecycle`, `docker.lifecycleRetire` |
| containerMetrics | `docker.metrics` |
| containerMutation | `docker.runtimeFence`, `docker.runtimeInventory`, `docker.stopSet`, `docker.startSet`, `docker.runtimeLegacyHandoff`, `docker.prepare`, `docker.networkSet`, `docker.retireSet`, `docker.limits` |
| containerReadiness | `docker.readiness` |
| containerTools | `docker.containerTool` |
| databaseClient | `db.client.prepare` |
| databases | `docker.restart`, `db.exec` |
| deployHooks | `docker.hookRun` |
| fileMounts | `file.writeMount`, `file.removeMounts` |
| gitCredential | `git.withKey` |
| githubRunners | `gha.runner.prepare`, `gha.runner.start`, `gha.runner.list`, `gha.runner.stop` |
| idleWatch | `proxy.idleWatch.open`, `proxy.idleWatch.sample`, `proxy.idleWatch.finish`, `proxy.idleWatch.close` |
| imageScan | `image.scan` |
| images | `docker.imageInspect`, `docker.imageRm`, `docker.tag`, `docker.push` |
| nodePages | `proxy.pages.write`, `proxy.pages.prune`, `proxy.pages.ensure` |
| observability | `docker.probe`, `docker.logsSince` |
| pgbouncer | `db.pgbouncer.enable`, `db.pgbouncer.disable`, `db.pgbouncer.status` |
| osUpdates | `host.packages` |
| pitr | `db.pitr` |
| proxyOrdered | `proxy.writeOrderedConfig` |
| proxyRouting | `proxy.confirmRouting` |
| proxyTraffic | `proxy.traffic.open`, `proxy.traffic.sample`, `proxy.traffic.finish`, `proxy.traffic.close` |
| publicAccess | `db.publicAccess.apply`, `db.publicAccess.remove`, `db.publicAccess.inspect` |
| runSpec | `docker.runSpec` |
| servingTraffic | `proxy.servingTraffic.open`, `proxy.servingTraffic.sample`, `proxy.servingTraffic.finish`, `proxy.servingTraffic.close` |
| stream | `stream.open` |
| studios | `db.studio.start`, `db.studio.stop`, `db.studio.clear`, `db.studio.open` |
| swarm | `swarm.info`, `swarm.join`, `swarm.leave` |
| tunnels | `tunnel.open` |
| volumeFiles | `volume.fileTool` |
| volumes | `docker.volumeCreate`, `docker.volumeList`, `docker.volumeUsage`, `docker.volumeSize`, `docker.composeVolumes`, `docker.composeVolumeCreate` |
| wakeCatcher | `wake.catcher.inventory`, `wake.catcher.prepare`, `wake.catcher.retire`, `wake.catcher.ensure`, `wake.catcher.remove`, `wake.demand` |

  Every operand (names, paths, URLs, refs, SHAs) is validated by strict regexes
  on both ends. A registered operation is sealed-only unless it carries no
  secret: only `file.removeMounts`, the four image operations,
  `db.publicAccess.inspect`, `db.pgbouncer.status` and the four volume
  operations may use the legacy plaintext transport when the operator has
  opened it, and the three build operations are sealed whenever they carry an
  environment or build arguments. (The table lists one row per source file;
  `volumes.ts` registers three modules and `agentOps/index.ts` is the
  authority.)
- **Capabilities and switches.** An agent advertises, inside its
  sealed `agent.ping` operation, exactly the operations its owner has switched on
  (`NINEDEPLOY_AGENT_BUILDS`, `NINEDEPLOY_AGENT_DATABASES`,
  `NINEDEPLOY_AGENT_PROXY_TRAFFIC`, `NINEDEPLOY_AGENT_GHA_RUNNERS`,
  `NINEDEPLOY_AGENT_HOST_TERMINAL`, `NINEDEPLOY_AGENT_IMAGE_SCAN`, …).
  Advertised operations, not an assumed version, decide support; the panel
  refuses a request with `422 node_agent_outdated` when a node's agent
  predates a feature
- **Transport is sealed by default.** Both ends derive a per-message key with
  HKDF-SHA256 from the shared secret — `sha256(agentToken)`, the only value
  both sides hold — and the body travels as AES-256-GCM with the timestamp
  bound in as AAD (`lib/agentSeal.ts`). The token never crosses the network
  (opening the envelope *is* the authentication), and neither do the service
  secrets an env-file write carries. Envelopes older than ±5 min are refused.
  The legacy plaintext transport is **opt-in**: it is used only with
  `NINEDEPLOY_AGENT_ALLOW_CLEARTEXT=1`, and
  `NINEDEPLOY_AGENT_REQUIRE_SEALED=1` forbids it outright. Node terminal and
  tunnel channels use a per-channel frame cipher with a strict counter
  (`lib/agentFrameCipher.ts`)
- ⚠ Still **no TLS**: this hides the payload, not the metadata (which host,
  when, how often, roughly how large), and it gives no forward secrecy and no
  defence against an attacker who already owns the agent host. Agents belong
  on a private network. mTLS remains the long-term answer (§16.6)
- **Each node runs its own Traefik.** The panel is the source of truth for
  domains, middlewares and certificate policy: it renders the node's static
  and dynamic config and ships both through ordered writes; the node only
  writes them to a fixed path and acknowledges the loaded routing. A routing
  change refreshes every node; the proxy is recreated only when its static
  config changed
- **Durable authority.** Node Stop, Start, Restart, deploy, scale, sleep and
  wake run as ordered intents (`node_lifecycle_intents`,
  `node_sleep_transitions`, `node_autoscale_transitions`) against a
  per-service runtime owner epoch, so a superseded or interrupted command
  cannot act on a newer runtime (§7.1, [docs/NODE_SLEEP_WAKE.md](docs/NODE_SLEEP_WAKE.md))

## 10. Scoping: workspaces, projects, labels, lanes

Three independent, optional tag dimensions replace the old single-parent
project hierarchy (migration `0034`):

- **Workspace** — the team/tenancy unit. Carries membership and roles
- **Project** — a grouping inside (or across) workspaces
- **Label** — free cross-cutting tagging ("production", "team-x"),
  workspace-scoped or global

A service may belong to many of each. Two more dimensions sit on top:
**environments** (deployment lanes such as production or staging; a lane can
be *protected*, hiding its variables and logs from members, and can *require
approval* before any deploy) and **access grants** (§8.1).

The web UI keeps the active workspace in `lib/workspace.tsx` (localStorage)
and the composed tag filter in the top bar; the API accepts
`?tagWorkspaceIds=&tagProjectIds=&tagLabelIds=`.

All list endpoints share one visibility rule — `visibleServiceIdSet` in
`lib/resourceAccess.ts`: untagged services the caller owns ∪ services tagged into a workspace the
caller belongs to ∪ services an access grant covers, unrestricted for instance
operators.

## 11. Web UI

- **Stack**: React 19.2, react-router 8, Vite 8, Tailwind CSS 4 (CSS-first
  `@theme`), TanStack Query 5, xterm.js 6, @xyflow/react 12, lucide-react
- **Theming**: dark and light via `data-theme`, accent colors via
  `data-accent`; persisted in localStorage
- **Experience mode**: `simple` (default) vs `advanced` — hides advanced
  navigation groups and controls for first-time operators
- **Layout**: `compact` (default) or `classic` (`lib/layout.ts`) —
  the compact layout shortens the sidebar, merges overlapping entries and
  folds rarely used cards
- **Pages** (`routes/`): Dashboard, Services, New (one picker for every
  resource), Hub (template gallery), Manifest Creator, Deploys, Doctor,
  Databases and database detail, Domains, Tunnels, Users, Volumes, Networks,
  Docker, Topology, Backups, Sources, Servers, Settings, About, Monitoring,
  Activity, Traefik, Terminals, Workspaces, Projects, Labels; plus sign-in,
  password reset, invitation acceptance, the OAuth consent page and the
  forward-auth page
- **Service detail** — 15 tabs: Overview, Terminal & Exec, Architecture,
  Manifest & Traefik, Compose File, Deploys, CI, Environment, Network &
  Domains, Volumes & Storage, File Browser, Framework, Settings, Activity
  Logs, Danger Zone; the cards for canary, autoscale, sleep, placement,
  maintenance, forward auth, image scan, errors, pending changes and recovery
  live on these tabs
- **Settings** — 20 sections: Account, Appearance, Security, SSO & OIDC,
  Integrations, AI Diagnosis, Notifications, Log Drains, Firewall, Storage &
  Prune, Swarm, Deploy freeze, CI runners, Image scanning, GitOps, Config
  Center, Plugins, System, Panel backup, Migration
- **Languages**: English (the source strings) and Turkish
  (`locales/tr.ts`, keyed by the English text); `test/i18nCatalog.test.ts`
  fails on a missing or unused entry. See
  [docs/TRANSLATIONS.md](docs/TRANSLATIONS.md)

## 12. Alerting, scaling and observability

Threshold rules (`alert_rules`) are evaluated by the collector on every 30 s
sample:

```
ok → breaching (first breach, breach_since = now)
   → firing  (breach sustained ≥ duration_windows × 30 s → ONE notification)
   → ok      (clears → recovery notification, only if it had fired)
```

- Metrics: `cpu`, `memory`, `error_rate` and `latency_p95` per service;
  `cert-expiry` (days remaining across issued and uploaded certificates),
  `disk` and `server_offline` are host-wide only — the API refuses a
  `serviceId` for them
- `disk`: percent used of the worst filesystem across the panel host and the
  nodes. On the panel host the data directory is measured, plus Docker's data
  root when it is a different, locally visible path. Each node's reading comes
  from its agent's `agent.stats` (`ND-DF` lines of `df -kP`, 30 s timeout),
  sampled every 5 minutes; a reading older than 15 minutes is dropped
- `server_offline`: whole minutes (rounded up) that the longest-unseen
  registered node has gone without contact, so `> 5` means "unseen for more
  than 5 minutes" (the panel default). Contact is the node's heartbeat
  announce or the panel's own sealed ping on each collector tick. Pending
  nodes and nodes that never connected are not watched, and unseen time
  counts from the panel's first completed ping cycle at the earliest, so a
  panel that was itself down does not fire for that gap
- Both are fleet-wide rules with one state row each: the value is the worst
  host, and the fired notification names every host involved
- Anti-spam: a 30-minute cooldown before re-notifying; state is reset when
  the rule is edited
- Events that are not threshold rules are audited and notified the same way:
  deploy outcomes, restart-limit trips, uptime up and down, new and regressed
  error issues, critical image-scan findings, GitOps drift and node lifecycle
  alerts. An AI alert investigation can be attached to a firing rule
- Channels: 17 types — Telegram, Discord, Slack, Microsoft Teams, Mattermost,
  Google Chat, Matrix, Lark, PagerDuty, Opsgenie, ntfy, Gotify, Pushover,
  email, Resend, FCM and generic webhook — with a per-channel event filter and
  a delivery log
- **Uptime monitors** (`http`, `tcp`) run from the panel on their own
  interval with down and up alerts; public status pages show them with a
  90-day history
- **Metrics history**: raw samples for a day, 5-minute rollups for up to 7
  days, 1-hour rollups for the configured retention (1–90 days); Prometheus
  and OTLP export are opt-in
- **Logs**: the runtime log tail, a durable drain queue with cursors and
  batches feeding 11 drain types (syslog, Loki, Vector, Datadog, HTTP,
  Elasticsearch, Splunk, Better Stack, New Relic, Axiom, CloudWatch), and
  cluster log search through the Loki drain
- **Autoscaling** (0.16.10): every 30 s, between a minimum and a maximum
  number of replicas, driven by CPU, memory or requests per second, with
  optional scheduled floors. Idle until a service has a configuration
- **Scale to zero** (0.16.11): `sleep_after_minutes` puts an idle service to
  sleep; its first request hits the wake route and wakes it. On nodes this
  needs the traffic capability, continuous idle evidence and a wake catcher
- **Canaries** (0.16.9): weighted traffic steps (§7.1)
- **Error ingest**: a Sentry-compatible endpoint per service, grouped by
  fingerprint and linked to the deploy that introduced an issue

Guides: [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md),
[docs/UPTIME.md](docs/UPTIME.md), [docs/AI.md](docs/AI.md).

## 13. Testing

| Package | Test files | Statements / Branches / Functions / Lines floor |
|---|---|---|
| apps/server | 903 | **93.25 / 87.3 / 91 / 95.1** |
| apps/web | 247 | **97.5 / 91.5 / 97.5 / 97.5** |
| apps/cli | 69 | **83 / 80 / 80 / 83** |
| packages/db | 36 | 100 |
| packages/schemas | 44 | 100 |
| packages/sdk | 40 | 100 |
| packages/mcp | 4 | **90 / 80 / 95 / 95** |
| packages/plugin-sdk | 1 | 100 |
| desktop | 5 | no gate |

Test files are counted in the tree; the floors are the thresholds in each
`vitest.config.ts`. The server, web, CLI and MCP floors sit below 100, with
the reasoning recorded inline in each config. A full local `release:check`
in Linux took 37 minutes on November 25, 2026, for the 0.20.0 candidate, with
20,259 tests, no failure and no skip, while the server suite still ran in one
process; `release:check` now runs it through `pnpm test:server`.

- **Unit, route and regression tests** run by default. `fileParallelism` is
  off for the server: an invocation has one data root, and the suites boot
  a real Fastify kernel against an in-memory database. `pnpm test:server`
  gets its parallelism another way: several processes at once over small
  chunks of the files. A process is an invocation of its own, with a data
  root of its own and its files still one after another; it takes the next
  chunk when its ends. The chunks deal the files round-robin, because the
  heaviest files sit together in the alphabet. The chunks' coverage is
  merged and the four floors are checked once
  (`scripts/test-server-sharded.mjs`). On GitHub's runner (4 cores,
  15.6 GiB) that is 6 processes over 24 chunks; on November 25, 2026 the
  suite took 11.6 minutes where, in one process, it took 38.9.
- **Integration tests** (`apps/server/test/integration/`, 14 files) use
  testcontainers with real PostgreSQL, MySQL, Redis and MongoDB and real
  Docker. They are excluded from the default config and run only through
  `vitest.integration.config.ts` with `RUN_INTEGRATION=1`, one file at a
  time, as a separate CI job
- **Browser journeys** (`e2e/`, Playwright) drive an isolated panel in
  Docker-in-Docker: setup, first deploy, environment and rollback, database
  backup and restore, approval, member access, compact and phone layouts,
  domain routing and PR previews
- **Contract preflight** (`pnpm check:contracts`) runs the fast guard suites
  before the long coverage run: release notes and workflows, the
  documentation index, audit coverage of every mutating route, capabilities
  and node refusals, proxy setting application, PITR contracts, the
  environment reference, the smoke inventory, owned settings, import cycles,
  the Swarm reader, the OpenAPI document and the test cache inputs

CI (`ci.yml`) runs on every push and pull request: typecheck → lint → build →
contract preflight → test, a **schema-drift check** (regenerating migrations
must produce no diff) and a **deprecated-dependency check**, a Node security
baseline, an installer sanity check and smoke. Beside that job run the
integration job and an image job that is a matrix of six groups: each job
builds the image and runs its own smokes on real routing (the in-place
upgrade, node autoscaling, the canary lifecycle, readiness, serving-traffic
observation and the wake catcher). In one job those smokes took 43 minutes
on November 25, 2026; the longest group takes about 13. The main image is
published only after the verify job and every group have passed, and the
Release workflow starts its nine cohorts all at once.

The schema-drift gate is **functional** as of 0.6.0: the CI step requires the
literal `No schema changes, nothing to migrate` line plus a clean `git
status`, and `packages/db/test/schema-drift.test.ts` remains the second line
of defence.

### 13.1 Release drill

A release is a version bump (`pnpm version:bump X.Y.Z`, then a real
`version.ts` entry and a `CHANGELOG.md` section that opens with
**Highlights** and an **Action needed:** line — `pnpm release:tag` refuses a
section without them), a commit, and a lightweight `vX.Y.Z` tag. Pushing the
tag runs `.github/workflows/release-publish.yml`:

1. **publish-image** — tag format, provenance (tag = `package.json` =
   `version.ts`), a successful main CI on the same commit, the release checks
   (typecheck, lint, build, test), the backup integration checks, then a
   multi-architecture build pushed as `:vX.Y.Z` only, with the manifest
   smoke-checked, the index **digest** signed with cosign keyless (GitHub
   OIDC → Fulcio, logged in Rekor; no maintainer key) and SLSA build
   provenance attached
2. **smoke-published-image** — on that pushed image, in privileged
   Docker-in-Docker: the upgrade smoke from the previous published release
   (the same data volume), the user-journey smoke and nine cohorts —
   `upgrade-journey`, `panel-lifecycle`, `public-lifecycle`,
   `agent-runtime`, `node-infrastructure`, `node-sleep-wake`,
   `public-canary`, `replica-databases` and `swarm-artifacts`
3. **desktop** — the installers are built and launched on macOS, Ubuntu and
   Windows (signing only when certificates exist)
4. **browser-release-gate** — the core Playwright journeys run against the
   signed image digest. This gate is in no published release: it was added
   in commit `e264a77c`, after v0.19.0, which did not include it
5. **promote-release** — only when all of the above pass: decide whether the
   tag is the highest (only then does `:latest` move), build and sign the
   integrity assets (`ninedeploy-vX.Y.Z.tar.gz` from `git archive`,
   `install.sh`, `SHA256SUMS` over both and the desktop installers, and
   `SHA256SUMS.sigstore.json`), attach them to a **draft** release, re-point
   `:latest` at the already-pushed manifest (registry retag, no rebuild) and
   publish the draft
6. **publish-npm** — the CLI and packages

A red gate means **no server is offered the release**: installed servers
discover releases through the Releases API, and docker installs follow
`:latest` or their pinned tag. It does leave a pushed `:vX.Y.Z` image and a
git tag behind, which `git ls-remote` (the update check's last-resort
source) and `install.sh --version` can still see — fix forward promptly. The
smokes can be run by hand against any published pair:
`pnpm smoke:upgrade --from=vA --to=vB` and
`pnpm smoke:user-journey --image=ghcr.io/ninedeploy/ninedeploy:vB`.

**Channels.** The default channel offers every release. The **stable**
channel offers only the release the `stable` tag points at;
`.github/workflows/stable-channel.yml` moves it daily to the newest release
that is at least 7 days old, never backwards. A release's notes can carry
`<!-- stable: hold -->` (keep it off stable) or `<!-- stable: security -->`
(promote it at the next run). See [CONTRIBUTING.md](CONTRIBUTING.md).

## 14. Installation, updates and supervision

- **`install.sh`** (about 3,200 lines) supports **bare-metal** (default) and
  `--docker` modes on Debian and Ubuntu, the RHEL family and Fedora, Alpine
  (Docker mode only), openSUSE, SLES, Arch and derivatives; any other
  distribution works when Node and Docker are already present. It checks or
  installs Node 22.23.4+, 24.22.1+ or 26.12.1+ and Docker from signed
  repositories, installs checksum-verified Nixpacks, resolves the target
  version by channel (`--channel=release` default, `--channel=stable`,
  `--channel=main`, `--version vX.Y.Z`), can put the panel on its own domain
  from the first boot (`--domain`, `--email`) and keep it on loopback
  (`--private`). Bare metal: renders the systemd unit, snapshots `.data`
  before an upgrade, rebuilds, migrates, restarts and gates on `/health`.
  Docker mode: writes `/opt/ninedeploy-docker/docker-compose.yml` with
  `NINEDEPLOY_IMAGE_TAG` pinned, so the upgrade path is re-running the
  installer. The installer verifies the release archive against the signed
  `SHA256SUMS` (and the signature when cosign is installed) and prints the
  one-time setup token. See [docs/QUICKSTART.md](docs/QUICKSTART.md)
- **Update check** (`lib/updateCheck.ts`): GitHub-Releases-format feed, semver
  compare, a 1-hour cache (10 minutes after a failed check), per channel;
  `NINEDEPLOY_UPDATE_CHECK_URL=disabled`
  turns it off; offline → `updateAvailable: null`
- **Self-update** (`lib/selfUpdate.ts`): `POST /v1/system/update-start` with
  progress polling — a one-click panel upgrade that runs this install's own
  `install.sh` detached through `systemd-run`
- **systemd**: `Type=simple`, `WatchdogSec=0`, `Restart=always`,
  hardening (`ProtectSystem=full`, explicit `ReadWritePaths`,
  `NoNewPrivileges`, `PrivateTmp`); readiness is verified through the HTTP
  `/health` gate so long-running Docker children are not killed by a watchdog
- **Image**: `node:26-slim`, non-root `ninedeploy` user, tini, and the pinned
  Nixpacks, Railpack, `pack`, Compose and buildx binaries of §2
- **Backups of the panel itself**: an opt-in scheduled, encrypted panel
  backup; a combined disaster-recovery runbook covers restoring the panel,
  application volumes and databases on a new host
  ([docs/DISASTER_RECOVERY.md](docs/DISASTER_RECOVERY.md))

## 15. Security model

- **Commands**: every subprocess is an argument array through one validated
  spawn choke point, shared by the panel and the agent — never a shell string
  built from input
- **First boot**: a fresh panel accepts its first operator only with the
  installer's one-time setup token; registration is off by default
- **Containers**: healthchecks probe container addresses; Traefik routes by
  name over each service's own bridge. Host ports are not published by
  default — `published_port` and port mappings are operator-gated, and
  reserved ports (the panel, 80, 443, 22) are refused for everyone
- **Traefik**: the intended sole public listener; dynamic config written
  atomically into a directory bind mount; Host and Path operands sanitized;
  custom config is validated in a throwaway Traefik
- **Secrets**: AES-256-GCM in versioned envelopes (`v<ver>:iv:tag:ct`). The
  master key rotatable through the `NINEDEPLOY_MASTER_KEYS` ring and
  `POST /v1/settings/master-key/rotate` (or `ninedeploy system rotate-keys`);
  legacy envelopes stay readable (key version 0). Backup envelopes carry
  their own key version and are *not* rewritten by a rotation — see §16.9.
  Secret values are write-only in the API, masked in deploy logs and redacted
  before a sandboxed plugin sees configuration
- **Backups encrypted at rest** — dumps and volume archives are sealed with
  the master key on write; restore and download decrypt transparently, and
  legacy plaintext restores as-is
- **Webhooks**: HMAC-SHA256 (GitHub, Gitea) or a shared token (GitLab) plus
  branch match, watch-path globs and replay dedup; deploy-hook and
  registry-hook URLs carry hashed tokens; the public receivers are
  rate-limited
- **SSRF egress guard** (`lib/egressGuard.ts`): operator-supplied outbound
  URLs (notification channels, log drains, push delivery, git remotes, OAuth
  token exchange, secret providers, the template source) are refused when
  they resolve into private, loopback or link-local space — closing the
  metadata-service (`169.254.169.254`) path. It is deliberately not applied
  to targets that are normally internal (the OIDC issuer, the S3 endpoint,
  log search, telemetry); escape hatch `NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1`;
  DNS rebinding is explicitly *not* solved
- **Domain ownership proof** (`lib/domainVerification.ts`): non-operators
  must prove control of a hostname before attaching it
- **Agent transport**: sealed and authenticated envelopes by default, with
  sealed-only operations, a ±5-minute replay window, per-channel frame
  ciphers and no plaintext fallback unless the operator opts in (§9)
- **Subprocess hygiene**: whitelisted environment (never `NINEDEPLOY_*`);
  runtime secrets through a temp `--env-file` (0600, deleted after start);
  tree-killed on timeout
- **Terminals**: single-use tickets, idle and length limits, host shells off
  by default behind an operator check, a password re-check and kill switches;
  every session is audited as metadata, never as a transcript
- **DB operations**: idempotent container start; backup and restore through
  arg-array `docker exec` and `docker cp` (no host shell); restore is
  ownership-checked; database passwords stay out of process lists
- **Imports**: tar members are validated before extraction (tar-slip, with a
  bounded gzip expansion); system import rolls back on a mid-flight failure;
  per-service bundles are operator-only
- **Logs**: the request serializer strips query strings
- **Production guards**: the panel refuses to boot with a known-insecure JWT
  secret or a weak master key (checked for `NINEDEPLOY_MASTER_KEY` and every
  version in `NINEDEPLOY_MASTER_KEYS`)
- **Releases**: keyless-signed images with provenance, and checksums signed
  with the same identity that the installer verifies (§13.1)

## 16. Known gaps (implementation vs. intent)

This section has two parts. **§16.0 lists what is still open on November 23,
2026**, each item checked against the code or the current work plan. §16.1 to
§16.19 then keep the findings of the 0.3.5 architecture sweep with their
original scope: each one names the defect, the fix and the release. They are
history, kept because the regression tests that closed them still cite them,
and because the reasoning behind each fix still explains the code.

### 16.0 What is still open — November 23, 2026

Limits that are decided design, not defects:

- **The agent transport has no TLS.** Payloads are sealed and authenticated
  by default, but metadata is visible and there is no forward secrecy (§9,
  §16.6). Agents belong on a private network.
- **WAL is off by design** (§4), which serializes writers behind readers under
  the worker, the collector and the schedulers. The capacity baseline
  ([docs/CAPACITY_BASELINE.md](docs/CAPACITY_BASELINE.md)) measured no
  SQLite busy errors and route p95 values under 60 ms on its workload.
- **Swarm is a stateless deployer.** Volumes, managed databases, host ports,
  fan-out, the restart limit and tunnels are refused there (owner decision of
  2026-11-09; the support matrix states it).
- **PM2 has no blue-green window** — it stops, then starts, with auto-rollback
  on failure.
- **DNS rebinding is not solved** by the egress guard; it validates at resolve
  time only.
- **`GET /v1/services` filters tags in memory** over the visible rows, and
  `visibleDatabaseIds` reads the whole `databases` table. Fine at self-hosted
  scale.

Work that is planned but not implemented, tracked as packages in the
[November 16 work plan](docs/plans/PROJECT_REVIEW_2026-11-16.md):

- Restart behavior for user-visible in-memory state (canary observations,
  idle observations, one-time forward-auth codes) — N07
- Panel sign-in (forward auth) on nodes — N11; the design record is `docs/plans/node-forward-auth.md` and the implementation is open
- Database high availability, major upgrades on nodes and for MongoDB — N12
- Preview database copies only for PostgreSQL and the Redis family on the
  panel host — N13
- GitOps covers projects, services, domains and grants and never deletes;
  recorded Compose releases refuse external inputs — N14
- No application log history across deploys, source maps or traces — N15
- No metrics-only scrape token and no guided credential rotation — N16
- No workspace quotas — N17
- Desktop installers are unsigned and Keychain sign-in is unverified on a
  real Mac; cloud provisioning is not accepted on live provider accounts — N18
- About 54 singleton settings keys are read without a schema — N20
- Deploy by polling Git does not exist; 172 bundled template ids still carry
  the `coolify-` prefix

Acceptance that is still open for published code: public DNS and ACME
issuance in a controlled environment, and the remote PostgreSQL archive drill
on a managed S3 provider. See
[Current status](docs/CURRENT_STATUS.md).

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

**Update, November 23, 2026.** That list has narrowed. Seven sections are fully
wired in `lib/applyManifestToService.ts`, which runs on every successful deploy
and is idempotent: `routes`, `database`, `alerts`, `previews`, `notifications`
and `volume.backups` (the declared retention is noted but not applied, and
notification subscriptions apply only to a service owned by an instance
operator), and `watch` whose paths become the watch-path filter of the
service's active webhooks. `build`, `run`, `resources`, `env.required`,
`runtime` and `phases` are applied by the pipeline as described above. Two
sections are still recognised but not wired, and each says so in the deploy
log: `static` and `network`. `hooks` is still ignored on purpose;
`env.aliases` and `volume.mount` are validated and never read.

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
83 route modules means a new route is covered the day it is added.

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

**Update, November 23, 2026.** The product decision has been made in two
parts, and this section's "still open" paragraph is history:

- `npm`, `git` and `local` sources are still refused
  (`UnsupportedPluginSourceError` in `kernel/pluginLoader.ts`). The static
  catalog still has 16 entries, every one `implemented: false`, and installing
  one is refused with a message naming the built-in feature
  (`UnimplementedPluginError`). A live, ed25519-signed marketplace index can
  be merged over the static list (`lib/marketplaceCatalog.ts`,
  `NINEDEPLOY_MARKETPLACE_URL` and `NINEDEPLOY_MARKETPLACE_PUBLIC_KEY`).
- **Third-party code runs in the sandbox** (`source: 'sandbox'`, the other
  loadable source, since 0.5.0 — `kernel/sandbox/`). A sandboxed plugin
  executes in a worker thread or a Node permission-model child process, never
  in the panel's own realm: its configuration is redacted, it may emit only
  events in its own `plugin.<pluginId>.*` namespace, every hook call has a
  time budget, and it gets no network unless an operator accepts that with
  `NINEDEPLOY_ALLOW_SANDBOX_NETWORK=1` (Doctor reports `sandbox_plugin_network`
  while that is missing).

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

### 16.19 Smaller items — re-verified November 23, 2026

- ~~`DELETE /v1/projects/:id` is scoped to projects the caller can see, but is
  not role-gated the way services and databases are — any seat in the
  workspace can delete a project.~~ **FIXED**: the route now requires the
  `admin` seat in the project's workspace
  (`assertWorkspaceRole(…, 'admin')` in `modules/projects.ts`), like service
  and database deletion (§16.4).
- Migration tag `0020` is skipped (journal-authoritative, cosmetic).
- WAL is off by design (§4) — see §16.0.

## 17. Key design decisions

- **Single SQLite database** — no PostgreSQL, MongoDB or Redis dependency for
  the panel; libsql client on a local file; `foreign_keys = ON`,
  `busy_timeout = 5000`, WAL off for safe single-file backups; hot paths
  indexed
- **Self-migrating server** — startup applies pending SQL migrations via
  Drizzle's runtime migrator, tolerating pre-journal hand-patched columns;
  drizzle-kit stays a devDependency
- **The panel runs bare-metal (systemd) or as a socket-mounted container** —
  PM2 and UFW features need the bare-metal install; the same binary is the
  remote agent
- **Docker CLI, not dockerode** — every engine operation is a validated
  arg-array spawn through one choke point, shared by local and agent
  execution; never a shell string built from input
- **Traefik file provider** — dynamic config regenerated atomically on every
  deploy and domain change, directory-mounted; each node runs its own proxy
  that the panel configures
- **Container-name routing on per-service bridges** — Traefik reaches
  containers by name over `nd-svc-<slug>` bridges; host ports are an explicit,
  gated exception
- **Blue-green (Docker) + rollback (PM2, Compose)** — two versions run side
  by side; PM2 cannot (port conflict), so it auto-rolls back. In-flight
  deploys can be cancelled at every stage checkpoint
- **Typed agent protocol** — remote execution is a fixed operation registry
  with regex-validated operands and per-capability owner switches, sealed by
  default, not arbitrary shell
- **Advertised capabilities decide support** — what a node can do is what its
  agent advertises, never an assumed version; the generated support matrix and
  the capability API come from the same evaluators that refuse a request
- **Durable authority** — every multi-step runtime change is journalled with an
  owner token and an epoch, so a restart resumes or safely aborts it and stale
  work cannot act on a newer runtime
- **Image digest pinning** — each deployment records the exact digest it ran,
  so rollback redeploys that precise image
- **Deployment history is honest** — a superseded build is marked
  `superseded`, not left `running` forever
- **Fire-and-forget notifications** — `audit()` → DB write + event bus +
  notifier, never blocking the request
- **Bounded retention** — metrics: raw 1 day, 5-minute rollups 7 days, hourly
  rollups 1–90 days; deploy logs *and their finished deployment rows* 30 d
  (the live and in-flight rows are never swept); scheduled-job runs 30 d;
  audit 90 d; notification log 30 d; dangling images hourly; databases without
  a policy keep 7 scheduled backups; volume backups keep
  `NINEDEPLOY_BACKUP_VOLUME_RETAIN_COUNT`
- **Forward-only, additive migrations** — no down-SQL; a bad migration leaves
  an unused object rather than losing data
- **New behavior is opt-in or keeps the old default** — installed panels
  update themselves, so every release must upgrade in place without breaking.
  The compact panel layout is the one exception on `main`, and it is unreleased
- **Tiered coverage gates** — 100 % where it is achievable (db, schemas, sdk,
  plugin-sdk), and measured floors for server, web, CLI and MCP, each one
  justified in its config rather than silently ratcheted
- **Documentation that is checked** — the docs index, the environment
  reference, the smoke inventory, the release notes format and the generated
  support matrix are guarded by tests
- **TypeScript strict** — `noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
  `isolatedModules`; Node 22.23.4+, 24.22.1+ or 26.12.1+ (supported majors only)
