# Remote nodes

A node is another host that runs the NineDeploy **agent**: the same image as the panel, started with `NINEDEPLOY_AGENT=1`. The panel drives it through typed operations over an encrypted ("sealed") transport. A `docker` or `compose` service with a `serverId` deploys to that node, and each node runs its own Traefik proxy for the services on it.

From 0.15.2 a node can do almost everything the panel host does: Nixpacks and Railpack builds, private clones with a PAT or deploy key, volumes, managed databases (0.15.3), builds on another host with image transfer (0.15.3), and Docker Swarm (0.15.4). Every one of these is opt-in, and every one needs a node agent recent enough to offer it. Until you update a node's agent, that node behaves exactly as before.

---

## 1. Enrolling a node

**Manual registration** (Servers → Add node, `POST /v1/servers {name, host, port}`, operator only). The panel generates the agent token, keeps it encrypted, and answers once with `token`, `tokenSha256` and `agentCommand`: the `docker run` line to paste on the node. That line starts `ghcr.io/ninedeploy/ninedeploy:v<panel version>` as `ninedeploy-agent`, as root, with the Docker socket, `/var/lib/ninedeploy-agent` mounted at the same path, and `NINEDEPLOY_AGENT_TOKEN=<sha256 of the token>`. The agent never holds the raw token. Then **Test** (`POST /v1/servers/:id/test`) marks the node online.

**SSH bootstrap** (`POST /v1/servers/ssh-bootstrap`) installs Docker if asked, runs the same command over SSH with a fresh token, and registers the node.

**Self-enrolment:** start the agent with `NINEDEPLOY_MASTER_URL` and `NINEDEPLOY_ENROLMENT_TOKEN` instead of a token hash. It announces itself every 60 seconds and waits for an operator to approve it. See `.env.example` for the agent's variables.

Register a node by **IP address** where you can. Swarm's join check compares the node's address with the server's host (section 8), and a hostname makes that check depend on DNS.

Keep the transport between the panel and its nodes on a private network or VPN. Operations are sealed (AES-256-GCM under a key derived from the token), and every feature that carries a secret refuses an unsealed transport, but there is no TLS underneath.

## 2. Agent versions and updates

Nodes update separately from the panel. The panel learns what an agent can do from its sealed `agent.ping` answer: the version and a list of capabilities. `GET /v1/servers` shows them per node:

- `agent: {version, capabilities, checkedAt}`, or `null` until a sealed ping answered;
- `features: {nixpacks, railpack, privateClones, volumes, databases, imageTransfer, swarm}`, with a `reason` naming the agent version to install when something is off;
- `terminal`, `isBuildServer`, `buildConcurrency`, `databases` (how many managed databases the node hosts), `swarmNodeId` and `swarmRole`.

The panel keeps the last answer in memory for up to 5 minutes, so after an agent update `GET /v1/servers` can show the previous version for that long. **Test** stores the new answer for a node that shows `agent: null`. The list is advisory: a deploy asks the agent again when it runs.

**A newer agent under an older panel changes nothing.** The 0.15.x agents keep every older operation byte-identical, so you can update agents before or after the panel, and keep a newer agent if you roll the panel back.

**To update an agent:**

- re-run the node's bootstrap from the Servers page: it replaces `ninedeploy-agent` with the panel's version, under a new token. The new container gets only the default variables, so set your switches (section 3) again; or
- on the node, `docker pull ghcr.io/ninedeploy/ninedeploy:v<version>`, then `docker rm -f ninedeploy-agent` and run the same `docker run` line with the new tag, the same `NINEDEPLOY_AGENT_TOKEN` and your switches. `docker inspect ninedeploy-agent --format '{{range .Config.Env}}{{println .}}{{end}}'` shows the current values before you remove it.

## 3. Capabilities, switches and refusals

| Feature | Capabilities | First agent | Node switch (on the agent) |
| :--- | :--- | :--- | :--- |
| Service and host terminals | `terminal`, `terminal.host` | 0.15.0 | `NINEDEPLOY_AGENT_HOST_TERMINAL=off` (host shells only) |
| GitHub App repositories | `git.credential` | 0.13.0 | — |
| Volume attachments, a container command, the Docker socket | `docker.runSpec` (+ `volume.manage` for volumes) | 0.15.2 | `NINEDEPLOY_AGENT_DOCKER_SOCKET=off` refuses socket mounts only |
| Node volumes: create, list, back up, restore | `volume.manage`, `stream` | 0.15.2 | — |
| Image transfer (build placement, fan-out) | `stream`, `image.manage` | 0.15.2 | — |
| Nixpacks builds | `build.nixpacks` | 0.15.2 | `NINEDEPLOY_AGENT_BUILDS=off` |
| Railpack builds | `build.railpack` | 0.15.2 | `NINEDEPLOY_AGENT_BUILDS=off` |
| PAT and deploy-key clones | `git.sshkey` | 0.15.2 | `NINEDEPLOY_AGENT_STATIC_CREDENTIALS=off` |
| Managed databases | `db.manage`, `stream`, `docker.runSpec`, `volume.manage` | 0.15.3 | `NINEDEPLOY_AGENT_DATABASES=off` |
| Swarm join and leave | `swarm` | 0.15.4 | **opt-in:** `NINEDEPLOY_AGENT_SWARM_MANAGER=<host:port>` |

A switch counts as off when it is `off`, `false`, `0`, `no` or `disabled`. Switching a feature off removes its capability from the ping, and the agent refuses the operation too.

What the panel answers when a node cannot do something (the agent is asked nothing but `agent.ping`, and nothing is written):

| Answer | When |
| :--- | :--- |
| `422 node_agent_outdated` | The agent predates the feature. The message names the version to install. |
| `403 node_feature_disabled` | A current agent whose owner switched the feature off. The message names the variable. |
| `422 node_swarm_not_enabled` | Swarm join on a current agent without `NINEDEPLOY_AGENT_SWARM_MANAGER`. The message names the value to set. |
| `422 node_transport_unsealed` | The panel reaches the node only unencrypted, and the feature carries a secret. |
| `502 node_unreachable` | The agent did not answer. |

The same check runs again when the deployment starts, so a node downgraded in between fails the deploy with the same message.

## 4. Builds on a node

The panel resolves the build pack on its own checkout of the commit, with the panel host's rules: a Dockerfile at the configured path, else a Dockerfile found in the repository, else Nixpacks. The node builds what the panel chose.

- **Nixpacks** builds run `nixpacks build` on the node. The service's build-time env is on the `nixpacks` command line on the node, as it is on the panel host.
- **Railpack** builds run `railpack prepare`, then `docker buildx build` with Railpack's frontend (`ghcr.io/railwayapp/railpack-frontend:v<bundled version>`, pulled on first use) on the node's own BuildKit. Env values reach the build as BuildKit secrets, never on a command line. If the node has its own BuildKit, set `NINEDEPLOY_AGENT_BUILDKIT_HOST` (for example `tcp://buildkitd:1234`) and the agent runs `railpack build` against it instead.
- **Railpack through the node's own Docker needs Docker's containerd image store.** Railpack's frontend uses BuildKit merge operations, which Docker's built-in BuildKit offers only with that store. `docker info` shows `driver-type: io.containerd.snapshotter.v1` under the storage driver when it is on; a daemon on the classic store (`overlay2`) does not. From agent v0.15.5 such a build stops before anything is built, with the fixes in the deploy log (agents v0.15.2–v0.15.4 fail later with `requested experimental feature mergeop has been disabled on the build server`). Pick one:
  - turn the containerd image store on: add `"features": {"containerd-snapshotter": true}` to `/etc/docker/daemon.json` and restart Docker. While it is on, the images and containers of the classic store are not visible to Docker (they come back when you turn it off), so plan it like a migration, and redeploy the node's services afterwards;
  - or set `NINEDEPLOY_AGENT_BUILDKIT_HOST` on the agent to a BuildKit daemon, for example `docker run -d --name buildkitd --restart unless-stopped --privileged moby/buildkit` on the node and `NINEDEPLOY_AGENT_BUILDKIT_HOST=docker-container://buildkitd`;
  - or build the service elsewhere: Build on: panel, or a build server whose Docker uses the containerd image store (section 5).
- **Agents before 0.15.2** keep the old rules: Nixpacks is refused (422), and a Railpack service builds the repository's Dockerfile instead. After the agent update such a service really builds with Railpack, which changes the image.
- **The static pack** runs its build commands on the host itself and is refused on a node. Build it on the panel (section 5).
- The first Nixpacks or Railpack build on a node pulls large base images.

## 5. Build placement and image transfer (0.15.3)

Where a docker service built from a repository is built (`PUT /v1/services/:id/placement`, operator; `GET` for anyone who can see the service; Service → Settings → Build):

| `buildOn` | Builds | Then |
| :--- | :--- | :--- |
| `null` / `target` | where the service runs (the default, unchanged) | — |
| `panel` | on the panel host, with every pack and credential the panel supports | the image is shipped to the node |
| `server` + `buildServerId` | on a node with the build-server role | the image is shipped to where the service runs, the panel host included |

- **Build-server role:** `PATCH /v1/servers/:id {isBuildServer, buildConcurrency}` (operator; concurrency 1–8, default 1). Turning it off does not change the services that build there: their next deploy fails, and never builds somewhere else. A deploy waiting for a build slot says so in its log, with how many builds are ahead.
- **Transfer:** by default the panel relays the image over the sealed stream channel: `docker save` on the build host, verified by size and sha256 on both ends, loaded on the target under `ninedeploy/<slug>:<sha7>-b<deployment id>`. The loaded image's id must match the build, and an archive carrying any other tag is refused. A failed transfer is retried once. Node-to-node transfers pass through the panel, so big images or many targets cost panel bandwidth. Each transfer is recorded (`GET /v1/services/:id/image-transfers`, `GET /v1/deployments/:id/image-transfers`).
- **Registry (opt-in per service):** set `pushRegistrySourceId` (a registry source) and `pushRepository`; the build host pushes, and targets pull by digest.
- **Retention:** a build node keeps the current build of each service and removes the previous one. The panel keeps its own prune rules.
- **Recommended for private repositories:** with `buildOn: panel`, a PAT or deploy key never leaves the panel.
- **Fan-out targets** (`PATCH /v1/services/:id/targets`) receive the primary's image when the primary was built with Nixpacks, Railpack, the static pack or on another host, instead of a different build. A target that needs a command, the Docker socket or volumes needs agent 0.15.2. Deploy hooks run once, on the panel, for the primary.

## 6. Private clones on a node

A PAT or deploy key reaches a node only when its source allows it:

1. **Allow it on nodes:** System → Sources → Allow on nodes, or `PATCH /v1/sources/:id {allowOnNodes: true, password}`. Turning it on needs an interactive session and your password; it is audited `source.allow_on_nodes`. It is off for every existing source.
2. The node needs agent 0.15.2 (`git.sshkey`) over the sealed transport, and its owner can refuse every static credential with `NINEDEPLOY_AGENT_STATIC_CREDENTIALS=off`.

Without the toggle the deploy answers `400 remote_deploy_unsupported`, naming both fixes. Per clone:

- **A PAT** travels like a GitHub App token: in the git child's environment as an `http.extraheader`, never on a command line or in `.git/config`, and redacted from the output. The user name is `oauth2` for GitLab and `x-access-token` otherwise.
- **A deploy key** is written to a fresh directory under `/dev/shm` in the agent container (0700, key 0600) for that one call and removed afterwards, also on failure. Host keys are accepted on first use (`accept-new`) into a known_hosts file of that call; nothing is pinned across deploys.
- A source that names its provider (github, gitlab, bitbucket, or a base URL) is never sent to a repository on another host. `custom` sources name no host.
- While the clone runs, the credential is on the node. A PAT is not revoked afterwards, unlike a GitHub App token. If that matters, build on the panel instead (section 5).

GitHub App repositories work on nodes since 0.13 without any toggle: [GITHUB_APP.md §6](./GITHUB_APP.md).

## 7. Volumes and databases on a node

**Volumes** live on the host of the service that uses them. Attachments, a container command and the Docker socket work for node docker services, missing managed volumes are created on the node first, and the volume routes take `?serverId=`. Details, backups and restore: [DATABASES_BACKUPS.md, "Volumes on nodes"](./DATABASES_BACKUPS.md).

**Managed databases** can be placed on a node at create time (`serverId`, operator only, fixed for the database's life). Details: [DATABASES_BACKUPS.md, "Databases on nodes"](./DATABASES_BACKUPS.md). In short:

- each one runs as `nd-db-<slug>` on its own `nd-dbnet-<slug>` network on the node; services on the **same node** that attach it are connected to that network at deploy;
- backups, policies, off-site upload, restore, drills, imports and shell terminals work; the dump files land on the panel;
- refused: attaching it to a service on another host (`409 attachment_host_mismatch`), fan-out targets of a service that uses it (`409 fanout_database_host`), Studio, PgBouncer and public access (`422 remote_database`), a client-mode terminal (`422 client_mode_unsupported`; open a shell and run the client there), adopting an existing volume, and moving it to another host;
- a node that hosts databases cannot be deleted, even with `?force=true` (`409 server_hosts_databases`).

## 8. Swarm (0.15.4)

Swarm is opt-in on **both** sides: an operator initialises and enables it on the panel host, which is the only manager, and each node's owner allows its node to join by setting `NINEDEPLOY_AGENT_SWARM_MANAGER=<the panel's advertise address>:2377` on the agent. The agent then joins that manager only. It refuses to join while `NINEDEPLOY_AGENT_DOCKER_SOCKET=off`. The full procedure, what runs on Swarm and what is refused: [DEPLOYMENTS.md §7](./DEPLOYMENTS.md).

**Firewall**, between all swarm hosts and only those:

| Port | Purpose |
| :--- | :--- |
| 2377/tcp | cluster management (the panel host) |
| 7946/tcp and 7946/udp | node gossip |
| 4789/udp | overlay traffic (VXLAN) |
| ESP (IP protocol 50) | the overlay encryption (IPsec) |

NineDeploy's overlays are always encrypted, so **encrypted overlays must work on every swarm host: they do not on Windows nodes**, and some desktop VMs lack the kernel support. `POST /v1/swarm/init` and every join check this first and answer `502 swarm_overlay_unavailable` when the panel host cannot create one.

## 9. Troubleshooting

- **`422 node_agent_outdated`:** update the agent (section 2). The message, and `features.reason` in `GET /v1/servers`, name the version.
- **`403 node_feature_disabled`:** the node's owner switched the feature off (the message names the variable). Change it on the agent and restart the agent.
- **`422 node_transport_unsealed`:** the agent does not offer the sealed transport and the panel allows cleartext (`NINEDEPLOY_AGENT_ALLOW_CLEARTEXT=1`). Update the agent.
- **Node shows `agent: null`:** no sealed ping has answered since the panel was upgraded. Click **Test**.
- **`400 remote_deploy_unsupported` naming "Allow on nodes":** the service clones with a PAT or deploy key. Allow the source on nodes, or set Build on: panel.
- **A Railpack build on a node fails pulling the frontend:** the node needs to reach `ghcr.io`, or set `NINEDEPLOY_AGENT_BUILDKIT_HOST` to a BuildKit the node can use.
- **A Railpack build on a node says the daemon uses the classic image store** (or, with an older agent, `mergeop has been disabled on the build server`): the node's Docker needs the containerd image store, a BuildKit of its own, or the build moves to the panel or a build server (section 4).
- **A transfer fails with "exceeded its … byte limit":** streams are capped at 50 GiB by default; raise `NINEDEPLOY_STREAM_MAX_BYTES` on the panel. A stream also ends after 6 hours, and an agent runs at most 4 streams at once.
- **`502 swarm_overlay_unavailable`:** the panel host's kernel cannot do IPsec for encrypted overlays (section 8).
- **Swarm join answers `swarm_node_unverified`:** the manager saw the node connect from another address than the server's host. Register the node by the IP address it uses to reach the panel host.

## 10. Rolling back and testing

What each 0.15.x rollback does to nodes, and the cleanup commands: [ROLLBACK.md, "0.15.x multi-node rollback runbook"](./ROLLBACK.md).

`node scripts/smoke-multinode.mjs` runs a panel and a node (two Docker-in-Docker hosts and an agent) on throwaway containers: `--image=<candidate>` exercises every feature above; `--from=v0.15.1 --to=<tag> --to-image=<image>` upgrades a panel with an old agent and then updates the agent; `--from=<tag> --from-image=<image> --to=v0.15.1` rehearses the rollback. `--with-builds` adds Nixpacks and Railpack builds; `--no-swarm` skips Swarm on hosts without IPsec.
