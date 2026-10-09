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
- Since 0.10.42 a preview also never receives the parent project's shared **secret** env vars, any vault reference (`${{provider:KEY}}`), or a database the production service is attached to (including the one a `.ninedeploy` `database:` section names). Each deploy log lists what was withheld, by name. To give a preview its own values, use the parent's preview-only env set (below), set env vars directly on the preview service, or attach a separate non-production database to it under Service → Databases (needs `admin` on that database).
- **Preview-only env (0.12):** a git-backed service has a second env set, edited under Service → Environment → **Preview deployments** (API `GET/POST /v1/services/:id/env/preview`, `PATCH/DELETE /v1/services/:id/env/preview/:varId`; SDK `previewEnv.*`; CLI `ninedeploy env list|set|rm … --preview`). Its values:
  - reach **only** that service's PR previews — the production service never receives them;
  - override, inside a preview, any value of the same key the preview inherited (the parent's non-secret env, project-shared non-secret env); attached managed databases still win, as they do over normal env;
  - are read at every preview deploy, so an existing preview (including one created before 0.12) picks a change up on its next deploy;
  - may be secrets (encrypted at rest and write-only like normal secrets) but may not be vault references — a preview never resolves one.
  The parent's own secrets are still never copied into a preview. Values in this set ARE handed to code from a pull-request branch, so put test or staging credentials here, never production ones. Reading needs `viewer` on the service (secret values masked), writing needs `member`; every change is audited (`env.preview.create|update|delete`, key only). The set is not part of a `.ninedeploy` manifest (manifests never carry env values), of a service clone, of a cross-server service migration bundle, or of the `/env/export` download. Deleting the service deletes its set.
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

## 🐝 7. Docker Swarm (opt-in per service)

Swarm spreads a docker service's replicas across the panel host and the
NineDeploy nodes that joined it. Nothing changes until an operator opts in:
every service keeps running plain containers, and the panel never touches
Swarm on its own.

**Turning it on (operator):**

1. `POST /v1/swarm/init` with `{advertiseAddr}` runs `docker swarm init` on the
   panel host. It needs an interactive session and your password (step-up),
   refuses a daemon that is already in a swarm, and checks that the swarm can
   create an encrypted overlay network.
2. `PUT /v1/swarm/settings` with `{enabled: true}` (step-up) allows Swarm deploys.
3. `POST /v1/servers/:id/swarm/join` joins a node as a worker through its agent
   (agent v0.15.4 or newer, sealed transport). The join token is read on the
   panel and sent to the node only; it is never stored, logged or returned.
   `POST /v1/servers/:id/swarm/leave` drains the node first.
4. `PUT /v1/services/:id/placement` with `{orchestrator: "swarm"}`, then deploy.

**How a Swarm service runs:** one stack `nd-<slug>` with one service
`nd-<slug>_web`, applied with `docker stack deploy` on every deploy (env,
replicas and limits all apply). Updates roll one task at a time, start-first,
and Swarm rolls a failed update back; if the panel's probe through Traefik fails
after the update, the panel rolls the service back to its previous spec and the
deployment is marked failed. Traefik is the only ingress: it joins the
service's overlay `nd-swarm-<slug>` and routes to the service's virtual IP. No
port is published on the Swarm ingress mesh.

- **Images:** an image release is pulled by every node (`--with-registry-auth`).
  A repository is built on the panel (or on a build server). With a push
  registry (Service → Settings → Build) every node pulls it by digest; without
  one the image is copied to each NineDeploy node in the swarm, and any node that
  cannot receive it is labelled `nd.preload.<slug>=0` so no task lands there.
- **Environment** reaches Swarm through a temporary 0600 env file, never a
  command line. Docker keeps it in the service spec, which `docker service
  inspect` shows to anyone with access to the daemon, the same people who can
  inspect a container. A value that spans several lines is refused.
- **Refused on Swarm:** compose stacks, PM2, a service pinned to a node, the
  persistent volume and volume attachments (named volumes are per node), the
  Docker socket, a published host port, managed databases, and fan-out targets.
  A PR preview of a Swarm service runs as a normal container.
- **Logs** come from `docker service logs`; **restart** is a rolling restart;
  **stop/start** scale the service to 0 and back; the **terminal** opens a task
  on the panel host, or says which node runs the replica; **stats** cover the
  tasks on the panel host.

**Network and firewall.** NineDeploy's overlays always encrypt their traffic
(IPsec), and there is no setting to turn that off. Between all swarm hosts
allow: 2377/tcp (management), 7946/tcp and 7946/udp (gossip), 4789/udp (overlay
traffic) and **ESP, IP protocol 50** (the encryption). Restrict these to the
cluster's own hosts. Encrypted overlays do not work on Windows nodes. An
overlay `nd-swarm-<slug>` created without encryption before is reported on
the deploy log and left in place, because recreating it would cut off the
running tasks. Remove the stack and the network during a maintenance window
to get an encrypted one.

**Leaving Swarm:** set the orchestrator back to `container` and redeploy. The
container goes live first; then the stack and its overlay are removed.
