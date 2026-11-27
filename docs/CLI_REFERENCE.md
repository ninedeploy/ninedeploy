# CLI command reference

Every command of the `ninedeploy` CLI at version **0.20.0**, generated from the CLI's own `--help` output by `scripts/generate-cli-reference.mjs`. Each entry gives the usage line, the description and the options exactly as the CLI prints them. For sign-in, configuration, examples and the SDK and MCP references, see [API, MCP, CLI and SDK](AI_MCP_CLI.md).

The same text is available in a terminal with `ninedeploy <command> --help` or `ninedeploy <command> <subcommand> --help`.

| Command | Description |
|---|---|
| [`init`](#init) | Initialize local instance and setup admin user (alias for setup) |
| [`setup`](#setup) | Create the first admin user on a fresh instance |
| [`login`](#login) | Authenticate against a NineDeploy server |
| [`logout`](#logout) | Revoke this CLI session and clear stored credentials |
| [`whoami`](#whoami) | Show the currently authenticated user and server |
| [`config`](#config) | Show or change the server URL |
| [`services`](#services) | Manage services |
| [`databases`](#databases) | Manage databases |
| [`templates`](#templates) | Browse the template hub and scaffold starter manifests from it |
| [`deploys`](#deploys) | Manage deployments |
| [`token`](#token) | Manage API tokens |
| [`system`](#system) | System information & tools |
| [`env`](#env) | Manage service environment variables |
| [`domains`](#domains) | Manage domains & routing |
| [`config-preset`](#config-preset) | Manage named configCenter bundles that can be re-applied to a fresh instance |
| [`metrics`](#metrics) | Resource monitoring and kernel event history |
| [`log-drains`](#log-drains) | Inspect and recover durable log delivery |
| [`build-cache`](#build-cache) | Build cache plugin — per-backend LRU stats (G-01) |
| [`branding`](#branding) | Override the panel logo, color, support email and footer (G-30) |
| [`ips`](#ips) | Manage this server's IP addresses: label, primary, dedicate to a service |
| [`egress`](#egress) | Manage per-project outbound IP rules (G-15) |
| [`import`](#import) | Move from Coolify, Dokploy, CapRover or Heroku: plan (read-only), apply, data, cutover |
| [`sso`](#sso) | Manage OIDC / SAML SSO providers (G-22) |
| [`volumes`](#volumes) | Manage Docker volumes |
| [`networks`](#networks) | Manage Docker networks |
| [`sessions`](#sessions) | Manage your active sessions |
| [`backups`](#backups) | Manage database backups |
| [`alerts`](#alerts) | Manage alert rules |
| [`notifications`](#notifications) | Manage notification channels (admin) |
| [`users`](#users) | List users (admin) |
| [`reset-link`](#reset-link) | Generate a one-time password reset link (admin) |
| [`activity`](#activity) | Show recent activity |
| [`plugins`](#plugins) | Manage plugins and marketplace extensions |
| [`config-center`](#config-center) | Manage central configuration entries and secrets |
| [`workspaces`](#workspaces) | Manage workspaces and team organizations |
| [`images`](#images) | Inspect and prune Docker images on the host |
| [`demo`](#demo) | Demo mode operations |
| [`server`](#server) | Manage local NineDeploy Docker server |
| [`logs`](#logs) | Search the configured log drain (Loki) |
| [`email-templates`](#email-templates) | Manage per-workspace email template overrides |
| [`certificates`](#certificates) | Traefik certificate inventory and renewal status |
| [`proxy`](#proxy) | Traefik proxy management (operator) |
| [`secrets`](#secrets) | Deploy-time secret references |
| [`terminals`](#terminals) | Terminal session history and termination (operator) |
| [`terminal`](#terminal) | Open an interactive shell (operator; needs a TTY) |
| [`tunnel`](#tunnel) | Reach a database or a service port through the panel on a local port (G5.8) |
| [`traffic`](#traffic) | Traffic analytics (opt-in) |
| [`access`](#access) | Project and environment access grants |
| [`servers`](#servers) | Remote nodes: agent capabilities, build-server role (operator) |
| [`swarm`](#swarm) | Docker Swarm on the panel host (operator, opt-in per service) |
| [`monitors`](#monitors) | Uptime monitors: HTTP(S) and TCP checks with up/down alerts |
| [`status-pages`](#status-pages) | Public status pages showing a set of monitors (operator) |
| [`canary`](#canary) | Canary releases: shift traffic to a new release in steps |
| [`autoscale`](#autoscale) | Autoscaling: run between a minimum and a maximum number of containers, set by load |
| [`sleep`](#sleep) | Scale to zero: stop an idle service and wake it on the next request |
| [`previews`](#previews) | PR preview settings of a git-backed service |
| [`lanes`](#lanes) | Deployment lanes (production, staging, …) and their protection |
| [`approvals`](#approvals) | Deploys waiting for an admin's approval |
| [`ci`](#ci) | CI pipelines, jobs and runners |
| [`doctor`](#doctor) | Run system, Docker, server connectivity, and auth diagnostics |
| [`sources`](#sources) | Manage private repository credentials (PATs / SSH keys) |
| [`github-app`](#github-app) | Manage GitHub Apps (one-click setup runs in the panel: Sources → GitHub Apps) |
| [`deploy`](#deploy) | End-to-end deploy helpers |
| [`webhooks`](#webhooks) | Manage auto-deploy webhooks |
| [`firewall`](#firewall) | Manage host firewall (UFW) and open ports |
| [`manifest`](#manifest) | Manage the .ninedeploy file in this repo |

## `init`

```
ninedeploy init [options]
```

Initialize local instance and setup admin user (alias for setup)

| Option | Description |
|---|---|
| `--setup-token <token>` | One-time setup token printed by the installer (or NINEDEPLOY_SETUP_TOKEN) |

## `setup`

```
ninedeploy setup [options]
```

Create the first admin user on a fresh instance

| Option | Description |
|---|---|
| `--setup-token <token>` | One-time setup token printed by the installer (or NINEDEPLOY_SETUP_TOKEN) |

## `login`

```
ninedeploy login [options]
```

Authenticate against a NineDeploy server

## `logout`

```
ninedeploy logout [options]
```

Revoke this CLI session and clear stored credentials

## `whoami`

```
ninedeploy whoami [options]
```

Show the currently authenticated user and server

## `config`

```
ninedeploy config [options]
```

Show or change the server URL

| Option | Description |
|---|---|
| `-s, --server <url>` | Set server URL |

## `services`

```
ninedeploy services|service [options] [command]
```

Manage services

Can also be called as `ninedeploy service`.

### `services list`

```
ninedeploy services list [options]
```

List all services

### `services create`

```
ninedeploy services create [options]
```

Create a service (interactive wizard)

### `services get`

```
ninedeploy services get [options] <id>
```

Show service details

### `services deploy`

```
ninedeploy services deploy [options] <id>
```

Trigger a new deployment

### `services logs`

```
ninedeploy services logs [options] <id>
```

View runtime container logs (the newest lines)

| Option | Description |
|---|---|
| `--tail <n>` | Number of lines, 1 to 5000 (default 50) |
| `--grep <text>` | Only lines containing this text (case-insensitive) |

### `services stop`

```
ninedeploy services stop [options] <id>
```

Stop a running service

### `services start`

```
ninedeploy services start [options] <id>
```

Start a stopped service

### `services restart`

```
ninedeploy services restart [options] <id>
```

Restart a service

### `services lifecycle`

```
ninedeploy services lifecycle [options] <id>
```

Show the last node runtime command and its pending reason

| Option | Description |
|---|---|
| `--retry` | Retry the same command without changing its revision |

### `services delete`

```
ninedeploy services delete [options] <id>
```

Delete a service (with confirmation)

### `services export`

```
ninedeploy services export [options] <id>
```

Export a service as a JSON bundle

### `services compose`

```
ninedeploy services compose [options] <id>
```

Show generated runtime Docker Compose YAML

### `services inspect`

```
ninedeploy services inspect [options] <id>
```

Inspect runtime container and Traefik tags

### `services sticky`

```
ninedeploy services sticky [options] <id>
```

Toggle sticky-session routing (Traefik sticky cookie, G-28)

| Option | Description |
|---|---|
| `--enable` | Route every request to the same backend container |
| `--disable` | Remove the sticky-cookie middleware |

### `services deploy-hook`

```
ninedeploy services deploy-hook [options] <id>
```

Show, turn on (or rotate) or turn off the deploy hook URL for CI

| Option | Description |
|---|---|
| `--enable` | Turn the hook on, or give it a new URL |
| `--disable` | Turn the hook off |

### `services ports`

```
ninedeploy services ports [options] <id> [mappings...]
```

List or replace extra host-port mappings (e.g. 27015-27030/udp, 203.0.113.7:8443:443, 5432@10.0.0.0/8)

| Option | Description |
|---|---|
| `--clear` | Remove every port mapping |

### `services github`

```
ninedeploy services github [options] <id>
```

Show or change the GitHub App link (commit statuses, PR comments, migrate, finalize, unlink)

| Option | Description |
|---|---|
| `--status <onOff>` | Commit statuses for deploys: on \| off |
| `--pr-comment <onOff>` | PR preview comments: on \| off |
| `--migrate <sourceId>` | Link to the GitHub App installation behind this gh-app source |
| `--finalize` | Detach the previous source and switch the per-service webhooks off |
| `--unlink` | Revert: restore the previous source and webhooks, remove the link |

### `services placement`

```
ninedeploy services placement [options] <id>
```

Show or (operator) change where the image is built and which orchestrator runs it

| Option | Description |
|---|---|
| `--build-on <where>` | target (where it runs) \| panel \| server |
| `--build-server <id>` | The build server for --build-on server (none clears it) |
| `--push-registry <sourceId>` | Ship the image through this registry credential (none = stream relay) |
| `--push-repo <repo>` | Repository for --push-registry, e.g. team/app |
| `--orchestrator <name>` | container \| swarm |

### `services transfers`

```
ninedeploy services transfers [options] <id>
```

Image transfers of a service, newest first

| Option | Description |
|---|---|
| `--limit <n>` | How many (1-100, default 20) |

### `services swarm`

```
ninedeploy services swarm [options] <id>
```

Swarm tasks of a service

## `databases`

```
ninedeploy databases [options] [command]
```

Manage databases

### `databases list`

```
ninedeploy databases list [options]
```

List all databases

### `databases create`

```
ninedeploy databases create [options]
```

Create a database (interactive)

| Option | Description |
|---|---|
| `--server <id>` | Run it on this node (operator; fixed for its life) |

### `databases pgbouncer`

```
ninedeploy databases pgbouncer [options] <dbId> <action>
```

Manage the PgBouncer sidecar: enable | disable | status (postgres only)

| Option | Description |
|---|---|
| `--port <port>` | Override the listen port (enable only) |

### `databases upgrade`

```
ninedeploy databases upgrade [options] [command]
```

Move a PostgreSQL, MySQL, MariaDB or MongoDB database to a newer release in a new volume, compare, switch (previous volume kept)

### `databases pitr`

```
ninedeploy databases pitr [options] [command]
```

PostgreSQL point-in-time recovery: WAL archiving, base backups, recovery into a new database

### `databases backup-policy`

```
ninedeploy databases backup-policy [options] [command]
```

Per-database backup schedule, retention and destination

### `databases public-access`

```
ninedeploy databases public-access [options] <id>
```

Show, enable/update (--enable) or disable (--disable) public access through a TCP sidecar (operator)

| Option | Description |
|---|---|
| `--enable` | Enable or update public access; unset flags keep their current value |
| `--disable` | Remove the sidecar (the settings are kept) |
| `--port <port>` | Host port, 1024-65535 |
| `--allow <cidr...>` | Allowed source addresses or CIDRs (replaces the allow-list) |
| `--tls <mode>` | none \| terminate (not for mysql/mariadb) |
| `--tls-host <host>` | Hostname clients connect to (and the TLS name in terminate mode) |

### `databases import`

```
ninedeploy databases import [options] <id>
```

Import a dump from a local file (chunked, resumable) or a backup destination object (operator)

| Option | Description |
|---|---|
| `--file <path>` | Dump file to upload |
| `--from-s3 <destinationId>` | Backup destination to read the object from (operator) |
| `--key <key>` | Object key inside the destination prefix (with --from-s3) |
| `--clean` | postgres custom format: drop objects before recreating them |
| `--no-single-transaction` | postgres: do not wrap the restore in one transaction |
| `--drop` | mongo: drop each collection before restoring it |
| `--confirm-replace` | redis/valkey/keydb/dragonfly: required, the RDB replaces the whole dataset |
| `--no-safety-backup` | Skip the pre-import backup (operator, or a database created in the last 10 minutes) |
| `--resume <importId>` | Continue an interrupted upload of the same file |
| `--no-wait` | Return once the import has started |

### `databases imports`

```
ninedeploy databases imports [options] <id>
```

List a database's imports

| Option | Description |
|---|---|
| `--watch` | Keep polling until no import is uploading, pending or running |

## `templates`

```
ninedeploy templates [options] [command]
```

Browse the template hub and scaffold starter manifests from it

### `templates list`

```
ninedeploy templates list [options]
```

List all templates

### `templates deploy`

```
ninedeploy templates deploy [options] <id>
```

Deploy a template by ID

### `templates community`

```
ninedeploy templates community [options] [command]
```

Manage per-instance community template contributions

### `templates init`

```
ninedeploy templates init [options] <templateId>
```

Fetch a template from the panel and emit a starter .ninedeploy

| Option | Description |
|---|---|
| `--host <host>` | Default `routes[0].host` for the starter manifest |
| `--filename <name>` | Filename to write when --write is set (default .ninedeploy) |
| `--write` | Write to a file in the current directory instead of stdout |

## `deploys`

```
ninedeploy deploys [options] [command]
```

Manage deployments

### `deploys queue`

```
ninedeploy deploys queue [options]
```

List every in-flight (queued / building / deploying) deploy across all services you can see

### `deploys list`

```
ninedeploy deploys list [options] <serviceId>
```

List deployments for a service

### `deploys rollback`

```
ninedeploy deploys rollback [options] <serviceId> <deployId>
```

Rollback to a previous deployment

### `deploys diagnose`

```
ninedeploy deploys diagnose [options] <service> <deployId>
```

The configured AI provider diagnoses a failed deployment and may propose a settings change

| Option | Description |
|---|---|
| `--apply` | Apply the proposed settings change and start a deploy |
| `--json` | Print raw JSON |

### `deploys cancel`

```
ninedeploy deploys cancel [options] <serviceId> <deployId>
```

Cancel a queued or in-flight deployment

### `deploys rm`

```
ninedeploy deploys rm [options] <serviceId> <deployId>
```

Remove a finished deployment from history, with its build log

| Option | Description |
|---|---|
| `-y, --yes` | Skip the confirmation prompt |

### `deploys watch`

```
ninedeploy deploys watch [options] <serviceId> <deployId>
```

Stream a deployment's build logs live

## `token`

```
ninedeploy token [options] [command]
```

Manage API tokens

### `token create`

```
ninedeploy token create [options]
```

Create a new API token

### `token list`

```
ninedeploy token list [options]
```

List API tokens

## `system`

```
ninedeploy system [options] [command]
```

System information & tools

### `system info`

```
ninedeploy system info [options]
```

Show version, stats, and tech stack

### `system dashboard`

```
ninedeploy system dashboard [options]
```

Live dashboard with service health

### `system update-check`

```
ninedeploy system update-check [options]
```

Compare the running version with the latest release

| Option | Description |
|---|---|
| `-f, --force` | Bypass the 6h cache |

### `system rotate-keys`

```
ninedeploy system rotate-keys [options]
```

Re-encrypt every stored secret onto the newest NINEDEPLOY_MASTER_KEYS version

### `system prune`

```
ninedeploy system prune [options]
```

Run system housekeeping prune (images, containers, build artifacts)

### `system export`

```
ninedeploy system export [options] [file]
```

Export the full system state as JSON

### `system import`

```
ninedeploy system import [options] <file>
```

Import a system bundle (destructive)

### `system panel-backup`

```
ninedeploy system panel-backup [options] [command]
```

Scheduled, passphrase-sealed backups of the panel's own state

## `env`

```
ninedeploy env [options] [command]
```

Manage service environment variables

### `env list`

```
ninedeploy env list [options] <serviceId>
```

List a service's env vars

| Option | Description |
|---|---|
| `--preview` | Target the preview-only set: values only this service's PR previews receive |

### `env set`

```
ninedeploy env set [options] <serviceId> <key> <value>
```

Create or update an env var (secret by default)

| Option | Description |
|---|---|
| `--public` | Store as a plain (non-secret) value |
| `--preview` | Target the preview-only set: values only this service's PR previews receive |

### `env rm`

```
ninedeploy env rm [options] <serviceId> <key>
```

Remove an env var by key

| Option | Description |
|---|---|
| `--preview` | Target the preview-only set: values only this service's PR previews receive |

## `domains`

```
ninedeploy domains [options] [command]
```

Manage domains & routing

### `domains list`

```
ninedeploy domains list [options]
```

List all domains

### `domains add`

```
ninedeploy domains add [options] <serviceId> <host>
```

Route a hostname to a service

| Option | Description |
|---|---|
| `-p, --path <path>` | Path prefix (default: "/") |
| `--no-ssl` | Serve over plain HTTP (no TLS) |

### `domains rm`

```
ninedeploy domains rm [options] <serviceId> <domainId>
```

Remove a domain

### `domains verify`

```
ninedeploy domains verify [options] <serviceId> <domainId>
```

Check a pending domain TXT ownership challenge and bring it live

### `domains transfer`

```
ninedeploy domains transfer [options] <domainId>
```

Start a domain transfer to a target email; prints an accept URL

| Option | Description |
|---|---|
| `--to <email>` | Email of the target user (existing or future) |

### `domains preview-transfer`

```
ninedeploy domains preview-transfer [options] <token>
```

Preview a pending transfer by token (no auth required)

### `domains accept-transfer`

```
ninedeploy domains accept-transfer [options] <token>
```

Accept a transfer as the target user; the domain moves to the given service

| Option | Description |
|---|---|
| `--service-id <id>` | Target service id (must be one the caller can admin) |

### `domains cancel-transfer`

```
ninedeploy domains cancel-transfer [options] <token>
```

Cancel a pending transfer (source user or instance operator only)

### `domains preset`

```
ninedeploy domains preset [options] [command]
```

Manage DNS presets (IDomainProvider automation)

## `config-preset`

```
ninedeploy config-preset [options] [command]
```

Manage named configCenter bundles that can be re-applied to a fresh instance

### `config-preset list`

```
ninedeploy config-preset list [options]
```

List every registered preset id

### `config-preset get`

```
ninedeploy config-preset get [options] <id>
```

Show a preset's values and description

### `config-preset register`

```
ninedeploy config-preset register [options] <id>
```

Register a preset from a JSON values file (key → value object)

| Option | Description |
|---|---|
| `-f, --file <file>` | JSON file with key → value pairs (required, validated inside the action) |
| `-d, --description <text>` | Optional human description (max 500 chars) |

### `config-preset apply`

```
ninedeploy config-preset apply [options] <id>
```

Write every value in the preset to configCenter (idempotent)

| Option | Description |
|---|---|
| `--override <json>` | Inline JSON object of one-shot overrides for this call only |

### `config-preset remove`

```
ninedeploy config-preset remove [options] <id>
```

Unregister a preset (does NOT undo the live apply)

## `metrics`

```
ninedeploy metrics [options] [command]
```

Resource monitoring and kernel event history

### `metrics settings`

```
ninedeploy metrics settings [options]
```

Resource retention, Prometheus and collector settings

### `metrics configure`

```
ninedeploy metrics configure [options]
```

Update resource monitoring settings

| Option | Description |
|---|---|
| `--retention-days <days>` | Service history retention, 1–90 days |
| `--prometheus <on\|off>` | Enable or disable authenticated Prometheus scraping |
| `--otlp-endpoint <url>` | OTLP/HTTP JSON metrics endpoint, empty disables export |
| `--otlp-authorization-env <name>` | Read collector Authorization from this environment variable |
| `--clear-otlp-authorization` | Remove the saved collector credential |
| `--log-queue-mb <mb>` | Encrypted log payload limit per destination, 1–256 MiB |

### `metrics show`

```
ninedeploy metrics show [options]
```

Show the active backend, events, and last flush marker

### `metrics flush`

```
ninedeploy metrics flush [options]
```

Run the built-in backend retention sweep

## `log-drains`

```
ninedeploy log-drains [options] [command]
```

Inspect and recover durable log delivery

### `log-drains queue`

```
ninedeploy log-drains queue [options] <id>
```

Show pending, blocked and paused log delivery

### `log-drains retry`

```
ninedeploy log-drains retry [options] <id>
```

Schedule pending logs for the next delivery cycle

### `log-drains discard`

```
ninedeploy log-drains discard [options] <id>
```

Permanently discard pending logs

| Option | Description |
|---|---|
| `--yes` | Confirm permanent removal of queued logs |

## `build-cache`

```
ninedeploy build-cache [options] [command]
```

Build cache plugin — per-backend LRU stats (G-01)

### `build-cache stats`

```
ninedeploy build-cache stats [options]
```

Show per-backend cache counters and the merged totals

## `branding`

```
ninedeploy branding [options] [command]
```

Override the panel logo, color, support email and footer (G-30)

### `branding get`

```
ninedeploy branding get [options]
```

Show the current branding overrides

### `branding set`

```
ninedeploy branding set [options]
```

Override one or more branding fields

| Option | Description |
|---|---|
| `--logo-url <url>` | Logo URL (use --logo-url="" to clear) |
| `--primary-color <hex>` | Primary color (hex code, e.g. #1d4ed8) |
| `--support-email <addr>` | Support email shown in the help menu |
| `--footer-html <html>` | Custom footer HTML for the sign-in page |

## `ips`

```
ninedeploy ips [options] [command]
```

Manage this server's IP addresses: label, primary, dedicate to a service

### `ips list`

```
ninedeploy ips list [options]
```

List the IP addresses of the panel host

### `ips set`

```
ninedeploy ips set [options] <ip>
```

Label an address, make it primary, or dedicate it to a service

| Option | Description |
|---|---|
| `--label <text>` | A label ("" clears it) |
| `--primary` | Make it the primary address |
| `--service <id>` | Dedicate it to a docker service on the panel host |
| `--shared` | Share it again (undo --service) |

### `ips forget`

```
ninedeploy ips forget [options] <ip>
```

Forget what was saved about an address

## `egress`

```
ninedeploy egress [options] [command]
```

Manage per-project outbound IP rules (G-15)

### `egress list`

```
ninedeploy egress list [options]
```

Show every egress IP rule across every registered driver

### `egress set`

```
ninedeploy egress set [options] <projectId> <ip>
```

Attach a stable outbound IP to a project (e.g. after creating a VPS)

| Option | Description |
|---|---|
| `--driver <name>` | Target a specific driver (default: first registered) |

### `egress clear`

```
ninedeploy egress clear [options] <projectId>
```

Detach the egress rule for a project

| Option | Description |
|---|---|
| `--driver <name>` | Target a specific driver (default: first registered) |

## `import`

```
ninedeploy import [options] [command]
```

Move from Coolify, Dokploy, CapRover or Heroku: plan (read-only), apply, data, cutover

### `import plan`

```
ninedeploy import plan [options] <source>
```

Read a coolify | dokploy | caprover panel, or a Heroku app's app.json and Procfile, and print what NineDeploy would create. Nothing is created or changed. The credential comes from NINEDEPLOY_IMPORT_TOKEN (Coolify, Dokploy) or NINEDEPLOY_IMPORT_PASSWORD (CapRover, plus NINEDEPLOY_IMPORT_OTP), or a hidden prompt; Heroku needs none.

| Option | Description |
|---|---|
| `--url <url>` | The source panel (e.g. https://coolify.example.com), or for heroku the app's git repository |
| `--dir <path>` | heroku: a checkout of the repository holding app.json / Procfile (default: .) |
| `--branch <branch>` | heroku: the branch NineDeploy deploys (default: main) |
| `--app <name>` | heroku: the Heroku app name, for the pg:backups command |
| `--json` | Print the plan as JSON |
| `--out <file>` | Also write the plan (JSON, names only) to a file |

### `import apply`

```
ninedeploy import apply [options] <plan>
```

Create the services and databases of a saved plan (import plan --out) on this panel. Without --yes it only shows what it would create. Never deploys and never adds a domain; keeps a resumable receipt next to the plan.

| Option | Description |
|---|---|
| `--yes` | Create them |
| `--project <id>` | Tag every created service and database with this project |
| `--dotenv <service=path>` | Environment values for a service, from a .env file (repeatable) (default: []) |
| `--receipt <file>` | Receipt file (default: <plan>.receipt.json) |

### `import data`

```
ninedeploy import data [options] <plan>
```

Move database contents into the databases import apply created. Without --yes it prints the cutover order and the dump command to run on the source host for each database.

| Option | Description |
|---|---|
| `--dump <database=file>` | A dump to import into that database (repeatable); its sha256 is checked by the panel (default: []) |
| `--volume <service=file>` | A gzipped tar of that service's data volume (repeatable); restored after a snapshot of what is there (default: []) |
| `--yes` | Import the dumps and archives |
| `--receipt <file>` | Receipt file (default: <plan>.receipt.json) |

### `import cutover`

```
ninedeploy import cutover [options] <plan>
```

Add the planned domains once each service runs a successful deploy and the hostname's DNS already points at this panel. Without --yes it only reports what is ready.

| Option | Description |
|---|---|
| `--yes` | Add (or verify) the domains that pass |
| `--expect <address>` | The address DNS must point at (repeatable; default: Settings → DNS records) (default: []) |
| `--resolver <ip>` | DNS server to query (default: the system's) |
| `--skip-dns-check <host>` | Skip the DNS check for a proxied host (repeatable). For a domain still to be added or verified it is refused while the Cloudflare integration is on; an attached route is only reported (default: []) |
| `--receipt <file>` | Receipt file (default: <plan>.receipt.json) |

## `sso`

```
ninedeploy sso [options] [command]
```

Manage OIDC / SAML SSO providers (G-22)

### `sso list`

```
ninedeploy sso list [options]
```

List every configured provider

### `sso add`

```
ninedeploy sso add [options] <oidc|saml> <name>
```

Register a new OIDC or SAML provider (config flags become the config_json blob)

| Option | Description |
|---|---|
| `--issuer <url>` | OIDC issuer URL (OIDC only) |
| `--client-id <id>` | OIDC client id (OIDC only) |
| `--client-secret <secret>` | OIDC client secret (OIDC only) |
| `--redirect-uri <uri>` | OIDC redirect URI (OIDC only) |
| `--metadata-url <url>` | SAML IdP metadata URL (SAML only) |

### `sso remove`

```
ninedeploy sso remove [options] <id>
```

Remove a provider by id

## `volumes`

```
ninedeploy volumes [options] [command]
```

Manage Docker volumes

### `volumes files`

```
ninedeploy volumes files [options] <name> [path]
```

List files inside a managed volume

| Option | Description |
|---|---|
| `--server <id>` | Read this node instead of the panel host |
| `--json` | Print raw JSON |

### `volumes read`

```
ninedeploy volumes read [options] <name> <path>
```

Read exact file bytes from a managed volume

| Option | Description |
|---|---|
| `--server <id>` | Read this node instead of the panel host |
| `--output <file>` | Save to a local file instead of stdout |
| `--force` | Overwrite an existing output file |

### `volumes write`

```
ninedeploy volumes write [options] <name> <path>
```

Write a local file into a managed volume (maximum 1 MiB)

| Option | Description |
|---|---|
| `--file <file>` | Local input file |
| `--server <id>` | Write this node instead of the panel host |

### `volumes mkdir`

```
ninedeploy volumes mkdir [options] <name> <path>
```

Create a directory inside a managed volume

| Option | Description |
|---|---|
| `--server <id>` | Use this node instead of the panel host |

### `volumes delete-file`

```
ninedeploy volumes delete-file [options] <name> <path>
```

Delete a file or directory inside a volume, with confirmation

| Option | Description |
|---|---|
| `--server <id>` | Use this node instead of the panel host |
| `--yes` | Confirm this exact path without prompting |

### `volumes list`

```
ninedeploy volumes list [options]
```

List all volumes

| Option | Description |
|---|---|
| `--server <id>` | A node's volumes instead of the panel host's |

### `volumes rm`

```
ninedeploy volumes rm [options] <name>
```

Delete a volume (with confirmation)

| Option | Description |
|---|---|
| `--server <id>` | Delete it on this node |

### `volumes create`

```
ninedeploy volumes create [options] <name>
```

Create a managed volume (nd-svc-* / nd-db-*) on the panel host or a node

| Option | Description |
|---|---|
| `--server <id>` | Create it on this node |

## `networks`

```
ninedeploy networks [options] [command]
```

Manage Docker networks

### `networks list`

```
ninedeploy networks list [options]
```

List user-defined networks

### `networks create`

```
ninedeploy networks create [options] <name> [driver]
```

Create a network (bridge|overlay)

### `networks rm`

```
ninedeploy networks rm [options] <name>
```

Delete a network (with confirmation)

## `sessions`

```
ninedeploy sessions [options] [command]
```

Manage your active sessions

### `sessions list`

```
ninedeploy sessions list [options]
```

List active sessions

### `sessions revoke`

```
ninedeploy sessions revoke [options] <id>
```

Revoke a session

## `backups`

```
ninedeploy backups [options] [command]
```

Manage database backups

### `backups list`

```
ninedeploy backups list [options] [databaseId]
```

List backups (all, or one database's)

### `backups create`

```
ninedeploy backups create [options] <databaseId>
```

Back a database up now

### `backups restore`

```
ninedeploy backups restore [options] <databaseId> <backupId>
```

Restore a backup (destructive)

### `backups drill`

```
ninedeploy backups drill [options] <databaseId> <backupId>
```

Smoke-test a backup without restoring it into a live database

| Option | Description |
|---|---|
| `--restore-query <query>` | Restore into an isolated helper of the database engine and run this query there (SQL, a mongosh script, a Meilisearch API path, one rabbitmqctl list command, or one Redis command per line; database admin) |
| `--expect <value>` | The exact output --restore-query must print (no headers; psql: \| between columns, MySQL/MariaDB/ClickHouse: a tab, mongosh: its printed result, Meilisearch: the JSON body, RabbitMQ: a tab between columns, rows in any order, Redis: one line per value) |
| `--no-wait` | Return once the restore verification is admitted, without waiting for its verdict |

### `backups drills`

```
ninedeploy backups drills [options] <databaseId>
```

List recent backup drills for a database

## `alerts`

```
ninedeploy alerts [options] [command]
```

Manage alert rules

### `alerts list`

```
ninedeploy alerts list [options]
```

List alert rules

### `alerts create`

```
ninedeploy alerts create [options] <name> <metric> <operator> <threshold>
```

Create an alert rule (metric: cpu|memory|cert-expiry|disk|server_offline, operator: > or <)

| Option | Description |
|---|---|
| `-w, --windows <n>` | Consecutive 30s samples before firing (default: "1") |
| `-s, --service <id>` | Scope to a service (default: host-wide) |

### `alerts rm`

```
ninedeploy alerts rm [options] <id>
```

Delete an alert rule

## `notifications`

```
ninedeploy notifications [options] [command]
```

Manage notification channels (admin)

### `notifications list`

```
ninedeploy notifications list [options]
```

List configured channels

### `notifications create-webhook`

```
ninedeploy notifications create-webhook [options] <name> <url>
```

Create a webhook channel (HMAC-signed POST; G-06)

| Option | Description |
|---|---|
| `--secret <s>` | HMAC secret used to sign the body |
| `--header <h>` | Signature header name (default: X-NineDeploy-Signature) |
| `--algo <algo>` | Hash algorithm: sha256 (default) or sha1 (default: "sha256") |
| `--event-filter <prefix>` | Comma-separated event prefixes to match (default: all) |
| `--template <kv>` | Body template field (key=value, repeatable) |

### `notifications create-fcm`

```
ninedeploy notifications create-fcm [options] <name> <deviceToken>
```

Create an FCM push channel (Firebase Cloud Messaging HTTP v1; G-22)

| Option | Description |
|---|---|
| `--service-account <file>` | Path to a Firebase service account JSON file |

### `notifications test`

```
ninedeploy notifications test [options] <id>
```

Fire a test event through the channel

### `notifications rm`

```
ninedeploy notifications rm [options] <id>
```

Remove a channel

## `users`

```
ninedeploy users [options]
```

List users (admin)

## `reset-link`

```
ninedeploy reset-link [options] <idOrEmail>
```

Generate a one-time password reset link (admin)

## `activity`

```
ninedeploy activity [options]
```

Show recent activity

## `plugins`

```
ninedeploy plugins [options] [command]
```

Manage plugins and marketplace extensions

### `plugins list`

```
ninedeploy plugins list [options]
```

List all installed plugins

### `plugins marketplace`

```
ninedeploy plugins marketplace [options]
```

Browse verified marketplace extensions

### `plugins marketplace-refresh`

```
ninedeploy plugins marketplace-refresh [options]
```

Bypass the cache and re-fetch the live signed marketplace index

### `plugins inspect`

```
ninedeploy plugins inspect [options] <id>
```

Inspect plugin manifest and runtime telemetry

### `plugins install`

```
ninedeploy plugins install [options] <target>
```

Install a plugin (marketplace, sandbox)

| Option | Description |
|---|---|
| `-s, --source <source>` | Source type (marketplace, sandbox) (default: "marketplace") |
| `-n, --name <name>` | Custom display name |
| `-v, --version <version>` | Custom version |
| `-d, --desc <description>` | Description |

### `plugins enable`

```
ninedeploy plugins enable [options] <id>
```

Enable an installed plugin

### `plugins disable`

```
ninedeploy plugins disable [options] <id>
```

Disable a plugin

### `plugins reload`

```
ninedeploy plugins reload [options] <id>
```

Hot-reload a plugin

### `plugins uninstall`

```
ninedeploy plugins uninstall [options] <id>
```

Uninstall a plugin

## `config-center`

```
ninedeploy config-center [options] [command]
```

Manage central configuration entries and secrets

### `config-center list`

```
ninedeploy config-center list [options]
```

List configuration entries

| Option | Description |
|---|---|
| `-c, --category <category>` | Filter by category |
| `-p, --plugin <pluginId>` | Filter by plugin id |
| `-r, --reveal` | Reveal decrypted secrets (admin only) |

### `config-center get`

```
ninedeploy config-center get [options] <key>
```

Get a configuration key in detail

### `config-center set`

```
ninedeploy config-center set [options] <key> <value>
```

Set or update a configuration key

| Option | Description |
|---|---|
| `-s, --secret` | Mark as encrypted secret |
| `-d, --desc <description>` | Description |
| `-t, --tags <tags>` | Comma-separated tags |

### `config-center delete`

```
ninedeploy config-center delete [options] <key>
```

Delete a custom configuration key

## `workspaces`

```
ninedeploy workspaces [options] [command]
```

Manage workspaces and team organizations

### `workspaces list`

```
ninedeploy workspaces list [options]
```

List accessible workspaces

### `workspaces get`

```
ninedeploy workspaces get [options] <id>
```

Get workspace details and team members

### `workspaces create`

```
ninedeploy workspaces create [options] <name>
```

Create a new workspace

| Option | Description |
|---|---|
| `-d, --desc <description>` | Workspace description |

### `workspaces delete`

```
ninedeploy workspaces delete [options] <id>
```

Delete a workspace

## `images`

```
ninedeploy images [options] [command]
```

Inspect and prune Docker images on the host

### `images ls`

```
ninedeploy images ls [options]
```

List every image on the host with size / age / in-use metadata

| Option | Description |
|---|---|
| `--sort <field>` | Sort by `size` (default) or `age` (default: "size") |

### `images prune`

```
ninedeploy images prune [options]
```

Prune images. Refuses to run with no filter; pass --dry-run first.

| Option | Description |
|---|---|
| `--keep-last <n>` | Keep the newest N images per repo:tag (rest are candidates) |
| `--older-than <hours>` | Only prune images older than N hours |
| `--dangling` | Only prune dangling images (repo/tag both <none>) |
| `--dry-run` | Report what would be deleted without actually deleting |

## `demo`

```
ninedeploy demo [options] [command]
```

Demo mode operations

### `demo seed`

```
ninedeploy demo seed [options]
```

Seed Next.js Docker + PM2 demo environment with PostgreSQL database

## `server`

```
ninedeploy server [options] [command]
```

Manage local NineDeploy Docker server

### `server start`

```
ninedeploy server start [options]
```

Start local NineDeploy server container

| Option | Description |
|---|---|
| `-p, --port <port>` | Host port to bind (default: "3000") |
| `-i, --image <image>` | Docker image tag (default: "ghcr.io/ninedeploy/ninedeploy:latest") |
| `-n, --name <name>` | Container name (default: "ninedeploy") |

### `server stop`

```
ninedeploy server stop [options]
```

Stop local NineDeploy server container

| Option | Description |
|---|---|
| `-n, --name <name>` | Container name (default: "ninedeploy") |

### `server status`

```
ninedeploy server status [options]
```

Check local server container and health status

| Option | Description |
|---|---|
| `-p, --port <port>` | Host port (default: "3000") |
| `-n, --name <name>` | Container name (default: "ninedeploy") |

### `server logs`

```
ninedeploy server logs [options]
```

View local server container logs

| Option | Description |
|---|---|
| `-n, --lines <lines>` | Number of lines to show (default: "50") |
| `-c, --name <name>` | Container name (default: "ninedeploy") |

## `logs`

```
ninedeploy logs [options] [command]
```

Search the configured log drain (Loki)

### `logs search`

```
ninedeploy logs search [options] <query>
```

Full-text search across the configured Loki drain

| Option | Description |
|---|---|
| `--service <id>` | Restrict to one service id |
| `--since <window>` | How far back to search (e.g. 15m, 2h, 1d) (default: "15m") |
| `--limit <n>` | Max lines to return (default 200, max 1000) |
| `--drain <id>` | Query a specific drain (default: first enabled Loki drain) |
| `--json` | Print raw JSON instead of the human-readable table |

### `logs analyze`

```
ninedeploy logs analyze [options] <service>
```

0.16.15: the configured AI provider reads the service's newest runtime logs: health, problems, next steps

| Option | Description |
|---|---|
| `--tail <n>` | How many of the newest lines to read (20-5000, default 300) |
| `--json` | Print raw JSON |

## `email-templates`

```
ninedeploy email-templates [options] [command]
```

Manage per-workspace email template overrides

### `email-templates list`

```
ninedeploy email-templates list [options] <workspaceId>
```

List the built-in templates and whether the workspace has overridden each

### `email-templates preview`

```
ninedeploy email-templates preview [options] <workspaceId> <name> [vars...]
```

Render a template with the supplied vars (key=value pairs)

### `email-templates set`

```
ninedeploy email-templates set [options] <workspaceId> <name>
```

Upsert the workspace override for a template (admin only)

| Option | Description |
|---|---|
| `--subject <subject>` | Override subject line |
| `--text <text>` | Override plain-text body (use {{var}} placeholders) |

### `email-templates reset`

```
ninedeploy email-templates reset [options] <workspaceId> <name>
```

Drop the workspace override and fall back to the built-in default

## `certificates`

```
ninedeploy certificates [options] [command]
```

Traefik certificate inventory and renewal status

### `certificates list`

```
ninedeploy certificates list [options]
```

List every certificate the panel knows about with days-to-expiry and status

| Option | Description |
|---|---|
| `--threshold <days>` | Expiring-soon threshold in days (default 30) |

### `certificates expiring`

```
ninedeploy certificates expiring [options]
```

Focused list of certificates expiring within N days

| Option | Description |
|---|---|
| `--days <days>` | Window in days (default 30) |

### `certificates custom`

```
ninedeploy certificates custom [options] [command]
```

Uploaded TLS certificates (operator)

## `proxy`

```
ninedeploy proxy [options] [command]
```

Traefik proxy management (operator)

### `proxy config`

```
ninedeploy proxy config [options] [command]
```

Custom Traefik dynamic config (custom.yml)

## `secrets`

```
ninedeploy secrets [options] [command]
```

Deploy-time secret references

### `secrets providers`

```
ninedeploy secrets providers [options] [command]
```

HashiCorp Vault / OpenBao and AWS Secrets Manager (operator)

## `terminals`

```
ninedeploy terminals [options] [command]
```

Terminal session history and termination (operator)

### `terminals list`

```
ninedeploy terminals list [options]
```

List terminal sessions, newest first (metadata only)

| Option | Description |
|---|---|
| `--status <status>` | pending \| active \| ended \| failed \| expired |
| `--target <kind>` | service \| database \| container \| host |
| `--limit <n>` | Page size (1-200, default 50) |
| `--before <id>` | Page back from this session id |

### `terminals show`

```
ninedeploy terminals show [options] <id>
```

Show one terminal session

### `terminals kill`

```
ninedeploy terminals kill [options] <id>
```

Terminate a live session (or revoke a pending one)

| Option | Description |
|---|---|
| `-y, --yes` | Skip the confirmation prompt |

## `terminal`

```
ninedeploy terminal|shell [options] [command]
```

Open an interactive shell (operator; needs a TTY)

Can also be called as `ninedeploy shell`.

### `terminal service`

```
ninedeploy terminal service [options] <id>
```

Shell into the container of a service

| Option | Description |
|---|---|
| `--replica <n>` | Replica number (1-based) |
| `--node <serverId>` | A node the service runs on (fan-out target) |

### `terminal db`

```
ninedeploy terminal db [options] <id>
```

Shell into the container of a database

| Option | Description |
|---|---|
| `--client` | Open the engine client (psql, mysql, redis-cli) with the stored credentials |

### `terminal container`

```
ninedeploy terminal container [options] <name>
```

Shell into a managed container on the panel host

### `terminal host`

```
ninedeploy terminal host [options] [serverId]
```

Root shell on the panel host or a node (off by default; asks for your password)

## `tunnel`

```
ninedeploy tunnel [options] [command]
```

Reach a database or a service port through the panel on a local port (G5.8)

### `tunnel db`

```
ninedeploy tunnel db [options] <id>
```

Offer a panel-host database on a local port; its port stays closed to the internet (database admin)

| Option | Description |
|---|---|
| `--port <n>` | Local port (default: the engine port when free, else any free one; 0 picks one) |
| `--bind <address>` | Local address to listen on (default 127.0.0.1) |

### `tunnel service`

```
ninedeploy tunnel service [options] <id>
```

Offer a port of a panel-host docker service on a local port, past its domains (service admin)

| Option | Description |
|---|---|
| `--target <port>` | Container port (default: the service port) |
| `--replica <n>` | Replica to reach (default 1) |
| `--port <n>` | Local port (default: the container port when free, else any free one; 0 picks one) |
| `--bind <address>` | Local address to listen on (default 127.0.0.1) |

## `traffic`

```
ninedeploy traffic [options] [command]
```

Traffic analytics (opt-in)

### `traffic settings`

```
ninedeploy traffic settings [options]
```

Show or change traffic analytics (enabling or disabling recreates Traefik once)

| Option | Description |
|---|---|
| `--enable` | Turn analytics on |
| `--disable` | Turn analytics off |
| `--retention <days>` | Keep hourly rows this many days (1-400) |
| `-y, --yes` | Skip the confirmation prompt |

### `traffic summary`

```
ninedeploy traffic summary [options]
```

Instance traffic: totals, percentiles and top domains (operator)

| Option | Description |
|---|---|
| `--range <range>` | 1h \| 24h \| 7d \| 30d (default 24h) |
| `--top <n>` | Top domains (1-50, default 10) |

### `traffic service`

```
ninedeploy traffic service [options] <id>
```

Traffic of one service, by domain

| Option | Description |
|---|---|
| `--range <range>` | 1h \| 24h \| 7d \| 30d (default 24h) |

## `access`

```
ninedeploy access [options] [command]
```

Project and environment access grants

### `access grants`

```
ninedeploy access grants [options] [command]
```

Manage access grants in a workspace (workspace admin)

### `access me`

```
ninedeploy access me [options]
```

Your own grants and guest workspaces

## `servers`

```
ninedeploy servers [options] [command]
```

Remote nodes: agent capabilities, build-server role (operator)

### `servers list`

```
ninedeploy servers list [options]
```

List nodes with their agent version, build role, databases and Swarm membership

### `servers roles`

```
ninedeploy servers roles [options] <id>
```

Set the build-server role of a node

| Option | Description |
|---|---|
| `--build-server <onOff>` | on \| off |
| `--build-concurrency <n>` | Builds at once on this node (1-8) |

## `swarm`

```
ninedeploy swarm [options] [command]
```

Docker Swarm on the panel host (operator, opt-in per service)

### `swarm status`

```
ninedeploy swarm status [options]
```

Swarm state, the join address and the nodes

### `swarm init`

```
ninedeploy swarm init [options]
```

Initialise Swarm on the panel host (asks for your password)

| Option | Description |
|---|---|
| `--advertise-addr <ip>` | The address nodes reach the panel host on |

### `swarm enable`

```
ninedeploy swarm enable [options]
```

Allow Swarm deploys (asks for your password)

### `swarm disable`

```
ninedeploy swarm disable [options]
```

Refuse new Swarm deploys; running stacks keep running

### `swarm join`

```
ninedeploy swarm join [options] <serverId>
```

Join a node to the swarm as a worker

### `swarm leave`

```
ninedeploy swarm leave [options] <serverId>
```

Drain a node and take it out of the swarm

| Option | Description |
|---|---|
| `-y, --yes` | Skip the confirmation prompt |

## `monitors`

```
ninedeploy monitors|monitor [options] [command]
```

Uptime monitors: HTTP(S) and TCP checks with up/down alerts

Can also be called as `ninedeploy monitor`.

### `monitors list`

```
ninedeploy monitors list [options]
```

List monitors with their status and uptime

| Option | Description |
|---|---|
| `--service <idOrSlug>` | Only the monitors of this service |
| `--json` | Print raw JSON instead of the table |

### `monitors add`

```
ninedeploy monitors add [options] <name> <target>
```

Add a monitor (operator): an http(s):// URL, or host:port for a TCP check

| Option | Description |
|---|---|
| `--tcp` | TCP connect check (the default for a host:port target) |
| `--service <idOrSlug>` | Attach it to a service (its members can see it) |
| `--interval <seconds>` | Seconds between checks (30-3600, default 60) |
| `--timeout <seconds>` | Seconds before a check fails (1-60, default 10) |
| `--failures <n>` | Failed checks in a row before it is down (1-10, default 2) |
| `--expect <codes>` | Accepted HTTP status codes, e.g. 200-299,301 (default 200-399) |
| `--keyword <text>` | Text the response body must contain |
| `--head` | Send HEAD instead of GET |
| `--no-follow-redirects` | Do not follow redirects |
| `--insecure` | Accept a self-signed or expired certificate |
| `--disabled` | Create it paused |

### `monitors show`

```
ninedeploy monitors show [options] <id>
```

Monitor details and the last 10 checks

| Option | Description |
|---|---|
| `--json` | Print raw JSON |

### `monitors check`

```
ninedeploy monitors check [options] <id>
```

Run a check now (operator)

### `monitors pause`

```
ninedeploy monitors pause [options] <id>
```

Stop checking (operator)

### `monitors resume`

```
ninedeploy monitors resume [options] <id>
```

Start checking again (operator)

### `monitors rm`

```
ninedeploy monitors rm|remove [options] <id>
```

Delete a monitor and its history (operator)

| Option | Description |
|---|---|
| `-y, --yes` | Skip the confirmation prompt |

## `status-pages`

```
ninedeploy status-pages|status-page [options] [command]
```

Public status pages showing a set of monitors (operator)

Can also be called as `ninedeploy status-page`.

### `status-pages list`

```
ninedeploy status-pages list [options]
```

List status pages with their public URL

| Option | Description |
|---|---|
| `--json` | Print raw JSON instead of the table |

### `status-pages add`

```
ninedeploy status-pages add [options] <slug> <title>
```

Create a status page (unpublished unless --publish)

| Option | Description |
|---|---|
| `--monitor <id...>` | Monitors to show, in order |
| `--publish` | Publish it right away |

### `status-pages publish`

```
ninedeploy status-pages publish [options] <id>
```

Make the page public

### `status-pages unpublish`

```
ninedeploy status-pages unpublish [options] <id>
```

Take the page offline (404)

### `status-pages notice`

```
ninedeploy status-pages notice [options] <id> [text]
```

Set the notice shown at the top (maintenance, an incident)

| Option | Description |
|---|---|
| `--clear` | Remove the notice |

### `status-pages rm`

```
ninedeploy status-pages rm|remove [options] <id>
```

Delete a status page

| Option | Description |
|---|---|
| `-y, --yes` | Skip the confirmation prompt |

## `canary`

```
ninedeploy canary [options] [command]
```

Canary releases: shift traffic to a new release in steps

### `canary show`

```
ninedeploy canary show [options] <service>
```

The canary configuration and the canary running now

| Option | Description |
|---|---|
| `--json` | Print raw JSON |

### `canary set`

```
ninedeploy canary set [options] <service>
```

Turn canary releases on or change them (docker services); options not given keep their value

| Option | Description |
|---|---|
| `--steps <list>` | Percent of requests per step, rising, 1-99, up to 5 (default 10,50) |
| `--step-seconds <n>` | Seconds per step (30-3600, default 120) |
| `--max-error-rate <percent>` | Highest share of 5xx responses the new release may have (default 5) |
| `--max-p95 <ms>` | Highest p95 response time in ms, or off (default off) |
| `--min-requests <n>` | Fewer requests in a step are not judged (default 20) |
| `--json` | Print the stored configuration as JSON |

### `canary off`

```
ninedeploy canary off [options] <service>
```

Turn canary releases off

### `canary promote`

```
ninedeploy canary promote [options] <service>
```

Skip the remaining steps and send all traffic to the new release now

| Option | Description |
|---|---|
| `--deployment <id>` | The deployment to promote (default: the one running) |

## `autoscale`

```
ninedeploy autoscale [options] [command]
```

Autoscaling: run between a minimum and a maximum number of containers, set by load

### `autoscale show`

```
ninedeploy autoscale show [options] <service>
```

The autoscaling configuration and what it is doing now

| Option | Description |
|---|---|
| `--json` | Print raw JSON |

### `autoscale set`

```
ninedeploy autoscale set [options] <service>
```

Turn autoscaling on or change it (docker services); options not given keep their value

| Option | Description |
|---|---|
| `--min <n>` | Containers it never goes below (1-10, default 1) |
| `--max <n>` | Containers it never goes above (2-10, above --min; required to turn it on) |
| `--metric <metric>` | cpu, memory or rps (default cpu) |
| `--target <value>` | Value per container to keep near: percent for cpu/memory, requests per second for rps (required to turn it on) |
| `--up-seconds <n>` | How long the need must last before adding containers (30-3600, default 60) |
| `--down-seconds <n>` | How long the need must last before removing containers (60-3600, default 300) |
| `--json` | Print the stored configuration as JSON |

### `autoscale off`

```
ninedeploy autoscale off [options] <service>
```

Turn autoscaling off

## `sleep`

```
ninedeploy sleep [options] [command]
```

Scale to zero: stop an idle service and wake it on the next request

### `sleep show`

```
ninedeploy sleep show [options] <service>
```

When the service sleeps, and whether it is asleep now

| Option | Description |
|---|---|
| `--json` | Print raw JSON |

### `sleep set`

```
ninedeploy sleep set [options] <service> <minutes>
```

Sleep after this many minutes without a request (5-1440; docker services on the panel host)

### `sleep off`

```
ninedeploy sleep off [options] <service>
```

Never sleep

### `sleep now`

```
ninedeploy sleep now [options] <service>
```

Put the service to sleep now

### `sleep wake`

```
ninedeploy sleep wake [options] <service>
```

Wake a sleeping service

## `previews`

```
ninedeploy previews [options] [command]
```

PR preview settings of a git-backed service

### `previews show`

```
ninedeploy previews show [options] <service>
```

The PR preview settings, including database copies

| Option | Description |
|---|---|
| `--json` | Print raw JSON |

### `previews database-copies`

```
ninedeploy previews database-copies [options] <service> <onOff>
```

Give each preview its own database copies (PostgreSQL and the Redis family): on | off

### `previews forks`

```
ninedeploy previews forks [options] <service> <onOff>
```

Build pull requests from forks too, each deploy held for approval: on | off

## `lanes`

```
ninedeploy lanes [options] [command]
```

Deployment lanes (production, staging, …) and their protection

### `lanes list`

```
ninedeploy lanes list [options]
```

Lanes with their service count and switches

| Option | Description |
|---|---|
| `--json` | Print raw JSON |

### `lanes protect`

```
ninedeploy lanes protect [options] <lane> <onOff>
```

Keep the lane's variable values, logs and shells for workspace admins: on | off (admin)

### `lanes require-approval`

```
ninedeploy lanes require-approval [options] <lane> <onOff>
```

Make every deploy into the lane wait for a workspace admin: on | off (admin)

## `approvals`

```
ninedeploy approvals [options] [command]
```

Deploys waiting for an admin's approval

### `approvals list`

```
ninedeploy approvals list [options]
```

Deploys waiting for approval that you can see

| Option | Description |
|---|---|
| `--json` | Print raw JSON |

### `approvals approve`

```
ninedeploy approvals approve [options] <service>
```

Let a waiting deploy build

| Option | Description |
|---|---|
| `--deployment <id>` | The deployment (default: the service's oldest waiting deploy) |

### `approvals reject`

```
ninedeploy approvals reject [options] <service>
```

Turn a waiting deploy down; it will not run

| Option | Description |
|---|---|
| `--deployment <id>` | The deployment (default: the service's oldest waiting deploy) |

## `ci`

```
ninedeploy ci [options] [command]
```

CI pipelines, jobs and runners

### `ci runners`

```
ninedeploy ci runners [options] [command]
```

Machines that run CI jobs (operator)

### `ci pipeline`

```
ninedeploy ci pipeline [options] <service>
```

Show the service's pipeline

| Option | Description |
|---|---|
| `--json` | Print raw JSON |

### `ci set`

```
ninedeploy ci set [options] <service> <file>
```

Set the pipeline from a JSON file (service admin)

### `ci jobs`

```
ninedeploy ci jobs [options] <service>
```

The service's latest jobs

| Option | Description |
|---|---|
| `--json` | Print raw JSON |

### `ci run`

```
ninedeploy ci run [options] <service>
```

Run the pipeline now

| Option | Description |
|---|---|
| `--ref <ref>` | A branch or commit (default: the service branch) |
| `--follow` | Print the job's log until it ends; exit non-zero unless it succeeds |

### `ci log`

```
ninedeploy ci log [options] <service> <job>
```

A job's log (its last attempt unless --attempt)

| Option | Description |
|---|---|
| `--attempt <n>` | The attempt number |
| `--follow` | Keep printing until the job ends |

### `ci approve`

```
ninedeploy ci approve [options] <service> <job>
```

Let a job that waits for approval run (service admin)

### `ci cancel`

```
ninedeploy ci cancel [options] <service> <job>
```

Cancel a job; a running attempt is killed

## `doctor`

```
ninedeploy doctor [options]
```

Run system, Docker, server connectivity, and auth diagnostics

| Option | Description |
|---|---|
| `--fix` | Automatically attempt to heal and repair detected issues |

## `sources`

```
ninedeploy sources|creds [options] [command]
```

Manage private repository credentials (PATs / SSH keys)

Can also be called as `ninedeploy creds`.

### `sources list`

```
ninedeploy sources list [options]
```

List configured sources

### `sources show`

```
ninedeploy sources show [options] <id>
```

Show one source in detail

### `sources add`

```
ninedeploy sources add [options] [name]
```

Add a new source (interactive; PAT/SSH key from env or masked prompt)

| Option | Description |
|---|---|
| `--base-url <url>` | Gitea or self-hosted GitLab base URL, e.g. https://git.example.com (enables the live test and repo list) |

### `sources test`

```
ninedeploy sources test [options] [id]
```

Verify that a stored source token still authenticates

### `sources keygen`

```
ninedeploy sources keygen [options] [id]
```

Generate an ed25519 deploy-key pair on the panel and print the public key

### `sources remove`

```
ninedeploy sources remove|rm [options] [id]
```

Remove a source (with confirmation)

### `sources allow-on-nodes`

```
ninedeploy sources allow-on-nodes [options] <id> <onOff>
```

Allow (on, asks for your password) or stop (off) sending this credential to nodes for clones

### `sources pin-host-keys`

```
ninedeploy sources pin-host-keys [options] <id> <onOff>
```

Pin (on) or stop pinning (off, asks for your password) the git host SSH keys of a deploy-key source

### `sources reset-host-keys`

```
ninedeploy sources reset-host-keys [options] <id>
```

Forget the pinned git host keys so the next clone learns them again (asks for your password)

### `sources host-keys`

```
ninedeploy sources host-keys [options] <id>
```

Show the git host key fingerprints a source has pinned

## `github-app`

```
ninedeploy github-app [options] [command]
```

Manage GitHub Apps (one-click setup runs in the panel: Sources → GitHub Apps)

### `github-app list`

```
ninedeploy github-app list [options]
```

List registered GitHub Apps

### `github-app show`

```
ninedeploy github-app show [options] <id>
```

Show a GitHub App and its installations

### `github-app add-manual`

```
ninedeploy github-app add-manual [options]
```

Register an existing GitHub App or one on GitHub Enterprise Server (key from --key-file or NINEDEPLOY_GITHUB_APP_KEY)

| Option | Description |
|---|---|
| `--name <name>` | Display name |
| `--app-id <id>` | GitHub App ID |
| `--key-file <path>` | Path to the App private key (.pem) |
| `--web-base-url <url>` | GHES web URL, e.g. https://github.example.com (with --api-base-url) |
| `--api-base-url <url>` | GHES API URL, e.g. https://github.example.com/api/v3 (with --web-base-url) |

### `github-app sync`

```
ninedeploy github-app sync [options] <id>
```

Sync installations from GitHub (creates their gh-app sources)

### `github-app rotate-key`

```
ninedeploy github-app rotate-key [options] <id>
```

Replace the App private key (verified with GitHub first)

| Option | Description |
|---|---|
| `--key-file <path>` | Path to the new private key (.pem) |

### `github-app remove`

```
ninedeploy github-app remove|rm [options] <id>
```

Forget a GitHub App (its installation sources stay)

| Option | Description |
|---|---|
| `-y, --yes` | Skip the confirmation prompt |

## `deploy`

```
ninedeploy deploy [options] [command]
```

End-to-end deploy helpers

### `deploy create-from-github`

```
ninedeploy deploy create-from-github|from-github [options] [url]
```

One-shot: add source (PAT), analyse repo, create service, set env, trigger deploy, optional webhook

### `deploy up`

```
ninedeploy deploy up [options] [path]
```

Deploy a local folder, .zip or .tar.gz as a service source (no Git repository needed)

| Option | Description |
|---|---|
| `-s, --service <idOrSlug>` | An existing service created without a repository or image |
| `-c, --create <name>` | Create a new docker service for this source |
| `-p, --port <port>` | Container port, with --create |
| `-x, --exclude <pattern...>` | Extra paths to leave out (.git, node_modules, .env… are always left out) |
| `--no-deploy` | Only upload; deploy later |

## `webhooks`

```
ninedeploy webhooks [options] [command]
```

Manage auto-deploy webhooks

### `webhooks list`

```
ninedeploy webhooks list [options] <serviceId>
```

List a service's webhooks

### `webhooks show`

```
ninedeploy webhooks show [options] <serviceId> <hookId>
```

Show one webhook in detail

### `webhooks add`

```
ninedeploy webhooks add [options] <serviceId> [branch]
```

Add a webhook (returns the HMAC secret once for pasting into GitHub)

### `webhooks remove`

```
ninedeploy webhooks remove|rm [options] <serviceId> <hookId>
```

Remove a webhook (with confirmation)

## `firewall`

```
ninedeploy firewall [options] [command]
```

Manage host firewall (UFW) and open ports

### `firewall status`

```
ninedeploy firewall status [options]
```

Show host firewall status, default policies, and active rules

### `firewall enable`

```
ninedeploy firewall enable [options]
```

Enable host firewall (ensures SSH port 22 is permitted)

### `firewall disable`

```
ninedeploy firewall disable [options]
```

Disable host firewall

### `firewall recommended`

```
ninedeploy firewall recommended [options]
```

Apply standard VPS profile (allows 22 SSH, 80 HTTP, 443 HTTPS and enables firewall)

### `firewall allow`

```
ninedeploy firewall allow [options] <port>
```

Open a host port (e.g. 5432 or 8080)

| Option | Description |
|---|---|
| `-p, --proto <proto>` | Protocol (tcp\|udp\|any) (default: "tcp") |
| `-f, --from <ip>` | Source IP/CIDR to restrict access to |
| `-c, --comment <text>` | Rule description/comment |

### `firewall deny`

```
ninedeploy firewall deny [options] <port>
```

Block a host port

| Option | Description |
|---|---|
| `-p, --proto <proto>` | Protocol (tcp\|udp\|any) (default: "tcp") |
| `-f, --from <ip>` | Source IP/CIDR |
| `-c, --comment <text>` | Rule description/comment |

### `firewall rm`

```
ninedeploy firewall rm [options] <id>
```

Delete a firewall rule by ID

## `manifest`

```
ninedeploy manifest [options] [command]
```

Manage the .ninedeploy file in this repo

### `manifest init`

```
ninedeploy manifest init [options]
```

Scaffold a starter .ninedeploy based on detected project kind

### `manifest validate`

```
ninedeploy manifest validate [options]
```

Parse + schema-check the .ninedeploy in the current directory

### `manifest show`

```
ninedeploy manifest show [options]
```

Print a human-readable summary of the parsed manifest

### `manifest apply`

```
ninedeploy manifest apply [options] <serviceId>
```

Apply the .ninedeploy manifest to a service (requires admin role)

