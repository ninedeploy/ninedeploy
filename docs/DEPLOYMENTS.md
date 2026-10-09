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
   create an encrypted overlay network. When the advertise address is one of
   the panel host's own interface addresses, the management port binds there
   only (`--listen-addr <addr>:2377`). Otherwise Docker's default bind stays,
   and the response carries a warning. **In a Docker install this is the usual
   case:** the panel sees only its container's interfaces, so the management
   port listens on every interface of the panel host, and you must firewall
   2377/tcp to the cluster's own hosts. The panel host's node is labelled
   `nd.member=1`.
2. `PUT /v1/swarm/settings` with `{enabled: true}` (step-up) allows Swarm deploys.
3. **On each node that should join**, its owner opts in by setting
   `NINEDEPLOY_AGENT_SWARM_MANAGER=<the panel's advertise address>:2377` in the
   agent's environment and restarting the agent (agent v0.15.4 or newer). Without
   it the agent does not offer Swarm, and the panel's join answers 422
   `node_swarm_not_enabled`, naming the variable and the value to set. The agent
   joins only that manager address, and refuses to join while
   `NINEDEPLOY_AGENT_DOCKER_SOCKET=off`, because a swarm manager can start a
   task that mounts the Docker socket. It also refuses a TLS Docker daemon
   (`DOCKER_TLS_VERIFY`, `DOCKER_TLS` or `DOCKER_CERT_PATH` set to anything,
   or an `https://` `DOCKER_HOST`) and a non-default Docker context
   (`DOCKER_CONTEXT`, or `currentContext` in the agent user's Docker config),
   so the join and the agent's other Docker calls reach the same daemon. If the
   socket is switched off on a node that is already a member, `GET /v1/swarm`
   shows a warning on that node; the node is not made to leave on its own.
4. `POST /v1/servers/:id/swarm/join` joins the node as a worker through its
   agent (sealed transport only). The join token is read on the panel and sent
   to the node only. It is never stored, logged or returned, and the agent hands
   it to its Docker daemon through the Engine API, never on a command line. The
   panel rotates the worker token after every join and every leave. Before it
   links the node to the server, the panel checks with the manager that the
   reported node id is a node's full id (not another node's hostname or an id
   prefix, which Docker would also accept), is a worker, is not the panel host
   itself, is not linked to another server, and connects from the server's
   host address. When the server's host is a hostname, it matches if it
   resolves to that address, so **this check trusts the DNS of the server's
   host name**; register nodes by IP address where you can. Only then is the
   node labelled `nd.member=1`, under the id the manager confirmed.
   `POST /v1/servers/:id/swarm/leave` removes the label, drains the node, has
   it leave, and removes it; it touches only the node with exactly that id.
   **A member server cannot be deleted** (409 `server_swarm_member`, even with
   `?force=true`): make it leave first, or it would stay in the swarm, labelled
   a member, still receiving tasks and their secrets.
5. `PUT /v1/services/:id/placement` with `{orchestrator: "swarm"}`, then deploy.

**How a Swarm service runs:** one stack `nd-<slug>` with one service
`nd-<slug>_web`, applied with `docker stack deploy` on every deploy (env,
replicas and limits all apply). Updates roll one task at a time, start-first,
and Swarm rolls a failed update back; if the panel's probe through Traefik fails
after the update, the panel rolls the service back to its previous spec and the
deployment is marked failed. Traefik is the only ingress: it joins the
service's overlay `nd-swarm-<slug>` and routes to the service's virtual IP. No
port is published on the Swarm ingress mesh. Every Swarm service requires
`node.labels.nd.member==1`, so a node that joined the swarm any other way, for
example with a leaked token, never runs a NineDeploy task.

- **Images:** an image release is pulled by every member node. A repository is
  built on the panel (or on a build server). With a push registry (Service →
  Settings → Build), every node pulls it by digest. Without one, the image is
  copied to each member node, and exactly the nodes that received it (the panel
  host included) are labelled `nd.preload.<slug>=<image id>`. The service
  requires that label, so no task lands on a node without the image.
- **Registry credentials:** each Swarm deploy gets its own temporary Docker
  client config (0700, under the data directory). When the service has a
  registry credential, the panel writes it there as a 0600 `config.json`
  (`auths` only) and passes `--with-registry-auth`; otherwise the config stays
  empty and nothing is forwarded. It never runs `docker login`, which against
  an empty config would store the password in the host's credential helper
  (wincred, osxkeychain, pass, secretservice) for every later Docker call. The
  config is removed as soon as the stack is submitted. The panel's shared
  Docker config is never forwarded to the workers.
- **Environment** reaches Swarm through a temporary 0600 env file, created
  fresh and removed after the deploy, never a command line. Left-over env files
  are swept at boot. Docker keeps the values in the service spec, which `docker
  service inspect` shows to anyone with access to the daemon, the same people
  who can inspect a container. A value that spans several lines is refused.
- **Limits:** the memory and CPU limits apply to each task. A Swarm task gets
  **no memory-swap cap** (a container's `--memory-swap` equals its memory
  limit) and **no CPU shares**: neither can be expressed in a stack file.
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
cluster's own hosts. Encrypted overlays do not work on Windows nodes. A deploy
refuses to use an existing network named `nd-swarm-<slug>` that is not an
encrypted overlay. No NineDeploy release before Swarm support created such a
network, so one that exists was made by hand or by another tool. Check that
nothing else uses it, remove it (`docker network rm nd-swarm-<slug>`) and deploy
again.

**Leaving Swarm:** set the orchestrator back to `container` and redeploy. The
container goes live first; then the stack and its overlay are removed.

## 🛰️ 8. Deploying to remote nodes

A `docker` or `compose` service with a `serverId` deploys to that node through
its agent, and the node's own Traefik routes it. What a node can do depends on
its agent version; an older agent answers `422 node_agent_outdated` with the
version to install, and nothing else changes. The full reference is
[MULTI_NODE.md](./MULTI_NODE.md). For deployments:

- **Build packs on a node** (agent v0.15.2): the panel picks the pack on its own
  checkout with the panel host's rules (a Dockerfile, a Dockerfile found in the
  repository, else Nixpacks), and the node builds it. Nixpacks and Railpack
  build on the node; Railpack's env values travel as BuildKit secrets. Railpack
  through the node's own Docker needs Docker's containerd image store (or
  `NINEDEPLOY_AGENT_BUILDKIT_HOST` on the agent); on a classic-store daemon
  the build stops with the fix, see [MULTI_NODE.md §4](./MULTI_NODE.md). The
  static pack is refused on a node.
- **Build placement** (0.15.3, operator): `PUT /v1/services/:id/placement`
  with `buildOn: panel` builds on the panel host and ships the image to the
  node; `buildOn: server` with `buildServerId` builds on a node that has the
  build-server role and ships it to wherever the service runs, the panel host
  included. The image travels over the agent's sealed stream channel, checked
  by size and sha256, or through a registry you set. Every shipment is listed
  under `GET /v1/services/:id/image-transfers`. A `null` placement builds where
  the service runs, as before.
- **Private repositories** reach a node only when the source allows it on
  nodes (step-up), or are built on the panel and shipped as an image. See
  [PRIVATE_REPO_GUIDE.md §10](./PRIVATE_REPO_GUIDE.md).
- **Volume attachments, a container command and the Docker socket** work on
  node docker services (agent v0.15.2); a missing managed volume is created on
  the node before the container starts, and before `compose up` for a stack.
- **Deploy hooks** still run on the panel host only, so a node service with a
  pre-deploy, post-deploy or pre-stop hook is refused.
- **Fan-out targets** receive the primary's image when it was built with
  Nixpacks, Railpack, the static pack or on another host, instead of a
  different build. Each target is checked on its own before anything runs
  there; a refused target is recorded with the reason and the primary is not
  affected.
- **Health** on a node is container state, not an HTTP probe through Traefik.
