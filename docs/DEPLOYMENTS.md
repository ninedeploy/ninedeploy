# Deployments & Pipeline Engine

NineDeploy deploys Docker, PM2 and Compose services, including images built with Nixpacks. Container releases use health checks and blue-green traffic switching; Compose replaces its stack in place and has a brief interruption. Rollback behavior depends on the release type, as described below.

---

## 🔄 1. Blue-Green Zero-Downtime Releases

When deploying a containerized service:
1. **Parallel Build**: NineDeploy clones the git repository or pulls the specified image, building the new container without stopping the active one.
2. **Dynamic Port Binding**: The new container starts on an ephemeral port.
3. **Healthcheck Gate**: NineDeploy polls the configured health endpoint (e.g. `GET /health` returning `200 OK`).
4. **Traefik Traffic Flip**: Once the new container passes health verification, Traefik dynamically routes incoming traffic to the new container.
5. **Graceful Drain**: The old container receives `SIGTERM` and is stopped after draining in-flight requests.

### Fan-out traffic transitions (unreleased)

Each routed fan-out target keeps its previous runtime until its candidate passes
the selected readiness check and its node confirms the loaded HTTP/TLS routing
generation. After confirmation, a two-second request drain precedes retirement.
Explicit HTTP/TCP readiness uses the service path, resolved container port and
configured timeout; the target agent must support sealed `docker.probe` and
`proxy.routingAck` operations as applicable. An unrouted worker retains its
legacy container-state behavior unless application readiness is selected.

A failed transition restores the previous target record and confirms rollback
before candidate cleanup. If rollback cannot be confirmed, both generations stay
running and the deployment log names them for manual reconciliation. Target
replacement/deletion and a stopped or newer primary generation prevent stale
promotion. A target failure remains independent of primary success; inspect the
fan-out outcome lines and per-target status. Published host ports prevent safe
overlap, so routed fan-out with a published port is refused before retirement.
Primary node canary has the separate eligibility requirements below; node autoscaling remains later R2 work. The 0.18.2 artifact increment also uses these guards for recorded-image fan-out promotion.

### Ordered multi-node lifecycle (unreleased)

For plain Docker services whose primary runs on a node, accepted Start, Stop and Restart commands record the primary and additional-node placements together. Every participating agent must support sealed `docker.lifecycle`, `docker.recovery`, `docker.readiness` and `proxy.routingAck`. Additional-node targets currently run one container each; the primary's replica count does not create extra target containers or routing backends.

The worker captures immutable container IDs separately on each node and verifies that node's deployment generation. Start and Restart require three stable readiness samples for every serving target before publishing routing. Stop confirms routing removal on every participant and drains requests before stopping the captured IDs. A command is complete only after every required node acknowledges its effect and routing phase. An offline node, lost response or unsupported agent leaves it pending with a reason; retry preserves the original command and identities. A newer command or changed target membership/runtime invalidates an older continuation.

An older primary-only journal cannot silently adopt existing fan-out targets: submit a new command to capture the full placement. An unresolved fan-out deployment/recovery transition holds lifecycle effects because it may own containers outside the serving row. Coordinating Stop with those unfinished generations, deploy/scale/wake ordering and local-primary fan-out remain separate R2 work; this increment does not certify those paths.

The development agent additionally advertises `docker.lifecycle.generations`. It accepts an explicit expected deployment label for every immutable target in a Stop batch, checks the entire batch before effects and verifies it again afterward. A fresh agent process can replay the same durable receipt. Explicit batches permit up to thirty targets; legacy batches remain limited to ten, and Start refuses explicit generation annotations. `NINEDEPLOY_AGENT_CONTAINER_LIFECYCLE=off` disables both forms. This agent foundation does not remove the panel's unresolved-transition hold: builders must participate in the same ordering before that path can complete safely.

The development panel persists one runtime ownership clock per service independently of lifecycle history. New node lifecycle commands reserve that ownership in the same transaction as their journal entry; a replaced owner invalidates old leases, continuations and retries. Migration 0102 preserves the wire revision of already-pending commands, while later commands advance beyond the retained high-water mark. Ownership metadata does not start or stop containers by itself. Already-admitted managed runSpec and runEnv creation now drains under the same agent journal lock as lifecycle effects. The lock includes create, network attachment, Start and failure cleanup, and a timed-out child remains owned until its actual close. This does not authorize or reject an older request that arrives only after a newer Stop; binding delayed creation, scale, wake and retirement requests to the persisted authority is still required. The unresolved-transition hold remains in force.

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

0.18.2 also configures Traefik health checks on both canary releases when `http-strict` readiness is selected, including single-container releases: a 5-second interval, 3-second timeout and no redirect following. Their weighted parent follows health changes, so an unhealthy release leaves rotation even while the panel control loop is delayed. Traffic during the health-detection interval can still fail. Other readiness modes keep their existing replica probe behavior; a weighted parent subscribes only when both leaves have probes. Accepted health query strings and percent encoding are preserved on canary and ordinary replica backends. See [Traefik v3.1 health checks](https://doc.traefik.io/traefik/v3.1/routing/services/#health-check).

While a canary runs:
- **Promote** (`POST /v1/services/:id/deploys/:depId/canary/promote`) switches a panel-host canary early. A node canary first finishes and passes its current full measured step, then skips the remaining steps. Abort remains available while that node promotion waits.
- **Cancel** requests a checked rollback at the next checkpoint. An in-flight probe/observation and routing confirmation can delay it; unconfirmed rollback retains both runtime generations.
- `GET /v1/services/:id/canary` shows the step, the share and each release's requests, 5xx rate and p95 so far.
- With sticky sessions on, a visitor stays on one release (cookie `ninedeploy_release`).

A panel-host deploy switches all traffic at once, and its log names why, when:
- it is a rollback;
- the service has no previous release or no routed domain;
- it publishes host ports (the previous release is stopped before the new one starts);
- it runs on Swarm, whose native rolling-update behavior applies. Additional-node fan-out targets receive the new release after the primary canary has finished; they do not share its weighted observation.

<a id="node-canary-unreleased-0180"></a>

<a id="node-canary-0180"></a>

<a id="node-canary-0181"></a>

#### Node canary (0.18.2)

Node canary uses the same service configuration and promote/cancel routes. It currently supports a plain Docker service with one desired/serving replica, explicit `http-strict` readiness, an active domain or automatic URL, and no published port or port mappings. The selected node must provide sealed `proxy.traffic`, `proxy.routingAck`, `docker.recovery`, `docker.probe` and `docker.readiness`. Update both panel and agent, and set `NINEDEPLOY_AGENT_PROXY_TRAFFIC=on` on that agent to opt in. The panel's local traffic-analytics toggle does not enable or disable node measurement.

The worker checks these requirements before candidate build/run and again after resolving manifest settings. Unsupported requested node settings or missing capabilities fail the deploy before candidate launch. A first deploy without a serving previous release, and an explicit rollback, use an all-at-once transition instead of a split. Normal deploy readiness defaults remain unchanged when canary is off.

After candidate qualification, the worker confirms stable-only routing and verifies that a node observation reservation can open before creating a weighted split. Every step begins its full timer after the node confirms the loaded split and opens its independent observation window. Missing or invalid observation results fail the step even if application readiness succeeds. Complete windows below `minRequests` retain the documented healthcheck-only verdict policy. Ordinary domain/fleet refreshes during a split preserve the generation marker and require sealed HTTP/TLS confirmation; a changed generation invalidates the earlier observation.

Failure/cancellation confirms stable routing before retiring the candidate by immutable identity. An unknown routing outcome keeps both generations for durable recovery. A hard panel restart does not replay an in-memory canary or its measurements: recovery uses the persisted stable intent. Explicit Stop remains authoritative. Readiness/observation RPCs and rollback confirmation can delay cancellation; it is checked at bounded operation boundaries.

R1 has local API/worker and browser acceptance; final artifact certification and publication are tracked separately. Node multi-replica canary, autoscaling/sleep and Swarm canary are outside this increment.

`pnpm smoke:node-canary --image=<candidate>` exercises the public API/worker against isolated panel/node Docker daemons and the standard bridge agent bootstrap. It covers readiness holding, healthy rollout, measured 5xx rollback, full-step promotion, concurrent domain refreshes, source loss, cancellation, Stop, owner-disabled refusal and hard panel restart. It retains proof files under `.temp_files` (or `--proof=<directory>`) and removes resources only after checking their ownership labels. The release workflow repeats this gate on the pushed version image before promotion/publication. Its Host-header fixtures do not certify public DNS or TLS termination for an operator's domain.

0.18.2 measured local steps use their own access-log window, independent of the analytics tailer's 10-second poll. The full step timer starts after routing acknowledgement and source opening. Completed JSON records are counted by byte position, with a final drain before the verdict. The selected local service, proxy identity/restart, static-config fingerprint and writable log mount are rechecked. File replacement/truncation, malformed or incomplete records, source errors and unreadable analytics settings fail the step and request a confirmed rollback instead of manufacturing zero traffic. Complete windows below `minRequests` retain the healthcheck-only policy above.

A window is limited to 32 MiB, 100,000 records and 16 KiB per record, with at most 16 concurrent windows. Crossing a limit fails observation. Normal owner rotation is deferred during a window; above the existing 64 MiB trigger plus a 32 MiB allowance, windows are invalidated before forced rotation. This is a rotation trigger, not a filesystem quota. Disabling/purging analytics invalidates active windows. A completed local file window describes logged responses; producer-level loss detection for these local windows is unfinished. The separate node protocol below adds request-sequence coverage for eligible node canaries.

Local canary state remains in memory: a panel restart ends that canary and clears its split. The primary Docker transition journal controls interrupted-runtime reconciliation where applicable; see the primary recovery section below. Each run has an opaque owner distinct from its deployment number. Routing/source/probe/close continuations recheck ownership, and parent cleanup cannot end a newer incarnation of the same deployment. A failed initial deployment checkpoint writes no canary state or routing. Periodic verification is capped at ten seconds and the deployment’s configured health timeout; remote initial qualification and its three stable samples are unchanged. A successful probe completed after the step boundary is reused before the final observation drain.

<a id="node-traffic-observations-unreleased-0180-internal"></a>

<a id="node-traffic-observations-0180-internal"></a>

<a id="node-traffic-observations-0181-internal"></a>

### Node traffic observations (0.18.2; internal)

The internal controller adapter reserves, polls, finishes and closes node observations through sealed `proxy.traffic.open`, `.sample`, `.finish` and `.close` operations. Eligible node canary workers consume this transport through the existing service deploy/canary controls. The node owner must add `NINEDEPLOY_AGENT_PROXY_TRAFFIC=on` to the agent environment; unset or off means no advertised capability and no operation admission. The panel refuses plaintext fallback for this entire operation family, including when legacy fallback was explicitly allowed. Raw observation operations have no public panel endpoint.

The observer streams the existing default Traefik v3.1 common access log through the node's Docker Engine. It does not change logging configuration or restart the proxy to open a window. A running, non-TTY `ninedeploy-proxy` with the `json-file` or `local` driver and a direct Engine socket/TCP transport is required. Nondefault Docker contexts and CLI/TLS-only transports are refused. Runtime names, immutable IDs, running state and managed-service labels must match the selected service. Proxy identity, start/restart metadata and log-source fingerprint are checked again before accepting results. The controller also rechecks placement, deployment state, cancellation and its caller-supplied checkpoint around RPCs. The caller supplies the exact expected routing content, limited to 1 MiB in UTF-8. The agent checks both HTTP and TLS handler generations and enabled definitions against it using the pinned proxy container ID, then confirms the proxy did not restart during those reads. Active-window verification repeats these checks; a failed check invalidates the reservation. Receipts bind the SHA-256 routingGeneration to the request and target identities. Private routing content is discarded after completion or closure rather than retained in the retry cache.

Unpredictable loopback GET markers delimit a window; each must produce an unrouted HTTP 404 record. Traefik assigns its request counter when a request starts, so response completions can arrive out of order ([upstream logger](https://github.com/traefik/traefik/blob/v3.1/pkg/middlewares/accesslog/logger.go)). A final receipt requires every counter between the two markers, including requests to other services; only the selected upstreams contribute stable/canary statistics. A five-second final drain allows late completions. Filtered or missing records, a missing marker, source replacement or requests still in flight after that drain refuse the result. Long-lived requests and WebSockets can therefore make a window unavailable. A genuine empty interval is accepted only with adjacent observed markers. This attests the bounded HTTP counter interval, not connection failures before the proxy's HTTP handler.

Receipts carry source/agent epoch, service/node/deployment/step and target identities, coverage counts, 5xx rates and p95 at one-millisecond precision. They omit client addresses, request paths, headers and raw access records. Windows are limited to 32 MiB of stream data, 100,000 records, 16 KiB per line and 16 active reservations. Requested duration is one second to one hour; opening has a ten-second deadline, active reservations expire after 30 seconds without a poll or at duration plus 20 seconds. Completed receipts and closed-request tombstones are cached for up to 60 seconds, subject to a 128-entry capacity. Shutdown clears sessions and rotates the agent epoch. Cancellation closes a known reservation best-effort; agent expiry bounds an unconfirmed/lost open response.

Expected routing is checked at observation boundaries; continuous per-request generation attestation is not claimed. The worker binds reservations to its primary transition lease, immutable stable/candidate identities, selected node and weighted step. Node promotion waits for the current complete measured step and its configured verdict before skipping remaining steps; local manual promotion retains its existing early behavior. Public node canary is limited to the single-replica scope above. Node autoscaling/sleep and additional runtime support follow in R2; local file observations retain their separate limitations above.

### Autoscaling (0.16.10)

A docker service on the panel host can run between a minimum and a maximum number of containers, set by load, without a redeploy. Configure it under **Service → Settings → Autoscaling**, or with `autoscale` on `PATCH /v1/services/:id`:

| Field | Default | Meaning |
| --- | --- | --- |
| `minReplicas` | 1 | containers it never goes below (1–10) |
| `maxReplicas` | — | containers it never goes above (up to 10, above the minimum) |
| `metric` | `cpu` | `cpu`, `memory` or `rps` |
| `target` | — | the value per container to keep near (see below) |
| `scaleUpSeconds` | 60 | how long the need must last before it adds containers (30–3600) |
| `scaleDownSeconds` | 300 | how long the need must last before it removes containers (60–3600) |

The metrics, per container:
- `cpu`: percent of the service's CPU limit, or of one core without a limit.
- `memory`: percent of the service's memory limit. Set a limit, or this reads the host's memory.
- `rps`: requests per second over the last minute, from traffic analytics. Traffic analytics (**Traefik → Traffic**) must be on; otherwise the autoscaler holds and says so.

**How it decides.** Every 30 s, the count it needs is the current count times value ÷ target, within the bounds. Within 10 % of the target nothing changes. It adds containers once the need has lasted `scaleUpSeconds`, to the smallest count asked for in that time. It removes them once the need has lasted `scaleDownSeconds`, to the largest count asked for in that time, so a short dip does not drop capacity.

**How it scales.** Each deploy creates all `maxReplicas` containers (`<runtime>`, `<runtime>-r2`, …) and stops those it does not need. It keeps as many serving as served before the deploy, within the bounds. Scaling up starts a stopped container and routes it only after it passes the service's healthcheck. Scaling down first routes containers away, then stops them. Each change is in the activity log as `service.autoscale`, with the reason.

CPU and memory decisions require valid measurements from every serving container and a collector sample no older than 90 seconds. Unknown memory limits, incomplete samples and failed reads hold scaling and restart the load window. A configured bound change still takes effect without waiting for a load window.

A failed routing transition restores the previous serving count and keeps containers running. For a routed service on the panel host, the next pass must confirm the loaded HTTP/TLS routing generation before cleaning spare containers. Scale-down then allows a two-second drain for in-flight requests. A queued, building or deploying release, a changed runtime/configuration, or controller shutdown prevents a pending readiness operation from publishing its old decision. Shutdown waits for active operations to finish.

The Overview keeps status errors visible with **Retry status**, hides unavailable measurements and highlights the reason scaling is held.

Resource telemetry displays **No data** when a running service has no measured CPU/memory value. Empty history does not draw a zero-valued chart. Historical fallback values are labelled **Last recorded sample**; a real measured zero still displays zero.

**Panel-host routing confirmation.** A routed local deploy, canary step or autoscale change waits up to 15 seconds for the requested generation and enabled router/backend definitions to be observed. The generation travels in the same atomic file as the managed routes and is checked through both HTTP and TLS handlers. A canary observation window starts after this acknowledgement. The internal API route uses the reserved host `ninedeploy-routing.invalid`, exact path `/api/rawdata` and a loopback IP allow list inside the proxy container; no management port is published. Its objects are hidden from the application routing tables. Ordinary config edits and unrouted workers do not wait for this check.

If confirmation and the retry fail, a blue-green deploy attempts to confirm the previous routing. When that outcome is also unknown, it fails the deploy and keeps both runtime generations running; the deployment log names the retained candidate. A first runtime that might already serve traffic is retained too. Resolve the proxy problem before retiring a retained container. This protects availability at the cost of temporary extra capacity.

**Node routing confirmation (agent target 0.18.2).** Routed primary-node deployments require sealed transport and the `proxy.routingAck` capability. Before writing node routing, the panel checks the live capability answer; an older agent is refused with an update instruction. The agent observes both HTTP/TLS generations inside its fixed `ninedeploy-proxy` container and returns only the requested generation hash, never raw private API state. A lost dynamic-write response or failed load confirmation is an unknown outcome, so the same confirmed-rollback/retain-both rule applies. Ordinary fleet refreshes and unrouted workers retain their compatibility path. This confirms routing application, not application readiness: node default health remains container state; select explicit HTTP readiness to require an HTTP response. Eligible primary node canary adds the requirements described above; node autoscaling remains later R2 work.

During the routing transition the deployment remains `deploying`, with no `finishedAt`; it stays in the queue view and blocks another deployment of that service. Only acknowledged routing can mark it `running` and supersede the previous deployment. Cancellation still applies during this phase: a healthy previous generation is restored and confirmed before candidate retirement. If rollback cannot be confirmed, both generations remain. A first or in-place runtime, or a candidate whose previous runtime is unhealthy, is kept live rather than stopped after routing; the cancelled deployment log explains that outcome. Explicit stop cancels a pending routing transition. Cancellation cleanup does not reinstate a service that is stopped or now points at another runtime.

`GET /v1/services/:id/autoscale` shows:
- the containers serving now;
- the last value and the count it asks for;
- why it holds, if it does: a deploy or a canary in progress, no traffic analytics for `rps`, or no spare container yet;
- the last change.

Notes:
- Turning autoscaling on applies fully at the next deploy, which creates the spare containers; until then it can only scale down. Turning it off keeps the containers that serve now until the next deploy, which runs `replicas` containers again.
- As with replicas, a host port reaches the first container only; the others serve through the domain.
- Autoscaling holds for services on a node and for Swarm services (Swarm scales with its own replicas).
- Stopped spare containers take disk space only. With `--restart always`, a Docker restart starts them again; the autoscaler stops them at its next look.

#### Scheduled minimums (G5.6)

An autoscaled service can raise its minimum in weekly time windows, for example weekdays from 08:00 to 18:00. Set them under **Settings → Autoscaling → Scheduled minimums**, or as `schedules` and `timezone` in the `autoscale` configuration:

```json
{ "minReplicas": 1, "maxReplicas": 6, "metric": "cpu", "target": 70,
  "timezone": "Europe/Istanbul",
  "schedules": [{ "days": [1, 2, 3, 4, 5], "from": "08:00", "to": "18:00", "minReplicas": 3 }] }
```

- Days run from 0 (Sunday) to 6. The times are local to `timezone`, an IANA name that defaults to UTC.
- A window whose end is before its start runs past midnight and counts for the day it starts on.
- The highest floor in force wins, capped at `maxReplicas`. A floor may not be above `maxReplicas`.
- When a window begins, the autoscaler starts containers up to the floor within 30 seconds; the scaling event names the window. When the window ends, the floor stops holding capacity and normal scale-down applies.
- The status (`GET /v1/services/:id/autoscale`) shows `scheduledFloor` while one is in force.
- At most 20 windows per service. No migration is needed: they are part of the stored autoscale configuration.

### Right-sizing hints (G5.6)

**Settings → Right-sizing**, under Resource limits, suggests memory and CPU limits from the service's metric history. `GET /v1/services/:id/sizing` returns the same (viewer).

**What it reads**
- The primary container's 95th percentile and peak, memory in MiB and CPU in cores.
- Up to a week of history: the raw samples of the last day, plus the 5-minute summaries when the metric retention keeps more.

**What it suggests**
- **Memory**, with no limit: set one with room above the peak.
- **Memory**, with a peak above 90 % of its limit: raise the limit.
- **Memory**, with a peak under 40 % of a limit of 256 MiB or more: lower the limit.
- **CPU**, with the 95th percentile above 80 % of its limit: raise the limit.
- **CPU**, with a peak under 25 % of a limit of half a core or more: lower the limit.

There are no suggestions under 12 hours of history. The hints are advisory: nothing changes until someone edits the limits.

### Scale to zero (0.16.11)

A docker service on the panel host can sleep when nobody uses it and wake on the next request. Set **Service → Settings → Sleep when idle**, or `sleepAfterMinutes` (5–1440) on `PATCH /v1/services/:id`; `null` turns it off.

**Going to sleep.** Every minute, a service sleeps once its domains have had no request for `sleepAfterMinutes`:
1. Its domains are routed to the panel's wake endpoint.
2. Its containers stop. Nothing is removed: the containers, volumes and variables stay as they are.

The service stays `running` in the panel with an `asleepAt` time, and the activity log records `service.sleep`.

**Waking up.** The next request through one of its domains:
1. starts the containers and waits for the healthcheck (the service's healthcheck timeout, or 60 s);
2. routes the domains back, and the activity log records `service.wake`.

What the visitor gets:
- a GET or HEAD is sent back to the same URL, which the app now answers. Most apps wake in a few seconds, so the visitor sees only a slower first page;
- other methods get `503` with `Retry-After`, because their body cannot be replayed;
- if the wake takes longer than 25 s, a small "Waking up" page that reloads itself (`503` with `Retry-After` for non-browser clients).

A domain's basic auth and IP allow list run before the wake, so a protected service wakes only for allowed visitors.

**By hand.**
- `POST /v1/services/:id/sleep` puts a service to sleep now, even without `sleepAfterMinutes`.
- `POST /v1/services/:id/wake`, **Start** or **Restart** wakes it.
- **Stop** ends the sleep (the service is then stopped). A deploy ends it too; the new release is awake.

Requirements and limits:
- Traffic analytics must be on (**Traefik → Traffic**): requests are counted from the traffic log. Without it nothing sleeps.
- The service needs at least one routed domain; otherwise nothing could wake it. Host ports and the service's internal network do not count as requests and do not wake it, so a service reached only that way should not sleep.
- Panel host only; not for node or Swarm services. Nothing sleeps during a deploy or a canary, and the autoscaler holds while a service sleeps.
- The idle window starts again after a panel restart and after each deploy.

### Pending changes (G5.2)

A service's settings normally apply as each card is saved. Turn on **Settings → Pending changes → Stage edits before applying** to collect edits instead, then apply them together.

**How it works**
- While staging is on, every settings card stages its edit. The service stays as it is.
- The tray shows each change as a field with its value now and after. A field set back to its current value leaves the tray.
- **Apply and deploy** applies the changes together and queues a deploy, which an approval-gated lane then holds for review. **Apply only** applies them without a deploy. **Discard** empties the tray.
- Applying sends the staged changes as one `PATCH /v1/services/:id` with your own credentials. Every check of a direct edit applies: your role on the service, operator-only fields, and validation. The changes land together or not at all.
- If PATCH refuses them, the tray keeps them, so you can fix or discard the refused change.
- Changes someone else staged apply only with **I reviewed them** (`includeOthers`), because they run with your permissions. Each change shows who staged it.
- Apply names the version of the tray you reviewed. If someone staged more in the meantime, apply is refused (`409 pending_changed`) until you review again. Afterwards only the applied changes leave the tray.
- The tray shows you only what the service page shows you. A field you cannot see there, such as a stack's YAML for a non-operator, is shown as hidden.
- Staging is per service and shared by everyone who edits it. Tags and environment variables keep their own routes and apply directly.
- Concurrent tray writes compare the stored state and retry instead of silently overwriting another edit. If contention persists, the operation returns `409 pending_busy`; refresh and retry.

**API, SDK and storage**
- API: `GET`/`PUT`/`DELETE /v1/services/:id/pending`, `PUT …/pending/staging` with `{ staging }`, and `POST …/pending/apply` with `{ deploy, includeOthers, version }`. Read `version` from the reviewed tray and send it back unchanged; `updatedAt` is a display timestamp, not the review token. Older stored trays without a token expose their timestamp as `version`. Clients that send only `updatedAt` for a newly staged tray receive `409 pending_changed` and must refresh and use `version`.
- SDK: `services.pending.*`.
- Audited as `service.changes.stage`, `service.changes.staging`, `service.changes.discard` and `service.changes.apply`.
- No migration is needed: the tray is one settings row per service.

### Inline Dockerfile (G1.1)

A docker service that builds from source can use a Dockerfile pasted in the panel instead of one kept in the repository. Set it under **Service → Settings → Inline Dockerfile**, or with `PUT /v1/services/:id/inline-dockerfile` and `{ "content": "FROM …" }`. `{ "content": null }` builds from the repository again.

**How it builds**
- On the next deploy the text is written into the base directory as `.ninedeploy.Dockerfile`. That deploy builds with the `dockerfile` pack and that file, even when the repository has a Dockerfile of its own.
- The build arguments, the build target and the other build settings still apply.
- **Dockerfile only:** a docker service with neither a repository nor an image builds the Dockerfile from an uploaded source if there is one, otherwise from an empty context. The deployment's commit is then the hash of the Dockerfile.
- It works with the panel builder and with build placement on nodes, since both read the same build config. Checked with a real `docker build` from an empty context.

**Limits and storage**
- At most 64 KiB, and the text must start with `FROM` (or `ARG` before `FROM`).
- No migration is needed: the text is a settings row, `inline_dockerfile:<id>`.

### Restart-loop limit (G1.3)

A docker service on the panel host can be stopped when its containers keep crashing. Turn it on under **Settings → Restart-loop limit**, or with `PUT /v1/services/:id/restart-limit` and `{ "limit": { "maxRestarts": 5, "windowMinutes": 10 } }`. `{ "limit": null }` turns it off.

**How it works**
- Once a minute the panel reads Docker's restart count for each of the service's containers.
- When the containers restart `maxRestarts` times within `windowMinutes`, the service is stopped as the Stop button would: it is marked stopped, then every replica is stopped.
- Stopping it is audited as `service.restart_limit`, which notifies the channels that receive audit events. The card shows the restarts in the window and when the limit last tripped.
- A deploy in progress is left alone, since it restarts containers on purpose. A new container starts counting from scratch.
- Checked against a real container in a crash loop: the limit tripped after 3 restarts and the container stayed stopped.

**Limits and storage**
- Off by default, and only for docker services on the panel host, not on nodes or Swarm for now.
- No migration is needed: the limit is a settings row. The restart history is kept in memory, so a panel restart starts each window again.

### Healthcheck timeout (0.16.1)

The ordinary panel-host Docker HTTP gate in step 3 accepts HTTP **200–499** on the health path and waits **300 seconds** by default. If direct container-IP access fails, the sibling container checks the same HTTP path from the runtime's bridge; it never downgrades HTTP readiness to an open TCP socket. Exposed-port recovery also requires an HTTP response. Redirects are checked without following them to another host. Set **Service → Settings → Healthcheck timeout** (`healthTimeoutSeconds`, 10–3600) for an app whose first boot runs long migrations or downloads a model; leave it blank for the default. A failed deploy names the limit it hit. The old container keeps serving until the new one passes.

Choose a health path that reflects the application's readiness, including required database migrations and dependencies. The ordinary HTTP mode retains acceptance of authentication/error routes such as 401/404; choose **HTTP readiness (2xx / 3xx response)** for 2xx/3xx only, or a command below for a stronger application-specific check. TCP and container-running checks prove only those signals. Services publishing a direct host port use stop-then-start and cannot keep two instances on the same host port during the readiness wait.

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

### A database copy per preview (0.16.12)

With **Service → Settings → Previews → Give each preview its own database copies** on (`previewDatabaseCopy: true` on `PATCH /v1/services/:id`), every PR preview gets its own copy of each database attached to the parent service. The preview's `DATABASE_URL` (or whatever variable name the parent uses) then points at its copy: the preview runs against real-looking data, and production data is never touched.

- **When.** The copies are made on the preview's first deploy, before its environment is assembled; the deploy log shows each step. Later deploys of the same PR keep the copy and its data.
- **From what.** The parent database's latest completed backup (fetched from remote storage when the local file is gone). With no backup yet, a dump of the parent database is taken at that moment.
- **The copy.** A new managed database named `<database> · PR #<n>`, with its own container, volume and credentials, the same engine, version and limits, owned by the preview's owner. It shows in the Databases list like any other database.
- **Migrations.** Run them as the app normally does (its start command, or the pre-deploy hook): they apply to the copy.
- **Removal.** Closing the PR (with auto-destroy on) or evicting the preview removes its copies: container, volume and backups. A copy left behind some other way, for example when the parent service is deleted, is removed by the hourly housekeeping. Copies get no daily built-in backups.
- **Which databases.** PostgreSQL and the Redis family (Redis, Valkey, KeyDB, Dragonfly) on the panel host. MySQL, MariaDB and MongoDB dumps carry the server's own users, which would replace the copy's credentials, so they are not copied yet. Neither are databases on a node. The deploy log names each database that is left out, and the preview gets no variable for it.
- **Failure.** If a copy cannot be made, the half-made copy is removed and the preview's deploy fails with the reason. It never falls back to the production database.
- **Size.** A copy takes the disk of the parent database again, and a restore briefly needs about three times the dump's size free. The `previewMaxActive` limit also bounds how many copies exist.

### Pull requests from forks (0.16.14)

A pull request from a fork is code from outside the repository, so by default it gets no preview: the webhook answers `skipped: external_pr_repository`. With **Service → Settings → Previews → Build pull requests from forks** on (`previewForks: true` on `PATCH /v1/services/:id`; CLI `ninedeploy previews forks <service> on|off`), a fork's pull request gets a preview too, under these rules:

- **Every deploy waits for approval.** Each push to the fork's branch queues a deploy that waits as `awaiting approval`, whatever lane the service is in. An admin decides after reading the change. They do that on the preview's Deploys tab, on the Deploys page, or with `ninedeploy approvals approve|reject`.
  - In a lane, the lane's admins decide. Outside a lane, anyone with `admin` on the service decides.
  - A deploy an admin starts by hand goes straight through.
  - A newer push replaces the waiting deploy, so nothing older is built after it.
- **No credential.** The fork is cloned anonymously, on the panel or on a node. Neither the service's Git credential nor a GitHub App token is ever part of the checkout the fork's code builds from. So only a public fork builds; a private one fails at the clone, and the log says why.
- **Less than a same-repository preview.** A fork preview gets:
  - the parent's non-secret variables and the non-secret preview-only values;
  - no secrets of any kind;
  - no database copies, even with database copies on.
- **Docker services only, on the same git host.** A service that runs on the host (PM2), a compose stack, or a service with the Docker socket never builds a fork (`fork_preview_unsupported_type`). A fork on another host than the service's repository is ignored (`fork_on_another_host`).
- **Telling a fork from the repository.** The GitHub App compares repository ids, so a fork whose URL looks like the repository's is still a fork. A per-service webhook compares the head repository's URL with the service's.
- **The preview row.** `previewFromFork: true` on the preview service. `ninedeploy previews show` says so.

Turning the switch off refuses the fork's next push again, as before. Previews that already exist stay until their PR closes.

0.16.14 also fixes how GitLab merge requests and Bitbucket pull requests are read: their preview now clones the source (fork) repository. Before, it cloned the target repository at the fork's branch name, which failed or built the wrong code. A merge request from the repository itself is read as before.

---

---

## ⏪ 5. Rollbacks & Deployment History

- Image deployments record the resolved image digest when the runtime provides one; source deployments record a commit. Legacy rollback redeploys that artifact using **current** service settings and environment. The config diff is descriptive, not a complete recoverable configuration.
- Deployment history stays honest: when a new deploy goes live, older rows are settled into a `superseded` state instead of lingering as "Running", both at finalize time and during a reconciliation pass at panel boot.

### Recorded Compose releases (0.17.1)

New inline Compose deploys on the **panel host** can record their resolved Compose model, including resolved environment values and the image IDs actually used by all containers. This is a separate AES-GCM encrypted record; history, config diffs and the release metadata API never return its payload. Instance key rotation includes it. Keep the instance master keys with database backups.

The Deploys tab shows **Release recovery** and distinguishes recorded restores from legacy redeploys. A recorded rollback uses the old model and image IDs, without a checkout, image pull, rebuild, current env resolution or platform build hooks. The queue receives its own copy in the same transaction as the deployment, so deleting the original history later does not change its input. Current lane approvals and host privileges still apply; inline Compose execution remains operator-only. The editable service definition stays as it is: the next ordinary deploy applies those edits again.

- Only successful, previously serving releases are restorable. Old history has no retroactive record; deploy once to create one.
- Restore on the original panel host. The guard checks the service, slug, panel target and an existing primary container's name; it does not fingerprint the Docker daemon. Moving the panel database does not move images or volume data. Node/Swarm and repository-based Compose snapshots are not implemented.
- Models with bind/anonymous mounts, unresolved environment entries, external config/secret/env/label files or profiles do not receive a restorable record. A capture or storage failure is logged without model contents and does not fail an otherwise healthy deployment.
- Pinned image IDs must still exist on that Docker daemon. NineDeploy's image cleanup preserves every image ID referenced by a retained release record, including unused/untagged images and copied queued restores. This applies to automatic cleanup, hourly maintenance, Images API/CLI, system cleanup and doctor repair. The inventory reports `releaseProtected` separately from `inUse`; CLI `images ls` shows `release: kept`.
- Protection ends when the last referring deployment record is deleted (including normal history retention). Unreadable encrypted records stop image cleanup rather than risk deleting their images. Keep the master keys available; recover them or explicitly remove affected history before retrying cleanup. Manual Docker commands outside NineDeploy can still remove images. A missing image fails **before** stopping the running project; records do not archive image layers.
- Cleanup with protected images reports an image-size estimate; shared layers can make the actual reclaimed disk space smaller. The disk-usage reading after cleanup remains separate.
- Compose still replaces its project **in place**, with a brief interruption. This is not blue-green deployment or automatic recovery after a failed start.
- Named volume **data is not snapshotted or rewound**. Database migrations and data compatibility remain application responsibilities.
- Before manually downgrading to 0.17.0, cancel queued/awaiting-approval recorded restores and stop the worker. That version ignores the new restore input and must not process it. The additive table/column can stay; after upgrading again their encrypted records are readable.

`GET /v1/services/:id/deploys/:depId/release` (viewer) returns `available`, `mode`, `imageCount` and `reason`. Recorded releases also return `imageAvailability` (`present`, `missing` or `unknown`) and `missingImageCount` (unique IDs; `null` when Docker cannot be checked). SDK: `deploys.releaseInfo`. The bounded local image check includes untagged images. Missing images or an unsuccessful Docker check disable confirmation; the API repeats the check and refuses `POST .../rollback` before queueing. Availability is a point-in-time result: the worker still checks image IDs again before teardown.

Real-Docker verification uses a disposable daemon and panel, including changed YAML/env/tags, panel restart, source-history pruning, exact image/env recovery, retained volume data and missing-image refusal:

```sh
node scripts/smoke-user-journey.mjs --image=ninedeploy-local:YOUR_BUILD --compose-release-only
```

The model comes from [`docker compose config`](https://docs.docker.com/reference/cli/docker/compose/config/); restore uses [`up --pull never --no-build`](https://docs.docker.com/reference/cli/docker/compose/up/). Compose's canonical dollar escaping is retained during replay rather than escaped a second time.

### Registry webhook: redeploy when the image is pushed (G1.7)

An image service can redeploy as soon as its tag is pushed, instead of waiting for the 30-minute auto-update sweep. Turn it on under **Settings → Registry webhook** (or `POST /v1/services/:id/registry-hook`). Copy the URL then: it is shown once, because only its SHA-256 is stored. Paste it into the registry:

| Registry | Where |
| --- | --- |
| Docker Hub | Repository → Webhooks |
| GitHub Packages (GHCR) | A repository or organization webhook with the **Packages** event (`registry_package`) |
| Harbor | Project → Webhooks, event *Artifact pushed* |
| `registry:2` / Distribution | `notifications.endpoints[].url` in the registry config |
| A CI step | `curl -fsS -X POST -H 'content-type: application/json' -d '{"image":"ghcr.io/acme/api:v1"}' <url>` |

**What a call does**
- When a pushed repository and tag are the service's image (and the registry, when the payload names one), it queues a deploy, which pulls the new image. The deploy runs as the member who made the hook, with every check a manual deploy makes, and waits for approval in an approval-gated lane.
- Other pushes answer `202 { "ignored": true }`. A second push while the deploy is still queued answers with that deploy.
- The auto-update baseline is cleared, so the sweep does not deploy the same push again.

**Limits and storage**
- Turning it off, or making a new URL, makes the old URL answer 404, as does deleting the member who made it.
- No migration is needed: the hook is a settings row, `registry_hook:<serviceId>`.

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

### Protected lanes and deploy approvals (0.16.13)

A lane (an environment: production, staging, …) has two switches in **Services → Lanes**. Both are off on every lane, including after an upgrade, and only a workspace admin can change them.

**Protected.** The lane's variable values, deploy logs and runtime logs are for the lane's admins only, and so are its mounted files, log search and AI diagnosis. Members keep working as before:
- they edit the service and push code, and git deploys keep running;
- they can set or replace a variable's value;
- they cannot read a value back: it shows as `•••• protected lane`, and the API returns it as `''` with `hidden: true`.

A member also cannot clone a protected service, export its variables, or move it to another lane. A clone would hand over the variables, and leaving the lane would lift the protection.

**Require approval.** Every deploy into the lane waits as `awaiting approval` until an admin of the lane approves it or rejects it. It does not matter whether a webhook push, a schedule, an image update, a deploy hook or a member started it.
- Approve and it builds as usual; reject and it ends as `cancelled`.
- A deploy an admin starts from the panel, the CLI or the API goes through without waiting. A deploy hook URL always waits, because whoever holds the URL is not necessarily the admin who made it.
- Each service has at most one waiting deploy. A newer push replaces the older waiting deploy, and when a deploy of the service starts, its older waiting deploys are dropped, so approving never ships older code.
- The author can withdraw a waiting deploy with cancel.
- Waiting deploys never expire, and the history sweep keeps them.
- A waiting deploy sends a `deploy.awaiting_approval` notification, which any channel that receives deploy events picks up. Decisions are audited as `deploy.approve` and `deploy.reject`.
- Turning the switch off does not release deploys that are already waiting; approve or reject them.

**Who counts as an admin of a lane:**
- an operator;
- an admin or owner seat in the lane's workspace;
- an admin access grant covering the service.

Having created the service is not enough. Otherwise a member could approve their own deploy into production, or read the secrets of a service they cloned.

**PR previews** take their parent's lane:
- a protected service's previews are protected too;
- an approval-gated service's previews wait for approval. A preview runs the PR's code with the parent's variables, so this is where the gate matters.

Previews of pull requests from forks are refused unless the service builds them (0.16.14, [below](#pull-requests-from-forks-01614)), and then each of their deploys waits for approval whatever the lane says.

- API:
  - `PATCH /v1/environments/:id` with `{ protected, requireApproval }` (admin);
  - `GET /v1/services/approvals`, which lists what waits and whether you may decide;
  - `POST /v1/services/:id/deploys/:depId/approve` and `/reject`;
  - the deploy list carries `reviewedBy` and `reviewedAt`.
- SDK: `environments.update`, and `deploys.approvals`, `deploys.approve`, `deploys.reject`.
- CLI:
  - `ninedeploy lanes list`;
  - `ninedeploy lanes protect <lane> on|off`;
  - `ninedeploy lanes require-approval <lane> on|off`;
  - `ninedeploy approvals list`;
  - `ninedeploy approvals approve|reject <service> [--deployment <id>]`.

### Deploy freezes (G5.5)

An operator can freeze deploys during a release week, an incident or a holiday. A freeze covers one of:
- the whole instance;
- a workspace, including the services in its environments;
- a project;
- an environment (lane).

Each freeze has a reason and an optional end. A PR preview is covered through its parent service.

**What a freeze does**
- The worker checks freezes when it claims a deploy, so every trigger is held: the UI, the API, a git push, a deploy hook, a schedule, an image poll and a rollback.
- A held deploy stays `queued`. Its log says once which freeze holds it and why.
- When the freeze ends or is lifted, the held deploys start. Nothing is dropped.
- Deploys outside the freeze run as usual.
- To roll back during a freeze, lift it first.

**Where to manage it**
- UI: Settings → Deploy freeze (operator only).
- API: `GET /v1/deploy-freezes`, `POST /v1/deploy-freezes` with `{ scope, targetId, reason, until }`, and `DELETE /v1/deploy-freezes/:id`. Changes are audited as `deploy.freeze` and `deploy.unfreeze`.
- SDK: `deployFreezes.list`, `deployFreezes.create` and `deployFreezes.lift`.

No migration is needed: the freezes are stored in a single settings row.

### Image vulnerability scanning (G5.1)

Trivy scans each Docker deploy's image on the panel host and rescans running images on a schedule. Panel-host Compose stacks and Docker services on nodes are scanned on request and on the schedule, after they start; their scans are report-only. It is off by default; an operator turns it on under Settings → Image scanning.

**How the scan runs**
- Trivy runs in a throwaway container that reads the image from `docker save` on its stdin. It never gets the Docker socket and needs no host path.
- Only its vulnerability database persists, in the `ninedeploy-trivy-cache` volume. The first scan downloads it, which takes about half a minute; later scans of a typical image take seconds.
- The scanner is `aquasec/trivy:0.69.3`, pinned by digest. Trivy 0.69.4 to 0.69.6 were malicious releases (CVE-2026-33634); 0.69.3 predates them. `NINEDEPLOY_TRIVY_IMAGE` selects another image, such as a mirror or a newer release; pin it by digest too.
- Scans run one at a time on the host.
- A node scan runs through the agent's sealed `image.scan` capability; older agents must be updated. A node owner can disable it with `NINEDEPLOY_AGENT_IMAGE_SCAN=off`.

**During a deploy**
- The new container's image is scanned after it starts and before it gets traffic. The deploy log shows the counts.
- The gate is one of: report only, block critical findings, or block critical and high findings.
- When the gate counts findings, the deploy fails there and the previous release keeps serving. The service's scan is marked *blocked*.
- By default the gate counts only findings with a fixed version available. A base image often carries CVEs that cannot be fixed (debian:12 has one critical and 56 high CVEs, none fixable); counting those would block every deploy.
- A scan that cannot run never blocks a deploy, for example when there is no network to update the database. It is recorded as `error`, and the deploy log says so.

**Scheduled rescans**
- Once an hour, running images whose latest scan is older than the interval (default 24 hours), or was of another image, are scanned again.
- Failed scans and incomplete Compose scans are retried at the next hourly sweep. A partial result keeps findings from scanned images and names the images that could not be scanned; it does not report the stack as clean.
- If Docker cannot provide a complete Compose container and image inventory, the scheduled result is marked as an error instead of retaining a previous clean verdict.
- A rescan that finds new fixable critical findings is audited as `image_scan.critical`, which notifies the channels that receive audit events.

**Where the results show**
- Each service shows its latest scan on its Deploys tab: counts by severity (with how many are fixable) and up to 300 findings, most severe first.
- A service admin can press *Scan now*.

**Nodes and Swarm**
- A docker deploy on a node is scanned by the node agent (0.18.7 or newer, capability `image.scan`) before it gets traffic, under the same gate. A node that cannot scan (an older agent, or `NINEDEPLOY_AGENT_IMAGE_SCAN=off`) records why and does not block the deploy.
- Swarm services are scanned on the panel host from the image their spec runs, on the schedule and on request.

**What has no deploy gate**
- Compose stacks (`compose up` replaces the stack at once, so there is no moment before traffic) and Swarm services. Both are scanned on the schedule and on request.

**API, SDK and storage**
- API: `GET`/`PUT /v1/image-scanning` (operator), `GET /v1/services/:id/image-scan` (viewer) and `POST /v1/services/:id/image-scan` (admin, runs in the background).
- SDK: `imageScans.policy`, `setPolicy`, `get` and `scan`.
- No migration is needed: the policy and each service's latest result are settings rows. A deleted service's result is pruned by the hourly sweep.

## 🧩 6. Docker Compose Stacks

A multi-container app deploys as `type: compose`. The stack runs as the compose
project `ndcmp-<slug>`; `composeService` names the service Traefik routes to and
whose healthcheck gates the deploy. There is **no blue-green** here — compose
replaces the project in place, so expect a brief gap. Compose files often
bind-mount host paths or request privileged containers, so creating and
deploying one is **operator-only**.

**Unchanged builds are skipped (G2.4).** Before it builds, a compose deploy fingerprints its inputs: the commit and the resolved compose model from `docker compose config`, which covers the build contexts, Dockerfiles, build args and interpolated environment.
- When the fingerprint matches the last build, the deploy logs *Build inputs are unchanged* and reuses the built images. An image that has gone missing is still built by `up`.
- A deploy without an exact commit always builds.
- A base image that changed upstream is not picked up while the inputs stay the same. Set `NINEDEPLOY_COMPOSE_BUILD_SKIP=off` to build on every deploy.
- The fingerprint lives in the panel's data directory (`compose-build/<slug>.sha256`, and `node-<serverId>-<slug>.sha256` for a stack on a node).
- **On a node:** the agent prints the resolved model (`docker.composeConfig` with `print`). The panel reads it through a silent sink, since it carries the interpolated environment, and keeps only the hash. A match brings the stack up without `--build`. An agent too old to print the model, or one that ignores the request, simply builds as before.

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

**0.17.1 lifecycle (superseded by the 0.18.2 flow below):** one stack `nd-<slug>` with one service
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

**Leaving Swarm in 0.17.1:** set the orchestrator back to `container` and redeploy. The
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

## Service tunnels (G5.8)

`ninedeploy tunnel service <id>` makes a container port of a running panel-host docker service available on your machine. Use it for an admin port, a debugger, or a service that has no domain. Nothing is published.

```bash
ninedeploy tunnel service 12                          # the service port, on the same local port when it is free
ninedeploy tunnel service 12 --target 9229 --port 0   # the Node inspector, on any free local port
ninedeploy tunnel service 12 --replica 2              # the second replica
```

**How it works**
- Each local connection travels over its own WebSocket (`GET /v1/services/:id/tunnel?port=&replica=`) to the container, byte for byte, as the database tunnel does.

**Access**
- The tunnel reaches the container directly, past what the service's domains enforce: forward auth, IP allow lists and basic auth. It therefore needs the service `admin` role, the role that can change those settings.
- A scoped API token must also be allowed to write services.
- Access is re-checked every minute.

**Limits**
- At most 32 tunnels per user, database and service tunnels together.
- An idle tunnel closes after 30 minutes.
- Opening and closing are audited as `service.tunnel.open` / `service.tunnel.close`, with byte counts.
- Swarm, compose, PM2 and node services are refused for now.

## Docker artifact promotion (0.17.1)

A successful repository-backed Docker deployment on the panel or a capable node records its actual immutable image ID and buildpack conventions. Node-built artifacts retain a verified image copy on the panel before their record is saved, so recovery does not depend on the origin node staying online. In Deploys, choose **Same artifact · no rebuild** and a service tracking the same repository. Confirmation names the image and target. The deployment detail shows the original build, historical build node and promotion source.

`POST /v1/services/:id/promote` accepts `{ "targetServiceId": 2, "mode": "artifact", "sourceDeploymentId": 123 }`. The optional source ID refuses a stale selection if another release is now running. The current SDK exposes `deploys.promote(source, target, { mode: 'artifact', sourceDeploymentId })`. Omitting mode preserves the existing **same commit · rebuild** behavior, including for older clients and historical deployments without an artifact.

Artifact mode copies the record into the target deployment. It survives source history deletion and panel restart. Exporting an image from a protected source lane requires that lane's secret-reading authority, including for previews inheriting a protected parent: build-time secrets may already be baked into the image. Target required GitHub workflows must pass for the pinned commit, and target lane approval remains required. No Git checkout, manifest application or compilation occurs. The worker transfers the image to a node using the existing sealed, verified stream relay, or pulls its recorded registry digest. The candidate's actual image ID must match before it can serve traffic; missing images never trigger a rebuild or mutable-tag fallback.

Target runtime environment, attached databases, files, volumes, ports, command, resource limits, restart policy and health checks apply. Source build-time variables, dependencies and files stay baked into the image; changing target build settings cannot rewrite them. Configure target routes and dependencies in the panel: source manifests are not replayed during promotion. Database/volume contents are never copied or restored.

The source build may run on the panel, target node or a separate build node; a promotion can run on the panel or one Docker node. Nodes need a sealed transport and `image.manage`; stream transfers also need `stream`. Runtime capability, database and file/volume guards still apply, while Git credential and build-pack requirements are skipped because no node build occurs. Host pre-deploy/post-deploy/pre-stop hooks remain unsupported. Swarm support is added by the 0.18.2 flow below. Node capture requires sealed transport, image.manage and stream when the panel does not already hold the exact image. Missing capabilities or a failed observation/cache leave an ordinary deployment working without an artifact record; configure a push registry when successful archival must be required before traffic changes.

The 0.18.2 increment adds configured fan-out targets to artifact promotion and artifact rollback. Each target receives the exact recorded image ID from the retained panel copy or its recorded registry digest; it never checks out the repository, discovers a buildpack or rebuilds source. Current target-service environment, runtime options and resolved port apply. Nixpacks images receive the resolved `PORT` default unless the target environment explicitly provides one. Routed targets require sealed `proxy.routingAck` and `docker.recovery`, then use the same readiness, guarded routing, drain and durable recovery flow as an ordinary fan-out deploy. Target failures preserve the previous runtime and appear in per-target status/logs while the primary remains live. These fan-out transitions do not restore volume/database data. Swarm uses the separate native flow below.

For a registry archive, an operator selects **Push registry** and **Repository** in the source service's Build placement settings, then deploys it on the panel or a capable node. The source's registry credential must be bound to exactly one host. The successful push records the manifest digest separately from the image ID, and Deploys shows the immutable registry reference. A push or archive-record failure fails the candidate before routing changes. The existing secret-export policy refuses Nixpacks images containing secret environment variables and Dockerfile builds using secret build arguments. Existing historical artifacts are not uploaded retroactively.

An archived artifact can restore a missing local image or reach a target node even after its source deployment history is deleted. Registry credentials are loaded at use time and their original host binding is checked again; a removed/revoked credential fails recovery. The registry must remain reachable and retain the recorded manifest and layers: NineDeploy does not control external registry garbage collection. Registry retention is not a database/volume backup.

Without an archive, keep the image on the panel: all NineDeploy image cleanup paths protect it while any source or copied deployment record is retained. Deleting the last retained record releases that protection; external Docker cleanup can still remove the image. Node caches can be repopulated from the panel or archive. A corrupted artifact record stops NineDeploy image cleanup until that history is repaired or removed.


<a id="primary-docker-transition-recovery-unreleased-0180"></a>

<a id="primary-docker-transition-recovery-0180"></a>

<a id="primary-docker-transition-recovery-0181"></a>

## Primary Docker transition recovery (0.18.2)

Routed plain Docker replacements persist a primary transition after candidate readiness and lifecycle preparation, before canary or full traffic publication. Migration 0098 permits one unresolved transition per service. The journal captures every serving replica's immutable container ID, separately records owned stopped autoscale capacity, and retains previous/candidate routing metadata and a renewable ownership lease. Stopped capacity never counts as a readiness backend. It stays with the selected generation; obsolete owned capacity is removed by immutable ID after routing confirmation. Unrelated containers at possible spare names are never adopted. Node candidates carry managed service/deployment labels and require sealed `docker.recovery` plus `proxy.routingAck` before traffic changes; explicit HTTP/TCP readiness also requires `docker.probe`. Default node readiness remains container-state based unless HTTP/TCP is selected.

After a panel restart, the worker hands these transitions to recovery rather than deleting possibly routed candidates or rebuilding them as stale jobs. An interrupted job stays building/deploying while recovery is pending. Only its own service's queue waits; unrelated services can use the host's deployment slots. Automatic checks resume after the live lease expires. Settings shows **Primary runtime recovery**, its holding reason and retry time. Operators can use `GET/POST /v1/services/:id/runtime-recovery` or SDK `services.runtimeRecovery/retryRuntimeRecovery`; a manual retry never steals a live lease.

Recovery repeats the configured readiness for all captured serving replicas, confirms the proxy's loaded HTTP/TLS generation, drains requests, and stops/removes only known obsolete IDs. An interrupted canary returns to the previous generation; an interrupted full cutover may finish on its healthy candidate. Before retirement commits, an unhealthy candidate can fall back to the confirmed healthy previous generation. After commitment, recovery never restores the obsolete generation. Cancellation cannot turn into a successful deployment, and explicit Stop remains stopped; its selected container is retained for a later Start. No recovery operation starts a stopped container.

Unknown or renamed identities, changed placement/runtime/replica ownership, missing deployment history, unavailable readiness/routing acknowledgement and restricted TCP sidecar routing retain the generations for review. Restricted TCP port proxies need separate loaded-routing confirmation; this HTTP/TLS recovery must not retire their possible backend automatically. Direct published host ports still cannot overlap safely and have no zero-downtime guarantee. Recovery does not replay builds, lifecycle hooks, canary observation or additional-node fan-out; inspect per-target status before another rollout. Compose, Swarm, unjournalled historical containers, database/volume restore and arbitrary manual Docker changes are outside this recovery flow. Deleting a service/node cascades its transition record; it is not an orphan-container cleanup operation.


<a id="swarm-preload-placement-safety-unreleased-0180"></a>

<a id="swarm-preload-placement-safety-0180"></a>

<a id="swarm-preload-placement-safety-0181"></a>

## Swarm preload placement safety (0.18.2)

Preparing a new source image must not change a node label referenced by the currently serving Swarm spec: Swarm can evict that task before the new spec is submitted. Preloaded images now use one of three fixed `nd.preload.<slug>.g0/g1/g2` slots, with the full image content address as the value. The manager reads every service's current and previous placement constraints and chooses an unreferenced slot. This also protects a different service referencing the same key. The legacy unsuffixed label is left unchanged, preserving upgrades and native rollback. Three slots plus an existing legacy key keep this metadata bounded per service/node.

An unavailable manager, incomplete metadata or three referenced slots fails preparation before a preload label is changed. The operator must restore a complete manager inventory or review the extra references; the deploy does not guess. Nodes that cannot receive the new image are still excluded from the new placement. Registry-based deployment retains its digest-based path. This change protects the preparation window; native rolling-update availability still depends on the image/command healthcheck, and it does not add HTTP/TCP readiness, artifact promotion or durable interrupted-update recovery to Swarm.


<a id="swarm-recorded-artifacts-and-interrupted-updates-unreleased-0180"></a>

<a id="swarm-recorded-artifacts-and-interrupted-updates-0180"></a>

<a id="swarm-recorded-artifacts-and-interrupted-updates-0181"></a>

### Swarm recorded artifacts and interrupted updates (0.18.2)

Managed Swarm applications submit version-fenced Docker Engine service specs through the configured Docker context. A source build saves its immutable artifact before native submission. Artifact promotion and rollback use that image and the target environment, replica count, port and healthcheck; no Git checkout, build or host lifecycle hooks run. Required managed members must receive the image before an artifact update is submitted. Full task/container image IDs are checked through the manager and sealed node agents after convergence and readiness. Image releases resolve mutable tags to a matching repository manifest digest; an unconfirmed pin never falls back to a tag.

Preloading uses three fixed full-image placement slots, protecting references in every current/previous native spec. It does not rewrite an outgoing slot while that slot is referenced; unreadable inventory or exhausted slots refuse preparation without changing serving placement. Managed native specs carry literal environment values in the Engine body and encrypted recovery journal; this flow creates no plaintext stack/env files. Docker daemon access still exposes the native service environment. Registry credentials are selected from the bound source and kept out of argv and public recovery responses.

A durable encrypted journal records the exact candidate and previous spec before native mutation. First creation reserves a zero-replica service, then starts it with a known service ID/version. After a panel crash, recovery waits for the renewable 90-second lease, fences stale native writes with a service-level epoch, verifies task images and health, confirms loaded routing and completes the original job. It does not replay a build or lifecycle hooks. Stop/cancellation, changed ownership and unconfirmed state prevent false success. Native health failures can restore a known previous spec; unknown spec/identity/manager/routing remains pending. Active Swarm container-port changes are refused before native update.

Settings → Swarm runtime recovery shows the pending reason and an operator retry. Viewer GET and operator POST `/v1/services/:id/swarm/recovery` return a redacted entry; retry bypasses the retry time, never a live lease. SDK methods are `services.swarmRecovery(id)` and `services.retrySwarmRecovery(id)`. Migration 0099 preserves the unresolved record until confirmed settlement or service deletion; retention protects its needed deployment history and logs.

This checkpoint covers new/native Swarm services and existing owned Swarm updates. Cross-orchestrator migration/upgrade compatibility and historical unjournalled-runtime adoption are not accepted by it and remain separate release work. Swarm readiness uses native image/command healthchecks and the existing proxy probe; explicit HTTP/TCP readiness, node/Swarm canary and autoscaling are separate capabilities. No general availability guarantee is implied.

<a id="docker-and-swarm-migration-unreleased-0180"></a>

<a id="docker-and-swarm-migration-0180"></a>

<a id="docker-and-swarm-migration-0181"></a>

### Docker and Swarm migration (0.18.2)

Changing a panel-host Docker service's placement between containers and Swarm keeps its previous runtime until the candidate passes readiness and the loaded HTTP/TLS routing is confirmed. Swarm placement still requires an enabled manager and a supported configuration. Configure command or image healthchecks before moving to Swarm; explicit HTTP/TCP readiness and published host ports remain refused there. This moves the application runtime, not database data or volumes between hosts; application/schema compatibility and concurrent access to shared data still need operator review.

Docker → Swarm captures the immutable IDs of the previous serving containers and stopped spare capacity inside the encrypted Swarm journal before native submission. Service/deployment labels from 0.17 are supported without requiring the new managed label; unlabelled or conflicting ownership is refused. After a confirmed cutover, only those known Docker IDs can be stopped and removed. Cancellation or a failed native update can retain/restore the freshly checked previous Docker generation. Explicit Stop remains stopped.

Swarm → Docker records an encrypted manager/service identity, image provenance and native-spec fingerprint in the primary journal. It does not copy native environment values into plaintext recovery metadata. After candidate readiness, loaded routing and the request drain, the previous native service is updated to zero replicas using its observed Engine version. Recovery persists the expected retirement fingerprint before that update and waits for its tasks to stop. The zero-replica service remains as an archive because Docker service deletion has no revision fence. A later return to Swarm can reuse this owned archive. Changed manager/service/spec ownership or an unconfirmed update remains pending instead of overwriting another native revision. Instance key rotation also rotates the encrypted provenance.

Both directions use the existing lease-safe recovery controls and original deployment ID after a panel restart; builds and host hooks are not replayed. A crash before a candidate is durably selected may settle on the healthy previous runtime and fail that interrupted deployment. A selected candidate is rechecked before completion and retirement. This package has separate real-runtime, published-0.17.1 upgrade, same-service roundtrip, hard-crash and fresh full-matrix acceptance records; see [Competitive delivery](COMPETITIVE_DELIVERY.md). It is not published and does not mark 0.18.2 ready.


## Primary canary traffic binding and rollback retirement

The primary worker now shares its traffic binding with the internal node-canary acceptance path. Local canary routing and rollback use the primary recovery lease to record the acknowledged generation before obsolete-candidate retirement. Internal node observations require sealed `proxy.traffic` and `proxy.routingAck`, the journal's captured serving container IDs and ports, the selected node's rendered configuration, and live deployment/step checkpoints. Missing identities, changed ownership, unavailable receipts or failed acknowledgement refuse the observation; panel traffic is never substituted. Public node canary rollout remains disabled. Capability preflight before candidate creation, multi-replica/request-rate capacity, concurrent refresh behavior and real public-API/worker Stop/cancellation/restart flows remain acceptance gates.


## Batched node candidate readiness

Updated agents advertise `docker.readiness`. A primary transition can verify up to ten captured serving container identities in a batch; all replicas must pass three consecutive samples, including fresh Docker health/restart checks after application probes. Already-qualified replicas continue to be checked while others start. Each node batch has a bounded deadline and at most two active groups; started probes and cleanup attempts settle before capacity is released. Older agents retain the existing per-container path. Once a batch-capable transition starts, unavailable or changed receipts fail within the original service deadline instead of downgrading the protocol. HTTP/TCP application readiness still requires explicit configuration; images without Docker HEALTHCHECK remain valid, while command readiness requires a real passing Docker healthcheck.

Run `pnpm smoke:container-readiness --image=<built-image>` against a candidate to exercise the actual agent operation on real containers with and without image healthchecks. The published-image release workflow includes this gate. This does not add node replica creation, autoscaling or public node canary support.
