# Node operations: readiness, metrics and logs

Release target: 0.17.0. The new readiness and log capabilities first ship in
the 0.17.0 agent. Capability negotiation is authoritative; the panel and agent
update independently. Update both to use the new node operations.

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

Retention remains 24 hours. Remote Swarm task aggregation, fan-out destination
history and node-only database history are not included in this increment.

## Log drains

Node Docker/Compose primary runtimes and their named replicas are tailed through
`docker.logsSince`, never through the panel host's Docker daemon. The agent must
advertise this capability. Cursors include the node identity; moving a runtime
cannot cause another host's logs to be treated as already delivered.

As before, a new runtime starts without backfill. Each poll is bounded to 1,000
recent lines and 256 KiB from a node (long lines are clipped). This is a best-effort
drain, not a durable log queue: restarts and a producer that outruns these bounds
can lose history. PM2 files and secondary Compose services are outside this path.

A rejected/failed delivery no longer advances the cursor. The next poll retries
the batch. Delivery is at least once while that cursor remains in memory;
successful destinations can receive duplicate timestamps when another destination
fails. A durable per-destination spool is separate future work.

## Availability in the UI

The Servers page and Docker deployment wizard show HTTP/TCP readiness, log drains,
canary, autoscaling, scale to zero and file browser availability for the selected
host. Fields omitted by an older panel are shown as unknown. This is a capability
view; the deploy API revalidates the target when the job runs.

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
