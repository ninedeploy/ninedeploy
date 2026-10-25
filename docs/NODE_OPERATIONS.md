# Node operations: readiness, metrics and logs

Release target: 0.18.1. Readiness and log capabilities first shipped
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

The next agent increment targets 0.18.1 and advertises `proxy.routingAck`.
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
(agent target 0.18.1). Migration 0097 adds a durable transition journal before
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

For 0.18.1, node canary availability requires all five sealed-agent capabilities described in [Node canary](DEPLOYMENTS.md#node-canary-unreleased-0180), including owner-enabled proxy traffic observations. Per-service requirements are one replica, HTTP readiness, domain routing and no published host ports. Node autoscaling and scale to zero remain later R2 work. The live worker rechecks support before candidate launch; a cached availability indicator does not authorize deployment.

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


0.18.1 also journals routed plain-Docker **primary** node transitions (migration 0098). The same sealed recovery/routing capabilities and immutable-ID safety rules apply. The worker preserves journalled candidates across panel restart, and Settings exposes Primary runtime recovery with a lease-safe retry. Fresh readiness and loaded routing precede retirement; Stop, cancellation and changed placement remain authoritative. Recovery does not replay node builds, hooks or additional-node deployments. See [Deployments](DEPLOYMENTS.md#primary-docker-transition-recovery-unreleased-0180) for state choices and exclusions.


<a id="node-container-inspection-and-files-unreleased-0180"></a>

<a id="node-container-inspection-and-files-0180"></a>

## Node container inspection and files (0.18.1)

Service and database Manifest/Files views target their recorded node explicitly. Instance operators can inspect a container, generate its runtime Compose manifest and list/read/write/create/delete files through the sealed `docker.containerTools` capability. The agent resolves the container name once and uses its immutable Docker ID for the operation. Missing capabilities, unsealed transport, an unknown node or an unconfirmed response never fall back to the panel daemon.

Node routes use `/v1/servers/:serverId/containers/:container`, with `/inspect`, `/compose`, `/files`, `/files/content` and `/files/dir` suffixes. An older panel returns 404 for this namespace. The local `/v1/containers` routes reject a host query rather than ignoring it. Node file reads and writes are limited to 1 MiB decoded content; wrapped base64 is normalized before transport. Oversized or unreadable files are refused without returning an editable partial/empty file. Directory metadata preserves exact whitespace in names and includes empty files. File operations still require the workload's usual shell/head/stat/find/base64 utilities and permissions.

SDK container methods take an optional final `{ serverId }` argument. For example, `containers.inspect(name, { serverId: 7 })`, `containers.readFile(name, path, { serverId: 7 })` and `containers.writeFile(name, input, { serverId: 7 })`. CLI `services inspect <id>` and `services compose <id>` automatically use the service's host. Panel caches and editor state are separated by host, so identically named containers do not share file content.

The node owner can disable these operations with `NINEDEPLOY_AGENT_CONTAINER_TOOLS=off`; the capability disappears from the sealed ping and the agent refuses the operation too. The Servers/wizard support view reports `features.containerTools`; an older panel omitting the flag remains unknown. Node-volume files and database Web Studio use the separate capabilities below. Node canary uses the separate [R1 requirements](DEPLOYMENTS.md#node-canary-unreleased-0180); node autoscaling and Swarm task file selection remain later runtime-parity work.


<a id="node-volume-files-unreleased-0180"></a>

<a id="node-volume-files-0180"></a>

### Node volume files (0.18.1)

Instance operators can browse, read, write, create directories and delete paths on a selected node through sealed `volume.files` / `volume.fileTool`. Routes use `/v1/servers/:serverId/volumes/:name/files`, with `/content` and `/dir` suffixes. The legacy panel-host file routes reject `?serverId`; an older panel returns 404 for the new namespace. There is no local fallback. The node owner can disable this capability with `NINEDEPLOY_AGENT_VOLUME_FILES=off`. Support views expose `features.volumeFiles`; update the agent to 0.18.1 when unavailable.

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

### Node database client terminals (0.18.1)

The database Client action uses the recorded database ID and node. Operators can open PostgreSQL, MySQL, MariaDB, Redis, Valkey, KeyDB and Dragonfly clients through `POST /v1/terminals` with `target: {kind: 'database', databaseId, mode: 'client'}`. The node needs `db.manage`, `db.client`, sealed terminal transport and its Docker Engine API. Support views expose `features.databaseClients`. Missing support returns a refusal before creating a client; there is no panel-host fallback. Unsupported engines retain the separate container Shell action.

Preparation and attachment both recheck support. The agent verifies the managed-database labels, database ID, slug, running state and immutable container ID, then opens the fixed engine-specific command against that ID. Stored credentials travel only through the sealed channel and remain in the pending session's memory; client passwords use Docker exec environment variables rather than client command arguments. Terminal history and audit records do not contain the client payload. This does not change other database provisioning commands.

The node owner can disable clients with `NINEDEPLOY_AGENT_DATABASE_CLIENTS=off`, or disable database operations with `NINEDEPLOY_AGENT_DATABASES=off`. Both preparation and attachment enforce these switches. An already prepared ticket cannot attach to a replacement container with the same name. Existing terminal authorization, single-use tickets, resize, termination and connection limits still apply.

SDK `terminals.create` allows at least 60 seconds for database client creation; other terminal modes retain their normal timeout. Larger custom timeouts and an explicit disabled timeout remain respected. `onReady` confirms the terminal transport: automated interactive clients must also wait for their CLI prompt and each command's response. The panel title identifies the node. Database Web Studio is described below.

`pnpm smoke:database-clients --image=<built-candidate>` runs actual API and SDK queries against all seven default engine images on owned Docker-in-Docker hosts, including password refusal, same-name local/node isolation, old-agent refusal, owner switches, single-use tickets and container replacement controls. `--case=postgres` or `--case=engines --engine=keydb` narrows the run. This smoke does not certify every engine version, browser behavior or the full release matrix.


<a id="node-database-web-studio-unreleased-0180"></a>

<a id="node-database-web-studio-0180"></a>

## Node database Web Studio (0.18.1)

An operator can launch Adminer for PostgreSQL/MySQL/MariaDB or Redis Commander for Redis/Valkey/KeyDB/Dragonfly from the database page. Both the panel and node agent must support sealed `db.studio`; an old or owner-disabled agent is refused with an actionable message. `NINEDEPLOY_AGENT_DATABASE_STUDIOS=off` disables Studio on that node; `NINEDEPLOY_AGENT_DATABASES=off` disables it with other database operations.

The helper uses the verified private database bridge, resolved image identity and fixed internal port, with no published host port. Access uses the panel-origin proxy in a separate noopener tab. SQL driver/server/user/database defaults contain no password; SQL Studio still asks for the database password. A node Studio request never falls back to a local helper.

The standard bootstrap keeps its default Docker bridge. For private Studio access, the agent connects its own verified container to the database bridge with a lower gateway priority, preserving its original outbound route. This automatic attachment needs Docker Engine API 1.48 or newer. The agent identifies itself through Docker's default container-ID hostname; customized hostnames need an operator-provided compatible network arrangement. Native/host-network agents and existing manual connections are left unchanged. Stop removes only the endpoint carrying this Studio resource's ownership alias after confirming the helper is gone.

A preparing receipt is durable. If preparation or cleanup cannot be confirmed, retry from the same database page or use Stop Studio; the panel retains the receipt until confirmed node cleanup. Database stop/restart/recreate/delete share the lifecycle lock and confirm Studio cleanup first. A busy operation returns 409 rather than queueing another browser mutation. Explicit forced record deletion reports possible node orphans.

SDK `databases.startStudio` permits at least 240 seconds and returns `port: null` on a node. Stop permits at least 270 seconds to include an outstanding preparation and cleanup. Larger configured budgets and `timeoutMs: 0` retain their meanings. Browser requests include the path-scoped Studio cookie. The cookie follows the authenticated API key or login session; deletion, expiry, individual revocation, loss of operator scope/access, token-version changes and the instance epoch invalidate it. Reopen existing Studio tabs after this upgrade.

All seven supported engines passed real default-bootstrap browser data workflows and the uncached local matrix. An earlier opaque browser exception remains unreproduced; vendor Studio pages retain their narrow-screen layout limitations. Release artifact certification and publication status are tracked in [Competitive delivery](COMPETITIVE_DELIVERY.md).


<a id="database-resource-telemetry-unreleased-0180"></a>

<a id="database-resource-telemetry-0180"></a>

## Database resource telemetry (0.18.1)

The database page requests `/v1/stats?databaseId=<id>`. The response is access-scoped, excludes host metrics and other containers, and identifies the database and its recorded node. Database-only nodes are collected too. Samples older than 90 seconds, failed or missing samples, and stopped databases are never displayed as live zero metrics. The panel distinguishes waiting, unavailable, stale and stopped states and can retry. The SDK requires the scoped resource receipt; an older panel that ignores the filter must be upgraded. The unfiltered stats endpoint retains its panel-host behavior.

<a id="agent-capacity-and-readiness-budgets-unreleased-0180"></a>

<a id="agent-capacity-and-readiness-budgets-0180"></a>

## Agent capacity and readiness budgets (0.18.1)

Sealed agent calls honor a canonical positive Retry-After of 1–60 seconds on HTTP 429, with at most two retries and one original request deadline. The encrypted request and nonce are reused; already-executed requests remain protected by replay refusal. Unsupported headers, other HTTP failures, transport errors and legacy plaintext calls are not retried. Cancellation also stops a capacity wait. Rate-limit ceilings are unchanged.

Remote readiness RPCs and diagnostic log retrieval share the remaining readiness deadline. Replies arriving after it cannot admit a candidate. HTTP/TCP readiness still requires explicit configuration; container-state readiness alone does not establish HTTP application readiness. Packaged Docker health uses the configured `NINEDEPLOY_AGENT_PORT` and `/agent/ping` for agent role, or `NINEDEPLOY_PORT` and `/health` for panel role.
