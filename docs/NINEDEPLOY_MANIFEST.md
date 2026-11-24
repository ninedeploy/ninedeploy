# .ninedeploy Manifest

`.ninedeploy` is a project-side YAML file that declaratively describes how NineDeploy should build, run, route, alert, back up, and attach a service. The file is committed to the repo alongside the application source so that build, runtime, and routing behavior are reproducible from git alone — no click-through configuration in the panel, no per-developer setup drift.

The deploy pipeline loads the file once per deploy, right after the checkout, and applies it in two stages (§6):

1. **Prepare** — it upserts the operational sections (routes → domains, alerts → alert rules, `database.ref` → managed DB attach) and writes the `previews`, `notifications`, `volume.backups` and `watch` settings.
2. **Build** — it folds the `build`, `run` and `resources` sections into this one deploy's configuration, renders `runtime` and `phases` into a Nixpacks-compatible `nixpacks.toml`, and builds with the manifest's install/build/start commands.

The web panel, the CLI, and the `ninedeploy manifest {init,validate,show,apply}` subcommands all read and validate the same file.

---

## 🗂️ 1. Filenames & Precedence

The loader accepts any of the following names in the repository root, in this priority order:

| Priority | Filename |
| :--- | :--- |
| 1 | `.ninedeploy` |
| 2 | `.ninedeploy.yml` |
| 3 | `.ninedeploy.yaml` |
| 4 | `ninedeploy.yml` |
| 5 | `ninedeploy.yaml` |

The first file found is used. The dotfile `.ninedeploy` (no extension) is the canonical form and is what `ninedeploy manifest init` writes by default. Files larger than **16 KiB** are refused at load time.

The loader reads exactly one file, whichever of the five names it finds first: a manifest cannot be split across several files. The file must also be a regular file in the repository: a symlink, FIFO or directory under one of these names is refused (`ManifestNotRegularFileError`), so a push cannot make the panel read something else on the host.

The CLI's `manifest validate`, `show` and `apply` look for the first three names only (`.ninedeploy`, `.ninedeploy.yml`, `.ninedeploy.yaml`). A file called `ninedeploy.yml` or `ninedeploy.yaml` is read by the deploy pipeline but not by those subcommands.

---

## 🔒 2. Never Put Secrets in the Manifest

The manifest is committed to the repo, so it must **never** contain credentials, tokens, or connection strings. The loader runs a regex scan against every byte of the file before validation; any hit fails the load with a `ManifestSecretError` that names the offending pattern (the value itself is redacted).

The scanner matches the following patterns:

| ID | Detects |
| :--- | :--- |
| `aws-access-key` | AWS access key id (`AKIA…`) |
| `github-pat-classic` | GitHub personal access token (`ghp_…`) |
| `github-pat-fine-grained` | GitHub fine-grained PAT (`github_pat_…`) |
| `gitlab-pat` | GitLab personal access token (`glpat-…`) |
| `slack-token` | Slack token (`xox[baprs]-…`) |
| `stripe-live-secret` | Stripe live secret key (`sk_live_…`) |
| `stripe-live-restricted` | Stripe live restricted key (`rk_live_…`) |
| `openai-secret` | OpenAI API key (`sk-…`) |
| `anthropic-key` | Anthropic API key (`sk-ant-…`) |
| `discord-webhook` | Discord webhook URL |
| `database-url-credentials` | DB URL with embedded `user:pass@` |
| `private-key` | PEM private key block |
| `jwt-bearer` | Literal `Bearer eyJ…` value |

Values that need to remain secret go into the **panel env vault**; the manifest only references them by name via `env.required`.

---

## ⚖️ 3. Merge Precedence

When a service is built, every field is resolved through a three-tier merge. Higher tiers win:

```
panel/DB  >  manifest  >  auto-detect
```

- A value explicitly set in the panel or stored in the database always wins.
- If the panel is silent, the manifest fills the gap.
- If the manifest is silent too, NineDeploy's own auto-detection (file markers, Nixpacks heuristics) is used.

This makes the manifest a *project default*, not a hard override. The same project can be deployed with a different runtime from the panel for one-off experiments without editing the file.

The rule covers the fields that shape a build and its container (`build`, `run`, `resources`). It does not cover the operational sections: `routes` are upserted, an `alerts` section replaces the manifest-owned rules, and `previews` overwrites the service's preview settings on every deploy of a repository that still carries the section (§6.2). `ninedeploy manifest apply` is the other exception: for the `build`, `run` and `network.publishPort` fields it writes, a value the manifest supplies overwrites the panel's (§5).

---

## 📐 4. Schema Reference

The manifest is a single YAML document with a fixed top-level `version: "1"`. Every section is optional; omit any section you don't need. The schema is strict — unknown keys are rejected.

```yaml
version: "1"
```

### 4.1 `runtime` — Language & Version

> **Applied since 0.3.5.** The deploy pipeline reads `.ninedeploy` and applies
> its *operational* sections (`routes`, `alerts`, `database`, `previews`,
> `notifications`, `volume.backups`, `watch`) in PREPARE, then renders
> `runtime` and `phases` into a `nixpacks.toml` next to the source before the
> build (§6.1). A `nixpacks.toml` the repository already ships wins and is
> left alone.
>
> A version Nixpacks cannot express as a provider environment variable becomes a
> deploy-log warning rather than a silently-wrong build — see the header comment
> in `lib/ninedeployToNixpacks.ts` for exactly which pins the pinned Nixpacks
> release (v1.41.0) accepts.

Pins the language runtime Nixpacks should install. `version` is `<major>` or `<major>.<minor>` or `<major>.<minor>.<patch>`.

```yaml
runtime:
  type: node          # auto | node | python | go | ruby | php | java | rust | static
  version: "24"       # optional; 24 / 24.4 / 3.14 are all valid
```

`type` on its own changes nothing: the builder reads it only to pick the environment variable that pins `version` (§6.1). In particular `type: static` does not select the static build pack, which is a panel setting, and the `static` section is ignored at deploy time — see §4.4.

**Which version to pin.** The schema accepts any numeric version, including
ones that have gone end-of-life — reproducing a legacy runtime is a valid
reason to deploy one. What NineDeploy *recommends* lives in a single curated
table, `RUNTIME_VERSION_CATALOG` in `@ninedeploy/schemas`
([`packages/schemas/src/runtimeVersions.ts`](../packages/schemas/src/runtimeVersions.ts)).
Everything that suggests a version reads from it: the Manifest Creator's
presets and version picker, and the CLI's `starterManifest`. The picker shows
each version's upstream support state and warns — without blocking — when the
pinned version is security-only or end-of-life.

Recommended pins as of 2026-08-26:

| Runtime | Recommended | Why |
| --- | --- | --- |
| node | `24` | Active LTS (supported to 2028-04-30) |
| python | `3.14` | Latest stable; 3.13 goes security-only in Oct 2026 |
| go | `1.27` | Latest stable; Go supports only the two newest releases |
| ruby | `3.4` | Normal maintenance; 4.0 is available but only 8 months old |
| php | `8.4` | Active support; moves to 8.5 when 8.4 lapses 2026-12-31 |
| java | `25` | Current LTS |
| rust | `1.98` | Latest stable; Rust backports nothing to older releases |

To bump a default, edit the catalog and its `RUNTIME_CATALOG_REVIEWED` date —
not the presets, which derive from it.

**What the builder can honour.** The catalog above tracks *upstream* support.
Nixpacks — pinned to v1.41.0 by the installer, and upstream in maintenance
mode — can deliver considerably less, so these are the real ceilings:

| Runtime | Pin mechanism | Versions Nixpacks 1.41.0 can build | Out-of-range behaviour |
| --- | --- | --- | --- |
| node | `NIXPACKS_NODE_VERSION` | 14, 16, 18, 20, 22, 24 | silently falls back to 18 |
| python | `NIXPACKS_PYTHON_VERSION` | 2.7, 3.7 – 3.13 | silently falls back to `python3` |
| ruby | `NIXPACKS_RUBY_VERSION` (rbenv) | any, but needs an exact `3.4.10` | fails during build |
| rust | `NIXPACKS_RUST_VERSION` | any, but needs an exact `1.98.0` | fails at Nix eval |
| java | `NIXPACKS_JDK_VERSION` | 8, 11, 17, 19, 20, 21 | **fails the build** |
| go | none — read from `go.mod` | ≤ 1.23 | pin ignored |
| php | none — read from `composer.json` | 7.4, 8.0 – 8.4 | pin ignored |

`generateNixpacksToml` refuses to emit a pin it knows Nixpacks cannot honour and
returns a warning instead, so a manifest asking for Python 3.14 or JDK 25 will
say so rather than quietly building something else.

### 4.2 `build` — Install / Build / Start

Override the Nixpacks phases. Each field maps to a phase cmd; only the fields you set are overridden, the rest stay auto-detected.

```yaml
build:
  install: "npm ci"                 # [phases.install].cmds
  build: "npm run build"            # [phases.build].cmds
  start: "npm start"                # [phases.start].cmd
  baseDir: "apps/web"               # run build from a monorepo sub-path
  dockerfile: "Dockerfile.alpine"   # explicit Dockerfile path
```

`baseDir` is useful for monorepos where the service lives in a sub-folder. `dockerfile` short-circuits the auto-detect → Nixpacks path entirely. Each of the three commands is at most 500 characters; the schema does not reject line breaks (the generated `nixpacks.toml` escapes them); `baseDir` and `dockerfile` must be paths inside the repository (`dockerfile` at most 200 characters). A repository's own `nixpacks.toml` still wins over `runtime` and `phases` (§6.1).

### 4.3 `run` — Port, Healthcheck, Restart Policy

```yaml
run:
  port: 3000                        # container port; 1–65535
  healthcheck: "/healthz"           # GET path polled before traffic flip
  restart: unless-stopped           # no | always | unless-stopped | on-failure | on-failure:N
```

`on-failure:N` accepts a retry count (1–999, no leading zero). The healthcheck path is probed on the loopback address inside the container; it must return 2xx for the blue-green release to flip traffic.

### 4.4 `static` — Pre-Built SPA

For services that build into a `dist/` directory and need no Node process. Nixpacks installs nothing; NineDeploy serves the directory with a built-in static handler.

```yaml
static:
  spa: true                         # serve /index.html for unmatched routes
  root: "dist"                      # relative path inside the container
```

`root` must be a relative path with no `.` or `..` segments (1–200 characters); `spa` defaults to `false`.

> **Not wired yet.** The section validates, and the deploy log says it was read
> and ignored: static-site serving is configured in the panel
> (Service → Settings), not from the manifest. The Manifest Creator's
> **Static SPA (Vite)** preset still emits this section; expect that warning
> when you deploy its output.

### 4.5 `env` — Required Vars & Aliases

Declare the env var names a service expects. (`aliases` is validated only; see below.)

```yaml
env:
  required:                          # names the panel env vault must provide
    - DATABASE_URL
    - STRIPE_SECRET_KEY
  aliases:                           # validated, but not applied (see below)
    POSTGRES_URL: DATABASE_URL
```

The values themselves live in the panel env vault, never in the manifest.

`required` takes at most 100 names. Each name is checked against the
service's final environment at deploy time; a missing one is a deploy-log
warning, not a failure, because the value may come from the image itself
(§6.2).

`aliases` is **not applied**: the deploy pipeline validates it and never reads
it, and it gives no warning. To choose the variable a database is injected
under, set `database.env` for the manifest-attached database (§4.13), or the
env alias of the attachment in the panel (Service → Databases).

### 4.6 `phases` — Nixpacks Phase Overrides (Advanced)

For fine-grained control over what Nixpacks installs and runs. Use `build` (§4.2) first; reach for `phases` when you need to install system packages.

```yaml
phases:
  setup:
    pkgs:                            # nixPackages entries (additive)
      - imagemagick
      - libpq
  build:
    cmds:                            # additional commands run in [phases.build]
      - "prisma generate"
```

`pkgs` takes at most 50 package names and `cmds` at most 20 commands of 500 characters each. The extra packages are added to the ones the provider already installs; they never replace them (§6.1).

### 4.7 `resources` — CPU & Memory Limits

```yaml
resources:
  cpuShares: 1024                    # 0–262144 (Docker --cpu-shares)
  cpuLimitMilli: 500                 # 0–512000 (millicores; 500 = 0.5 cores, Docker --cpus)
  memMb: 512                         # 0–1048576 (MB; Docker -m)
  replicas: 2                        # 1–10 horizontal replicas for docker services (Traefik load-balances)
```

When omitted, the container inherits the host's defaults. The three limits fill in only while the panel has them at 0 (unlimited). `replicas` fills in only while the panel has 1 and the manifest asks for more (§6.2). Like the rest of the build-shaping sections these apply to one deploy at a time and are not written to the service.

### 4.8 `hooks` — Lifecycle Hooks

Shell commands meant to run at three points of the deploy lifecycle. Each is a single command line (max 500 chars). The section validates, but the deploy pipeline ignores it on purpose (§6.3): deploy hooks execute on the **host**, not in the container, and only an operator can set them.

```yaml
hooks:
  preBuild: "echo 'about to npm ci'"   # meant to run before install
  postBuild: "echo build done"         # meant to run after build
  preStop: "drain-connections"         # meant to run before SIGTERM
```

### 4.9 `watch` — Monorepo Watch Paths

Glob patterns that decide whether a push triggers a deploy. Useful when many packages share a repo and only some should rebuild.

```yaml
watch:
  paths:
    - "apps/web/**"
    - "packages/ui/**"
```

`*` and `?` match within one path segment; `**` also crosses directories, so `apps/web/**` matches `apps/web/src/index.ts`. There is no `!` negation: a pattern that starts with `!` matches no file. A pattern may be at most 200 characters with at most four `**` and 16 wildcards in total; of up to 50 patterns only the first 32 that pass those checks are used, and the rest are dropped silently.

On every deploy of a repository that carries a non-empty `paths` list, the pipeline writes the patterns into the watch-path filter of each **active webhook** of the service, replacing whatever filter the webhook had (§6.2). From the next push on, a push to the service's branch deploys only when at least one changed file matches a pattern; otherwise the webhook answers `skipped` with the reason `watch_paths`. Because the filter lives on the webhook, it starts with the first push after the deploy that wrote it. An empty or absent `paths` list leaves the webhooks' filters alone.

Two pushes still deploy whatever the patterns say: one whose payload lists no changed files, and one whose commit list is at GitHub's 20-commit cap (the watched change may be in a commit the payload omitted).

### 4.10 `routes` — Public Hostnames

List of hostnames the service should respond on. Upserted into the domains table on every deploy.

```yaml
routes:
  - host: app.example.com
    path: /                            # optional; defaults to "/"
    ssl: true                          # issue & auto-renew Let's Encrypt cert
    redirectWww: true                  # 301 www → apex
    headers:                           # response headers added by Traefik
      X-Frame-Options: DENY
      Strict-Transport-Security: "max-age=31536000; includeSubDomains"
    ipAllowlist:                       # CIDR allowlist (deny by default when set)
      - 1.2.3.4/32
      - 10.0.0.0/8
    rateLimit:                         # requests per second
      average: 50
      burst: 100
```

Up to 50 routes; `headers` values may be 2000 characters, `ipAllowlist` up to 50 CIDRs, and `average` / `burst` up to 100000. `ssl` defaults to `true` and `redirectWww` to `false`.

An empty or absent `routes` list leaves the service's domains alone: the manifest never removes a route, and it never changes a domain's verification state. A new route inside the instance's own zone goes live at once; any other hostname is created `pending`, with a challenge that is completed from the panel. A route is skipped with a deploy-log warning when another service already routes the hostname (an exact match, or a `*.` wildcard that covers it), when it collides with the panel's own domain, when it is outside the zone a push may claim, or when it is over the per-service cap for own-zone names. `redirectWww` is ignored with a warning when its `www` companion host cannot be claimed from a push; turn the redirect on from the panel, which verifies it.

### 4.11 `previews` — Ephemeral PR Environments

```yaml
previews:
  enabled: true
  pattern: "pr-{n}-{{slug}}.{{domain}}"   # {n} is the PR number
  maxActive: 5                              # 1–50
  autoDestroyOnClose: true                  # teardown on PR close
```

`pattern` must contain `{n}` when `enabled: true`; without it the file fails validation. To be applied it must also contain `{{slug}}` and render inside the instance's wildcard domain, so write `{{domain}}` where that domain goes. `pr-{n}-{{slug}}.{{domain}}` is the default. A pattern that breaks the rule is not applied: the stored pattern stays, the rest of the section applies, and the deploy log names the reason. (`{{pr}}` is the panel's own spelling of the PR number; in a manifest it is written `{n}`.)

`enabled` defaults to `false`, `maxActive` to `5` and `autoDestroyOnClose` to `true`. The web panel still owns the per-PR environment lifecycle (create, list, destroy); the manifest only sets the service's four preview settings, on every deploy of a repository that carries the section. A setting changed in the panel afterwards keeps the new value until the next such deploy.

A preview deploys code from a pull-request branch, so the manifest's `database:` section is not applied to it, and its runtime env never carries project-shared secrets, vault references or the production service's databases; the deploy log names what was withheld (see docs/DEPLOYMENTS.md §4). Values meant for previews belong in the service's preview-only env set in the panel (0.12), not in the manifest — a manifest never carries env values; `env.required` is checked against the preview's final environment, so a key supplied by that set counts.

### 4.12 `volume` — Persistent Mount

```yaml
volume:
  mount: "/var/lib/app/data"          # path inside the container (validated, not applied)
  backups:
    schedule: "0 3 * * *"             # cron expression
    retention: 14                     # 1–365 days (default 7; not applied per service)
```

`mount` must be 1–200 characters made of letters, digits, `.`, `_`, `/` and `-`, with no `.` or `..` segment. The deploy pipeline does not read it, and it gives no warning: give the service a data volume in the panel instead (§6.3).

The backup schedule is a standard 5-field cron expression; snapshots are written to the workspace's configured S3-compatible destination.

`backups` is applied at deploy time as a scheduled job named `volume-backups (manifest)` (§6.3). The schedule is checked as a cron expression before anything is written: an invalid one creates or changes nothing and is reported in the deploy log. The job snapshots the service's data volume, when the service has one in the panel, and every volume attached to the service in the panel.

### 4.13 `database` — Managed-DB Attach Hint

```yaml
database:
  ref: primary-postgres               # slug of an existing managed DB
  env: DATABASE_URL                   # env var name to inject the URL into
```

The DB itself is provisioned in the panel (or via the MCP/CLI). At deploy time the pipeline looks up the DB by `ref`, generates a connection URL, and writes it into the service's runtime env under the `env` key. If the DB does not exist, a warning is emitted and the deploy continues without the injection.

The attach needs the same authority as attaching in the panel: the service's owner must be an operator, the database's owner, or an `admin` of the database's workspace (since 0.10.42 — a `viewer`/`member` seat used to be enough). Otherwise the attach is skipped with a deploy-log note; an attachment that already exists is left in place. A PR preview never gets a manifest-attached database (it would be production's) — see §4.11.

Two more cases are skipped with a deploy-log note: a service with no recorded owner, and a database that runs on a node while the service runs elsewhere (a managed database is reachable only from services on its own host). `env` names the variable when the attachment is first created; an attachment that already exists keeps the alias it has.

### 4.14 `network` — Publish & Aliases

```yaml
network:
  publishPort: 8080                   # host port to map (rarely needed)
  aliases:                            # additional Docker network aliases
    - api.internal
```

> **Not wired yet.** The section validates, and the deploy log says it was read
> and ignored. Publish a host port and attach networks from the panel
> (Service → Network); see §6.3. `publishPort` is the one field that
> `ninedeploy manifest apply` writes (§5); `aliases` (at most 20) is never applied.

### 4.15 `notifications` — Channel References

The manifest references notification channels **by name**; the channels themselves (Slack, Discord, email, etc.) are configured in the panel.

```yaml
notifications:
  onDeploy: ["deploys"]               # notify when a deploy succeeds
  onFailure: ["deploys", "oncall"]     # notify on failure
  onAlert:   ["oncall"]                # notify when an alert fires
```

> **Applied at deploy time, for services owned by an instance operator.** Each
> name must match a channel configured under Settings → Notifications. For
> every scope the section lists (`onDeploy`, `onFailure`, `onAlert`), those
> names replace the service's subscriptions for that scope; a scope the section
> leaves out, or lists as empty, is not touched. A name that matches no channel is reported in the
> deploy log and the other names still apply. Delivery stays additive to each
> channel's own event filter.
>
> For a service owned by anyone who is not an instance operator the section is
> ignored with a deploy-log note, because channels are operator configuration.
> Any subscriptions an earlier deploy created for the service are removed. Ask
> an operator to include the service's events in a channel's event filter
> instead. Each list takes at most 20 names.

### 4.16 `alerts` — Monitoring Rules

```yaml
alerts:
  - when: highMemory
    channel: oncall
    thresholdPct: 85                  # required for highMemory / highCpu
  - when: highCpu
    channel: oncall
    thresholdPct: 90
  - when: deployFailed
    channel: deploys
  - when: restartLoop
    channel: oncall
  - when: certExpiry
    channel: oncall
  - when: highErrorRate               # % of requests answered 5xx
    channel: oncall
    thresholdPct: 5
  - when: slowResponses               # p95 response time
    channel: oncall
    thresholdMs: 1000
```

`thresholdPct` (1–100) is required for `highMemory`, `highCpu` and
`highErrorRate`. `thresholdMs` (1–600000) is required for `slowResponses`.

The **metric** triggers become `alert_rules` rows on the service:
- `highMemory`: memory above `thresholdPct` of the memory limit; skipped when the service has no limit.
- `highCpu`: CPU above `thresholdPct`.
- `highErrorRate` and `slowResponses`: the share of 5xx answers, or the p95
  response time, over the last 5 minutes of traffic analytics
  ([OBSERVABILITY.md](OBSERVABILITY.md#error-rate-and-latency-alerts)). They
  only sample while traffic analytics is on and the service had at least 20
  requests in the window.

`certExpiry` is tracked host-wide, so a service rule could never fire; it is
reported as skipped (an operator adds a host-wide cert-expiry rule under
Monitoring). `deployFailed` and `restartLoop` are events, not thresholds the
alert engine can sample, so they are reported as skipped in the deploy log
rather than written out. (They used to be stored as a `cert-expiry` rule with a
threshold of 0 — a rule that renders in Monitoring like a configured alert and
can never fire.)

`channel` is recorded in the generated rule *name*, which is what lets two
alerts with the same `when` coexist. It does not route the alert: delivery
follows the per-channel event filters in Settings → Notifications.

An `alerts` section is the source of truth for the manifest-owned rules, which
are named `svc-<service id>-<when>-<channel>`: a rule the section no longer
declares (removed, re-pointed to another channel, or skipped) is deleted on the
next deploy. An absent section leaves every rule alone, and rules created in
the panel are never touched. A manifest may declare up to 20 alerts.

---

## 🛠️ 5. CLI Usage

The `ninedeploy` npm package ships four subcommands under `ninedeploy manifest`. The first three need no server; `apply` calls the panel.

```bash
ninedeploy manifest init               # detect project kind, write a starter .ninedeploy
ninedeploy manifest validate           # parse + schema check the file in cwd
ninedeploy manifest show               # human-readable summary of the parsed manifest
ninedeploy manifest apply <service-id> # write the build and run settings to a service
```

- `init` auto-detects the project kind (Node/pnpm, Node/npm, Python, Go, Vite, Unknown) from the files in `cwd` and writes a starter. The kind can be overridden interactively. It asks for the file name (default `.ninedeploy`) and refuses to overwrite an existing manifest. To start from a panel template instead, run `ninedeploy templates init <template-id> --write`.
- `validate` exits non-zero on schema or YAML errors, and on a secret-pattern match: it runs the same scan as the deploy (§2) before the schema check. Add it to CI before pushing.
- `show` prints a key/value summary; useful for debugging what the pipeline will read. It works without a server. Secret-pattern matches are printed as a warning and still give a non-zero exit code.
- `apply <service-id>` reads the manifest in the current directory and sends it to the panel (`POST /v1/services/:id/manifest/apply`, SDK: `client.services.manifest.apply(serviceId, { manifest })`). It needs the `admin` role on the service, and the service must already have a build config. It writes the `build` section (install, build, start, base directory, Dockerfile path), the `run` section (port, health path, restart policy; giving `restart` also raises the stop grace period to 30 seconds) and `network.publishPort` into the service and its build config. Every field the manifest supplies **overwrites the panel's value**; fields the manifest omits are left alone. That is the opposite of the deploy-time rule in §3. It does not deploy, and it does not touch `runtime`, `phases`, `resources`, `routes`, `alerts`, `database`, `previews`, `notifications`, `volume.backups` or `watch`: those are applied on each deploy (§6). Reserved ports are refused for everyone, and a port below 1024 needs an instance operator. A manifest with a secret-pattern match is refused before anything is sent. **Manifests are also applied automatically on each deploy** by the deploy pipeline (§6).

---

## 🖥️ 6. How the Pipeline Applies the Manifest

### 6.1 Build Stage (Nixpacks)

`apps/server/src/lib/ninedeployToNixpacks.ts` translates the manifest into a `nixpacks.toml` that the Docker builder writes next to the checked-out source (inside `build.baseDir`) before invoking Nixpacks. If your repository already ships a `nixpacks.toml`, it is left untouched — a hand-written file is the more specific choice — and the manifest's `runtime`/`phases` are skipped with a log line.

The mapping is:

| Manifest field | nixpacks.toml key |
| :--- | :--- |
| `runtime.type` + `version` | `NIXPACKS_<TYPE>_VERSION` in `[variables]`. Version pins go through the provider's environment variable, never through a hand-built nixpkgs attribute: `nixPkgs` *replaces* the provider's package list, and the attribute would resolve against the provider's pinned (old) archive. A pin Nixpacks cannot express becomes a warning instead of a broken build. |
| `phases.setup.pkgs` | `nixPkgs += […]` (additive) |
| `phases.build.cmds` | `[phases.build].cmds += […]` |
| `build.install` | `[phases.install].cmds = ["npm ci"]` |
| `build.build` | `[phases.build].cmds` (prepended) |
| `build.start` | `[phases.start].cmd = "npm start"` |

`build.dockerfile` short-circuits the Nixpacks path entirely: the image is built from your Dockerfile, so `runtime` and `phases` have no effect. Everything that does not shape the image still applies — `run`, `resources`, `routes`, `alerts`, `database`, `previews`, `notifications`, `volume.backups` and `watch`, plus the `env.required` warnings.

The same holds for the other build packs. The builder picks one strategy per service: the static pack, Railpack, Cloud Native Buildpacks, a Dockerfile, or Nixpacks. This step runs only for Nixpacks, so a service on any other pack ignores `runtime` and `phases` without a warning.

The generated file starts with a marker line saying NineDeploy wrote it. When the manifest stops yielding one (the `runtime`, `phases` and `build` command fields were removed, or the file is gone), the builder deletes the file it generated on an earlier deploy, so a stale one never builds again.

### 6.2 Deploy Stage (Pipeline)

Two things happen, in this order.

**PREPARE** — `apps/server/src/lib/applyManifestToService.ts` writes real rows:

| Manifest field | Pipeline action |
| :--- | :--- |
| `routes[]` | upsert into `domains` (one row per host, with path/SSL/headers/CIDR/rate-limit) |
| `alerts[]` | upsert into `alert_rules`, one row per **metric** alert (`highMemory`, `highCpu`, `highErrorRate`, `slowResponses`); the host-wide `certExpiry` and the event-shaped `deployFailed` / `restartLoop` are reported as skipped |
| `database` | look the DB up by `ref` and attach it, injecting the connection URL into the service env |
| `previews` | write `enabled`, `pattern`, `maxActive` and `autoDestroyOnClose` onto the service row |
| `notifications` | resolve channel names into per-service subscriptions (operator-owned services only) |
| `volume.backups` | create or update the `volume-backups (manifest)` scheduled job |
| `watch` | write the paths into the watch-path filter of the service's active webhooks |

This stage is best-effort: a refused route or an unknown channel becomes a
`.ninedeploy note` line in the deploy log and the deploy goes on. A manifest
that fails to load (too large, a secret pattern, bad YAML, a schema error) is
reported as `warning: .ninedeploy apply failed` and the deploy continues
without it.

**BUILD** — `apps/server/src/lib/ninedeployApply.ts` folds the build-shaping
sections into the effective configuration for this one deploy (nothing is
persisted — the manifest travels with the commit, so the next deploy re-derives
it):

| Manifest field | Pipeline action |
| :--- | :--- |
| `build.install` / `build` / `start` / `baseDir` / `dockerfile` | fill the matching `BuildConfig` fields when the panel left them empty |
| `run.port`, `run.healthcheck` | fill the service port / health path when unset |
| `run.restart` | fill the container restart policy while it is still at the default |
| `resources.cpuShares`, `resources.cpuLimitMilli`, `resources.memMb` | fill the limits while the panel has them at 0 (unlimited) |
| `resources.replicas` | raise the replica count while the panel has 1 and the manifest asks for more |
| `env.required[]` | each missing key becomes a deploy-log warning |
| `runtime`, `phases` | rendered into `nixpacks.toml` (§6.1) |

Every value the manifest applies is announced in the deploy log, so a build
never silently differs from what the panel shows; the two fields no code reads are
the exception (§6.3).

### 6.3 What the Manifest Deliberately Cannot Do

**`hooks` is ignored, on purpose.** Deploy lifecycle hooks (`preBuild`,
`postBuild`, `preStop`) execute on the **host**, not inside your container —
which is why the panel restricts them to instance operators
(`lib/hostPrivilege.ts`). That check reads the stored build config *before* the
deploy starts, so honouring a hook that arrived with the commit would let
anyone able to push to the repository run commands on the host and step outside
container isolation. A manifest that declares `hooks` gets a deploy-log warning;
set them in Service → Settings instead.

The remaining stubbed sections (also emitted as deploy warnings) are:

- `static`, `network` — configure these through the panel for now

Two more fields are read by nothing and give no warning: `env.aliases` (§4.5)
and `volume.mount` (§4.12).

(`watch` is wired: on every deploy of a repository that carries a non-empty
`paths` list, the paths replace the watch-path filter of the service's active
webhooks. A push that changes no matching file is then skipped at the webhook,
before a deploy is queued — see §4.9.)

(`previews` is wired since r079: the section's values are applied onto the
service row at deploy time, alongside the panel's own preview settings. The
wildcard-zone constraint is still enforced at routing time, so a pattern is
never trusted until it renders inside the instance's own zone; since r602 the
same check runs when the section is applied, and a pattern that fails it is
left out with a note — see §4.11.)

(`notifications` is wired since r080: channel NAMES resolve to per-service
subscriptions — `onDeploy`, `onFailure` and `onAlert` each replace that
scope's subscriptions at deploy time, and delivery is additive to each
channel's own global event filter. A name that matches no channel is
reported as a deploy warning; the other names still apply. Since 0.10.42
(r652) the section applies only to services owned by an instance operator —
channels are operator configuration — and for any other owner it is ignored
with a deploy-log note, and subscriptions an earlier deploy created stop
delivering.)

(`volume.backups` is wired since r081: the declared cron becomes the
service's manifest-owned `volume-backups (manifest)` scheduled job — never
touching jobs the operator created themselves. The job scheduler picks the
job up within its regular 5-minute reload. Retention stays the
instance-wide keep-count; the declared per-service retention value is
reported as not-yet-applied in a deploy warning. An invalid cron expression
creates or changes nothing and is reported loudly.)

---

## 🧑‍🎨 7. Manifest Creator (Web UI)

The **Deploy → Manifest Creator** page in the web panel is a guided form for editing a manifest without writing YAML by hand. It is divided into two columns: a left-side outline of the 16 sections (with a filled/dot indicator per section) and a right-side editor with the active section's controls.

Capabilities:

- **Starter presets** replace the form state wholesale, and Undo brings the previous draft back: Blank, Node (npm), Node (pnpm), Node API (Express), Next.js, Static SPA (Vite), Python, FastAPI, Django, Go, Rust, Ruby on Rails, Laravel (PHP), Java (Gradle), Monorepo service, Background worker and API + managed DB. Every Node preset (including Monorepo service, Background worker and API + managed DB) and the Python and Go presets pin the catalog's recommended version (§4.1); Rust, Ruby on Rails, Laravel and Java set a type without a version, and Blank and Static SPA declare no runtime. The Node, Python and Go labels carry that version. Some presets emit sections the deploy ignores: the Vite preset's `static`, and the worker preset's `hooks` and `restartLoop` alert (§6.3).
- **Drafts autosave** to `localStorage` under `ninedeploy.manifest.draft`; the form rehydrates on reload. **Undo / Redo** walk back through the last 50 changes, and **Reset** returns to the empty starter (it can be undone). The active section is remembered under `ninedeploy.manifest.section`.
- **Live validation**: every change is checked with the same Zod schema the deploy uses, and a section with an issue is marked in the outline.
- **Import** loads an existing `.ninedeploy` file back into the form.
- **Live YAML preview** in a modal, with syntax highlighting and a client-side secret scan. The scan uses the server's own pattern list (§2) on the form's values and names the field that matched, so it flags the operator early, before the server-side scan refuses at deploy time.
- **Copy YAML / Download / Reset** in the page header; Copy and Download again in the preview. Download writes a file named `.ninedeploy`.
- **Service prefill**: opening the creator from a service detail page (via the "Open in Creator" button on the **Manifest & Traefik** tab) pre-seeds `run.port` and `run.healthcheck` from the service's panel config, but only when the form is still the empty starter — manual edits are not clobbered.
- **Generate manifest**: describe the app in plain language (at least 10 characters) and the panel's configured AI provider returns manifest sections that are merged over the draft: a section it returns replaces yours, the others survive, and Undo brings the old draft back. It needs the AI provider configured first (see [AI.md](./AI.md)).

The form itself is client-side: apart from the description typed into **Generate manifest**, nothing entered in it is sent to the server. The operator copies the YAML into `.ninedeploy` at the repo root and commits it.

---

## 🩺 8. Validation

### 8.1 Schema

Every field is validated against the Zod schema in `@ninedeploy/schemas`. Unknown keys fail with `path: "<section>"` and a message naming the unexpected key. Numeric ranges (ports, CPU shares, retention days, etc.) are bounded; out-of-range values fail with the constraint in the message.

### 8.2 Secret Scan

The server-side scanner runs on the raw file before validation; the client-side scanner (Manifest Creator preview) runs on the formatted YAML. Both redact matched values in the error output (first 4 + last 2 chars, with full length).

### 8.3 Size Limit

Files larger than 16 KiB are refused with `ManifestTooLargeError`. The manifest is meant to be a thin pointer to behavior, not a dump of config — keep bulky or generated configuration out of the repository and set it in the panel.

---

## 🧪 9. End-to-End Example

A minimal Node + Postgres service:

```yaml
version: "1"

runtime:
  type: node
  version: "24"

build:
  install: "npm ci"
  build: "npm run build"
  start: "npm start"

run:
  port: 3000
  healthcheck: "/healthz"
  restart: unless-stopped

env:
  required:
    - DATABASE_URL
    - STRIPE_SECRET_KEY
  aliases:
    POSTGRES_URL: DATABASE_URL

watch:
  paths:
    - "apps/api/**"
    - "packages/shared/**"

routes:
  - host: api.example.com
    path: /
    ssl: true
    headers:
      X-Frame-Options: DENY
    ipAllowlist:
      - 10.0.0.0/8

previews:
  enabled: true
  pattern: "pr-{n}-{{slug}}.{{domain}}"
  maxActive: 3
  autoDestroyOnClose: true

volume:
  mount: "/var/lib/api/uploads"
  backups:
    schedule: "0 3 * * *"
    retention: 14

database:
  ref: primary-postgres
  env: DATABASE_URL

notifications:
  onDeploy: ["deploys"]
  onFailure: ["deploys", "oncall"]

alerts:
  - when: highMemory
    channel: oncall
    thresholdPct: 85
  - when: deployFailed
    channel: deploys
```

What happens on push:

1. Webhook fires; the watch-path filter the manifest wrote to the webhook at
   the previous deploy (§4.9) matches the diff → deploy starts.
2. The docker builder generates `nixpacks.toml` with `NIXPACKS_NODE_VERSION = "24"`, the install/build/start cmds, and any `phases.build.cmds`.
3. The container boots on port 3000; `/healthz` is probed; Traefik routes `api.example.com` to it.
4. The `primary-postgres` DB is looked up; its connection URL is injected as `DATABASE_URL` (the name given by `database.env`).
5. One alert rule is upserted in `alert_rules` (`highMemory`); `deployFailed` is reported as skipped (§4.16).
6. Deploy success and failure reach the `deploys` channel, and failure also `oncall`, as far as each channel's event filter allows; the memory alert follows the channel filters too.

---

## 🛟 10. Troubleshooting

| Symptom | Likely cause | Fix |
| :--- | :--- | :--- |
| Build picks the wrong Node version | `runtime.version` not set and Nixpacks auto-detected a different version | Add `runtime: { type: node, version: "24" }` |
| `npm ci` fails with `package-lock.json not found` | Lock file not committed | Run `npm install` locally and commit the lock file |
| Route 404s after deploy | `routes` not declared and panel is empty for that service | Add a `routes[]` entry, or set the domain in the panel |
| `ManifestSecretError` on a deploy | Manifest contains a literal token | Move the value to the panel env vault; reference by name in `env.required` |
| DB not attached after deploy | `database.ref` does not match any managed DB slug | Verify the slug in the panel Databases tab; the pipeline logs the missing slug as a warning |
| Deploy log says `previews.pattern … not applied` | the pattern lacks `{{slug}}` or `{{domain}}`, or renders outside the wildcard zone | Use `pr-{n}-{{slug}}.{{domain}}`; a pattern without `{n}` fails validation instead |
| Volume backups never run | `volume.backups.schedule` is not a valid cron | Standard 5-field cron only; the panel validates the same string |
| Modal closes on first Tab press | Focus trap fires on `initialFocusRef` with disabled children | Ensure the ref'd element is enabled; the trap falls back to the first focusable in the panel |

For deploy-time issues that aren't in this list, see [docs/TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

---

## 📚 11. Related Documents

- [docs/DEPLOYMENTS.md](./DEPLOYMENTS.md) — Blue-green releases, rollbacks, previews
- [docs/DATABASES_BACKUPS.md](./DATABASES_BACKUPS.md) — Managed DBs + backup destinations
- [docs/TRAEFIK_INGRESS.md](./TRAEFIK_INGRESS.md) — Routing layer
- [docs/QUICKSTART.md](./QUICKSTART.md) — First-deploy walkthrough
- [docs/TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — Common failure modes
