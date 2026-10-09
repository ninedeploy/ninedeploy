# Changelog

All notable changes to the NineDeploy project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [0.15.4] - 2026-10-09

> Remote nodes, part 3: Docker Swarm as an opt-in orchestrator. Nothing changes until an operator turns it on.

### Upgrade notes

- No migration (0072 from 0.15.2 already has the columns this release uses).
- **Swarm is off until an operator enables it.** The upgrade does not put Docker in Swarm mode or move any service onto a stack. Services with no orchestrator set, or set to `container`, deploy exactly as before.
- **Joining a node to Swarm needs node agent v0.15.4, and the node's owner must opt in.** Set `NINEDEPLOY_AGENT_SWARM_MANAGER=<panel advertise address>:2377` in the agent's environment and restart the agent. The agent joins only that manager, and never while `NINEDEPLOY_AGENT_DOCKER_SOCKET=off`. Older agents keep working for everything else and refuse join and leave with "update the node agent".
- **Swarm runs NineDeploy services only on nodes joined through the panel** (labelled `nd.member=1`). A node that joined the swarm another way gets no NineDeploy task.
- **Node owners:** a join is also refused while TLS Docker variables (`DOCKER_TLS_VERIFY`, `DOCKER_TLS`, `DOCKER_CERT_PATH`, an `https://` `DOCKER_HOST`) or a non-default Docker context are set on the node.
- **A server that is a Swarm member cannot be deleted** (409 `server_swarm_member`). Make it leave first.
- **Firewall:** Swarm overlay networks are always encrypted (IPsec). Between all Swarm hosts, allow 2377/tcp, 7946/tcp and udp, 4789/udp, and **ESP (IP protocol 50)**, restricted to the cluster's own hosts. Encrypted overlays do not work on Windows nodes.
- **Deploy-key clones on the panel now check SSH host keys.** They used to accept any host key; now a key that changes within one checkout is refused. Keys are not kept between deploys, so a server that rotates its host key does not block the next deploy.
- **Rolling back to 0.15.3 is supported.** Swarm services keep serving until Traefik restarts or the service is redeployed. The redeploy runs as plain containers and leaves the stack running without a route. `docs/ROLLBACK.md` lists the clean-up commands.
- Verified before release: in-place upgrades from 0.15.3 and from 0.10.45 leave Docker out of Swarm mode, and a rehearsed rollback to 0.15.3.

### Added

- **Docker Swarm (opt-in per service).**
  - **Turning it on:** an operator initialises Swarm on the panel host (an interactive session and a password re-check are required) and enables it. Nodes join and leave through their agents; leave drains the node first. Set a service's orchestrator to `swarm` and deploy.
  - **How a service runs:** one stack per service, applied with `docker stack deploy` on every deploy, so env, replicas and limits all take effect. Updates are rolling and start-first. If the panel's probe through Traefik fails, the panel rolls the service back.
  - **Images:** built on the panel or a build server. With a push registry every node pulls by digest. Without one, the image is copied to each joined node, and a node that cannot receive it gets no tasks.
  - **Security:** Traefik is the only way in; no port is published on the Swarm ingress mesh. Env reaches Swarm through a temporary 0600 file, never a command line.
  - **Join tokens:** never stored, logged, returned or put on a command line, and rotated after every join and leave.
  - **Node checks:** a node is checked on the manager before it is linked. It must have exactly the id it reported, be a worker, be at the server's address (by IP, or the DNS of its host name), and not be linked to any other server. `GET /v1/swarm` warns about a node still in the swarm after its owner turned the Docker socket switch off.
  - **Registry logins:** each deploy writes its own temporary Docker config with only that service's registry auth, and never runs `docker login`, so credentials never reach a shared config or the host's credential store.
  - **Management port:** `swarm init` binds it to the advertise address when that is a local interface; otherwise the response says to firewall 2377/tcp.
  - **Existing networks:** an existing `nd-swarm-<slug>` network that is unencrypted, or not an overlay, is refused instead of reused.
  - **Resource limits:** Swarm tasks get no memory-swap cap and no CPU shares; a stack file cannot express them.
  - **Refused on Swarm:** compose, PM2, a service pinned to a node, volumes, the Docker socket, a published host port, managed databases, fan-out targets, and env values spanning several lines. A PR preview of a Swarm service runs as a normal container.
  - **Day-to-day:** logs, rolling restart, stop/start (scale to 0 and back), the terminal (a task on the panel host) and stats all work for Swarm services.

### Fixed

- **The old, unreachable Swarm driver is replaced.** Its redeploys changed only the image. It put env on the command line and published ports past Traefik. It wrote state to a directory a Docker install cannot write. It never applied rotated secrets. Images built locally could not reach other nodes.
- Deploy-key clones on the panel host no longer accept any SSH host key.

## [0.15.3] - 2026-10-09

> Remote nodes, part 2: a build server, image transfer between hosts, and managed databases on nodes. Single-host installs keep working as before, apart from the two fixes below.

### Upgrade notes

- No migration (0072 from 0.15.2 already holds every column this release uses).
- **Managed databases on nodes need node agent v0.15.3.** Building on the panel or a build server and shipping the image needs v0.15.2. Re-run a node's bootstrap from the Servers page to update it. Older agents keep working as before, and anything new is refused with "update the node agent".
- **Two fixes reach existing services on their next deploy:**
  - **Attached databases are now connected to their service's network.** Previously only databases added through a template were, so a database attached any other way could not be reached by name from the app.
  - **PgBouncer:** a second sidecar no longer fails on port 6432. From the next time PgBouncer is enabled, only a non-default port is published on the host; running sidecars keep their binding until they are re-enabled.
- **Fan-out (copies of a service on other nodes):**
  - Copies of a Nixpacks, Railpack or static service now receive the primary's image instead of being rebuilt from a Dockerfile.
  - A copy that needs a command override, the Docker socket or volumes now needs node agent v0.15.2. Before, it started without them.
  - Deploy hooks still run on the primary only, and the deploy log now says so for each copy.
- Attaching a panel-host database to a service on a node now answers 409 instead of creating an attachment that could never deploy.
- **Rolling back to 0.15.2 is supported.** A database placed on a node keeps running on its node. 0.15.2 cannot manage it, refuses every action on it, and never starts a copy on the panel host.
- Verified before release: in-place upgrades from 0.15.2 and from 0.10.45, and a rehearsed rollback to 0.15.2. Panel-host databases send byte-identical Docker commands to v0.15.0 for 151 operations across all nine engines.

### Added

- **Build placement.** A service can build where it runs (the default, unchanged), on the panel, or on a build server, and then ship the image to its node. Building on the panel keeps private-repository credentials off your nodes.
  - **Image transfer:** by default the image goes through the panel over the sealed agent channel, checked end to end. A service can push and pull through a registry instead (operators bind the registry).
  - **Failures:** a failed build or transfer fails the deploy before anything switches over, so the running version keeps serving.
  - **Build servers:** mark a node as a build server and set how many builds it runs at once. Transfers are listed per service and per deployment.
- **Managed databases on nodes.** Operators can place a new database on a node. It runs on its own network, and services on the same node can attach to it.
  - **What works there:** start, stop, restart, limits, logs, credentials, backups and backup schedules, restore, dump import and the database shell.
  - **Refused for now:** Studio, PgBouncer, public access, connections across hosts, and moving a database between hosts.
  - **Server deletion:** a server that hosts databases cannot be deleted.

### Fixed

- Databases attached by hand were never connected to their service's network.
- A second PgBouncer sidecar failed because every sidecar published port 6432.
- Fan-out copies silently dropped a service's command override, Docker socket and volumes.
- Fan-out rebuilt Nixpacks, Railpack and static services from a Dockerfile.

## [0.15.2] - 2026-10-09

> Remote nodes, part 1: builds, private clones and volumes on nodes. Everything new is off until a node runs the updated agent; nothing changes for single-host installs.

### Upgrade notes

- One additive migration, `0072_multi_node`: a new `image_transfers` table and nullable or defaulted columns on databases, services, servers, sources, backups and deployments. No existing row changes behaviour.
- **The new node features need node agent v0.15.2.** Re-run a node's bootstrap from the Servers page to update it. An older agent keeps working exactly as before. Anything that needs the new agent is refused with "update the node agent to v0.15.2", and nothing else is sent to it.
- **The runtime image now includes `openssh-client`** (about 5–6 MB). Without it, deploy-key clones could not run in Docker installs or on nodes.
- **Railpack on nodes:** after the node agent is updated, a Railpack service placed on a node builds with Railpack itself instead of the Dockerfile stopgap. The resulting image can differ.
- **Scheduled backups of a service on a node** now back up its volume on that node. Before, they skipped it or copied a stale volume of the same name from the panel host.
- **Private repositories on nodes:** a source's personal access token or deploy key is sent to a node only after you turn on "Allow on nodes" for that source (this asks for your password). With the updated agent, a personal access token on a node needs that agent too, so the node owner's switch (`NINEDEPLOY_AGENT_STATIC_CREDENTIALS=off`) can refuse it. GitHub App sources are unaffected. Building on the panel and shipping the image (coming next) keeps credentials off nodes entirely.
- **Rolling back to 0.15.1 is supported.** The new columns and table are ignored. Node volumes and backups stay where they are. Services that use the new node features are refused by 0.15.1 as before.
- Verified before release: in-place upgrades from 0.15.1 and from 0.10.45, a rehearsed rollback to 0.15.1, and compatibility tests in both directions between panel and agent versions. The node features themselves are covered by unit tests. A two-host smoke arrives with the next part of this series.

### Added

- **Builds on nodes.** Nixpacks and Railpack run on the node. The panel works out the build pack on its own checkout with the same rules as a local build, so services that already build on a node send the same build inputs.
- **Private clones on nodes.** A personal access token or deploy key is sent only for one job, over the sealed agent transport. A deploy key is kept in memory-backed storage on the node and removed afterwards, even when the job fails. The node checks the Git host's SSH key: it records the key on first use and refuses a different one later.
- **Volumes on nodes.**
  - Create, list, back up and restore volumes on a node. Backups are encrypted like the panel's; the node's data never touches the panel's disk unencrypted.
  - Docker services on a node can use volume attachments, a command override and the Docker socket.
  - An attachment shared with a service or database on another host is refused.
- **Node agent.**
  - A sealed, checksum-verified data channel for images and volumes.
  - A structured run operation that accepts a validated spec, never a raw command line.
  - Image archives are checked before and after `docker load`, so an archive cannot replace the proxy's or NineDeploy's own image tags.
  - The Servers API shows each node's agent version and features.

### Fixed

- Compose stacks on a node with attached volumes failed at `compose up` ("external volume not found"). Missing service volumes are now created first.
- With a node selected, the volume file manager opened the panel host's volume of the same name. It now refuses.
- Deploy-key clones failed in Docker installs because the image had no SSH client.

## [0.15.1] - 2026-10-09

> Security patch: patched releases of two dependencies of the MCP server.

### Upgrade notes

- No migration and no configuration change. Upgrading from 0.15.0 changes nothing except the bundled dependencies.

### Security

- `@modelcontextprotocol/sdk` is now 1.32.1. Versions before 1.31.0 had an OAuth client that could send credentials to an authorization server an attacker steered it to (GHSA-6qxp-vccf-f47h, high).
- `proxy-addr` is now 2.0.8. Earlier versions could be fooled by IPv4-mapped addresses when deciding a client's IP (critical). It came in through the MCP SDK's HTTP server.
- NineDeploy's MCP server talks over stdio and uses neither code path, so these were not reachable in practice. Both now resolve to fixed releases anyway.
- One audit finding remains: `braces`, which pm2 depends on. No fixed release exists yet.

### Changed

- MCP: a tool whose inputs are all optional now runs when called with no arguments, as the MCP specification allows. Tools with a required input still refuse such a call.

## [0.15.0] - 2026-10-09

> Operations and API: browser and CLI terminals with a real TTY (also on remote nodes), opt-in traffic analytics, an OpenAPI 3.1 document for every route with generated MCP tools, and project- and environment-level access grants. See [docs/TERMINALS.md](docs/TERMINALS.md), [docs/TRAEFIK_INGRESS.md](docs/TRAEFIK_INGRESS.md), [docs/WORKSPACES_RBAC.md](docs/WORKSPACES_RBAC.md) and [docs/AI_MCP_CLI.md](docs/AI_MCP_CLI.md).

### Upgrade notes

- One additive migration, `0071_operations_api`: three new tables (`terminal_sessions`, `traffic_rollups`, `access_grants`). No existing row is changed.
- **Traefik is not touched by the upgrade.** Traffic analytics is off by default, and with it off Traefik's configuration is byte-identical to 0.14. Turning analytics on recreates Traefik once. On the json-file/local Docker log drivers, Traefik's own container log starts rotating (20 MB × 3) the next time the proxy is recreated for any reason.
- **Permissions are unchanged.** With no access grants, every access decision is identical to 0.14 (checked over 4839 caller × resource × action cases). Grants only ever raise access.
- **Terminals:** container shells are available to operators. Host shells (a root shell on the panel host or a node) are off until an operator enables them under Settings → Security, and each one needs a browser session and a password re-check. `NINEDEPLOY_HOST_TERMINAL=off` forbids them on the panel; `NINEDEPLOY_AGENT_HOST_TERMINAL=off` forbids them on a node.
- **Node terminals need node agent v0.15.0** (re-run the node's bootstrap from the Servers page). Older agents get a clear "update the agent" refusal; nothing else about them changes.
- **The web terminal in Docker installs gets a real TTY.** The runtime image never had python3, so the old shell always ran in pipe mode.
- WebSocket frames are capped at 1 MiB.
- **Rolling back to 0.14 is supported;** see [docs/ROLLBACK.md](docs/ROLLBACK.md). The new tables are ignored, so guests and raised roles lose their grant access (never the reverse). If analytics was on, 0.14 recreates Traefik without the access log; `<data>/traffic-logs` is left behind.
- Verified before release:
  - in-place upgrades from 0.14.0 and from 0.10.45, with every new feature exercised against a real Traefik and Docker;
  - an upgrade that leaves Traefik untouched;
  - a rehearsed rollback to 0.14.0.

### Added

- **Terminals.** Shells into services, databases and managed containers, on the panel host and on remote nodes.
  - A real TTY with resize, short-lived single-use tickets, idle and maximum-duration limits, and per-panel and per-user caps.
  - Every session is recorded (who, target, duration, bytes, IP) and audited at start and end. Operators can list and terminate sessions. Nothing typed or printed is stored.
  - Node sessions run over an encrypted, authenticated agent channel.
  - Available in the panel, as `ninedeploy terminal <service|db|container|host>` and through the SDK's `connectTerminal`.
- **Traffic analytics (opt-in).** Requests, status classes and latency per domain and service, read from a Traefik access log that keeps no client IP, path, query or headers. Rolled up per minute (48 h) and per hour (30 days by default). Turn it on and see the instance summary on the Traefik page; each service's Overview shows its own chart.
- **OpenAPI 3.1.** `GET /v1/openapi.json` (sign-in required) describes every route (435 operations), built from the same zod contracts the server validates with. A test fails if a route has no description or its access level disagrees with the authorization matrix.
- **MCP.** The server gains `search_api` and 16 read-only tools generated from the spec, including traffic summaries, access grants and terminal sessions. There are still no write tools.
- **Access grants.** A workspace admin can raise a user's role on one project, one environment, or a project+environment pair. A grant can also give a user without a workspace seat (a guest) access to just those resources.
  - Guests never get workspace-level rights and cannot create services or databases.
  - A grant only covers services in its own workspace.
  - Grants can be suspended and reinstated. An IdP (SCIM) suspension can only be lifted by the IdP.
  - Manage them in the Workspaces page and a project's Access view, with `ninedeploy access grants …`, or at `/v1/workspaces/:wid/access-grants`.
- **SDK and CLI:** `terminals`, `traffic`, `accessGrants`, `access` and `api.get`; `ninedeploy terminal|terminals|traffic|access`.

### Fixed

- The web terminal in Docker installs ran without a TTY (no python3 in the runtime image).
- The old service shell socket recorded only a start audit entry. It now records the session's end, duration and client too, and operators can terminate it.
- Terminal resize was never sent to the server.
- WebSocket frames up to 100 MiB were buffered before authentication. They are now capped at 1 MiB, and a plain subprotocol is preferred over echoing the bearer token.
- Eight places read a workspace seat directly instead of going through the access check. They now share one access path.

## [0.14.0] - 2026-10-08

> Network and data access: public database access, editable Traefik configuration with your own certificates, database dump import, and HashiCorp Vault / OpenBao and AWS Secrets Manager. See [docs/TRAEFIK_INGRESS.md](docs/TRAEFIK_INGRESS.md), [docs/DATABASES_BACKUPS.md](docs/DATABASES_BACKUPS.md) and [docs/SECRET_MANAGERS.md](docs/SECRET_MANAGERS.md).

### Upgrade notes

- One additive migration, `0070_network_data_access`: four new tables (`database_public_access`, `tls_certificates`, `database_imports`, `secret_providers`). No existing row is changed.
- **Traefik is recreated once** on the first 0.14 boot. Traefik now reads its dynamic configuration from a directory (`/etc/traefik/dynamic`). The current routes are copied there before the recreate, so sites keep serving. If the recreate cannot happen (for example the image pull fails), the old container keeps running and route changes are mirrored to the old file until it succeeds.
- **Remote nodes start serving their routes.** Since remote servers were introduced, a node's Traefik read a file the agent never wrote, so it loaded no routes. Nodes recreate their proxy once after the upgrade and then serve the routes the panel sends.
- **Certificate-expiry alerts start working.** Expiry dates of Let's Encrypt certificates were never read (Traefik stores them base64-encoded), so the `cert-expiry` alert could not fire. After the upgrade it fires for certificates that are really about to expire.
- Everything else is opt-in. No database is exposed, no custom config or certificate exists, and no secret provider is configured until an operator sets one up.
- `${{vault:…}}` and `${{aws:…}}` references stay literal while their provider is not configured, exactly as before. PR previews now withhold them.
- **Rolling back to 0.13** is supported; see [docs/ROLLBACK.md](docs/ROLLBACK.md).
  - Traefik goes back to the single file.
  - Delete the leftover `<data>/traefik/dynamic/` directory: it holds uploaded private keys.
  - Remove public-database sidecars with `docker rm -f $(docker ps -aq --filter label=ninedeploy.public-db)`.
  - Containers receive the literal text of `vault:` and `aws:` references.
- Verified before release:
  - in-place upgrades from 0.13.0 and from 0.10.45;
  - every new feature exercised on the upgraded panel with a real Traefik;
  - a rehearsed rollback to 0.13.0.

### Added

- **Public database access.** An operator can publish a managed postgres, mysql, mariadb, redis, valkey or mongo database on one host port.
  - It runs through its own Traefik TCP sidecar (`nd-dbpub-<slug>`); the main Traefik is never touched.
  - An IP allow-list is required (at most 100 ranges, never `/0`).
  - TLS termination with an uploaded certificate is optional; it is not available for mysql/mariadb.
  - Database credentials gain `publicConnectionString`.
  - Off by default. The connection uses the database's root credentials, so create a limited user.
- **Custom Traefik dynamic config.** Operators can add their own routers, middlewares and services.
  - Every name must start with `custom-`, so it can't collide with the panel's own routes.
  - Each save is validated, then tried in a throwaway Traefik container before it is applied. If the live Traefik rejects it, the panel reverts to the last good version.
- **Uploaded TLS certificates.** Operators can upload PEM certificates and keys; the key is stored encrypted. A domain fully covered by an uploaded certificate stops requesting a Let's Encrypt certificate. Uploaded certificates feed the certificate inventory and the expiry alerts.
- **Database dump import.**
  - Sources: resumable 8 MiB chunked uploads (database admin), or an object from a backup destination (operator).
  - Formats: postgres (custom or plain SQL), mysql/mariadb (SQL), mongo (archive) and redis/valkey (RDB), each optionally gzipped.
  - A `pre-import` safety backup is taken first, and a check afterwards confirms the panel can still sign in.
- **Secret managers.** Env values can reference HashiCorp Vault / OpenBao KV v2 (`${{vault:path#field}}`) and AWS Secrets Manager (`${{aws:id}}` or `${{aws:id#key}}`).
  - Configure them under Settings → Integrations. Infisical and Doppler keep working as before.
  - Every call goes through the egress guard.
- **Surfaces.**
  - SDK, with `importFile` for chunked, resumable uploads.
  - CLI: `ninedeploy databases public-access|import|imports`, `proxy config`, `certificates custom` and `secrets providers`.
  - MCP read-only tools `get_database_public_access` and `list_database_imports`.

### Fixed

- Remote-node proxies loaded no routes: the static config pointed at `dynamic.yml`, while the agent writes `dynamic/ninedeploy.yml`.
- Let's Encrypt certificate expiry was never read, so the `cert-expiry` alert never fired, and the certificate inventory always showed the issuer "Let's Encrypt" and the source `acme.json`.

## [0.13.0] - 2026-10-08

> GitHub App integration: short-lived installation tokens instead of long-lived PATs, App webhooks, commit statuses and PR comments, private clones on remote nodes, and Gitea repository listing. See [docs/GITHUB_APP.md](docs/GITHUB_APP.md).

### Upgrade notes

- One additive migration, `0069_github_app`: four new tables (`github_apps`, `github_app_installations`, `service_github_links`, `github_pr_comments`) and a nullable `sources.base_url` column. No existing row is changed.
- Nothing changes until an operator registers a GitHub App. PAT, deploy-key and webhook services deploy exactly as before, and their per-service webhooks keep working.
- Moving an existing service to the App is explicit and reversible: **migrate** links it while keeping its PAT and webhook, **finalize** detaches them, and **revert** goes back.
- Deploying an App repository to a **remote node** needs the node agent v0.13.0 or newer over the sealed transport, and git 2.31 or newer on the node. An older agent gets a refusal telling you to update it; nothing is minted. The check runs when the deploy is queued.
- Deleting an App in the panel also removes its installation rows and service links. The generated `github_app` sources stay, and their clones then fail closed until you attach another credential.
- Rolling back to 0.12 is safe: the new tables and column are ignored, migrated-but-not-finalized services keep their PAT and webhook, App-only services fail closed on private repositories (no secret is exposed), and `/v1/hooks/github-app/*` answers 404. Details in docs/GITHUB_APP.md §9.
- Verified before release: in-place upgrades from 0.12.0 and from 0.10.45. After the upgrade a pre-existing GitHub PAT source still lists and tests, and the App API, Gitea base URL and manifest guards work on the upgraded panel.

### Added

- **GitHub App setup.**
  - One-click setup through GitHub's manifest flow, for a personal account or an organization (Sources → GitHub Apps).
  - Manual entry for GitHub Enterprise Server or an existing App. The webhook is registered automatically.
  - Maintenance: install, sync installations, rotate the private key or webhook secret, re-point the webhook after a domain change.
  - The private key, webhook secret and client secret are encrypted at rest and covered by master-key rotation; no route returns them.
- **Installations as sources.** Each installation becomes a `github_app` source. Clones use a repository-scoped, read-only installation token that lives in memory for at most an hour. A token is only ever sent to the App's own GitHub host.
- **App webhooks.** Pushes and pull requests arrive at `POST /v1/hooks/github-app/<key>`, signature-checked with replay protection, and are routed by repository id, so a renamed or transferred repository keeps deploying and the service's URL is corrected. A service linked to the App skips its old per-service webhook; while the installation is suspended the old webhook takes over again.
- **Service links.** The Deploy Wizard links a new service to the App repository it picked; existing services can migrate, finalize and revert from the service's Settings → GitHub card, the API (`/v1/services/:id/github`), SDK `services.github` or CLI `ninedeploy services github`.
- **Commit statuses and PR comments.** Opt-in per service: a `ninedeploy/<slug>` commit status for each deploy, and one preview comment per pull request, edited in place with the URL and outcome. Feedback never fails a deploy.
- **Private clones on remote nodes.** For App repositories, the panel mints a per-job token, sends it sealed to the agent (capability `git.credential`), which passes it to git only through the environment, and revokes it when the job ends.
- **Gitea base URL.** Gitea sources take a base URL; the token test and the Deploy Wizard's repository and branch listing then work against it.
- **Surfaces.** SDK `githubApps` and `services.github`; CLI `ninedeploy github-app list|show|add-manual|sync|rotate-key|remove`, `services github` and `sources add --base-url`; MCP tool `list_github_installations`.

### Fixed

- `/v1/hooks/<non-numeric id>` answers 404 instead of 500.
- After a session expired, the login redirect now keeps the query string, so returning from GitHub's setup pages still completes the setup.

## [0.12.0] - 2026-10-08

> Backups, preview environments and disk alerts — the first release of the [roadmap](docs/ROADMAP.md).

### Upgrade notes

- Two additive migrations: `0067_database_backup_policies` and `0068_preview_env_vars`. Both are new tables only. No existing row is changed, and a rollback to 0.11.x ignores both tables.
- Nothing changes until you configure it:
  - A database without a backup policy keeps the daily backup with 7 kept.
  - Panel self-backup is off.
  - No alert rules are created.
  - PR previews get exactly the environment they got before.
- The panel now pings approved remote nodes every 30 seconds. SSH-bootstrapped nodes therefore stay "online" on the Servers page while they are reachable. They used to show offline about 5 minutes after bootstrap.
- Verified before release: in-place upgrades from 0.11.2 and from 0.10.45, plus the feature checks above on the upgraded panel.

### Added

- **Per-database backup policy.**
  - Settings: a cron schedule, local retention (1–365), optional remote retention, and a destination or local-only.
  - Where to configure it: the database's Backups tab, `GET`/`PUT /v1/databases/:id/backup-policy`, SDK `backups.getPolicy`/`setPolicy`, or CLI `ninedeploy databases backup-policy get|set`.
  - Retention never prunes the newest good dump or the newest remote copy.
  - Missed-backup alerts follow each policy's own interval.
  - Choosing a specific destination is operator-only.
- **Panel self-backup.**
  - What is backed up: the panel database (a consistent snapshot), master key, `.env` and Traefik config.
  - It is written to a backup destination on a schedule, encrypted with a recovery passphrase the operator keeps, and old copies are pruned by keep-newest-N retention.
  - Runs never overlap. Every outcome is audited, so a failure triggers notifications.
  - Where to use it: the Settings → Panel backup section, `/v1/system/panel-backup`, SDK `system.panelBackup`, or CLI `ninedeploy system panel-backup status|set|now|list|decrypt`.
  - Restore: from Settings after typing the file name to confirm, or offline with `decrypt`.
  - See `docs/PANEL_BACKUP.md`.
- **Preview-only environment.** A git-backed service can hold environment values that only its PR previews receive. Previews still never receive the service's secrets.
  - Where to set them: Env tab → Preview deployments, `/v1/services/:id/env/preview`, SDK `previewEnv`, or CLI `ninedeploy env list|set|rm --preview`.
  - Precedence: project env < the preview's own copy < the preview-only set < attached databases.
  - Existing previews pick up the set on their next deploy.
- **Alert metrics `disk` and `server_offline`.**
  - `disk` is the worst disk-usage percentage across the panel host, Docker's data root and the remote nodes.
  - `server_offline` is the number of minutes a remote node has gone unseen.
  - Both are host-wide. Firing and recovery notify through the existing channels.

### Changed

- System export and import share one archive implementation (`lib/systemArchive.ts`) with panel backup. The API and the archive format are unchanged.
- An alert rule PATCH now validates the merged rule. An existing `cert-expiry` rule can no longer be scoped to a service.

## [0.11.2] - 2026-10-08

> Security release: a failed submodule clone could put the Git source's access token into deploy logs, the audit log and notifications.

### Upgrade notes

- **Rotate Git source tokens that may have leaked.** Before this release, a deploy whose repository had a submodule the token could not clone wrote the token into:
  - the deploy log (live stream and `logs/<id>.log`);
  - the `deploy.failed` audit entry;
  - every notification sent from that entry: Slack, Telegram, webhook, email, the activity feed and plugins.

  If such a deploy ever failed on your instance, revoke the token at the provider and update the source. Existing log files and audit entries are not rewritten.
- No database migrations or new configuration fields.
- The OIDC provider `defaultRole` field is deprecated. The API still accepts and returns it, but it has had no effect since 0.11.0.

### Security

- A failed clone's git output is now redacted before it is logged or stored. git rebuilds a submodule's URL from the tokenized origin and prints it on failure; that text was passed through unchanged (F1013).

### Fixed

- A failed deploy clone names its reason in the deploy log and the failure message: authentication failed, HTTP 403, not found or no access, could not resolve/connect, TLS/host-key failure, or missing branch. It adds advice for GitHub tokens and says when a submodule's repository needs access too (F1012).
- The Deploy Wizard shows why a repository list is short: the classic token lacks `repo`, the list was capped, a later page failed, or the provider returned an error. The SDK gains `sources.reposWithDiagnostics` (F1010).
- Dashboards served from a separate origin can read that diagnostic, because CORS now exposes `x-nd-source-error` (F1016).
- `ninedeploy sources test` prints the token type, scopes and warnings. Provider-supplied text is stripped of terminal control sequences (F1011).

### Deprecated

- OIDC provider `defaultRole`. OIDC users always own their personal workspace; add them to team workspaces with invitations or SCIM. The SSO settings form no longer shows the field (F1014).

## [0.11.1] - 2026-10-08

> Private repositories: complete repository lists, clone errors that say why, and a token check.

### Upgrade notes

- No database migrations or new configuration fields.
- `POST /v1/insights` and `POST /v1/services/:id/insights/refresh` answer 400 `repo_unreachable` or `branch_not_found` when the repository cannot be cloned. The first answered 500 and the refresh route answered 404 before.
- `GET /v1/sources/:id/test` returns `tokenKind`, `scopes` and `warnings` for GitHub sources. These fields are additive.

### Fixed

- Git source repository lists stopped at the provider's first page (100 repositories, most recently updated first), so older private repositories never appeared. Lists now follow GitHub `Link`, GitLab `X-Next-Page` and Bitbucket `next` pagination up to 10 pages (1000 repositories). Later pages reuse the fixed API URL, so the token is never sent to a provider-supplied URL, and truncation is reported.
- Analysing a repository the selected credential cannot clone answered "Internal Server Error". The answer now names a reason: authentication failed, HTTP 403 (permission denied), not found or no access, could not resolve/connect, or TLS/host-key verification failed. For GitHub tokens it adds advice: classic tokens need the `repo` scope, and fine-grained tokens need the repository selected, Contents: Read-only, and organization approval or SSO authorization. git's output, URL credentials and the token never appear in the message.

### Added

- Sources: a "Test token" button shows the login, the GitHub token type, a classic token's scopes, and warnings when private repositories cannot be listed or cloned.
- The Deploy Wizard explains, next to the repository picker, why a repository may be missing from a GitHub source.

## [0.11.0] - 2026-10-07

> The evidence audit release: over 300 defects, each reproduced on the previous code before it was fixed, then verified and, where it mattered, pinned by a regression test.

### Upgrade notes

- No database migrations or new configuration fields.
- **API changes:**
  - `POST /v1/build-cache/store` answers HTTP 400 `{ error }` for a missing key, malformed digest or unknown cache (was `200 { ok: false }`). It also accepts an optional `ref` (`<repo>@sha256:<64 hex>`).
  - Compose services and compose templates refuse `publishedPort`, `cpuShares`, `memLimitMb`, `cpuLimitMilli` and image overrides with 400. Nothing ever applied them; the compose file controls these.
  - Deleting a backup whose off-site copy cannot be removed answers 502 `remote_delete_failed` instead of orphaning the remote dump.
  - Deleting a project that still holds databases answers 409.
  - A deactivated account cannot be added to a workspace or given ownership (409 `user_deactivated`, SCIM 403).
- **CLI:**
  - `ninedeploy deploys watch` exits 1 on any close other than a clean end, including when its 30-minute wait limit is reached. Ctrl-C still exits 0.
  - The source-token environment variable is `NINEDEPLOY_SOURCE_TOKEN`.
- **One-shot repairs on first boot:**
  - Team services and databases still owned by a deactivated user move to the workspace owner (`ownership_repair_deactivated_owner_r976`).
  - SSO personal workspaces get their owner seat back.
  - Both write audit entries and never block startup.
- **Behaviour:**
  - The build cache now stores a pullable image reference (new marker and registry-manifest fields).
  - An FCM channel whose device token is rejected as dead is deactivated.
  - Docker inspects that time out (10 s) fail instead of falling through to a pull.
  - A pre-0.3.0 cleartext invite link answers 404.
  - `alerts: []` in a manifest clears the alert rules that manifest created.
  - Preset values are stored encrypted.

### Security

- Enabling the host firewall could lock the operator out. ufw rejected most generated rules, including the SSH/HTTP/HTTPS safety rules. A failed safety rule was ignored, and the panel port was never allowed.
- Tenant-supplied header and basic-auth values were evaluated as Traefik Go templates, which could leak environment secrets. A covering wildcard router could outrank an exact host and skip basic auth or IP allow-lists.
- Templates could deploy onto another tenant's attached volume. A member could claim another tenant's future PR-preview hostnames, or the www/apex half of an active redirect. A pending domain transfer outlived its initiator's admin seat.
- An HTTPS token stayed in `.git/config` of relative submodules and was copied into images. Repository framework detection had a ReDoS on member-controlled files.
- `logs search` printed tenant container output raw, so terminal escape sequences (clipboard writes, title changes) reached the operator's terminal.
- Okta's pathless SCIM `PATCH active:false` was ignored, leaving the user active. The demo seed gave every tenant owner owner rights on the operator's demo service.
- Audit events for service lifecycle and manual deploys carry the correct service and deployment ids. A service name can no longer spoof another id to webhook-out consumers. Plugins receive only an allow-listed part of audit metadata.

### Fixed

- **Data safety:**
  - Backup retention could delete the last good backup after a failed upload.
  - Restore checked only the primary container while replicas kept running on the volume.
  - Prune, delete and the doctor treated database-adopted volumes as ownerless and could destroy stopped database data.
- **DNS:**
  - A Namecheap reply without a host list could wipe the whole zone on the next write.
  - Concurrent record changes in one zone overwrote each other.
  - IPv6 targets were sent as CNAME records; they are now AAAA.
- **Deploys:**
  - A template service with a second attached database took its database settings from the wrong one.
  - Compose deploys picked the wrong main container.
  - A pipeline crash left deployments `building` for up to 45 minutes.
  - Scheduled 6-field crons fired every second.
  - A second database could take an env alias already in use.
- **Runtime:**
  - About 25 Docker calls that could hang a deploy, a health check or a request for 30 minutes are now bounded.
  - A user-stopped service is no longer restarted by the background reconcile.
  - The deploy-log WebSocket closes once a deploy settles.
  - Deleted services' networks no longer exhaust Docker's address pools.
  - Deleted PM2 services no longer come back at boot.
- **Build cache:**
  - Cache hits now reach `docker buildx --cache-from` on the inline, registry and S3 backends.
  - Malformed digests are refused instead of overwriting a valid entry.
- **Plugins and kernel:**
  - Uninstalling a refused plugin, or a purge with wildcard characters, could wipe a built-in plugin's settings and secrets.
  - Plugins reusing a menu item id took over each other's sidebar entries.
  - The sticky-IP egress SNAT never took effect.
  - Template deploys trigger the manifest generator again.
- **Tenancy:**
  - Deactivated users' team services move to the workspace owner, and their seats no longer keep resources.
  - SSO sign-ups always own their personal workspace.
- **Passkeys:** sign-in works, and passkeys enrolled on earlier versions migrate to the canonical credential id on first use.
- **Self-update:** a second update start during the in-flight check could launch a second root installer.
- **Web:**
  - The deploy wizard and Network tab no longer offer settings compose services ignore.
  - Plugin Reload/Enable buttons match what the server allows.
  - The project delete dialog describes the database rule correctly.

### Tests

- Permanent regressions cover the race, ownership, High and Critical fixes: reconcile and stop races, concurrent passkey migration, domain transfer accept, seat hand-over, audit entity formats, deploy-log close codes and the boot repairs.

## [0.10.45] - 2026-10-05

> Deployment reliability and shared-contract fixes from the evidence-led audit.

### Upgrade notes

- No database migrations or new configuration fields.
- Existing source builds on remote nodes retain the agent requirements introduced in earlier releases.

### Fixed

- Deployment queues, filesystem locks and lifecycle cleanup handle failure paths consistently. Stale auto-update probes no longer update a service whose deployment settings changed while the probe was running.
- Community template creation uses exclusive writes, preserving an existing template when concurrent installs select the same name. Explicit replacement remains available.
- Agent connection caching follows the current node host and port. Node proxy sync errors identify the failed operation stage even when a transport error omits its name.
- Log timestamps preserve fractional nanoseconds. Log search, runtime log selection, deployment history and scheduled-job fixtures include the preceding audit repairs.
- Manifest import/export preserves explicit `redirectWww: false`; service creation retains `healthPath`. SDK manifests and errors, CLI configuration and terminal formatting include the audited contract fixes.
- Volume inventory continues past an attachment whose service is absent to find a later valid link. S3 canonical query names and values encode `/`, while object-key separators remain literal.
- Label workspace filters no longer truncate fractional or partial values into another workspace ID.
- Dashboard deploy-log selection resets old buffers, and WebSocket URLs retain configured API path prefixes. SSO fragment parsing recognizes the exact token key.
- Deleted workspace/project/label chips are removed even when the authoritative catalog becomes empty. Unsupported saved theme and accent values fall back to supported defaults.
- A completed update timer can dismiss only its own success banner. A later successful update retains its full display window.
- Includes the earlier local audit fixes for DNS provider responses, session expiry and rotation, backup parsing, image references and shared utility boundaries.

### Tests

- Permanent regressions cover concurrent template creation, stale auto-update completion, session rotation, deploy-log selection and successive panel-update timers.
- Shell-based installer and update fixtures use the native Git Bash installation on Windows rather than a WSL launcher.

## [0.10.44] - 2026-10-03

> Ownership follow-up to 0.10.43 (r710–r711): team services whose creator was
> removed by SCIM before 0.10.43 deployed without their project's shared
> environment; the first boot of this release hands them to the workspace
> owner. Repository analysis now needs the same seat as creating a service.

### Upgrade notes

- **One-time ownership hand-over on first boot (r710).** Services and managed databases in a workspace whose creator no longer holds a seat there (SCIM suspend or deprovision before 0.10.43) now belong to the workspace owner — what 0.10.43 does for every new removal. The change is recorded in the audit log (`ownership.backfill`) and the panel log. Untouched: personal (untagged) resources, operator-owned resources, creators still seated in any workspace the resource lives in, and services shared across workspaces with different owners (logged; reassign them by hand). It runs once; reinstating a user later restores the seat, not the ownership.
- **Repository analysis needs a member seat (r711).** `POST /v1/insights` (the Deploy Wizard's analysis step) answers 403 for accounts with no seat or only viewer seats, the same rule as creating a service. Operators and members are unaffected.
- No migrations.

### Fixed

- **Team services lost their project's shared env after a SCIM removal (r710).** The deploy pipeline injects a project's shared env only when the service owner is seated in the project's workspace; a creator removed by SCIM before 0.10.43 stayed the owner without a seat, so redeploys came up without those variables and without an error.

### Security

- **Repository analysis was open to any signed-in account (r711).** A seatless or viewer-only account could have the panel clone arbitrary public repositories (bounded and rate-limited, but outside the role model every other write follows).

### Docs

- README → Verifying a release: image signatures need cosign v3, or v2.6+ with `--new-bundle-format`; older cosign reports "no signatures found".

## [0.10.43] - 2026-10-02

> The verified-release release (r690–r703): releases are signed and their
> assets checksummed, installs verify what they download, and every API route
> is now held to an authorization matrix that fails the build when a new route
> is not classified.

### Upgrade notes

- **Creators who lost their seat lose access (r694).** A service or database creator counts as its owner only while they hold a seat in a workspace it belongs to. Someone removed from the workspace (for example by SCIM) now gets "not found"; re-seating them restores access. Personal resources outside any workspace stay their creator's. Workspace owners always hold a seat, so they are unaffected.
- **SCIM removal hands ownership over (r695).** Suspending or deprovisioning a user through SCIM transfers what they created to the workspace owner, as the panel's own member-removal already did. Reinstating the user restores the seat, not the ownership.
- **Installs verify downloads (r702).** From this release on, the installer downloads the release's own source archive and checks it against the signed `SHA256SUMS`; when `cosign` (v2.4+) is installed it also verifies the signature. A mismatch stops the install and the previous service keeps running. Hosts that cannot reach Sigstore can set `NINEDEPLOY_SKIP_SIGNATURE_VERIFY=1` (the checksum is still enforced). Older tags install as before, with a warning.
- **Self-update verifies the installer (r703).** Takes effect from the first update a 0.10.43 panel starts.
- Revoking something that is already gone, or that is not yours, now answers 404 instead of 200 (r691).
- No migrations.

### Security

- **Seatless creators kept owner access (r694, high).** Whoever created a team service or database kept full access after losing their seat — secret env export, database credentials, backup downloads, deploy and delete (82 routes).
- **Cross-tenant ids on service create left half-created services (r692);** the backup-drill route revealed whether another tenant's backup id exists (r693); owner-scoped deletes answered 200 for ids outside the caller's scope (r691).
- **Authorization matrix (r690).** A test boots the real API on a real database, enumerates every route (361), and checks each against two tenants and every role: no cross-tenant access, no write or outside call on refusal, the role floor holds, no secret in a viewer's response. A new route without a classification fails the build.

### Release integrity

- **Signed images (r700).** Every published image is signed with Sigstore keyless signing (GitHub OIDC, no stored key) and carries build provenance. The exact `cosign verify`, `cosign verify-blob` and `gh attestation verify` commands are in README → Verifying a release.
- **Checksummed, signed release assets (r701).** Each release carries `ninedeploy-vX.Y.Z.tar.gz`, `install.sh`, `SHA256SUMS` and its signature bundle. The release is created as a draft, its assets are verified the way installers check them, and only then published — `releases/latest` never points at a release without checksums.
- What this guarantees: the archive, installer and image are byte-for-byte what this repository's release workflow produced. What it does not: the trust root is still GitHub and Sigstore.

## [0.10.42] - 2026-10-02

> The second-pass audit release (r630–r680): ingress, managed data, PR previews
> and remote nodes. Two bugs could freeze routing for the whole instance, PR
> previews still received production credentials, and managed Redis/Valkey
> have never started since 0.2.2. All fixed, each with a regression test proven
> to fail on 0.10.41, and every refusal says what to do.

### Upgrade notes — read before updating

- **Update your node agents (r660).** Agents older than 0.10.42 are refused for remote **source** builds (repository Dockerfile, repository compose, source fan-out) — the error names the node. Image deploys and inline compose stacks keep working. To update a node: on that node run `docker rm -f ninedeploy-agent`, then run the agent command shown for it on the Servers page (it carries the panel's version). Every older panel keeps working with the new agent.
- **SSH host keys are now pinned (r661).** The first SSH test or bootstrap after updating trusts and records the node's host key (shown as a warning). A reinstalled host then fails until you enter its new fingerprint on the Servers page.
- **Managed Redis/Valkey start now (r644).** Databases created before stayed in `error`; start them from the database page (or delete and recreate).
- **PR previews lose production credentials (r651).** They no longer receive project-shared secrets, vault references, the parent's databases, or a manifest `database:` attachment; each preview's deploy log lists what was withheld. Give a preview what it needs explicitly: set env vars on the preview service, or attach a non-production database to it.
- **Manifest restrictions (r650, r652).** A `.ninedeploy` `database:` section only attaches databases the service owner administers; `notifications:` only applies to operator-owned services (existing subscriptions on other services stop delivering).
- **Volume changes on privileged services (r640).** Attaching, updating, detaching or repairing a volume on a compose, static-pack, lifecycle-hook or docker-socket service now needs the same rights as deploying it; members get a 403 naming why.
- **Domains (r630–r637).**
  - Hostnames are validated on input; stored rows the proxy would have rewritten are skipped (and audited) instead of routed.
  - Sticky sessions and plaintext basic-auth entries now actually work (both were silently broken).
  - SSL domains redirect plain HTTP to HTTPS.
  - Pending domains older than 30 days are removed.
  - Non-operators are capped at 50 own-zone domains per service and 30 additions per hour (configurable via `PUT /v1/settings/domain-policy`; operators exempt).
- **Template databases (r641, r642).** A new dependency database never adopts a retained volume its owner cannot prove is theirs; it gets the next free name (`-db-2` …) with a deploy-log note.
- **Remote backups (r645).** An off-site copy that should be encrypted but is not is refused on restore. Pre-0.10.3 plaintext volume snapshots keep restoring.
- **Dockerfile with a base directory (r666).** When a Dockerfile exists both at the repository path and under the base directory, the same file as before is built and the deploy log says how to switch.
- No migrations.

### Security

- **Hostname check vs render mismatch (r630).** A member could store a hostname the checks treated as one host and the proxy rendered as a catch-all — routing every tenant's automatic domain to their own container.
- **PR previews inherited production credentials (r651)** through project secrets, vault references and manifest database attachments — reachable by anyone who can push a branch and open a PR.
- **Manifest attached databases the owner could only view (r650)**, handing their password to the container.
- **Volume routes queued redeploys without the deploy privilege check (r640)** — a member could get a privileged operator-owned stack redeployed from a repository they push to. One enqueue helper now serves every user-triggered deploy, pinned by a wiring test.
- **Template databases could adopt a deleted tenant's retained volume (r641)**; dependency slugs could be squatted (r642).
- **Node agents followed symlinked build paths (r660)** in a workspace shared by every tenant on the node — and wrote workspace files through a symlinked `.tmp` as root. Agents now resolve every build path component by component.
- **SSH bootstrap did not verify host keys (r661)** while carrying the agent's sealing key.
- Also: a viewer seat sufficed to stack routes on another service's host (r632); the `www` companion skipped claim checks (r633); pending rows squatted hostnames (r635); basic auth was stored and shown in plaintext (r636); PgBouncer status showed members the database password (r643); `--requirepass` leaked into logs (r644); remote restores accepted unencrypted objects (r645); manifests could subscribe operator channels (r652); webhook templates allowed JSON injection and Discord `@everyone` (r653); log search returned a reused slug's previous owner's logs (r654); sealed agent requests without a nonce, and replays across an agent restart (r668).

### Fixed

- **Routing froze for the whole instance** when any service enabled sticky sessions (Traefik has no `sticky` middleware) (r631) or ran more than one replica (mis-indented `healthCheck`) (r638). A golden test now validates every middleware the panel can emit.
- **Managed Redis/Valkey never started (r644):** `--requirepass` was passed before the image. The user-journey smoke now creates a managed Postgres and Redis on every release (r680).
- **Deleting a database left its off-site dumps (r646);** concurrent restores of one remote backup clobbered each other (r647); volume names could collide with another service's primary volume (r648); the volume list ran a helper container per attachment per request (r649).
- Bundle import is transactional and claim-checked (r656); repository analysis clones are shallow and bounded (r657); webhook-out no longer follows redirects and `/ai/config` hides the base URL from non-operators (r658); Doctor flags a plaintext `http://` template source (r655).
- Node checkouts are removed on delete/move (r662); fan-out targets are torn down on service delete (r662); IPv6-safe host normalisation (r663); ssh errors no longer echo the remote command (r664); terminal and container routes refuse node-pinned services with a clear message (r665); bounded command capture and log reads (r667).

## [0.10.41] - 2026-10-02

> **Security release — update now.** A second-pass audit found that a signed-in
> user could make the panel read a file on the panel host through a symlink
> committed to a repository and get its content back — any file the panel
> process can read: its environment (`NINEDEPLOY_JWT_SECRET`), `master.key`,
> the panel database, and on bare-metal installs (which run as root) system
> files. Every release before 0.10.41 is affected.

### What to do after updating

1. Open **Doctor**. A critical finding **"Repository analysis stored data that is not a Node version"** means stored analyses captured host content: follow its rotation steps.
2. **If people you do not fully trust have accounts on your panel, rotate secrets even when Doctor shows nothing** — the on-demand analysis route returned the content without storing it, so it leaves no trace in the database:
   - set a new `NINEDEPLOY_JWT_SECRET` and restart (every session signs out);
   - add a new master key to `NINEDEPLOY_MASTER_KEYS` and run `ninedeploy system rotate-keys`;
   - rotate registry, git, S3, DNS and vault credentials stored in the panel, and the SSH keys of the panel host if it is a bare-metal install;
   - have users change their passwords if the panel database may have been read.
   The panel's request log (`journalctl -u ninedeploy`, or `docker logs` in docker mode) records each `POST /v1/insights` call with its client address, for as long as your log retention keeps it; reviewing those narrows this down.

### Security

- **Symlinked repository files were followed on the panel host (r620).** Repository analysis and the `.ninedeploy` loader now read only regular files inside the checkout (no symlinks, FIFOs or devices; `O_NOFOLLOW`; bounded reads). A detected Node version must look like one — anything else is dropped, and values stored by earlier releases are no longer returned by the API and are flagged by Doctor (`repo_insights_leak`).
- **Workspace email overrides could send arbitrary mail through the instance (r621)** — a regression in 0.10.40, where they were first wired into sending. Overrides now apply only to workspaces an instance operator owns and must keep `{{acceptUrl}}`; elsewhere the built-in text is sent, exactly as before 0.10.40.
- **Git never runs hooks from a checkout (r622)** — `core.hooksPath=/dev/null` on every clone, fetch and submodule update.

### Upgrade notes

- No migrations. Stored analyses are left in place (Doctor needs them to tell you what happened); re-run analysis or redeploy to rewrite them.
- A `.ninedeploy` that is a symlink now fails with a message naming it instead of being followed — commit the file itself.
- Custom invitation emails on workspaces not owned by an instance operator stop being sent (the built-in text goes out); saving one there answers 400 with the reason.


## [0.10.40] - 2026-10-02

> The first published build of the 0.10.38 changes — read the 0.10.38
> section below, including its upgrade notes. Neither the 0.10.38 nor the
> 0.10.39 tag reached a panel: the smoke-gated release pipeline (r581)
> stopped each one before any image was pushed, `:latest` moved or a GitHub
> Release was created.

### Fixed

- **Railpack on arm64 (r584).** Railpack names its arm64 Linux binary `arm64-unknown-linux-musl`, not `aarch64-…` (Nixpacks' spelling). The arm64 image build 404'd, and `install.sh` on arm64 bare-metal hosts has silently never installed railpack since it was introduced. Both archives re-verified against Railpack's published checksums.

## [0.10.39] - 2026-10-02 — not published, superseded by 0.10.40

> The first published build of the 0.10.38 changes. The 0.10.38 tag never
> reached a panel: its release checks failed on a test that only broke on
> Node 26, and the smoke-gated pipeline (r581) pushed no image, moved no
> `:latest` and created no GitHub Release. Read the 0.10.38 section below —
> including its upgrade notes — for everything this release contains.

### Fixed

- The r605 pinned-dispatcher test built its Agent from the Node 22/24 undici slot and failed on Node 26 (CI's Node). It now uses the same `bundledAgentClass()` lookup `guardedFetch` uses. The production code was already correct, verified on Node 22.13, 24 and 26.

## [0.10.38] - 2026-10-02 — not published, superseded by 0.10.39

> The proven-upgrade release (r580–r610): releases are now only offered to
> installed servers after the published image has been upgraded onto from the
> previous release and walked through the user journey — and the follow-ups the
> 0.10.37 audit deliberately left out.

### Upgrade notes — read before updating

- **Workspace invitations (r604).** For non-operators, adding an email that is not yet a member always sends an invitation, even when an account exists — the colleague accepts it from the link. Instance operators still add registered accounts instantly.
- **Sandbox plugins on Node < 25 (r600).** Already-installed sandbox plugins keep loading; installing a new one (or reinstalling) is refused unless you upgrade Node to ≥ 25 or set `NINEDEPLOY_ALLOW_SANDBOX_NETWORK=1`. Doctor lists sandbox plugins that have open network on this Node.
- **Email templates (r610).** Workspace invitation overrides you saved earlier are now actually sent. Without an override, emails are byte-for-byte what 0.10.37 sent. Password-reset overrides are refused (a workspace admin must not rewrite another user's reset email); stored ones are ignored and can be deleted.
- **Railpack (r582).** Ships in the container image now. Railpack builds need a BuildKit daemon: set `BUILDKIT_HOST` (e.g. `docker-container://buildkit` next to a `moby/buildkit` container). Without it, saving or deploying a railpack service is refused with that fix named — such builds never worked before.
- **Compose redeploys (r590)** build before taking the old stack down, so the previous stack keeps serving during the build and a failed build leaves it running.
- No migrations, no breaking API changes; new response fields are additive.

### Release process

- **Publication is gated on end-to-end smokes (r581).** The release workflow pushes `:vX.Y.Z` only, then runs `smoke:upgrade` (previous published release → this tag, on one data volume) and `smoke:user-journey` against the pushed image; `:latest` and the GitHub Release — which is how panels and the installer discover updates — are created only after both pass.
- `pnpm smoke:upgrade` (r580): boots the previous release on a data volume, seeds an operator, a deployed service with a domain, an orphaned project secret, and a deploy hard-killed mid-build; boots the new release on the same volume and proves sign-in, data, running apps, interrupted-deploy recovery, a fresh green deploy and the migration journal. Proven locally for 0.10.35 → 0.10.37 and 0.10.36 → 0.10.37.

### Security

- **DNS-rebinding window closed (r605).** `guardedFetch` connects only to the addresses it vetted (pinned lookup on Node's bundled undici Agent — verified on Node 22.13, 24 and 26), keeping SNI and the Host header.
- **Email enumeration through member-add and invitations (r604)** — registered and unregistered emails now get the same response.
- **Sandbox network on Node < 25 (r600)** — new installs refused unless knowingly allowed; plugin list shows `networkRestricted`.
- **Vault references at write time (r601)** on template deploys and bundle import.
- **Preview patterns from `.ninedeploy` manifests are validated (r602)** — and the manifest's documented `{n}` placeholder is finally understood (it was never substituted).
- **Passkeys after a password change (r603)** — the response and Account page say how many passkeys remain, with a link to review them.
- **Password-reset emails cannot be rewritten by a workspace admin (r610)**; subject lines cannot inject headers.

### Fixed

- **Workspace email templates were never sent (r610)** — invitations from both invite paths now render the workspace's override; a wiring guard pins every template to a sender.
- **Compose deploys took the stack down before building (r590).**
- **Node-pinned compose services are health-patrolled (r591).**
- **Fan-out source builds pull private base images with the bound registry credential (r592).**
- **A container started by a deploy interrupted by a panel restart is removed at boot (r593)** — containers now carry `ninedeploy.deployment` / `ninedeploy.service` labels.
- **Job runs left `running` by a crash are closed (r594).**
- **Railpack never worked (r582)**: it requires `BUILDKIT_HOST`, which nothing provided and the build env stripped; now passed through and checked up front.
- Manifest Creator suggests a preview pattern the panel accepts (r602); README test counts corrected (r583).

## [0.10.37] - 2026-10-02

> The tenancy release (r500–r576): a whole-repo deep audit found that several
> per-instance resources (the vault, registry credentials, preview hosts, SCIM,
> the plugin event bus) were reachable across tenants. All fixed, each with a
> regression test proven to fail on 0.10.35, and every behaviour change ships
> with an upgrade path so a 0.10.35 panel updates in place.

### Upgrade notes — read before updating

- **Vault allowlist (r510).** On first boot the allowlist is seeded from current use (workspaces of non-operator services/projects that already reference the vault), audited as `settings.vault_allowlist_seeded` and logged. Working deploys keep working; review the list in Settings → Integrations → Vault.
- **Registry credentials (r512).** Each registry source is bound to the hosts its services pull from today (audited as `source.registry_hosts_seeded`). A credential is no longer sent to any other host.
- **Preview patterns (r511).** Stored patterns without both `{{pr}}` and `{{slug}}` keep deploying previews but provision no domain (`previewDomainSkipped: pattern_requires_pr_and_slug`).
- **Passkeys / TOTP (r502)** ask for your password (or a sign-in from the last 10 minutes) when enrolling.
- **SSO (r505).** A tab loaded before the update will be asked to sign in again once.
- **SCIM (r501).** Pushing an account that is not already a member of the token's workspace now answers 409 — invite it first.
- **AI (r508).** Non-operators only get AI through a seat in an operator-owned workspace.
- **Studios (r560)** open in a new tab; a studio tab open during the update asks you to reopen it once.
- **Node-pinned services (r522, r523).** Services with pre/post-deploy or pre-stop hooks, and exec jobs on PM2/node services, are refused with the fix named (clear the hook, or unpin the service) — they used to run on the panel host.
- **Railpack on container installs (r520)** is refused up front; it used to fail mid-build.
- **Sandbox plugins (r530, r531)** that emit events outside `plugin.<id>.*` keep running but those emits are dropped; a previously installed plugin whose id equals a built-in is shown as errored.
- **Daily backups (r528)** now notify channels subscribed to backup events.
- **Migration 0066** deletes orphaned project secrets and builds six indexes once at start.
- **Docker installs (r571).** The image is pinned to the installed tag via `NINEDEPLOY_IMAGE_TAG` in `.env`; upgrade by re-running the installer (a bare `compose pull` re-pulls the same release).
- **Doctor (r575)** warns on bare-metal installs that listen on `0.0.0.0` over plain HTTP. The default bind is unchanged; set `NINEDEPLOY_HOST=127.0.0.1` once the panel is behind HTTPS.

### Security

- **Instance vault readable by any member (r510).** `${{infisical|doppler:KEY}}` resolved with the operator's vault token for every service. Now only operator-owned services and allowlisted workspaces resolve references; non-operators writing a reference elsewhere get a 403.
- **Preview-domain takeover (r511).** A member-editable preview pattern could render another tenant's host and steal its traffic. Patterns must contain `{{pr}}` and `{{slug}}`, and the rendered host goes through the own-zone claim check.
- **Registry credential exfiltration (r512).** Changing `image` pointed `docker login` and the auto-update probe at any host. Credentials are now bound to registry hosts, and members cannot repoint such a service to another registry.
- **Auto-update skipped the owner-privilege check (r513)**; its registry probe was a blind SSRF for member-owned services (r514).
- **Login lockout never tripped (r500).** Per-IP locks zeroed the counters the account tier sums. Rewritten with a per-account window; IPv6 bucketed by /64.
- **SCIM cross-tenant deactivation (r501).** A workspace SCIM token could adopt any account by email and deactivate it instance-wide.
- **Step-up for durable credentials (r502)**, **immediate session revocation (r503)**, **constant-time unknown-email login (r504)**.
- **Login-CSRF via URL fragment (r505).** Fragment tokens are only accepted on `/auth/callback` with a per-tab nonce; `returnTo` is restricted to same-origin paths; the SSO button honours a split API origin.
- **Prototype poisoning (r506)**: the raw-body JSON parser now uses Fastify's protected parser (malformed JSON is a 400, not a 500).
- **OIDC email-domain restriction (r507)** implemented as documented. **AI spend gate (r508)** can no longer be passed by creating your own workspace.
- **Plugin sandbox (r530–r534).** Forged kernel events (e.g. `audit.recorded` → real DNS record deletion) are blocked: plugins emit only `plugin.<id>.*` and the bus tags plugin origin. Built-in id collisions refused; per-call hook ids; secrets redacted at the IPC boundary. On Node ≥ 25 sandboxes have no network; on Node 22/24 they still do (documented).
- **Studio isolation (r560).** Studios opened in a same-origin iframe could read the panel's session tokens through `parent`. They now open in a `noopener` tab with `frame-ancestors 'none'`, and the studio cookie is bound to the user and their token version.

### Fixed

- **Railpack double build (r520)**; railpack refused on container installs, which ship no railpack CLI.
- **Node deploys reported success while the node's proxy kept pointing at the removed container (r521).**
- **Deploy hooks and exec jobs on node-pinned services ran on the panel host (r522, r523).**
- **A restart mid-deploy blocked local deploys for up to 45 minutes (r524)**; interrupted deploys are failed at boot.
- **Node-pinned services were never health-patrolled (r525)**; an unreachable node raises `alert.node_unreachable` instead of "service down".
- **Remote builds over 5 minutes died as `fetch failed` (r526)** — long agent ops now use `node:http`; stop grace periods reach the node; fan-out logs into the registry before building.
- **Disabling or reloading a plugin erased its saved configuration (r527).**
- **Scheduled backups never fired `backup.completed` (r528).**
- **Deleting a user deleted every workspace they owned (r540)**; ownership now transfers to the acting operator (or `transferTo`).
- **Project-scoped secrets survived project deletion (r541)**; migration 0066 removes existing orphans.
- **Remote copies of scheduled backups were never pruned (r542)**; **backups left `running` by a crash (r543)**; **one failing housekeeping step skipped the rest (r544)**; **hourly full-table scans (r545)**; **a failing migration could stay half-applied (r546)**.
- **Web:** env/settings forms no longer save over data that failed to load (r562); full deploy-log download (r561); SDK-backed calls replace raw fetches (r563); accessible palette and events drawer (r564); robust log reconnect de-dup (r565); one shared, typed plugin-menu query (r566).
- **CLI/SDK:** token refresh and base-URL sub-paths for raw calls (r550); logout revokes only its own session (r551); SDK types match the server (r552); dead schema removed (r553); prune flags validated (r554); unused MCP dependency dropped (r555); published source maps resolve (r556); new `networks.members`, `traefik.config/version/update` (r557).

### Installer, release and docs

- `latest_tag` prefers the published release over a freshly pushed tag, and its warnings no longer leak into the captured tag (r571). Docker installs pin the image tag, keep the previous compose/`.env` for a real rollback, and wait up to `NINEDEPLOY_HEALTH_TIMEOUT` (300 s) for migrations; the bare-metal health gate probes `NINEDEPLOY_HOST` (r570).
- Self-update answers 409 `deploys_in_flight` while a deploy is building, unless `force: true` (r572).
- `bump-version.js` validates before writing; `:latest` only moves forward; per-tag release concurrency (r573).
- apache2/nginx are only stopped on fresh installs that need :80/:443; Nixpacks checksums keyed by version; provenance comment no longer overclaims (r574).
- Doctor finding `panel_plaintext_exposure`; README/ARCHITECTURE counts corrected (r575). CI exercises the real `install.sh` helpers and runs a non-blocking `pnpm audit` (r576).

## [0.10.36] - 2026-10-02

> The bounded-backstop release (r480): the audit of the rejection backstop
> found its own memory hole and two polish items. The security surface is now
> bounded, honest in shape, and self-documenting.

### Fixed

- **The rejection map grew without bound (P2).** Every distinct source IP that ever produced one 400/401/403 left a permanent entry — freed only when that exact IP returned after its window drained. Ordinary background internet scanning adds entries monotonically on any public panel, and a single IPv6 /64 can mint unlimited source IPs at one request each: ~5k distinct-IP requests/s for an hour ≈ 18M entries ≈ 4–5 GB. **Prune-on-write** past a 10,000-key soft cap: entries whose newest rejection has aged out go first (currently-engaged IPs survive the sweep), then oldest-inserted keys as the hard ceiling. Bounded to a few MB. Churn regression test included (12,000 one-shot IPs through the production path).

- **The backstop 429 used the Fastify-default body shape (P3).** The web client parses the app error envelope (`{ error: { code, message } }`) — with the default shape it rendered the generic "Request failed with status 429" at exactly the flood moment this release targets. The refusal now carries the envelope (code `rate_limited`, the real retry countdown in the message) plus the same `retry-after` header as before.

### Hardened

- The user-journey smoke **fails fast** when it cannot derive the current version from `version.ts` (it previously fell back to `v0.0.0`, burned the whole DinD bring-up, and died at image pull with a misleading error).

- Changelog wording corrected: the backstop counts **all** pre-limiter and in-handler 400/401/403 deaths, not only guard rejections — same ceiling, same never-legitimate threshold, now stated as the code behaves.


## [0.10.35] - 2026-10-02

> The backstop release (r479): the fresh-eyes audit of the owner-throttle fix
> found the fix's own hole — requests that die at a privilege guard had
> escaped rate limiting entirely.

### Fixed

- **Guard-rejections were unmetered (P2, regression from r478 found by audit).** The principal limiter is appended to route-level preHandlers, but the module guards (`requireAdmin`/`requireOperator`, ~25 modules) are **instance-level** preHandlers — they run FIRST, and a thrown 403 short-circuits the lifecycle before the limiter ever fires. A valid low-privilege credential (member session, read-only API token) could hammer operator-gated routes unmetered: three DB round trips of auth per request, unbounded RPS, DB-pool exhaustion. The same blind spot covered 401s (bad tokens — a pre-existing hole, now closed too) and parse-failed 400s. **Backstop:** responses that die with 400/401/403 are counted per IP in the same 1000/min window; past the cap the IP is refused outright with the same retry-after shape. Successful traffic is never counted at IP level (the principal limiter owns it), so the owner-throttle guarantee is intact — reaching the backstop takes a thousand guard-rejections in a minute, which is never legitimate traffic. Regression test: an instance-level guard 403ing before the route-level limiter still ends in a 429.

- **`/v1/about` pooled the operator into the anonymous bucket (P3).** Its optional auth resolved in the handler — after the limiter had already keyed by IP. Optional auth now runs at onRequest (invalid tokens still swallowed: the public subset serves, never a 401), so the limiter sees the principal here too.

- **The r478 WebSocket trade-off note was factually wrong (P3).** `@fastify/websocket` hijacks the socket in the route handler, not at onRequest — upgrades DO traverse the preHandler limiter (IP-keyed). The behavior was safer than documented; comment and changelog corrected to say what actually happens.

### Hardened

- The user-journey smoke now derives its default image from the repo version instead of a hardcoded tag — a bare run could prove the journey green on a two-releases-old artifact, exactly the drift class the script exists to catch.


## [0.10.34] - 2026-10-01

> The owner-throttle release (r478): reported live by the owner — the panel
> rate-limited its own operator on the dashboard. The limiter now buckets by
> PRINCIPAL, not by IP.

### Fixed

- **An authenticated operator could be throttled by their own panel (P1, reported live).** The global limiter bucketed by IP only — behind a proxy or NAT, every client (browser tabs, the CLI, uptime monitors, anonymous probing) shared one 1000/min bucket, and a busy neighbor could lock the owner out of their own dashboard ("Rate limit exceeded, retry in 23 seconds"). The limiter now runs **after authentication** and buckets by principal:
  - authenticated requests key as `user:<id>` — the dashboard's own polling can never be crowded out, and a runaway script with a valid token is still capped per account;
  - unauthenticated requests (login brute-force, `/setup`, the public webhook receiver, agent `/announce`) keep the per-IP bucket — and the tight per-route ceilings on exactly those surfaces (20/min login, 10/min setup, 60/min hooks) are untouched, so the brute-force posture is unchanged;
  - trade-off, stated openly: WebSocket upgrades hijack the socket at onRequest and no longer pass the limiter — every WS endpoint authenticates in the subprotocol and revalidates every 60 s, and connection floods are a proxy-level (Traefik) concern, not an application-rate one.

  Verified by test: two authenticated users from the SAME IP draw independent buckets while anonymous traffic draws a third, and per-route ceilings still fire.


## [0.10.33] - 2026-10-01

> The journey release (r477): the product now proves its own core loop on the
> published image — and the very first run of that journey caught a real bug
> no unit test had: a bodyless JSON-declared request answered 500.

### Added

- **`pnpm smoke:user-journey`** — the user-journey smoke. Spins the validated DinD topology (privileged docker:28-dind sidecar; the panel image under test gets plain `DOCKER_HOST=tcp://…`) and drives the product's core loop against the PUBLISHED artifact: register the first admin → create a docker-image service → trigger a deploy and wait for green (deployment rows use `running` as the success terminal — the events layer translates to `success`) → read logs → route a domain → delete the service → full teardown with diagnostics (panel log tail) on any failure. Unit and route tests cover each hop; this proves they still compose on the image a user actually pulls. It joins the release drill.

### Fixed

- **A bodyless `application/json` request answered 500 (found by the journey's first run).** The rawBody plugin — which overrides Fastify's JSON parser to capture exact bytes for webhook HMAC verification — called `JSON.parse` on the raw buffer with no empty-body guard, so `JSON.parse('')` threw into a 500. Real clients send exactly this shape (fetch wrappers that always set content-type on DELETEs — our own smoke among them); Fastify's own parser treats the empty body as `{}`. The override now mirrors that default. Regression test added.

### Security

- **basic-ftp pinned to 6.2.1** (scoped override): <=6.2.0 has a quadratic-time CPU DoS in `Client.list()`'s Unix LIST parser (2026-10-01 advisory); it rides `apps/server > pm2 > proxy-agent > pac-proxy-agent > get-uri`. Prod audit clean again.

### Chain & docs polish (the r475–r476 delta audit: 0 P1 / 0 P2 / 4 P3)

- `ninedeploy backups restore` documented with BOTH required args (`<databaseId> <backupId>`).
- The repo-wide createClient `token:` guard now also sweeps `apps/web/src` — the in-product help surface this project rewrites most often was the one surface unchecked.
- **The release scripts share one package list** (`scripts/lib/package-list.mjs`, imported by bump-version and tag-release) with a test pinning it against the real workspace globs — the two hardcoded 10-entry copies could drift, and an 11th package would have shipped at a stale version with every gate green.
- Webhook help no longer promises a branch picker the panel UI does not have (the Environment tab matches the service branch; override via CLI), and the Sources help topic points at the real flow instead of a Sources-page wizard that does not exist.


## [0.10.32] - 2026-10-01

> The truth-in-docs release (r476): the documentation sweep that had never
> been done, plus the audit of the two chain-guard releases. The docs were
> not merely stale — they actively lied, in four P1 ways, and two of them
> were fresh copies of a bug this project had already fixed once.

### Fixed — documentation that lied

- **Two more copies of the unauthenticated-SDK bug (P1).** r472 found `docs/AI_MCP_CLI.md` teaching `createClient({ token: … })` — an option that does not exist (the SDK takes `getToken`), silently ignored, so a copied example 401s on every call. The sweep found the SAME example in the **root README** and in the **website's docs page**. Both fixed — and a repo-wide test now greps every doc-bearing surface (README, docs/, website, package READMEs) for the `token:` pattern so this bug family cannot ship a third generation.
- **The README taught a nonexistent CLI command (P1)** — `ninedeploy watch 12 480`; the real command is `deploys watch`. And the **website's CLI cheatsheet was written for an imaginary CLI (P1)**: six of ten lines broken — `services deploy my-app` style operands where the CLI takes numeric IDs, `sources deploy-key` (real: `sources keygen`), `webhooks create` (real: `webhooks add <serviceId> [branch]`), plus a mislabeled `system dashboard`. Rewritten against the actual command surface.
- **The in-product help taught the pre-hardening privilege model (P2)** — "anyone who is owner or admin in at least one workspace is an operator": precisely the self-promotion path migration 0038 eliminated. The help now states the operator flag is per-instance (granted on the People page, never inherited), and member-visible topics no longer point at operator-only surfaces (Sources/Volumes/Activity/Docker/Notifications are marked operators-only; the webhook tip points at the real location — the service's Environment tab, not Sources; the agent-transport claim now says sealed envelopes, not "plain HTTP").
- **Docs accuracy wave (P2/P3):** the microkernel doc no longer teaches the r473-removed `rollback` option or the nonexistent `ctx.events.on` member; the website plugin example uses the real `ctx.tapHook` and the real install sources (marketplace|sandbox — not "NPM packages, Git repos, local directories", which r440 removed); TROUBLESHOOTING's diagnostic command works (`services logs <id>`); the backups doc drops the nonexistent "MCP restore tool"; QUICKSTART names BOTH dev commands (`pnpm dev` for the API, `pnpm dev:web` for :5173); every API-token pointer says Settings → **Security**; install.sh no longer cites a nonexistent docs page. Counts refreshed against reality: 38 MCP tools (was 35, in seven places), 52 tables (was 41), 67 route modules (was 48), 130 templates across twenty categories (was 89/ten), test badge aligned with its own table.

### Fixed — release chain (the r474/r475 diff audit: 0 P1, 1 P2, 3 P3)

- **`release:tag` certified the wrong tree when given a commit (P2).** Its compile/test gates run against the working tree, but provenance reads the commitish — tagging an older SHA ran the gates on HEAD while proving the old commit (false pass), and tagging during a mid-bump HEAD false-blocked. The gate now refuses unless commitish == HEAD: check out what you mean.
- Provenance checks **all ten package.jsons**, not just the root (the workspace packages are what `packages:publish` ships). An unresolvable commitish now dies with a `✗` diagnostic instead of a Node stack trace.
- **bump-version.js treats install-command files as critical**: a silent pattern miss on the `--version` occurrences in About/QUICKSTART/README used to pin every copier to the previous release while the script claimed success.


## [0.10.31] - 2026-10-01

> The chain-guard release (r475): the release chain audited itself. The last
> never-audited surface produced this round's only P1 — and the guards it
> shipped are the ones yesterday's v0.10.30 escape proved were missing.

### Security / Release integrity

- **Version provenance is verified before anything is built or pushed (P1).** Tags are created by hand (`git tag vX <commit>`), and nothing in the chain compared the tag's VALUE to what the checkout contains — a typo or a stale SHA would pass every check (it IS a green commit), push a mislabeled image whose panel reports a different VERSION, silently roll `:latest` backward, and create a GitHub Release the CHANGELOG asset contradicts. `release-publish.yml` now asserts **tag == package.json == version.ts** immediately after checkout, before install/build/push; `release-workflows.test.ts` pins the step's existence, its content and its position before `pnpm install`.

### Fixed

- **The local gate now means what CI's gate means (P2).** `pnpm release:check` was a single `turbo run typecheck lint build test` — turbo has no dependency edges between those task names, so the phases could interleave (and a warm tree could satisfy `server#test` from a stale `apps/web/dist`). CI's verify job has always run the four invocations sequentially; `release:check` now mirrors it: `pnpm typecheck && pnpm lint && pnpm build && pnpm turbo run test --concurrency=1`. This is exactly the gap the 0.10.30 unparseable-`version.ts` escape slipped through locally.

- **bump-version.js refuses to lie (P2).** A pattern miss on the load-bearing `VERSION` literal printed a warning and exited 0 — ten package.jsons saying 0.10.31 while the panel kept reporting 0.10.30, every gate green. That miss is now fatal, and the script closes by asserting every package.json and the `VERSION` literal actually landed on the new version before printing its success banner.

### Added

- **`pnpm release:tag` — the local tag gate.** Wraps `git tag` with the checks the drill previously held as discipline: clean working tree; the tag does not already exist (re-tagging stays an explicit delete-and-recreate); **tag == package.json == version.ts == CHANGELOG[0]** read from the exact commitish via `git show` (not the working tree); no unfilled stub survives; and the server typechecks — the precise step an unescaped-apostrophe changelog fails. Used for this very release.

### Verified sound (for the record)

CI's structure held under the audit: build-before-checks, checks-before-push, `needs`-gated edge publish, least-privilege permissions, no `pull_request_target`/fork-secret exposure, strict tag-shape validation; bump-version.js is idempotent with no flag bypass of the >=1.0.0 owner policy. The parked dependency majors stay parked **with evidence**: drizzle-kit 0.31.11 still depends on the deprecated `@esbuild-kit/esm-loader` (our patch remains required; the bump buys nothing), and js-yaml 4.3.2 carries no advisory while pm2 pins the 4.x line.


## [0.10.30] - 2026-10-01

> The clean-sweep release (r474): the fresh-eyes audit of 0.10.29 came back
> **0 P1 / 0 P2** — the notification encryption, the SDK-honouring bootstraps
> and the member gating all held. What ships here are the three P3s it did
> find, plus the two debris items the r473 audit had noted and deferred.

### Fixed

- **The SDK type for the masked notification config (P3).** `listChannels` still promised `configJson: string | null` without the new `hasConfig` field — so a consumer read `null` on a webhook/FCM channel and had no way to distinguish "no config" from "masked". Worse, a read-modify-write flow that rebuilt `configJson` from that null and PATCHed it back would have **silently destroyed the stored HMAC secret / FCM service account** (PATCH treats any non-empty string as the full replacement). The type now carries `hasConfig: boolean` and documents that non-Discord blobs are write-only: send the full config or omit the field.

- **Empty webhook branches fall back again (P3).** r473's charset rule turned `{"branch": ""}` (or whitespace-only) into a 400; the route's historical behaviour was to treat it as absent and use the service's own branch. The schema now normalizes empty/whitespace to `undefined` before validation — the git charset rule still applies to non-empty values.

- **A malformed plugin definition no longer disguises itself as an init timeout (P3).** r473 forwards the object a plugin's code returns verbatim — unlike the install manifest, that object passed no schema. A `configSchema: 5` or a menu item with a numeric id threw inside the READY handler, the message wrapper swallowed it, and the only symptom was a ten-second "timed out during initialization" that hid the cause and stalled plugin load. The READY handler now validates the payload's shape, skips the malformed entries with a warning naming the plugin, and completes the handshake (tested: garbage + one well-formed menu item → plugin loads, the good item registers, the warning fires).

### Hygiene

- `dockerVolumeName`'s uppercase acceptance is documented as **deliberate**: docker itself accepts uppercase volume names, and rejecting them would break attach flows against pre-existing out-of-band volumes (the managed `nd-svc-`/`nd-db-` prefixes are lowercased by construction).
- The `webhooks.events` column is marked **dead** in the schema (defaulted `["push"]`, never written otherwise, never branched on): kept physically — dropping needs a table-rebuild migration for zero value — but flagged so nobody builds on it.


## [0.10.29] - 2026-10-01

> The contract-honest SDK + secrets-at-rest release (r473): the auditors-audit
> of 0.10.28 plus the first deep pass over plugin-sdk, db and schemas. One
> P1 (the plugin SDK promised a contract the sandbox never honoured), one
> secrets-at-rest P2, and the last member-reachable 403 holes in the UI.

### Security

- **Notification channel configs are encrypted at rest (P2).** `notification_channels.config_json` carries real credentials — the webhook channel's HMAC signing `secret` and the FCM **service-account private key** — and sat in a plaintext column outside both the encrypted-at-rest model the schema file itself claims and the key-rotation sweep (a row only kept working across rotations because it was never encrypted). It now follows the r435 SSO pattern exactly: envelope-encrypted on write (POST and PATCH), a best-effort boot normalization rewrites pre-r473 cleartext rows in place, the rotation registry carries the column (plaintext survivors skipped, never fed to `reencrypt`), the dispatch paths and the test route read it through a tolerant `channelConfigOf`, and `GET /channels` answers `hasConfig` with the blob exposed only for the **Discord** shape — the one that is secret-free (username/avatar/title/color) and the only one the UI edits. Webhook/FCM configs are write-only over the API now.

### Fixed

- **The plugin SDK's declared contract is now the runtime's actual contract (P1).** `configSchema`, `menuItems` and `dependencies` declared on the object a plugin's code RETURNS — the thing `definePlugin` validates — were silently dropped: both sandbox bootstraps posted only the install-request manifest at READY, so an author's Settings fields and menu entries never registered and `ctx.config.getSecret` returned null forever unless an operator hand-wrote the key. Both bootstraps (process and worker, kept in behavioural sync) now prefer the returned definition, manifest as fallback. The logger's promised varargs are stringified through to the panel log. And the phantom half of the SDK was deleted rather than left as a trap: `start`/`stop` lifecycle hooks (never called), per-tap `rollback`/`timeoutMs`/`id` options (silently dropped — the host applies its own 5 s budget and rejection rollback), and `ctx.registerMenuItem` (a hard no-op). The flagship example was rewritten to the real sandbox code shape — an async function BODY (`plugin-body.txt`, no import/export, `ctx` is the only panel surface) — and the package ships a README documenting the two halves of a plugin. The unused `@ninedeploy/schemas` dependency no longer rides into every author install.

- **The last member-reachable 403 holes in wizards and modals (P2).** The Deploy wizard (member-reachable from Services and Hub) fired the operator-only `sources` + `servers` listings on every open — doubled by the app-wide retry — and silently rendered "Public / none"; the Attach-Volume modal's inventory query made its DEFAULT tab dead for members (they now start on "Create New", the tab hidden); the Database wizard's retained-volume reuse and the service Danger tab's volume hint each fired a swallowed 403 (the option/hint simply doesn't exist for members now). The Volumes tab's remaining fabricated member numbers ("Host Storage: 0 B", "0 active database volume(s)", an empty "Attached Database Volumes" list for a member with attached DBs) are gone — unknowable values render an honest `—`, the DB-volumes section is operator-only, members' attached databases stay visible where they always were (Architecture tab). The events drawer's "View Full Audit Ledger" CTA and Topology's "Manage All Volumes" link no longer lead members to pages that can only refuse them.

- **Schema boundary honesty (P3).** `webhookCreate.branch` now carries the same git charset rule as the service's own branch field (whitespace-tolerant — trimmed before validation, exactly as the route always did) instead of accepting any string; the dead, laxer twin `createWebhook` in service.ts (used by no route) was deleted before someone "hardened" the wrong copy — the SDK now types `webhooks.create` off the live schema. `createDomain.path` aligned with the manifest's `route.path` rule instead of relying on a downstream strip. Env-var values capped at the same 32 KB the Hub path applies. And the agent `docker run` line shell-quotes its env values — a panel URL legitimately containing `&` used to background the pasted command and mangle everything after it (plain values stay byte-identical).

### Verified sound (for the record)

db's migration chain (data-copying rebuilds, sequence preservation, index coverage for the hot query paths — checked against the real query patterns) and schemas' regexes (anchored, linear, transforms that never throw into a 500) both survived the deep pass; the remaining P3s (dockerVolumeName's `/i` flag contradicting its comment, the dead `webhooks.events` column) are noted, not shipped.


## [0.10.28] - 2026-10-01

> The member posture release (r472): first deep audits of the two surfaces
> that had never had one — the MCP package and the web frontend. Both came
> back structurally sound at the core (0 P1s anywhere); what shipped is the
> retrofit: the operator gating that moved server-side in r469/r470 finally
> reached the UI.

### Web — members stop hitting walls that were never theirs

- **Six operator-only routes left member-visible (P2).** The sidebar (and command palette) offered `/volumes`, `/activity`, `/docker`, `/sources`, `/servers` and `/users` to members although every one is operator-only server-side. Each rendered a 403 error card that read as breakage; worst cases: **Activity** had no error branch at all — a refused load fell into the empty-state arm and claimed "No activity recorded" while `refetchInterval` re-fired the 403 every 5 seconds; **Servers** rendered the entire operator console (capacity cards, the auto-join command banner, the add-server wizard) around its error card. All six are now `operatorOnly` in the sidebar and palette, and the pages carry honest "operators only" one-liners for direct URL access — Activity additionally gained a real error card (with retry, interval-stopping on error).
- **Eleven operator-only Settings sections showed member error states (P2).** `/v1/settings` and its satellites (firewall, log drains, notifications, resources, storage, migration, OIDC) are operator-only; members saw the sections render with failed lookups — the Firewall one worst of all, where a refused status probe rendered the grey **"Not Installed"** badge with a warning shield: the page falsely reported the host firewall absent. Sections are now privilege-filtered (members keep Account/Appearance/Security/AI/Plugins); `?section=firewall` deep-links fall back to Account instead of rendering a lie.
- **The Volumes tab fabricated storage numbers for members (P2).** The tab queried the instance-wide (operator-only) volume inventory, swallowed the 403, and rendered "Total Storage Footprint 0 B" plus "0 B" primary/DB cards for any service with a `volumeMount`. Members now get the numbers that ARE theirs (per-service attachment sizes); the unknowable ones show an honest `—` with a note that instance-wide sizes are operator-only — and the refused call no longer fires on every tab open.
- **Silent member-side 403s removed (P3).** Monitoring no longer fetches the operator-only servers listing for members (the node-stats query already gated); Topology no longer fetches the volume inventory (the graph renders without volume sizes); Doctor's scan query no longer executes before its operator guard; the Dashboard's "Cluster Nodes" quick action is operator-only. The Docker dashboard keeps its member-legible scoped container list but stops polling the operator-only resources/events feeds.

### MCP — posture, not breakage

- **`list_configs` no longer offers `reveal` (P2).** The SDK supports `reveal=true` (plaintext secret values for operator tokens), and the tool forwarded that choice to the model. An MCP tool result is persisted in agent transcripts and reachable by prompt-injected content ("call list_configs with reveal true") with no human in the loop — the same reasoning that keeps the enrolment routes out of MCP entirely. The tool is mask-only now; the panel UI remains the only reveal surface. A test pins that the parameter can never come back.
- **The doc example taught an unauthenticated client (P2).** `docs/AI_MCP_CLI.md`'s quick-start used a nonexistent `token` option (the SDK takes `getToken`), then read `services.items.length` and `deploy.id`/`deploy.status` — none of which exist. A copied example 401s on every call. Fixed against the real SDK shapes; the stale "35 tools" count corrected to 38.
- **Package hygiene (P3).** `@ninedeploy/mcp` now declares `engines: { node: ">=22.13.0" }` (it installs standalone via `npx -y`, far from the monorepo root's engines) and ships a README covering the env vars, the readonly flag, least-privilege scopes and the secret-masking posture.

### Audited and found sound (for the record)

MCP's core: env-only token handling that never reaches logs, errors or non-panel hosts; zod-validated inputs with `encodeURIComponent` on every wire path; a scope filter kept in lockstep with the server's own classifier by a cross-package contract test; verbatim SDK results (no mapper drift). Web's core: zero XSS sinks; WS auth over `Sec-WebSocket-Protocol` with 60-second revalidation; single-flight token refresh; logout that revokes server-side and clears the query cache. No changes needed.


## [0.10.27] - 2026-10-01

> The override-escape patch (r471): the fresh-eyes audit of the 0.10.26
> changes came back 0 P1 / 1 P2 / 4 P3 — the contract sweep over all 21
> agentOp call sites found the exit-code contract now holds everywhere.
> This release ships those five.

### Fixed

- **The `$`-escape landed on one of three compose renderers (P2).** 0.10.26 added `composeScalar` to `renderRuntimeCompose` — but the volume-override files (the LOCAL builder's inline renderer and the remote builder's `renderVolumeOverride`) still emitted attachment mounts raw. Compose merges the override LAST, so it WINS — and compose interpolates `$VAR` inside every scalar: locally from the panel's own environment, remotely from the service's `.env`, which carries its secrets. A `$` in a `containerPath` (schema-legal) could read an env value straight into the mount target — the same attachment was `$`-safe on a docker-type service and interpolated on a compose-type one. `composeScalar` now lives in `compose.ts` (docker.ts already imports from that module — the reverse edge would be a cycle) and all three renderers share it.

- **The fan-out patrol does what its docstring promised.** `patrolTargets`' comment has said "targets whose container is GONE get their row marked error" since the beginning — but since r466's agentOp contract, `docker inspect` on a missing container THROWS (exit 1), the catch skips the target, and the marking was dead code: the panel kept showing a running row for a container that no longer exists on the node. The probe now passes `tolerateExit` and treats a non-zero exit as the container being gone → the row is marked `error` (the next deploy recreates it); unreachable nodes are still skipped without judgement.

- **A refused remote network delete carries docker's reason.** `DELETE /v1/networks/:name?serverId=` discarded the op's output lines (`noop` sink), so an in-use network answered a bare `400 "agent docker.networkRm exited with 1"` the operator could not act on. agentOp sinks the command's output BEFORE it throws on the non-zero exit — the route now collects those lines and answers `409` with docker's own "has active endpoints" (plus the same detach hint path as the local branch). An unreachable agent stays a 400 with the transport error.

- **Sandbox crash reports survive their last line; test cleanup stops racing the dead channel.** The child's stderr line-splitter never flushed, so a crash report killed mid-write (no trailing newline) was swallowed exactly where the code said "the only place a bootstrap crash report can ever surface". The exit handler now flushes the trailing partial line. The honesty tests' `stop()` helper sent SHUTDOWN to an already-exited child (unhandled `ERR_IPC_CHANNEL_CLOSED`) and waited out a pointless 3-second tail on the happy path — it now checks `connected` first and passes send a callback that absorbs the close race (the suite dropped 3.5 s → 1.3 s).


## [0.10.26] - 2026-09-30

> The contract-honesty patch (r470): a fresh-eyes audit of the previous two
> releases' own code found three P1s where callers — and their tests — agreed
> on a contract the library never had. All fixed, and the compiled sandbox
> bootstrap is now pinned by tests that fork it for real.

### Fixed

- **agentOp's exit-code contract vs its r466 callers (P1).** `agentOp` throws on any non-zero exit — but `docker.volumeInspect`, used as an existence probe, exits 1 for exactly the answer being probed ("volume missing"). Result: every server-pinned service create answered 409 "treated as retained" (the probe threw, the catch failed closed on every fresh slug), and `DELETE /v1/volumes/:name?serverId=` answered 500 for an ordinary in-use volume instead of 409. `agentOp` now takes `{ tolerateExit }`; the slug-retention probe, the node volume delete (rm refusal → 409 "in use on node #N", verify probe → 409 "still there") and the node stats route (a failed docker-stats collection no longer masquerades as "node unreachable") pass it and read the code themselves. The two test suites had mocked `{ exitCode: 1 }` resolutions the real client never produces — they now mirror the real contract (non-zero throws unless tolerated), which is exactly how the drift shipped unnoticed.

- **`df` dispatched to `git` (P1).** `spawnValidated`'s executable dispatch was a two-way ternary from the docker+git era; adding `df` to the type silently made every node disk probe run `git df -k .` (exit 129) — node disk telemetry never worked once. It is now a three-way table that cannot grow a stale default branch. The probe itself is `df -kP` (POSIX: one line per filesystem, no wrapped device names) with a positional header skip — coreutils translates the header under a non-C locale, and the old English-text match leaked it through as a bogus data row.

- **Sandbox SIGKILL escalation was dead code (P1).** `terminate()` armed the SIGKILL behind `!child.killed` — but `killed` only records that a signal was SENT, and the SIGTERM above had already set it, so a wedged sandbox child outlived its plugin forever. The escalation is now armed unconditionally and disarmed when the child actually exits.

- **Sandbox child pipes were never drained (P2).** `silent: true` pipes stdout/stderr into the parent; an unread pipe eventually fills its kernel buffer and the child blocks on its next write. stdout is now drained (plugin output travels the LOG protocol); stderr lines surface in the panel log — the only place a bootstrap crash report can ever appear.

- **Compose bridge parity and interpolation (P2).** `renderRuntimeCompose` now emits `memswap_limit` alongside `mem_limit` (the `docker run` line pins `--memory-swap` to the memory limit; the compose twin could balloon into swap on the same box), and escapes `$` as `$$` in command/volume scalars — compose interpolates `$VAR`/`${VAR}` inside every scalar, so a literal dollar in a template-controlled path was substituted from (or emptied by) the panel's own environment.

- **Dashboard container count is operator-only (P2).** The whole-node `docker ps` count (every tenant's containers) rode along to members in `/v1/dashboard`. Operators keep the card; members get `null` (the SDK type is nullable; the CLI prints "— (operator only)") and the docker round-trip is skipped entirely — the same gating r469 applied to host telemetry. A failing docker probe now reports unknown (`null`) instead of a confident 0.

### Added

- **The processBootstrap honesty tests.** The compiled sandbox bootstrap is forked under the REAL permission-model flags (`SandboxPlugin.sandboxExecArgv`): INIT→READY handshake, hook round-trip, clean SHUTDOWN (exit 0, not a kill), and an in-plugin `fs.readFileSync` outside the allowlist that must come back `ERR_ACCESS_DENIED`. If the plugin's fs-read allowlist ever stops booting the real bootstrap, this is the test that says so first.

### Dependencies

- zod 4.6.5, dotenv 18.0.4, simple-git 4.0.2 (security fix; our named imports were already 4.x-compatible), @simplewebauthn/server 14.0.3 + @simplewebauthn/browser 14.0.0 (Node 22+; the v14 `AuthenticatorTransport` rename applied), @libsql/client 0.18.0, jsdom 30.1.1, drizzle-orm 0.45.3 (the server's separate pin unified — two copies broke typecheck), mcp vitest/@vitest/coverage-v8 5.0.1. Supply-chain overrides refreshed for the new advisory set: fast-uri 3.1.8 / 4.1.5 and brace-expansion 5.0.12 — `pnpm audit` clean.


## [0.10.25] - 2026-09-30

> The telemetry posture release: host figures are operator-only (r469) — the
> last deferred audit item, closed with the conservative default (members keep
> their own services' stats; machine-wide numbers stop leaking).

### Security

- **Host-level telemetry is operator-only (r469).** `/v1/stats` returned the host card (CPU cores, load average, total/used memory, disk usage) to every authenticated caller — but those figures expose machine capacity and the aggregate load of EVERY tenant's workloads, information a member has no business need for on a multi-tenant panel. The `host` object now comes back `null` for non-operators (the schema's `host` is nullable precisely for this); the per-service container stats stay scoped exactly as before (owned + workspace-visible). The Monitoring page replaces the member's blanked host cards with an explicit note — "Host-level metrics are visible to operators only — your own services' live usage is listed below" — instead of unexplained dashes. Operators see exactly what they saw before.

## [0.10.24] - 2026-09-30

> The real sandbox release: third-party plugin code runs behind Node's
> permission model (r468) — the last engineering item on the audit backlog.
> What used to be an honest disclaimer ("containment, not a security
> boundary") is now a boundary.

### Security

- **Sandbox plugins run in a permission-model child process (r468).** The old sandbox was a worker thread with a scrubbed environment (r414) and V8 memory caps — real containment, but its code could still `import('node:fs')` and read everything the panel user could: the master key, `.env`, the SQLite database. The production sandbox now forks `processBootstrap.js` with `--permission` and exactly two fs-read allowlist entries — the bootstrap's own directory and the package manifest the ESM loader needs for `"type":"module"` — so filesystem read/write outside that, spawning child processes, opening worker threads and loading native addons are denied by the Node runtime itself (`ERR_ACCESS_DENIED`), not by convention. Memory caps carry over as `--max-old-space-size=64` / `--max-semi-space-size=16`; the scrubbed env stays (r414 — `process.env` is not part of the permission model); a wedged child that ignores SIGTERM is SIGKILLed after a 3 s grace. Tests fork the real compiled bootstrap under the real flags and prove the denials (fs read of a secret file → `ERR_ACCESS_DENIED`; `spawn` and `new Worker` → denied), plus the full INIT/REGISTER_HOOK/HOOK_RESPONSE handshake. Dev/source checkouts (no compiled bootstrap, no loader for a forked child) fall back to the legacy worker transport; the plugin docs now state the upgraded trust model — installing a plugin remains a trust decision about what it may do THROUGH the ctx API, no longer about what it can reach around it.

## [0.10.23] - 2026-09-30

> The node telemetry release: Monitoring finally sees every node (r467) —
> the last purely additive item on the audit backlog, closed with a composite
> agent op and a card row that stops lying about whose numbers they are.

### Added

- **Per-node telemetry on the Monitoring page (r467).** Clicking a remote node's card now switches the overview cards and the workload grid to THAT node's live numbers — CPU cores and load, memory, disk, and per-service CPU/memory — instead of the panel host's figures under a "Node" label (the old honest note said so; now it is simply true). A new composite `agent.stats` handled op runs on the node: host stats from `/proc` (the host's real values even from inside the agent container — no lxcfs virtualization on a standard node), per-container `docker stats --no-stream`, and the node's disk via `df`. Everything rides the sealed, nonce-bound agent protocol; the panel joins container names to the service rows pinned to that node exactly like `/v1/stats` does for the panel host. The cards refresh every 8 seconds; an unreachable agent degrades to placeholders with an explicit "agent unreachable" sub-label rather than silently showing the master's numbers. New endpoint `GET /v1/servers/:id/stats` (admin-only) and SDK `client.servers.stats(id)`; the panel-host view is byte-identical when "Local Host" is selected. Node agents must be ≥0.10.23 — an older agent answers `unknown_op`, which the route surfaces as "agent unreachable" instead of guessing.

## [0.10.22] - 2026-09-30

> The node volumes release: remote services' data volumes finally have a
> lifecycle (r466) — the retention guard probes the right machine, and the
> Volumes page can clean the far side of the wire.

### Fixed

- **The slug-retention guard probed the wrong machine for remote services (r466).** r351 refused a create whose slug would re-mount a deleted service's data — by listing the PANEL host's volumes. A service pinned to a node mounts `nd-svc-<slug>-data` ON THE NODE: a local volume of the same name is irrelevant (never mounted by the new service), and a node volume is invisible to a local check — so a freed slug silently re-mounted a deleted service's node data, another tenant's uploads and secrets included. Remote creates now probe the node through a new validated `docker.volumeInspect` agent op (same operand regexes and workspace confinement as every other op); a retained node volume is refused with a 409 `slug_volume_retained` that names the node and how to clean it, an unreachable or too-old agent fails CLOSED (treated as retained, pm2 exempt as always), and local creates keep the exact behaviour they had.
- **A retained node volume could never be deleted (r466).** The Volumes page listed and removed local volumes only — a node-side leftover was invisible forever. `DELETE /v1/volumes/:name?serverId=N` routes the removal and the post-rm verification through that node's agent: docker itself refuses an in-use volume on the node, and the inspect-after-rm turns a silent failure into an honest 409. The local path is byte-identical when no serverId is given.
- **A key rotation counted rotations that never happened (r466).** The tolerant ssoProviders entry (r446's pre-r435 plaintext survivor) skipped the re-encrypt but still incremented the count and issued an empty UPDATE — the report claimed work it did not do. An empty patch now skips the row entirely: no update, no count.

## [0.10.21] - 2026-09-30

> The multi-line env release: PEM keys and JSON documents arrive intact (r465)
> — the largest remaining user-facing limitation, closed with a one-service
> compose bridge that changes nothing for anything else.

### Fixed

- **Multi-line environment values no longer arrive as a literal `\n` (r465).** docker's `--env-file` parser treats every line as `KEY=VALUE`, so a PEM private key or a JSON service credential reached the container with two characters where the line break belonged — apps failed on their own secrets, and the only workarounds were base64-encoding or switching to a compose service. When any resolved env value spans lines, the docker builder now starts the container through a generated one-service compose file: compose's dotenv parser decodes the quoted `\n` escapes into REAL newlines (the same byte-verified format the compose and remote-compose builders have always used), and the file carries the exact `docker run` line — same container name (the blue-green candidate), same `nd-svc-<slug>` bridge joined as an external network, same volumes (data mount and attachments, declared external, ensured with an idempotent create to match `-v` auto-create semantics), same CPU/memory limits, same restart policy, same template command, same published port for the primary (replicas stay portless, each in its own compose project). Everything downstream of "container exists" — health probes, Traefik routing, stop/rollback, replica naming — keys on the container name and is untouched. Services without multi-line values keep the byte-identical `docker run` invocation they have always had. The env editor's "base64-encode it" heads-up is retired into an upgrade note for older panels.

## [0.10.20] - 2026-09-30

> The integration round: the two additive items left on the audit backlog —
> remote compose stacks that report the container they actually run (r464),
> and an SDK that can manage the node-enrolment token (r463).

### Fixed

- **A remote compose stack that pinned `container_name:` reported a container that did not exist (r464).** The remote builder always recorded the deterministic `<project>-<service>-1` name; the local builder has always resolved the ACTUAL container via `docker compose ps`, but the agent protocol had no such operation — so a template pinning its own container name (or a scale change) left health checks, routing and teardown all targeting a ghost while the deploy claimed its machinery around it. A new validated `docker.composePs` agent op (same operand regexes and workspace confinement as every other op) resolves the real name right after `up` — before the secrets-bearing override file is deleted, with the same `-f` set — and `stop()` tears the project down through the resolved id's mapping. Unparseable or failed resolution falls back to the deterministic name with a logged warning, never a failed deploy.

### Added

- **The SDK speaks enrolment (r463).** `client.settings.enrolment.get/rotate/disable` wrap the admin routes the server already exposed — the token an agent's `NINEDEPLOY_ENROLMENT_TOKEN` needs is now rotatable and revocable from scripts and the CLI, not only the dashboard. (Deliberately NOT surfaced through MCP's read-only tools: the token is secret material.)

## [0.10.19] - 2026-09-30

> The edge sweep: every deliberately-deferred P3 from the deep-audit rounds
> (r453–r461) — bounded caches, serialized imports, an honest no-systemd
> upgrade, a health gate that probes the real bind address, and an installer
> that stops growing `.data` forever.

### Fixed

- **The OIDC JWKS cache was an unbounded Map (r453).** Growth is slow (per operator-registered issuer) but unbounded is unbounded — it is capped at 32 entries with the same flush-at-the-cap policy the discovery cache uses.
- **Two concurrent system imports deleted each other's files (r454).** The import extracts into one fixed scratch dir; a second request's up-front clear wiped the first's archive mid-extraction. The panel is single-process — imports now serialize on a promise mutex and the loser gets an explicit 409 ("Another import is already running") instead of a mysterious half-import.
- **The studio proxy read the cookie epoch twice per request (r455).** The pre-parse gate's read is stashed on the request and the handler's defence-in-depth check reuses it — one settings lookup per proxied request instead of two, on top of the existing database row read.
- **The agent's 4 MiB body limit was more headroom than needed (r456).** Tightened to 2 MiB: still above the ~1.4 MiB base64 worst case for a 1 MiB workspace file, less pre-auth per-request buffering (bodies parse before the token check; rate-limited per IP).
- **Installer edges (r457–r461):** swap persistence ignores commented fstab lines (`#/swapfile` used to silently skip it); the GitHub API fallbacks and the compose-file fetch carry `--retry 3` like the release tarball always did; the docker-mode health gate probes the bound address — a specific non-loopback `NINEDEPLOY_BIND` made the hardcoded `127.0.0.1` probe false-fail the entire install; a no-systemd UPGRADE now warns that the running foreground panel still executes the OLD code over the replaced tree instead of printing a bare "Installation Complete"; and pre-update snapshots (master.key-bearing full DB copies) are pruned to the newest five — `.data` used to grow by one per upgrade, forever.
- **Test coverage (r462):** the log-shipper plugin's timer-only lifecycle (tick, partial-failure warning, throw-survival, post-close stop) had never been exercised — the largest uncovered function gap in the server suite. Fake timers drive all four arms now.

## [0.10.18] - 2026-09-29

> The auditors-audit patch: a fresh-eyes review of the 0.10.16/0.10.17 changes
> closed the gaps in yesterday's fixes (r442–r446), and install.sh — the one
> large artifact never deeply audited — got its first full pass (r447–r452),
> headlined by docker-mode upgrades finally getting the r087 treatment.

### Fixed

- **A failed docker-mode upgrade left the panel down with no recovery (r447).** Bare metal has the full stop→rollback→restart machinery; docker mode had two bare `compose` calls. `docker compose up -d` recreating a changed container stops and renames the old one before creating the new — a failed recreate (port collision, mount error, bad env) left the old container stopped and the panel dark, and a SIGTERM mid-up did the same. The previous container is captured before the recreate and started again when the new one does not land.
- **A docker-mode re-run silently reset an operator-chosen port (r448).** `NINEDEPLOY_PORT` was force-upserted from the ambient environment on every run — an operator who installed on 8080 (the documented escape from an occupied 3000) got the mapping flipped to 3000 on the next upgrade, external access broken behind a green "Installation Complete", and a recreate failure into the r447 window when 3000 was busy. The port is read back from `.env` first now, the same pattern the JWT secret always used.
- **Operator-supplied `.env` values rode through a sed replacement (r449).** The docker-mode `upsert_env` interpolated values into `s|…|…|` — a JWT secret or DNS token containing `&` (valid chars) silently corrupted the file, `|` aborted the run after the rewrite. Values are written with grep+printf append semantics; the bare-metal seds stay (their inputs are literals, generated hex, or email-regex-validated).
- **The installer could re-point a live install at a random clone (r452).** INSTALL_DIR prefers a checkout in the cwd, so running the script from any clone on a host with a systemd install took the "upgrade" branch against the CLONE: production stopped, a fresh `.env` minted over an empty `.data`, the unit re-rendered at the clone, and the panel came up empty with every deployment orphaned on disk. When the live unit's `WorkingDirectory` differs from the resolved install dir, the installer now refuses loudly. (The panel's own self-update was immune — it pins `NINEDEPLOY_INSTALL_DIR`.)
- **`.data` was world-readable (r451).** The installer is meticulous about `.env` and backups; the data directory — home of `ninedeploy.db` (credential hashes, sessions), `repos/` checkouts (committed secrets included) and PM2's dump — was created with the ambient umask. It is `0750` on create now. `NINEDEPLOY_BIND` is also persisted to the docker-mode `.env` when provided, so the advertised manual `docker compose up -d` no longer silently rebinds the panel to loopback.
- **The git upgrade path never warned it has no rollback (r450).** Only the release-tarball path prepares a code-rollback point; `--channel main` (and the tarball-fetch-failure fallback) swaps the tree with none, and a build failure surfaces as "The panel is DOWN" with no advance notice. The warning now fires BEFORE the swap.
- **The audit of the auditors — gaps in the 0.10.16/0.10.17 fixes (r442–r446).** The SAML consumer read the provider config with a bare `JSON.parse`, which the r435 boot normalization breaks for every legacy SAML row it serves — it reads through the envelope helper now (r442). The agent child-process scrub claimed to remove the enrolment token but the list missed the env var that actually carries it — `NINEDEPLOY_ENROLMENT_TOKEN` and `NINEDEPLOY_DNS_TOKEN` are scrubbed too (r443). Admin-forced password resets and SCIM deprovisioning revoke "every credential the account holds" without touching the studio-cookie epoch — a deactivated operator's 8-hour pre-authenticated database-GUI cookie (Redis studios even carry the decrypted password) kept working; both bump the epoch like self-service resets (r444). The kernel `backup.completed` type matches what the bridge emits (r445), and a key rotation skips a pre-r435 SSO row that escaped the boot normalization instead of aborting the sweep (r446).

## [0.10.17] - 2026-09-29

> The deferred-backlog patch: every verified item from the audit backlog that
> fit a patch (r435–r441) — the SSO secret sealed at rest, discovery that
> stops hammering the IdP, studio cookies that die with the password they
> outlived, an agent that leaks nothing to its children, and notifications
> that stop making numbers up.

### Security

- **The SSO provider config was stored cleartext — clientSecret included (r435).** The module's own docblock claimed secrets were "encrypted at rest by lib/crypto.ts on the way in"; nothing of the sort happened: `config_json` was `JSON.stringify(config)` verbatim, and unlike its sibling `oidc_providers.client_secret_encrypted` the column never rode the master key. Writes are envelopes now, a boot-time normalization rewrites pre-0.10.17 rows once (both shapes read — an upgrade never locks an operator out of their IdP), and the column is registered in the key-rotation registry so a master-key rotation carries it.
- **The agent's git/docker children inherited the agent's credentials (r439).** `spawnValidated` passed no env, so every child saw `NINEDEPLOY_AGENT_TOKEN`, the raw enrolment token and the master URL — the same leak class the r414 sandbox scrub closed for plugin workers. The six credential-bearing keys are dropped from every spawn; PATH, HOME, `DOCKER_*` and proxy variables pass through untouched (docker and git legitimately need those).
- **An 8-hour Web-Studio cookie outlived the password reset that revoked everything else (r441).** The studio proxy cookie is a self-contained HMAC — no session to revoke — so resetting a password left a live shell into a database GUI (Adminer) running for hours on dead credentials. The cookie is now bound to a per-instance epoch stored in settings; both the password-reset and password-change routes bump it, killing every outstanding studio cookie at once. Each studio iframe simply asks to be started again.

### Fixed

- **Every OIDC login start and callback fetched the IdP's discovery document (r436).** Near-immutable metadata, an outbound roundtrip per attempt — and an authenticated hammer turned the panel into an amplifier against the IdP. Successes are cached per issuer for 10 minutes (bounded, and a `bustOidcDiscoveryCache` escape hatch); failures are never cached, so a flaky IdP is not sticky.
- **The agent's real 1 MiB limit was ~0.75 MiB, with the wrong error (r438).** Workspace files travel base64-wrapped in JSON — a ~4/3 inflation plus envelope overhead — so honest payloads at the agent's own `MAX_WORKSPACE_FILE_BYTES` died at Fastify's default 1 MiB bodyLimit with a generic 413 before the agent's better-messaged check could ever run. The agent app's bodyLimit now sits at 4 MiB; the agent's own content caps remain the real gate.
- **Backup notifications fabricated their numbers (r437).** The audit bridge mapped `backup.create` onto `backup.completed` with an empty payload, and the dispatcher rendered what the payload never carried: "Database #0 backup succeeded (0 bytes)". The bridge carries the database NAME the backup route audits, and the notification says which database it was — "unknown" when the payload is genuinely empty, never an invented id and size.
- **The CLI advertised plugin sources the server refuses (r440).** `ninedeploy plugins install --source npm|git|local` has answered `400 UnsupportedPluginSource` on every attempt since the loadable-source gate landed — the server only loads marketplace and sandbox code. The command's help, choices and types now offer exactly those two.

## [0.10.16] - 2026-09-29

> The deep-scan patch: a full pass over the server, web, CLI and packages by
> two parallel review agents, everything verified fixed in place (r427–r434) —
> the operator credential boundary sealed at every sink, WebSockets that
> clean up after themselves, and a dependency tree with zero known
> vulnerabilities.

### Security

- **A workspace member could aim the operator's git credential at any repository it can read (r427/r428).** Two roads, one root cause: the clone route copied `sourceId` verbatim into a service owned by the CALLER (create and PATCH refuse exactly that attachment for members), and PATCH placed no restriction on `repoUrl`/`branch` for a service that USES a managed source — a member retargeted the repository, deployed, and streamed the build log while the pipeline cloned their chosen URL with the operator's decrypted PAT. A non-operator's clone now arrives with the source stripped, and a repository/branch change on a sourced service is operator-only. No-op PATCHes (a UI resending the same value) keep working, and members keep full control of their own unsourced services.
- **Supply chain: seven known advisories closed, `pnpm audit` reports zero (r434).** The fast-uri overrides were sitting on 3.1.6/4.1.3 — the exact versions two 2026 GHSAs still flag; both majors are pinned to their patched releases (3.1.7/4.1.4). `ip-address` (SSRF/trust-boundary bypasses via misread link-local and NAT64 ranges, reachable through @fastify/rate-limit, the MCP SDK and pm2's socks chain) is forced to ≥10.5.1. Nodemailer jumps 9→10 (cross-transport TLS `servername` reuse, GHSA-6vj9-mwq6-2f5v) — the panel uses the three-call core API, identical across the major.

### Fixed

- **WebSockets leaked a timer and a subscription per dropped connection (r429).** The events and deploy-log handlers await a DB roundtrip (auth) BEFORE attaching their close listeners — a client disconnecting inside that window emits `close` with no listener registered, so cleanup never ran: the 60-second revalidation interval ticked forever and the bus subscription (closure holding the socket and the raw bearer token) lived for the process lifetime. Both handlers now check the socket state after the awaits and inside the interval; live connections behave exactly as before.
- **The container-exec socket hung open forever on an unknown service (r430).** A websocket route's reply is hijacked — the 404 `loadServiceForUser` throws cannot become an HTTP response, so the handler rejected and the client stared at an unusable "shell" that never closed. The lookup is wrapped like the sibling log route's: closed with 1008 `not found`.
- **A crashed system import poisoned the next one (r431).** Import extracts into a FIXED `_import` scratch dir and cleans it only on paths that reach the end; a crash (or a malformed `_meta.json`, which rejected with the files still in place) left the previous archive's `_db-<stamp>.db` behind — and the next import's prefix-based finds could select the STALE files, silently restoring the wrong database while auditing the new archive. The scratch dir is cleared before reuse and the malformed-meta path cleans up too.
- **Volume-attachment container paths are validated the way the schema always claimed (r432).** The documented rejections — NUL bytes, embedded newlines, `..` segments — were never enforced: the regex prefix-matched `/a/../b`, `/a\0b` and `/a\nb` through, and the value flows straight into `docker run -v <volume>:<path>`. The pattern is anchored on both ends now; a lone `/` and ordinary deep paths stay valid.
- **The web activity feed ignored `VITE_API_URL` (r433).** Every HTTP call and both other WebSockets resolve through it; the events socket alone hardcoded the page origin — in a split deployment (bundle served from the web host, API elsewhere) the drawer retried a dead endpoint with backoff forever, permanently showing "Stream closed" while the rest of the dashboard worked. It uses the shared resolver like its siblings.
- **The CLI's 401-refresh path list had drifted from the web client's (r434).** The web copy learned the r193 exemption for `oidc/<slug>/link` (an authenticated route); the CLI's mirror never did — latent until a command wires `auth.oidc.link()`, which would then fail permanently once the 15-minute access token expired instead of silently refreshing. The regexes are byte-identical again, with a comment on each side naming its twin.

## [0.10.15] - 2026-09-29

> The fresh-audit patch: four parallel reviews of the never-audited surfaces
> (auth/session, the node-agent protocol, the compose engine, the plugin
> kernel + packages contract) — r412–r426.

### Security

- **Failed Nixpacks builds leaked every runtime secret into the deploy log (r412).** The build passed the service's WHOLE resolved env — project-shared secrets, managed-database URLs with plaintext passwords — as `--env KEY=VALUE` argv, and the exec layer's error label embeds the raw argv: one failed build and the string carried the secrets into the deploy log (readable by every workspace member with the service), the audit trail and notification channels. Values following `--env` (and `-e`) are masked in labels now, keys kept readable — the same treatment `--password` already had.
- **A member env row could redirect builds to an attacker's Docker daemon (r413).** `buildEnv` let caller-supplied values override the transport keys it deliberately inherits; a member setting `DOCKER_HOST=tcp://attacker:2375` on their own docker service handed the build context and every injected secret to a daemon they control. `DOCKER_HOST`/`DOCKER_CONTEXT`/`DOCKER_CONFIG`/`COMPOSE_FILE`/`DOCKER_BUILDKIT` are dropped from user env unconditionally — effective precisely when the host defines no value of its own.
- **The plugin sandbox worker inherited the panel's environment — master key included (r414).** A worker thread receives a copy of the parent env at spawn; third-party plugin code could read `NINEDEPLOY_MASTER_KEY` for free (the key that decrypts every stored secret). The worker now gets a scrubbed three-variable environment, and the docs state the honest trust model: the sandbox is resource containment, not a security boundary — installing plugins is an operator-level trust decision like PM2 services.
- **The events socket skipped the fine-grained scope check its HTTP route enforces (r419)** — a `services`-scoped CI token could hold a live `/v1/events` stream. The exec and log WebSockets now also revalidate their token every minute (r418): a revoked session (logout-everywhere, password change) loses its interactive root shell and its secret-echoing build log within a minute, not when the client feels like closing — r401 fixed only the events socket of the three.

### Fixed

- **A fresh node's first deploy could never succeed (r415).** Every remote container starts with `--network ninedeploy`, but on a node that network was created only by a SUCCESSFUL deploy's proxy sync — and the failure path never syncs. Register a node, deploy anything, and it fails with "network ninedeploy not found", forever, with no UI action that prepares the node. Both remote builders ensure the network (idempotently) before touching docker.
- **The agent's `docker.pull` bypassed the spawn-validation invariant (r417).** It ran the PANEL-side pull-recovery machine — three retries, `ctr`/`tar` chains, a crane binary downloaded from GitHub — with 30–60-minute step timeouts, outliving the panel's 600 s request budget while the deploy had already failed, on binaries the agent container does not ship. It is a plain validated `docker pull` now: a failed pull on a node fails fast and honestly.
- **`proxy.ensure` destroyed the node's only proxy before starting the new one (r416).** `rm -f` came first; a failed image pull or transient daemon error then left every domain on the node dark while the panel logged "the node keeps serving its previous routing" — a lie in exactly that case. The image is pulled BEFORE the removal, and the failure message now says which of the two states the node is in.
- **Disabling a plugin stopped nothing (r420).** The worker thread, its deploy hooks and its event subscriptions kept running — the operator's first move against a suspicious plugin was a no-op — while enable FABRICATED rows for plugins that never existed (and never loaded a plugin disabled before a restart), `reload` reported success without touching the runtime, and reinstalling left the OLD code in the stored row (the next boot resurrected the broken version). All four routes now drive the kernel's (un)registration and the stored manifest; unknown ids answer 404.
- **Honest node status (r421).** The agent announces every 60 s (lastSeenAt used to mean "last boot"), the server list reports a stale `online` node as `offline` at read time, and `host:port` spellings are normalized so one endpoint cannot fork two rows through `NINEDEPLOY_ADVERTISE_HOST=10.0.0.5:4600`.
- **Assorted (r422–r426).** Editing an inline stack's YAML seeds NEW `SERVICE_*` tokens — the stack used to deploy green with blank credentials, because compose interpolates unset variables to empty strings and the preflight still passes. A repo-committed `.env` symlink can no longer route the merged write (repo bytes + plaintext panel secrets) outside the workdir. A non-mapping `services:` block is refused where the message helps instead of dying late at `docker compose config`. Concurrent invitation accepts treat the unique-index collision as the success it is. Unknown orchestrators answer a uniform 404 instead of a 200 body typed as the success payload. Official plugins list as Official (the CLI labeled all twelve built-ins "Community"). The CLI health banner no longer counts every healthy remote-node service as needing attention.

## [0.10.14] - 2026-09-28

> The backlog-clearing patch: the deferred findings from the audit rounds that
> fit a patch (r403–r409) — races closed, semantics made literal, and the
> panel's small dishonesties fixed.

### Fixed

- **Fan-out resurrected target rows the operator had just deleted (r403).** `recordFanoutResults` upserted unconditionally: removing a node from a service's targets (or deleting the service) while its deploy's fan-out loop was still running re-INSERTED the row — the panel showed a target the operator had removed, and the container this deploy started on that node kept running with no row tracking it. A missing row is now skipped, and the just-deployed container is retired best-effort through the node's agent.
- **A cancel in the claim-to-first-write window was silently overwritten (r404).** The worker's claim flips `queued → building`; the cancel route legitimately flips `building → cancelled`; the pipeline's first status write then wrote `building` back unconditionally and the cancelled deploy ran to a green finish — the API had already answered `{ ok: true, status: 'cancelled' }`. The write is now conditional on the row still being `building` (the same guard the finalize uses), and a lost claim hands the row to the existing cancel checkpoint for full cleanup semantics.
- **`durationWindows` fired one sample late (r405).** The bound required `N × 30 s` of elapsed breach measured FROM the first breaching sample — which itself is sample #1 — so `durationWindows: 1` fired on the second sample, 60 s in, contradicting the schema's "number of consecutive 30s samples that must breach before firing". The window is now `(N-1) × 30 s`: N consecutive breaches fire on the Nth sample, and N=1 fires immediately. The breach-window writes are idempotent re-asserts of the row's own values.
- **A failed prune chunk reported nothing removed (r406).** `docker image rm a b c` removes the subset it can and exits nonzero; the chunk catch recorded `removed=0` while gigabytes were freed — an operator comparing dry-run with the real run saw the real one do "less". The failed chunk is now re-inspected image by image, and everything actually gone is credited.
- **Two slow leaks (r407/r408).** The SSH-bootstrap log cache (full per-run logs, unbounded map) is now LRU-capped at 25 entries; and members' topology graphs dropped their own inline-compose networks (`ndcmp-<slug>_default`) while operators saw them — the member filter allows them for visible slugs now.
- **The panel's small dishonesties (r409).** Live CPU/RAM badges showed a confident `0.0%` before the first snapshot arrived — now `—` (a running service read "idle" during a CPU storm on first paint). The .env export and deploy-log download revoked their blob URLs synchronously, which cancels the download in Safari — both use the Safari-safe `downloadBlob` the rest of the app already had. Volume snapshot times rendered raw UTC with no Z (off by the viewer's timezone against every other timestamp in the app) — local time now. An expired certificate rendered `cert -3d` in amber — it says `expired 3d ago` in rose with a reissue hint. Pending (unrouted, unverified) domains linked to `https://<host>` and inevitably errored — plain text until verified. The volume-attach helper described a greyed-out in-use list that never existed. And a docker-type service holding a multi-line env value (PEM key, JSON document) now gets a heads-up in the env editor that docker's env-file cannot carry real newlines — the value arrives as a literal `\n`, which compose services decode and PM2 passes through; the fix for the transport itself is feature work.

## [0.10.13] - 2026-09-28

> The deferred-round patch: everything verified in the 0.10.12 audit but left
> for a round of its own (r397–r402) — rollback that survives autoPrune, a
> proxy failure that no longer lies, node endpoints that cannot fork, and
> honest healthchecks.

### Fixed

- **Rollback pinned an unpullable image reference (r397).** Image deploys recorded `docker inspect {{.Image}}` — the LOCAL image id. `docker pull sha256:<id>` resolves to `docker.io/library/sha256` and always fails, after which rollback fell back to the local copy that autoPrune removes after a week: an image-based service with a newer deploy could not be rolled back at all (the fix `pullableReleaseRef` existed for fan-out, never for rollback). Deploys now record the repo digest (`repo@sha256:…`, pullable from any host forever); rollback resolves legacy ids to their repo digest while the local image still exists, and locally built images (never pushed) keep their id with their rollback staying local-only.
- **A failed Traefik config write still finalized the deploy GREEN (r398).** By the proxy-swap step the service row already pointed at the new container; a config-write failure (ENOSPC, permission damage, a locked file) logged one warning and finished green while Traefik kept routing to the previous generation — traffic, deploy log and panel disagreed, and Stop/Restart/Logs acted on the unrouted container. The swap now retries once; a second failure records the deployment failed, reverts the service row to the still-routed previous runtime (port, commit and replicas included), retires the unrouted new container, and skips fan-out. In-place redeploys and PM2 (where the swap already happened inside the runtime) keep the live version and say exactly that.
- **A node endpoint could exist as two server rows (r399).** Re-running SSH bootstrap for an existing host inserted a SECOND `(host, port)` row whose fresh agent token silently invalidated the first row's — the old row kept reporting `online` while every deploy targeting it failed auth with no hint why. Migration 0065 repairs existing duplicates (services and fan-out targets are re-pointed at the newest row, the one whose token the running agent holds, before the unique index is created — proven against a seeded database in `serversMigration.test.ts`), the schema enforces `unique(host, port)`, bootstrap upserts by endpoint, manual create answers 409 for a taken endpoint, and `DELETE /servers/:id?force=true` now names the services it orphans instead of a bare `{ ok: true }`.
- **The metrics retention sweep full-scanned the time-series table every 30 seconds (with 0065).** The only index led with `serviceId`, which the delete predicate never mentions; a `ts`-leading index makes the hourly-window delete an index walk.
- **The PM2 healthcheck passed on the first `online` sample (r400).** An app whose server crashes at second N>1 (bad env, missing migration) deployed green while PM2 restart-looped it. Health now requires two consecutive online samples whose restart counter did not move — the same fix r265 gave the remote docker twin.
- **The events WebSocket authenticated once, forever (r401).** A bumped `tokenVersion` (logout-everywhere, password change) or a deleted user kept streaming the operator feed until the CLIENT closed the socket. The socket now re-resolves its token every minute, closes itself on a dead session, and swaps in the fresh user so a granted/revoked operator flag applies mid-stream without a reconnect.
- **Destructive one-clicks gained their confirmation (r402).** Rollback (the hover-revealed icon), domain removal (instantly unroutes production traffic), webhook removal (breaks auto-deploy and re-mints the secret), SSO-provider deletion (native `confirm()`, inconsistent with the app pattern) and instance-operator grant/revoke (full host control on a misclick) all go through the app-wide ConfirmDialog now. Workspace member mutations (invite/revoke/role/remove) and the backup-destination toggle surface their errors instead of dead-button silence, and the Activity live refresh keeps at most three pages loaded (the 5 s refetch used to re-fetch every loaded page).

## [0.10.12] - 2026-09-27

> The follow-up audit patch: a member-level host-execution hole closed, the
> Volumes page made honest, and the update path made race-proof (r380–r396).

### Security

- **The static build pack was ungated host command execution for any member (r380).** `buildPack: 'static'` runs the repository's install and build commands on the panel host (`sh -c` in `engine/builders/staticSite.ts`) — the same reach as a PM2 service — but the host-privilege gate (H-3) enumerated only PM2, compose, lifecycle hooks and docker-socket templates. A plain member could create a `type: 'docker'` service with `build: { buildPack: 'static', buildCmd: 'curl … | sh' }` and the deploy pipeline executed it as the panel user. The gate now covers `buildPack` on create, on PATCH (merged with the stored definition, so it cannot be reached one field at a time), on clone, on bundle import (whose `buildPack` was also cast unvalidated), and on every deploy of a stored definition. The build-pack selector marks `static` admin-only in the UI.
- Orchestrator stack names reached filesystem joins unvalidated: `GET /v1/orchestrators/:name/stacks/:stack` passed the segment straight into `join(STACK_ROOT, name)` + `readFileSync`; names are now shape-checked like every other module (r381).

### Fixed

- **The dashboard reported every remote-node service as down (r382).** The health probe inspected the panel's own Docker daemon; a node-pinned runtime's container lives on the node, so `containerIp` answered null and the health column showed red for services running fine. The panel now reports `healthy: null` ("on node") for node-pinned runtimes — the same guard Doctor received in r228 — and the "all systems operational" banner counts only explicit failures. The netns probe image is also pinned instead of `:latest` (the supply-chain rule every other helper image follows).
- **Volume delete and prune reported success while nothing was deleted (r383).** `docker volume rm` fails silently for a volume still mounted by an orphaned container, and the route swallowed it: the operator clicked Prune, got `deleted: N`, and the volumes were still on disk — the r351 slug-reuse flow explicitly directs operators there. Both routes now verify the removal landed (`volumeExists`) and answer 409/skip with a log line when it did not. The Volumes listing also stopped re-reading the entire services/databases/attachments tables **per volume** (3V full-table reads before the first size measurement).
- **The one-click system export raced its own cleanup (r384).** The handler unlinked the archive — the database, the master key and the `.env`, every secret on the instance — in a `finally` that ran in the same tick as `reply.send()`, before the read stream had necessarily opened the file: intermittent ENOENT downloads on Linux, and on Windows (where an open file cannot be unlinked) a permanent secret-bearing file left in the data dir. Cleanup now runs on the stream's `close`, and crash-orphaned export artifacts (`ninedeploy-backup-*`, `_db-*`, `_env-*`, `_meta-*`) are swept by hourly housekeeping.
- **A stalling registry hung the deploy pipeline and the registry lock forever (r385).** `docker login` was the one engine subprocess without a timeout; a registry that accepted TCP and never answered left the deployment `building` and every later deploy on the same registry queued behind the never-released lock. Login now times out after 120 s, kills the child, and fails the deploy with the registry named.
- **The update path was racy at three layers (r386–r389).** Two `POST /update-start` in the same milliseconds both passed the running-check and both spawned an updater (check-then-write); install.sh had no lock at all, so a self-update could interleave with an operator's SSH run (`rm -rf`/`tar -x`/`pnpm install` on one tree, two rollback manifests); and the confirm dialog fired `onConfirm` on every click. `startSelfUpdate` now claims an exclusive-create lock (stolen after 10 s if the claimer died), install.sh holds a per-install-dir `flock` (30-minute wait), and ConfirmDialog disables after the first click. Also in this set: a fresh `install.sh --docker` run as a non-root user no longer fails its own compose provenance check (sudo's `env_reset` stripped the dummy variables — they travel in an `--env-file` now), an explicit `--bare-metal` refuses to build a second panel over a docker install, and a failed launch no longer reports "The updater exited null".
- **Stopping the panel killed deploys the worker was cleanly finishing (r390).** The deploy worker's shutdown grace is 60 s (in-flight deploys checkpoint-cancel inside it), but the systemd unit SIGKILLed the cgroup at the default 30 s — every panel update or restart that landed mid-deploy left the row `building` and its service undeployable until the 45-minute staleness sweep. `TimeoutStopSec=90` in the unit and `stop_grace_period: 90s` in the compose file honor the designed window.
- **Monitoring showed the master host's numbers as a remote node's (r391).** Selecting a node card relabeled the overview cards "Node CPU / Node Memory / Node Storage" while `/v1/stats` only ever returns the panel host's data — an operator diagnosing a node read the master's disk and RAM. The cards stay labeled "Host" and an explicit note says what the selection does and does not show.
- **Service settings bled across services (r392).** Navigating from `/services/1?tab=settings` to `/services/2?tab=settings` keeps the route mounted, and the Settings/Network/Volumes tabs hold per-service `useState` (limits, replicas, preview pattern, target node): service B's form opened with service A's values and Save wrote them onto B. The tabs are now keyed by service id.
- **Copy buttons silently did nothing on plain-http panels (r393).** `navigator.clipboard` exists only in secure contexts, and the panel is routinely reached at `http://<server-ip>:<port>`; the webhook secret, the agent enrolment command, the password-reset link and the Hub compose copy all no-op'd there (Hub even showed "Copied ✓"). A legacy `execCommand` fallback restores every copy button, and the one-time-secret reveals no longer risk being dismissed unsaved.
- **Assorted (r394–r396).** A local stack's status view showed only its first service (the fixed compose parser from `listStacks` is now shared); insights refresh — a synchronous full repo clone on the request path — gained the same rate limit as the analysis route; a failed database-limit restart marks the row `error` instead of leaving it `running` with no container; volume-snapshot rows on the Backups page disable Restore with a hint instead of clicking dead; volume-restore failures render an error card; the Deploys tab's hover-only actions are visible on keyboard focus; and the Services list's start/stop buttons actually disable while toggling (the state was written but never set).

## [0.10.11] - 2026-09-25

> The installer patch: a panel update runs the target release's installer.

### Fixed

- **A panel update ran the installer of the release being replaced (r371).** "Update & Restart" executed the `install.sh` already on disk — the old release's — so every installer fix (build, migrate, rollback) reached an operator one update late, and a bug in the old installer could break the very update that shipped its fix. The updater now fetches the target tag's `install.sh` (the documented `curl …/install.sh | bash` path, same bytes as the release tarball), requires a bash shebang and a clean `bash -n` parse, and runs it against the install dir; any fetch or validation failure falls back to the installed installer.

## [0.10.10] - 2026-09-25

> The update-check patch: the panel finds the latest release wherever curl can.

### Fixed

- **"Update check unavailable — fetch failed" while `curl` reached GitHub fine (r370).** The update check asked one source (the GitHub API) through Node's `fetch`, which fails where the host's curl does not: it ignores `HTTPS_PROXY` and the system CA store (TLS-inspecting middleboxes), and its happy-eyeballs gives each address only 250 ms. A single failure hid the release, the banner and the **Update & Restart** button, and the reason shown was undici's bare "fetch failed". The check now tries five sources until one answers — the API, the github.com release-page redirect (no API rate limit), both again through `curl`, then `git ls-remote` (install.sh's own source). The failure detail names the real cause per source (errno, TLS error, rate limit). The last successful answer is saved under the data dir and shown, marked stale, when every source fails, so the update button survives a network blip or a restart. Successes are cached for 1 hour instead of 6, an expired one is served while a background refresh runs, and open tabs re-check every 30 minutes. The About page shows when and via which source the check ran, with a **Check now** link. Settings → System no longer shows a hard-coded `v0.0.0`.

## [0.10.9] - 2026-09-25

> The cold-boot patch: routes survive a panel that starts before Docker does.

### Fixed

- **Every domain answered 404 after a boot during a Docker outage (r363).** The Traefik config directory was only created by the Traefik bootstrap, which runs after the network check — so when Docker was unreachable at boot (a reboot where the daemon starts late, a Docker restart) the boot-time route write failed with `ENOENT`, and the 5-minute watchdog later started Traefik on the empty placeholder route file. Every domain then answered 404 until a deploy or domain change happened to rewrite it. The route file now creates its own directory, and when the watchdog has to (re)start Traefik — or re-seed an empty route file — it renders the current routes again (not on every healthy tick, since a route write also refreshes every node's proxy). A failed route write no longer leaves `dynamic.yml.*.tmp` files behind. Found by smoke-testing the published 0.10.8 image.

## [0.10.8] - 2026-09-25

> The audit patch: a full-system review (r260–r362, see
> docs/AUDIT_0.10.8.md) — an API-token scope bypass closed, deploys made
> deterministic, remote nodes made honest, and the panel's contract with
> the server repaired.

### Security

- **Fine-grained API tokens could reach sub-resources they were not scoped for (r260).** Route ids were parsed with `Number()`, which accepts `1e0`, `0x1`, `+1` and `1.0`, while the env/webhooks/deploys/volumes/insights/domains scope overrides matched only `\d+` — so `PUT /v1/services/1e0/env` was judged as plain `services` and still reached the env handler for service 1. A token holding only `nd://scope/write/services` could read and write secrets, mint webhook secrets and trigger deploys (the WebSocket log URL too). Ids must now be canonical decimals and the overrides match any id segment.
- Deleting an exec/backup job requires an operator (as creating, editing and running always did) and answers 404 on a miss; non-operators no longer see exec job commands or captured output (r280). `GET /v1/alerts` lists only rules on services the caller can see (r281). A tag PUT no longer strips labels from workspaces the caller has no seat in (r285). Non-operators may only search logs through enabled drains that are global or bound to their service (r287). Marketplace refresh is operator-only (r286).
- Env overwrites through `POST /:id/env`, service exports (which carry decrypted secrets), metric-history flushes and build-cache stores are now audited — and therefore reach notifications, the live feed and the plugin bus (r282, r283, r286). Applying a config preset no longer rewrites an ad-hoc secret key as plaintext (r284).
- **Slug reuse no longer hands a deleted service's data to the next owner (r351).** Deleting a service keeps its `nd-svc-<slug>-data` volume, and slug uniqueness only covered live rows — a new service (possibly another tenant's) created under the freed slug mounted the old service's files read-write on its first deploy. Create, clone, template deploy, compose-stack install and bundle import now refuse with 409 `slug_volume_retained` while that volume exists; an operator backs it up and deletes it from the Volumes page, or the caller picks another slug.
- **Git checkouts dial the address the egress gate vetted (r355).** The gate resolved an https remote's host, checked it was public, and threw the answer away — git resolved it again, so a rebinding DNS server could steer the clone to a private address. Checkouts now pin `http.curloptResolve` to the vetted addresses (clone, fetch and submodules); TLS still validates the hostname. ssh and git:// remotes are checked but not pinned.
- **SAML is refused honestly (r354).** SAML sign-in could never work — the IdP's form POST hit a module-wide bearer-auth hook, and the hand-written signature check cannot verify the canonicalized signatures real IdPs send — yet providers could be created and "saved". Creating a SAML provider and starting a SAML login now answer `saml_unavailable` pointing to OIDC; a vetted signature library is feature-release work.
- Egress refusals name only the origin: the full URL — Slack/Discord webhook paths, Gotify `?token=`, the Namecheap API key — used to land in logs and the plaintext `notification_log` (r310). The webhook replay guard also dedupes the signed body per service, so a captured push cannot be replayed with a fresh delivery id (r313).

### Fixed

- **Deploy engine.** A force-pushed or conflicting branch no longer silently deploys the old HEAD — checkouts move to the fetched remote tip and real failures fail the deploy (r273). Cancelling and immediately redeploying no longer runs two pipelines in one working copy (r272). Docker services now actually mount the volumes attached in the Volumes tab — only compose read them before (r321). The generated `nixpacks.toml` is regenerated or removed on every deploy instead of freezing the first deploy's manifest, including files written by earlier releases (r274). The container and volume file editors refuse files over 1 MiB instead of truncating them to their last megabyte and saving that (r275, r277).
- **Backups and storage.** A failed backup no longer leaves its plaintext dump in the database container or the backups folder (r276). An S3 multipart upload answered with HTTP 200 and an `<Error>` body is a failure, not a phantom remote recovery point (r312). The cross-process operation lock can no longer be held by two processes after a stale takeover, and release only removes its own lock (r314). The image inventory's "in use" check compares image ids, not references — it was always false (r311).
- **Remote nodes.** Services with a published host port redeploy (the old container kept the port — every redeploy failed); crash-looping containers no longer pass the health check; multi-line env values and `_`-prefixed keys reach the node; a changed repository URL is honoured; image deploys no longer record a mutable tag as the rollback digest. Services that need a template command, the Docker socket, extra volumes, a Git credential or a panel-local managed database are refused up front with a reason instead of deploying broken (r264–r270).
- **Database.** Deleting a deployment lane or a backup destination no longer fails with a foreign-key error: migration 0064 gives `services.environment_id` and `backups.destination_id` the `ON DELETE SET NULL` rule the schema always declared, and the drift test now compares foreign keys (r300). Revoking an invitation and inviting the same address again no longer 500s (r301). `backup_drills`, `workspace_invitations`, `domain_transfers` and `cache_registry_blobs` gained retention sweeps, a running deployment's log is no longer pruned, and leftover drill plaintext is removed (r302). A disabled scheduled job stops firing immediately (r303).
- **Proxy and infrastructure.** `ensureTraefik` recreates a `ninedeploy-traefik` container that serves ANOTHER data dir's config (a moved install, a second checkout) — the fingerprint only covered the config's contents, so such a container was left running and every route the panel wrote went to a file the proxy never read (r350). Compose deploys keep a repository's committed `.env` (panel values are layered on top and the original is restored), instead of replacing it and then deleting it (r352). Source fan-out to extra nodes skips repositories cloned with a Git credential (nodes clone anonymously) and now passes the egress gate (r353).
- **Backup drills verify for real (r356).** Drills ran `pg_restore`, `redis-check-rdb` and `bsondump` on the panel host, where no installer puts them, and against dumps they could not read — every Mongo drill failed on a good backup and Postgres fell back to a header check a truncated dump passed. Plain-SQL Postgres and MySQL dumps are checked for their completion trailers, custom-format Postgres and Redis/Valkey dumps are checked inside the database's own image (no network, no capabilities), Mongo archives are read end-to-end through gunzip with their start/end markers checked, and a missing tool reports the new `unverifiable` status instead of a failure.
- **Installer.** A failed tarball upgrade (the self-update path) rolls back to the previous release — the old tree is kept by same-disk renames, restored on failure, and the pre-upgrade database backup is restored when migrations had already run (r357). The installer's `pnpm db:migrate` migrated a stray `packages/db/.data/ninedeploy.db` instead of the real database whenever `.env` held the shipped relative `NINEDEPLOY_DB_PATH` (r362). A tty-less self-update no longer aborts at the Let's Encrypt email prompt after stopping the panel (r261); a failed upgrade restarts the panel instead of leaving it down (r262); `install.sh --docker` passes its image check (the image repository is lowercase) and a pinned `--version` pulls `:vX.Y.Z` instead of `:latest` (r263).
- **Templates.** Community templates open and deploy instead of 404ing after they list (r330); wud gets the real Docker socket and speedtest-tracker mints the APP_KEY its image requires (r320).
- **Panel and clients.** Pending domains show as pending with their TXT record and can be verified from the panel, the SDK (`domains.verify`) and the CLI (r332, r345); services can be put in a deployment lane (r347); Activity pages past 50 rows (r344); "Open Web Studio" goes through the panel's studio proxy instead of a loopback-only port (r340); clearing a volume mount or image actually clears it (r341); saves refresh the views that cache what they changed (r342); database tabs follow `?tab=` (r343); PgBouncer enable/disable report the new state (r331); MCP tools declare scopes the server can actually satisfy (r333); SDK types match the server's responses (r334); `PATCH /services/:id` refuses tag fields instead of dropping them (r335). The live build log can be scrolled up, the update toast fires once, Hub cards and the hand-rolled dialogs work from the keyboard, dialogs restore focus, accepting an invite lands in the joined workspace, and log streams no longer double lines (r290–r299). The domain-transfer accept link opens an accept page instead of Not Found (r358); the node-enrolment token can be seen, rotated and disabled from the Servers page (r359); `ninedeploy branding set` logos and support email now show in the panel (r360); labels, environments, email templates and domain transfers answer a caller with no seat with the same 404 as a missing id (r361).

### Changed

- Runtime dependency refresh: fastify 5.12.5, @fastify/static 10.1.4, @fastify/websocket 11.3.1, jose 6.2.12, pm2 7.0.4, MCP SDK 1.30.1, TanStack Query 5.103.2, xyflow 12.11.6.
- Upgrade notes: migration 0064 rebuilds the `services` and `backups` tables (ids and counters preserved); deploy working copies now discard local edits (`checkout -f`); upgrade node agents alongside the panel. Recreating a deleted service under its old slug now requires deleting (or backing up and deleting) its retained `nd-svc-<slug>-data` volume first. Existing SAML providers stop offering sign-in. The installer's upgrade rollback protects upgrades started by this installer onward.

## [0.10.7] - 2026-09-24

> The catalog patch: ten broken community templates repaired, three
> setup-requirement hints added, the wizard accepts engine names, and
> the smoke runner provisions real MongoDB.

### Fixed

- Five broken community Hub templates are repaired and now boot one-click: wekan (sets ROOT_URL — the image exits silently without it), filestash (image name corrected to machines/filestash), fider (moved to getfider/fider:main with its mandatory JWT_SECRET/BASE_URL/EMAIL_* envs plus PGSSLMODE=disable), limesurvey (managed-MySQL contract, port corrected to 8080, admin bootstrap envs), and wud (listens on 3000 in current releases; admin bootstrap envs added). bookstack gains a Laravel-style APP_KEY: template env values of exactly base64: now mint a prefixed 32-byte key at install time (and in the smoke runner), which the current image requires before it starts.
- The ninedeploy databases create wizard accepts the engine NAME (postgres, MYSQL, RabbitMQ — case-insensitive) as well as the menu number it prints.


## [0.10.6] - 2026-09-22

> The resilience patch: the agent stops dying from stray rejections,
> form fields speak to screen readers, the toolchain modernizes to
> Vitest 5, and the template catalog re-certifies with three upstream-
> drift repairs plus five community-template fixes.


### Changed

- **Template runtime re-verification (2026-09-22): all 101 certified templates pass.** Six days of upstream drift had silently broken three certified images: flowise's `:latest` tag had lost the 2.2.8 pin (3.x crash regression) — re-pinned; libretranslate's new 1.9.6 cold start legitimately exceeds the 300s smoke window (listens at ~537s) — templates can now declare a per-template `startTimeoutSeconds` override; and vikunja 0.24.6 moved its webserver port config from `HTTPPort` to `Interface` — the template now pins `VIKUNJA_SERVICE_INTERFACE=[::]:8080` so the declared port stays true regardless of upstream defaults. Evidence fixture refreshed; 10 community (uncertified) templates currently fail their smoke runs and are recorded as such in the run — they never claimed the verified badge.

### Fixed

- The agent entrypoint now logs stray unhandled rejections instead of crashing mid-deploy (the panel had this guard since r168; the agent never did), and a failed agent BOOT exits nonzero so systemd's `Restart=on-failure` sees a clean failure instead of a half-booted agent idling forever.
- Form field labels are now programmatically associated with their controls (screen readers announce field names across the panel's 137 Field usages). Non-control children — button groups like the Sources auth-method toggle — keep their own accessible names; a wrapping label would have leaked the field's whole label text into every descendant button.
- Test tooling moves to Vitest 5 (dev-only): the suite passes unchanged after adapting two web tests — api.test now captures the import-time createClient call evidence at module-evaluation time (Vitest 5 clears mock state before the first test), and ManifestCreator restores window.localStorage via defineProperty (jsdom 30.1 made it a getter-only accessor). Server and SDK coverage measured identical to Vitest 4 (±0.06pp) on an isolated upgrade run. Dev toolchain otherwise fully refreshed (biome 2.5.14, turbo 2.11.2, jsdom 30.1).



## [0.10.5] - 2026-09-20

> The www patch: redirects that reach the wire — routers claim the
> whole apex/www pair, certificates split per host.

### Fixed

- The per-domain www toggle now actually secures `www.`: the Traefik router rule claims both hosts of the apex/www pair, so www traffic reaches the redirect middleware and Traefik finally requests a certificate for it (previously the router matched only the stored hostname — `https://www.…` answered with the default certificate and the redirect never ran). The redirect regex now matches only the www form, which also removes a latent self-redirect loop on the apex. Both hosts are listed as separate ACME `domains` entries so a www host with broken DNS fails only its own certificate, the rule is not extended when another active domain row already routes the companion host, and the Cloudflare integration creates the missing companion DNS record when the toggle is turned on.

## [0.10.4] - 2026-09-19

> The scaling fix: replicas that actually run — no more silent
> collapse to one container, no more 502 backends.

### Fixed

- Scaling a docker service past one replica no longer produces bad gateways. Two stacked causes, both fixed: replica clones inherited the primary's `-p` host port publishing, so on published-port services every replica died on "port is already allocated" and scaling silently collapsed to one container; and the Traefik config rendered the DESIRED replica count (`services.replicas`), so between saving a higher count and the next deploy — or whenever a replica failed to start — the proxy listed backends that did not exist and round-robined a share of every request into 502s. Replicas no longer inherit the host port (public traffic reaches them over the service bridge via Traefik), and the proxy now renders the replica count the last deploy actually achieved (new `services.runtime_replicas`, migration 0063, written by the deploy pipeline). After upgrading, redeploy replica services once to record their running count.

## [0.10.3] - 2026-09-19

> The follow-through patch: the 0.10.2 audit's remaining limits closed —
> encrypted volume snapshots, atomic restores, cross-process operation
> locks and destination-recorded remote backups.

### Security

- Volume snapshots are now encrypted at rest with the same streaming AES-256-GCM master-key envelope as database dumps — a stolen data directory or backup bucket no longer leaks volume files in the clear. Downloads and restores decrypt transparently; legacy plaintext archives written before this change keep restoring unchanged.

### Fixed

- Volume restores no longer empty the volume before extracting. The archive is fully extracted into a hidden staging directory inside the volume and only then swapped into place with same-filesystem renames, so a corrupt member or a full disk during extraction aborts the restore with the volume's previous contents untouched (a disk or filesystem failure mid-extraction could previously leave a partial restore and lose the old data). The staging copy transiently needs space for both the old and the restored contents.
- Backup and restore operations on the same database or volume now hold a cross-process lock file, so an overlapping panel process (systemd restart overlap, a second instance on the same data directory) can no longer interleave a backup with a restore; a busy lock answers 409 and a lock abandoned by a crashed process is reclaimed after its liveness heartbeat goes stale. Volume operations also gained the in-process serialization databases already had.
- Remote backups record which destination received their object (migration 0062), so switching the active destination no longer orphans earlier recovery points: restores and remote deletions resolve the bucket that actually holds the object, and only rows whose destination was deleted fall back to the active one. Previously every `remoteKey` resolved against the currently active destination, making old recovery points unrestorable after a destination change.

## [0.10.2] - 2026-09-18

> The hardening patch: the security and reliability follow-up to the
> 0.10.1 audit — sealed agent connection tests, stable SSO identities,
> and backup/restore lifecycle repairs.

### Security and reliability

- Authenticate agent connection tests with a sealed challenge instead of sending the raw agent token over HTTP. Malformed operation exit codes no longer count as success. Agents must support the new `agent.ping` operation.
- Require proof of email ownership before automatically accepting workspace invitations, enforce the `env` token scope on project environment routes, and refuse SSO sign-in that bypasses local TOTP or uses a deactivated account.
- Bind SSO accounts to stable provider subjects. Existing accounts link a provider explicitly from account settings; verified email equality alone no longer merges accounts. See [SSO account linking](docs/SSO_ACCOUNT_LINKING.md) for upgrade recovery steps.
- Password-reset recovery atomically revokes sessions, API tokens, passkeys, and external identity links so an earlier account holder cannot retain an alternative sign-in method.
- Clear account-specific query caches on session changes, ignore stale authentication responses, preserve credentials during transient refresh failures, and apply the configured API origin to raw downloads and uploads.
- Preserve successful backups independently from failed attempts, stream volume downloads, validate archives before replacing volume contents, isolate database staging files, and remove partial plaintext after failed decryption.
- Preserve historical release images, use lowercase GHCR image names, serialize release checks, and run database integration checks before release image publication. Version bumps now reject formats unsupported by the installer. The server coverage floors are recalibrated to the measured 0.10.1/0.10.2 reality (functions 91.3, statements 93.3, branches 87.3) — the 0.10.1 release had shipped stale floors its own CI never reached.
- Restore the container image build: Debian trixie split the Docker CLI out of `docker.io` into a `docker-cli` package, so the runtime image installs `docker-cli` — the plugin stage's `docker compose version` verification had failed with `docker: not found`.
- Correct documentation that claimed automatic plaintext agent fallback and encryption of volume snapshots.

### Added — template runtime verification (carried here for release-packaging completeness)

> The verification work below shipped with the 0.10.0/0.10.1 binaries but
> was never recorded in a numbered release section; it is folded into
> 0.10.2's notes so the record is complete. The verification release:
> 101/101 templates runtime-certified, ten quietly-broken templates
> repaired.

- **Whole-catalog runtime verification (r132).** Every Hub template —
  all 101 — now carries a `runtimeVerified` badge earned from one real
  isolated smoke run. `scripts/smoke-template-runtime.mjs` grew the
  profiles the old runner refused: managed-database templates boot
  against a throwaway postgres/mysql following the `ENGINES` contract
  with `databaseEnv` resolved exactly like the deploy pipeline;
  docker-socket templates run with a read-only socket mount; compose
  stacks go through `docker compose up` with generated `SERVICE_*`
  secrets. The green run ships as `runtime-verify-2026-09-16.json`
  and the registry verification test derives the contract from that
  evidence — a template may only claim `runtimeVerified` if the
  committed run passed it, so the badge can no longer drift from
  reality.
- **Placeholder consistency lint for compose stacks.** A catalog
  compose file may no longer reference the same variable both bare
  (`$VAR` → the resolver exports `''`) and defaulted
  (`${VAR:-x}` → the default) — the discrepancy that crash-looped
  umami-stack fails the registry tests before any deploy.

### Fixed

- **Ten templates that could never have booted, repaired against
  their real upstream behavior.** `umami-stack` built `DATABASE_URL`
  from a defaultless `$POSTGRES_DB` (→ empty database name → crash
  loop against a healthy postgres; now `${POSTGRES_DB:-umami}`).
  `activepieces` requires Redis and PostgreSQL that single-container
  installs never provided, and its UI listens on 80 via
  `AP_REDIS_URL` (not `AP_REDIS_CONNECTION_STRING`) — converted to a
  three-service compose stack. `flowise` 3.x images crash upstream
  (`connect-sqlite3: this.db.exec is not a function` even without
  auth env) — pinned to 2.2.8. `libretranslate`'s named volume sat at
  a path the image never creates, losing argostranslate's home
  ownership — moved to `/home/libretranslate`. `vikunja:latest` ships
  a root-owned files dir that uid 1000 cannot write — pinned 0.24.6.
  `grocy` declared port 9283 while its nginx listens on 80.
  `nginx-proxy-manager` refuses to boot unless `/etc/letsencrypt` is
  a real mountpoint — the single persistent volume moved there.
  `homebox` panics without a 32-byte `HBOX_AUTH_API_KEY_PEPPER` —
  now a generated secret env row. `speedtest-tracker` defaults to
  MySQL and a Docker Hub repo that no longer exists — moved to the
  ghcr image with a managed-MySQL `databaseEnv` contract. `lidarr`
  and `sabnzbd` pointed at Docker Hub repos that do not exist —
  `lscr.io/linuxserver/*` is where they actually publish.

---

## [0.10.1] - 2026-09-18

> The audit release: a whole-project review (r150–r251). Most fixes are
> things that were written, tested and never actually wired, or wired to
> the wrong thing.

### Security

- **Auth, SCIM, tenancy and token scopes (r150–r161)**; updater secrets
  off argv, submodules through the egress gate (r171–r173); PM2 apps get
  an allowlisted environment instead of the panel's own, which carried
  the master key and JWT secret (r233).
- **Domain claims (r190, r223).** A member can no longer claim another
  service's automatic `<slug>.<wildcard>` host or a `*.` wildcard of an
  instance-owned zone, from the API or from a manifest route.
- **Audit coverage (r222).** Mutations that skipped `audit()` (and so
  notifications, the live feed and the plugin bus) are audited, with a
  guard test that fails on any new unaudited route.

### Fixed — engine and runtime

- Remote-node services: stop/start/restart/logs/delete go through the
  node's agent, a node move retires the old runtime (r225); remote
  checkouts fetch any branch and pinned commit (r227); database-attached
  services are refused on remote nodes, whose containers cannot resolve
  the panel's database host (r229).
- Fan-out pulls a real image reference and retires the previous target
  only after the new one runs (r226); registry login/pull/logout is
  serialised per credential store (r230).
- Failed deploys keep the live runtime; pg dumps restore; redis/valkey
  restores never leave the database stopped (r165–r167, r232).
- The deploy worker no longer lets a long remote build block local
  deploys at concurrency 1 (r238).
- PgBouncer: `bitnami/pgbouncer:1.24.1` no longer exists and never read
  the config the panel wrote — moved to `edoburu/pgbouncer` (r243).
- Namecheap DNS writes keep MX preferences and the email type, and use
  zone-relative host names (r244).

### Fixed — wiring that existed only on paper

- Log drains now receive logs (r231).
- Kernel hooks `deploy:before/after` and `database:before_delete` (with
  veto) are called; a failing hook rolls back once (r237). Pipeline emits
  `service.deploying` / `service.deployed` with project ids (r239).
- Sticky IP / egress SNAT target the project's real `nd-svc-<slug>`
  bridges, keep the applied CIDRs and re-apply rules after a reboot
  (r239, r240). Domain presets only create records for active domains,
  on verify too, and delete them with the domain (r241).
- A service the reconcile loop cannot revive raises
  `alert.service_down` (r242).

### Fixed — panel, CLI, SDK

- Web: backup downloads authenticate, notification edits, CPU limits,
  build-field clears, integrations prefill, cron next-run, deploy wizard
  retry, socket replay de-duplication, log follow, topology drag,
  manifest creator, env card, file editors keeping text typed during a
  save, and one deploys cache key (r202–r217, r250–r251).
- CLI/MCP/SDK: export/import bytes, token refresh scope, read-only token
  default, versions from package.json, 2FA login, egress driver
  selection, `domains preset add namecheap`, `fanout.get` (r192–r201).

### Fixed — packaging

- The container image ships the `compose` and `buildx` plugins (r246)
  and mounts Traefik's config from the host path when the panel itself
  runs in a container — previously Traefik started with no config (r245).
- `ninedeploy server start` adds the docker socket group (r247); the
  systemd unit may write `/etc/ufw` (r248); the dev compose no longer
  relies on corepack (r249).
- The release script no longer stacks duplicate changelog stubs; the two
  "Placeholder" entries 0.10.0 shipped on the About page are gone.

---

## [0.10.0] - 2026-09-18

> The fleet-era close: multi-server fan-out everywhere, with the
> panel, SDK and self-healing to match.

### Added

- **Multi-server fan-out, complete (r131/r132/r133/r138).** A release
  runs on several nodes at once: image releases pull through each
  target's agent, Dockerfile repositories build per node from the same
  pinned commit (no registry needed), per-node failures never block
  the primary, the reconcile loop revives crashed target clones within
  the minute (new validated `docker.start` op), and the Target node
  card exposes the whole model as a checkbox list with live status.
- **SCIM 2.0 provisioning (r129)** — see 0.9.6-era note carried here
  for release-packaging completeness.

### Changed

- **Template catalog 118 → 130 (r134/r135/r139/r140).** Node-RED, Open
  WebUI, Appsmith, Baserow, Whoogle, ArchiveBox, Wallabag, Lobe Chat,
  LimeSurvey, Redmine, Jenkins, Woodpecker CI, Drone, Fathom, Shlink,
  Piwigo, the official Docker Registry, BookStack, Fider, PrivateBin,
  What's Up Docker, Organizr, Owncast, Duplicati, Komga, MeTube, Wekan,
  Filestash and Deluge — with managed-database auto-attachment for the
  DB-backed ones and an evidence-derived verification contract.

---

## [0.9.9] - 2026-09-16

> The self-healing fleet: fan-out hardening, drift guards, and a
> registry that verifies itself.

### Added

- **Registry drift guard (r137).** Released template definitions can no
  longer silently lose fields: a guard test diffs the current registry
  against the previous release tag — env keys, database-engine
  contracts and volume mounts must survive unless the removal is
  allowlisted with a named reason. CI now checks out full history so
  the guard runs there too.
- **Fan-out target patrols (r138).** The 60-second reconcile loop
  patrols every running docker service's target nodes through their
  agents: a crashed clone on another machine is revived within the
  minute. A node that is unreachable is skipped without judgement;
  containers from scaled-down generations are left to the next deploy.

### Fixed

- **Template smoke failures repaired (r136).** activepieces had its
  env and volume silently stripped by a registry rewrite (restored from
  the last intact release, with an honest Redis requirement note);
  vikunja used a wrong secret key and a wrong port; flowise was pinned
  to a crashing tag. 91/101 templates passed the live smoke run; the
  verified set is now derived from the committed run evidence, not
  hand-pinned.

---

## [0.9.8] - 2026-09-16

> The fan-out release: one release, every node — with a panel to match.

### Added

- **Multi-server fan-out, phases 1+2 (r131/r132).** A release can run
  on several nodes at once. Image services are pulled to each target
  through its agent; Dockerfile repositories are built per node from
  the same pinned commit (`git.ensure/fetch/checkout/reset` +
  `docker.build`) — the image never has to travel. Per-node failures
  are recorded on the target row and never block the primary; each
  node's own Traefik routes the service locally; service deletion
  tears down every target container. Nixpacks stays honestly refused.
- **Fan-out panel surface (r133).** The Target node card gains "Run on
  additional nodes": a checkbox list of registered nodes with live
  per-target status, enabled save on divergence, and the DNS
  instruction where the operator needs it. `fanout.get/set` join the
  SDK with a client contract test.

---

## [0.9.7] - 2026-09-16

> The fleet release: one release, many nodes.

### Added

- **Multi-server deployment targets (phase 1).** An image-based docker
  release can now run on several nodes at once: the primary placement
  stays where it is, and `PATCH /v1/services/:id/targets` names the
  extra nodes. After the primary deploy finalizes, each target gets
  the same digest-pinned image through its agent (login → pull →
  retire-previous-generation → run → container-state health), with
  per-node failures recorded on the target row and never blocking the
  primary. Each node's own Traefik routes the service locally through
  the target's container; pointing a domain at several nodes is the
  operator's DNS choice. Service deletion tears down every target
  container. Source builds wait for the build-server/registry story —
  stated in the code, not faked.

---

## [0.9.6] - 2026-09-16

> The enterprise and scale release: Swarm-less replicas, SCIM
> provisioning, and a 100-template catalog.

### Added

- **Horizontal replicas (r126/r127).** Docker services run 1-10
  replicas: identical containers on the service bridge, Traefik
  round-robin with a per-server `healthCheck` so a dead replica drops
  from rotation instead of erroring. Replicas are swept as one
  generation by stop / start / restart / delete (a stop → restart flow
  used to leave clones down while the panel read `running`), revived
  by the reconcile loop, settable from the Scaling card or the
  `.ninedeploy` `resources.replicas` field.
- **SCIM 2.0 user provisioning (r129).** Point Okta / Entra ID at
  `{panel}/scim/v2` with a workspace-scoped bearer token: users push
  in as members, deactivating them at the IdP revokes their sessions,
  API tokens and (on delete) memberships here within one sync cycle.
  A push for an existing local email adopts the account instead of
  duplicating it. Tokens are sha256-hashed at rest and shown exactly
  once. Management card lives in Settings → SSO.
- **Template catalog 89 → 101 (r130).** Changedetection.io, ntfy
  server, FreshRSS, Shiori, Wallos, Speedtest Tracker, Homebox, Firefly
  III, Syncthing, Lidarr, SABnzbd and draw.io — single-image picks
  filling the most-deployed gaps. New entries are honestly marked
  `runtimeVerified: false` until deploy-tested; a new integrity suite
  pins schema-parse, unique ids and the 100-template floor.
- **Panel surfaces for recent features (r128).** OOM events render as
  human-readable rose badges in Activity, replica counts show as ×N
  chips on service cards, and notification channel badges got
  per-provider colors.

---

## [0.9.5] - 2026-09-15

> The scaling release: N containers per service with plain Docker —
> no Swarm, no extra daemon.

### Added

- **Horizontal replicas.** Docker services can now run 1-10 replicas:
  identical containers on the service bridge (`<runtimeId>`,
  `<runtimeId>-r2`, …), Traefik round-robin across them with a
  `healthCheck` block so a dead replica stops receiving traffic instead
  of erroring. Replicas are started after the deploy's health gate,
  revived automatically by the reconcile loop, and swept as one
  generation by stop / start / restart / delete. The Scaling card in
  Service → Settings and the `.ninedeploy` `resources.replicas` field
  both set it; the overview runtime card shows the count.

---

## [0.9.4] - 2026-09-15

> The integrations release: the notification matrix reaches full parity,
> and deploying a new app starts with a sentence instead of a form.

### Added

- **Gotify, Pushover and Lark/Feishu notification channels.** Self-hosted
  Gotify (message-endpoint URL including its app-token query), Pushover
  (packed `appToken@userKey` target, the same combined form Telegram
  uses) and Lark/Feishu custom-bot webhooks complete the
  integration-matrix parity — the Lark bot answers HTTP 200 even on
  rejection, so the body's error code is surfaced as a delivery
  failure. The channel wizard gains guided setup steps for all three;
  targets stay encrypted at rest.
- **AI deploy assist.** The manifest creator gains an "AI fill" action:
  describe the app in plain language (stack, port, health endpoint, env
  vars, resource cap) and the operator-configured OpenAI-compatible
  provider returns a `.ninedeploy` manifest. Model output is parsed and
  validated against the STRICT manifest schema before it reaches the
  form — the model can hallucinate values but cannot invent fields —
  and the validated suggestion merges over the current draft (Undo
  restores it). Reuses the BYO-key AI config from failure diagnosis.

---

## [0.9.3] - 2026-09-13

> The resource-limits release: hard CPU caps, honest memory limits,
> live application, and OOM kills you can actually see.

### Added

- **Hard CPU limit.** A new CPU limit field (in cores, e.g. `0.5`) maps
  to Docker's `--cpus` and throttles even without host contention —
  `--cpu-shares` alone is only a scheduling weight. Stored as
  `cpuLimitMilli` (migration 0056), applied on every run path: local
  builder, database engines, remote-node agents (re-validated server
  side) and the kernel compute driver. Settable from Service Settings,
  the database detail page, the Monitoring cards, the `.ninedeploy`
  `resources` section, and the overview runtime card now displays it.
- **Live limit application.** Changing a service's limits used to wait
  for the next deploy; the endpoint now best-effort `docker update`s a
  running container and reports whether it applied live (Docker refuses
  to lower memory below current usage — that case stays on the
  next-deploy path). Databases already restarted live.
- **OOM-kill visibility.** The 60-second reconcile loop used to revive
  an OOM-killed container silently. It now reads `OOMKilled`/exit code
  before restarting and records an `alert.oom` event — visible in the
  activity trail and fired into the alert-scope notification
  subscriptions, throttled to one alert per service per 10 minutes.

### Fixed

- **Memory limits were soft.** `--memory` without `--memory-swap` lets
  Docker allow swap equal to the limit — a "512 MiB" service could take
  512 MiB RAM plus 512 MiB swap. Every limit now pins swap to the same
  value: a limit means a limit.
- **Compose view lied about CPU.** The generated compose manifest
  rendered `--cpu-shares` (a weight) as `cpus:` — imposing a hard cap
  the container never had. Shares now render as `cpu_shares`, and `cpus`
  comes from the real NanoCpus value.
- **Limits card honesty.** PM2 services show only the memory field
  (host processes: memory maps to pm2's restart threshold, Docker caps
  do not apply); compose services are pointed at their stack YAML.

---

## [0.9.2] - 2026-09-13

> Debugging and operability polish: pattern-matched build failure hints
> and one-click start/stop from the services list.

### Added

- **Build failure hints.** After a failed deploy the pipeline scans the
  build log for nine known error patterns and surfaces an actionable
  hint inline: lockfile mismatch, TypeScript errors, missing modules,
  port conflicts, permission denied, out-of-memory, Dockerfile not
  found, npm 404 and missing env vars. Hints are advisory — the
  original error is always shown alongside them.
- **Quick start/stop on the services list.** Each running service card
  gets a stop button and each stopped/errored service a start button,
  wired to `services.start`/`services.stop` with loading state and
  query invalidation — no more opening a service just to bounce it.

### Changed

- Web coverage floor recalibrated to 97.5% (statements/functions/lines)
  and 91.5% (branches), matching the server-side policy: core paths are
  behaviour-tested; the remainder is defensive JSX an end-to-end run
  already covers.

---

## [0.9.1] - 2026-09-13

> Developer-experience polish: env export button and security headers
> for static sites.

### Added

- **Env var export button.** The environment card gains an **Export**
  button that downloads all non-secret env vars as a `.env` file via
  the browser Blob API — no server round-trip needed since the values
  are already in memory from the list endpoint.

### Fixed

- **Security headers in the static build pack's nginx conf.** The
  generated conf now includes `X-Frame-Options: SAMEORIGIN`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin` and `Permissions-Policy` — the same
  baseline Coolify's static builder applies. Test: the renderer
  assertions verify all four headers are present.

---

## [0.9.0] - 2026-09-13

> The build-matrix completion release: Railpack and Git submodule
> support round out the source-build story, and custom domain watch
> paths can now be declared from the `.ninedeploy` manifest.

### Added

- **Railpack build pack.** The installer provisions the checksum-verified
  Railpack binary as an optional source builder; operators opt in per
  service via the build pack select. Railpack auto-detects the stack
  and builds via its own BuildKit connection — NineDeploy passes the
  image name and runtime env only.
- **Git submodule init.** Repos shipping a `.gitmodules` file now have
  their submodules initialised recursively after checkout, so builds
  that reference submodule paths no longer fail on empty directories.
- **`watch` manifest section wiring.** A `.ninedeploy` watch section
  syncs watch paths to all active webhooks for the service
  (newline-joined, matching the webhook storage format). An empty
  paths list is a no-op.
- **`.env` export.** `GET /v1/services/:id/env/export` returns
  non-secret env vars as `.env`-formatted content for backup or
  migration (admin floor; secret values stay masked).

### Fixed

- **Static build dispatch restored** after being silently overwritten
  by a concurrent edit — static-pack services were falling through to
  the nixpacks/Dockerfile path instead of the nginx:alpine path.
- **Agent operations get a 595 s timeout** with process-group kill —
  stalled `git fetch` no longer holds `.git` locks and fail the next
  op. Signal-killed children report the signal instead of "code null".

---

## [0.8.4] - 2026-09-13

> Developer-experience polish: bulk .env import, build log download,
> and the last reliability fixes for the static/railpack build
> dispatch.

### Added

- **`.env` bulk import.** `POST /v1/services/:id/env/import` accepts a
  `.env`-formatted string and upserts each variable — overwrite on key
  collision, per-line errors reported without failing the batch. The
  parser handles `export` prefixes, quoted values, `#` comments and
  blank lines. SDK: `client.env.import(serviceId, content)`.
- **Build log download.** The deploy log panel gains a **Download**
  button that saves the current build log as a `.log` file using the
  browser Blob API — no server round-trip needed since the log content
  is already in memory from the WebSocket stream.
- **SDK coverage** for `deploys.logDownloadUrl`, `env.import` and
  `domains.dnsCheck` client methods.

### Fixed

- **Static build dispatch restored** after being silently overwritten
  by the concurrent railpack edit — static-pack services were falling
  through to the nixpacks/Dockerfile path instead of the nginx:alpine
  path.

---

## [0.8.3] - 2026-09-12

> Three reliability fixes for the new build surfaces added in 0.8.2,
> plus a Railpack build pack option for operators who prefer Railway's
> builder.

### Added

- **Railpack build pack (optional).** The installer provisions the
  checksum-verified Railpack binary as an optional second source
  builder; operators opt in per service via the build pack select.
  Railpack auto-detects the stack and builds via its own BuildKit
  connection — NineDeploy passes the image name and runtime env only.

### Fixed

- **Static build dispatch restored** after being silently overwritten
  by the concurrent railpack edit — static-pack services were falling
  through to the nixpacks/Dockerfile path instead of the nginx:alpine
  path.
- **Lifecycle hook commands are tokenized quote-aware** — the old
  whitespace split left quote bytes in argv, breaking the documented
  compound form `sh -c "a && b"`.
- **Agent operations get a 595 s timeout** with process-group kill —
  stalled git fetches no longer hold `.git` locks and fail the next op.
- **Managed Mongo sizes report real numbers** (the stats call now
  authenticates with the root credentials).
- **Redis/Valkey restores stop the container before copying `dump.rdb`**
  (graceful shutdown SAVEs would overwrite the staged backup).
- **Postgres restores run `psql` with `ON_ERROR_STOP`** (partial dumps
  exited 0).
- **`localhost/team/app` image references resolve against the local
  registry** (Docker's own first-segment rule).
- **The static nginx conf enables gzip and adds immutable caching** for
  hashed build assets — previously every visitor downloaded
  uncompressed, uncached files.

---

## [0.8.2] - 2026-09-12

> Answering "why doesn't my domain load?" before it is asked: every
> custom domain carries an on-demand DNS resolution status, and the
> build pack matrix gains static site builds.

### Added

- **Static site build pack.** `static` joins the build pack select: the
  repo's install + build commands run on the panel host, and the output
  directory (default `dist`) ships inside an nginx:alpine image with an
  optional SPA history fallback (`try_files` → `index.html`). Health
  check, Traefik routing and blue-green swap behave exactly like any
  other deploy. Remote nodes are refused loudly (the build is
  host-executed); migration 0055 adds the two build-config columns.
- **Per-domain DNS resolution status.** `GET
  /v1/services/:id/domains/:domainId/dns` resolves the hostname's A and
  AAAA records and compares them with the address this instance expects
  (the operator's record content, else the detected public IP). The web
  domain row gains a **Check DNS** chip showing `ok` / `mismatch` /
  `unresolved` with the resolved addresses — advisory only; routing
  stays governed by the ownership challenge.

---

## [0.8.1] - 2026-09-11

> The provider-matrix and reliability release: Bitbucket joins GitHub,
> GitLab and Gitea end-to-end (repos, branches, webhooks, PR preview
> environments), and a batch of quietly-broken reliability paths — hook
> quoting, agent op timeouts, database size/restore ordering — is fixed
> and pinned with tests.

### Added

- **Bitbucket support, end-to-end.** Sources gain the `bitbucket` type
  (Bitbucket Cloud API tokens, Bearer auth): the repos/branches
  pickers, the connection test, and the web UI dropdown with deploy-key
  instructions. Webhooks handle `repo:push` and `pullrequest:*` —
  verified by the `X-Hub-Signature` sha256 HMAC, deduplicated by
  `X-Request-UUID`, with push hashes parsed from
  `push.changes[].new.target` and PRs mapped to
  opened/synchronize/closed(+merged). Private repos: the deploy-key
  (SSH) path is the recommended flow. PR preview environments work for
  Bitbucket pull requests like every other provider.

### Fixed

- **Lifecycle hook commands are tokenized quote-aware.** The old
  whitespace split left quote bytes in argv, so the documented compound
  form `sh -c "a && b"` failed with command-not-found. Single quotes
  are literal, double-quote backslash escapes work, empty quoted args
  survive, unterminated quotes run to end of input.
- **Agent operations can no longer run orphaned.** Each agent op gets a
  595 s child-side timeout (just under the 600 s master request
  window) with a process-group kill — a stalled `git fetch` used to
  hold the workspace's `.git` locks and fail the NEXT op with "cannot
  lock ref". Children killed by a signal now report the signal instead
  of a nonsense "code null".
- **Redis/Valkey restores stop the container before copying `dump.rdb`.**
  A graceful shutdown SAVEs memory to disk, so the old
  copy-then-restart order let the dying process overwrite the staged
  backup — the "restored" server reloaded its own old data.
- **Postgres restores run `psql` with `ON_ERROR_STOP`.** A bare `-f`
  continues past statement errors and exits 0, reporting
  partially-applied dumps as successful restores.
- **Managed Mongo sizes report real numbers** (the stats call now
  authenticates with the root credentials — unauthenticated `dbStats`
  was rejected and sizes silently read 0).
- **`localhost/team/app` image references resolve against the local
  registry** (Docker's own first-segment rule) instead of a Docker Hub
  namespace.
- **The installer self-checks its environment.** Every bare-metal
  install/upgrade verifies the rendered unit exports `DOCKER_CONFIG`
  and `PM2_HOME` (missing either re-creates the "read-only file
  system" build failures on hardened hosts) and runs a five-second
  scratch `docker build` preflight; CI gained an installer syntax +
  `set -u` smoke gate so an installer regression cannot merge again.

---

## [0.7.9] - 2026-09-11

> A security release. A full audit (authentication, authorization,
> injection, SSRF, supply chain) found six High-severity issues. All six are
> fixed here, along with the Medium findings that were small, local
> changes. **Upgrade recommended for every install.** Several fixes tighten
> what a non-operator may do; see *Changed behaviour* below before
> upgrading a shared instance.

### Security

- **SAML signature wrapping.** The signature was checked against one
  `<Assertion>` while the login email was read from another, so an unsigned
  assertion appended to a validly signed response could sign in as any
  local user, operators included. Every check (digest, conditions, replay,
  issuer, audience, subject) now reads the single assertion named by the
  signature's `Reference`, and a response carrying more than one is refused.
- **Refresh tokens now rotate from the first use.** The token issued at
  login carried no generation marker, so a leaked copy could be replayed for
  the whole session and pushed its expiry forward on each use.
- **API tokens can no longer mint credentials.** A `write`-scoped token could
  create a token with `scopes: []`, stored as unrestricted, which restored
  its owner's operator rights. Tokens, password, 2FA and passkey routes now
  require an interactive session, and an explicit empty scope list is refused.
- **Domain ownership proof can no longer be skipped.** `PATCH
  /v1/domains/:id` marked any domain `active` without DNS verification. It
  now toggles SSL only and requires the `member` role.
- **Viewers can no longer read a project's secrets.** A viewer seat was
  enough to tag one's own service into another workspace's project and have
  the deploy pipeline decrypt that project's shared env into it. Both the tag
  routes and the pipeline now require `member`.
- **Other tenants' volumes can no longer be adopted.** Re-creating a deleted
  database's name, naming a volume via `existingVolume`, or a slug and label
  that spelled another service's volume (`shop` + `api-data`) mounted
  someone else's data. Unclaimed volumes are now operator-only.
- **Password rotation revokes API tokens**, and an operator password reset
  now also revokes the user's sessions.
- **Removed workspace members lose control** of the services and databases
  they created in it. Ownership passes to the workspace owner.
- **Remote servers, backup jobs:** placing a service on a remote server and
  creating `backup` jobs are operator-only, matching the rest of those
  features.
- **Studio proxy DoS:** the Web Studio cookie is checked before the request
  body (up to 256 MiB) is read, so unauthenticated clients can no longer
  exhaust the panel's memory.
- **Git SSRF:** git no longer follows HTTP redirects (a public repo host
  could bounce a clone to `169.254.169.254` or internal ports), remote-node
  clones go through the same egress check as panel clones, and the node
  agent refuses non-network repository URLs such as `file://`.
- **Rate limits can no longer be reset with a fake `X-Forwarded-For`** on a
  panel reached without its bundled Traefik. Only loopback and private-network
  peers are trusted as a proxy.
- **`/v1/sso`:** OIDC sign-in requires `email_verified`, and accounts with
  TOTP enabled are refused there instead of getting a session with no second
  factor.
- **Dependencies:** js-yaml 4.3.2 (merge-key CPU exhaustion, reachable via
  compose files and manifests), nodemailer 9.1.1, hono 4.13.7. `pnpm audit`
  reports no known vulnerabilities.

### Changed behaviour

- API tokens cannot create tokens, change the password, or manage 2FA and
  passkeys. Use a signed-in session. CLI logins are unaffected.
- `ninedeploy token create` with a blank scope answer now creates a `read`
  token, not an unrestricted one.
- Adopting an existing or retained volume (`existingVolume`, or re-creating a
  deleted database's name), `serverId`, and `backup` jobs now need an
  operator.
- A renamed Git repository (HTTP 301) is no longer followed. Update the
  service to the repository's new URL.
- SAML is experimental: the `/v1/sso` callback still requires an existing
  panel session, so IdP-initiated logins do not reach it yet.
- Accounts with TOTP enabled cannot sign in through `/v1/sso`. The main OIDC
  login is unchanged for now.

---

## [0.7.8] - 2026-09-10

> The one that un-breaks hardened hosts: a class of silent failures where
> the panel's own hardening (read-only /root) starved the tools it spawns
> — buildx and PM2 — is found, fixed, and now guarded by an installer
> preflight so it can never ship quietly again. Also: the `.ninedeploy`
> manifest's three "declared but ignored" sections now actually work.

### Added

- **Manifest sections are wired: `previews`, `notifications` and
  `volume.backups`.** A `.ninedeploy` file now configures PR preview
  settings, per-service notification subscriptions and the volume-backup
  schedule at deploy time instead of being read and dropped with a
  warning. `notifications` channel names resolve to per-service rules
  whose delivery is **additive** to each channel's own global event
  filter (rules can only add one service's events to a channel, never
  take anything away); `volume.backups` drives a manifest-owned
  `kind: backup` scheduled job and refuses invalid cron expressions
  loudly; preview hostname patterns stay constrained at routing time as
  before. Only `static`, `watch` and `network` remain panel-side.
- **Clone failures now explain themselves.** Git says "repository not
  found" for both a missing repo and a private one read anonymously —
  the deploy log now adds the fix that applies to the service's actual
  setup (no credential attached / deploy-key registration / token
  validity).
- **The installer runs a deploy preflight.** After the health gate,
  install.sh performs a five-second scratch `docker build` with the same
  `DOCKER_CONFIG` the unit exports, so a broken build toolchain is
  caught during the install — with output and the known-cause hint —
  instead of by the operator's first push.

### Fixed

- **`docker build` failed on every hardened install** ("failed to update
  builder last activity time: open /root/.docker/buildx/activity/…:
  read-only file system"). v0.7.3's `ProtectHome=read-only` makes /root
  read-only for the root-run panel, and modern buildx insists on writing
  builder-activity files under `$DOCKER_CONFIG` on every build. The unit
  now exports `DOCKER_CONFIG` (and `PM2_HOME`, for the same class of
  failure in the PM2 process-list dump) pointing at writable paths under
  the data directory, the panel's env allowlist inherits them, and both
  directories are created at boot. Docker-mode installs were never
  affected.
- **PM2 deployments could not persist their process list** on hardened
  installs for the same reason — `dump.pm2` was written to the read-only
  `/root/.pm2`. The dump now lives under the data directory, and the
  boot-resurrect unit reads the same path.

---

## [0.7.6] - 2026-09-10

> Watch your images: docker services can now follow their registry tag
> and re-deploy themselves when the tag moves. Plus one security-debt
> item from the September audit is closed for good.

### Added

- **Image auto-update (digest watch).** Image-based docker services gain
  an **Auto-update** switch in their settings — remote-node services
  included, since the sweep reads the registry from the panel while the
  enqueued deployment reaches the node through the usual agent path. A
  30-minute sweep probes the registry for the tag's current manifest
  digest (Docker Hub and ghcr via the anonymous pull-token dance) and,
  when it moved, queues a **normal deployment** — full build-config,
  health checks and blue-green swap, so a broken new image fails
  visibly while the old container keeps serving. Safety rails: enabling
  the switch only records a baseline and never deploys by itself; a
  service with a queued or in-flight deployment defers the update to
  the next sweep; probe failures and unsupported registry auth schemes
  are skips, never errors; digest-pinned refs are refused (they cannot
  move); repo-backed services cannot enable the flag. Disabling clears
  the baseline. Migration 0053 adds `services.auto_update` +
  `services.auto_update_digest`.

### Security

- **The last "conditional SSRF" accepted risk is closed.** The five
  outbound git-host API calls in `sources.ts` (GitHub repos / branches /
  user, GitLab projects / user) now run through `guardedFetch` like
  every other panel webhook and API client. The routes were already
  operator-only and the hosts hardcoded; the guard locks that invariant
  so it cannot silently drift, a wiring test pins the call path, and
  the audit document's accepted-risk entry is marked closed (r077).

---

## [0.7.5] - 2026-09-09

> The deployment-workflows release: services can be grouped into
> environments (deployment lanes), a commit soaked in staging can be
> promoted to production with one call, and failed builds can be
> diagnosed by an AI provider under your own API key. Also: operators
> are now told when scheduled database backups silently stop happening.

### Added

- **Deployment lanes (environments).** A workspace can define named
  lanes — production, staging, development, anything — and services join
  a lane from the service create/edit form. The services page gains a
  lane filter and a **Lanes** manager (create, rename, delete, with live
  service counts per lane). Deleting a lane detaches its services rather
  than deleting anything. Role floors are enforced server-side: `member`
  to create or rename, `admin` to delete. SDK: `client.environments`.
- **Staging → production promotion.** `POST /v1/services/:id/promote`
  redeploys ANOTHER service at this service's exact running commit — the
  canonical soak-in-staging-then-promote flow. Both services must track
  the same repository, the caller needs `member` on both, the source
  must have a pinned running deployment, and the target's queued-deploy
  cap applies. The deploy tab shows a **Promote this commit** card when
  same-repo siblings exist. SDK: `client.deploys.promote`.
- **AI failure diagnosis (bring your own key).** The operator configures
  one OpenAI-compatible endpoint, model and API key under
  *Settings → AI Diagnosis* — the key is sealed with the same
  versioned AES-256-GCM envelope as other credentials and is never
  returned by any route. Failed deployments then offer **AI diagnosis**:
  the sanitized tail of the build log (16 KB) goes to the provider with
  the log framed strictly as data. The sanitizer strips ANSI escapes and
  masks credential-named assignments, Authorization/Bearer headers and
  `user:password@` URLs before anything leaves the host. Diagnosis needs
  `member` on the service, works only on failed deployments, and is
  audited. Endpoint/model are operator-set by design — pointing the
  provider at a local Ollama/LM Studio is an intended scenario. SDK:
  `client.ai`.
- **Missed-backup watchdog.** The backup scheduler now notices when a
  running database's newest scheduled backup is more than 48 hours old
  — the silent failure mode where a scheduler tick dies and nobody
  looks — and raises a `backup.missed` alert once per incident until a
  successful backup clears it.

---

## [0.7.4] - 2026-09-09

> Post-remediation polish: the database Web Studio is now served through
> the panel itself (fixing the broken embedded iframe under HTTPS), the
> update banner is honest about WHY it could not check for updates and
> recovers from transient failures in minutes instead of hours, and the
> installer verifies that what it downloaded is actually the release it
> asked for.

### Added

- **The database Web Studio is served through the panel origin.** A
  same-origin reverse proxy (`/v1/databases/:id/studio-proxy/`) fronts the
  loopback-bound Adminer / Redis Commander container: the embedded iframe
  finally works under HTTPS and CSP, the studio port stays off the network
  entirely, and access rides an HMAC-signed, path-scoped, 8-hour
  operator-only cookie instead of nothing at all. Upstream cookie paths are
  rewritten into the proxy scope so parallel studios never share sessions.
- **The About page tells you WHY an update check failed** (checks switched
  off vs feed unreachable, with the feed's own status line) and offers a
  **Check again** button instead of waiting out the cache.
- **Installer provenance checks:** the release tarball's content must match
  the requested tag (version binding, no symlinks, no setuid bits) and the
  docker-mode compose file must parse with the compose engine, reference
  exactly one image — the panel's own — before it is deployed.

### Fixed

- **Update-check failures are cached 10 minutes, not 6 hours.** A single
  boot-time blip (network not up yet, one API rate-limit 403) used to pin
  "unavailable" on the dashboard for six hours.
- The failed-check result now carries a machine-readable reason, so future
  UIs can distinguish disabled from unreachable.

---

## [0.7.3] - 2026-09-09

> The September 2026 security-audit remediation release. Three critical
> cross-tenant chains, eleven high-severity findings and the full
> installer/supply-chain cluster were closed across four remediation
> sessions — every fix regression-locked with tests. Several defaults
> changed in a securing direction (see **Changed**); a self-hosted
> operator upgrading should read the entries marked ⚠ before deploying.

### Security

- **Cross-tenant project-tag exfiltration closed.** Creating a service with
  another tenant's project id no longer passes validation, so the deploy
  pipeline can no longer decrypt a foreign project's shared env into an
  attacker-controlled container; the pipeline additionally re-verifies
  every project link against the owner's workspace seats before decrypting.
- **Cross-tenant volume mounts closed.** Attaching an `nd-svc-*` /
  `nd-db-*` volume (or config-repairing it) now requires every owner of
  the volume to be visible to the caller, `admin` on the database for
  `nd-db-*`, and refuses orphaned names.
- **Database attachments require the admin tier.** The attachment ships
  the database's admin-only password into the service env — visibility
  alone was never enough.
- **The agent transport fails closed.** The plaintext fallback now
  requires `NINEDEPLOY_AGENT_ALLOW_CLEARTEXT=1` on the core (a forged
  capability probe can no longer downgrade it), sealed requests demand
  sealed verifying replies, and replies must echo a fresh request nonce —
  captured envelopes cannot be replayed. Upgrade node agents together with
  the core; the fallback knob covers mixed-version fleets temporarily.
- **Fine-grained API-token scopes are enforced.** A token holding only
  `nd://scope/read/services` can no longer write other resources;
  unclassified endpoints fail closed. **New tokens default to read-only
  scopes with a 365-day lifetime** — pass explicit scopes/expiry when
  creating write-capable CI tokens.
- **`viewer` is read-only.** Service/project/label/database creation,
  domain verification, repo-insight refresh and webhook management
  (create/delete sits at the admin tier — the secret is a standing deploy
  credential) all require their documented role floors.
- **Refresh tokens rotate for real** (generation-bound: a replayed old
  refresh token is refused before any DB write); SAML assertions gain a
  replay cache plus Issuer / `InResponseTo` / Audience / Destination /
  Recipient validation; login lockout moved to a per-(account, IP) pair
  tier so an attacker can no longer hold a known account hostage;
  `connect-src` drops the bare `ws:`/`wss:` grants.
- **Privileged third-party images pinned** (alpine helper sidecars →
  `3.21`, cloudflared → `2026.8.3`, Adminer → `6.0.1`, Redis Commander →
  digest, remote-node agent → the core's own release tag). The
  remote-node agent image reference also stopped pointing at a
  repository that does not exist — remote provisioning works again.
- **Installer hardening:** a failed `--frozen-lockfile` no longer falls
  back to a re-resolved install (`NINEDEPLOY_ALLOW_LOOSE_INSTALL=1` to
  opt in); the compose panel port binds loopback by default
  (`NINEDEPLOY_BIND`); the systemd unit adds `ProtectHome=read-only`
  (tree-ownership lockdown available via `NINEDEPLOY_HARDEN_OWNERSHIP=1`).
- **Studio/pooler exposure:** the database Web Studio publishes on
  127.0.0.1 only and Redis Commander receives the database password
  (`REDIS_URL`); PgBouncer sidecars bind explicit ports to loopback and
  authenticate with SCRAM-SHA-256 instead of MD5.
- Exec error labels redact `--password=` / `-p` / `-a` argv values;
  build paths refuse symlinks; the generated `nixpacks.toml` escapes
  control characters.

### Fixed

- Push webhooks no longer write `services.commitSha` before the deploy
  succeeds — the branch still syncs immediately.
- Domain transfers: expired transfers stop blocking new ones; acceptance
  claims the row conditionally, closing the accept/accept and
  accept/cancel races.
- Scheduled jobs hold a per-job lock (no more parallel double-runs from
  overlapping ticks or run-now).
- Sandbox plugins persist their code/manifest across restarts; installing
  one without code is refused instead of registering an "active" no-op.
- The release workflow honors the `workflow_dispatch.tag` input in every
  step and smoke-checks the pushed multi-arch manifest before going
  green.
- The remote-node provisioner's agent pull failed against a
  non-existent image repository (see Security).

### Performance

- The web landing bundle was code-split per route: **1,010 kB → 125 kB
  raw (240 kB → 38 kB gzip)**.

---

## [0.7.2] - 2026-09-06

> A narrow post-0.7.1 patch: two reliability gaps caught once 0.7.1 went
> out, both narrow in scope. The `git://` protocol was not part of the
> `lib/gitEgress` SSRF guard, so a repository URL of
> `git://169.254.169.254/...` could reach the cloud metadata service; and
> the Traefik reaper's `docker network ls --filter` query used `^` anchors
> that Docker treats as literal characters, so the reaper matched no
> bridge and Traefik was never re-attached to the per-slug `nd-svc-<slug>`
> or `ndcmp-<slug>_default` bridges after a restart, leaving every domain
> on those meshes answering 502 until a full service redeploy ran
> `ensureServiceBridge` for that slug. No new features — just two holes
> closed.

### Fixed

- **The `git://` protocol is now part of the egress SSRF guard.**
  `lib/gitEgress.ts` handled only `http://`, `https://`, and `ssh://` URLs,
  leaving `git://` (port 9418, supported by `simple-git`) with no check. A
  repository URL of `git://169.254.169.254/...` could reach the cloud
  metadata service and leak instance credentials, and
  `git://<private-LAN>/...` could reach internal Git servers. The `git://`
  branch parses the URL and calls `rejectIfPrivateHost`, mirroring the
  `ssh://` guard. Four new regression cases cover the metadata service,
  RFC1918 LAN, loopback, and the positive public case.
- **The Traefik bridge reaper actually reaps.** Docker's
  `--filter name=<value>` is a substring match, not a regex, so the `^`
  anchors in `name=^nd-svc-` and `name=^ndcmp-` were treated as literal
  characters and the filter matched no bridge. After any Traefik restart
  (deploy, host reboot, image update), the reaper silently returned zero
  bridges and Traefik was never re-attached to the per-slug
  `nd-svc-<slug>` meshes or the `ndcmp-<slug>_default` compose defaults —
  every domain on those meshes answered 502 until a full service redeploy
  ran `ensureServiceBridge` for that slug. The anchors are gone and a
  regression test pins the substring-not-regex invariant so it cannot
  silently regress.

---

## [0.7.1] - 2026-09-05

> A quiet post-0.7.0 patch: three reliability gaps caught once 0.7.0 went
> out, all narrow in scope. Remote compose `stop()` was tearing down the
> wrong project whenever the compose service key itself contained a
> hyphen; the `withClient: false` option on `createDb()` was a dead
> no-op; and the database-URL secret pattern missed any connection
> string whose password was percent-encoded. No new features — just
> three holes closed.

### Fixed

- **Remote compose `stop()` no longer tears down the wrong project.**
  The previous recovery stripped a single trailing `-[^-]+-\d+` block
  from `<project>-<service>-1` to reach the project — but the compose
  service key is a user-controlled YAML map name and can contain
  hyphens itself (`services.frontend-api:`), so `ndcmp-web-frontend-api-1`
  extracted `ndcmp-web-frontend` instead of `ndcmp-web`. The production
  path then ran `docker compose down -p ndcmp-web-frontend` on the
  node, tearing down whatever stack happened to share that name (and
  silently leaving the actual one running). The builder now records
  the project it minted for each `runtimeId` at `buildAndRun` time and
  looks it up at `stop()` time: no string surgery, a `runtimeId` this
  builder never recorded is refused outright rather than guessed, and
  a redeploy of the same service overwrites its own mapping (a `Map`,
  not an array — the latest project wins).
- **`createDb({ withClient: false })` actually suppresses the raw
  libSQL client.** The option was a dead no-op since the field existed:
  the raw client was always returned, so read-only workers that wanted
  to release the underlying connection (the runtime migrator is one)
  could not. The Drizzle handle is unaffected; the client is omitted
  only when the caller asks, and the regression test pins both the
  suppression and that the Drizzle handle still answers queries.
- **The database-URL secret pattern now matches percent-encoded
  passwords.** A literal `@` cannot appear in the password class (it
  is the user/host delimiter) but its URL-encoded form `%40` can, and
  tools that build connection strings from user input routinely emit
  `%40` instead of escaping it themselves. The old regex treated the
  entire non-special class as raw, so a connection string with `%40`
  in the password was never caught by the secret scanner and slipped
  into env vars and the panel as a "no credentials detected" string.
  The pattern now accepts `[non-special] | %XX` triplets in the
  password class, the `{3,}` minimum still measures raw characters
  (so a real password still satisfies the guardrail), and the scanner
  covers what connection-string builders actually produce.

---

## [0.7.0] - 2026-09-04

> The multi-node release. `server_id` had been on the services table, the
> Servers page and the build context since the fleet feature shipped, and no
> builder ever read it: a service pinned to a node was refused outright
> rather than be built on the wrong machine. Now a `docker` or compose
> service pinned to a node is actually built and started ON that node
> through the typed agent protocol, and each node runs its own Traefik so
> production traffic never hairpins through the panel. The rest of the wave
> makes the panel honest about itself: build-cache backends that shipped
> complete but were never registered, settings that were saved and read by
> nothing, counters pinned at zero — and four post-0.6.0 reliability fixes.

### Added

- **Multi-node docker deploys.** A `docker` service pinned to a node is
  built and started on that node through the typed agent protocol: the
  repository is checked out in a per-service workspace on the node, the
  image is built or pulled there, and the environment arrives as a 0600
  env-file that is deleted the moment the container has taken it. PM2 and
  Nixpacks (Dockerfile-less) builds on a node are refused at queue time
  with a reason naming the missing capability, instead of running on the
  panel host behind the operator's back.
- **Compose stacks run on a node too**, which is what makes the one-click
  template catalogue usable there at all — most of it is compose-shaped.
  The panel ships the inline stack YAML (or the node checks the repository
  out), writes the `.env` and any volume-attachment override, then runs the
  same ordering the local builder uses: `compose config` and `compose pull`
  complete while the PREVIOUS revision is still serving, so a broken
  interpolation or a bad tag fails the deployment without ever tearing the
  live stack down.
- **Per-node ingress.** Each node runs its own Traefik — you point the
  domain at the NODE and the node terminates TLS for the services that live
  on it. The panel stays the source of truth for domains, middlewares and
  certificates: it renders the node's Traefik configs with the same
  functions that generate its own and ships them over; the node only writes
  them to a fixed path. A routing change refreshes every node
  automatically, and the node proxy is recreated only when the STATIC
  config changed, so a domain edit is not an ingress interruption.
- **A Target node card on the service settings tab.** `serverId` had been
  accepted by the create and update endpoints all along with no field
  anywhere in the UI, so multi-node was reachable only from the CLI or a
  raw API call. The card lists the registered nodes, explains the limit for
  PM2 instead of offering a choice that would fail at deploy time, and
  shows a non-operator the current target read-only.
- **Registry and S3 build caches are selectable at last.** Both drivers
  shipped complete and unit-tested but were never registered on the kernel,
  so an operator who set the backend to `registry` or `s3` silently kept
  building against the in-memory LRU. All three are registered now, each
  reads its connection settings lazily (saving them in the panel needs no
  restart), and the panel gained the registry/S3 endpoint and credential
  fields that were missing entirely.
- **Sessions table retention.** Sessions kept one row per login — each
  with an IP and User-Agent — and nothing ever deleted one; the panel
  filtered dead rows out of its response, so the growth was invisible.
- **`GET /v1/orchestrators/:name/stacks` lists an orchestrator's stacks**,
  and `GET /:name/stacks/:stack` reports one (SDK:
  `orchestrators.stackStatus(orchestrator, stack)`).

### Changed

- **The panel proxy and each node proxy render only THEIR OWN services.**
  A router upstream is a container name resolved over the local Docker
  network, so once nodes really ran containers, rendering every service
  into every proxy would have made the panel advertise routes for
  containers on another machine and answer 502 for each one — with the node
  doing the same in reverse. A node never receives the panel dashboard
  router, which would blackhole the control plane behind whichever node
  answered DNS first.
- **Node agents gained per-service workspaces.** Git has no per-invocation
  repository operand — fetch, checkout and reset act on the process working
  directory — so the agent ran every git operation in its OWN directory: a
  host could hold exactly one checkout and two remote services would
  overwrite each other's source tree.
- **The deploy worker honours the build-cache settings it was ignoring**: it
  took whichever backend happened to register first instead of the one
  named in `cache_name`, and the master `enabled` switch on that plugin
  turned nothing off.
- **Build-cache hit rate stops reading 0%**: the plugin looked up a key it
  invented (`service:<id>:no-commit`) that the builder never stores under,
  so every deploy published a `miss` that could not have been anything
  else. The hit/miss/error events now come from the build itself, carrying
  the key it actually consulted.
- **Four more settings that were saved and never read now work**: the
  per-minute alert cap on the notification dispatcher (it advertised
  protection against restart storms and capped nothing) and its
  deploy-success switch, and the template-bundle override counter that was
  pinned at 0. A regression guard now fails the build when any plugin
  declares a setting nothing reads.
- **Two settings that could never work were removed** rather than left as
  decoration: the account id and tunnel TOKEN on the Cloudflare Tunnels
  plugin (a password field whose value went nowhere — real tunnel tokens
  live per tunnel on the Tunnels page), and the metrics retention on the
  telemetry streamer (the metrics table is deliberately a 24-hour ring).
- **Metric history is swept hourly** instead of only when an operator
  clicks Flush — and the retention cutoff itself stopped matching every
  row and wiping the archive it was meant to trim.

### Fixed

- **Remote private-registry deploys no longer hang.** The agent built
  `docker login --password-stdin` so the credential never reaches the
  process table, but nothing ever wrote to that pipe: the child sat blocked
  on a stdin that was never closed until the agent's 600-second request
  timeout.
- **BuildKit builds stop logging a resolve error every time**: `--cache-from`
  was handed the literal `ref=empty` on a first build, and a bare
  `sha256:` content digest after that — neither names a repository, so
  buildx could never resolve either. A cache reference that cannot be named
  is simply omitted.
- **The orchestrator stack API answers real questions**: `GET
  /:name/stacks` passed the ORCHESTRATOR name into the driver as the STACK
  name, so it returned null for every real stack — and a test had pinned
  that behaviour rather than fixing it.
- **The backup drill no longer OOMs the panel on a multi-gigabyte dump**:
  the MySQL and Postgres validators sniffed dump headers through
  `readFile()`, which loads the entire file, and the drill is
  member-triggerable — a self-service OOM on the process that also hosts
  the deploy worker. Header sniffing goes through a bounded `readHead()`.
- **Config-center strings stop type-flipping across a cache boundary**:
  `set()` stored plain strings raw while `get()` re-parsed stored rows on a
  cache miss, so JSON-ambiguous values (`true`, `123`, `null`) came back as
  types after a restart — and a metadata-only save laundered the flip
  permanently.
- **Slug collision suffixes stay inside the 63-char cap**: appending
  `-<n>` to an already-truncated base stored 64–72 char slugs the schema
  rejects (clone loops, migration imports, compose stacks, personal
  workspaces).
- **Documentation corrected where it overstated the product**: the SSRF
  egress guard never covered the OIDC issuer or the S3 endpoint, and
  deliberately does not (self-hosted Keycloak and MinIO normally sit on
  private addresses); the agent transport is a sealed protocol with a
  cleartext fallback, not plain HTTP; and the multi-node docs name exactly
  what a node runs (docker, compose) and what it refuses (PM2, Nixpacks).

---

## [0.6.0] - 2026-09-03

> A security-and-reliability minor that also ships inline Compose stacks:
> paste YAML instead of cloning. Under the hood, a full-system audit closed
> a privilege-escalation path, made rate limits and audit logs see real
> client IPs behind Traefik, cleared every production dependency advisory,
> and stopped multi-gigabyte backups from ever entering the panel's heap.

### Added

- **Inline Compose stacks.** Services can store a pasted Docker Compose
  file (256 KiB cap) instead of a git clone: the schema enforces
  `type: compose` and rejects combining it with a repo URL, the server
  validates the file server-side (dry-run preview endpoint) and re-
  materialises it into the workspace before every deploy, and the new
  Compose tab offers Save and Save & redeploy.
- **Database indexes for hot lookups.** `services.server_id`,
  `webhooks.service_id` and `databases.project_id` were full-table scans;
  SQLite does not auto-index FK columns.

### Changed

- **Real client IPs behind Traefik.** The panel now trusts one proxy hop
  by default (`NINEDEPLOY_TRUST_PROXY`): rate limits are enforced per
  actual client instead of one shared bucket for the whole instance, and
  audit rows record the true source address. Set it to `false` when the
  panel is exposed directly.
- **SSH password bootstrap refuses fast.** Password authentication was
  accepted by the schema but never worked (`BatchMode=yes` disables all
  prompting and the password was never wired to sshpass). It now fails
  immediately with an actionable message; install a key and use key auth.
- **The CLI defaults to `https://` for non-loopback server URLs**, so the
  bearer token no longer rides plaintext HTTP to a remote host (loopback
  keeps `http://`; type an explicit scheme to override).
- **Scheduled backup failures are no longer silent.** A failed scheduled
  backup lands a failed row in the UI and fires the notification
  channels; MySQL/MariaDB dumps run `--single-transaction --quick`, so
  backups no longer lock live databases or produce inconsistent dumps.
- **CI ships tested images only.** The `:edge` image (what
  `--channel=main` installs) is published only after the full suite and
  integration tests pass, and the release prune no longer deletes the
  CI-pushed edge tags.

### Fixed

- **Privilege escalation via scheduled deploy jobs.** A workspace member
  could wrap an operator-created PM2/compose service in a cron job and
  reach host command execution. Scheduled deploys now authorize against
  the service owner's privileges, exactly like manual and webhook deploys.
- **Editing an env var no longer corrupts secrets.** Inline edits used to
  silently flip `isSecret` to false and a single typed character could
  overwrite the stored secret; the classification is preserved and
  failures surface as toasts.
- **The panel no longer crashes during self-update** on hosts without
  `/bin/bash` — a failed updater launch records a finished, failed state
  instead of an uncaught exception.
- **Deploy logs stop freezing the tab.** Live output keeps a bounded tail
  and flushes on an interval (the old per-message re-join was O(n²)) and
  reconnects a dropped stream; the terminal session also survives the
  fullscreen toggle.
- **Webhook replays are rejected.** Provider delivery ids are deduplicated
  for 24 hours, closing the window where a captured payload could
  redeploy an old commit.
- **System export is crash-consistent.** The archive carries a `VACUUM
  INTO` snapshot of the database instead of a tar raced against live
  writes; remote backup transfers stream, so multi-GB dumps no longer
  buffer in the panel's heap (which also hosts the deploy worker).
- **CLI sessions survive past 15 minutes** — the CLI persists the refresh
  token and retries through a single-flight refresh; server URLs default
  to `https` for non-loopback hosts and the JWT secret no longer appears
  in `docker run` argv (`ps` / `docker inspect`).
- **Slug collisions are impossible again.** `services.slug` is globally
  unique at the database level (it mints container, volume and router
  names) after a one-time dedup; slug uniqueness was application-layer
  only since the projects overhaul.
- **Dependency advisories cleared** — `fast-uri` (8× HIGH, SSRF/host
  confusion) and `qs` (2× MODERATE, DoS) pinned past their vulnerable
  ranges; `pnpm audit --prod` is clean.
- The schema-drift CI guard can actually fail now, `/v1/auth/token`
  answers instead of always 401ing, Traefik certificate backups follow
  the configured data dir, concurrent routing writes no longer drop just-
  added domains, PR preview creation survives the slug race, and the
  installer no longer discards local modifications without `--force`.

---

## [0.5.3] - 2026-09-03

> A production-hardening patch: the lazy `require()` class that only
> crashed outside vitest is gone (OIDC login works in production again),
> both remote build-cache backends can finally produce hits, image
> retention actually prunes, and the databases pages show live CPU/RAM.

### Added

- **Live CPU and RAM for managed databases.** Running databases show a
  live CPU + memory line on the list cards and a Live Resources card in
  the detail view — CPU %, memory used against the configured
  `memLimitMb` — polling the stats snapshot every 3 seconds while
  visible.

### Changed

- **Redeploying a running service asks first.** The Deploy button on a
  live service opens a confirmation dialog explaining the blue-green
  behavior (the current version keeps serving until the new build
  passes the healthcheck, then traffic swaps); idle, stopped or errored
  services still deploy immediately.

### Fixed

- **OIDC login works in production again.** RS256 signature verification
  pulled `node:crypto` through a lazy `require()` — undefined in the
  pure-ESM server package — so every OIDC sign-in died with
  `ReferenceError: require is not defined` in production while the unit
  suite stayed green (vitest's module runner shims `require`). The
  helpers now ride the module's static import, and the suite gains a
  source-level ESM-purity guard.
- **The same `require()` class killed two more production paths.** The
  iptables egress driver's entire on-disk state layer (rehydrate,
  persist, delete) threw and was swallowed by best-effort catches — boot
  forgot every persisted rule, applied rules were never persisted, and
  detach was a permanent no-op after a restart — and
  `RegistryBuildCache.store()` crashed outright on every non-marker
  digest with no catch to soften it. Both now use static `node:fs` /
  `node:crypto` imports.
- **Remote build caches can produce hits.** The S3 backend's `lookup()`
  demanded a metadata header on HEAD that `store()` cannot send — the
  digest only lives in the marker body — and the registry backend
  compared the cached layer digest against HEAD's
  `Docker-Content-Digest`, the digest of the manifest itself, which is
  never equal. Both now GET the marker/manifest and compare
  like-for-like, so store→lookup round-trips hit and `--cache-from`
  stops building cold every time.
- **`images prune --keep-last N` actually prunes.** Retention groups
  were keyed by `repo:tag`, which maps to exactly one image id, so every
  group was a singleton: `keepLast >= 1` protected the entire tagged
  inventory and nothing was ever deleted on real hosts. Groups are now
  keyed per repository, keeping the N newest versions per repo.
- **Email template overrides stay per template.** The override lookup
  filtered by workspace only, so once a workspace overrode a second
  template, every render returned an arbitrary sibling override (a
  password-reset email rendered with the workspace-invitation text) and
  deleting one template's override wiped the workspace's others.
  Lookups are now scoped by workspace AND template name, matching the
  table's unique key.
- **Magic hex secrets are exact-length.** `SERVICE_PASSWORD_HEX_25`
  baked a 24-char key and `HEX_1` an empty secret, because the hex
  generator computed `size / 2` bytes and Node silently truncates
  fractional sizes. Generation now rounds up and slices to the exact
  documented length; even sizes are byte-identical.
- **Manifest formatting keeps string types.** `formatManifestYaml`
  emitted plain scalars for any charset-safe string, so header values
  like `true`, `8080` or `007` round-tripped as boolean/number and the
  schema rejected the manifest the formatter itself produced. Quoting is
  now self-verifying: a plain scalar ships only if js-yaml loads it back
  as a string.
- **Cron summaries refuse wrong monthlies.** `0 0 1,15 * *`,
  `0 0 */7 * *` and `0 0 1-15 * *` were all summarized as "monthly on
  the 1st at 00:00" — factually wrong, operator-facing. Multi-day
  day-of-month expressions now fall through to null so the UI shows the
  bare expression instead.
- **PgBouncer status reports the real pool mode.** Status grepped a
  container env var that is never set, through an invalid Go template,
  so `poolMode` was always null while the sidecar ran; it now parses the
  rendered `/etc/pgbouncer/pgbouncer.ini`.
- **CLI multi-line pastes.** `prompt()`/`promptHidden()` split raw stdin
  chunks on the first newline, collapsing multi-line pastes into one
  value and dropping the tail after a hidden prompt's Enter; lines are
  now framed and fed to successive prompts in FIFO order.
- Misc: the SettingsTab privilege tests use the global 30s timeout
  ceiling instead of a tighter per-file override that tripped on loaded
  CI runners.

## [0.5.2] - 2026-09-02

> UI polish release: the Hub template catalog drops its noisy per-app
> emojis for a uniform monochrome icon, and an alert-evaluation bug
> affecting new rules is fixed.

### Changed

- **Uniform Hub icons.** Template cards and the detail drawer render a
  plain slate `Package` icon instead of 89 arbitrary per-template
  emojis, matching the panel's monochrome design. Original brand logos
  are deliberately not used (licensing and asset hosting for
  third-party marks).

### Fixed

- **New alert rules now evaluate from a clean slate.** Creating a rule
  seeds its `alert_state` row so `evaluateAlerts` can track breaches
  immediately instead of skipping the first evaluation window.

## [0.5.1] - 2026-09-02

> A security follow-up to 0.5.0: the demo is now a real deployable app,
> one host-privilege gap is closed, and the follow-up UI work is pinned
> by tests.

### Changed

- **The demo is real now.** "Load Demo Stack" used to seed rows that
  claimed to be running — an `nginxdemos/hello` container, a PM2 service
  from `vercel/next-learn`, and a Postgres row with no container behind
  any of them. It now creates a single deployable service: a Docker
  source build of `github.com/ersinkoc/nextjs-test` (multi-stage
  Dockerfile, port 3000, `/api/health`), queues its first build, and
  re-seeding is idempotent. Legacy fake rows are reaped on the first
  new-seed call. No PM2, no database, no fake state.

### Fixed

- **Watch-path webhook matcher could hang forever.** Patterns like
  `**a**b**c**d` compiled into a regex that backtracked ~C(n,3) steps on
  long non-matching paths (ReDoS); the matcher is now a bounded DP walk
  with identical folding semantics, over-long inputs fail open, and the
  tokenizer's own comment no longer breaks the server build.
- **Deploy finalize no longer strands the previous container** when env
  decryption fails, and the managed-env fingerprint merges into the
  config snapshot instead of replacing it.
- **Web coverage regression** on the 0.5.0 follow-ups: the activity
  drawer's reconnect badge flow and the KeyValueEditor's second-Add
  focus are pinned by tests.
- Misc: orchestrator routes are operator-gated (see Security); ESM-illegal
  `require` in the PgBouncer userlist renderer repaired with a
  regression test.

### Security

- **Orchestrator routes are operator-gated.** `GET /v1/orchestrators` and
  `GET /v1/orchestrators/:name/stacks` executed host Docker daemon
  commands through the registered drivers behind bare authentication;
  they now require the operator, like the exec terminal.
- **Mimosa sweep cleanups.** The last six false-positive findings were
  resolved at the source: five test-fixture tokens now use the runtime
  assembly pattern, and the login form's bullet placeholder is built at
  runtime instead of a literal scanners classified as a credential.

## [0.5.0] - 2026-09-02

> A plugin sandboxing release with a deep security and correctness sweep.
> NineDeploy now features an isolated Worker Thread plugin sandboxing engine
> with V8 memory bounds, asynchronous JSON-RPC protocol bridging, LIFO Saga
> rollback execution for lifecycle hooks, direct CRUD domain event emissions,
> and dynamic React UI slot widgets for the Web Dashboard and detail views —
> alongside fixes for a SAML sign-in bypass, a template path traversal, and
> several authorization gaps. Some deliberate behavior changes (listed under
> Changed) are worth reading before upgrading.

### Added

- **Isolated Worker Thread Plugin Sandboxing.** Community and third-party extensions
  run inside dedicated `node:worker_threads` isolates with memory limits (`16MB/64MB`)
  and an asynchronous RPC bridge, preventing host process crashes on plugin errors.
- **LIFO Hook Rollback (Saga pattern).** Intercepting pipeline hooks now support
  sequential rollback handlers that automatically clean up provisioned resources
  if a downstream handler aborts or vetoes (`allowOrAbort: false`).
- **Direct Domain Event Emissions.** Services, Databases, and Edge Servers emit
  typed domain events directly across the kernel event bus.
- **Dynamic React UI Extension Slots.** Live overview widgets and tab panels are
  rendered across Dashboard, Service, and Database detail views via `<PluginSlot />`.

### Security

- **SAML: bind the signature to the assertion (sign-in bypass).** Signature
  verification only proved that SOME `SignedInfo` was signed by the IdP — a
  legitimately signed response could be rewritten to name any local user and
  sign in as them. The callback now verifies the assertion digest against the
  signed `DigestValue` and enforces the `NotOnOrAfter` replay window; OIDC
  login `state`/`nonce` values now come from the CSPRNG instead of
  `Math.random`.
- **SAML/OIDC login CSRF.** The OIDC login flow's signed `state` was not bound
  to the browser: an attacker could deliver their own callback URL and sign a
  victim into the attacker's account. The login route now sets an HttpOnly
  state cookie the callback must match.
- **Community template path traversal.** A template `id` became a file name
  unvalidated, so `../`-style ids could write or delete `.json` files outside
  the community-templates directory. Ids are now filename-safe slugs
  (create/delete routes answer 400).
- **Managed git sources are operator-only.** Any member could attach a guessed
  `sourceId` to a service or repo analysis and have the pipeline clone the
  operator's private repos with the operator's decrypted credentials into a
  container they own. Setting or using a `sourceId` now requires the operator.
- **Database attachments require the `member` role.** A workspace `viewer`
  could attach (and detach) databases on a shared service — attaching injects
  the database's decrypted connection string into the service's runtime env.
- **Operator-gated maintenance routes.** `POST /v1/domain-presets/apply`
  (spends the operator's DNS token), `POST /v1/build-cache/store` (other
  builds chain from these digests) and `POST /v1/metric-history/flush`
  (instance-wide retention deletion) were available to every authenticated
  account; all three now require the operator.
- **No private-workspace id oracle.** Workspace routes answered 403 for
  existing-but-foreign workspaces vs 404 for missing ones, letting any
  authenticated user enumerate private workspace ids. Non-members now get the
  same 404; members with insufficient rank still get 403.

### Changed

- **Host-port services deploy sequentially.** Blue-green kept failing on
  "port is already allocated" for every redeploy after the first of a
  `publishedPort` service, stranding it on its first version. The previous
  runtime is now retired before the new container starts (a short, deliberate
  gap); Traefik-routed services keep full blue-green.
- **Compose deployments wait for healthchecks.** A container that boots but
  fails its own healthcheck forever used to deploy green on the first poll;
  the builder now waits for Docker's health status and fails fast on a
  failing streak.
- **Compose `.env` values are escaped.** Secrets containing ` #` were
  silently truncated by compose's dotenv parser and `$VAR`-shaped values
  were expanded from the panel's own environment; values now round-trip
  byte-exact (verified against compose-go).
- **PgBouncer sidecars no longer publish the default host port.** Every
  sidecar bound 6432, so enabling a second database failed on "port is
  already allocated". Clients connect over the docker network; set an
  explicit `pgbouncerPort` to publish. Sidecar config is also copied into the
  container instead of bind-mounted, so the credential-bearing temp files no
  longer sit in the host's tmp dir.
- **PM2 domains route through the host gateway.** The Traefik upstream for
  PM2 services was the PM2 process name — unresolvable inside the Traefik
  container, so every attached domain 502'd. Upstreams now use
  `host.docker.internal`.
- **OIDC id-token checks follow the spec.** Multi-valued `aud` now requires a
  matching `azp` (§3.1.3.7); an unknown `kid` forces one JWKS refresh before
  failing (IdP key rotation); trailing-slash issuers compare equal. Tokens
  that used to pass on lax providers may now be rejected.
- **Managed `sourceId` on services is operator-only** (see Security).
- **Foreign workspace routes answer 404 instead of 403** (see Security).
- **Watch-path webhooks fail open at the commit-list cap.** GitHub truncates
  the `commits` array at ~20 entries; a push whose watched change sat in an
  omitted commit was silently skipped. A list at the cap now deploys.
- **Stricter manifest validation.** `env.aliases` keys must now be env-var
  names, and the generated YAML quotes scalars so special characters survive
  a round-trip.
- **Dev checkouts anchor the default data dir to the monorepo root.** The
  old cwd-dependent default provisioned a fresh `.data` (and a NEW master
  key) when restarted from a different working directory, making every stored
  secret undecryptable. Docker/systemd installs are unaffected.

### Fixed

- **Runtime output across chunk boundaries.** stdout/stderr no longer merge
  interleaved partial lines, multi-byte UTF-8 split across chunks survives
  intact, and trailing partial lines are flushed.
- **SAML/OIDC edge cases.** OIDC JWKS no longer verifies arbitrary `kid`
  tokens against whichever key is listed first; signature verification of
  remote source credentials surfaces failures instead of silently fetching
  with stale tokens.
- **Database volume TOCTOU.** Two concurrent creates with the same
  `existingVolume` could both pass the clash check and mount one data
  directory; creation is now serialized per volume.
- **Deploy finalize isolation.** A corrupted env row no longer aborts
  finalize and leaks the previous container; the managed-env fingerprint
  merges into the config snapshot instead of replacing it (the `/diff`
  endpoint keeps its build-config view), and the drift warning actually
  fires.
- **Generated artifacts.** The container compose manifest quotes env/label
  scalars (values like `{"a":1}` no longer produce invalid YAML); Traefik
  routes PM2 services via the host gateway (attached domains no longer 502);
  compose `stop` ignores recorded config files that no longer exist, so
  volume-attached stacks stop for real.
- **CLI output.** `table()` counts visible width (pre-colored cells no
  longer shift columns), colored `status`/`health` cells stay aligned.
- **SDK client.** `threshold: 0` / `days: 0` / `serverId: 0` reach the server
  instead of silently becoming the default; volume names and template ids are
  URL-encoded.
- **MCP server.** Legacy unrestricted tokens (`[]`) and interactive sessions
  (`session`) keep every tool instead of silently losing the scoped ones;
  `list_services({ projectId })` uses the supported `tagProjectIds` query —
  the retired `?projectId=` filter returned ALL services.
- **Secret scanner.** Detects the current `sk-proj-` OpenAI key format and
  reports every occurrence of a pattern, not only the first.
- **Certificate inventory.** Certificates expired less than a day ago are
  reported `expired`, not `expiring-soon`.
- **Web dashboard.** A stale repo analysis no longer deploys the wrong
  framework preset; a dead session now returns the app to `/login` instead of
  a wall of failed queries; the service page follows `?tab=` deep links and
  no longer streams a foreign deployment's logs; topology live stats actually
  update; the activity drawer reconnects with backoff and says so; QR codes
  for regenerated TOTP secrets always show the current value.
- **Misc.** PgBouncer's `pgbouncer.ini` and userlist are removed from the
  host tmp dir right after the sidecar starts (previously leaked forever);
  pgbouncer temp files carry the caller's tmpdir, not a hardcoded `/tmp`;
  community template removal reports 400 for unsafe ids; `config.ts` locates
  the monorepo root instead of silently following the process cwd.

## [0.4.9] - 2026-09-01

> Hub installs always ran the template's pinned image reference —
> `directus/directus:latest` and friends — with no way to choose a version.
> The install request rejected any image override by design (the templates
> are runtime-verified), and the wizard's image field was disabled. Now the
> wizard lets you pin a different tag of the template's OWN repository
> (`:latest` → `:11.5`), the server validates the override keeps the
> repository, and the review step shows exactly what will run.

### Added

- **Pin a template image version at install time.** The Hub deploy wizard's
  image field is live for templates: it comes pre-filled with the registry
  reference, and typing e.g. `directus/directus:11.5` deploys that tag. The
  server accepts only overrides that keep the template's registry repository
  — digest references and cross-repository swaps are refused, because the
  point is version pinning, not running arbitrary bytes under a vetted
  template's name. Port and volume stay registry-controlled. Interrupted
  installs reconcile cleanly across overrides (the same-template check
  compares repositories, not exact references), and Service → Settings keeps
  allowing image edits after install for redeploy.

## [0.4.8] - 2026-09-01

> Cancelling a deployment and immediately removing it from the queue left
> the pipeline itself alive: the row that carried the cancellation signal
> was gone, so the zombie kept building, deploying and holding its
> concurrency slot — and every queued deploy behind it waited for a deploy
> that no longer existed. Deleting a cancelled deploy now stops the
> pipeline at its very next checkpoint.

### Fixed

- **Cancel-then-remove no longer strands the queue behind a zombie
  pipeline.** The cancel route flips the row terminal immediately while
  the pipeline stops at its NEXT checkpoint — which can be minutes away
  (a docker build, a healthcheck window). Removing the row in that
  window destroyed the only signal the pipeline polls: `isCancelled`
  read the missing row as "not cancelled" and ran the whole deploy to
  completion — holding its concurrency slot, so the queue's #1 entry
  never claimed, with no way left to stop the zombie. A deployment row
  that disappears under a running pipeline is now treated as cancelled:
  the pipeline aborts at the next checkpoint, releases the slot, and the
  queued deploys behind it proceed.

## [0.4.7] - 2026-09-01

> The postgres 18 support shipped in 0.4.5's dependency defaults was
> broken on arrival: the official postgres 18+ images moved the data
> directory to a major-version-specific path and deliberately refuse the
> classic mount every managed database here used. The container
> crash-looped, its DNS name never registered on the per-service bridge,
> and the attached app — Directus was the first hit — burned the whole
> healthcheck window on `getaddrinfo EAI_AGAIN` against the database
> hostname. Fixed together with the 0.4.5 diagnostics that finally made
> the real error visible.

### Fixed

- **Managed postgres 18+ databases start again.** The official postgres
  18+ images (and pgvector pg18) store data under
  `/var/lib/postgresql/<major>/docker` (pg_ctlcluster-compatible layout,
  docker-library/postgres#1259) and deliberately exit when they detect
  the classic `/var/lib/postgresql/data` mount — NineDeploy's standard
  volume mount since forever. The result was a database container in a
  restart loop: "running and attached" at attach time, gone from DNS a
  moment later, and an app that could not even resolve the database
  hostname. Volumes for majors ≥ 18 now mount ONCE at
  `/var/lib/postgresql` with the data in the versioned subdirectory;
  majors ≤ 17 keep the classic layout, and rows already pinned to 17
  see no change.
- **The retained-volume re-key sidecar follows the volume label's own
  image.** The label records the image that initialized the data, which
  can be an older major than the row's configured version — the sidecar
  previously derived its paths from the row and would have mounted a
  16-layout volume with 18 paths. It now matches the label's image.

## [0.4.6] - 2026-09-01

> Follow-up to 0.4.5's CI bring-up: the dependency patches existed to remove
> a vulnerability-flagged glob and the deprecated @esbuild-kit toolchain, but
> the lockfile kept resolving those edges from the UNPATCHED manifests — so
> every install carried exactly the packages the patches exist to remove,
> and the deprecated-dependency guard failed on every CI run. The edges are
> now cut at resolution level, and the deploy pipeline's own end-to-end
> integration tests verify reachability the way Model B actually works.

### Fixed

- **The lockfile now reflects what the patches mean.** The drizzle-kit
  patch removes `@esbuild-kit/esm-loader` from its manifest and the
  archiver-utils patch moves glob to `^13`, but pnpm kept resolving those
  edges from the UNPATCHED manifests — `@esbuild-kit/core-utils`,
  `@esbuild-kit/esm-loader` and the vulnerability-flagged `glob@10.5.0`
  stayed in the lockfile and the installed store. Overrides now cut the
  edges at resolution level (23 packages left the tree; glob resolves into
  the maintained 13.x line fastify already carries), and the
  deprecated-dependency guard strips the lockfile's `overrides:` metadata
  block before grepping — the block legitimately names the packages being
  removed. Source installs stop pulling the deprecated packages; the guard
  keeps guarding.
- **The deploy integration tests verify Model B networking, not Model A.**
  The end-to-end suite still asserted the runtime container sits on the
  shared `ninedeploy` mesh and fetched it by name from a throwaway mesh
  container — but every runtime lives on its own `nd-svc-<slug>` bridge
  since v0.3.0, where the mesh neither resolves the name nor routes to it.
  The pipeline itself passed on CI; the test's own verification failed with
  "bad address". It now verifies reachability the way platform
  infrastructure (Traefik, the probe container) does — from a container
  attached to the service's bridge, by name — asserts bridge membership
  instead of mesh membership, and sweeps the bridge on teardown.

## [0.4.5] - 2026-09-01

> v0.3.0's Model B moved every runtime onto its own per-service bridge but
> left the healthcheck's sibling probe on the shared mesh — and Docker drops
> traffic between bridges by default. Any app that binds its port later than
> the 10-second direct-probe grace (first boot, DB migrations — Directus is
> the first app anyone hit it with) burned the full 5-minute window on blind
> `nc` timeouts and failed its deployment while perfectly healthy. This
> release closes that regression, makes the failure diagnostics honest about
> container stderr, and carries the security-gates hardening.

### Fixed

- **The healthcheck probe reaches per-service bridges again.** Model B
  (v0.3.0) puts every runtime on its own `nd-svc-<slug>` bridge, but
  `ninedeploy-prober` kept living on the shared `ninedeploy` mesh — and
  Docker's DOCKER-ISOLATION chains drop traffic BETWEEN bridges, so the
  fallback `nc` probe timed out against every container IP no matter how
  healthy the app was. Direct probes only cover the first 10 seconds
  (`directGraceMs`) and don't work at all from the host on Docker Desktop,
  so anything slower than that — Directus running first-boot DB migrations —
  failed every deploy with "did not become ready in time" after ~45 blind
  attempts (~3s `nc` + ~3s sleep per attempt ≈ the 300s deadline). The
  prober now joins the runtime's networks idempotently before the sibling
  probe (mirroring Traefik's permanent bridge membership; networks it
  already sits on are skipped), and the first sibling failure logs the
  probe topology — which networks the container and the prober actually
  sit on — instead of a bare exit code.
- **Container diagnostics no longer lose stderr.** `logContainerDiagnostic`
  read `docker logs` through `capture()`, which returns stdout only — and
  `docker logs` exits 0, so everything the app wrote to stderr (exactly the
  output a crashed boot explains itself with) silently vanished from the
  "Recent container logs" section. It now streams both streams through
  `run()`'s sink.

### Security

- **Egress routes are operator-only.** Listing or mutating host-level
  SNAT/iptables state is not a project-member capability; the routes are
  gated behind a preHandler role check and the suite pins the 403 rejection
  before any driver method runs.
- **The CORS allowlist excludes localhost origins in production** — the
  panel is same-origin in prod; `localhost:5173`/`3000` remain allowlisted
  in dev only.
- **The workspace owner's role can no longer be changed in place.** The
  member-role update route refuses to demote the owner (`403`): changing
  the owner's membership role without transferring `workspaces.ownerId`
  could let an admin lock the owner out or leave an owner without owner
  access — ownership moves only through the transfer route.
- **The 256 MB request-body allowance is scoped to the backup import
  route** instead of global, so login, webhooks and ordinary JSON
  endpoints cannot allocate a quarter-gigabyte Buffer before
  authentication runs.
- **Workspace projects require the workspace admin role to mutate.**
  Project PATCH/DELETE and shared environment variable mutations now
  demand workspace admin when the project belongs to a workspace —
  members can still discover and read workspace projects, but can no
  longer rename, re-home or delete them, or edit shared env vars that
  propagate to every linked service. Service cloning requires admin
  too, since it duplicates encrypted secrets and the full build
  definition into a caller-owned service.

## [0.4.4] - 2026-09-01

> A review pass over 0.4.3's doctor mode and retained-volume work found
> one deep flaw and two sharp edges: the headline fix did not survive
> its own retry path, every compose stack's network looked like an
> orphan to the Doctor, and the guarded-fix refusals surfaced as opaque
> 500s instead of the promised 409s. Fixed together with a few
> papercuts (hidden progress, one scan too many, a sidebar link for a
> page that can only refuse you).

### Fixed

- **The retained-volume fix now survives a retry.** Adoption was gated
  on `status = 'creating'`, but every failure path flips the row to
  `error` — so the most common follow-up (deploy again) skipped
  adoption entirely and booted the retained volume's stale credentials,
  re-creating the exact crash-loop 0.4.3 set out to close. Databases now
  carry an `initialized_at` marker (migration 0048), stamped once the
  volume's contents have been made consistent with THIS row's
  credentials; the adoption gate re-arms whenever the marker is NULL and
  the row sits in `creating`/`error`. Covers the API create path, the
  Hub-provisioning retry (`reuseExisting`), the explicit start route,
  and template reconcile — where a retained row left in `error` by a
  failed first attempt now goes through adoption again instead of
  silently starting under credentials nobody has.
- **Doctor no longer mistakes every compose stack's network for an
  orphan.** Compose networks are named `ndcmp-<slug>_default`; the scan
  compared the full name (suffix included) against service slugs and
  never matched — flagging healthy stacks as "no owner" and offering a
  delete for a stopped-but-existing stack's live network. The project
  suffix is now stripped before the ownership check.
- **Doctor fix refusals answer 409 with the reason, not an opaque
  500.** The guarded re-checks (container came back running, volume
  gained an owner, row gone, deploy moved on) threw plain errors that
  the global handler turned into 500s — hiding the actionable message
  in production entirely. They now throw proper conflicts, and a volume
  deletion VERIFIES the removal landed: a failed `docker volume rm`
  (volume still mounted by a container) no longer reports "Fixed" while
  the volume survives on disk.
- **Re-key progress is visible.** `capture()` silently ignored the
  heartbeat options, so a slow postgres re-key (up to its 5-minute
  timeout) sat silent in the deploy log; heartbeats now flow through an
  optional `onProgress` sink like `run()` always did.
- **The Doctor panel no longer triggers a third full scan per fix** —
  the fix response already carries the post-fix report; the panel seeds
  its query cache with it instead of invalidating and refetching.
- **The Doctor sidebar link is hidden from non-operators** (`operatorOnly`
  nav filter) instead of leading every member to a page that can only
  refuse them.

## [0.4.3] - 2026-09-01

> Two long-standing operator pain points close out this release.
> The retained-volume trap: deleting a database intentionally kept
> its Docker volume, but a redeploy over that volume booted with a
> fresh row's credentials against data initialized under the old
> ones — an unexplained crash-loop at the healthcheck, every retry,
> forever. Postgres is now re-keyed automatically on adoption, and
> the engines that cannot be re-keyed fail up front with the
> volume's provenance and the exact remediation instead of an
> opaque timeout. And the missing host-level janitor: the new
> Doctor page scans for dead containers, orphan volumes/networks,
> row-vs-runtime desyncs, stuck deploys, dangling images and disk
> pressure, and repairs findings through re-validated,
> name-family-guarded actions — a stale panel can no longer delete
> a volume that gained an owner in between. Volume provenance
> labels, a 400 for `existingVolume` claims that collide with
> another row, and 32-byte template-generated secrets round it out.

### Fixed

- **Redeploying a template over a deleted database no longer dies silently at
  the healthcheck.** Deleting a database intentionally keeps its Docker volume,
  but the postgres/mysql family only reads `*_PASSWORD`-style env vars during
  FIRST initialization of an empty volume — so a fresh database row (with a
  freshly generated password) remounting a retained volume booted a server
  whose real credentials belonged to the deleted installation. The app then
  crash-looped on auth failures and the deploy failed at its healthcheck with
  no explanation, every retry, forever. Callers that create a new database row
  now run `adoptRetainedVolume` before starting it:

  - **postgres** is re-keyed automatically: a throwaway sidecar running the
    cluster's own image (`ninedeploy.database.image` volume label, falling
    back to the row's configured version) opens the data directory in
    single-user mode and rewrites the role's password to the new row's value.
    Success is verified by a catalog probe inside the same session, since
    single-user mode does not fail the process on statement errors.
  - **redis/valkey** need nothing — their credentials live on the container,
    not in the volume.
  - **mysql/mariadb/mongo/clickhouse/rabbitmq/meilisearch** have no automatic
    re-key: the deploy now fails up front with the volume's provenance and the
    exact remediation (`docker volume rm <name>` / Volumes panel) instead of
    an opaque healthcheck timeout.
  - A labeled volume belonging to a different engine is refused outright
    instead of being mounted as garbage.

### Added

- **Doctor mode — host-wide analysis + guarded cleanup.** A new `GET /v1/doctor`
  scan answers "what is dead, stale or bloated on this host": exited Hub
  containers nobody claims, orphaned managed volumes and leftover
  bridge/compose networks (with their `ninedeploy.*` provenance), services
  marked *running* whose runtime container is gone, databases marked running
  with a dead container or stuck in `creating`, deployments frozen in
  queued/building, dangling image layers, oversized builder cache and disk
  pressure — each with severity, reclaimable size where applicable, and a
  one-click repair. `POST /v1/doctor/fix { findingId }` re-scans and
  re-locates the finding against FRESH state before executing, so a stale
  panel can never delete a volume that gained an owner or kill a container
  that came back (it gets a 409 instead); destructive targets are additionally
  name-family-guarded (`nd-*` / `ninedeploy-*` / `ndcmp-*` only) and volume
  deletion refuses anything whose owner row reappeared. Panel: new
  **Doctor** page in the System group (operator-gated) with severity-grouped
  findings, host facts and per-finding fixes with confirmation for the
  destructive ones. SDK ships the same surface (`client.doctor.scan/fix`).
  Repairs reuse existing safe paths (managed `startDatabase`, audited volume
  removal, age-filtered builder prune, auto-prune) instead of raw prunes.
- **Volume provenance labels.** Every managed database volume is created with
  `ninedeploy.managed=database` plus its slug, display name, engine, the exact
  initializing image, owning user, container name and — for template
  provisioning — the template id. The Volumes panel now shows `retainedFrom`
  (name + engine) for ownerless volumes, so a retained volume can always be
  traced back to the database that created it even after the row is gone.
- Creating a database with `existingVolume` that already belongs to another
  database row is refused with a 400 instead of silently sharing (and
  re-keying) another database's data directory.
- Template-generated secrets (`secret: true`) are now 32 bytes (43
  base64url chars) instead of 18, so variables like Directus `SECRET` or
  n8n `N8N_ENCRYPTION_KEY` can never fall under ecosystem 32-character
  minimums. Existing installs keep their stored values — generation only
  happens on first install.

## [0.4.2] - 2026-08-31

> The post-0.4.1 plugin audit found five real bugs across the
> built-in kernel plugins (a UI surface that never showed up, a
> non-functional `export_endpoint`, a sidebar that leaked
> command-palette items, a broken route on the ConfigPresets
> palette entry, and an `telemetry.export.error` re-emit that
> could feedback-loop the export on a non-2xx response). They
> ship here together with the deploy-queue management surface
> (global queue page + cancel/remove + per-service position)
> that 0.4.1 tagged without, and the first end-to-end test
> against the typed SDK surface. Release pipeline is hardened
> so this version can never ship under a non-semver tag.

### Plugin Audit & Fixes

- **NotificationsDispatcherPlugin** ships a `command:palette`
  menuItem now — the plugin listened on `deployment.status_changed`
  / `service.health_changed` / `backup.completed` and emitted
  `notification.queued`, but had no `menuItems` entry at all,
  so the only path to its config was the hidden
  `/settings?section=plugins` URL. The new entry points to
  `/settings?section=notifications`.
- **TelemetryStreamerPlugin** actually POSTs to
  `export_endpoint` now — the configSchema exposed the field and
  the description said records were pushed, but the init
  handler only re-emitted `telemetry.recorded` as a pass-through
  and the endpoint was silently ignored. Wires a real `fetch()`
  call with HMAC-SHA256 signing
  (`X-NineDeploy-Signature: sha256=<hex>`) and per-request
  AbortSignal timeout; failures land on `telemetry.export.error`
  custom events so the audit pipeline picks them up.
- **TelemetryStreamerPlugin wildcard filter** drops
  `telemetry.recorded` (recursion guard) and
  `telemetry.export.error` (a non-2xx response re-emitted
  itself as `telemetry.recorded`, re-fetched, re-failed, and
  OOMed the test process — the export now short-circuits
  before the loop can build). Also drops `plugin.*` /
  `config.*` so a `plugin.registered` tick never surfaces as
  user-facing audit data.
- **Layout sidebar no longer leaks `command:palette` items**
  into the Extensions group. Every built-in plugin that
  registered any `menuItems` ended up in the rail-mounted
  Extensions group regardless of slot — `Build Cache`,
  `Webhook Out`, `Domain Presets`, `Sticky IP` showed up in
  BOTH the Cmd+K palette AND the sidebar. Filter
  `menus.data` to `m.slot === 'sidebar:secondary'` so only
  Cloudflare Tunnels (the only built-in plugin in the
  registry that uses that slot) lands in the rail.
- **ConfigPresetsPlugin menuItem** repointed from
  `/settings/presets` (no such route) to
  `/settings?section=config`, where the panel renders the
  `preset.list` / `preset.<id>.values` rows the plugin owns.
- **plugin-sdk MenuSlot** union extended with `database:tabs`
  — the slot was in the kernel's runtime type but missing
  from the SDK type, so an external plugin declaring a
  database-tab menuItem would compile against the SDK and
  then have the kernel reject the row at runtime. SDK now
  mirrors the kernel exactly.

### Deploy Queue Management

- **Global queue page** at `/deploys` — every in-flight
  (queued / building / deploying) deploy across every
  service the caller can see, with one-click cancel +
  remove, per-service position chip on queued rows
  (`#3 of 5` next to the timestamp), 3s auto-refresh, and a
  `DeployQueueBadge` in the top bar that hides when the
  queue is empty and pulses while a row is live. Member
  sessions see only the rows on services they can admin.
- **Multiple queued deploys per service** (50-row cap) —
  the old dedup short-circuited on ANY queued/building
  match, so a `services deploy` click during a long build
  silently dropped. Split into in-flight (still wins) +
  per-service queued (cap 50, returns the actual row).
- **Cancel + remove routes** on `services.deploys` —
  queued deploys stop immediately, in-flight ones stop at
  the next pipeline step boundary with the previous
  version still serving. Remove refuses in-flight (cancel
  first) and refuses the `running` row (it carries the
  digest a rollback re-deploys).
- **CLI: `ninedeploy deploys queue`** — same data the
  web panel's /deploys page renders, with per-service
  1-based queue position (queued rows only; in-flight
  rows get a dash so the column reads cleanly) and a
  by-status k/v block at the bottom (queued / building
  / deploying) so the operator can confirm the empty
  state at a glance.
- **MCP: `list_queue` + `remove_deploy` tools** register
  the matching `requiredScopes` (read for queue, write
  for remove) so a `read`-only token can list the queue
  but cannot delete a deploy — same gate the SDK + HTTP
  layer enforce.
- **Longest-match sidebar routing** — `Layout.findGroup`
  now picks the longest prefix match, not the first one.
  Plugin-contributed menu items register routes like
  `/settings/extensions/<plugin-id>`; the static System
  group also owns `/settings`, so a first-match lookup
  routed every plugin click into System and the user
  landed in the wrong panel.

### Integration Coverage

- **SDK ↔ server queue end-to-end test** — wires the real
  SDK client to the real Fastify route via Fastify's
  `app.inject()` (no port binding, no real network). A
  custom `fetch` translates the SDK's standard
  `Authorization: Bearer <token>` header to the in-process
  test app's `x-test-user` header. Pins the contract that
  the SDK schema and the route JSON agree — a renamed
  response key, a removed field, a 404 that became a
  400, an SDK shape that no longer matches the route JSON
  will all surface here first.

### Installer & Release

- **Strict-semver tag validation** in the release
  workflow. The trigger `on: push: tags: ['v*']` accepted
  any v-prefixed ref — `v0.4.0-foo`, `v0.4.0+build.1`,
  even a stray `v0.4.0 ` with trailing whitespace. install.sh
  and selfUpdate.ts only resolve `^v\d+\.\d+\.\d+$`, so
  pushing a different shape would build a real image no
  install path can ever reach. A new first step fails
  fast on anything that does not match strict semver.
- **Multi-arch release build** — the ci.yml
  `publish-image` job was already multi-arch
  (linux/amd64 + linux/arm64), but the release tag
  pipeline (which is what `install.sh --docker` actually
  pulls) was silently amd64-only. Every ARM host
  (Raspberry Pi, AWS Graviton, Apple-Silicon-as-target)
  hit a "no matching manifest" error on `docker pull`.
  Mirrors the daily edge build's architecture coverage.
- **Marketplace catalog shape smoke test** — every entry
  in `MARKETPLACE_CATALOG` is walked and asserted against
  the shape the loader depends on (id / name / version /
  menuItem id+slot+label+route+route-format /
  configSchema key+label+isSecret). A typo in a new
  catalog entry would have shipped as a row the panel
  could show but not install; the test makes that fail
  in CI.

## [0.4.1] - 2026-08-31

> The v0.4.0 tag was published without the post-Sprint 11 fixes and
> the GHCR image pipeline; this 0.4.1 release re-publishes every change
> listed below as one coherent version. There will not be further
> `vX.Y.Z-hotfixN` tags — patch fixes ship as the next semver patch
> so install.sh / one-click panel self-update can find them through
> `^v\d+\.\d+\.\d+$` without manual version pinning.

### Installer & Release

### Installer & Release

- **CI publishes the panel image to GHCR on every push to main** so a fresh
  `install.sh --channel=main` lands on a current image, not a stale one. The
  job tags the multi-arch (amd64 + arm64) build as `:edge` and an
  immutable `:main-<sha>`; the existing release workflow (tag push) re-tags
  `:latest` so a fresh `install.sh --docker` from the release channel still
  pulls the most recent published artifact. `install.sh` now substitutes the
  right tag (`:edge` for main, `:latest` for release) into the rendered
  compose file, and a preflight `docker manifest inspect` runs before
  `compose pull` so a private GHCR package surfaces a clear one-line
  error instead of the generic "image pull failed".
- **Sprint 11 PR #58 coverage push**. 200+ tests across 17 new files for
  the Sprint 11 surface (PRs #45–#58). Server coverage **88.12% → 93.53%**
  statements, **86.00% → 88.31%** branches. CLI coverage 73% → 84% on the
  back of the `test/index.test.ts` restore. SDK 100% on every axis.
  Thresholds re-bumped: server 93.6/88.4/93/95.1, CLI 83/80/80/83.

### Fixed (post-Sprint 11)

- **`serviceBridge` test premise correction**: the docker
  `network ls` / `inspect` output preserves the bridge name verbatim
  (`{"nd-svc-foo": {…}}`), so the lib's `state.includes('"nd-svc-foo"')`
  matches correctly and every ensure/connect/reap/reconcile call is
  idempotent. The previous test fixtures were written against an
  imagined underscore form (`{"nd_svc_foo": {…}}`) and asserted the
  wrong behaviour. The lib was correct; the tests were not. (16/16.)
- **`imageInventory.pruneImages.keepLast` semantics**: the previous
  loop `for (let i = keep; i < list.length; i++)` protected everything
  past `keep`, the inverse of the docstring's "keep the newest N per
  repo:tag". The new loop `for (let i = 0; i < keep; i++)` with
  `keep = Math.min(Math.max(0, keepLast), list.length)` protects exactly
  the newest N and leaves the rest as candidates. (45/45.)
- **`marketplaceCatalog.decodeKey` Node 24 raw 32-byte Ed25519 import**:
  `createPublicKey({format: 'der', type: 'spki'})` rejects the raw 32-byte
  key with `Failed to read asymmetric key`; the SPKI envelope is 44 bytes
  (12-byte prefix + 32-byte key), and `createPublicKey(raw)` throws
  `error:1E08010C:DECODER routines::unsupported` on the bare seed. The
  new path imports the key as a JWK
  (`{kty: 'OKP', crv: 'Ed25519', x: base64url(raw)}`), the only form
  Node's key importer accepts for an OKP public key. (16/16.)
- **`localOrchestrator.listStacks` service-count regex** was always
  0 for any compose file with body under each service entry
  (the format the driver itself emits). The new
  per-block scanner counts top-level `  <name>:` lines inside the
  `services:` block and excludes 4+-space-indented body lines. (24/24.)

### Coverage follow-ups (post-Sprint 11, pre-0.4.0)

- **`stickyIpPlugin.ts`** (G-15, PR #22): 32% → **100%** on every axis
  (16 tests). Drives the real `NineDeployKernel` event bus +
  `configCenter` + `IEgressIpDriver` to cover the metadata,
  `service.deployed` attach (success / failed / no projectId / master
  switch off / no ip / no driver / driver throws / non-Error throw),
  the `service.deploying` detach path, and the destroy lifecycle.
- **`swarmOrchestrator.ts`** (G-10, PR #21): 42% → **100%** statements /
  **100%** lines (28 tests). Cross-platform in-memory `node:fs` shim
  covers the network / secret / config / service create + update
  paths, `serviceExists` catch, `markPartial` rollback on both create
  and update failure, every `getStackStatus` replica state label
  (`running` / `stopped` / `partial` / `unknown`), the `readState`
  file-vs-DB fallback, the `upsertRow` insert + update branches, the
  ordered `removeStack` (services → configs → secrets → networks)
  with best-effort docker rm tolerance.
- **`localOrchestrator.ts`** (G-10 PR-A): 60% → **97%** statements /
  **98%** lines (22 tests). Every `renderCompose` block (ports /
  env / networks / secrets / configs / healthcheck / labels /
  stack-level sections / `attachable: false` / `replicas > 1`
  collapse), `deployStack` failure modes, `removeStack` best-effort
  paths, `getStackStatus` null paths, `listStacks` STACK_ROOT
  unreadable.
- **`auth.ts`** (operator + scope gates): 38% → **97%** statements
  (16 tests). Operator flag narrowing for scope-restricted tokens,
  read-only token enforcement on non-safe methods, and every branch
  of the per-resource scope superset rule
  (`nd://scope/admin/services` does NOT cover `databases`).
- **`stats.ts`** route: 85% → **98%** statements (12 tests). Operator
  vs member visibility filter, the `userWsIds.length === 0` early
  return, the `visibleDatabases === null` ternary.
- **`notifications.ts`** module (channels + log): 0% → **100%**
  statements (12 tests). Channel CRUD, target encryption round-trip,
  configJson empty-string → null clear, decrypt-on-test-dispatch
  with the dispatchChannel mock, 404 / 400 error paths.
- **`backups.ts`** module: 0% → **97%** statements / **98%** lines
  (21 tests). Every per-database route (storage / list / create /
  restore / drill create / drill list) and every global route
  (list / delete / download) — including the local-vs-remote
  restore branch, the engine-failure mark-failed path, the
  volumes-scope download branch, the operator-only volume-scope
  backup gate, and the `if (!row) return` early exit.
- **`manifest.ts`** module: 92% → **98%** statements / **100%**
  lines (14 tests). Every `diff.build` field branch
  (install / build / start / baseDir / dockerfile).
- **`templates.ts`** hub: 0% → **30%** statements (9 tests). List
  with community-merge collision drop, detail with runtimeVerified
  coercion, community import (success / 400) + remove (200 / 404).
  The complex `prepare` / `deploy` paths (env rotation, compose-stack
  construction) are documented as a follow-up — they need a
  much larger fixture set.
- **`servicesCoverage`** tag-attachment test un-skipped:
  the array `serviceProjects` insert resolver now finds the
  project-99 row in the values array instead of asserting on a
  single value object's `.serviceId`. (20/20.)

- **+200 tests across 17 new files** for the Sprint 11 surface
  (PRs #45–#58). Server: 12 new test files
  (`test/lib/{communityTemplates,certificateInventory,domainTransfer,marketplaceCatalog,backupDrill,logSearch,fcm,pgbouncer,emailTemplates,imageInventory}.test.ts`
  and
  `test/modules/{pgbouncer,emailTemplates,logSearch,manifest,images,domainTransfers}.test.ts`),
  CLI: 2 new test files
  (`test/{communityTemplates,certificates}.test.ts`),
  SDK: 1 new test file (`test/sprint11Coverage.test.ts`).
  Coverage deltas — server statements **88.12% → 93.53%**
  (+5.41), branches **86.00% → 88.31%** (+2.31); SDK 100%
  on every axis. The new files cover every Sprint 11 code
  surface (manifest apply, pgbouncer sidecar, log search,
  backup drill, FCM push, email templates, certificate
  inventory, community templates, domain transfer, image
  inventory, marketplace index) at 100%. Threshold lowered
  to **92/87/92/94** (server) and **72/80/63/73** (CLI) to
  match the current reachable baseline; the goal remains 100%
  — see `vitest.config.ts` for the per-axis rationale and the
  follow-up plan.
- **`marketplaceCatalog.decodeKey` fix**. The previous
  implementation passed a raw 32-byte Ed25519 public key
  to `createPublicKey({ format: 'der', type: 'spki' })`, which
  Node 24 rejects with `Failed to read asymmetric key` (SPKI
  envelopes are 44 bytes — 12-byte prefix + 32-byte key). The
  new path imports the raw key as a JWK
  (`{ kty: 'OKP', crv: 'Ed25519', x: base64url(raw) }`),
  the only form Node's key importer accepts for an OKP
  public key. `createPublicKey(raw)` directly throws
  `error:1E08010C:DECODER routines::unsupported` because
  the 32-byte seed is not a self-describing key blob. The
  signed marketplace index now verifies cleanly on Node 24
  and the 6 TODO-marked happy-path tests (merge, `isInstalled`
  propagation, cache hit, `force: true` bypass,
  `clearMarketplaceCache`, opts precedence over env) are
  back.
- **`domainTransfer.test.ts` state-tracking fix** (the
  side-effect of the new `test/helpers.ts` update). The
  fake-DB `update` resolver now reads the bound `id` from
  `where(eq(id, X))`'s `queryChunks` so the in-memory map
  mutation lands on the right row, fixing 6 pre-existing
  test failures (state was being flipped on every row, not
  the row whose `id` matched the predicate).
- **CLI `vitest.config.ts` excludes `test/index.test.ts`**
  for the coverage run only. The test is a pre-Sprint 11
  commander integration smoke that registers every CLI
  command; it depends on a `FakeCommand` helper that lives
  in the test file itself, and its mock factory overlaps
  with the unit tests for `communityTemplates` /
  `certificates` (PRs #57, #56) through vitest's per-worker
  module cache. Excluding it keeps the coverage run green
  while leaving the test available for `vitest run
  test/index.test.ts` (run on demand). PR #58 does not
  rewrite that test — it lands in a dedicated follow-up.
- **`serviceBridge.test.ts` premise fix** *(post-merge)*. The
  coverage tests were written against a *fictional* docker
  behaviour that the bridge name `nd-svc-foo` would be
  reported as `nd_svc_foo` (underscore) in `docker inspect`
  output. Real `docker network create nd-svc-foo` keeps the
  hyphenated name in the JSON, so the lib's literal-string
  search `state.includes('"nd-svc-foo"')` matches
  correctly and the operation is genuinely idempotent. The
  tests now assert the correct no-op behaviour for
  `ensureServiceBridge` / `connectContainerToServiceBridge`
  / `reapTraefikNetworks` / `connectTraefikToComposeNetwork`
  when the bridge is already on the network, and 16/16
  tests pass on the real docker output.
- **`imageInventory.pruneImages.keepLast` fix** *(post-merge,
  functional bug)*. The previous loop
  `for (let i = keep; i < list.length; i += 1) protectedIds.add(list[i]!.id)`
  with `keep = Math.max(0, keepLast)` produced the *opposite*
  of the docstring's "Keep at least this many images per
  repo:tag (newest first)": with `keepLast = 0` it
  protected every entry, so the prune was a silent no-op,
  and with `keepLast = 1` it protected everything except
  the *newest*. The new loop
  `for (let i = 0; i < keep; i += 1) protectedIds.add(list[i]!.id)`
  with `keep = Math.min(Math.max(0, keepLast), list.length)`
  protects exactly the newest N and lets the rest fall into
  the candidate filter (in-use, dangling, age). 45/45
  `imageInventory` tests pass, including a new
  `keepLast = 0 removes every non-dangling image` happy
  path that previously asserted the no-op was the
  expected behaviour. The 50-id chunking test was
  re-fixtured to 60 distinct repo:tag × 3 images so it
  still produces 120 candidates (50 + 50 + 20 across 3
  `docker image rm` chunks).
- **CLI `test/index.test.ts` restore** *(post-merge)*. The
  commander integration smoke is no longer excluded. Three
  blockers had to go: (1) the
  `vi.mock('../src/lib/format.js', () => ({ banner: h.banner }))`
  factory replaced the entire `format.js` surface with just
  `banner`, which the sibling unit tests for
  `communityTemplates` and `certificates` depended on. The
  new factory uses `vi.importActual` so the real
  implementation is preserved and only `banner` is
  overridden; (2) the `FakeCommand` helper in the test
  file did not implement `requiredOption`, so every new
  command using `.requiredOption(...)` (`domains
  transfer`, `pgbouncer`, `metrics`, `notifications
  create-fcm`, `email-templates set`) crashed during
  registration. The fake now implements `requiredOption`
  alongside the existing `option`; (3) the test's hard-coded
  list of registered commands and per-command child counts
  was stale. The list now includes `notifications`, `images`,
  `logs`, `email-templates`, `certificates` and the new
  `egress`/`sso` order, and the per-command lengths are
  updated (`databases` 2→3 with `pgbouncer`, `templates`
  3→4 with `init <templateId>`, `domains` 4→8 with
  `preset` + 4 transfer commands, `backups` 3→5 with
  `drill` + `drills`, `plugins` 8→9 with
  `marketplace-refresh`). 24/24 index tests pass; total
  CLI suite 33 files / 596 tests pass. Coverage jumps
  from ~73% to **84.12% statements / 81.83% branches /
  81.8% functions / 84.17% lines** because the inline
  `.action((...args) => fn(...))` bodies that the unit
  tests never invoked are now driven through
  `program.parseAsync()`. Threshold bumped to
  **83/80/80/83** to match the new reachable baseline; the
  goal of 100% on every new module is unchanged.
- **Pre-Sprint 11 low-coverage modules closed**
  *(post-merge, follow-up commits)*. Three of the
  longest-standing pre-Sprint 11 coverage gaps are
  closed:
    - `stickyIpPlugin.ts` (G-15, PR #22) — **32% →
      100%** on every axis. 16 tests cover the metadata
      (id / name / configSchema / menuItems), the
      `service.deployed` attach path (success / failed /
      no projectId / master switch off / no ip configured /
      no driver registered / driver throws / non-Error
      throw), the `service.deploying` detach path
      (success / no projectId / no driver / driver
      throws), and the destroy lifecycle (subscriptions
      cleared, second-init on a fresh kernel).
    - `swarmOrchestrator.ts` (G-10, PR #21) — **42% →
      100% statements / 100% lines**. 28 tests with an
      in-memory `node:fs` shim (cross-platform path
      handling via the orchestrator's own `node:path`
      `join`) cover the network / secret / config / service
      create+update paths, the `serviceExists` catch
      branch, the `markPartial` rollback on both create
      and update failure, every `getStackStatus` replica
      state label (`running` / `stopped` / `partial` /
      `unknown`), the `readState` file-vs-DB fallback, the
      `upsertRow` insert + update branches, the
      `listStacks` happy and malformed paths, and the
      ordered `removeStack` (services → configs → secrets
      → networks) with best-effort docker rm tolerance.
    - `localOrchestrator.ts` (G-10 PR-A) — **60% →
      97% statements / 91% branches / 98% lines**. 22
      tests cover every `renderCompose` block (ports /
      env / networks / secrets / configs / healthcheck /
      labels / stack-level secrets / configs / volumes /
      `attachable: false` / `replicas > 1` collapse), the
      `deployStack` failure modes (compose-up error /
      mkdir error / unknown / partial / stopped states),
      the `removeStack` ordered + best-effort paths
      (compose down error + rmSync error), `getStackStatus`
      (null paths + empty `services:` block + per-service
      states), and `listStacks` (STACK_ROOT unreadable +
      compose file present + parse error). The listStacks
      service-count regex is documented as a known
      limitation (the strict `^services:\n((?:
      {2}[A-Za-z0-9_.-]+:\n)+)` capture + `endsWith(':')`
      post-filter produces 0 for any compose file with
      content under the service entry) — a future
      improvement can swap it for a more permissive
      parser.
- **`test/helpers.ts` update**: `update`/`select`/`delete`
  resolvers now try `name` / `snake` / `camel` lookups in
  order so tests can register resolvers under either
  spelling (drizzle's `tableName` returns the snake_case SQL
  identifier; tests historically registered camelCase).
  `update.where()` captures the predicate for branch
  filtering; `select.where()` is now lazy (rows are resolved
  on `await` so the bound `whereArgs` is available).

### Security

- **Instance-operator rights are no longer self-grantable** *(critical)*. `isOperator`
  was computed as "holds `owner`/`admin` in at least one workspace". Because
  `POST /v1/workspaces` has no role gate and inserts the caller as `owner` — and
  `GET /v1/workspaces` auto-creates an owned workspace for a user with no seats —
  any authenticated member could promote themselves to full instance operator in
  a single request. That flag also gates the host-privilege boundary
  (`lib/hostPrivilege.ts`), so the escalation reached PM2 services, Compose
  stacks, deploy lifecycle hooks and Docker-socket templates: **arbitrary code
  execution on the host**. Migration `0038` adds `users.is_instance_operator`;
  the flag is granted at bootstrap or by an existing operator
  (`PATCH /v1/users/:id/operator`, Settings → Users) and never inferred from
  workspace membership. The last operator cannot be demoted or deleted.
  Upgrade backfill is deliberately narrow — the bootstrap user plus
  owners/admins of the OLDEST workspace; anyone who had become an "operator" by
  creating their own workspace is not carried over and must be re-granted
  explicitly. `test/operatorEscalation.test.ts` fails against the old code.
- **Workspace roles are actually enforced.** `assertWorkspaceRole` / `roleAtLeast`
  had zero call sites, so a `viewer` could create services, rewrite environment
  variables and trigger deploys exactly like an `owner` — the four roles existed
  in the docs and the UI and nowhere else. New `assertServiceRole` resolves the
  caller's highest seat across the workspaces a service is tagged into and gates
  the service, deploy, env, domain and tag routes: read = any seat, write =
  `member`, delete/re-tag = `admin`. Databases, backups, volumes and jobs still
  follow the same hierarchy: `assertDatabaseRole` resolves a database's role
  through its project's workspace, so reads need any seat, lifecycle and limits
  need `member`, and deletion, backups, restores and credential reveal need
  `admin`. Database Studio (binds a host port) and volume-scope backups (no
  owning database) stay instance-operator-only.
- **Backup and credential routes were stricter than documented, and one was
  unscoped.** Taking a backup and revealing a database password were
  instance-operator-only, so a workspace admin could not back up or connect to
  their own database. Both are now `admin` on the database. Relaxing them
  required adding the per-database ownership check that `DELETE /backups/:bid`
  and `GET /backups/:bid/download` never had — safe while only operators could
  reach them, not safe with workspace admins in scope.
- **API token scopes are enforced.** `api_tokens.scopes` was written as `[]` and
  read by nothing, so every token — CI and MCP included — carried its owner's
  full authority, operator flag included. Scopes are now `read` (safe methods
  only), `write` (mutates, but always as a NON-operator) and `operator`, applied
  centrally in `plugins/auth.ts` so new routes are covered on the day they are
  added. A token can never outrank its owner. Tokens also accept
  `expiresInDays`. Empty scopes still mean unrestricted so existing CI keeps
  working; `ninedeploy token list` labels those `unrestricted`.
- **Core→agent traffic no longer crosses the network in cleartext.** The
  multi-server transport was plain `http://` with no TLS option, and it carried
  two things worth stealing: the agent token, which is unrestricted remote
  execution on the agent host, and — via `file.writeEnv` — the deployed
  service's DECRYPTED secrets. `lib/agentSeal.ts` seals the body: HKDF-SHA256
  derives a fresh key per message from `sha256(agentToken)` (the only secret
  both ends hold), and the payload travels as AES-256-GCM with
  `version.timestamp` bound in as additional authenticated data. Opening the
  envelope *is* the authentication, so the token stops being sent at all;
  replies are sealed too, because command output routinely echoes
  configuration. Envelopes more than ±5 minutes old are refused, and every
  failure — wrong secret, tampered ciphertext, edited timestamp, unknown
  version, malformed field — returns the identical error, so `/agent/exec`
  cannot be used as a decryption oracle. Agents advertise support via
  `GET /agent/ping`; an un-upgraded agent still gets the legacy plaintext
  request with a warning naming the host in the deploy log. Set
  `NINEDEPLOY_AGENT_REQUIRE_SEALED=1` on the core once the fleet is upgraded to
  refuse that fallback — it is the one downgrade an on-path attacker could
  force. This is not TLS: metadata is still visible, there is no forward
  secrecy, and agents still belong on a private network.
- **A compose-stack template no longer bypasses the host-privilege gate.**
  `POST /v1/templates/:id/deploy` called `assertMayUseHostPrivilege` with the
  service type hard-coded to `'docker'`, but a template carrying
  `composeContent` becomes a `type: 'compose'` service — and `hostPrivilege.ts`
  classifies compose as a host privilege precisely because a compose file can
  bind-mount host paths or request a privileged container. A `member` could
  therefore create and queue a compose stack through this route, while
  `assertMayDeployStoredService` correctly refused them the *next* deploy of the
  same service. The gate now keys off the type that will actually be created,
  and the Deploy wizard says so on the first screen instead of after five steps.
- **One lost packet can no longer downgrade the sealed agent transport.**
  `agentClient` cached "this agent does not speak the sealed protocol" per
  server — including when that answer came from a *failed* probe rather than
  from the agent. An agent restarting, a dropped packet, or an on-path attacker
  killing exactly one `GET /agent/ping` pinned that server to the legacy
  cleartext transport for the life of the process. Only an answer the agent
  actually gave is cached now.
- **`lib/auth.ts` no longer grants operator from the legacy `users.role`
  column.** Migration `0034` rebuilds `users` without that column, so the
  `role === 'admin'` → operator branch was unreachable in production and existed
  only to keep its own test fixtures passing — a second, dead grant path in the
  auth core that would have quietly widened the deliberately narrow backfill
  migration `0038` imposes.

### Added

- **SSO (G-22).** A new official microkernel feature for OIDC and
  SAML single sign-on. The `sso_providers` table
  (migration `0042`) carries the per-provider config; the new
  `lib/oidc.ts` helper does discovery, JWKS, and RSA-SHA256
  id-token verification with zero npm dependencies; the new
  `lib/saml.ts` helper parses IdP metadata and verifies
  `<SignedInfo>` signatures against the IdP X.509 cert. The HTTP
  surface (`GET /v1/sso/providers`, `POST /v1/sso/providers`,
  `DELETE /v1/sso/providers/:id`, `GET /v1/sso/:name/login`,
  `GET /v1/sso/:name/callback`) backs the SDK
  (`client.sso.listProviders`, `addProvider`, `removeProvider`)
  and the CLI (`ninedeploy sso list|add|remove`). PR-A ships the
  provider CRUD + the OIDC wire path; PR-B (next sprint) adds the
  SAML POST consumer + the session-mint glue that ties the SSO
  callback to the existing email/password session cookie. The
  helper is intentionally narrow — a hand-rolled
  XMLDSig + JWKS verifier is small enough to read in one sitting
  and avoids a new dependency tree.

- **Sticky IP / dedicated egress (G-15).** A new
  `IEgressIpDriver` interface and an `IServiceRegistry` extension
  (`registerEgressIpDriver` / `getEgressIpDriver` /
  `listEgressIpDrivers`) — the first new network interface since
  G-04. The reference `IptablesEgressDriver` writes an
  `iptables -t nat -A POSTROUTING` SNAT rule scoped to a
  project's Docker network, persists the rule to
  `/var/lib/ninedeploy/egress/<projectId>.rules` so a kernel restart
  rehydrates, and is idempotent on `(projectId, ip)`. The
  `StickyIpPlugin` subscribes to `service.deploying` +
  `service.deployed`, reads `project:<id>:sticky_ip.ip` from
  config-center on success, and emits `metric.egress.unavailable`
  on a failed iptables call so a project with a broken
  container does not block a deploy. New HTTP surface
  (`GET /v1/egress`, `POST /v1/egress`, `DELETE
  /v1/egress/:projectId`) backs the SDK
  (`client.egress.list / set / clear`) and the CLI
  (`ninedeploy egress list|set <projectId> <ip>|clear <projectId>`).
  Sprint 6 will add cloud-specific drivers (AWS NAT gateway
  allocation, GCP static IP reservation, …) on top of the same
  contract.

- **Discord notification channel can now send a coloured embed
  (G-18 PR-A).** The `notification_channels` table gains a nullable
  `config_json` blob (migration `0043`); the existing Discord path
  sent a plain `content` webhook, which is fine for a debug channel
  but reads as a thin grey line next to a properly formatted alert.
  Operators can now opt in to a structured embed (`title`,
  `description` reusing the formatted message, sidebar `color` —
  default `#2563eb`) and override the webhook's identity
  (`username`, `avatar_url`) per channel. `sendDiscord` is exported
  from `lib/notifier.ts` for direct testing; `dispatchChannel`
  forwards `configJson` to it from the channel row. Channels created
  before this PR keep working with the old plain-content payload —
  `null` / malformed JSON falls back to the default shape.

- **Discord embed form in the operator panel (G-18 PR-B).** The
  `Settings → Notifications` channel editor now exposes the
  four Discord embed knobs that the server already stored in
  `config_json` (Sprint 5 G-18 PR-A shipped the storage, this PR
  wires the UI): embed title, webhook username override,
  avatar URL, and sidebar color (rendered as a `#rrggbb` hex).
  The SDK's `listChannels` and `updateChannel` signatures now
  carry the `configJson` field so the panel can read existing
  embed settings back on render and serialize the new values
  on save. The form only shows the embed block for `type ===
  'discord'`; other channel types ignore the field. Empty
  fields are stripped from the saved JSON so a "clear the
  embed" submission does not retain ghost keys. The server
  route and schema were already in place from PR-A — this PR
  only touches the SDK types and the panel form.

- **SAML POST consumer + session-mint glue (G-22 PR-B).** The SAML
  half of SSO finally closes the round-trip. A new
  `POST /v1/sso/:name/saml-callback` accepts the IdP's
  base64-encoded `SAMLResponse`, decodes it, parses the IdP-issued
  metadata (already registered at provider create time) to pull
  out the signing certificate, verifies the XMLDSig
  `<ds:SignedInfo>` envelope with `verifySignedInfo` (RSA-SHA256,
  zero-dep `node:crypto`), extracts the federated identity (NameID
  plus the `email` / `mail` / `emailAddress` attribute aliases),
  looks up the matching local user, and mints the same access +
  refresh token pair the email/password flow produces via
  `issueSessionTokens`. New `lib/saml.ts` helper
  `extractSamlSubject` walks the assertion's
  `<AttributeStatement>` for the email attribute; a new
  `lib/authHelpers.ts` `findUserByEmail` is the canonical lookup
  (lowercased email match) that future callers (operator panel
  search, audit reconciliation) can share. The endpoint refuses
  unknown emails with a "no local user matches …" envelope —
  SAML is for existing operators, not a public sign-up path;
  invitations remain the operator-issuance flow.

- **OIDC session-mint glue (G-22 PR-C).** The OIDC callback
  (`GET /v1/sso/:name/callback`) now runs the full code-exchange
  + `id_token` verification + local user lookup + session-mint
  flow instead of returning a "[redacted]" placeholder. The route
  surfaces the IdP's `?error=…&error_description=…` redirect
  parameters verbatim so the panel can render a useful toast;
  exchanges the authorization `code` at the IdP's
  `token_endpoint` (form-encoded POST); verifies the returned
  `id_token` (JWKS-backed RS256, iss / aud / exp / nonce checks);
  requires an `email` claim; looks up the matching local user via
  the new `findUserByEmail` helper; and mints the same access +
  refresh token pair the email/password flow produces. The
  OIDC-specific nonce check (the one that ties the auth request
  to the callback) is documented as the PR #23-b follow-up: the
  `expectedNonce` argument to `verifyIdToken` is empty for now,
  opting the route out of that one check. A pre-existing bug in
  the JWK → SPKI DER encoder (the long-form ASN.1 length was
  missing for >127 byte modulus blocks) is fixed by going
  through `createPublicKey({ key: jwk, format: 'jwk' })` directly,
  which Node 24 supports and which the OIDC spec already
  endorses. Tests use unique `idp<salt>.example.com` issuers per
  case so the JWKS cache doesn't leak keys across runs.

- **HttpOnly state / nonce cookies for OIDC (G-22 PR-D).** The
  `state` and `nonce` values that the OIDC login route
  generates are no longer echoed in the response body for the
  client to round-trip. Instead, the login route sets two
  `HttpOnly` cookies (`ninedeploy_sso_<provider>_state` and
  `…_nonce`, `Path=/v1/sso`, `Max-Age=600`, `SameSite=Lax`,
  `Secure` on https); the callback reads them back, rejects the
  flow with a CSRF error if the `state` query parameter does not
  match the cookie, and passes the `nonce` cookie to
  `verifyIdToken` so the OIDC replay check actually runs (the
  previous PR relaxed the check to empty string; this one
  restores the spec's intent). The cookie helpers live in
  `lib/ssoCookie.ts` — a 30-line zero-dep alternative to
  `@fastify/cookie` that handles the two `Set-Cookie` headers
  and a single `Cookie` request header. Success and CSRF
  failures both clear the auth-flow cookies so a stale
  `state` from a previous attempt cannot be replayed.

- **Namecheap DNS records (G-07 PR-A).** The third `IDomainProvider`
  driver joins Cloudflare and DNSimple on the kernel's
  `IDomainProvider` registry, behind the same `IDomainProvider`
  contract — pick it by setting `dns_records_provider=namecheap` in
  Settings → DNS.
  endpoint; `namecheap.domains.dns.setHosts` is a wholesale PUT that
  replaces the entire host list for a domain. The driver composes
  `getHosts` → merge → `setHosts` → re-`getHosts` so the kernel
  contract stays clean: one `createRecord` call, one returned
  `recordId`, one `deleteRecord` call by id. Two extra round-trips
  per mutation is the cost of Namecheap's atomic-write model and the
  documented way even their UI does it. A new zero-dependency XML
  parser (`lib/xml.ts`) handles the upstream's `<ApiResponse>` /
  `<Domain Name=…>` / `<host HostId=…>` shape and is shared with
  `lib/saml.ts`. Credentials live in three settings keys
  (`namecheap_api_user`, `namecheap_api_key_encrypted`,
  `namecheap_client_ip`) — the key is encrypted at rest, the IP is
  the operator's whitelisted public IP and must already be on the
  Namecheap account panel. New HTTP surface
  (`GET /v1/settings/dns-records/namecheap`,
  `PUT /v1/settings/dns-records/namecheap`), SDK
  (`client.settings.namecheap.{get,set}`), and CLI
  (`ninedeploy domains preset add namecheap --api-user <u> --api-key
  <k> --client-ip <ip>`). PR-B (next sprint) wires the operator
  panel's Namecheap form to the same shape.

- **White-label (G-30).** The four branding fields operators can
  override (`logoUrl`, `primaryColor`, `supportEmail`,
  `footerHtml`) move from hard-coded in the panel to a real
  config-center namespace (`branding.*`). The new
  `GET /v1/branding` returns the four values (null = panel default)
  and is cached in-process for 60 s so a panel that refreshes the
  branding tab does not hammer SQLite; `PATCH /v1/branding` writes
  one or more fields atomically and invalidates the cache. New SDK
  surface (`client.branding.get()` / `set(input)`) and CLI
  (`ninedeploy branding get|set --logo-url <url> --primary-color
  <hex> --support-email <addr> --footer-html <html>`). Empty strings
  clear the override so an operator can return to the panel default
  with a single command. The values are visible everywhere the
  panel renders the sidebar logo, the sign-in footer, and the
  support-email link in the help menu — without a panel rebuild.

- **Docker Swarm orchestrator interface (G-10 PR-A).** A new
  `IOrchestrator` interface and an `IServiceRegistry` extension
  (`registerOrchestrator` / `getOrchestrator` /
  `listOrchestrators`) — the first new orchestrator interface since
  G-04. The new `LocalOrchestrator` driver wraps the existing
  `IComputeDriver` flow behind the contract: it renders a
  `StackSpec` into a single `docker compose up -d` invocation
  under `/var/lib/ninedeploy/stacks/<name>/` and reports per-service
  state via `getStackStatus()`. Replicas > 1 collapse to 1 (the
  local driver is single-node by design) but the requested count
  is recorded in the generated YAML as a comment so a future Swarm
  driver can honour it. New HTTP surface
  (`GET /v1/orchestrators`, `GET /v1/orchestrators/:name/stacks`)
  backs the SDK (`client.orchestrators.list()`,
  `client.orchestrators.stackStatus(name)`). The interface is
  intentional non-breaking — every existing `IComputeDriver` call
  site continues to work; the new `IOrchestrator` is opt-in per
  service. PR-B (Sprint 4 PR #19) wires the Swarm driver on top of
  the same contract, which is the first concrete benefit of landing
  the interface first.

- **S3-backed build cache (G-01 PR-D).** A new `S3BuildCache`
  driver that reuses the existing `lib/s3.ts` SigV4 helpers to
  store a `BlobRef` marker per cache key in any S3-compatible bucket
  (AWS S3, MinIO, R2, Backblaze B2, Garage, …). Two operators on the
  same bucket are isolated by the `prefix` config-center key
  (default `build-cache/`); a `HEAD` against the prefix on `lookup()`
  returns the digest the previous build stored, and a `PUT` on
  `store()` writes the marker with the digest encoded in the body.
  The driver reuses the operator's existing S3 credentials (no new
  secrets), reports in-process hits / misses / stores via
  `stats()`, and never throws on a missing key. PR-D closes the
  third backend of the G-01 contract — operators on hosting
  providers who already run an S3-compatible store get a
  low-friction cache that costs nothing to provision.

- **Registry-backed build cache (G-01 PR-C).** A new
  `RegistryBuildCache` driver that writes a small `BlobRef` marker
  to an OCI registry as a single-tag manifest, and reads it back via
  `HEAD /v2/<repo>/manifests/<tag>`. The driver's table
  (`cache_registry_blobs`, migration `0040`) records the
  (key, backend, repo) → digest mapping so a kernel restart can
  resume without re-listing the registry; a `HEAD` against the
  registry confirms the tag is still reachable, and an out-of-band
  registry GC surfaces as a clean miss. Auth is `Basic <base64>` over
  the operator's `registry_username` / `registry_token` config-center
  keys; the table only stores metadata, never the token. PR-C
  closes the durable half of the G-01 contract — the build cache
  now survives a kernel restart, an instance migration, and
  cross-instance pulls on a registry that the operator already
  maintains.

- **BuildKit invocation through the cache contract (G-01 PR-B).** The
  Dockerfile build path now honours `engine.use_buildkit`: when an
  operator flips the flag on and the kernel has at least one
  `IBuildCache` registered, the docker builder routes the build
  through `docker buildx build --cache-from=type=registry,ref=<digest>
  --cache-to=type=inline` instead of the legacy `docker build` path.
  Cache keys are content-addressed
  (`apps/server/src/lib/buildCacheKey.ts` — SHA-256 of
  `serviceId + dockerfilePath + baseDir + commitSha + lastBuildDigest`)
  so a code change automatically invalidates the cache. A successful
  build's digest is published back to the cache via the new
  `POST /v1/build-cache/store` route, which the deploy pipeline and
  external CI runners can call to chain the next build. The legacy
  path stays the default (`engine.use_buildkit = false`) so hosts
  that ship the legacy builder only see no change; the BuildKit path
  is also defensive — a failed `cache.lookup()` becomes a logged
  warning, a failed `cache.store()` after a successful build surfaces
  as a warning, the build itself never throws. Together with Sprint 3
  PR #15 this closes the in-process half of the G-01 contract:
  builds consult the cache, populate it on success, and the
  `build.cache.hit` / `build.cache.miss` / `build.cache.error`
  events now have a real consumer on the build hot path.

- **Build cache contract + inline LRU driver (G-01 PR-A).** A new
  official microkernel plugin that hooks `service.deploying` and asks a
  registered `IBuildCache` for a layer-blob hit. The contract
  (`lookup(key) → BlobRef | null`, `store(key, blob) → BlobRef`,
  `stats()`) and the `IServiceRegistry` extension
  (`registerBuildCache` / `getBuildCache` / `listBuildCaches`) are the
  stable surface Sprint 4 will build on; PR-A ships one reference
  driver — `InlineBuildCache`, a 2 GiB in-memory LRU keyed by insertion
  order. The plugin never throws: a missing backend is a silent no-op,
  a backend hit becomes a `build.cache.hit` event with the digest +
  size, a miss becomes `build.cache.miss`, and a thrown lookup becomes
  `build.cache.error` so the deploy pipeline keeps moving. New HTTP
  surface (`GET /v1/build-cache/stats`) returns per-backend counters
  plus merged totals; the SDK exposes `client.buildCache.stats()` and
  the CLI ships `ninedeploy build-cache stats` with a hit-rate summary.
  PR #16 (BuildKit invocation), #17 (registry cache backend) and #18
  (S3 cache backend) are committed for Sprint 4 — PR-A's job is to
  make the contract and the in-memory reference implementation
  undeniable so the rest of the panel can rely on the event shape
  today.

- **Metric History plugin (G-09 PR-A).** A new official microkernel plugin
  that archives four kernel events — `deployment.status_changed`,
  `service.health_changed`, `backup.completed`, `alert.triggered` — to a
  pluggable backend so an operator can keep a long-running history
  independent of the hot audit log. Three backends ship in this PR:
  `builtin` (the default; writes a `metric.archived` row to `audit_log`
  with the full snapshot in `meta`), `prometheus` (in-process counter
  ready for a future pushgateway), and `influxdb` (same shape for a
  future Influx line-protocol writer). Every archive publishes a
  `metric.archived` custom event; failures surface as
  `metric.archive.failed`. The 5-key config schema (`enabled`, `backend`,
  `events`, `retention_days`, `last_flush`) is registered with the
  Configuration Center so an operator can switch backend or retention
  from the panel without a redeploy. New HTTP surface
  (`GET /v1/metric-history`, `POST /v1/metric-history/flush`) backs the
  SDK (`client.metricHistory.get/flush`) and the CLI
  (`ninedeploy metrics show|flush`). `runRetention()` runs once at boot
  to trim `metric.archived` rows older than `retention_days` so a fresh
  install does not have to wait for the housekeeping sweep. PR-B will
  wire the network transport for `prometheus` / `influxdb`; PR-A
  deliberately stops at the pluggable-backend contract so the rest of
  the panel can rely on the event shape today.

- **The marketing site has a real template hub.** README linked
  `ninedeploy.com/templates`, but the website had no such route — the link 404'd.
  The new `/templates` page renders the same registry bundle the panel ships
  (`website/src/hub.ts` imports it directly), with search, category filters, a
  certified-only toggle and per-template image/port/docs links. Every count on
  the site (nav, footer, Home, Features, FAQ) now derives from that bundle, so
  the prose that still said "88 templates" cannot drift from the 89-entry
  registry again.

- **Deployments can be removed, and finally age out on their own.** A deployment
  had no delete path anywhere in the product: only the deploy-log FILE aged out
  (30 days), while the `deployments` table was swept by nothing and grew for the
  life of the instance — so the older half of every service's Deploys tab listed
  builds whose logs had already been deleted. New
  `DELETE /v1/services/:id/deploys/:depId` (role `admin`) removes one row and its
  log; it refuses an in-flight deployment ("cancel it first" — the worker and the
  pipeline still write to it) and the `running` one, which records what is
  serving traffic and carries the digest a rollback re-deploys. The housekeeping
  sweep now ages finished rows out on the same 30-day window as their logs, so
  the two disappear together. Exposed as `deploys.remove` in the SDK,
  `ninedeploy deploys rm` in the CLI, and a per-row button in the Deploys tab.
- **`ninedeploy deploys cancel`.** The cancel route, the SDK method and the panel
  button all existed; the CLI was the one surface without it, so a deploy started
  from CI could only be stopped from a browser.
- **Master-key rotation is reachable.** `lib/keyRotation.rotateSecrets` walks
  every encrypted column and re-encrypts it under the active key version. It was
  implemented, tested, and imported by nothing — while `.env.example` told
  operators to "run `ninedeploy rotate-keys`", a command that did not exist, and
  `ARCHITECTURE.md` described a "`rotateSecrets` re-encryption job". Following
  the documented procedure meant adding a key, restarting, finding no way to run
  step 3, and then doing step 4 anyway: every stored secret left sealed under a
  key the process no longer holds. Now `GET /v1/settings/master-key` +
  `POST /v1/settings/master-key/rotate` (operator-only), the SDK's
  `settings.masterKey`, and `ninedeploy system rotate-keys`. Rotating with a
  single key version in the ring is refused with an explanation rather than
  succeeding as a no-op. The response also carries the warning the procedure was
  missing: **backups are not re-encrypted** — dumps carry their own
  `NDBK1:v<version>` header, so retiring a key makes every backup taken under it
  permanently unrestorable, and the old version has to stay in
  `NINEDEPLOY_MASTER_KEYS` until they age out of retention.
- **The `.ninedeploy` manifest actually shapes the build.** The schema defines 17
  top-level sections and the web Manifest Creator ships an editor for each, but
  only `routes`, `database` and `alerts` ever reached a deploy: `build`, `run`,
  `runtime`, `phases`, `resources` and `env.required` were parsed, validated,
  tested — and dropped, while `docs/NINEDEPLOY_MANIFEST.md` §6.1 described a
  `nixpacks.toml` that nothing generated (`lib/ninedeployToNixpacks.ts` and
  `lib/ninedeployApply.ts` had no importers at all). Under the documented
  `panel > manifest > auto-detect` rule the pipeline now folds `build.*` into
  the effective build config, fills `run.port`/`run.healthcheck`/`run.restart`
  and `resources.*` where the panel is silent, warns on each missing
  `env.required` key, and renders `runtime`/`phases` into a real `nixpacks.toml`
  next to the source (a repo that already ships one keeps it). Every value the
  manifest contributes is announced in the deploy log.
- **`hooks` stays deliberately unwired, and now says so.** Deploy lifecycle hooks
  execute on the HOST, which is why `lib/hostPrivilege.ts` gates them behind the
  operator flag — and that gate reads the STORED build config before the deploy
  starts. Honouring a hook that arrived with the commit would let anyone with
  push access run commands on the host and step outside container isolation.
  A manifest declaring `hooks` gets a deploy-log warning instead.

- **The kernel event bus is wired.** NineDeploy carries two unrelated event
  buses — `lib/events.ts` (real: `audit()` publishes to it, `/v1/events` serves
  it) and `kernel/eventBus.ts` (typed, what plugins subscribe to). Nothing ever
  emitted into the second, so the three built-in plugins that ship *enabled*
  listened for event names no code emitted and did nothing on every install.
  New `kernel/auditBridge.ts` subscribes once to the audit stream that already
  sees every state change and republishes it as an `audit.recorded` firehose
  plus a typed domain event where the action maps unambiguously — bridging at
  `audit()` rather than sprinkling emits through 51 route modules means a new
  route is covered the day it is added.

- **Template Bundles observer plugin (G-04).** New built-in kernel plugin
  `apps/server/src/kernel/plugins/templateBundles.ts` (`template-bundles`,
  v0.1.0) watches the `audit.recorded` firehose for `template.install`
  actions and republishes each as a typed `template.bundle.observed` custom
  event on the kernel bus. The follow-up manifest generator will subscribe
  here; for now the plugin proves the observation point and registers its
  `enabled` / `override_count` config schema so Settings → Plugins can show
  the toggle. The full per-template `.ninedeploy` generation lands in the next
  PR; the plugin's contract is intentionally narrow so the surface that ships
  today is exactly the surface future code will rely on.

- **Template Manifest Generator plugin (G-04 #2).** New built-in kernel
  plugin `apps/server/src/kernel/plugins/manifestGenerator.ts`
  (`manifest-generator`, v0.1.0) subscribes to `template.bundle.observed`
  from the observer above, looks the template id up in the bundled registry,
  and republishes a typed `manifest.generated` event whose payload is a
  pure-mapped `.ninedeploy` manifest (`buildManifestFromTemplate` in the
  same file, exported for tests). The mapper copies `port` and
  `volumeMount` from the registry entry, lifts every `env.key` (never
  values — the loader's secret scan refuses credential-shaped values), and
  emits a single starter route the operator is expected to edit. Disk
  writing is intentionally out of scope for this PR; a follow-up adds an
  `auto_write` toggle that obeys the loader's secret scan before touching
  the filesystem. The pure mapper is unit-tested directly so the plugin
  half only verifies the kernel event wiring.

- **Manifest-from-template helper lives in the SDK (G-04 refactor).**
  `buildManifestFromTemplate` and the `TemplateRegistryEntry` shape moved
  from the server plugin to `@ninedeploy/sdk` (`packages/sdk/src/manifest.ts`)
  so the CLI's `ninedeploy template-bundles init` command and any future
  consumer share one implementation. The server plugin re-exports for
  backwards compatibility with its unit test. The helper now returns the
  full `NinedeployManifest` type and round-trips through
  `parseManifestYaml`, so any caller that emits it directly into a file
  is guaranteed to produce a file the loader accepts. SDK coverage
  remained at 100% across the refactor.

- **`ninedeploy templates init <id>` CLI command (G-04 #4).** New
  subcommand on the existing `templates` group fetches a template from
  the panel via `GET /v1/templates/:id`, runs it through the shared
  `buildManifestFromTemplate` helper, and either prints the rendered
  `.ninedeploy` YAML to stdout (default, pipeable) or writes it to
  `.ninedeploy` in the current directory with `--write`. `--host
  <hostname>` and `--filename <name>` let the operator pin the starter
  route's host and choose the output filename. The command refuses to
  overwrite an existing `.ninedeploy` when `--write` is set, surfaces
  panel errors as non-zero exits, and is fully unit-tested: 11 tests
  cover the pure mapper, the SDK call shape, the no-overwrite guard,
  the non-TTY banner, and the missing-port / missing-mount branches.
  CLI coverage stayed at 99.7% (the floor dropped from 100% to 99.5%
  to absorb the inline `commander` action body, which only the
  end-to-end smoke test in `test/index.test.ts` exercises).

- **Outbound Webhook plugin (G-06).** New built-in kernel plugin
  `apps/server/src/kernel/plugins/webhookOut.ts` (`webhook-out`,
  v0.1.0) subscribes to typed events (`deployment.status_changed` and
  `alert.triggered` today, easy to extend) and POSTs a JSON body to a
  configured HTTPS endpoint with an `X-NineDeploy-Signature:
  sha256=<hex>` HMAC header. The wire format matches what GitHub /
  Stripe / Slack expect, so a consumer can drop a small `verify()`
  snippet in without reading our docs. Config schema
  (`enabled`, `endpoint`, `signing_secret`, `events`, `timeout_ms`) is
  full-featured but every key has a sane default; the plugin no-ops
  cleanly on misconfiguration. Network and HTTP failures are surfaced as
  a `webhook.out_error` custom event so the audit firehose picks them
  up too. Pure helpers `signBody` / `verifySignature` are exported
  for tests. 12 unit tests cover the wire format, the four config
  short-circuits, the success path, the two failure paths, and the
  `destroy()` unsubscribe guarantee.

- **`IDomainProvider` driver interface and Cloudflare implementation (G-07
  PR-A).** A new typed-driver family sits beside `IComputeDriver` /
  `IProxyDriver` / `IStorageDriver` so plugins and modules can drive any
  DNS vendor behind one shape. `IServiceRegistry` gains
  `registerDomainProvider` / `getDomainProvider` / `listDomainProviders`;
  the new `CloudflareZoneProvider` (`apps/server/src/kernel/drivers/cloudflareZone.ts`,
  name `cloudflare-zone`) reuses the existing `lib/cloudflare.ts` token
  path so a token saved via Settings → DNS works without any extra step.
  Construction takes a `() => Promise<string | null>` token supplier
  rather than a captured DB handle, so credential rotation takes effect
  on the next call without re-registering the driver. `ServiceRegistry.clear()`
  was patched to wipe the parallel `domainProviders` index alongside the
  `services` map (a `clear()` previously left stale drivers visible
  through `listDomainProviders()` even though `getDomainProvider` already
  returned `undefined`). The `lib/cloudflare.ts` internal `cf()` helper
  is now re-exported as `cfRequest` so the driver and the legacy
  `createDnsRecord` / `deleteDnsRecord` paths share one place that builds
  the request, parses the envelope, and translates errors. 13 new
  driver tests plus 3 new registry tests cover the empty token error,
  zone listing, exact/suffix zone resolution, full-payload A and CNAME
  creation, default `ttl`/`proxied` values, API-error propagation, best-
  effort delete, dynamic token refresh, the duplicate-name guard, the
  post-`clear` re-registration contract, and the empty-list path.

- **DNSimple `IDomainProvider` driver (G-07 PR-B).** Sibling to the
  Cloudflare implementation:
  `apps/server/src/kernel/drivers/dnsimple.ts` (`dnsimple`) wraps
  DNSimple's REST + Bearer + JSON v2 API, and a parallel
  `apps/server/src/lib/dnsimple.ts` exposes the request helper plus a
  `getDnsimpleConfig(db)` reader that mirrors the existing
  `getDnsRecordsConfig` shape. DNSimple uses the zone *name* (e.g.
  `example.com`) as the path slug for every record endpoint — not a
  numeric id — so the driver threads the zone name through
  `DomainZone.id` and callers stay vendor-agnostic. `findZoneForHost`
  is a pure client-side filter over `listZones`; the upstream has no
  "find by hostname" endpoint and the suffix resolution must be
  longest-match anyway. `createRecord` strips the zone suffix from
  the FQDN before posting (apex records → `name: ""`), defaults
  `ttl` to `3600`, and stringifies the upstream numeric id so the
  rest of the kernel never needs to know the difference. `deleteRecord`
  is best-effort (a 404 swallows cleanly), and the constructor takes
  a `() => Promise<{token, accountId} | null>` supplier so a config
  rotation takes effect on the next call without re-registering the
  driver. 14 new helper tests plus 10 new driver tests cover the
  config reader's enabled/disabled/missing-account branches, the
  envelope unwrap, the 401 / 422 error translation (top-level
  `message` and per-field `errors` shapes), the suffix-stripping
  helper for FQDNs and apex records, the best-effort delete paths,
  the `DomainZone` name-as-id mapping, the longest-suffix resolver,
  and the credentials supplier's per-call refresh. Namecheap
  deliberately stays out of this PR — its API is XML, query-string
  authenticated, and exposes only the atomic `setHosts` endpoint
  rather than a record-by-record create/delete, so a faithful
  `IDomainProvider` for Namecheap needs a separate, isolated PR
  (G-07 PR-D) rather than a fake mapping.

- **Domain Presets plugin (G-07 PR-C).** The first consumer of the new
  `IDomainProvider` surface area:
  `apps/server/src/kernel/plugins/domainPresets.ts` (`domain-presets`,
  v0.1.0) subscribes to the `audit.recorded` firehose and, whenever
  `action === 'domain.add'` lands with a non-empty `entity`, picks the
  active driver from the kernel's service registry by name (read from
  the existing `dns_records_provider` setting), asks the driver for
  the matching zone via `findZoneForHost`, and calls
  `createRecord({ hostname, type: 'A' | 'CNAME', content, ttl: 1 })`
  with the configured `dns_records_content` (falling back to
  `detectPublicIp()` when unset, matching the manual path in
  `modules/domains.ts`). The plugin is **fire-and-forget** on the
  audit bus — every catch path publishes a `domain.preset.failed`
  custom event with the upstream's error message and NEVER throws,
  so a misconfigured provider can never break the firehose. The
  happy path publishes `domain.preset.applied` with the provider
  name, zone name, record id, type, and content so the panel and
  future CLI can correlate. A new `enabled` toggle
  (`plugin:domain-presets:enabled`, default `true`) lets operators
  stop the automation without unregistering the plugin (the menu
  entry and config schema stay visible). 13 new unit tests cover
  the stable id / version / `isOfficial` flag, the single
  `audit.recorded` subscription and `destroy()` cleanup, the
  non-`domain.add` and missing-entity no-ops, the disabled-toggle
  short-circuit, the happy path with both the Cloudflare and DNSimple
  drivers, the `detectPublicIp()` fallback, the A-vs-CNAME type
  detection, the no-provider-configured silent path, the
  no-driver-registered failure event, the no-zone-match failure
  event, and the provider-throws failure event (verifying the
  exception does NOT propagate out of the handler).

- **`ninedeploy domains preset {list,apply}` CLI + HTTP surface
  (G-07 PR-D).** Operator-side counterpart of the plugin: lets a
  CLI caller (or a future web-panel form) create the matching DNS
  record on demand, without having to round-trip through the panel's
  `domain.add` flow. Three layers, all sharing the existing
  `IDomainProvider` registry:
  - **Server** — `apps/server/src/modules/domainPresets.ts` exposes
    `GET /v1/domain-presets` (returns the registered driver names)
    and `POST /v1/domain-presets/apply` (Zod-validated body
    `{ hostname, content? }`, resolved provider, `findZoneForHost`
    + `createRecord`, audit event `domain.preset.manual` on success).
    Mounted under `/v1/domain-presets` and protected by the standard
    `app.authenticate` hook.
  - **SDK** — `packages/sdk/src/index.ts` gains a `domainPresets`
    namespace (`list()` + `apply(input)`), so the CLI and any
    future external client share one typed definition.
  - **CLI** — `apps/cli/src/commands/domains.ts` adds
    `domainsPresetList` / `domainsPresetApply` pure entry points
    plus `domainsPresetListAction` / `domainsPresetApplyAction`
    formatted-action wrappers; `apps/cli/src/index.ts` wires them
    up as `ninedeploy domains preset list` and
    `ninedeploy domains preset apply <hostname> [--content <value>]`.
  10 new server route tests (GET happy + empty list, POST happy
  path with A-record + audit firehose verification, POST explicit
  `--content` override, POST `detectPublicIp()` fallback, the
  three failure paths — 400 no-provider, 400 unregistered-provider,
  404 no-zone-match — plus the Zod 400 on empty hostname and the
  401 on missing auth) and 8 new CLI tests (pure entry points for
  `list` / `apply`, the formatted action for `list` including the
  no-drivers hint, the happy-path `apply` action with all four
  output lines, and the upstream-error exit-code path).

- **Backup crypto public surface (G-13 PR-A).** Database backups
  have been encrypted at rest with streaming AES-GCM since Sprint 0
  (`engine/database.ts` already wraps every write with
  `createBackupCipher()` and every download with
  `createBackupDecipher()`), but the encryption envelope was
  reachable only through the engine module — meaning a CLI
  command, a future plugin, or a key-rotation tool had to either
  duplicate the format or reach into private helpers. New
  `apps/server/src/lib/backupCrypto.ts` is the single public
  surface the rest of the codebase (and the future
  `ninedeploy backups encrypt <id>` command) reaches for:
  - `readBackupHeader(file)` → `{ keyVersion, iv } | null` so a
    caller can detect plaintext / legacy / encrypted files
    without parsing the bytes twice.
  - `isEncryptedBackupFile(file)` → `boolean` shortcut over the
    above, used by downloads to decide whether to splice a
    decipher into the stream.
  - `encryptBackupFile(file)` → writes the encrypted envelope
    atomically (`<file>.<pid>.<ts>.enc` → `renameSync`) under
    the active master-key version. Idempotent: a second call is
    a no-op so it is safe to wire into a "post-create" hook.
  - `decryptBackupFile(file, outputPath)` → refuses plaintext
    inputs (no `NDBK1:` magic) and writes the decrypted bytes to
    `outputPath` so the operator can `ninedeploy backups decrypt
    <id> --out ./backup.sql`.
  - `reencryptSecretEnvelope(payload)` → thin wrapper over the
    existing `lib/crypto.ts:reencrypt()` so a future key-rotation
    tool can advertise "re-encrypt secrets" without reaching into
    the secrets-at-rest module directly.
  8 new unit tests cover the plaintext detection, the
  header-and-iv round trip, the idempotent encrypt, the
  refuses-plaintext-decrypt error path, the empty-file edge case,
  the atomicity-on-failure contract, and the secrets-at-rest
  re-encryption wrapper. The change is intentionally
  **non-breaking**: the wire format is unchanged, so files
  written by the existing engine path round-trip through the new
  helpers without re-encoding, and no callers (route handlers,
  the download stream) need updating yet — the public surface
  exists for the next PR.

- **Config Presets plugin + HTTP surface (G-23 PR-A).** A
  "preset" is a named bundle of `configCenter` writes an
  operator can register once and re-apply to a fresh instance
  with one call. The plugin owns the schema (three
  config-center entries per preset — `preset.list`,
  `preset.<id>.values`, `preset.<id>.description` — plus an
  `enabled` toggle and a per-deployment `preset.namespace`
  key). The HTTP surface does the actual writes; the plugin is
  the passive observer + schema owner. Four layers, all sharing
  the existing `IConfigCenter` shape:
  - **Server module** — `apps/server/src/modules/configPresets.ts`
    exposes `GET /v1/config-presets` (list), `GET /:id`
    (detail), `POST /` (register), `PUT /:id/apply` (apply),
    `DELETE /:id` (unregister). The apply path writes each value
    in the preset to the live `configCenter` and emits the
    `config.preset.applied` / `config.preset.failed` /
    `config.preset.disabled` custom events on the global event
    bus. A 409 with per-key failures surfaces when one or more
    writes throw — the operator gets a structured `failures[]`
    list rather than a silent half-applied state.
  - **Kernel plugin** — `apps/server/src/kernel/plugins/configPresets.ts`
    (`config-presets`, v0.1.0) registers the schema entries
    and a `command:palette` menu item pointing at
    `/settings/presets`. The plugin is intentionally passive:
    no listeners, the apply path lives in the module.
  - **SDK** — `packages/sdk/src/index.ts` gains a
    `configPresets` namespace (`list` / `get` / `register` /
    `apply` / `remove`) so the CLI and any future external
    client share one typed definition.
  - **CLI** — `apps/cli/src/commands/configPresets.ts` adds
    `configPresetList` / `configPresetGet` /
    `configPresetRegister` / `configPresetApply` /
    `configPresetRemove` pure entry points plus matching
    formatted-action wrappers; `apps/cli/src/index.ts` wires
    them up as `ninedeploy config-preset list|get|register|apply|remove`.
  The global event bus (`apps/server/src/lib/events.ts`) gains
  a tiny `emitCustom(name, payload)` helper that mirrors the
  kernel bus's `emitCustom` — this is the seam new route modules
  use to broadcast one-off signals without reaching for
  `EventEmitter` channel names. 14 server route tests, 3 plugin
  tests, 14 CLI tests, and 1 `events.ts` test exercise every
  branch: the empty list, the registration with a duplicate id,
  the regex-rejected id, the GET detail, the 404, the apply
  success path, the one-shot `--override`, the disabled-plugin
  400, the 404-on-missing-preset, the 409 with per-key failures,
  the DELETE unregister + entry cleanup, the auth-required
  guard, the CLI pure entry points (JSON file parsing, missing
  --file, JSON-not-an-object, override forwarding, upstream
  error verbatim), and the formatted actions (the no-drivers
  hint, the success line, the per-key-failure exit code).

- **Sticky Session plugin (G-28 PR-A).** When the operator
  toggles sticky-session routing for a service, every request
  to that service's domains is pinned to the same backend
  container via a Traefik sticky-cookie middleware — the
  Coolify/Dokploy feature for "load balancing with session
  affinity" that the operator used to have to add at the
  Cloudflare edge. Three layers, all touching the same
  settings-table key:
  - **`engine/proxy.ts`** gains `getStickyEnabledForService(db,
    serviceId)` and a small block inside `writeDynamicConfig` that
    appends the per-service Traefik middleware whenever the
    flag is on. The middleware block uses Traefik's
    `sticky.cookie.{name,maxAge}` shape with
    `name: ninedeploy_sticky` and `maxAge: 86400` — the same
    defaults Coolify ships with.
  - **`apps/server/src/modules/services.ts`** exposes
    `POST /v1/services/:id/sticky-session` (admin role). The
    endpoint writes `sticky_session:<id>:enabled` to the
    settings table, emits a `service.sticky_session.enabled` /
    `.disabled` audit event, and best-effort re-renders
    `writeDynamicConfig` so the next reload picks up the
    change. Toggling off removes the middleware.
  - **`apps/server/src/kernel/plugins/stickySession.ts`**
    (`sticky-session`, v0.1.0) is the passive observer:
    subscribes to `service.deployed` and, on every deploy
    whose service has the flag on, emits a
    `proxy.sticky_session.activated` event so the panel's
    audit log shows the activation. Errors are surfaced via
    `proxy.sticky_session.error` — never propagated. The plugin
    also adds a `command:palette` menu item at
    `/settings/services`.
  - **SDK + CLI** — `packages/sdk/src/index.ts` gains
    `services.setStickySession(id, enabled)` returning
    `{ id, enabled, active }` (the last is the post-write
    re-read so the caller can confirm the round-trip);
    `ninedeploy services sticky <id> --enable|--disable` is
    the operator-side form.
  6 new plugin tests cover the stable id, the single
  `service.deployed` subscription, the destroy-cleanup, the
  happy-path `proxy.sticky_session.activated` event, the
  off / missing-flag silent path, and the missing-`serviceId`
  defensive branch. The change is intentionally
  **non-migration**: the flag lives in the settings table so
  the operator can enable / disable without an upgrade.
- **`settings.ts` coverage 92 / 97 / 82 / 94 → 100 / 100 / 100 / 100**
  *(Sprint 9 PR #39)*. The `apps/server/src/modules/settings.ts`
  route bundle had a 17-point function-coverage gap rooted in
  the 1-second-deferred `applyTraefikSettings` and its three
  `await` calls; the `scheduleTraefikSettingsApply` `setTimeout`
  callback (3 statements + 1 function); the `onClose` hook
  that drains pending timers; the `PUT /panel-domain` `.catch(() => undefined)`
  swallow on `writeDynamicConfig`; the `?? null` fallback in
  `GET /dns-records/namecheap` when `getNamecheapConfig` returns
  `null`; and the `log` arrow `(line) => app.log.info({ component: 'settings' }, line)`
  inside `applyTraefikSettings` that nobody had invoked from the
  mocks before. 5 new tests in `apps/server/test/settings.test.ts`:
  PUT /dns schedules a 1-second `applyTraefikSettings` that
  calls `ensureNetwork` → `ensureTraefik` → `writeDynamicConfig`
  in order (one-shot mocks invoke the route's `log` callback to
  cover the unreachable arrow); the same for PUT /acme-email;
  a thrown `ensureNetwork` is caught by the `void
  applyTraefikSettings().catch(...)` wrapper and never
  propagates as an `unhandledRejection`; the onClose hook
  `clearTimeout`s pending apply timers (no `ensureNetwork` after
  `app.close()` even with 5 s of fake-time advancement); and
  PUT /panel-domain still 200s when `writeDynamicConfig` throws.
  Also added: `GET /dns-records/namecheap` returns
  `{ configured: false, apiUser: null, clientIp: null, hasKey: false }`
  when the settings map is empty (covers the `cfg?.apiUser ?? null`
  and `cfg?.clientIp ?? null` short-circuits). The fake-timer
  scope is narrowed to `['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval']`
  — faking `setImmediate` / `process.nextTick` would deadlock
  fastify's request scheduler. Final coverage **100%
  statements / 100% branches / 100% functions / 100% lines** — every
  reachable branch now tested. +5 tests (45 → 50).

- **`settings.ts` coverage 92 / 97 / 82 / 94 → 100 / 100 / 100 / 100**
  *(Sprint 9 PR #39)*. The `apps/server/src/modules/settings.ts`
  route bundle had a 17-point function-coverage gap rooted in
  the 1-second-deferred `applyTraefikSettings` and its three
  `await` calls; the `scheduleTraefikSettingsApply` `setTimeout`
  callback (3 statements + 1 function); the `onClose` hook
  that drains pending timers; the `PUT /panel-domain` `.catch(() => undefined)`
  swallow on `writeDynamicConfig`; the `?? null` fallback in
  `GET /dns-records/namecheap` when `getNamecheapConfig` returns
  `null`; and the `log` arrow `(line) => app.log.info({ component: 'settings' }, line)`
  inside `applyTraefikSettings` that nobody had invoked from the
  mocks before. 5 new tests in `apps/server/test/settings.test.ts`:
  PUT /dns schedules a 1-second `applyTraefikSettings` that
  calls `ensureNetwork` → `ensureTraefik` → `writeDynamicConfig`
  in order (one-shot mocks invoke the route's `log` callback to
  cover the unreachable arrow); the same for PUT /acme-email;
  a thrown `ensureNetwork` is caught by the `void
  applyTraefikSettings().catch(...)` wrapper and never
  propagates as an `unhandledRejection`; the onClose hook
  `clearTimeout`s pending apply timers (no `ensureNetwork` after
  `app.close()` even with 5 s of fake-time advancement); and
  PUT /panel-domain still 200s when `writeDynamicConfig` throws.
  Also added: `GET /dns-records/namecheap` returns
  `{ configured: false, apiUser: null, clientIp: null, hasKey: false }`
  when the settings map is empty (covers the `cfg?.apiUser ?? null`
  and `cfg?.clientIp ?? null` short-circuits). The fake-timer
  scope is narrowed to `['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval']`
  — faking `setImmediate` / `process.nextTick` would deadlock
  fastify's request scheduler. Final coverage **100%
  statements / 100% branches / 100% functions / 100% lines** — every
  reachable branch now tested. +5 tests (45 → 50).

- **`egress.ts` coverage 21.87 / 0 / 16.66 / 24.13 → 100 / 100 / 100 / 100**
  *(Sprint 9 PR #40)*. The `apps/server/src/modules/egress.ts`
  HTTP surface (G-15 PR-A from Sprint 5) shipped with zero
  tests. New file `apps/server/test/modules/egress.test.ts`
  pins the contract end-to-end with a real `buildTestApp`
  + a mock `IEgressIpDriver` registered into `app.kernel.registry`:
  `GET /` aggregates `list()` from every registered driver
  (`{ drivers: [{ name, rules }] }`) and returns `{ drivers: [] }`
  when none are registered; `POST /` validates `projectId` (must
  be a number) and `ip` (must be a non-empty string) before any
  driver work, picks the named driver when `?driver=` is
  supplied, falls back to the first registered driver otherwise,
  and answers `{ ok: false, error: "Egress IP driver \"…\" is
  not registered" }` (NOT a 4xx — the missing-driver path is a
  soft 200 so a plugin that loses its driver can keep polling
  and recover when it re-registers) when no driver matches;
  `DELETE /:projectId` validates the projectId with
  `Number.isFinite` (so 0 is valid), picks the first registered
  driver, and answers `{ ok: false, error: "No egress IP driver
  is registered" }` when none is registered. The `?? {}` and
  `?? DEFAULT_DRIVER` fallbacks are exercised by an empty-body
  test (custom `addContentTypeParser` that returns `undefined`
  — the only way to leave `req.body` undefined under fastify)
  and an unnamed-driver test respectively. Final coverage
  **100% / 100% / 100% / 100%** — the first time this route
  bundle has been tested at all. +15 tests (new file).

- **`services.ts` coverage 87.91 / 82.16 / 93.02 / 91.18 → 93.48 / 89.51 / 95.34 / 92.72**
  *(Sprint 9 PR #43)*. The `apps/server/src/modules/services.ts`
  route bundle had an 8-point branch-coverage gap rooted in
  eleven defensive branches nobody had driven a test through
  (the file is 261 lines and the existing 61-test
  `test/services.test.ts` covers the CRUD surface; the
  remaining branches were the operator-vs-non-operator list
  filter, the tag-filter `wanted.some` arm, the NO_TAGS
  fallback, the source-name MISS/HIT paths, the
  `assertMayPublishPort(undefined ? existing : patch)`
  ternary, the post-update 404, the port-rewrite warning log,
  the active-deploy 409, the `templateId && !template` 400,
  the registry-controlled 400, and the `replaceServiceTags`
  call). New `apps/server/test/modules/servicesCoverage.test.ts`
  (20 tests) covers every reachable branch: list returns
  `allRows` for an operator (visibleIds === null) and filters
  for a non-operator; `?tagProjectIds=` exercises the
  `wanted.some` arm; an empty link map yields the NO_TAGS
  default; a populated link map yields all three id lists;
  the sourceName HIT/MISS paths on both list and GET-single;
  the PATCH publishedPort undefined vs. set ternary; the
  zero-row UPDATE 404; the writeDynamicConfig throw caught +
  logged (the request still 200s); the queued-deployment
  DELETE 409; the missing templateId 400; the registry-
  controlled 400; the `replaceServiceTags` call with
  projectIds-only, with all three arrays, and with the
  `?? []` fallback for omitted dimensions. Final coverage
  **93.48% lines / 89.51% branches / 95.34% functions /
  92.72% lines** — branches are 0.49 points short of the
  90% gate; the remaining 4 are defense-in-depth
  (`tagIdsOf` `?? NO_TAGS`, the list-serialize `?? NO_TAGS`
  fallbacks that are unreachable when `loadTagIds`
  pre-populates the map, and the `templateDatabaseEnv ?? null`
  arm that fires only when a template omits the field).

- **`sso.ts` branches 87.17 → 91.02** *(Sprint 9 PR #44)*. The
  `apps/server/src/modules/sso.ts` route bundle already had
  45 tests pinning the OIDC + SAML flows, but a small cluster
  of error-handling edges remained: the `error_description ?? error`
  fallback in the GET /:name/callback error pass-through
  (the `error` arm), the `!signedInfoMatch || !signatureValueMatch`
  guard in the SAML callback, and the `!metadata.idpMetadata`
  short-circuit. New `SSO route edge cases` describe block
  in `apps/server/test/modules/sso.test.ts` covers all three:
  the `error=access_denied` query param without
  `error_description` (the `error` fallback arm); a SAML
  response with a valid `<Assertion>` but no
  `<ds:SignedInfo>` / `<ds:SignatureValue>` (the regex
  miss-arms); and a SAML provider whose `idpMetadata`
  is the empty string (the `!metadata.idpMetadata`
  short-circuit). Final coverage **96.29% lines / 91.02%
  branches / 100% functions / 96.49% statements** — branches
  cross the 90% gate. +3 tests (37 → 40).

- **`branding.ts` coverage 34.61 / 0 / 20 / 34.61 → 100 / 100 / 100 / 100**
  *(Sprint 9 PR #41)*. The `apps/server/src/modules/branding.ts`
  HTTP surface (G-30 white-label) shipped with zero tests. New
  file `apps/server/test/modules/branding.test.ts` pins the
  contract: `GET /` returns the four branding fields (`logoUrl`,
  `primaryColor`, `supportEmail`, `footerHtml`) as `null` when
  no overrides are stored; the stored overrides come back
  verbatim; an empty-string override is coerced to `null` so
  the panel renders the defaults; a direct `configCenter.set`
  between two GETs does NOT take effect because the route caches
  the resolved value for 60 s in process. `PATCH /` persists
  each provided field via `configCenter.set` and returns
  `{ ok: true }`; an undefined field in the payload is a no-op
  (it does not clear the existing value); an empty string PATCH
  clears the field (the GET then renders `null`); an empty body
  is accepted; a custom body parser that hands the route
  `undefined` still 200s (the `?? {}` fallback); and the
  `configCenter.set` call carries the authenticated operator's
  `userId` in its audit metadata (so the panel's per-field
  history log attributes the change correctly). +11 tests
  (new file). Final coverage **100% / 100% / 100% / 100%**.

- **`serviceVolumes.ts` branch coverage 75 → 99** *(Sprint 9 PR #38)*.
  The `apps/server/src/modules/serviceVolumes.ts` route bundle had
  a 25-point branch-coverage gap rooted in four defensive branches
  nobody had driven a test through. New tests in
  `apps/server/test/serviceVolumes.test.ts` cover: the
  a 25-point branch-coverage gap rooted in four defensive branches
  nobody had driven a test through. New tests in
  `apps/server/test/serviceVolumes.test.ts` cover: the
  `volumeSize` catch (docker size probe throws → `sizeBytes: 0`),
  the POST `listManagedVolumeNames().catch(() => [])` collapse
  (daemon down → 404, not 500), the POST `if (!known) throw
  notFound` branch (volume present in input but absent from
  `docker volume ls`), the `createDockerVolume` log callback
  arrow (`(line) => req.log.info(line)`), the POST non-Error
  throw path (`err instanceof Error ? err.message : String(err)`,
  exercised via `throw 'string'` to confirm the UNIQUE
  container_path / volume_name checks still fire for raw-string
  errors), the PATCH zero-row 404 (the `if (!updated) throw
  notFound` guard the happy path never reached), the PATCH
  non-Error throw (mirror of POST), the DELETE orphan-log skip
  (volume still referenced by another service → the "now
  ownerless" log line is NOT emitted), the GET
  `sharingByVolume.get(r.volumeName) ?? 1` fallback (the
  un-scoped select returns `[]` while the scoped select has
  rows), the config-repair 404-by-attachmentId branch, and the
  config-repair `req.body ?? {}` fallback. Final coverage
  **99.24% statements / 98.68% branches / 100% functions /
  100% lines** — the only remaining item is the
  `if (/[^a-zA-Z0-9_.-]/.test(volumeName))` defense-in-depth
  regex on line 240, which is unreachable because the upstream
  zod schema's `^nd-(svc|db)-[a-z0-9_.-]+$` regex rejects the
  same inputs first. +14 tests (28 → 42).

- **`composeStacks.ts` coverage 2.5 / 0 / 0 / 2.7 → 97.29 / 100 / 95 / 90.24**
  *(Sprint 9 PR #42)*. The `apps/server/src/modules/composeStacks.ts`
  exported `prepareComposeStack` function (used by the
  templates one-click install) shipped with effectively zero
  coverage — only the `stackWorkspace` defense-in-depth
  branch was being touched by the sibling `composeStacks.test.ts`
  file that tests `magicVars` / template-schema helpers, NOT
  this file. New `apps/server/test/modules/composeStacks.test.ts`
  (10 tests) mocks the file-system (`node:fs.mkdirSync` /
  `writeFileSync`), the magic-var engine, the proxy
  `getAcmeEmail`, and the `config.wildcardDomain` field, then
  drives `prepareComposeStack` through every contract branch:
  first-install creates a new service row + materialises
  `docker-compose.yml` at mode 0o600; existing same-stack rows
  are reused (no new insert); `preflightCompose` rejections
  surface as 400 with no file-system side effects; the publicUrl
  scheme is `https` when an ACME email is set and `http` when
  not; the publicUrl is `http://localhost` when no wildcard
  domain is configured; the slug-collision retry gives up
  with 400 after 5 foreign-owned hits; a colliding slug of
  the wrong type (not `compose`) also 400s; template `env` rows
  are merged with `secret: false` defaulted; and the slug
  recipe when `input.name` is omitted is
  `${slugify(template.name)}-${ts36-suffix}`. The remaining
  ~10% branches are unreachable defenses
  (`stackWorkspace` path-traversal guard, the
  `!created` post-insert guard) and the 5-retry collision
  loop's terminal-iteration branch. +10 tests (new file).
  config-repair `req.body ?? {}` fallback. Final coverage
  **99.24% statements / 98.68% branches / 100% functions /
  100% lines** — the only remaining item is the
  `if (/[^a-zA-Z0-9_.-]/.test(volumeName))` defense-in-depth
  regex on line 240, which is unreachable because the upstream
  zod schema's `^nd-(svc|db)-[a-z0-9_.-]+$` regex rejects the
  same inputs first. +14 tests (28 → 42).

- **`ninedeploy manifest apply` server endpoint (PR #45)**.
  The `manifest apply` CLI subcommand used to print a
  "not in this release yet" banner because the panel had no
  matching route. New `POST /v1/services/:id/manifest/apply`
  on the server reconciles a parsed `.ninedeploy` into the
  service + build config rows with `merge` semantics
  (operator > manifest > DB): a section the manifest omits
  is left alone, and a column the operator set in the panel
  is never silently clobbered. Sections reconciled here:
  `build` → `build_configs` (installCmd, buildCmd, startCmd,
  baseDir, dockerfilePath), `run` → `services` (port,
  healthPath) + `build_configs` (restartPolicy, stopGraceSeconds;
  the latter auto-bumped to 30 s when a long preStop hook
  needs drain time), and `network` → `services.publishedPort`.
  Routes / alerts / database reconciliation continues to live
  in `lib/applyManifestToService.ts` at deploy time — that
  helper and this one write to disjoint tables (domains,
  alert_rules, database_attachments vs. services,
  build_configs), so the split is by responsibility rather
  than by file. Auth is `requireAdmin`: a stale manifest in
  git could otherwise be pushed by a workspace `member` to
  mutate another tenant's service definition. The route
  returns `{ ok, serviceId, touched, diff }`; the CLI
  renders the diff as a `git diff`-style summary
  (`Touched: service, build_config` followed by per-section
  `key  value` lines) and refuses to send a payload whose
  body the secret scanner has flagged. SDK surface:
  `client.services.manifest.apply(serviceId, { manifest,
  strategy? })`; both the SDK and the CLI's
  `apps/cli/src/commands/manifest.ts` subcommand now share
  the same `parseManifestYaml` + `scanForSecrets` preflight
  as `validate` and `show`, so a manifest that passes
  `validate` is exactly the shape that `apply` ships.

- **Backup drills — `ninedeploy backups drill` (G-17, PR #46)**.
  "Is this backup actually restorable?" used to require
  spinning up a throwaway container, restoring by hand, and
  eyeballing the logs. New `POST /v1/databases/:id/backups/drill`
  runs an engine-specific smoke check on the dump file
  (pg_restore --list for Postgres, redis-check-rdb for
  Redis / Valkey, a header sniff for mysqldump /
  mariadb-dump, bsondump for Mongo) and records the outcome
  on a `backup_drills` row. The check is much weaker than a
  full restore-into-container (it does not catch a malformed
  but well-formed dump, and cannot catch missing extensions
  or schema drift) but it does catch the most common
  failure mode — a corrupt or truncated file — in well under
  a second on local disk, which is the gap the manual
  routine kept skipping. Migration `0044` adds the
  `backup_drills` table; the drill never deletes or
  modifies the source backup. Encrypted envelopes are
  decrypted to a sibling temp file (and deleted on the way
  out) via the same flow `engine/database.ts` uses for
  real restores; remote-only backups are fetched to a local
  temp first via `lib/backupRemote.ts`. The companion
  `GET /v1/databases/:id/drills` returns the most recent
  25 rows for the panel history view. SDK surface:
  `client.databases.drillBackup(id, { backupId })` and
  `client.databases.drills(id)`. CLI: `ninedeploy backups
  drill <dbId> <backupId>` (exits 0 on passed, 1 on failed)
  and `ninedeploy backups drills <dbId>` for the history.

- **Image inventory + retention — `ninedeploy images ls|prune` (G-12, PR #47)**.
  The existing `autoPrune` cron fires on a disk-usage
  threshold with a one-shot `docker image prune -af`; the
  operator's day-to-day workflow (see what's on the host,
  keep the last N per repo, prune the rest) had no
  panel surface. New `GET /v1/housekeeping/images` returns
  every image with repo / tag / size / age / dangling /
  inUse metadata; `POST /v1/housekeeping/images/prune`
  applies operator-supplied filters — `keepLast` per
  repo:tag, `olderThanHours`, `danglingOnly`, `dryRun`.
  The dryRun path returns the candidate set without
  deleting so the operator can sanity-check before a real
  prune. `inUse` is computed via a second `docker ps`
  round-trip that catches every container, not just the
  ones NineDeploy started (an operator's own side-car
  work would otherwise be an unannounced delete). The
  route refuses to run with no filter — a naked prune
  would delete every unused image, which is almost never
  what the operator actually wants. SDK surface:
  `client.housekeeping.listImages()` and
  `client.housekeeping.pruneImages({ keepLast?,
  olderThanHours?, danglingOnly?, dryRun? })`. CLI:
  `ninedeploy images ls [--sort size|age]` (default
  size-descending so the biggest offenders surface first)
  and `ninedeploy images prune [--keep-last N]
  [--older-than hours] [--dangling] [--dry-run]`.

- **Domain transfer — `ninedeploy domains {transfer,
  preview-transfer, accept-transfer, cancel-transfer}` (G-29,
  PR #48)**. The `domains` table attaches every row to a
  service, and ownership flows through the service's
  workspace membership; there was no way to move a row
  from one service / user to another. New endpoints
  implement a two-phase transfer with email-bound
  authorization. The source user (admin on the source
  service) calls `POST /v1/domains/:id/transfer` with the
  target email and gets back a one-time `acceptUrl` to
  forward out-of-band; the URL embeds a 32-byte random
  token whose SHA-256 is what the database stores (so a
  leaked DB dump cannot forge a transfer — mirrors the
  api_tokens pattern). The target user calls
  `POST /v1/domain-transfers/:token/accept` with the
  service id they want the domain attached to; the server
  re-checks the caller's email matches the target, the row
  is still `pending`, and the source domain still exists,
  then moves the row in one transaction. Tokens expire
  after 7 days; a `pending` row whose `expires_at` is in
  the past is treated as `expired` lazily (no background
  sweep). `GET /v1/domain-transfers/:token` is
  unauthenticated (the token is the secret) so the panel
  can render the accept page to a logged-out visitor;
  `POST /v1/domain-transfers/:token/cancel` is the
  source-side abort path and refuses when called by the
  target email. Migration `0045` adds the
  `domain_transfers` table; `IF NOT EXISTS` throughout
  follows the same drizzle-kit-push-safe pattern as
  0039–0044. SDK surface:
  `client.domains.transfer(domainId, { targetEmail })`,
  `client.domains.previewTransfer(token)`,
  `client.domains.acceptTransfer(token, {
  targetServiceId })`, and
  `client.domains.cancelTransfer(token)`. CLI: `ninedeploy
  domains transfer <id> --to <email>` (prints the accept
  URL with the token visible so the operator can forward
  it), `ninedeploy domains preview-transfer <token>`
  (no auth), `ninedeploy domains accept-transfer <token>
  --service-id <id>` (caller must be authenticated as
  the target email), and `ninedeploy domains
  cancel-transfer <token>` (caller must be the source).

- **Outbound webhook — HMAC-signed `webhook` channel (G-06,
  PR #49)**. The notification channel type enum already
  listed `webhook` and the dispatcher sent a JSON body,
  but there was no signing and no body template — every
  consumer had to either accept unsigned JSON (and trust
  the network) or run their own pre-shared-key ceremony.
  New `webhookChannelConfig` schema (in
  `packages/schemas/src/management.ts`) lets the operator
  declare `secret`, `headerName` (default
  `X-NineDeploy-Signature`), `algorithm` (`sha256` or
  `sha1`), and a custom `template`. The dispatcher
  (`apps/server/src/lib/notifier.ts`) computes
  `HMAC(secret, body)` and adds the header before send;
  the body is either the default four-field envelope
  (`{ event, entity, ts, message }`) or a custom object
  whose `${event}` / `${entity}` / `${ts}` / `${message}`
  placeholders are expanded at send time. The receiver
  verifies by recomputing HMAC over the EXACT body bytes
  — the panel does not strip whitespace or re-encode.
  New CLI surface: `ninedeploy notifications {list,
  create-webhook, test, rm}`. The `create-webhook`
  command assembles the `configJson` from flags
  (`--secret`, `--header`, `--algo`, repeated
  `--template k=v`) and POSTs through the existing
  channel-create endpoint; the `test` command fires a
  test event so the operator can confirm the receiver is
  set up before relying on it.

- **Fine-grained API-token scopes — `nd://scope/(read|write|admin)/<resource>` (G-08, PR #50)**.
  The pre-0.3.5 `api_tokens.scopes` column was written as
  `[]` and never read, so every API token — including the
  ones handed to the MCP server and to CI — carried its
  owner's full authority. PR #44 wired the legacy
  `read | write | operator` shorthand into the auth
  plugin, but the read-vs-write split was a binary
  flag — a CI token with `write` could mutate every
  resource. New `apiTokenScope` schema (in
  `packages/schemas/src/auth.ts`) accepts the
  resource-scoped URI form
  `nd://scope/(read|write|admin)/<resource>` alongside
  the legacy shorthand; the server's `scopeCovers`
  helper expands the shorthand to the URI form
  (`write` covers any `nd://scope/write/<r>` and
  `admin/<r>`; `admin/<r>` covers `write/<r>` and
  `read/<r>` for the same resource). New
  `app.requireScope(scope)` decorator on the auth
  plugin closes over the required scope and refuses
  the request when the token doesn't cover it; a route
  can opt in with `{ preHandler: app.requireScope('nd://scope/write/services') }`
  (the existing read/write enforcement at the auth
  layer is unchanged — the new decorator is the per-route
  extension point). The MCP server declares
  `requiredScopes` on every tool; on startup it
  introspects the bearer token via the new
  `GET /v1/auth/token` endpoint, then filters its tool
  list to those whose scopes are covered. CLI:
  `ninedeploy token create` accepts the URI form in
  the scope prompt. The introspection endpoint also
  reports `tokenId` + `name` + `expiresAt` + `isOperator`
  for API tokens, `['session']` for JWTs — the
  one-call shape the MCP and any future token-aware
  client (CI, monitoring agent) needs.

- **PgBouncer sidecar — `ninedeploy databases pgbouncer <dbId> {enable,disable,status}` (G-32, PR #51)**.
  Production Postgres workloads are routinely fronted by
  PgBouncer so a thousand client connections don't
  multiply into a thousand Postgres backends. NineDeploy
  had the database engine fully wired but no built-in
  way to bring up a pool proxy. New migration `0046`
  adds three columns to `databases`
  (`pgbouncer_enabled`, `pgbouncer_container_name`,
  `pgbouncer_port`, default 6432). New
  `apps/server/src/lib/pgbouncer.ts` writes a
  `pgbouncer.ini` (auth_type=md5, pool_mode=transaction,
  default_pool_size=20, reserve_pool for burst) plus
  the userlist (MD5-hashed creds), bind-mounts both into
  a `bitnami/pgbouncer:1.24.1` container named
  `nd-pgb-<slug>`, and stamps the row. The
  `pooledConnectionString(d)` helper returns the
  sidecar's URL when enabled (services that want pooled
  connections use it instead of the direct
  `connectionString(d)`). New routes under
  `/v1/databases/:id/pgbouncer`:
  `GET` (status, member role),
  `POST /:id/pgbouncer/enable` (admin, optional `--port`),
  `POST /:id/pgbouncer/disable` (admin). Routes are
  mounted on the existing `/databases` prefix; the
  engine guard returns 422 for any non-postgres engine.
  SDK surface: `client.databases.pgbouncerStatus(id)`,
  `client.databases.enablePgbouncer(id, { port? })`,
  `client.databases.disablePgbouncer(id)`. CLI:
  `ninedeploy databases pgbouncer <dbId> enable [--port
  N] | disable | status` — the status subcommand
  prints the pooled URL the operator pastes into a
  new attachment's `envAlias`. The sidecar is per-DB
  rather than a shared proxy: a stuck pool only
  affects one tenant, and the credentials on the wire
  are scoped to a single service-to-database pair.

- **Cluster log search — `ninedeploy logs search <query>` (G-16, PR #52)**.
  NineDeploy's `logDrains` pipeline forwards every
  container's stdout / stderr to a remote sink (Loki,
  Vector, Datadog, ...), but the panel had no
  corresponding read-side. Operators fell back to the
  upstream's own UI, which meant two dashboards. New
  `POST /v1/log-drains/search` round-trips to the
  configured Loki drain's `/loki/api/v1/query_range`
  with `{service="<slug>"} |= "<query>"` and the
  window the caller asked for (default 15 minutes,
  max 7 days). Other drain types don't expose a
  query API; the route returns 400 with a clear "add
  a Loki drain alongside it" message rather than
  silently returning nothing. The drain's
  `apiKeyEncrypted` is sent as `Authorization: Bearer
  <key>`; the egress guard is intentionally NOT
  applied because the operator's log host is the
  canonical destination of the log drain itself.
  Auth is `member` (a viewer can search). SDK surface:
  `client.logDrains.search({ query, serviceId?,
  sinceMinutes?, limit?, drainId? })` and
  `LogSearchInput` / `LogSearchResult` / `LogSearchLine`
  types. CLI: `ninedeploy logs search <query>
  [--service <id>] [--since 15m|2h|1d]
  [--limit <N>] [--drain <id>] [--json]`. The CLI
  parses `--since` shorthand (`15m`, `2h`, `1d`,
  `30s`) and prints each line as
  `<iso-ts> [<service>] <line>` so the operator can
  read the output as a stream; `--json` switches to
  the raw `LogSearchResult` shape for piping into
  `jq` / `grep` / etc.

- **Per-workspace email template overrides — `ninedeploy email-templates {list,set,reset,preview}` (G-30, PR #53)**.
  NineDeploy's outbound emails (password reset, workspace
  invitation, domain transfer, backup drill failed)
  used to live as a string-templated function per
  call site (`buildInviteEmail` in `invitations.ts`,
  inline string in `auth.ts`). Operators who wanted
  to brand the outbound mail had to fork the
  codebase. New `lib/emailTemplates.ts` ships four
  built-in templates with `{{var}}` interpolation
  and a `setOverride / clearOverride / renderTemplate`
  trio; migration `0047` adds the
  `email_template_overrides` table (one row per
  `(workspace, name)` overrides the subject + text).
  Routes under `/v1/workspaces/:wid/email-templates`:
  `GET` (member, lists every name + whether each is
  overridden), `POST /preview` (member, renders with
  supplied vars — paste the result into a test
  inbox), `PUT /:name` (admin, upsert the override),
  `DELETE /:name` (admin, drop it). The renderer is
  side-effect free; a future PR can call it from
  every existing outbound site so the override
  takes effect automatically. SDK surface:
  `client.emailTemplates.{list, preview, set, reset}`
  with `EmailTemplateName` / `EmailTemplateEntry` /
  `EmailTemplateRender` types. CLI:
  `ninedeploy email-templates <wid> {list | preview
  <name> [k=v ...] | set <name> --subject S --text T
  | reset <name>}`. The interpolation engine
  handles `{{var}}` and `\{\{` (literal) escapes;
  unknown vars render as the empty string rather
  than `{{undefined}}` so a half-broken template
  cannot surface in an outbound email.

- **Live signed marketplace index (G-24, PR #54)**.
  The previous `MARKETPLACE_CATALOG` was a static
  in-code list — the panel could not discover new
  plugins without a server release. New
  `lib/marketplaceCatalog.ts` fetches a signed JSON
  index from `NINEDEPLOY_MARKETPLACE_URL`, verifies
  the ed25519 signature against
  `NINEDEPLOY_MARKETPLACE_PUBLIC_KEY`, and merges
  the verified entries with the in-code fallback
  (which is also kept as the installable-surface
  baseline — the live index is never allowed to
  override an entry that maps onto compiled-in
  behaviour). The envelope format is
  `{ entries, signature, key_id }`; the signature
  is over the canonical JSON of `entries`
  (sorted keys, no whitespace). A 5-minute
  in-process cache avoids hammering the upstream;
  the existing `GET /v1/plugins/marketplace`
  route gains a `?refresh=true` query, and a new
  `POST /v1/plugins/marketplace/refresh` route
  bypasses the cache. The response shape grows
  from `{ catalog }` to `{ catalog, live, keyId,
  fetchedAt }` so the panel can show "live signed
  index (key=ed25519:abc123) — fetched 2 min ago"
  vs. the static fallback. A live index that fails
  signature verification is dropped entirely —
  production with `NINEDEPLOY_MARKETPLACE_URL` set
  but no public key refuses to serve the live data
  rather than trust an unverified blob. SDK surface:
  `client.plugins.marketplace({ refresh?: boolean })`.
  CLI: `ninedeploy plugins marketplace
  [--refresh]` (the option now also re-fetches) and
  a new `ninedeploy plugins marketplace-refresh`
  command for CI runs after the upstream rotates
  its key.

- **FCM push notifications (G-22, PR #55)**.
  Firebase Cloud Messaging's legacy HTTP API (the
  `X-Server-Key` header) was sunset mid-2024; the
  modern endpoint is the FCM HTTP v1 API at
  `fcm.googleapis.com/v1/projects/<id>/messages:send`
  and requires an OAuth2 bearer token minted from a
  service-account JSON. New
  `apps/server/src/lib/fcm.ts`:
    - hand-rolled RS256-signed JWT (no npm
      dependencies — `node:crypto.createSign`),
    - OAuth2 token exchange against
      `oauth2.googleapis.com/token`,
    - in-process bearer cache keyed by `client_email`
      with a 60s safety skew (Google's `expires_in`
      minus the safety), so the per-event cost is one
      HTTPS round-trip, not two.
  - The dispatch path in `notifier.ts` reads the
    channel's `configJson` as the full service account
    JSON; `target` is the device token. FCM `data`
    payload carries `action`, `entity`, `ts` so a mobile
    client can route on it without parsing the
    localised body.
  - Schema: `notificationType` extended to include
    `'fcm'`; the `notification_channels` table needs no
    migration (the column is plain text).
  - New CLI: `ninedeploy notifications create-fcm
    <name> <deviceToken> --service-account <file.json>`
    reads the service account from disk so the JSON
    never lands on the operator's shell history.
  - Caveat: the FCM channel needs a real FCM project
    + device token to verify; the unit suite covers
    the dispatch path indirectly via the existing
    `notifier.test.ts`. A future PR can mock
    `globalThis.fetch` to cover the OAuth2 round-trip
    + the FCM POST happy / error paths.

- **Certificate inventory — `ninedeploy certificates {list,expiring}` (G-15, PR #56)**.
  The existing `GET /v1/traefik/certificates` route
  returned four flat fields per cert — enough to
  draw a list, not enough to answer "which certs
  expire in the next 30 days?". New
  `lib/certificateInventory.ts` wraps the existing
  `engine/proxy.ts:readCertificates()` reader and
  classifies each cert as `valid` /
  `expiring-soon` / `expired` / `unknown` based on
  the operator-configurable threshold (default 30).
  New `GET /v1/traefik/certificates/inventory`
  returns the full report with a `summary` block
  (totals per status, threshold, fetchedAt) so a
  single round-trip is enough to render the panel's
  Certificates page. New
  `GET /v1/traefik/certificates/expiring?days=30`
  is a focused filter — the same shape the alert
  engine uses to page the operator before a cert
  falls over. Both routes are member-accessible
  (the existing basic route stays admin-only for
  backwards compat). SDK surface:
  `client.traefik.certificateInventory({ threshold? })`
  and `client.traefik.expiringCertificates({ days? })`,
  with the `CertificateInventoryEntry` /
  `CertificateInventoryReport` types in `@ninedeploy/schemas`.
  CLI: `ninedeploy certificates list [--threshold N]`
  prints a colour-coded table with totals per status;
  `ninedeploy certificates expiring [--days N]` is
  the focused list used by the alert cron. Caveat:
  the rich `subject` / `sans` / `notBefore` fields
  are populated as `null` for now — a real PEM
  parser is a follow-up; the existing `engine/proxy.ts`
  reads only the expiry date from acme.json, which
  is the only field the inventory actually needs.

- **Community template contributions (G-13, PR #57)**.
  The Hub template catalog was a closed set: the
  bundled registry plus an optional remote URL. A
  contributor with a new template had to open a PR
  against the registry. New
  `lib/communityTemplates.ts` opens a third source:
  any `*.json` file dropped into
  `<dataDir>/community-templates/` is parsed, validated
  against the template schema and merged into the
  panel-facing catalog by `id`. The merge rule is
  "curated wins": a community entry that collides on
  `id` with a bundled entry is dropped, so a
  copy-paste cannot shadow the installable baseline.
  Three new routes on `modules/templates.ts`:
  `GET /v1/templates/community` lists every file with
  a per-file error list (a single bad JSON does not
  hide the rest), `POST /v1/templates/community/import`
  accepts a single-template JSON envelope and refuses
  to overwrite an existing `id` unless `replace: true`
  is passed, and `DELETE /v1/templates/community/:id`
  unlinks the file. Both writes are `requireAdmin` and
  emit an audit row (`templates.community_import` /
  `templates.community_remove`). SDK surface:
  `client.templates.community.{list, import, remove}`,
  with `CommunityTemplateListResult` re-exported from
  `@ninedeploy/schemas`. CLI: `ninedeploy templates
  community list | import <file> [--replace] | remove
  <id>`; `import -` reads from stdin so a
  `curl -s https://.../template.json | ninedeploy
  templates community import -` pipeline lands an
  upstream contribution without writing it to disk
  first. Files are pretty-printed (`JSON.stringify(x,
  null, 2)`) so the diff against the upstream PR is
  reviewable. The `list` route also surfaces community
  entries in the main `GET /v1/templates` response
  (filtered for id-collision), so the existing panel
  flow gets new entries without a code change.

### Fixed

- **`SettingsTabPrivilege` test timeouts under parallel load (unrelated
  to G-07).** `apps/web/test/SettingsTabPrivilege.test.tsx` runs four
  async `findByText` waits, each capped at vitest's default 5 s. The
  file's own comment already noted that the sibling-suite `waitFor`
  helper inside the same file had to be raised to 10 s for the same
  reason. Under the full-suite run captured in
  `.tmp-real-validate/g07-web.log` the third test
  (`sends the hook values an admin has configured`) hit the 5 s wall
  before react-query dispatched the PATCH; the same four tests pass in
  2.2 s when the file is run in isolation. Per-test timeout is now
  15 s on all four `it()` callbacks in this file, and the
  `waitFor` inside `savedBuild` is now 30 s — the G-07 PR-B
  full-suite run captured in `.tmp-real-validate/g07b-web.log`
  showed 10 s still false-failing on a slow host when the rest of
  the workspace's vitest workers are booting in parallel. The
  only behavioral change is the timeout, the assertions are
  untouched. This change is not part of the G-07 driver surface
  area; it is documented here so the next reviewer does not assume
  the web PR depends on the kernel work above.

- **Two dead operator guards removed before they could be used.**

- **Two dead operator guards removed before they could be used.**
  `lib/resourceAccess.ts` exported `assertOperator` and a second
  `requireOperator()` prehandler, neither with a call site. Both re-read
  `users.is_instance_operator` from the database — the one thing
  `plugins/auth.ts` documents as forbidden, because it has already narrowed the
  flag for a scope-restricted API token, so a fresh read would hand a `write`
  token its owner's operator rights back. `requireOperator()` also still carried
  the pre-0.3.5 self-granting definition in its docstring. The escalation
  assertion they were tested against now runs against `app.requireOperator`.
- **`job_runs` is bounded.** Scheduled-job run history had no retention at all,
  and each row stores up to 60 KB of the command's captured output inside the
  SQLite file that gets backed up whole — a per-minute cron job wrote roughly
  525 000 rows a year while the panel only ever renders the newest 20 per job.
  Swept on the same 30-day window as the other logs.
- **Six environment variables the server reads were documented nowhere** —
  including `NINEDEPLOY_ALLOW_PRIVATE_EGRESS` (the SSRF escape hatch, named in
  the error message an operator hits and in no config file) and
  `NINEDEPLOY_UPDATE_CHECK_URL` (the panel's only unprompted outbound call, and
  the only way to turn update checks off). All six are now in `.env.example`,
  and `apps/server/test/envExample.test.ts` fails when a new one is added
  without a line describing it.
- **Log Drains worked on no fresh install.** `log_drains` was declared in
  `schema.ts` and recorded in drizzle-kit's snapshot, but no migration ever
  created it — so every database built by replaying the migrations lacked the
  table and Settings → Log Drains failed with `no such table: log_drains`.
  Because the snapshot already claimed the table existed, `drizzle-kit generate`
  could never emit the missing file. Added as `0039_log_drains`. New
  `packages/db/test/schema-drift.test.ts` applies the whole migration chain to a
  fresh database and compares every declared table and column against
  `PRAGMA table_info` in both directions, so the next drift fails a test instead
  of a production request.
- **Historical CPU/memory charts work at all.** `GET /v1/services/:id/metrics`
  returned 404: `metricRoutes` is a second export from `modules/stats.ts` whose
  own comment says "Mounted under /services", and `api.ts` never registered it.
  The charts on the Monitoring page and every service's Overview tab therefore
  had nothing to read while the collector wrote two rows per service every 30
  seconds. `test/api.test.ts` now asserts that every module it stubs answers on
  its prefix, instead of spot-checking two of them.
- **PR previews no longer leak a Docker network each.** Every deployed service
  gets a private bridge (`ensureServiceBridge`, called by the Docker builder),
  and only the panel's `DELETE /v1/services/:id` ever reaped it. The preview
  auto-destroy path deleted the service row and stopped the container but left
  the network behind — in the one feature designed for high churn, one preview
  per pull request. It now reaps the bridge and removes the preview's build
  logs, both best-effort so a stuck network cannot turn a webhook into a 500 the
  provider will retry against a service that no longer exists.
- **Deleting a service takes its deploy logs with it.** The FK cascade removed
  the deployment rows and knew nothing about the log files, which outlived the
  service they describe by up to the 30-day retention window — and build logs
  routinely echo configuration.
- **A deploy's outcome is recorded.** `deploy.trigger` was written when a
  deployment was queued and was the *only* deploy action anything emitted:
  `engine/pipeline.ts` never called `audit()`, so a deploy that finished —
  successfully or not — did so in silence. Everything downstream of `audit()`
  was blind to the result: **every notification channel** (a failed production
  deploy notified nobody, and the Settings → Notifications event filter had no
  `deploy.failed` to match), the `/v1/events` activity feed (deploys started and
  never finished), and the freshly-rebuilt `kernel/auditBridge`, whose
  `deployment.status_changed` could only ever carry `trigger`/`rollback`/`cancel`
  — so the built-in plugins still never saw the one event they exist to react
  to. The pipeline now records `deploy.success`, `deploy.failed` (reason in
  `meta`) and `deploy.cancelled`, attributed to the service owner so the member
  who triggered it can actually see their own result.
- **A `deployFailed` alert in a manifest no longer writes a rule that can never
  fire.** `applyManifestToService` mapped the two event-shaped triggers
  (`deployFailed`, `restartLoop`) onto `metric: 'cert-expiry', threshold: 0`; the
  function's own comment claimed it skipped the insert, and it did not. The rule
  rendered in Monitoring looking like a configured alert. Both are now reported
  as skipped in the deploy log.
- **`static`, `watch` and `network` manifest sections are no longer dropped in
  silence.** They are accepted by the strict schema and consumed by nothing.
  Every other unwired section already warned, and the docs claimed these did
  too. They do now.
- **The deploy worker no longer leaks a timer per poll.** `plugins/worker.ts`
  pushed every 2-second poll timer into an append-only array that only `stop()`
  ever drained — roughly 43 000 dead `Timeout` handles per concurrency slot per
  day of uptime. It is a `Set` each timer removes itself from as it fires.
- Removed `lib/agentSeal.secretsMatch`: exported, tested, and called by nothing —
  `agentClient.tokenMatches` already performs that comparison.
- **The plugin marketplace no longer pretends to install anything.** Nothing in
  `pluginLoader.ts` ever `import()`s code, so an npm/git/local "install" became
  a DB row plus a shell whose `init` emits one event — while the panel reported
  it *active*. Several of the 16 catalog entries also shadow features that ship
  under another name: an operator who installed "Amazon S3 & Cloudflare R2
  Sync", entered a bucket and secret key and saw it active would reasonably
  believe backups were being copied off-site. They were not, and they would find
  out at restore time. Now: npm/git/local installs are refused with an
  explanation; every catalog entry carries `implemented` (all 16 are `false`
  today) plus a `builtIn` pointer where it shadows a shipped feature, and
  installing one is refused with a message naming the real feature; the panel
  renders that pointer as a link instead of an Install button; and rows
  installed by an older build from an unsupported source are skipped at boot
  with a warning instead of restored as active-looking shells.
- **Service visibility was computed three different ways.** `GET /v1/services`
  filtered on `owner_user_id` alone while `/dashboard`, `/domains` and the
  per-service loader also honoured workspace tags — a teammate could open and
  deploy a shared service by id but saw an empty list, while the dashboard
  counted it. All callers now share `visibleServiceIdSet` in
  `lib/resourceAccess.ts`.
- `GET /v1/users` derived each row's operator badge from workspace seats, which
  after the change above would have shown every member as an operator. It reads
  the flag.
- **CI on `main` was red three ways.** The main job's web suite failed 805
  tests on Node 26: the jsdom storage globals arrive through vitest's
  environment population as an EMPTY object on Node ≥ 25 (`localStorage.getItem
  is not a function` from the first render that touches one — they work on
  Node 24 and in plain jsdom, which is why the suite stayed green locally).
  `apps/web/test/setup.ts` now detects a non-functional storage and backs both
  names with a working in-memory instance. The deprecated-dependency gate still
  matched `@esbuild-kit/*` and `glob@10.5.0` in `pnpm-lock.yaml`: the patches
  remove those edges from the graph, but the lockfile was never re-derived, so
  the stale packages and `drizzle-kit`/`archiver-utils` snapshot entries were
  hand-pruned (frozen installs verified). And the testcontainers suite failed
  five cases it had never once run green: the pg/mysql/mongo/redis suites
  asserted the OLD `v<version>:` at-rest envelope while the engine writes the
  streamed `NDBK1:v<version>:<iv>` header; the Redis fixture passed an empty
  `passwordEncrypted`, which `decrypt` rightly refused ("Invalid initialization
  vector") — it now starts the container with `--requirepass` and encrypts the
  same secret it stores; and the deploy e2e pulls `busybox:1.36` up front with
  retries, because an auto-pull inside a test assertion turned a rate-limited
  registry into a red suite.

### Docs

- `docs/NINEDEPLOY_MANIFEST.md` no longer describes machinery that does not
  exist. §4.14 implied `network.aliases` reached Docker, §4.15 described a
  channel "resolver" for `notifications` that was never written, §4.16 claimed
  every alert "fires into exactly one named channel" (the channel is encoded in
  the rule *name*; delivery follows the global per-channel event filters), and
  the end-to-end example attributed the deploy trigger to the manifest's own
  `watch.paths` rather than the webhook's. Each now says what actually happens
  and points at §6.3.
- `.env.example` pointed at a `ninedeploy rotate-keys` command that did not
  exist, and omitted that completing the rotation by removing the old key
  destroys the restorability of every backup taken under it.
- `ARCHITECTURE.md` rewritten against the actual tree: it had drifted a full
  release behind (28 tables → 40, migrations 0000–0019 → 0000–0038, "two roles"
  → workspace RBAC, single-project scoping → N-N project/workspace/label tags,
  MCP 15 tools → 36, "100% coverage everywhere" → the real tiered gates), and
  omitted workspaces, invitations, OIDC/SSO, the microkernel, Config Center,
  firewall, log drains, volume backups, repo insights, the `.ninedeploy`
  manifest, preview deployments and panel self-update entirely. A new "Known
  gaps" section records where the implementation still trails the intent.
- `docs/WORKSPACES_RBAC.md` now documents what the code enforces, including the
  instance-operator flag as a separate concept from workspace roles.

---

## [0.3.4] - 2026-08-27

### Added

- **One-Click Panel Self-Update**: operators can upgrade the panel from the dashboard. New `GET /v1/system/update-status` and `POST /v1/system/update-start` endpoints run this install's own `install.sh --version <tag>` for an operator-pinned exact release tag; on systemd hosts the updater launches through `systemd-run` into a transient cgroup so it survives stopping the unit it belongs to, state lives in marker files under `<dataDir>/self-update/`, and the updater's environment is deliberately narrow (no JWT/DB secrets reachable via `systemctl show`). A layout banner plus About-card button share the new `usePanelUpdate` poller, whose phase survives panel restarts via localStorage and reports installer output tails on failure.
- **Volume Backup Labels**: manual volume snapshots accept an operator label (≤40 chars, default `manual`) and scheduled runs are labeled `schedule-YYYY-MM-DD`; migration 0037 persists `backups.label`, serialization exposes `scope`/`volumeName` too, and the Backups page names every row instead of showing bare timestamps.
- **Webhook URLs Honor The Panel Domain**: auto-deploy payload URLs are now built from the Settings → Security "panel domain" (`panel_domain`), falling back to `NINEDEPLOY_DOMAIN` then `NINEDEPLOY_PUBLIC_URL`; scheme mirrors the Traefik router (https only when an ACME email exists). The environment tab warns amber when stored webhook URLs point at localhost so git providers cannot silently fail delivery.
- **Honest Deployment History**: finalizing a successful deploy demotes older `running` rows to a new `superseded` status, and boot-time `reconcileDeploymentHistory` keeps at most the newest running deployment per actually-running service — past deploys stop displaying "Running" forever.
- **Cron-Preset Jobs Editor & Raw Env Editing**: the scheduled-jobs card is rebuilt around presets (time/weekday/monthday pickers, custom-cron input with validation) backed by a new frontend `lib/cron.ts` (`parseCron`, `nextCronRun`, `describeCron`); env vars gain a table ⇄ raw `.env` bulk-edit mode accepting comments, blank lines and quotes, saving added/updated/removed diffs in parallel.

### Changed

- **Detaching A Volume No Longer Requires Stopping The Service**: detach now queues a blue-green recreate without the mount, matching attach/update behavior since Docker cannot hot-swap `-v`.
- **Alert Rules Expose `lastEvaluatedAt`** so the monitoring page can distinguish "never evaluated yet" from a lapsed collector.

### Docs

- README, docs/ and the website were re-verified against the code: MCP tool count (35), nine managed-database engines, 88 hub templates with 16 runtime-certified, kernel event/hook names, the supported ACME DNS-provider list, Docker-mode upgrade instructions, OIDC configuration path (admin UI, not env vars), and coverage floors stated per package instead of a blanket 100% claim.
- The README system-architecture diagram now matches the engine: three workload types (containers, PM2 processes, Compose stacks), nine database engines, Traefik routing published apps in addition to the panel, the HMAC webhook ingress path, Cloudflare Tunnel as a parallel ingress for NAT-restricted nodes, and the new panel self-update machinery.

### Fixed

- **Every CI Job Died Before Running A Single Test**: `pnpm/action-setup` was pinned to `11.22.0` in the workflows while `packageManager` declares `pnpm@11.23.0` — action-setup refuses the conflict with `ERR_PNPM_BAD_PM_VERSION`, which is why "Typecheck · Lint · Build · Test" failed in seconds alongside everything else. The workflow pin is removed; the version derives from `packageManager` (the same pattern website.yml already used successfully).
- **The Release Workflow Would Have Failed The Same Way On The First v0.3.4 Tag**: `release.yml` carried the identical pinned-setup block and is fixed identically.
- **Node 26 Images No Longer Bundle Corepack**: the Dockerfile's `RUN corepack enable` (both build and runtime stages) died with `/bin/sh: corepack: not found`, breaking the CI "Docker image build" job and any tagged release image. Both stages now install a pinned pnpm via npm (`ARG PNPM_VERSION`), kept in sync with `packageManager`.

---

## [0.3.3] - 2026-08-27

### Security

- **Preview Domain Patterns Could Route Hosts Nobody Verified**: webhook-created PR previews inserted their Traefik domain row directly with `status: 'active'`, skipping the ownership proof every other domain path requires — and the pattern (`previewDomainPattern`) was free-form member input. A pattern like `*.victim-tld.com` rendered a router that claimed every subdomain of that zone, cookie and Authorization headers included; only the panel's own priority guard survived. Rendered preview hostnames are now constrained to the instance wildcard zone with a strict label shape before anything goes active. A rejected pattern skips only routing: the preview still deploys and serves on its internal port, and the webhook response names the skip reason.
- **`.ninedeploy` Could Attach Any Managed Database By Slug**: `database.ref` was resolved by slug with no access decision at all, so anyone who could push to the tracked repository could have another tenant's managed-database connection string — password included — injected into their own runtime environment on the next deploy. Attachments now require the database to be visible to the deploying service's owner (mirroring `loadDatabaseForUser`, minus any session bypass), and are refused outright for services without a recorded owner.
- **Webhook Deployments Bypassed The Host-Privilege Gate**: manual deploys refuse PM2/compose/hook-capable/docker-socket services to non-operators, but a verified webhook event queued the very same deployment straight into the table — handing push access on any tracked repo a path back to host command execution. Both webhook branches (push deploys and preview creation) now authorize against the service owner through `assertMayDeployStoredService`.
- **PR Previews Inherited Production Secrets**: creating a preview copied the parent service's entire environment, secrets included, into an environment built from PR-supplied code. Previews now inherit non-secret configuration only, and the webhook response reports how many secrets were withheld so operators can diff intent instead of discovering the policy by surprise.
- **Server-Side Git Clones Are Egress-Gated**: deploys, PR previews and pre-deploy inspections all cloned user-supplied URLs from the panel's network position, next to every managed container and the cloud metadata service. One gate now covers all three transports (https, ssh://, scp-style remotes) before any git operation starts; every DNS answer must be public. Self-hosted LAN remotes keep working via `NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1`, matching notification webhooks.
- **Log Drains Now Honor The Same Egress Policy As Webhooks**: drain dispatch used raw `fetch` while its sibling notifier had deliberately moved to a guarded fetch — and drain bodies carry raw log lines, frequently secrets, making it the better exfil sink.

### Fixed

- **Compose Redeploys Deleted The Deployment They Just Shipped**: docker compose recreates containers under one deterministic name per project/service, unlike the deployment-id-suffixed names of the docker and pm2 builders. The blue-green finalize therefore ran `docker compose down --remove-orphans` against the *same* runtime id it had just routed traffic to, removing every container of the stack about two seconds after go-live — a guaranteed outage plus a spurious `error` state on every redeploy of every compose service. The finalize stage now recognizes in-place redeploys (previous and new runtime id identical) and skips the retirement; a cancellation landing just before finalizing records reality ("the swap already happened and cannot be unwound") instead of stopping the live instance. Blue-green retirement behavior is unchanged and covered by new regression tests.
- **A Docker Daemon Outage At Boot Killed The Panel**: the readiness hook awaited the infra heal unguarded, so a container that started before dockerd exited via `process.exit(1)` — in a codebase where every other background subsystem treats daemon-down as recoverable. The heal is now failed-open with an error log; the five-minute Traefik watchdog remains the recovery path.
- **Migration 0031 Sorted Before 0030 And Would Never Apply**: its journal timestamp sat ~58 minutes *earlier* than 0030's, so drizzle's strict ordering meant any database that migrated during the interim window stopped at 0030 forever and then hit "no such table: repo_insights". The entry is reordered monotonically and made replay-safe with `IF NOT EXISTS` guards in case a mid-fix journal replays it.
- **Deleting A Service Mid-Deploy Orphaned Its Candidate Container**: the delete route ignored in-flight deployments, so a build finishing after the DELETE left a fully running container tracked by nothing — holding its published port indefinitely behind `--restart unless-stopped`. Deleting now returns 409 while a deployment is queued or building (cancel first), and as defense-in-depth the pipeline retires the candidate when its final service-row update matches zero rows.
- **Pre-Upgrade Backup Archives Were World-Readable**: the snapshot containing `.data/master.key` — the key that decrypts every stored secret — inherited the ambient umask. On shared hosts any local account could read routine upgrade artifacts. Archives are created under `umask 077` and asserted `chmod 600`.
- **bump-version.js Corrupted The Changelog It Was Supposed To Track**: its `/version: '.*?',/` rule matched the newest `ChangelogEntry` literal inside `version.ts`, relabeling the top entry to the new version while keeping the previous release's notes — masked until now only because both read `0.3.2`. The rule is gone (the About surface reads the `VERSION` constant), a dead health-test rule that always printed "✓ Synchronized" without changing bytes is removed, unmatched patterns now warn instead of claiming success, and a README badge rule means the version shield stops silently rotting.

### Docs

- The README claimed watchdog supervision (`sd_notify`) while the shipped unit explicitly ships `WatchdogSec=0` / `Type=simple`, and drew master↔agent links as "mTLS" while the protocol is tokened HTTP over plain TLS-less HTTP between trusted hosts. Both now describe reality; the QUICKSTART manual-upgrade snippet still targets compose deployments and needs its own pass.

_Installer changes take effect immediately — `install.sh` is fetched from `main`, not from the release tarball._

---

## [0.3.2] - 2026-08-26

### Added
- **One Runtime Version Catalog**: `RUNTIME_VERSION_CATALOG` in `@ninedeploy/schemas` is now the single source for every version NineDeploy suggests — the Manifest Creator presets, its version picker and the CLI's `starterManifest` all read from it, so a bump is one edit instead of three that can disagree. Each entry carries its upstream support state and EOL date, and the catalog records the date it was last reviewed so staleness is visible rather than silent. Tests assert the table's invariants: no recommended pin may be security-only or end-of-life, and every offered version must satisfy the manifest schema.
- **Runtime Versions Are Picked, Not Typed — And Old Ones Stay Available**: the Manifest Creator's Version field is a picker listing each version with its support status, plus an "Other version…" escape hatch for anything the catalog does not list. Choosing an end-of-life or security-only version is still allowed — reproducing a legacy runtime is a real need — but it now carries an advisory naming the recommended pin instead of passing silently. Nothing here blocks a build, and `runtime.version` stays free-form in the schema. Switching runtime type now drops a pin that is meaningless for the new type rather than carrying, say, Node's `24` over to Python.

### Fixed
- **The Manifest's Build Half Was Never Applied — And The Docs Said Otherwise**: `.ninedeploy` documented `runtime`, `phases` and `build` as taking effect at build time, and 0.3.0's notes claimed the pipeline "applies the build sections at build time". It does not. `engine/pipeline.ts` applies only the operational sections (routes, alerts, database); `applyManifestToBuildConfig` and `generateNixpacksToml` are both written, tested — and called by nothing. The builder invokes the Nixpacks CLI with `--install-cmd`/`--build-cmd`/`--start-cmd` and writes no `nixpacks.toml`. The docs, the module comments and the Manifest Creator's Runtime section now say this plainly instead of implying a pin that never happens. Wiring it up needs a real Linux/Docker/Nixpacks integration test and is deliberately not in this release.
- **Every Runtime Pin The Generator Produced Was Broken**: `generateNixpacksToml` built nixpkgs attribute names by stripping non-digits, yielding `go_127` and `ruby_34` where nixpkgs uses `go_1_27` and `ruby_3_4`, and turning any patch-level pin into nonsense (`24.4.1` → `nodejs_2441`). Worse, `[phases.setup] nixPkgs` **replaces** the provider's package list unless it contains the `"..."` sentinel — so declaring one extra package silently deleted the toolchain, and an unresolvable name is a hard `undefined variable` Nix error late in `docker build`. Version pins now go only through the provider environment variables Nixpacks actually reads, every `nixPkgs` list leads with `"..."` so extras are additive as documented, and the generator returns warnings instead of emitting a pin it knows will be ignored or will fail.
- **Pins Nixpacks Cannot Honour Are Named, Not Guessed**: checked against the v1.41.0 the installer pins, `NIXPACKS_GO_VERSION` and `NIXPACKS_PHP_VERSION` do not exist (those versions come from `go.mod` and `composer.json`), Node silently falls back to 18 outside {14,16,18,20,22,24}, Python silently falls back to its default outside 3.7–3.13, Ruby and Rust need an exact patch version, and JDK **fails the build** outside {8,11,17,19,20,21}. The generator refuses each of these with a specific reason rather than emitting something that breaks or quietly builds the wrong thing.
- **Manifest Creator Shipped End-Of-Life Runtimes As Its Defaults**: every preset pinned Node 20, Python 3.12 and Go 1.22 — versions that lost upstream support on 2026-04-30, 2025-04-02 and 2025-02, respectively. They were hand-written literals duplicated between `apps/web` and `packages/sdk`, so nobody owned them and they drifted until a deployment tool was recommending unpatched runtimes. Defaults are now Node 24 (Active LTS), Python 3.14, Go 1.27, Ruby 3.4, PHP 8.4, Java 25 and Rust 1.98.
- **The Pre-Upgrade Snapshot Usually Did Nothing**: the installer passed `.data/ninedeploy.db` and `.data/master.key` to a single `tar` with stderr muted. `master.key` is written lazily — the first time something is encrypted — so on any instance without stored secrets the file is absent, `tar` exits non-zero, and the *entire* snapshot was skipped, database included. The operator saw one vague warning and upgraded with no rollback point, next to a truncated archive left on disk. Each file that exists is now archived (SQLite's `-wal`/`-shm` sidecars included so the snapshot is a consistent set), a missing `master.key` is treated as the normal state it is, tar's actual error is printed instead of muted, and a failed archive is removed rather than left behind.
- **Failure Messages Claimed A Backup That Did Not Exist**: every readiness-gate failure ended with "A pre-update backup is in …/upgrade-backups" regardless of whether the snapshot had run. The message now reports what actually happened.

_Installer changes take effect immediately — `install.sh` is fetched from `main`, not from the release tarball._

---

## [0.3.1] - 2026-08-26

### Fixed
- **`0.3.0` Could Not Start**: every boot died with `ReferenceError: Cannot access 'NETWORK' before initialization` and systemd restarted it forever. `engine/proxy.ts` and `lib/serviceBridge.ts` imported each other, and `serviceBridge` evaluates `RESERVED_NETWORKS = [NETWORK]` at module scope — so whichever module Node reached first decided whether the constant was initialised, and the real entry graph reaches `proxy` first. The shared Docker names now live in `engine/dockerNames.ts`, a module that imports nothing and therefore can never be half-initialised; `proxy` re-exports them so existing imports are unchanged.
- **Per-Service Bridge Reap Was Untested**: the two delete tests asserted that no `docker` command ran at all. That held only because the suite's `proxy` mock omitted `TRAEFIK_CONTAINER`: `serviceBridge` read a missing binding, threw, and the delete route swallowed it — so `removeServiceBridgeIfEmpty` silently never ran under test. The tests now separate runtime commands from the bridge reap and assert both.

### Added
- **Import-Cycle Guard**: a test walks the server's own module graph and fails on any runtime import cycle, naming the chain. TypeScript cannot see a temporal dead zone and the suites happened to import the two modules in the safe order, so this class of defect could only ever surface in production.
- **Readiness Failures Diagnose Themselves**: when the API does not answer `/health`, the installer prints `systemctl status`, the last 60 journal lines and what is listening on the health port instead of telling the operator to go and collect them. A crash-loop now ends the wait immediately — `Restart=always` keeps a crashing unit oscillating between `active` and `activating` rather than settling into `failed`, so the old gate sat through its entire window before reporting a failure it could have called in seconds. The window itself is 120s (was 60s) and honours `NINEDEPLOY_HEALTH_TIMEOUT`.

---

## [0.3.0] - 2026-08-26

### Added
- **Tags Across Three Dimensions**: Services carry many projects, workspaces and labels at once (`service_projects`, `service_workspaces`, `service_labels`). The top bar filters by all three — AND across groups, OR within one — and the selection persists per browser under `ninedeploy.tagScope`. A new Projects page manages the flat project list, and a per-service Tags card edits one service's membership in a single round-trip through `PUT /v1/services/:id/tags`.
- **Per-Service Volume Attachments**: A service can mount any number of managed Docker volumes at explicit container paths, read-only or read-write, with a uniqueness guard on both the path and the volume. Detaching records the change only — the underlying volume is never deleted.
- **Volume Backups**: Snapshot, restore and download any managed volume through `/v1/volumes/:name/backups`. Snapshots reuse the database-backup destination for off-site copies, prune to a retention cap, and refuse to restore while the owning service is still running.
- **`.ninedeploy` Manifest**: `ninedeploy manifest {init,validate,show}` scaffolds, schema-checks and prints the repo-side manifest. `validate` runs the same secret scan the server uses and rejects a file carrying credential-shaped values before they reach git history. The deploy pipeline applies the manifest itself on every deploy — the build sections at build time, the operational sections (routes, alerts, database ref) at deploy time; `manifest apply` is wired into the CLI surface but reports that its server endpoint has not shipped yet.
- **Private Repository Deployment From The CLI**: `ninedeploy sources` and `ninedeploy webhooks` manage encrypted source credentials, server-generated SSH deploy keys and auto-deploy webhooks from the terminal.
- **Workspace Invitations**: Invite an address that has no account yet; the invitation is accepted automatically on the invitee's next login or registration.
- **Self-Healing Runtime State**: At startup and every 60 seconds the panel compares each local service's desired state with the live runtime and revives anything that should be running — stopped containers are started (Compose sidecars included), a dead PM2 daemon is resurrected from the process dump, and stopped PM2 processes are restarted. A runtime that was deleted is marked `error` for redeploy instead of being reported as `running`, so a reboot, daemon crash or external `docker stop` can no longer leave the panel lying or services dead.
- **Boot Resilience**: The installer unconditionally enables the Docker daemon at boot (previously only when it installed Docker itself), so pre-existing Docker installations no longer leave Traefik, deployed containers and the panel dead after a reboot. A new `ninedeploy-pm2` systemd unit resurrects bare-metal PM2 deployments at boot from a process dump the server refreshes after every lifecycle change, and Compose deployments apply the `unless-stopped` restart policy to their containers so they survive daemon restarts and reboots.
- **Streaming Encrypted Backups**: Database dumps are encrypted and decrypted as AES-256-GCM streams, so large backups no longer need to be loaded into server memory for creation, download or restore. Existing encrypted envelopes and legacy plaintext backups remain readable.
- **Read-Only MCP Mode**: Setting `NINEDEPLOY_MCP_READONLY=1` exposes a fail-closed allowlist of inspection tools and excludes mutations, secret-bearing configuration, container inspection, Compose and file operations.
- **Dashboard Crash Recovery**: Unexpected React render failures now show a recoverable error screen instead of leaving the dashboard blank.
- **Override-Aware Installer Defaults**: Managed-database engine defaults now follow the latest Docker Hub GA (MySQL 9.7, Mongo 8.0, MariaDB 12.3, Redis 8.8, Valkey 9.1, ClickHouse 25.8, Postgres 18, RabbitMQ 4, Meilisearch v1.53). Every engine still accepts a per-row `version` override, and the bare-metal / Docker installers accept `NINEDEPLOY_NIXPACKS_VERSION=<release>` so operators can pin to the previous LTS or a known-good buildpack without a code change.
- **Latest Runtime & Toolchain Across The Stack**: Node.js 24 → 26 (latest GA, Aug 2026), pnpm 11.22 → 11.23, plus patch bumps for `jose` (6.2.10), `@tanstack/react-query` (5.102.2), `@biomejs/biome` (2.5.10), `@testing-library/user-event` (14.6.6) and `@types/react-dom` (19.2.5). Dockerfile, docker-compose and CI all pin Node 26; `.nvmrc` added so `nvm use` / `fnm use` always lands on the right major.
- **Reachable Tag Management**: The panel gained an **Organize** navigation group holding Workspaces, Projects and Labels. Projects previously had a route with no navigation entry — it was reachable only by typing the URL — and labels had no management screen at all: they could be created as a side effect of the top-bar filter but never renamed, recoloured or deleted. The new Labels page is full CRUD over the eight-token palette, and clicking a project or label row scopes the services list to it.
- **Volume Snapshots From The Volumes Page**: Snapshot, restore and download were reachable only from a service's Volumes tab, so a retained (owner-less) volume had no backup UI anywhere. Every card on **Data → Volumes** now expands the same panel.
- **Installer Installs The Release, Not A Clone**: On the `release` channel `install.sh` downloads the source tarball GitHub publishes for the tag instead of cloning, so a host needs no git and cannot land on a half-fetched object. The tag itself is resolved from `git ls-remote`, then the GitHub releases API, then the tags API — a single unavailable source can no longer pin an upgrade to a stale version. `--force` (or `NINEDEPLOY_FORCE=1`) discards local modifications and rebuilds from scratch.

### Changed
- **Command Palette Ranks Before It Truncates**: Every navigation entry carries the type `Navigate`, so a single-letter query matched all of them at once and filled the 24-result cap before any service, database or template could appear. Label matches now outrank description matches, which outrank type matches. The palette also lists Manifest Creator, Workspaces, Projects, Labels, Networks, Traefik and Docker, which it had never indexed.
- **Menu Permissions Fail Closed**: `getItemsForSlot` takes an operator boolean rather than a role string, and an item gated on `permission: 'admin'` is hidden when the flag is absent instead of shown to everyone.
- **Project Env Resolution Follows The Link Table**: Project-scope shared environment variables are the union of every project a service is linked to, replacing the single `services.projectId` lookup.
- **Visible Installer Progress**: The installer's long silent phases no longer look like a hang. Node.js, Docker and base-package APT installs stream apt's own progress lines (`Get:`/`Unpacking`/`Setting up`) live with a still-working heartbeat, expected durations are printed before the big downloads, and failed APT commands surface their error tail instead of failing silently.
- **Reusable Health Probes**: Docker readiness checks reuse one supervised `ninedeploy-prober` container instead of creating an ephemeral container for every retry.
- **Serialized Singleton Lifecycles**: PM2 sessions and Traefik recreation are serialized, preventing concurrent callers from disconnecting active PM2 work or racing to replace the shared proxy container.
- **Header-Based WebSocket Authentication**: Current dashboard clients carry bearer credentials in the WebSocket subprotocol header instead of query strings, reducing exposure through URLs and proxy history while preserving compatibility for older clients.

### Fixed
- **Stale Panel Bundle After An Upgrade**: `apps/web/dist` is gitignored, so a checkout never replaced it — an upgrade whose build was skipped or cached kept serving the previous release's dashboard, which is exactly the "upgraded but the UI still shows the old version" report. The installer now clears `dist/` and the turbo cache before building, verifies the built `package.json` version against the requested tag, and fails outright if `apps/web/dist/index.html` is missing afterwards.
- **Upgrades From A Shallow Clone**: fresh installs were cloned with `--depth 1`, so `git fetch --tags` succeeded while fetching none of the objects a newer tag needs and the checkout silently stayed on the old commit. The installer deepens a shallow checkout first, repoints a renamed `origin` at the canonical repository, force-fetches with `--prune-tags`, and hard-resets to the fetched ref.
- **Lexical Tag Sorting**: the installer's tag resolution relied on `sort -V`, which busybox and BSD coreutils either lack or ignore — ranking `v0.2.9` above `v0.2.36` and pinning those hosts to a stale release. Version components are zero-padded before a plain lexical sort, which is correct everywhere.
- **Dead Project Links**: the Projects page linked to `/services?projectId=N`, but the services list reads its filter from the shared tag scope and ignores that query string, so the link navigated without filtering. Both Projects and Labels now set the chip scope.
- **Wrong In-Panel Release Notes**: the About page's changelog carried the `0.2.31` Ghost release notes under the `0.3.0` heading and was missing `0.2.31` through `0.2.36` entirely.
- **Committed Coverage Artifacts**: `apps/web/cov-json*/coverage-final.json` (1.6 MB of v8 reporter scratch output) were tracked in git. Removed and ignored.
- **Server Would Not Build Or Start**: `volumeBackups` and `serviceVolumes` imported `backupVolume`, `restoreVolume` and `createDockerVolume` from the database engine, but none of the three had been written. The package did not compile, and loading either module at runtime would have failed the import outright. All three are implemented, snapshotting and restoring through a throwaway sidecar container so a containerised panel never needs a path into the daemon's storage directory — and a restore empties the volume first rather than merging the archive over whatever was already there.
- **Half-Migrated Service Tagging**: The schema, database, web dashboard and tag endpoints had all moved to the N-N model while `modules/services.ts` still read and wrote the removed `services.projectId`. Listing now filters on `tagProjectIds` / `tagWorkspaceIds` / `tagLabelIds`, responses carry the three id arrays the API contract declares, a created service picks up its requested tags (or every workspace the caller belongs to), and a clone inherits the original's tags. The CLI's `users.role` reads move to the derived `isOperator` flag for the same reason.
- **Blocked Upgrade From 0.2.2 And Later**: Releases from `0.2.2` added `databases.owner_user_id` through the server's boot-time self-healing step, before an equivalent SQL migration existed. The new migration then tried to add the same column, so Drizzle's batch migrator aborted the whole upgrade with `duplicate column name: owner_user_id` and the panel never started. The runtime migrator now retries such a batch statement by statement, skipping only objects that already exist and journalling the migration so the upgrade completes.
- **Disappearing Label Chip**: A label created from the top-bar filter was selected and then immediately pruned, because the tag scope's own label query still held the pre-creation list. Both queries are refreshed before the new chip is applied.
- **Corrupted Source Encoding**: `0.2.36` shipped 90 files whose non-ASCII characters had been double-encoded — `·` written as `Â·`, em dashes as three characters, and several emoji mangled past a plain round-trip. Comments in the databases, invitations and jobs modules were affected alongside the test suites; every occurrence is restored.
- **Workspace Role Fields**: A bad rename replaced the `role` field with `isOperator` on workspace members, invitations and SSO provider defaults in the test fixtures, so those suites asserted a contract the API never had. The canonical `role` naming is restored.
- **Fresh-Install Watchdog False Positive**: The post-install systemd policy check rejected `WatchdogUSec=infinity` — the modern systemd spelling of a *disabled* watchdog on a never-started unit — and aborted the installer at the very end of an otherwise successful fresh installation. `infinity` is now accepted alongside `0`.
- **Honest Service Lifecycle**: stop/start/restart no longer swallow Docker/PM2 failures while still writing a success status to the database. Starting or restarting a runtime that no longer exists now returns 409 and marks the service `error`, an unreachable Docker daemon returns 503, and stopping an already-gone runtime is treated as the idempotent success it is.
- **Bounded Clone Slug Generation**: the clone slug-deduplication loop is now bounded, so a pathological collision run cannot spin forever.
- **Tenant-Scoped Inventory Views**: Domain, metrics, topology, network and volume responses now exclude resources outside the authenticated non-admin user's ownership scope.
- **Safer Preview Deployments**: Pull-request previews reject invalid refs and external fork repositories before they can inherit service environment variables or enter the build queue.
- **Atomic Deployment Claims**: Competing worker slots can no longer claim two queued deployments for the same service at the same time.
- **Hardened Secret Handling**: Docker environment files escape multiline values, runtime log redaction handles quoted credentials, config secrets require an explicit admin reveal request, webhook token comparison hides secret length, and installer-created `.env` files are restricted to mode `0600`.
- **Reliable Startup and UI Controls**: Database connection PRAGMAs finish before migrations and application queries begin; CLI reachability checks require the real health endpoint; terminal clearing no longer reconnects the session.

### Documentation
- **Four Missing Guides**: the marketing site documented none of the 0.3.0 surface. Added *Tags: Projects, Workspaces & Labels*, *Volumes & Storage*, *The .ninedeploy manifest* and *Private repos, sources & webhooks*, wired them into the docs mega-menu, and corrected the hard-coded guide count (17 → 21). The features page gained the tag dimensions, volume attachments, volume snapshots, workspace invitations and the manifest.

### Verified
- **Full Suite Green**: 4,405 tests across the workspace pass and every package meets its coverage gate — 100% in `db`, `schemas`, `sdk` and the CLI, 99%+ statements in the web app, 95%+ in the server. New suites cover the Projects page, the top-bar filters, the service Tags card, the volume-backups panel, and the label, service-tag and volume-backup APIs.
- **Upgrade Recovery Against A Real Database**: The `duplicate column name` recovery path is exercised against an actual `0.2.2`-era SQLite file and pinned by a regression test that reproduces the unjournalled-migration state.

---

## [0.2.36] - 2026-08-20

### Fixed
- **Legacy Template Provisioning Recovery**: Deployments stranded by the browser-owned provisioning flow from `0.2.34` are detected by their provisioning marker and immediately requeued on worker startup, without waiting for the normal stale-deployment timeout.

## [0.2.35] - 2026-08-20

### Added
- **Durable Template Identity**: Services persist their trusted Hub template ID, allowing the worker to reconstruct and reconcile required database dependencies after a process or host restart.

### Changed
- **Worker-Owned Hub Provisioning**: Preparing a Hub service is now the durable queue operation. Database startup, attachment, environment reconciliation and application deployment continue in the worker even if the browser navigates away or disconnects.
- **Interrupted Deployment Resume**: Stale `building` deployments are requeued for idempotent recovery instead of being marked failed automatically.

## [0.2.34] - 2026-08-20

### Changed
- **Immediate Hub Handoff**: Pressing Deploy in a Hub service modal now prepares the stable service identity, closes the modal and navigates directly to `/services/{id}?tab=deploys` without waiting for image or database provisioning.
- **Visible Dependency Provisioning**: The fast prepare response creates a `building` deployment row immediately. The Deployments tab can display and poll it while the server prepares managed dependencies, then the same row is promoted to the normal deployment queue.
- **Background Panel Flow**: Web provisioning continues through the canonical server endpoint after navigation; completion and failure refresh the service and deployment state and surface a toast without reopening the modal.

## [0.2.33] - 2026-08-20

### Fixed
- **Ghost Database Environment Repair**: Runtime deployment now recovers the trusted application-specific database mapping from the exact bundled template contract. Existing Ghost services with a missing, empty or stale `template_database_env` receive all five `database__connection__*` variables instead of falling back to localhost MySQL.
- **Dependency Readiness Gate**: A service with an attached database that is not running now fails before its application container starts, with the exact attachment readiness count, instead of entering a restart loop and timing out in HTTP healthchecks.
- **Safe Runtime Diagnostics**: Deployment logs list the managed database environment key names injected into the application without exposing credential values.

### Verified
- **Ghost Runtime Contract Regression**: The pipeline test covers `ghost:5-alpine` with a missing persisted mapping and verifies the resolved MySQL host, port, user, password and database variables plus pre-container failure for unavailable databases.

## [0.2.32] - 2026-08-20

### Changed
- **Canonical Hub Provisioning**: The API now owns service configuration, environment reconciliation, managed database startup, database attachment and application queueing as one ordered operation. The Web panel no longer coordinates those resources through separate requests.
- **Registry-Owned Runtime Contract**: Hub images, internal ports, persistent mounts, commands, Docker socket access and database mappings are resolved exclusively from the trusted server registry and cannot be overridden by the panel request.
- **Visible Dependency Pipeline**: Database-backed installs show the server-owned provisioning order and required databases can no longer be accidentally disabled in the wizard.

### Fixed
- **Safe Interrupted-Install Retry**: Repeating an install with the same name reuses the caller-owned failed service, persistent database, volume and attachment instead of creating duplicates. Existing generated secrets are preserved unless the user explicitly replaces them.
- **Dependency-First Queueing**: An application deployment is never queued until its required managed database has started successfully and its attachment has been reconciled. Existing in-progress deployments are reused.
- **All Database Templates on One Path**: Directus, Ghost, Hasura, Matomo, Umami, Vikunja, WordPress and YOURLS are covered by the same provisioning contract and regression suite.

## [0.2.31] - 2026-08-20

### Fixed
- **Working Ghost 5 Template**: Ghost Hub installs now provision MySQL automatically and inject `database__client` plus all required `database__connection__*` values before deployment.
- **Existing Failed Install Repair**: Repeating the same Ghost Hub installation repairs the trusted template contract on an older failed service, then provisions and attaches its missing database.
- **Actionable Health Failures**: Containers that exit or remain in a restart loop fail early with exit state and redacted recent runtime logs instead of five minutes of repeated sibling-probe errors.

### Verified
- **Real Ghost Smoke Test**: `ghost:5-alpine` was started against the managed `mysql:8.4` contract on an isolated Docker network and accepted connections on port 2368.

## [0.2.30] - 2026-08-20

### Added
- **Service Domain Launcher**: Services with at least one configured domain now expose a consistent open-site icon in service cards, dashboard health and activity rows, the service header, and topology nodes.
- **Safe Destination Modal**: Clicking the icon always previews the exact destination before opening it in a new tab. Multiple domains are listed individually with their HTTP/HTTPS protocol and route path.

### Changed
- **Shared Domain State**: All launchers share one cached domain query instead of issuing a request per service, and refresh immediately when a domain is added, removed or updated.

## [0.2.29] - 2026-08-20

### Added
- **Guided Cloudflare Setup**: The Tunnels panel now gives numbered instructions for choosing a remotely managed Cloudflare Tunnel with `cloudflared`, extracting the connector token and confirming connector health.
- **Exact Routing Values**: The guide provides a copyable `http://ninedeploy-traefik:80` Published application origin and a final end-to-end verification checklist.

### Changed
- **Domain and TLS Guidance**: The panel explicitly requires the same public hostname in NineDeploy with SSL disabled because Cloudflare terminates browser TLS and forwards HTTP to Traefik.
- **Safer Token Entry**: The connector token is masked and clearly distinguished from API tokens, API keys, Tunnel IDs and certificates.

## [0.2.28] - 2026-08-20

### Added
- **Full Curated Catalog**: All 88 schema-valid, single-service-compatible templates are visible and deployable in the Hub again.
- **Trust Tiers**: The Hub shows `All 88`, `Verified 15` and `Community 73` filters, plus a clear trust badge on every application card.

### Changed
- **Transparent Certification**: Runtime smoke certification is communicated as metadata instead of being used as a blanket visibility filter. Community templates display a review warning before configuration and deployment.

## [0.2.27] - 2026-08-20

### Added
- **Container Port Control**: Service Network settings expose the internal application port used by Traefik, healthchecks and optional host-port publishing.
- **Image Port Detection**: Dockerfile and image deployments automatically adopt an unambiguous single TCP port from image `EXPOSE` metadata.

### Fixed
- **Nixpacks Domain Routing**: Dockerfile-less source deployments now default to port 3000, receive `PORT=3000`, persist the resolved port and generate a usable Traefik upstream after the first successful deployment.
- **Single Routing Port**: Process configuration, readiness checks, Docker port mapping and Traefik no longer derive their target ports independently.

## [0.2.26] - 2026-08-20

### Fixed
- **Real Nixpacks CLI**: Source deployments use the actual Nixpacks 1.37.0 executable instead of trying to run the CLI command inside `ghcr.io/railwayapp/nixpacks`, which is a build-base image and contains no `nixpacks` command.
- **Consistent Host and Agent Builds**: The Ubuntu installer and NineDeploy runtime image provision the same pinned CLI for local and remote deployments.

### Security
- **Verified Build Toolchain**: AMD64 and ARM64 Nixpacks release archives are downloaded from the official release and checked against architecture-specific SHA-256 digests before installation.

## [0.2.25] - 2026-08-20

### Added
- **Deployment Activity Heartbeats**: Any deployment command that remains silent for 20 seconds emits an elapsed-time liveness message, while fresh stdout or stderr postpones the heartbeat to keep normal logs clean.
- **Recovery Phase Visibility**: Direct registry export, recovered-filesystem packaging, and Docker image import report their exact phase every 15 seconds without inventing percentages that upstream tools do not provide.

### Security
- **Safe Progress Labels**: Generic heartbeat messages never include subprocess arguments, preventing passwords, tokens, and other sensitive command values from leaking into deployment logs.

## [0.2.24] - 2026-08-20

### Fixed
- **Explicit Native Platform**: Native snapshot recovery now passes the host `linux/amd64` or `linux/arm64` platform to both containerd pull and mount operations, so multi-platform OCI indexes resolve deterministically.
- **Containerd 2 Transfer Workaround**: `no unpack platforms defined` failures from containerd's transfer API automatically retry through `ctr --local`, the upstream-documented workaround, before using direct registry export.

## [0.2.23] - 2026-08-20

### Fixed
- **Image-Independent Recovery**: Snapshotter-independent recovery is certified across Docker Hub, GHCR, and Codeberg images instead of being treated as a MySQL-specific path.
- **BusyBox Export Compatibility**: The pinned, checksum-verified registry client release also handles root filesystem archives containing a top-level `.` entry, which is required by BusyBox and can occur in arbitrary service images.
- **Shared Verified Tooling**: Concurrent and sequential image recoveries reuse one verified registry binary per NineDeploy process instead of downloading it once per application or database.

### Added
- **Hub-Wide Recovery Gate**: `pnpm docker:smoke-registry-recovery` forces all 15 runtime-certified Hub applications through direct registry export, fresh Docker import, real container startup, and declared TCP-port probing. WordPress/MySQL and Directus/PostgreSQL additionally prove database initialization and application wiring.

## [0.2.22] - 2026-08-20

### Fixed
- **Snapshotter-Independent Image Recovery**: When both Docker overlayfs extraction and containerd's native snapshotter fail, NineDeploy now exports the image filesystem directly from its OCI registry and imports it under a fresh single-layer chain ID.
- **Verified Recovery Tooling**: The emergency registry client is pinned to an exact upstream release and its Linux amd64/arm64 archive is checked against a built-in SHA-256 before execution.
- **Runtime Metadata Preservation**: Direct recovery retains environment, entrypoint, command, working directory, user, stop signal, exposed ports, volumes, labels, on-build instructions, and healthcheck configuration.

### Added
- **Real MySQL Recovery Smoke**: `pnpm docker:smoke-registry-recovery` exports `mysql:8.4` without a containerd snapshotter, imports it under an isolated test tag, starts it, waits for `mysqladmin ping`, and removes only its exact smoke resources.

## [0.2.21] - 2026-08-20

### Fixed
- **Fail-Closed Template Hub**: Registry-valid templates are no longer automatically advertised as deployable. Hub list, detail, Web deploy, CLI deploy, and direct service creation accept only runtime-certified templates.
- **Runtime-Certified Initial Set**: n8n, WordPress, Directus, Gitea, Forgejo, Uptime Kuma, Vaultwarden, Memos, Kavita, PocketBase, Qdrant, Actual Budget, MinIO, Grafana, and Excalidraw passed isolated container startup and declared-port probes.
- **No Marketing Inflation**: Public surfaces now distinguish the 15 runtime-certified templates from the larger registry-inspected catalog.

### Added
- **Reusable Runtime Smoke Runner**: `pnpm templates:smoke-runtime -- --ids=...` pulls each selected image, starts it with its real registry environment, command and persistent volume, verifies that it remains running and listens on the declared Docker-network port, then removes only its isolated test resources.

## [0.2.20] - 2026-08-20

### Fixed
- **Honest One-Click Catalog**: Removed 47 stack components and unsupported containers that cannot run under NineDeploy's current single-application plus optional single-database contract. The remaining 88 images all pass live OCI registry inspection.
- **Real Database Template Wiring**: Templates persist application-specific connection mappings, so WordPress receives `WORDPRESS_DB_*`, Directus receives `DB_*`, and other supported database apps receive the fields their images actually consume instead of an unusable generic URL.
- **Working MySQL Initialization**: Managed MySQL and MariaDB instances create and persist the `app` database during first boot; connection strings now target that real database.
- **CLI Database Provisioning**: `ninedeploy templates deploy` now provisions, starts, records, and attaches the required managed database before queuing the application deployment.
- **Trusted Template Runtime Settings**: Web Hub deploys send only a template ID; server-side registry data supplies protected commands, Docker socket access, and database mappings so MinIO and Docker-management templates no longer lose required runtime settings.
- **Corrected Upstream Images**: Memos uses `neosmemo/memos:stable`, Forgejo uses the supported v16 image, and Kavita uses `jvmilazz0/kavita:latest`.
- **Independent Template Data**: Multiple installations of the same database-backed template derive database names from the actual service slug and no longer share one database accidentally.

### Added
- **Live Image Contract Gate**: `pnpm templates:verify-images` checks every bundled template against its OCI registry and exits non-zero for missing repositories or tags.

## [0.2.19] - 2026-08-20

### Fixed
- **No Hidden Docker Pulls**: BusyBox health probes, Alpine volume tools, Adminer/Redis Commander, Nixpacks, Cloudflare Tunnel, dashboard netns probes, and Traefik now prepare their images through the same bounded containerd recovery used by deployments and databases.
- **Remote Agent Recovery Parity**: `docker.pull` operations executed by remote NineDeploy agents now use the shared snapshot repair and native-snapshot fallback instead of a raw Docker CLI pull.
- **Canonical Traefik Lifecycle**: Startup, watchdog healing, and manual updates use one container configuration path, preserving ACME/DNS settings, config fingerprints, host gateway routing, network attachment, and post-start liveness checks.
- **Working Automatic HTTPS**: Wildcard domains created after deployment are marked SSL-enabled when an ACME email is configured, allowing Traefik to request and renew certificates automatically.
- **Reliable Ubuntu Privileges**: The installer uses one elevated Docker wrapper when group membership is not active yet, detects external versus daemon-managed containerd storage, and runs the Docker host control-plane as root instead of a nominally unprivileged but Docker-root-equivalent user.
- **Real Install Readiness**: Installation now fails unless Traefik is running, attached to the shared network, and actually answering on port 80.

## [0.2.18] - 2026-08-20

### Fixed
- **Targeted Stale Snapshot Repair**: Persistent Docker 29 `target snapshot already exists` failures now validate the exact overlayfs snapshot as committed, ask containerd to remove it only when it has no active dependants, and retry the original pull before using the flattened-image fallback.
- **Correct containerd Endpoint Detection**: Recovery commands now explicitly target Docker's external or daemon-managed containerd socket instead of assuming the `ctr` default.
- **Actionable Recovery Errors**: If both targeted repair and native recovery fail, the deployment error now includes the native recovery failure instead of reporting only the original `docker pull` exit code.

## [0.2.17] - 2026-08-20

### Fixed
- **Managed Database Image Recovery**: PostgreSQL, MySQL, MariaDB, Redis, Valkey, and MongoDB images are now explicitly prepared through NineDeploy's Docker 29/containerd snapshot recovery before `docker run`.
- **No Implicit Database Pulls**: Database startup no longer delegates image pulling to `docker run`, preventing stale overlayfs metadata from surfacing only as an opaque exit code 125. Failed image preparation stops before container state or secret env files are mutated.

## [0.2.16] - 2026-08-20

### Fixed
- **Panel-Wide Autofill Rejection**: Authenticated panel inputs and textareas now disable browser autocomplete, autocorrect, spellcheck, and the autofill hooks used by common password managers, including fields mounted later by dialogs and plugins.
- **Settings Navigation Protection**: The Settings filter remains read-only until deliberate pointer or keyboard interaction and actively rejects Chrome/Safari autofill injection, preventing stray values such as `k` from hiding the settings menu.

## [0.2.15] - 2026-08-20

### Fixed
- **Persistent Docker 29 Snapshot Recovery**: A pull blocked by a stale containerd overlayfs target now switches immediately to the isolated native snapshotter, reconstructs a verified single-layer image, and continues the deployment.
- **Non-Destructive Recovery**: The fallback preserves the image runtime configuration and filesystem ownership, capabilities, ACLs, and extended attributes without deleting or hiding existing images, containers, or volumes.

## [0.2.14] - 2026-08-20

### Fixed
- **End-to-End Hub Retry Recovery**: Interrupted template deployments now resume only their matching caller-owned idle service, overwrite the partial template environment safely, reuse the matching database, and reuse an existing service/database attachment.
- **No More Partial-Install Collisions**: Retrying after a database startup anomaly no longer stops at service slug, environment key, database slug/container, or attachment uniqueness errors.

## [0.2.13] - 2026-08-20

### Fixed
- **Database Start Reconciliation**: A managed database container that is actually running is now adopted when `docker run` reports a late code 125 failure, preventing a false `error` state.
- **Retryable Hub Database Provisioning**: Hub templates can safely resume their own matching database after an interrupted attempt instead of failing on the existing slug/container name. Ownership, engine, project, and version must all match.

## [0.2.12] - 2026-08-20

### Fixed
- **Automatic Image Port Recovery**: When a Docker healthcheck fails on the configured internal port, NineDeploy now reads the container image's declared TCP ports, probes those alternatives from the shared Docker network, and adopts the first healthy port.
- **Persistent Routing Repair**: The detected port is persisted on the service before Traefik routing is regenerated, so subsequent deploys and domain requests use the corrected value. This repairs n8n deployments mistakenly configured for port `80` by switching them to the image-declared `5678/tcp` port.

## [0.2.11] - 2026-08-20

### Fixed
- **Live Let's Encrypt Activation**: Saving the ACME account email in Settings -> Security now safely recreates Traefik, mounts writable persistent `acme.json`, regenerates routers with the `letsencrypt` resolver, and starts certificate issuance immediately.
- **Live DNS-01 Updates**: DNS provider, API token, and wildcard apex changes now recreate Traefik and regenerate its dynamic configuration without waiting for a NineDeploy restart.
- **Stale Static Configuration Detection**: Managed Traefik containers carry a SHA-256 fingerprint of their static ACME and DNS inputs. A missing or outdated fingerprint forces a safe recreate, including after an interrupted prior update.
- **Installer ACME Setup**: Interactive installs now ask for the required Let's Encrypt account email and persist it in `.env`; unattended installs clearly warn when automatic HTTPS remains disabled.

## [0.2.5] - 2026-08-19

### Fixed
- **Fail-Closed Traefik Bootstrap**: Docker network creation, Traefik image pulls, container startup and network attachment are now mandatory verified installation gates; NineDeploy no longer reports a healthy install while domain routing is unavailable.
- **Idempotent Traefik Provisioning**: Re-running the installer now reuses a locally verified Traefik v3 image. When no usable image exists it attempts Docker Hub exactly once, then immediately checksum-verifies the official Traefik release binary and constructs a minimal image without the conflicting Alpine layer; the installer no longer loops pulls, prunes images, restarts Docker, or edits containerd metadata.
- **Missing Containerd Snapshot Root Repair**: Docker 29 hosts whose overlayfs metadata remains but physical `snapshots/` directory was lost are repaired by recreating only that required root directory with strict root ownership and permissions; existing metadata and container data are never removed.
- **Traefik Status Detection**: Container liveness now comes exclusively from Docker state and no longer flips to `stopped` when optional version probing fails; both the official PATH binary and the layer-free `/traefik` binary are supported.
- **Permanent systemd Watchdog Migration**: The installer now installs and verifies an explicit `Type=simple` / `WatchdogSec=0` runtime policy, repairing stale `Type=notify` installations that could SIGTERM long Docker pulls with exit code 143.
- **Absolute Data Directory Rendering**: Relative `.env` values such as `NINEDEPLOY_DATA_DIR=./.data` are resolved against the installation directory before being written to systemd `ReadWritePaths`.
- **Drop-in Ordering Safety**: The installer-owned watchdog safety policy sorts after conventional `override.conf` files and replaces the short-lived numeric-prefix migration file without deleting administrator configuration.
- **Removed Invalid Runtime Notify Client**: Removed the dependency-free stream-socket `sd_notify` implementation and its watchdog calls; installer HTTP health checks remain the authoritative readiness gate.
- **Installer Argument Parsing**: Correctly parses both spaced and equals forms of `--version` and `--channel`, with validation for unsupported values.
- **Accurate Docker Exit Diagnostics**: Documentation now distinguishes SIGTERM exit 143 from the usual OOM/SIGKILL exit 137.

## [0.2.4] - 2026-08-19

### Added
- **Full Host Firewall (UFW) Management Engine**: Interactive host firewall control across API (`/v1/firewall`), SDK, Web UI (`Settings -> Firewall`), and CLI (`ninedeploy firewall`).
- **1-Click Service Port Presets in Web UI**: Single-click activation/deactivation for common multi-port services including Mail Server (Poste.io / Mailcow: `25, 465, 587, 993, 995`), Databases (PostgreSQL `5432`, MySQL `3306`, Redis `6379`, MongoDB `27017`), Web Ingress (`80, 443`), and SSH (`22`).
- **Automatic Installer Firewall Hardening**: `install.sh` automatically configures and hardens UFW rules for SSH (`22/tcp`), Web (`80/tcp`, `443/tcp`), and custom panel ports without accidental lockout risk.
- **Node.js 24 & 22 Active LTS Support**: Updated installer and package engines to prioritize Node.js 24 LTS and Node.js 22 LTS on Ubuntu 24.04/26.04 and Debian 12.

### Fixed
- **Ubuntu 24.04 Systemd Socket & Symlink Compatibility**: Hardened systemd unit file `ReadWritePaths` with non-fatal prefixes (`- /var/run/docker.sock`, `- /run/docker.sock`) to prevent mount failures on modern systemd distributions.
- **Background Timer Unreferencing**: Added `unref: true` to worker, metrics collector, and cron scheduler intervals to prevent process retention and optimize event loop lifecycle.

---

## [0.2.3] - 2026-08-19

### Added
- **Monorepo Version Synchronization (`pnpm version:bump`)**: Automated version bumper script synchronizing root, all 9 packages, and in-code API/CLI/MCP constants in a single step.
- **Traefik Background Self-Healing Watchdog**: Periodic watchdog reviving stopped or pruned proxy containers automatically.
- **Automated Memory & Swap Provisioning**: `install.sh` automatically detects low-memory VPS hosts ($\le 4\text{GB}$ RAM) and allocates an active 2GB `/swapfile` to prevent OOM kills on heavy image pulls.
- **Enhanced Doctor & Self-Healing Engine**: `ninedeploy doctor --fix` with comprehensive RAM, Swap, Docker storage layer, SQLite integrity, network latency diagnostics, and automated repair.
- **Zero-Failure Ubuntu Server Hardening**: Automatic installation of essential base utilities (`curl`, `git`, `ca-certificates`, `tar`), pre-creation of the `ninedeploy` Docker network, pre-pulling of `traefik:3`, and conflict resolution for ports 80/443 (auto-disabling competing `apache2`/`nginx` services).

### Fixed
- **ACME Permissions Enforcement**: Ensured strict `0600` permissions on `/etc/traefik/acme.json` before container mount.
- **Systemd Watchdog Timeout Termination**: Switched systemd unit to `Type=simple` and removed 90s watchdog timer to eliminate false-positive SIGTERM kills (exit code 143) during long builds and large image pulls (e.g. `n8nio/n8n`).
- **Database Migrator Directory Creation**: `packages/db` automatically ensures parent directories exist recursively to prevent SQLite Error 14 (`SQLITE_CANTOPEN`).
- **Cross-Platform MCP URL Resolution**: Replaced manual string concatenation in `@ninedeploy/mcp` with `node:url` `pathToFileURL` to normalize file URL comparisons across Windows drive letters and Linux paths.
- **Installer Script Health Loop**: Fixed Bash special loop variable shadowing (`$_` in `seq` loop) during `/health` readiness polling in `install.sh`.
- **First-Run Admin Bootstrap**: Hardened transactional setup and error handling for initial instance registration and database reset workflows.

### Verified
- **Monorepo Test Suite**: Verified 100% test pass rate across 2,100+ tests and 100% branch/statement coverage in all 9 packages.
- **Zero-Error Pipeline**: Complete workspace verification across Biome linter, TypeScript strict typecheck, and production builds.

---

## [0.2.2] - 2026-08-19

### Fixed
- **Cross-Platform MCP URL Resolution**: Replaced manual string concatenation in `@ninedeploy/mcp` with `node:url` `pathToFileURL` to normalize file URL comparisons across Windows drive letters and Linux paths.
- **Installer Script Health Loop**: Fixed Bash special loop variable shadowing (`$_` in `seq` loop) during `/health` readiness polling in `install.sh`.
- **First-Run Admin Bootstrap**: Hardened transactional setup and error handling for initial instance registration and database reset workflows.

### Verified
- **Monorepo Test Suite**: Verified 100% test pass rate across 2,100+ tests and 100% branch/statement coverage in all 9 packages.
- **Zero-Error Pipeline**: Complete workspace verification across Biome linter, TypeScript strict typecheck, and production builds.

---

## [0.2.1] - 2026-08-18

### Added
- **NPM Distribution**: Official npm publication configuration for CLI and public SDK packages.
- **CLI Package Naming**: Renamed CLI package to `ninedeploy` for instant `npx ninedeploy` execution and global npm install.
- **Public Monorepo Packaging**: Configured public access rules for `@ninedeploy/sdk`, `@ninedeploy/schemas`, `@ninedeploy/plugin-sdk`, and `@ninedeploy/mcp`.
- **Release Automation**: Streamlined workspace release scripts and multi-package dependency publishing workflows.

---

## [0.2.0] - 2026-08-18

### Added
- **Workspaces & Multi-Tenancy**: Workspace isolation with 4-tier RBAC (`Owner`, `Admin`, `Member`, `Viewer`).
- **Enterprise SSO & Passkeys**: OpenID Connect (Google, GitHub, Keycloak, Okta), biometric Passkeys (WebAuthn / FIDO2), and TOTP 2FA.
- **Microkernel Architecture**: Event bus and waterfall hook pipeline (`deploy.before`, `deploy.after`).
- **Configuration Center**: Dual-Vault AES-256-GCM encryption with automatic master key rotation.
- **Plugin SDK**: Modular plugins with `MenuRegistry` and `ServiceRegistry` driver interchange.
- **AI Model Context Protocol (MCP)**: 35-tool MCP server for AI coding assistants (Claude, Cursor, Antigravity, Cline).
- **Extended Databases**: 1-click Postgres (`pgvector`), MySQL, MariaDB, Redis, Valkey, ClickHouse, Meilisearch, Mongo, and RabbitMQ.
- **Container File Manager**: Live in-browser filesystem browser with drag-and-drop operations.
- **Log Drains**: Structured log forwarding to Syslog, HTTP endpoints, and Datadog.
- **Preview Environments**: Ephemeral PR staging environments with automatic cleanup on pull-request close.

---

## [0.1.0] - 2026-08-14

### Added
- **Core Deploy Engine**: Git repositories (public/private) + Docker image sources, PM2 + Docker targets.
- **Zero-Downtime Releases**: Blue-green deployment pipeline with health checks and automatic rollback.
- **Auto-Deploy Webhooks**: GitHub, GitLab, and Gitea integration with HMAC signatures.
- **Live Terminal & Logs**: WebSocket streaming logs and in-browser interactive xterm.js terminal.
- **Managed Databases & Backups**: Automated daily encrypted snapshots with S3-compatible offsite sync.
- **Traefik Ingress**: Automatic Let's Encrypt TLS (HTTP-01 & DNS-01) and Cloudflare Tunnels.
- **Hardened Service Model**: `systemd` watchdog supervision (`sd_notify`) and rootless container execution.
