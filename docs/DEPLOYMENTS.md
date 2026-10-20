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

### Canary releases (0.16.9)

With a canary configuration (**Service → Settings → Canary releases**, or `canary` on `PATCH /v1/services/:id`), step 4 happens in stages instead of all at once. After the new container passes its healthcheck:

1. Traefik sends the first step's share of requests to the new release (for example 10 %) and the rest to the previous one. Every routed domain of the service is split the same way.
2. The step runs for `stepSeconds` (30–3600, default 120). The new release's healthcheck is probed every 15 s.
3. At the end of the step, the step is judged. With traffic analytics on (**Traefik → Traffic**, an operator setting), the new release fails a step when:
   - more than `maxErrorRate` percent (default 5) of its responses are 5xx, or
   - its p95 response time is over `maxP95Ms` (off by default).

   Both need at least `minRequests` requests (default 20) to the new release in that step; with fewer, the step passes on its healthcheck. With traffic analytics off, every step is judged on the healthcheck only, and the deploy log says so.
4. The next step follows (`steps`, up to 5, rising, 1–99 %; default `10, 50`). After the last one, all traffic switches to the new release and the previous container stops, as in a normal deploy.

A failed step sends all traffic back to the previous release, stops the new container and fails the deploy with the reason, for example `Canary aborted: at 10%, 12% of 240 requests failed with a 5xx (the limit is 5%)`. Notifications and alert subscriptions get it as a failed deploy.

While a canary runs:
- **Promote** (`POST /v1/services/:id/deploys/:depId/canary/promote`) skips the remaining steps and switches all traffic now.
- **Cancel** stops it: all traffic goes back to the previous release.
- `GET /v1/services/:id/canary` shows the step, the share and each release's requests, 5xx rate and p95 so far.
- With sticky sessions on, a visitor stays on one release (cookie `ninedeploy_release`).

A deploy switches all traffic at once, and its log names why, when:
- it is a rollback;
- the service has no previous release or no routed domain;
- it publishes host ports (the previous release is stopped before the new one starts);
- it runs on a node or on Swarm. Canary releases are for docker services on the panel host for now. A panel-host service that also fans out to nodes splits the panel's traffic only; the nodes get the new release when the canary has finished.

The traffic log is read every 10 s, so the last few seconds of a step can count towards the next step. Nothing about a canary is stored: a panel restart during one fails that deploy (as any interrupted deploy), removes the new container, and routes everything to the previous release.

### Healthcheck timeout (0.16.1)

The gate in step 3 accepts any answer below 500 on the health path and waits **300 seconds** by default. Set **Service → Settings → Healthcheck timeout** (`healthTimeoutSeconds`, 10–3600) for an app whose first boot runs long migrations or downloads a model; leave it blank for the default. A failed deploy names the limit it hit. The old container keeps serving until the new one passes.

### Healthcheck command (0.16.3)

When an HTTP answer does not prove the app is ready (a database, a worker that needs its queue, an app that answers before its migrations finish), set **Service → Settings → Healthcheck** to *Command inside the container* and give a command, for example `pg_isready -U app` or `curl -fsS localhost:3000/up`. The deploy runs it with `sh -c` inside the new container every 2 seconds (each attempt limited to 10 seconds) until it exits 0, within the healthcheck timeout above. A failing attempt's output goes to the deploy log, and the container exiting fails the deploy at once.

- The image needs a shell (`sh`); a distroless image cannot run it.
- Docker services only. On a node (0.16.4, the node agent must be 0.16.4 or later) and on Swarm the command runs as the container's own Docker healthcheck (`CMD-SHELL`, every 5 seconds, 10 seconds per attempt, unhealthy after 3 failures in a row) and the deploy waits until Docker reports the container healthy; it keeps running after the deploy, so `docker ps` shows the container's health. A node whose agent is older is refused when the deploy is queued, with the update named. Fan-out nodes run it the same way.
- API: `healthCheck: 'command'` with `healthCommand` (one line, up to 1000 characters) on `PATCH /v1/services/:id`. PR previews and clones keep it.

### Docker labels (0.16.3)

**Service → Settings → Docker labels** puts your own labels on the container, one `key=value` per line, for tools on the host that read them (Prometheus or Vector service discovery, backup agents, cost tagging). They apply on the next deploy and on every replica.

- Up to 50 labels; keys use letters, digits and `. _ / -`; values are one line of up to 1000 characters.
- `ninedeploy.*` (the panel finds and cleans up its containers by them), `com.docker.*` and `traefik.*` are reserved. Routing does not read labels here: the panel's Traefik uses its file provider.
- Docker services only: on the panel host, on a node (0.16.4, the node agent must be 0.16.4 or later; an older one is refused when the deploy is queued, with the update named), on fan-out nodes, and on Swarm (0.16.4, on each task container).
- API: `dockerLabels` (an object; `{}` clears) on `PATCH /v1/services/:id`. PR previews and clones keep them.

### Container options (0.16.1, operator only)

**Service → Settings → Container options** adds these to a docker service's container, on its next deploy:

| Option | Docker flag | Typical use |
| --- | --- | --- |
| GPUs | `--gpus all` / `--gpus <n>` | Ollama, vLLM, Stable Diffusion (needs the NVIDIA container toolkit) |
| Shared memory | `--shm-size <n>m` | Chromium / Puppeteer, PyTorch data loaders |
| Init process | `--init` | apps that spawn children and leave zombies |
| Open files limit | `--ulimit nofile=<n>:<n>` | databases, proxies, file watchers |
| Extra capabilities | `--cap-add` | `NET_ADMIN`/`NET_RAW` (VPN, ping), `SYS_PTRACE` (profilers), `SYS_NICE`, `SYS_RESOURCE`, `IPC_LOCK` (mlock), `SYS_TIME` |

- These are structured fields, not free-form flags: privileged mode, host mounts and the host network cannot be requested, and capabilities that lead out of the container (`SYS_ADMIN`, `SYS_MODULE`, …) are not offered.
- Only an operator changes them; members see them and can redeploy. A member's clone and every PR preview start without them.
- They apply on the panel host, and (0.16.6) on a node and each fan-out target whose agent is 0.16.6 or newer (capability `docker.runtimeOptions`). A node's owner can refuse them with `NINEDEPLOY_AGENT_RUNTIME_OPTIONS=off` on the agent. On an older agent, a switched-off one, or a Swarm service, the container starts without them, as before 0.16.6, and the deploy log says why; such a deploy is never refused for them. GPUs need the NVIDIA container toolkit on the node itself.

### Port mappings: UDP, ranges and a dedicated IP (0.16.1)

Traefik carries HTTP(S) and the TCP routes in front of a service. Anything else (game servers, VoIP/RTP, DNS, WireGuard, syslog) needs the host port itself. **Service → Network → Port Mappings** publishes extra host ports straight to a docker service's container:

| Field | Example | Meaning |
| --- | --- | --- |
| Host IP | empty, `203.0.113.7`, `2001:db8::7` | Empty listens on every address of the host; an IP dedicates that address to these ports |
| Host ports | `27015` or `27015-27030` | One port or a range |
| Container port | empty or `27015` | Where the range starts inside the container; empty = the same numbers |
| Protocol | UDP / TCP | One protocol per rule; add a second rule for both |

Each rule becomes one `docker run -p` operand (`-p 203.0.113.7:27015-27030:27015-27030/udp`), and the compose bridge renders the same `ports:` entries. From a terminal: `ninedeploy services ports <id> 27015-27030/udp 203.0.113.7:53/udp` replaces the list, `--clear` removes it, and no mapping lists it. API: `portMappings` on `PATCH /v1/services/:id` and the service response.

- Up to 20 rules and 1000 host ports per service. Docker runs one proxy process per published port and protocol, so a 10 000-port RTP range would cost 10 000 processes on the host.
- The rules of one service may not overlap on the same address and protocol. Saving a port another panel-host service or a database's public access already holds is refused with the owner's name (409). The same port on two different IPs is allowed.
- The single direct host port (Network → Direct Host Port Publishing) is held to the same rule now: a port another service on the same host (the panel host, or the same node) already publishes is refused when it is saved or the service is created, instead of failing the first deploy with "port is already allocated".
- The same privilege rules as the direct host port: ports below 1024 need an operator, and the panel's port, 22, 80 and 443 are refused for every protocol.
- **Several IPs on one server** (Settings → Security → IP addresses, operator; `GET/PUT/DELETE /v1/host-ips`, CLI `ninedeploy ips list|set|forget`). The panel reads the host's addresses and lets an operator label them, mark one as **primary** and **dedicate** one to a docker service on the panel host.
  - The primary address is the one DNS records should point at: the Deploy Wizard names it in its DNS hint (an AAAA record for IPv6), and Settings → Automatic URLs offers it as the sslip.io address.
  - A dedicated address can only be chosen by that service in its port mappings; every other service is refused it (409), and the Host IP field no longer offers it to them. Services that publish on every address still listen on it for their own ports. Dedicating is refused while another service binds the address explicitly. Deleting the service shares the address again.
  - Nothing is saved until an operator changes something, so an upgraded panel behaves exactly as before.
- The Host IP field offers the panel host's own addresses (`GET /v1/services/:id/host-addresses`, read with `ip -o addr` in a host-network container, so it works for both the systemd and the Docker install). Saving an IP the host does not have is refused (`host_ip_unknown`); when the host cannot be asked, any address is taken and Docker refuses a wrong one when the container starts.
- The next deploy applies a change. A service with host ports cannot run blue-green: Docker binds a port once, so the old container stops before the new one starts. Replicas get none of the ports; only the primary publishes them.
- **A service with no HTTP or TCP port** (a UDP game server, VoIP, a queue worker) would fail the deploy healthcheck, which probes the container port. Set **Service → Settings → Healthcheck** to *Container running*: the deploy then only waits for the container to stay up for 10 one-second samples without a restart, and fails at once if it exits. The Port Mappings card offers the switch when only UDP is published. API: `healthCheck: 'http' | 'running'` on `PATCH /v1/services/:id`; PR previews and clones keep it. Remote nodes already check "running and stable".
- A node-pinned service publishes them on its node. The node's agent must advertise `docker.ports` (v0.16.1); an older one is told to update before anything reaches the node. On a node the agent's own port is reserved too, the Host IP field offers no suggestions (the panel cannot read a node's interfaces), and moving a service to another host re-checks its ports there. Swarm services are refused (Traefik is the only ingress there), and a fan-out target deploys without them and says so in its log.
- Docker publishes ports through its own iptables chain, ahead of `ufw`, so a rule on the panel's Firewall page does not close a mapped port. To limit who reaches a **single TCP port**, give it an **allow list** (the "allow from" field, `5432@10.0.0.0/8,203.0.113.4` in the CLI, `allowFrom` in the API): the container then does not publish that port; a small Traefik proxy (`nd-portproxy-<slug>`, on the service's own bridge, every capability dropped) publishes it and forwards only connections from those addresses or CIDR ranges (`/0` refused). The proxy follows each deploy to the new containers, replicas included, and is recreated only when its port list changes; the allow list itself applies without a restart. UDP and port ranges cannot be filtered this way (refused), so restrict those with the cloud provider's firewall or the Host IP field. Panel host only; deleting the service removes the proxy.

---

### File mounts (0.16.3)

**Service → Volumes → Files** keeps text files the container reads, such as an `nginx.conf`, a `config.yaml` or a CA bundle, without baking them into the image. Each file has a path inside the container and its content; the panel stores the content encrypted (like an environment variable) and mounts the file **read-only** at that path. A change applies on the next deploy.

- Up to 20 files per service, 256 KiB each. The path must be absolute, name a file (not a directory), contain no `:` (0.16.5; Docker's `-v` splits on it, so such a path never mounted), and stay out of what Docker manages (`/proc`, `/sys`, `/dev`, `/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf`, the Docker socket). It may not be the path of the service's data volume or of an attached volume.
- Each deploy writes its own copy under the data directory (`service-files/<slug>/d<deployment>/`), so during a blue-green release the outgoing container keeps the content it started with. The directories are the panel user's alone (0700), so other accounts on the host cannot read the files; the container reads them through the bind mount. The three newest copies are kept; deleting the service removes them.
- **On a node (0.16.5)**, and on each node a service fans out to, the agent writes the same copies under its home (`/var/lib/ninedeploy-agent/.agent-files/<slug>/d<deployment>/`, directories 0700) one file per request over the sealed transport, and mounts them read-only. The node needs agent 0.16.5 or newer (capability `docker.fileMounts`); an older one is refused when the deploy is queued, naming the update, before anything is written. Deleting the service removes the copies on its nodes.
- Swarm, compose and PM2 services cannot mount files: one that has them is refused at deploy time with a message, never started without them.
- Reading a file's content needs a member seat (it can hold secrets); a viewer sees the paths and sizes.
- API: `GET`/`PUT /v1/services/:id/files`, `GET`/`DELETE /v1/services/:id/files/:fileId`; SDK `services.files`.

## ⚡ 2. Pipeline Cancellation

- In-flight deployments can be safely cancelled at any stage (clone, build, image pull, healthcheck).
- The engine uses process tree termination (`tree-kill`) to ensure no orphan Docker processes or hung subshells consume resources.

---

## 🔍 3. Git Webhooks & Watch-Paths

- **Push Webhooks**: Automatic deployments on GitHub/GitLab pushes with HMAC-SHA256 signature verification.
- **Monorepo Watch-Paths**: Set glob patterns (e.g. `apps/api/**`, `packages/shared/**`). Deployments trigger only when matching files change in the commit diff.
- **CI Opt-Out**: Commits containing `[skip ci]` or `[skip cd]` in the commit message are ignored by webhook triggers.

### Git LFS (0.16.3)

A repository that keeps models, media or datasets in Git LFS checks out *pointer files* (a few lines of text) in their place. Turn on **Service → Settings → Git LFS** and each deploy replaces them with their content before the build.

- The files come from the repository's own LFS server, `<repository URL>.git/info/lfs`, with the service's Git credential (an access token or a GitHub App). A repository's `.lfsconfig` is ignored, so a repository cannot point the panel at another server. HTTPS repositories only; an SSH (deploy key) repository is refused with a message.
- Every request, including each download and each redirect to object storage, passes the same egress check as the clone (no private or link-local addresses), and the credential is sent to the repository host only.
- Each file is checked against its SHA-256 and size. Limits: 10,000 objects, 2 GiB per object, 5 GiB per deploy.
- Builds on the panel host only. A service that runs there builds there; a **node service with no build placement set builds on the panel too (0.16.5)** and the image is shipped to the node (the node needs `stream` and `image.manage`, agent 0.15.2+; checked when the deploy is queued), as with Build on: panel. A placement chosen on the node itself or on a build server clones the repository again and would get pointer files, so it is refused. Extra fan-out nodes receive the image built on the panel.
- API: `gitLfs` on `PATCH /v1/services/:id`. PR previews and clones keep it.

### Deploy without Git: uploaded source (0.16.1)

A docker service created with neither a repository nor an image builds from an archive you upload:

- **Panel:** New → **Upload source** (name, `.zip` / `.tar.gz`, optional port) creates the service and deploys the upload. Later versions go in on the service's **Deploys** tab.
- **CLI:** `ninedeploy deploy up [path] --create <name>` for a new service, or `--service <id|slug>` for an existing one. A folder is packed without `.git`, `node_modules`, `.env`, `.env.*` and common build caches; add more with `--exclude <pattern>`. A ready `.zip` / `.tar.gz` is sent as is. `--no-deploy` only uploads.
- **API:** `POST /v1/services/:id/source` with the archive as the raw body (`Content-Type: application/zip` or `application/gzip`), `?deploy=false` to only store it.

The build is the same as for a repository: a Dockerfile in the archive wins, otherwise Nixpacks (or the build pack set under Settings), and a `.ninedeploy` file is read. When the archive holds a single top-level folder (a zipped directory), that folder is the root.

| Limit | Value |
| --- | --- |
| Archive size | 100 MiB |
| Extracted size | 1 GiB (one zip member: 256 MiB; use `.tar.gz` for larger files) |
| Entries | 50 000 |
| Kept uploads per service | 5 (redeploying an older deployment rebuilds its upload while it is kept) |

Only regular files and directories are accepted: symlinks, hardlinks, devices, absolute paths and `..` are refused, as are encrypted and zip64 zips, before anything is stored. Deleting the service deletes its uploads.

Uploads build on the panel host, which keeps them. From 0.16.7 a service pinned to a remote node takes uploads too: with no build placement set, the panel builds the archive and ships the image to the node, as with Build on: panel (the node needs `stream` and `image.manage`, agent 0.15.2+; checked when the upload is sent). A placement chosen on the node itself or on a build server cannot fetch the archive, so it is refused. Extra fan-out nodes receive the same image.

### Where a deploy's variables come from

Each deploy assembles the environment in this order; a later source wins over an earlier one for the same name:

1. **Shared variables of the service's projects** (Projects → Shared variables, `/v1/projects/:id/env`). Every service in the project receives them. The service's Environment tab lists them under **From projects**, marking the ones it overrides.
2. **The service's own variables** (Service → Environment).
3. A PR preview's **preview-only** set (§4).
4. **Attached managed databases** (`DATABASE_URL` and friends).

Nixpacks, Railpack and the static pack build with the whole environment; a Dockerfile build receives only the names listed as build arguments ([PRIVATE_REPO_GUIDE.md §6](./PRIVATE_REPO_GUIDE.md#build-time-variables-0161)).

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

---

## ⏪ 5. Rollbacks & Deployment History

- Every deployment records an immutable image digest and exact configuration snapshot.
- Rollback redeploys that exact verified digest — preventing unexpected changes from floating `:latest` tags.
- Deployment history stays honest: when a new deploy goes live, older rows are settled into a `superseded` state instead of lingering as "Running", both at finalize time and during a reconciliation pass at panel boot.

### Deploy hook: redeploy from CI (0.16.2)

**Service → Settings → Deploy hook** gives the service a secret URL; a POST to it queues a deploy, the same as the Deploy button:

```bash
curl -fsS -X POST https://panel.example.com/v1/deploy-hooks/<token>
```

- It answers `202 { "deploymentId": 42 }`, or the running deployment with `"alreadyInProgress": true` when a build is already underway.
- The hook deploys **as the member who turned it on**, and every check a manual deploy makes runs again on each call: a member who lost the service (403) or whose account was deleted (404) leaves a hook that no longer works. A hook never deploys with more operator authority than the request that created it had, so one made through a scope-restricted API token stays restricted.
- Only the member it deploys as sees the URL. Another member of the service sees that a hook is on and can rotate it, which makes it theirs, running with their own access; the previous URL stops working.
- POST only, so a link preview or a crawler that sees the URL deploys nothing. Rotating gives a new URL and the old one answers 404; turning it off does the same. Treat the URL like a password.
- API: `GET`/`POST`/`DELETE /v1/services/:id/deploy-hook` (member), public `POST /v1/deploy-hooks/:token`; SDK `services.deployHook`; CLI `ninedeploy services deploy-hook <id> [--enable|--disable]`.

### Deploy status badge (0.16.1)

**Service → Settings → Status badge** gives a public SVG to embed in a README:

```markdown
[![deploy](https://panel.example.com/v1/badges/<token>.svg)](https://panel.example.com/v1/badges/<token>.svg)
```

It reads `running`, `deploying`, `failed` (the newest deployment failed, even while the previous one still serves), `stopped` or `not deployed`, and nothing else: no service name, host or commit. `?label=prod` replaces the "deploy" label. The badge is off until a member turns it on; the token is its only credential, so anyone with the URL sees the state. **New URL** rotates the token (the old URL then shows "not found"); turning it off retires the URL.

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
  Docker socket, a published host port or port mappings, managed databases, and fan-out targets.
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
