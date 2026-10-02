export type Block =
  | { kind: "p"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "code"; file?: string; body: string }
  | { kind: "list"; items: string[] }
  | { kind: "callout"; tone: "info" | "warn"; title: string; text: string };

export type Doc = {
  slug: string;
  title: string;
  description: string;
  group: string;
  blocks: Block[];
};

export const docs: Doc[] = [
  {
    slug: "introduction",
    title: "Introduction",
    description: "What NineDeploy is, and why it looks like this.",
    group: "Start",
    blocks: [
      {
        kind: "p",
        text: "NineDeploy is a self-hosted deployment platform and PaaS. It wraps PM2 and Docker behind a sleek web dashboard, a fast CLI and a 35-tool MCP server, fronts everything with Traefik, and handles webhooks, managed databases, monitoring, alerts, notifications, and backups. All state lives in a single SQLite database on your server — zero external database dependencies.",
      },
      { kind: "h2", text: "The shape of the system" },
      {
        kind: "list",
        items: [
          "Core server (Fastify + Microkernel) runs bare-metal under systemd for direct Docker daemon + PM2 access — or in a single Docker container.",
          "Remote hosts run the same binary in agent mode (NINEDEPLOY_AGENT=1) and execute a fixed table of typed, sanitized operations.",
          "All application containers live on a shared Docker network; only Traefik is exposed on :80/:443.",
          "The web dashboard is served directly by the API process — one process, one port, zero orchestration overhead.",
        ],
      },
      { kind: "h2", text: "Design principles" },
      {
        kind: "list",
        items: [
          "No host ports exposed on apps — healthchecks probe internal container IPs, Traefik routes traffic by hostname.",
          "Every subprocess has a hard timeout with tree-kill; a hung build or script can never stall the deployment queue.",
          "Secrets are AES-256-GCM encrypted in versioned envelopes with a rotatable key ring.",
          "Coverage floors enforced in CI across every package: 100% on the data, schema, SDK, CLI, MCP and plugin-sdk packages; 99% on the web dashboard and 95% on the server.",
        ],
      },
      {
        kind: "callout",
        tone: "info",
        title: "Requirements",
        text: "Node ≥ 22.13, Docker, and a Linux host (or macOS for local development). That's the complete list.",
      },
    ],
  },
  {
    slug: "installation",
    title: "Installation",
    description: "Three ways up: one-click, Docker, or from source.",
    group: "Start",
    blocks: [
      { kind: "h2", text: "One-click (bare-metal, recommended)" },
      {
        kind: "code",
        body: "curl -fsSL https://raw.githubusercontent.com/NineDeploy/NineDeploy/main/install.sh | bash",
      },
      {
        kind: "p",
        text: "The installer validates Node ≥ 22.13 and Docker, renders a hardened Type=simple systemd unit, disables service watchdog termination, verifies the effective runtime policy and gates readiness on /health. Open http://localhost:3000 to create the initial admin account.",
      },
      { kind: "h2", text: "Docker" },
      {
        kind: "code",
        body: `docker run -d --name ninedeploy \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v ninedeploy-data:/data \\
  -p 3000:3000 \\
  -e NINEDEPLOY_JWT_SECRET=$(openssl rand -hex 32) \\
  ghcr.io/ninedeploy/ninedeploy`,
      },
      {
        kind: "p",
        text: "All state (SQLite, repos, logs, backups, master keys) persists in the volume; database migrations apply automatically on boot. PM2 services require bare-metal mode; Docker containers and templates work in both modes.",
      },
      { kind: "h2", text: "From source" },
      {
        kind: "code",
        body: `git clone https://github.com/NineDeploy/NineDeploy.git
cd ninedeploy && pnpm install && cp .env.example .env
pnpm build && pnpm dev`,
      },
      { kind: "h2", text: "Upgrades" },
      {
        kind: "p",
        text: "Re-running install.sh performs an atomic in-place upgrade: snapshots the database, checks out the release (latest by default, --channel main for edge, --version to pin), rebuilds, runs migrations, and gates the restart on /health.",
      },
      {
        kind: "callout",
        tone: "warn",
        title: "JWT secret",
        text: "The server refuses to boot in production with the insecure default JWT secret. Generate one using: openssl rand -hex 32.",
      },
    ],
  },
  {
    slug: "deploy-pipeline",
    title: "Deploy pipeline",
    description: "Trigger → claim → build → healthcheck → flip → retire.",
    group: "Core",
    blocks: [
      {
        kind: "p",
        text: "Deploys are tracked as atomic database records, claimed by concurrent worker slots (NINEDEPLOY_DEPLOY_CONCURRENCY, default 1, max 8). The same service is never deployed concurrently. Stranded deployments from abrupt restarts are swept automatically on boot.",
      },
      {
        kind: "list",
        items: [
          "Trigger: manual UI button, webhook (HMAC + branch + watch-path globs + replay dedup), CLI command, cron schedule, or template hub.",
          "Build: git clone with credentials (scrubbed after checkout) or Docker image pull with per-source registry credentials.",
          "Blue-green: the new container starts on the shared network while the existing version continues handling live traffic.",
          "Healthcheck: container liveness check plus HTTP probes against the container IP — isolated per attempt with hard timeouts.",
          "Flip: Traefik's dynamic routing configuration is rewritten atomically; only then is the previous container retired.",
          "Automatic rollback: on failure, the new container is destroyed and the previous healthy release keeps running.",
          "Cancellation: in-flight builds can be cancelled at any stage, immediately stopping subprocesses and cleaning up containers.",
        ],
      },
      {
        kind: "callout",
        tone: "info",
        title: "Rollback pins digests",
        text: "Each deployment records the exact immutable image digest. Rollback redeploys that exact digest — never an altered :latest tag.",
      },
    ],
  },
  {
    slug: "workspaces-rbac",
    title: "Workspaces & RBAC",
    description: "Multi-tenant workspace isolation and role-based permissions.",
    group: "Core",
    blocks: [
      {
        kind: "p",
        text: "NineDeploy organizes projects, services, databases, volumes, and credentials into isolated workspaces. Team members can belong to multiple workspaces with distinct roles.",
      },
      { kind: "h2", text: "Roles & Privileges" },
      {
        kind: "list",
        items: [
          "Owner: Full system access, workspace deletion, billing/licensing, and transfer of ownership.",
          "Admin: Create/edit/delete services, manage secrets, configure alert rules, invite and manage members.",
          "Member: Deploy existing services, view logs, view container metrics, and restart applications.",
          "Viewer: Read-only access to service statuses, build logs, and topology views without mutation rights.",
        ],
      },
      { kind: "h2", text: "Team Invitations" },
      {
        kind: "p",
        text: "Invite team members via email with role assignment. When SMTP is configured, an invitation link is dispatched automatically; otherwise, admins can copy the single-use token from the dashboard.",
      },
    ],
  },
  {
    slug: "tags-projects-labels",
    title: "Tags: Projects, Workspaces & Labels",
    description: "Three independent dimensions a service can belong to at once.",
    group: "Core",
    blocks: [
      {
        kind: "p",
        text: "A service is not filed into one folder. It carries membership in three independent dimensions at the same time — projects, workspaces and labels — each stored in its own join table (service_projects, service_workspaces, service_labels). Nothing moves when you reorganise; you only add or remove a tag.",
      },
      { kind: "h2", text: "The three dimensions" },
      {
        kind: "list",
        items: [
          "Workspace — the tenancy boundary. Members, roles, invitations and RBAC hang off it. A service can be shared across several workspaces.",
          "Project — a purpose grouping (Acme Web, Internal tooling). Projects also own shared environment variables, and a service inherits the union of every project it is linked to.",
          "Label — a free-form coloured tag (production, staging, team-x) for slicing across the other two.",
        ],
      },
      { kind: "h2", text: "Filtering" },
      {
        kind: "p",
        text: "The top bar has one chip group per dimension. Selections OR within a group and AND across groups: picking projects A and B plus the label production returns services in (A or B) that are also tagged production. The selection is persisted per browser under ninedeploy.tagScope, so a reload keeps your view.",
      },
      {
        kind: "code",
        file: "REST",
        body: `# Every dimension is a comma-separated id list; omit one to leave it unfiltered.
GET /v1/services?tagProjectIds=3,7&tagLabelIds=2

# Manage the flat lists
GET|POST /v1/projects        PATCH|DELETE /v1/projects/:id
GET|POST /v1/labels          PATCH|DELETE /v1/labels/:id

# Replace one service's whole membership in a single round-trip
PUT /v1/services/:id/tags
{ "projectIds": [3], "workspaceIds": [1], "labelIds": [2, 5] }`,
      },
      { kind: "h2", text: "In the panel" },
      {
        kind: "list",
        items: [
          "Organize → Workspaces — tenants, members, roles and invitations (including invites to addresses with no account yet).",
          "Organize → Projects — create, rename and delete projects; the row shows service and database counts.",
          "Organize → Labels — full CRUD with an eight-token colour palette; clicking a label scopes the services list to it.",
          "Service detail → Tags card — edits all three dimensions of one service and saves them in one request.",
        ],
      },
      {
        kind: "callout",
        tone: "info",
        title: "Deleting a tag never deletes a service",
        text: "Removing a project or label only drops the membership rows. Every service that carried it keeps running, untagged in that dimension.",
      },
    ],
  },
  {
    slug: "volumes-storage",
    title: "Volumes & Storage",
    description: "Per-service volume attachments, and snapshot/restore for any managed volume.",
    group: "Core",
    blocks: [
      {
        kind: "p",
        text: "NineDeploy manages Docker named volumes on your behalf. Every managed volume is prefixed (nd-svc- for service storage, nd-db- for a managed database) so the platform never touches a volume it did not create. A service is no longer limited to one mount — it can attach any number of volumes at explicit container paths.",
      },
      { kind: "h2", text: "Attaching a volume to a service" },
      {
        kind: "p",
        text: "Open a service → Volumes & Storage → Attach Volume. Either pick an existing managed volume or provision a new one by giving it a short label; the server prepends the service prefix to keep the name unique. Choose the absolute container path and whether the mount is read-only. The path and the volume are both unique per service, so a typo cannot shadow an existing mount.",
      },
      {
        kind: "code",
        file: "REST",
        body: `GET    /v1/services/:id/volumes
POST   /v1/services/:id/volumes
{ "create": { "label": "uploads" }, "containerPath": "/app/uploads", "readOnly": false }
# ...or attach one that already exists:
{ "volumeName": "nd-svc-api-uploads", "containerPath": "/app/uploads" }

PATCH  /v1/services/:id/volumes/:attId   # move the mount or flip readOnly
DELETE /v1/services/:id/volumes/:attId   # detaches only — the volume survives`,
      },
      {
        kind: "callout",
        tone: "info",
        title: "Detach is not delete",
        text: "Removing an attachment records the change and unmounts the volume on the next deploy. The data stays; delete the volume itself from the Volumes page when you actually want it gone.",
      },
      { kind: "h2", text: "Backups" },
      {
        kind: "p",
        text: "Any managed volume can be snapshotted, restored and downloaded. Snapshots run through a throwaway sidecar container, so a containerised panel never needs a path into the daemon's storage directory. They reuse the same S3-compatible destination as database backups for off-site copies and prune to the configured retention cap.",
      },
      {
        kind: "code",
        file: "REST",
        body: `GET  /v1/volumes/:name/backups
POST /v1/volumes/:name/backups                  # snapshot now (admin)
POST /v1/volumes/:name/backups/:bid/restore     # admin
GET  /v1/volumes/:name/backups/:bid/download    # admin`,
      },
      {
        kind: "callout",
        tone: "warn",
        title: "Restore requires a stopped service",
        text: "A restore empties the volume before unpacking the archive rather than merging over what is already there, and it refuses to run while the owning service is still running. Stop the service first.",
      },
      { kind: "h2", text: "Declaring storage in the repo" },
      {
        kind: "code",
        file: ".ninedeploy",
        body: `volume:
  mount: "/var/lib/app/data"
  backups:
    schedule: "0 3 * * *"    # 5-field cron
    retention: 14            # days, 1-365`,
      },
    ],
  },
  {
    slug: "ninedeploy-manifest",
    title: "The .ninedeploy manifest",
    description: "Commit build, runtime, routing and storage config next to the code.",
    group: "Core",
    blocks: [
      {
        kind: "p",
        text: ".ninedeploy is a YAML file committed in your repository root that declares how the service is built, run, routed, alerted and backed up. It removes click-through configuration drift: the panel and the file describe the same service, and the file travels with the branch.",
      },
      { kind: "h2", text: "Filenames & precedence" },
      {
        kind: "list",
        items: [
          "The loader accepts .ninedeploy, .ninedeploy.yml, .ninedeploy.yaml, ninedeploy.yml, ninedeploy.yaml — in that order; the first match wins.",
          "The extensionless dotfile .ninedeploy is canonical and is what `ninedeploy manifest init` writes.",
          "Files larger than 16 KiB are refused at load time.",
        ],
      },
      { kind: "h2", text: "Merge precedence" },
      { kind: "code", body: `panel/DB  >  manifest  >  auto-detect` },
      {
        kind: "p",
        text: "A value set in the panel always wins. If the panel is silent the manifest fills the gap, and if the manifest is silent too NineDeploy falls back to its own detection. The manifest is a project default, not a hard override — you can still run a one-off experiment from the panel without editing the file.",
      },
      { kind: "h2", text: "A representative file" },
      {
        kind: "code",
        file: ".ninedeploy",
        body: `version: "1"

runtime:
  type: node
  version: "20"

build:
  install: "pnpm i --frozen-lockfile"
  build: "pnpm build"
  start: "node dist/server.js"
  baseDir: "apps/api"        # monorepo sub-path

run:
  port: 3000
  healthcheck: "/healthz"
  restart: unless-stopped

env:
  required:                   # names only - values live in the env vault
    - DATABASE_URL
    - STRIPE_SECRET_KEY
  aliases:
    POSTGRES_URL: DATABASE_URL

watch:
  paths:
    - "apps/api/**"
    - "packages/**"
    - "!**/*.test.ts"

routes:
  - host: api.example.com
    ssl: true
    redirectWww: true
    rateLimit: { average: 50, burst: 100 }

database:
  ref: primary-postgres       # slug of a managed database
  env: DATABASE_URL

resources:
  cpuShares: 1024
  memMb: 512`,
      },
      { kind: "h2", text: "Sections" },
      {
        kind: "list",
        items: [
          "runtime — language and version pinned for Nixpacks (auto | node | python | go | ruby | php | java | rust | static).",
          "build — install/build/start commands, monorepo baseDir, or an explicit dockerfile that skips Nixpacks entirely.",
          "run — container port, HTTP healthcheck path and restart policy (no | always | unless-stopped | on-failure[:N]).",
          "static — serve a pre-built dist/ directory with SPA fallback instead of starting a process.",
          "env — required variable names and aliases that rename injected managed-database variables.",
          "phases — advanced Nixpacks overrides: extra Nix packages and additional build commands.",
          "resources — cpuShares and memMb limits.",
          "hooks — preBuild, postBuild and preStop command lines.",
          "watch — glob paths that decide whether a push rebuilds this service.",
          "routes — hostnames upserted into the domains table, with SSL, headers, IP allowlist and rate limits.",
          "previews — ephemeral PR environment hostname pattern and retention.",
          "volume — persistent mount path and its backup schedule.",
          "database — managed-DB slug to attach and the env var to inject the URL into.",
          "network — published host port and extra Docker network aliases.",
        ],
      },
      { kind: "h2", text: "CLI" },
      {
        kind: "code",
        file: "shell",
        body: `ninedeploy manifest init       # detect the project kind and scaffold a starter file
ninedeploy manifest validate   # strict schema check + secret scan
ninedeploy manifest show       # print the resolved manifest as a flat summary`,
      },
      {
        kind: "p",
        text: "The panel has the same thing under Deploy → Manifest Creator, which builds a manifest section by section and hands you the YAML to commit. Each service also has a Manifest & Traefik tab showing the manifest the last deploy actually used.",
      },
      {
        kind: "callout",
        tone: "warn",
        title: "Never put secrets in the manifest",
        text: "The file is committed to git, so the loader regex-scans every byte before validation and fails the load on a hit — AWS keys, GitHub/GitLab PATs, Slack and Stripe tokens, OpenAI and Anthropic keys, Discord webhooks, DB URLs with embedded credentials, PEM private key blocks and literal Bearer JWTs. Reference secrets by name under env.required and keep the values in the panel env vault.",
      },
      {
        kind: "callout",
        tone: "info",
        title: "Applied automatically on every deploy",
        text: "The docker builder reads the build and runtime sections at build time; the deploy pipeline reads the operational sections (routes, alerts, database ref) at deploy time. There is no separate apply step to remember — the on-demand manifest apply endpoint shipped in 0.9.x, and the CLI says so rather than pretending it ran.",
      },
    ],
  },
  {
    slug: "private-repos",
    title: "Private repos, sources & webhooks",
    description: "Encrypted credentials, server-generated deploy keys, auto-deploy hooks.",
    group: "Core",
    blocks: [
      {
        kind: "p",
        text: "A source is a stored, AES-256-GCM encrypted credential for a Git provider or container registry. Services reference a source instead of embedding a token, so the same credential can be rotated once and picked up everywhere. Credentials are scrubbed from the working tree right after checkout and never appear in build logs.",
      },
      { kind: "h2", text: "Credential types" },
      {
        kind: "list",
        items: [
          "Provider token — a GitHub / GitLab / Bitbucket PAT. The panel can list the repositories and branches it can reach, and test proves the token still authenticates without deploying anything.",
          "SSH deploy key — generated server-side as an ed25519 pair. The private half is encrypted into the source row and never leaves the server; you paste the returned public key into the provider's Deploy keys screen.",
          "Registry credential — used for private Docker image pulls, per source.",
        ],
      },
      {
        kind: "code",
        file: "shell",
        body: `ninedeploy sources list
ninedeploy sources add              # interactive: provider, token or deploy key
ninedeploy sources test <id>        # live credential check
ninedeploy sources keygen <id>        # generate an ed25519 pair, print the public half

ninedeploy webhooks list <service>
ninedeploy webhooks add <serviceId> [branch] # returns URL + HMAC secret once`,
      },
      { kind: "h2", text: "Auto-deploy webhooks" },
      {
        kind: "p",
        text: "Each service can own webhooks that trigger a deploy on push. The receiver verifies the HMAC signature in constant time, checks the branch, applies the manifest's watch.paths globs, and de-duplicates replayed deliveries. A push whose diff touches nothing in watch.paths is accepted and skipped rather than rebuilt.",
      },
      {
        kind: "callout",
        tone: "warn",
        title: "The secret is shown once",
        text: "Webhook secrets and generated private keys are never returned again after creation. Store the secret in your provider immediately; if you lose it, delete the webhook and create a new one.",
      },
      {
        kind: "callout",
        tone: "info",
        title: "Fork PRs are not trusted",
        text: "Pull-request preview environments reject invalid refs and external fork repositories before they can inherit the service's environment variables or enter the build queue.",
      },
    ],
  },
  {
    slug: "databases",
    title: "Managed databases",
    description: "Postgres (pgvector), MySQL, MariaDB, Redis, Valkey, ClickHouse, Meilisearch, RabbitMQ, Mongo.",
    group: "Core",
    blocks: [
      {
        kind: "p",
        text: "One-click managed databases with persistent volume attachments, CPU/memory limits, Web Studio management, and credentials encrypted at rest. Attaching a database to a service injects standard connection strings automatically.",
      },
      { kind: "h2", text: "Supported Engines" },
      {
        kind: "list",
        items: [
          "PostgreSQL (with pgvector AI extension support)",
          "MySQL 8 & MariaDB 11",
          "Redis 7 & Valkey 8 in-memory caches",
          "ClickHouse analytical column store",
          "Meilisearch fast search engine",
          "RabbitMQ message broker",
          "MongoDB 7 document database",
        ],
      },
      { kind: "h2", text: "Backups & S3 Replication" },
      {
        kind: "list",
        items: [
          "Automated engine dumps sealed with AES-256 encryption the moment they hit the filesystem.",
          "Daily scheduled backups with automated 7-day retention; manual snapshots are preserved permanently.",
          "Off-site replication to any S3 endpoint (AWS, MinIO, Cloudflare R2, Backblaze B2) using zero-dependency SigV4 signing.",
          "One-click restore fetches the remote archive if local copy is missing, validated against path-traversal / tar-slip.",
        ],
      },
    ],
  },
  {
    slug: "multi-server",
    title: "Multi-server & Nodes",
    description: "Typed agent protocol, SSH zero-touch provisioning, and cluster management.",
    group: "Core",
    blocks: [
      {
        kind: "p",
        text: "Deploy workloads across multiple servers. Remote nodes run the same NineDeploy binary with NINEDEPLOY_AGENT=1, communicating over a strictly typed RPC protocol.",
      },
      { kind: "h2", text: "Zero-Touch SSH Provisioning" },
      {
        kind: "p",
        text: "Bootstrap fresh Linux VPS instances directly from the web dashboard. Enter IP, SSH user, and private key — NineDeploy connects, installs Docker and dependencies, configures the agent, and securely links it to your cluster.",
      },
      { kind: "h2", text: "Security & Validation" },
      {
        kind: "list",
        items: [
          "Strict typed operations (docker pull/build/run, compose up/down, git checkout) — no raw shell execution over the wire.",
          "Operand validation regexes enforced at both controller and agent boundaries.",
          "Node health monitoring with heartbeat pings and CPU/memory metric streaming.",
          "Per-service migration bundles for exporting and moving services between nodes with zero data loss.",
        ],
      },
    ],
  },
  {
    slug: "ingress-traefik-tunnels",
    title: "Ingress, SSL & Tunnels",
    description: "Traefik reverse proxy, Let's Encrypt certificates, and Cloudflare Tunnels.",
    group: "Core",
    blocks: [
      {
        kind: "p",
        text: "All incoming HTTP and HTTPS traffic is routed through an integrated Traefik reverse proxy. Applications do not expose host ports.",
      },
      { kind: "h2", text: "SSL & Wildcard Domains" },
      {
        kind: "list",
        items: [
          "Automatic Let's Encrypt HTTP-01 challenge for custom domains.",
          "Cloudflare DNS-01 integration for wildcard certificates (*.yourdomain.com).",
          "Automatic subdomains: configure NINEDEPLOY_WILDCARD_DOMAIN to auto-assign {service-name}.yourdomain.com.",
          "Dynamic middleware: basic auth, rate limiting, IP whitelisting, and custom response headers.",
        ],
      },
      { kind: "h2", text: "Cloudflare Tunnels" },
      {
        kind: "p",
        text: "Expose self-hosted services without opening router ports or exposing public IPs. Connect a Cloudflare Tunnel token in Settings, and NineDeploy proxies traffic through Cloudflare's edge securely.",
      },
    ],
  },
  {
    slug: "security-sso",
    title: "Security, SSO & Passkeys",
    description: "WebAuthn, OIDC Single Sign-On, TOTP 2FA, brute-force lockout, and AES-256 key rotation.",
    group: "Security",
    blocks: [
      {
        kind: "p",
        text: "NineDeploy follows a defense-in-depth security model built into every layer.",
      },
      { kind: "h2", text: "Authentication Options" },
      {
        kind: "list",
        items: [
          "Passkeys (WebAuthn): Biometric and hardware FIDO2 key login without passwords.",
          "OIDC Single Sign-On: Turnkey integration for Google, GitHub, Okta, Keycloak, and generic OpenID Connect.",
          "Two-Factor Authentication (TOTP): RFC 6238 time-based one-time passwords for password logins.",
          "Argon2id password hashing with hardened parameters.",
        ],
      },
      { kind: "h2", text: "Secrets & Key Rotation" },
      {
        kind: "list",
        items: [
          "Environment secrets and database passwords are encrypted with AES-256-GCM in versioned envelopes.",
          "Zero-downtime key rotation: configure NINEDEPLOY_MASTER_KEYS=0:old_key,1:new_key to seamlessly re-encrypt secrets.",
          "Account lockout: 5 failed consecutive login attempts lock the account for 15 minutes.",
          "Session revocation: password resets immediately invalidate all active JWT tokens and sessions.",
        ],
      },
    ],
  },
  {
    slug: "alerts-notifications",
    title: "Alerts & Notifications",
    description: "Sustained breach metric monitoring and multi-channel alerting.",
    group: "Core",
    blocks: [
      {
        kind: "p",
        text: "Define metric alert rules to stay ahead of performance degradation and downtime. Background workers collect CPU, memory, disk usage, and SSL certificate expiration windows.",
      },
      { kind: "h2", text: "Supported Channels" },
      {
        kind: "list",
        items: [
          "Telegram (bot token + chat ID)",
          "Discord (webhook URL)",
          "Slack (incoming webhook)",
          "Ntfy (self-hosted or public push notification topics)",
          "Generic Webhook (HMAC signed JSON payload)",
          "Email (SMTP relay with custom templates)",
        ],
      },
      { kind: "h2", text: "Sustained Breach Windows" },
      {
        kind: "p",
        text: "Avoid notification fatigue from transient spikes. Rules evaluate consecutive metric windows (e.g. CPU > 85% for 3 cycles) before triggering alert delivery.",
      },
    ],
  },
  {
    slug: "cli",
    title: "CLI",
    description: "The ninedeploy command — full scriptability.",
    group: "Interfaces",
    blocks: [
      {
        kind: "p",
        text: "The CLI communicates with the REST API using the typed SDK. User credentials live in ~/.ninedeploy/config.json (0600 permissions).",
      },
      {
        kind: "code",
        body: `ninedeploy setup                     # bootstrap first admin
ninedeploy login                     # authenticate interactively
ninedeploy services list             # list workspace services
ninedeploy services deploy 12        # trigger a deploy (service ID)
ninedeploy deploys watch 12 480      # stream live build logs (IDs)
ninedeploy deploys rollback 12 480   # rollback to exact digest
ninedeploy env set 12 API_KEY …      # encrypted secret
ninedeploy domains add 12 app.example.com
ninedeploy backups create 3          # snapshot database #3
ninedeploy system dashboard          # live status board (terminal)`,
      },
    ],
  },
  {
    slug: "api",
    title: "REST API & SDK",
    description: "Unified /v1 API surface with TypeScript SDK.",
    group: "Interfaces",
    blocks: [
      {
        kind: "p",
        text: "All endpoints live under /v1 and take Authorization: Bearer <token> (except public health, webhook, and auth endpoints). Shared Zod schemas keep contracts synchronized.",
      },
      {
        kind: "code",
        body: `curl -X POST http://localhost:3000/v1/auth/login \\
  -d '{"email":"admin@example.com","password":"…"}'

curl -X POST http://localhost:3000/v1/services/1/deploys \\
  -H "Authorization: Bearer $TOKEN"

curl "http://localhost:3000/v1/services/1/metrics?kind=cpu&minutes=60" \\
  -H "Authorization: Bearer $TOKEN"`,
      },
      { kind: "h2", text: "TypeScript SDK" },
      {
        kind: "code",
        body: `import { createClient } from "@ninedeploy/sdk";

const nd = createClient({ baseUrl: "http://localhost:3000", getToken: () => "nd_…" });
const deploys = await nd.deploys.list(1);
await nd.deploys.trigger(1);`,
      },
      {
        kind: "p",
        text: "SDK namespaces: auth, services, deploys, domains, volumes, system, tunnels, activity, alerts, settings, users, projects, workspaces, about, notifications, sources, webhooks, databases, and plugins.",
      },
    ],
  },
  {
    slug: "mcp",
    title: "MCP server (AI Agents)",
    description: "38 Model Context Protocol tools for AI assistants.",
    group: "Interfaces",
    blocks: [
      {
        kind: "p",
        text: "NineDeploy includes an official Model Context Protocol (MCP) stdio server. AI agents (Claude Desktop, Cursor, Antigravity, Cline) can query metrics, trigger deployments, inspect build logs, configure databases, manage workspaces, and operate extensions using 35 dedicated tools.",
      },
      {
        kind: "code",
        file: "claude_desktop_config.json",
        body: `{
  "mcpServers": {
    "ninedeploy": {
      "command": "node",
      "args": ["/path/to/NineDeploy/packages/mcp/dist/index.js"],
      "env": {
        "NINEDEPLOY_URL": "http://127.0.0.1:3000",
        "NINEDEPLOY_TOKEN": "nd_…"
      }
    }
  }
}`,
      },
    ],
  },
  {
    slug: "microkernel",
    title: "Microkernel Architecture",
    description: "Event-driven, hookable, zero-coupling core engine.",
    group: "Extend",
    blocks: [
      {
        kind: "p",
        text: "NineDeploy is architected around an asynchronous microkernel. Core services interact via an EventBus, waterfall hook pipelines, driver registries, and dual-vault config scopes.",
      },
      { kind: "h2", text: "Key Kernel Systems" },
      {
        kind: "list",
        items: [
          "EventBus: Low-latency async event pub/sub with typed events (deploy, audit, service, backup, alert).",
          "HookPipeline: Waterfall middleware (deploy.before, deploy.after, container.created) enabling plugins to intercept and mutate builds.",
          "ServiceRegistry: Dynamic driver interchange (Compute Drivers, Proxy Drivers, Storage Drivers).",
          "MenuRegistry: Dynamic UI navigation slot injection (sidebar items, service detail tabs, command palette actions).",
        ],
      },
    ],
  },
  {
    slug: "config-center",
    title: "Configuration Center",
    description: "Centralized dual-vault configuration and secret management.",
    group: "Extend",
    blocks: [
      {
        kind: "p",
        text: "Config Center provides a unified, reactive store for global server settings, system overrides, and plugin-scoped parameters.",
      },
      { kind: "h2", text: "Vault Separation & Encryption" },
      {
        kind: "list",
        items: [
          "Dual Vault: Plain text values (boolean, numbers, strings, JSON) vs AES-256-GCM encrypted secrets.",
          "Namespace Scoping: Unique plugin-scoped keys (e.g. plugin:s3-backups:bucket_name) with tag-based querying.",
          "Reactive Watchers: In-memory cache with zero DB lag and real-time onChange listeners for hot reloads.",
        ],
      },
    ],
  },
  {
    slug: "plugin-sdk",
    title: "Plugin SDK & Marketplace",
    description: "Build, publish, and install custom NineDeploy extensions.",
    group: "Extend",
    blocks: [
      {
        kind: "p",
        text: "Extend NineDeploy using @ninedeploy/plugin-sdk. Plugins can declare configuration schemas, register UI navigation items, tap into the deployment pipeline, and listen to security events.",
      },
      { kind: "h2", text: "Example Plugin" },
      {
        kind: "code",
        file: "my-plugin.ts",
        body: `import { definePlugin } from '@ninedeploy/plugin-sdk';

export default definePlugin({
  id: 'my-custom-extension',
  name: 'My Custom Extension',
  version: '1.0.0',
  configSchema: [
    { key: 'api_token', type: 'string', isSecret: true, label: 'API Token' }
  ],
  init: (ctx) => {
    ctx.tapHook('deploy:before', async (context) => {
      ctx.logger.info('Deploying service:', context.serviceId);
      return context;
    }, { priority: 150 });
  }
});`,
      },
      { kind: "h2", text: "Installing Extensions" },
      {
        kind: "p",
        text: "Install verified extensions from the web marketplace or CLI via `ninedeploy plugins install <id>`. Install sources: the verified marketplace, or a sandbox bundle.",
      },
    ],
  },
  {
    slug: "configuration",
    title: "Configuration",
    description: "Environment variables that matter.",
    group: "Reference",
    blocks: [
      {
        kind: "code",
        body: `NINEDEPLOY_PORT=3000              # dashboard + API port
NINEDEPLOY_DATA_DIR=./.data        # SQLite, repos, logs, backups
NINEDEPLOY_JWT_SECRET=…            # REQUIRED in production
NINEDEPLOY_MASTER_KEY=…            # AES-256 secrets key
NINEDEPLOY_MASTER_KEYS=0:old,1:new # key ring for rotation
NINEDEPLOY_WILDCARD_DOMAIN=…       # auto-assign {slug}.domain
NINEDEPLOY_DNS_PROVIDER=cloudflare # DNS-01 wildcard certs
NINEDEPLOY_DNS_TOKEN=…
NINEDEPLOY_DEPLOY_CONCURRENCY=1    # parallel worker slots (1-8)
NINEDEPLOY_TEMPLATES_SOURCE=…      # registry URL/path override
NINEDEPLOY_UPDATE_CHECK_URL=…      # or "disabled" for air-gapped`,
      },
      {
        kind: "callout",
        tone: "info",
        title: "Self-migrating",
        text: "Pending SQL migrations apply automatically on every startup — bare-metal and container alike. drizzle-kit is dev-only.",
      },
    ],
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting & Common Fixes",
    description: "Resolving common operational issues, Docker permissions, and boot errors.",
    group: "Reference",
    blocks: [
      { kind: "h2", text: "1. Production Boot: Insecure JWT Secret Error" },
      {
        kind: "p",
        text: "Symptom: The server exits immediately with 'Refusing to boot in production with default JWT secret'.",
      },
      {
        kind: "code",
        body: `# Fix: Generate a secure 256-bit random string and set NINEDEPLOY_JWT_SECRET in .env
openssl rand -hex 32
# Add to .env:
# NINEDEPLOY_JWT_SECRET=c9a0...3f2`,
      },
      { kind: "h2", text: "2. Docker Daemon Permission Denied" },
      {
        kind: "p",
        text: "Symptom: 'connect: permission denied' when communicating with /var/run/docker.sock.",
      },
      {
        kind: "code",
        body: `# Ensure the service user belongs to the 'docker' group:
sudo usermod -aG docker $USER
newgrp docker
# For Docker-in-Docker containers, verify the socket volume mount:
# -v /var/run/docker.sock:/var/run/docker.sock`,
      },
      { kind: "h2", text: "3. SQLite Database Locked or Busy" },
      {
        kind: "p",
        text: "Symptom: 'SQLITE_BUSY: database is locked'.",
      },
      {
        kind: "code",
        body: `# NineDeploy uses synchronous file locks. Ensure only one NineDeploy instance is accessing the .data directory.
# If a previous crashed process holds a lock, verify no zombie processes:
pgrep -fl ninedeploy
# Restart the systemd service cleanly:
sudo systemctl restart ninedeploy`,
      },
      { kind: "h2", text: "4. Port 80/443 Conflicts with Existing Nginx/Apache" },
      {
        kind: "p",
        text: "Symptom: Traefik container fails to bind port 80 or 443.",
      },
      {
        kind: "code",
        body: `# Check which process is occupying port 80/443:
sudo ss -tulpn | grep -E ':(80|443)'
# Stop or disable conflicting standalone web servers:
sudo systemctl stop nginx
sudo systemctl disable nginx`,
      },
      { kind: "h2", text: "5. Remote Node Agent Connection Refused" },
      {
        kind: "p",
        text: "Symptom: Controller reports 'Agent unreachable' when querying remote node.",
      },
      {
        kind: "code",
        body: `# Check that the agent is running on the remote host:
curl http://<remote-node-ip>:3001/health
# Verify firewall allows port 3001 from the controller IP:
sudo ufw allow from <controller-ip> to any port 3001 proto tcp`,
      },
      { kind: "h2", text: "6. Docker Pull Exits with Code 143 (SIGTERM)" },
      {
        kind: "p",
        text: "Exit 143 means an external supervisor sent SIGTERM. Older NineDeploy Type=notify/WatchdogSec units could terminate the service cgroup during a long image pull. OOM kills normally surface as exit 137.",
      },
      {
        kind: "code",
        body: `# Upgrade in place; this migrates and verifies the systemd policy:
curl -fsSL https://raw.githubusercontent.com/NineDeploy/NineDeploy/main/install.sh | bash

# Expected: Type=simple and WatchdogUSec=0
systemctl show ninedeploy -p Type -p WatchdogUSec`,
      },
    ],
  },
];

export const docGroups = [
  "Start",
  "Core",
  "Security",
  "Extend",
  "Interfaces",
  "Reference",
].map((name) => ({
  name,
  items: docs.filter((d) => d.group === name),
}));
