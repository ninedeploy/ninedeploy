# Deployments & Pipeline Engine

NineDeploy provides a robust, zero-downtime deployment engine supporting Docker, PM2, Compose and Nixpacks builds with health checks, blue-green port flipping, rollback safety, and preview environments.

---

## 🔄 1. Blue-Green Zero-Downtime Releases

When deploying a containerized service:
1. **Parallel Build**: NineDeploy clones the git repository or pulls the specified image, building the new container without stopping the active one.
2. **Dynamic Port Binding**: The new container starts on an ephemeral port.
3. **Healthcheck Gate**: NineDeploy polls the configured health endpoint (e.g. `GET /health` returning `200 OK`).
4. **Traefik Traffic Flip**: Once the new container passes health verification, Traefik dynamically routes incoming traffic to the new container.
5. **Graceful Drain**: The old container receives `SIGTERM` and is stopped after draining in-flight requests.

---

## ⚡ 2. Pipeline Cancellation

- In-flight deployments can be safely cancelled at any stage (clone, build, image pull, healthcheck).
- The engine uses process tree termination (`tree-kill`) to ensure no orphan Docker processes or hung subshells consume resources.

---

## 🔍 3. Git Webhooks & Watch-Paths

- **Push Webhooks**: Automatic deployments on GitHub/GitLab pushes with HMAC-SHA256 signature verification.
- **Monorepo Watch-Paths**: Set glob patterns (e.g. `apps/api/**`, `packages/shared/**`). Deployments trigger only when matching files change in the commit diff.
- **CI Opt-Out**: Commits containing `[skip ci]` or `[skip cd]` in the commit message are ignored by webhook triggers.

---

## 🪟 4. Ephemeral PR Preview Environments

- Automatically deploy isolated preview environments for Pull Requests / Merge Requests.
- Each preview environment receives a unique dynamic subdomain (e.g. `pr-42.app.yourdomain.com`), constrained to the instance's own wildcard zone before routing goes active.
- Previews inherit non-secret configuration from the parent service — secrets are withheld, and the webhook response reports how many were withheld.
- Since 0.10.42 a preview also never receives the parent project's shared **secret** env vars, any vault reference (`${{provider:KEY}}`), or a database the production service is attached to (including the one a `.ninedeploy` `database:` section names). Each deploy log lists what was withheld, by name. To give a preview its own values, set env vars directly on the preview service, or attach a separate non-production database to it under Service → Databases (needs `admin` on that database). There is no preview-scoped env var set on the parent yet.
- When the PR is closed or merged, NineDeploy automatically tears down the containers, removes Traefik routes, and purges ephemeral storage.

---

## ⏪ 5. Rollbacks & Deployment History

- Every deployment records an immutable image digest and exact configuration snapshot.
- Rollback redeploys that exact verified digest — preventing unexpected changes from floating `:latest` tags.
- Deployment history stays honest: when a new deploy goes live, older rows are settled into a `superseded` state instead of lingering as "Running", both at finalize time and during a reconciliation pass at panel boot.

---

## 🧩 6. Docker Compose Stacks

A multi-container app deploys as `type: compose`. The stack runs as the compose
project `ndcmp-<slug>`; `composeService` names the service Traefik routes to and
whose healthcheck gates the deploy. There is **no blue-green** here — compose
replaces the project in place, so expect a brief gap. Compose files often
bind-mount host paths or request privileged containers, so creating and
deploying one is **operator-only**.

Three ways to get a stack in:

| Source | Where the file lives | Edit it in |
|---|---|---|
| **Git repo** | in the repository (path from the build config's *Dockerfile / compose file path*, default `docker-compose.yml`) | your repo |
| **Hub template** | shipped inside the template (`composeContent`) | reinstall from the Hub |
| **Pasted YAML** | on the service row, rewritten into the workspace before every deploy | the service's **Compose File** tab |

### Pasting a stack

New Service → Type **Compose** → **Paste YAML**. The panel analyses the file as
you type and will not let you continue until it can actually run here:

- **Refused:** `env_file:` (inline the values or add them as environment
  variables), bind-mounts with inline `content:`, a file that declares no
  services, unparsable YAML.
- **Warned, but allowed:** `external: true` (the resource must already exist),
  `network_mode: host|service:|container:` (deployed as-is, with no sandbox
  bridge attached).

`${VAR:-default}` references are offered as prefilled environment rows;
`${VAR}` references with no default must be filled in yourself, or the stack
starts with empty values.

### Generated values

`SERVICE_*` tokens are resolved once per stack and stored as ordinary
environment variables, so the same token means the same value in every service
of the file:

| Token | Value |
|---|---|
| `SERVICE_USER_*` / `SERVICE_LOWERCASEUSER_*` | 16 random alphanumerics |
| `SERVICE_PASSWORD_*`, `SERVICE_PASSWORD_<n>` | random alphanumerics (32 by default) |
| `SERVICE_PASSWORD_HEX_<n>`, `SERVICE_HEX_<n>` | `<n>` hex characters |
| `SERVICE_BASE64_<n>` | `<n>` random characters (**not** base64, despite the name) |
| `SERVICE_REALBASE64_<n>` | base64 of `<n>` random bytes |
| `SERVICE_URL_<SERVICE>[_<port>]` | the stack's public URL |
| `SERVICE_FQDN_<SERVICE>[_<port>]` | just the host of that URL |

Existing values are never rotated by a retry or a redeploy.

### Editing and repair

The **Compose File** tab (inline stacks only) saves a new revision and
optionally redeploys. The service row is the source of truth: the workspace
copy is rewritten from it before every deploy, so a deleted or hand-edited
`docker-compose.yml` in the workspace repairs itself on the next run, and an
exported service carries its stack to another host.
