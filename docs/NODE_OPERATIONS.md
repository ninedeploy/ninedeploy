# Node operations: readiness, metrics and logs

Release target: 0.18.2. Readiness and log capabilities first shipped
in the 0.17.0 agent; later additions below identify their required capabilities.
Capability negotiation is authoritative; the panel and agent update independently.
Update both to use the new node operations.

## Readiness

Service → Settings → Healthcheck now offers two opt-in modes for plain Docker
services, on the panel host or a node:

| Mode | Verdict |
| --- | --- |
| Default (`http` or the existing NULL) | Existing behaviour, unchanged. On a node this checks stable container state and an image/command healthcheck when present. |
| HTTP readiness (`http-strict`) | The configured path must return HTTP 2xx or 3xx. Redirects are not followed; a 4xx/5xx or missing response fails. |
| TCP readiness (`tcp`) | The container's configured port must accept a TCP connection. This does not establish application readiness beyond that connection. |
| Container running / command | Existing explicit modes, unchanged. |

HTTP/TCP readiness requires a container port. A small `busybox:1.36` helper
shares only the workload's network namespace, targets loopback, and publishes
no port. It has a read-only root, no added capabilities, no mounts or credentials,
and bounded CPU, memory, process count and execution time. Helpers are removed
after an attempt, including failure. The first attempt may need the image pulled;
operators can pre-pull it to avoid that startup delay.

A remote agent must advertise `docker.probe`. The panel refuses unsupported
opt-in probes at queue time and checks again before starting the container.
Both new agent operations require sealed transport. Existing services keep
their default mode until an operator changes it. Swarm and Compose retain their
own healthcheck lifecycles; the new modes apply to plain Docker services.

The node builder still checks crash loops and Docker health, then requires the
readiness probe to pass before the new candidate can take traffic. Readiness
is a deploy-time check, not a continuous availability monitor.

## Routing-load confirmation

The next agent increment targets 0.18.2 and advertises `proxy.routingAck`.
Routed primary-node deployments and fan-out targets require this live capability and sealed transport
before changing routing; update the agent as well as the panel. There is no
silent fallback to a file-write acknowledgement for these deployments.

The managed routes and generation marker share one atomic dynamic file. The
agent checks enabled definitions and the actual HTTP/TLS response generation
through the proxy's loopback-only internal route, bounded to 15 seconds and
4 MiB per observation. Only a hash receipt crosses back to the panel. It does
not accept a caller-selected container, command, API path or external address.

If a dynamic-write response is lost or the load cannot be confirmed, either
runtime may already receive traffic. A confirmed rollback allows candidate
retirement; an unconfirmed rollback fails the deployment and keeps both
generations. The deployment log identifies the retained candidate; resolve the
proxy problem before manual cleanup. Ordinary fleet edits and unrouted workers
keep their existing compatibility behavior. This is separate from workload
readiness, and does not enable node canary or autoscaling.

Fan-out applies explicit HTTP/TCP readiness and its configured timeout on each
target, including the resolved container port of a source build. The target's
previous generation stays live until readiness and routing-load confirmation
pass, followed by a two-second request drain. Target updates check both the
target generation and the primary runtime owner; stale work cannot restore a
deleted/replaced target or publish after a service stop. A target failure is
reported independently; the primary deployment and other targets continue.
Routed fan-out with published host ports is refused before replacing a target;
remove that host-port mapping to allow overlapping generations behind Traefik.
Default node readiness remains container state unless HTTP/TCP is selected.

## Fan-out recovery after restart

Routed fan-out targets also require the sealed `docker.recovery` capability
(agent target 0.18.2). Migration 0097 adds a durable transition journal before
image preparation or container creation. Each transition records both generation
names and their immutable Docker IDs; managed service/deployment labels allow
recovery of a candidate created immediately before a panel crash. Cleanup uses
the recorded ID, so reusing a container name cannot delete another container.

Only transitions begun with this journal are recovered. Older retained
containers with no journal still require operator review; they are not adopted
by guessing ownership from their names.

The panel checks pending transitions one second after boot, then every minute.
A live deploy/recovery holds a renewable 90-second lease. A replacement panel
waits for that lease to expire. Failures retain both possible serving generations
and back off from one minute to one hour. Settings → Fan-out recovery shows the
reason and retry time. An operator can retry immediately; retry bypasses the
backoff, never another active lease. Viewer access is read-only.

Recovery reads the current target and service owner, repeats stable readiness
(including explicitly configured HTTP/TCP probes), confirms loaded routing and
drains requests before retiring an obsolete generation. An unhealthy,
uncommitted candidate can roll back to a confirmed healthy previous generation.
Once retirement is committed, recovery cannot roll back to that obsolete
generation. Unknown identity, stopped services, changed owners and unavailable
nodes retain their records for review; recovery never starts a stopped runtime.
Removing a target preserves its journal until routing removal and both known
generations can be confirmed. Explicit service or node deletion removes the
journal through its foreign key; this mechanism does not promise orphan cleanup
after those destructive operations.

`GET /v1/services/:id/targets/recovery` returns pending entries to authorized
service readers. Operator-only `POST` on the same path retries eligible entries
and returns recovered/held counts plus remaining entries. SDK methods are
`fanout.recovery(id)` and `fanout.retryRecovery(id)`. Recovery records expose
neither lease tokens nor immutable container IDs. This increment covers routed
fan-out Docker targets; primary-runtime cleanup, Swarm and canary/autoscaling
remain separate work. Recorded Docker artifact fan-out uses the same journal
and routing guards; see [artifact promotion](DEPLOYMENTS.md#docker-artifact-promotion-0171).

## Resource history

The collector now samples the existing `agent.stats` operation for nodes hosting
services. Node collection runs independently of local samples, at most once per
collector cycle, with at most four requests in flight, bounded requests and
shutdown cancellation. A failed node does not erase local samples or block the
other nodes. Missing/malformed data stays unknown.

CPU and memory for a node service are persisted in the same history and fed to
the same alert rules as local services. Serving replicas are summed only when
their complete sample is available. Host identity is part of the cache key:
identically named containers on different Docker daemons never share a sample.
The service metrics route retains its existing resource visibility checks.
Monitoring's Local Host totals stay local; selecting a node uses the existing
node-specific live endpoint. Samples from different hosts are never summed
into the panel host's allocation figures.

The published 0.17.0/0.17.1 releases retain 24 hours. The next observability
increment adds opt-in 1–90 day history with rollups; see
[resource history and export](OBSERVABILITY.md). Remote Swarm task aggregation,
fan-out destination history and node-only database history remain separate work.

## Immutable controller resource samples (0.19.0 development)

The development agent adds sealed `docker.metrics` for CPU/memory controller
decisions. This is separate from the existing `agent.stats` history path and is
not available in the published 0.18.2 agent. Requests bind an explicit node,
service/deployment and up to ten full Docker IDs with expected names. The agent
checks managed labels, running state, restart counts and configured resource
limits before and after one bounded sample. CPU limits use NanoCPUs or the
quota/period configuration; memory limits use HostConfig.Memory. An unlimited
memory container reports a zero limit, never the host RAM as its allocation.

The node owner can disable this read-only operation with
`NINEDEPLOY_AGENT_CONTAINER_METRICS=off`. The capability disappears from the ping
and the operation refuses execution. Older agents receive an update hint;
current agents with the operation disabled receive an owner-disabled hint.
Missing, duplicate, replaced, malformed or late samples remain unavailable.
There is no fallback to panel-host statistics or names alone. Sampling uses
one deadline, at most two concurrent samplers and at most 64 KiB per command.

Run `pnpm smoke:container-metrics --image=ninedeploy-local:YOUR_LOCAL_BUILD`
against a current built image. This creates an isolated Docker daemon with no
host socket, a same-name panel decoy and disposable node workloads; it verifies
configured limits and refusal after stop, generation mismatch and same-name
replacement. All owned containers and their volumes are removed afterward.
Node autoscaling and scale to zero remain unavailable until their fenced
runtime, readiness, routing and recovery acceptance is complete.

## Ordered container lifecycle (0.19.0 development)

The development agent adds the sealed `docker.lifecycle` operation for managed
plain Docker containers. A command binds a service/deployment, an increasing
revision, a request ID and up to ten full container IDs with expected names.
The fixed actions are Start and Stop. The agent verifies ownership labels and
the complete target set before any effect, addresses Docker by immutable ID,
then verifies the result before returning its receipt. Application readiness
and loaded routing remain separate controller steps.

The accepted revision and semantic intent are committed before Docker runs.
Each service has a private SQLite journal under the agent working directory:
`.agent-work/.lifecycle/service-<id>.sqlite`. The generated agent command mounts
that working directory at `/var/lib/ninedeploy-agent` on both host and container.
Preserve it when replacing the agent. The image's anonymous `/data` volume does
not hold this ordering state. A newer accepted revision refuses older requests
after restart; a conflicting reuse of a revision is refused. An exact retry
returns the original receipt, which records completed work rather than a fresh
readiness observation. An interrupted effect retains its accepted intent for
the same retry or a newer command. Corrupt or unavailable storage is an error.

SQLite write transactions serialize effects across agent processes sharing the
same state directory. Other services have independent journals. One deadline
includes queueing, storage and Docker calls. Pending work is bounded to 16;
timed-out work holds its queue position until an already-started child drains.
The node owner can disable the capability and operation with
`NINEDEPLOY_AGENT_CONTAINER_LIFECYCLE=off`.

`pnpm smoke:container-lifecycle --image=ninedeploy-local:YOUR_LOCAL_BUILD`
uses the generated agent command's persistent working-directory layout, an
isolated Docker daemon and independent agent processes. It exercises delayed
Start after Stop, exact retry, concurrent Start/Stop, hard crash after a Docker
effect, same-name replacement and owner-disabled refusal, then removes its
owned containers and volumes.

Current manual node lifecycle paths still use their existing operations.
Panel command persistence, revision allocation and conversion of competing
deploy/Stop/scale/wake callers remain R2 work. Node autoscaling and sleep stay
unavailable until that integration, routing and recovery acceptance is complete.

## Log drains

Node Docker/Compose primary runtimes and their named replicas are tailed through
`docker.logsSince`, never through the panel host's Docker daemon. The agent must
advertise this capability. Cursors include the node identity; moving a runtime
cannot cause another host's logs to be treated as already delivered.

New runtimes start without backfill. Each remote poll is bounded to 1,000
recent lines and 256 KiB (long lines may be clipped); PM2 files and secondary
Compose services remain outside this path.

The next observability increment replaces the volatile delivery cursor with
an encrypted per-destination queue and durable cursor. Captured batches survive
restarts and source-container removal, failed destinations retry independently,
and full queues pause capture without evicting pending logs. Destination edits
block existing batches from being sent to a different receiver. Source rotation
before capture can still lose history. See [durable captured-log delivery](OBSERVABILITY.md#durable-captured-log-delivery)
for limits, explicit discard, key rotation and CLI/API controls.

## Availability in the UI

The Servers page and Docker deployment wizard show HTTP/TCP readiness, log drains,
canary, autoscaling, scale to zero and file browser availability for the selected
host. Fields omitted by an older panel are shown as unknown. This is a capability
view; the deploy API revalidates the target when the job runs.

For 0.18.2, node canary availability requires all five sealed-agent capabilities described in [Node canary](DEPLOYMENTS.md#node-canary-unreleased-0180), including owner-enabled proxy traffic observations. Per-service requirements are one replica, HTTP readiness, domain routing and no published host ports. Node autoscaling and scale to zero remain later R2 work. The live worker rechecks support before candidate launch; a cached availability indicator does not authorize deployment.

## Validation

Run the normal workspace checks. The real-Docker smoke uses the current compiled
agent and a disposable workload; it checks a TCP-open/HTTP-503 application stays
unready, HTTP 200 passes, no host port is published, telemetry/logs contain the
workload, and probe helpers are removed:

```sh
pnpm build
node scripts/smoke-node-operations.mjs --image=ninedeploy-local:YOUR_LOCAL_BUILD
node scripts/smoke-multinode.mjs --image=ninedeploy-local:YOUR_LOCAL_BUILD --node-operations-only --no-swarm
```

On Windows the statistics operation runs in the supplied Linux NineDeploy image,
with current compiled server/packages mounted read-only and the Docker socket.
The script removes only its uniquely named workload. It does not certify upgrade,
cross-host networking or a published release.

The focused multi-node command uses separate panel and node Docker daemons.
It checks the sealed deploy path, refuses an unready HTTP release while the
previous release stays routed, reads persisted node memory through the API,
and receives actual node logs at an HTTP drain. Other multi-node features,
build packs and Swarm are outside this focused command.

## Following work from the platform comparison

1. Immutable release records: versioned Compose, configuration and encrypted
   environment snapshots; artifact-based approvals and CI checks before deploy.
2. Real restore-into-database drills, measured recovery time and preview data
   anonymisation/seed policies.
3. Remote Docker canary/autoscaling, the remaining node tools and private networking.
4. Authenticated HTTP MCP/OAuth and a reviewed AI proposal → validation → PR/apply
   → measured outcome flow.
5. Competitor migration previews, resource budgets/usage and cloud provisioning.

These remain planned work, not capabilities delivered by this increment.


0.18.2 also journals routed plain-Docker **primary** node transitions (migration 0098). The same sealed recovery/routing capabilities and immutable-ID safety rules apply. The worker preserves journalled candidates across panel restart, and Settings exposes Primary runtime recovery with a lease-safe retry. Fresh readiness and loaded routing precede retirement; Stop, cancellation and changed placement remain authoritative. Recovery does not replay node builds, hooks or additional-node deployments. See [Deployments](DEPLOYMENTS.md#primary-docker-transition-recovery-unreleased-0180) for state choices and exclusions.


<a id="node-container-inspection-and-files-unreleased-0180"></a>

<a id="node-container-inspection-and-files-0180"></a>

<a id="node-container-inspection-and-files-0181"></a>

## Node container inspection and files (0.18.2)

Service and database Manifest/Files views target their recorded node explicitly. Instance operators can inspect a container, generate its runtime Compose manifest and list/read/write/create/delete files through the sealed `docker.containerTools` capability. The agent resolves the container name once and uses its immutable Docker ID for the operation. Missing capabilities, unsealed transport, an unknown node or an unconfirmed response never fall back to the panel daemon.

Node routes use `/v1/servers/:serverId/containers/:container`, with `/inspect`, `/compose`, `/files`, `/files/content` and `/files/dir` suffixes. An older panel returns 404 for this namespace. The local `/v1/containers` routes reject a host query rather than ignoring it. Node file reads and writes are limited to 1 MiB decoded content; wrapped base64 is normalized before transport. Oversized or unreadable files are refused without returning an editable partial/empty file. Directory metadata preserves exact whitespace in names and includes empty files. File operations still require the workload's usual shell/head/stat/find/base64 utilities and permissions.

SDK container methods take an optional final `{ serverId }` argument. For example, `containers.inspect(name, { serverId: 7 })`, `containers.readFile(name, path, { serverId: 7 })` and `containers.writeFile(name, input, { serverId: 7 })`. CLI `services inspect <id>` and `services compose <id>` automatically use the service's host. Panel caches and editor state are separated by host, so identically named containers do not share file content.

The node owner can disable these operations with `NINEDEPLOY_AGENT_CONTAINER_TOOLS=off`; the capability disappears from the sealed ping and the agent refuses the operation too. The Servers/wizard support view reports `features.containerTools`; an older panel omitting the flag remains unknown. Node-volume files and database Web Studio use the separate capabilities below. Node canary uses the separate [R1 requirements](DEPLOYMENTS.md#node-canary-unreleased-0180); node autoscaling and Swarm task file selection remain later runtime-parity work.


<a id="node-volume-files-unreleased-0180"></a>

<a id="node-volume-files-0180"></a>

<a id="node-volume-files-0181"></a>

### Node volume files (0.18.2)

Instance operators can browse, read, write, create directories and delete paths on a selected node through sealed `volume.files` / `volume.fileTool`. Routes use `/v1/servers/:serverId/volumes/:name/files`, with `/content` and `/dir` suffixes. The legacy panel-host file routes reject `?serverId`; an older panel returns 404 for the new namespace. There is no local fallback. The node owner can disable this capability with `NINEDEPLOY_AGENT_VOLUME_FILES=off`. Support views expose `features.volumeFiles`; update the agent to 0.18.2 when unavailable.

These tools support existing managed volumes on Linux Docker's local driver without external driver options. Other drivers/options are refused with 422. A missing volume returns 404 and is never auto-created by browsing. The helper pins the selected volume through its first live bind and checks both metadata and the current device/inode through isolated read-only probes before and after the file operation. A changed identity returns 409. File operations cannot redirect that pinned bind into a replacement volume. Helpers mount only the selected volume, have bounded commands/lifetimes, and require nonce/immutable-ID ownership confirmation for cleanup. Unconfirmed cleanup is reported; helpers self-exit within 150 seconds after startup.

Reads and writes allow at most 1 MiB decoded content. Binary bytes and whitespace in names are preserved, empty files are listed, and wrapped base64 is accepted. Oversized reads never return an editable partial file. Paths outside the volume and symlinks escaping it are refused; deleting a terminal symlink deletes that link itself. Operations are ordinary live filesystem edits: coordinate with the workload when editing data files. Volume snapshots retain their separate support boundary.

The Volumes page host selector and a service's recorded host choose the file browser target. Host changes clear the editor and use distinct query caches. Unavailable nodes show the actual refusal with a retry action. SDK file methods take an optional final `{serverId}` argument. CLI examples:

```sh
ninedeploy volumes files nd-svc-app-data --server 7 --json
ninedeploy volumes read nd-svc-app-data config.json --server 7 --output config.json
ninedeploy volumes write nd-svc-app-data config.json --server 7 --file config.json
ninedeploy volumes mkdir nd-svc-app-data archive --server 7
ninedeploy volumes delete-file nd-svc-app-data archive --server 7
```

CLI reads preserve exact binary stdout; `--output` refuses an existing local file unless `--force` is supplied. Delete prompts for the exact path unless `--yes` is explicit. `pnpm smoke:volume-files --image=<built-candidate>` runs the actual helper CRUD/binary/limit/symlink/missing-volume controls on an owned Docker-in-Docker daemon. Public API, two-daemon isolation, CLI and browser acceptance are separate checks.

<a id="node-database-client-terminals-unreleased-0180"></a>

<a id="node-database-client-terminals-0180"></a>

<a id="node-database-client-terminals-0181"></a>

### Node database client terminals (0.18.2)

The database Client action uses the recorded database ID and node. Operators can open PostgreSQL, MySQL, MariaDB, Redis, Valkey, KeyDB and Dragonfly clients through `POST /v1/terminals` with `target: {kind: 'database', databaseId, mode: 'client'}`. The node needs `db.manage`, `db.client`, sealed terminal transport and its Docker Engine API. Support views expose `features.databaseClients`. Missing support returns a refusal before creating a client; there is no panel-host fallback. Unsupported engines retain the separate container Shell action.

Preparation and attachment both recheck support. The agent verifies the managed-database labels, database ID, slug, running state and immutable container ID, then opens the fixed engine-specific command against that ID. Stored credentials travel only through the sealed channel and remain in the pending session's memory; client passwords use Docker exec environment variables rather than client command arguments. Terminal history and audit records do not contain the client payload. This does not change other database provisioning commands.

The node owner can disable clients with `NINEDEPLOY_AGENT_DATABASE_CLIENTS=off`, or disable database operations with `NINEDEPLOY_AGENT_DATABASES=off`. Both preparation and attachment enforce these switches. An already prepared ticket cannot attach to a replacement container with the same name. Existing terminal authorization, single-use tickets, resize, termination and connection limits still apply.

SDK `terminals.create` allows at least 60 seconds for database client creation; other terminal modes retain their normal timeout. Larger custom timeouts and an explicit disabled timeout remain respected. `onReady` confirms the terminal transport: automated interactive clients must also wait for their CLI prompt and each command's response. The panel title identifies the node. Database Web Studio is described below.

`pnpm smoke:database-clients --image=<built-candidate>` runs actual API and SDK queries against all seven default engine images on owned Docker-in-Docker hosts, including password refusal, same-name local/node isolation, old-agent refusal, owner switches, single-use tickets and container replacement controls. `--case=postgres` or `--case=engines --engine=keydb` narrows the run. This smoke does not certify every engine version, browser behavior or the full release matrix.


<a id="node-database-web-studio-unreleased-0180"></a>

<a id="node-database-web-studio-0180"></a>

<a id="node-database-web-studio-0181"></a>

## Node database Web Studio (0.18.2)

An operator can launch Adminer for PostgreSQL/MySQL/MariaDB or Redis Commander for Redis/Valkey/KeyDB/Dragonfly from the database page. Both the panel and node agent must support sealed `db.studio`; an old or owner-disabled agent is refused with an actionable message. `NINEDEPLOY_AGENT_DATABASE_STUDIOS=off` disables Studio on that node; `NINEDEPLOY_AGENT_DATABASES=off` disables it with other database operations.

The helper uses the verified private database bridge, resolved image identity and fixed internal port, with no published host port. Access uses the panel-origin proxy in a separate noopener tab. SQL driver/server/user/database defaults contain no password; SQL Studio still asks for the database password. A node Studio request never falls back to a local helper.

The standard bootstrap keeps its default Docker bridge. For private Studio access, the agent connects its own verified container to the database bridge with a lower gateway priority, preserving its original outbound route. This automatic attachment needs Docker Engine API 1.48 or newer. The agent identifies itself through Docker's default container-ID hostname; customized hostnames need an operator-provided compatible network arrangement. Native/host-network agents and existing manual connections are left unchanged. Stop removes only the endpoint carrying this Studio resource's ownership alias after confirming the helper is gone.

A preparing receipt is durable. If preparation or cleanup cannot be confirmed, retry from the same database page or use Stop Studio; the panel retains the receipt until confirmed node cleanup. Database stop/restart/recreate/delete share the lifecycle lock and confirm Studio cleanup first. A busy operation returns 409 rather than queueing another browser mutation. Explicit forced record deletion reports possible node orphans.

SDK `databases.startStudio` permits at least 240 seconds and returns `port: null` on a node. Stop permits at least 270 seconds to include an outstanding preparation and cleanup. Larger configured budgets and `timeoutMs: 0` retain their meanings. Browser requests include the path-scoped Studio cookie. The cookie follows the authenticated API key or login session; deletion, expiry, individual revocation, loss of operator scope/access, token-version changes and the instance epoch invalidate it. Reopen existing Studio tabs after this upgrade.

All seven supported engines passed real default-bootstrap browser data workflows and the uncached local matrix. An earlier opaque browser exception remains unreproduced; vendor Studio pages retain their narrow-screen layout limitations. Release artifact certification and publication status are tracked in [Competitive delivery](COMPETITIVE_DELIVERY.md).


<a id="database-resource-telemetry-unreleased-0180"></a>

<a id="database-resource-telemetry-0180"></a>

<a id="database-resource-telemetry-0181"></a>

## Database resource telemetry (0.18.2)

The database page requests `/v1/stats?databaseId=<id>`. The response is access-scoped, excludes host metrics and other containers, and identifies the database and its recorded node. Database-only nodes are collected too. Samples older than 90 seconds, failed or missing samples, and stopped databases are never displayed as live zero metrics. The panel distinguishes waiting, unavailable, stale and stopped states and can retry. The SDK requires the scoped resource receipt; an older panel that ignores the filter must be upgraded. The unfiltered stats endpoint retains its panel-host behavior.

<a id="agent-capacity-and-readiness-budgets-unreleased-0180"></a>

<a id="agent-capacity-and-readiness-budgets-0180"></a>

<a id="agent-capacity-and-readiness-budgets-0181"></a>

## Agent capacity and readiness budgets (0.18.2)

Sealed agent calls honor a canonical positive Retry-After of 1–60 seconds on HTTP 429, with at most two retries and one original request deadline. The encrypted request and nonce are reused; already-executed requests remain protected by replay refusal. Unsupported headers, other HTTP failures, transport errors and legacy plaintext calls are not retried. Cancellation also stops a capacity wait. The agent operation route permits at most 1,000 requests/minute. Invalid authentication/validation retains a separate 120/minute rejection response budget, including concurrent failures; unrelated peers have independent buckets. The panel request limits, sealed authentication, nonce replay checks and original request deadlines remain in force.

Remote readiness RPCs and diagnostic log retrieval share the remaining readiness deadline. Replies arriving after it cannot admit a candidate. HTTP/TCP readiness still requires explicit configuration; container-state readiness alone does not establish HTTP application readiness. Packaged Docker health uses the configured `NINEDEPLOY_AGENT_PORT` and `/agent/ping` for agent role, or `NINEDEPLOY_PORT` and `/health` for panel role.

## Public access to a node database

A database on a node can be reached from outside on a port of that node, the same way as one on the panel host: **Database → Settings → Public access**, or `PUT /v1/databases/:id/public-access`. Operators only, behind a required IP allow-list.

How it works:
- The node's agent runs the same sidecar as the panel host: a Traefik container `nd-dbpub-<slug>` that publishes one port of the node and proxies TCP to the database.
- The sidecar joins only the database's own bridge `nd-dbnet-<slug>`, never the node's shared network, so it reaches that database and nothing else.
- Before it proxies anything, the agent checks that `nd-db-<slug>` is the managed database with that id.
- Its configuration lives under the agent's home (`dbproxy/<slug>`). It restarts with the node's Docker.

Clients connect to the node's address. The credentials' `publicConnectionString` uses it.

Limits on a node:
- **TLS end to end only (`tlsMode: none`).** The certificates are on the panel, so `terminate` is refused (`422 unsupported_tls_mode`). The client and the database still negotiate TLS between themselves.
- **Ports.** The port may not be the agent's port, 80, 443 or 22. It may not be a port a service on that node publishes. As on the panel host, it must differ from every other database's public port.
- **No panel reconcile.** The panel's reconcile does not restart a node's sidecar; the node's Docker restarts it.
- **Turning off needs the node.** Turning access off is refused while the node cannot confirm it (`502 node_unreachable`), because the port would stay open. Deleting the database removes the sidecar on a best-effort basis.

Requires agent 0.18.11 or newer (`db.publicAccess`) and a sealed transport. The node owner turns it off with `NINEDEPLOY_AGENT_PUBLIC_DATABASES=off`; `NINEDEPLOY_AGENT_DATABASES=off` turns it off together with every other node database feature.

## OS security updates (G4.2)

Operators can see each host's pending package updates and turn automatic **security** updates on or off:

- **Panel host:** Settings → System → *OS security updates*.
- **A node:** Servers → node panel.

The card reads nothing until you press **Check updates**: every read runs a short-lived helper container on the host.

**What it shows**

- the distribution and package manager;
- the pending updates, security ones first;
- whether automatic security updates are on;
- whether the host is waiting for a reboot and, on Debian or Ubuntu, which packages asked for it.

**Refresh package lists** runs `apt-get update` or `dnf --refresh` first.

**What switching it on does**

| Package manager | On | Off |
| :--- | :--- | :--- |
| apt (Debian, Ubuntu) | Installs `unattended-upgrades` if it is missing. Writes `/etc/apt/apt.conf.d/20auto-upgrades` (periodic list updates and unattended upgrades). Writes `/etc/apt/apt.conf.d/52ninedeploy-no-reboot`, which sets `Unattended-Upgrade::Automatic-Reboot "false"`. The distribution's default origins are its security pockets. | Rewrites `20auto-upgrades` with unattended upgrades set to `0`. The package stays installed. |
| dnf (Fedora, RHEL, Rocky, Alma) | Installs `dnf-automatic` (or `dnf5-plugin-automatic`) if it is missing. Sets `upgrade_type = security` and `apply_updates = yes` in `/etc/dnf/automatic.conf`. Enables the `dnf-automatic.timer` (or `dnf5-automatic.timer`). | Disables the timer. |

Other package managers (Alpine, Arch, SUSE) are reported as unsupported; nothing is changed there.

**Never a reboot.** NineDeploy does not reboot a host and turns unattended-upgrades' own automatic reboot off. The card shows **Reboot required** when the host reports it:

- on Debian or Ubuntu, from `/var/run/reboot-required`;
- on dnf hosts, from `needs-restarting -r`. Without it, the card says the host cannot tell.

Plan reboots yourself.

**How it runs**

Each action is a fixed script, picked by name. Nothing a caller sends reaches a shell.

- The script runs in a privileged helper with `--pid=host` that enters PID 1's namespaces with `nsenter -t 1`, the same helper as host shells.
- The image is `NINEDEPLOY_HOST_SHELL_IMAGE`, or else the proxy image that is already on the host.
- On a node, the agent runs it through the sealed op `host.packages`. The node's owner can refuse it with `NINEDEPLOY_AGENT_HOST_PACKAGES=off`; the panel then answers `403 node_feature_disabled`.
- An agent older than 0.18.6 gets `422 node_agent_outdated`.
- One action runs per host at a time; a second one answers `409 os_updates_busy`.

**Routes and audit** (operator only):

- `GET /v1/os-updates[?refresh=1]` and `POST /v1/os-updates/auto {enabled}` for the panel host;
- `GET /v1/servers/:serverId/os-updates[?refresh=1]` and `POST /v1/servers/:serverId/os-updates/auto {enabled}` for a node.

Switching is audited as `os_updates.auto_enable` or `os_updates.auto_disable`.

## Move a service with its data (G3.1)

`PATCH /v1/services/:id { serverId }` moves only the configuration: the next deploy starts the service on the new host with an empty volume. **Service → Settings → Move with data** (`POST /v1/services/:id/move`, operators) also moves the data:

1. The service must be stopped, with no deployment running and no extra volume attachments. Its primary volume `nd-svc-<slug>-data` must be on the current host. Docker services and compose stacks; Swarm and PM2 are refused.
2. The host change is that same PATCH, with every check it makes: attached databases stay on their host, and a volume of the same name already on the target is refused.
3. The volume is archived on the source, created on the target and restored there. Node archives travel over the agent's sealed stream channel, which checks the size and sha256 end to end. The temporary archive under the backups directory is deleted afterwards.
4. The service is deployed on the target.

The request answers 202 at once. `GET /v1/services/:id/move` reports `copying`, then `deploying`, then `done` with the deployment id, or `failed` with the reason. After a failed copy the service stays on the target, undeployed; moving it back is a plain host change, because the source volume is never deleted. Remove the old volume from the Volumes page once the service runs on the target. The state is the settings row `service_move:<id>`; there is no migration.

A **compose stack** moves every named volume compose created for it, `ndcmp-<slug>_<key>` (found by compose's own `com.docker.compose.project` label), one after the other; `GET …/move` lists them in `volumes` and counts them in `copied`. Each one is created on the target with compose's project and volume labels, so the stack's `up` there adopts it. A stack with a volume that has a fixed `name:` is refused (`move_fixed_volume_names`), because that volume would be left behind. External volumes and bind mounts are not moved. A node on either end needs agent 0.18.7 or newer with the `volume.compose` capability; its owner can turn it off with `NINEDEPLOY_AGENT_VOLUME_COMPOSE=off`. The agent transfers such a volume only when Docker says compose created it for the project its name starts with.
