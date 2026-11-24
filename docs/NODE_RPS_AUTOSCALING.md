# Node request-rate autoscaling implementation plan

Status: released. Node request-rate autoscaling is implemented end to end and enabled by `NODE_RPS_AUTOSCALING_ACCEPTED` in `lib/autoscaler.ts`; 0.18.17 shipped it after the hosted 1→2→1 and source-loss acceptance in [CI 41464316996](https://github.com/ninedeploy/ninedeploy/actions/runs/41464316996). Memory autoscaling has its own real single-node and PostgreSQL acceptance. [How it works today](#how-it-works-today) describes the current code; the [Acceptance record](#acceptance-record) and the later dated sections record each increment when it was written.

## How it works today

This section describes the current code. Paths are under `apps/server/src/` unless noted.

### Requirements

- A Docker service on a node, not Swarm. On the panel host, `rps` is still counted from traffic analytics, as before.
- The node agent runs with `NINEDEPLOY_AGENT_PROXY_TRAFFIC=on` (any value other than `off`, `false`, `0`, `no` or `disabled`), over sealed transport, and advertises `proxy.servingTraffic`. Without it the observation refuses and the autoscaler holds, with a null value.
- A routed domain on the node. A service without one is refused before a window opens.
- Confirmed replica capacity (`node_autoscale_capacity`) for the current deployment. A deploy on this path creates all `maxReplicas` containers, starts the serving ones and leaves the rest stopped. The deploy pipeline in `engine/pipeline.ts` takes this path only when the service has no canary configuration, no published port and no port mappings, at least one active domain, no fan-out target, at most 8 attached databases all running on the same node, and a sealed agent advertising `docker.mutations`, `docker.prepareAttemptEnv`, `docker.retireHandoff`, `docker.startSet`, `docker.readiness`, `proxy.routingAck`, `proxy.orderedWrite`, `image.manage`, `docker.runSpec`, `docker.recovery` and, for `rps`, `proxy.servingTraffic`. Otherwise the deployment log says it continues on the existing deployment path, and the status reports `node autoscale capacity is not confirmed`.
- `metric: rps` in the service's `autoscale` configuration, with the same bounds as the other metrics: `minReplicas` 1 to 10 (default 1), `maxReplicas` 2 to 10 and above the minimum, `scaleUpSeconds` 30 to 3600 (default 60), `scaleDownSeconds` 60 to 3600 (default 300), and optional `schedules` with `timezone`. For `rps`, `target` is requests per second per replica, above 0.

Switching a deployed service from `cpu` or `memory` to `rps` without a redeploy keeps the prepared capacity. Scaling then also needs the `proxy.servingTraffic` capability at observation time, which is why the worker checks the gate and the agent again on every tick.

### Where requests are counted

The panel does not count node traffic. Each autoscale tick, `lib/nodeServingTrafficSample.ts` opens one 10-second window (`NODE_SERVING_WINDOW_MS`) through `proxy.servingTraffic.open`, naming the serving replicas' immutable container ids, the service port and the node's current routing render. On the node, the agent:

1. inspects `ninedeploy-proxy` (running, with a `json-file` or `local` log driver) and every selected replica (immutable id, name and `ninedeploy.*` labels), and confirms the loaded routing generation over both the HTTP and the TLS handler;
2. sends a start marker into the proxy container and streams its access log;
3. counts only requests between the start and end markers whose router (`<slug>_<n>@file` or `<slug>_<n>_http@file`) and upstream address (`http://<replica>:<port>`) match a selected replica.

A window is complete only when every sequence number between the markers was seen. Requests to other services or to a weighted canary route are not counted, and a service that has a maintenance bypass router is refused before a window opens. Missing logs, a proxy restart, a replaced replica, changed routing or a lost capability refuse the observation; none of them reads as zero.

The value is `requests * 1000 / elapsedMs / replicas`, rounded to 0.1 requests per second per replica. A verified zero is a real zero; an unavailable source stays null.

### Decision

`plugins/autoscaler.ts` runs every 30 seconds (`AUTOSCALE_TICK_MS`; the first tick is 40 seconds after boot) and hands each node Docker service that has an `autoscale` configuration to `createNodeAutoscaleWorker` (`lib/nodeAutoscaleWorker.ts`). The worker reads the serving-traffic sample for `rps`, or container metrics for `cpu` and `memory`, and `lib/nodeAutoscaleDecision.ts` runs the same sustained window as the panel host:

- the needed count is the current count scaled by value / target; within 10 % of the target nothing changes;
- scaling up waits `scaleUpSeconds` and takes the smallest count asked for in that time; scaling down waits `scaleDownSeconds` and takes the largest;
- a scheduled floor raises the minimum while its window is in force; a count outside the bounds moves to the bound at once, without a sustained window;
- the window restarts when the node, runtime id, serving count or autoscale configuration changes, or when the replica set (ids, restarts and limits), proxy source, proxy, agent epoch or routing generation changes. It also restarts when the last observation is more than 90 seconds old (`AUTOSCALE_STATS_MAX_AGE_MS`) or the service is blocked. A repeated sample does not advance it.

The node is skipped while a deploy or a canary is running. The decider only builds decisions; every effect goes through durable admission and the controller.

### Admission, effects and recovery

`admitNodeAutoscale` (`lib/nodeAutoscaleAuthority.ts`) re-reads the service row and refuses unless the measurement is at most 90 seconds old and still bound to the node, service, deployment and exact serving ids. It also refuses during a queued, building or deploying deployment, a pending node lifecycle command, a panel-host or fan-out transition, an unfinished scale, a pending sleep or wake, or an active canary. It then reserves the service runtime owner with kind `scale` and records `node_autoscale_transitions` with a 90-second worker lease (`NODE_AUTOSCALE_LEASE_MS`).

The controller (`lib/nodeAutoscaleController.ts`) freezes the replica inventory, then runs ordered phases and re-checks ownership, placement, serving count and capacity around every effect:

- scale up: `accepted`, `fencing`, `prepared`, `started` (start the spares with `docker.startSet`), `ready` (three consecutive readiness samples), `routing` (the node acknowledges the ordered proxy write), `handoff`, `completed`;
- scale down: `accepted`, `fencing`, `prepared`, `routing` (route the replicas away first), `draining` (2 seconds), `stopping` (`docker.stopSet`, 10-second grace), `handoff`, `completed`.

A queued deploy, or a sample that grew stale before anything was published, aborts the decision through the `abort_*` phases, releasing the node fences first. Every tick also calls `reconcileNodeAutoscale` (`lib/nodeAutoscaleRecovery.ts`), which resumes up to 4 transitions whose lease expired. An interrupted scale is therefore finished or unwound after a panel restart, also when autoscaling was turned off in the meantime. A completed transition row is deleted.

Unlike the panel host, a node scale writes no `service.autoscale` audit event, and `lastEvent` is always null for a node service. The change is visible in `replicas` and in the service's routing.

### Receipts

Every finished window is consumed once, before it is returned. `consumeNodeServingTraffic` (`lib/nodeServingTrafficReceipt.ts`) writes `node_serving_traffic_receipts` (migration `0119`) and refuses a request or window id that was already used, and any counter interval at or below the source's retained high watermark. Counters are stored as fixed-width decimal text and compared as integers. The housekeeping step `serving-traffic-receipts` deletes a receipt 7 days after consumption unless it is the newest for its service, node and source.

The agent keeps at most 16 observation windows at a time (`PROXY_TRAFFIC_MAX_SESSIONS`), releases a window that is not sampled within 30 seconds, and closes all windows when it shuts down.

### Surfaces

| Surface | Control |
| :--- | :--- |
| API | `PATCH /v1/services/:id` with `autoscale` (`null` turns it off); `GET /v1/services/:id/autoscale`; `GET /v1/services/:id/capabilities` (`autoscale`) |
| SDK | `client.services.update(id, { autoscale })`; `client.services.autoscale(id)` |
| CLI | `ninedeploy autoscale show <service> [--json]`; `autoscale set <service> --metric rps --target <n>` with `--min`, `--max`, `--up-seconds` and `--down-seconds`; `autoscale off <service>` |
| Panel | Service, Settings, **Autoscaling** card: **Metric** (`Requests per second (rps)`), **Target**, **Scheduled minimums**, **Advanced** with the scale-up and scale-down windows. The **Autoscaling** panel on the Overview tab is polled every 15 seconds. |

`GET /v1/services/:id/autoscale` returns `enabled`, `replicas`, `supportedMetrics`, `minReplicas`, `maxReplicas`, `metric`, `target`, `value`, `desired`, `holding`, `lastEvent` and `scheduledFloor`. For a node service:

- `supportedMetrics` lists `cpu`, `memory` and `rps` while `NODE_RPS_AUTOSCALING_ACCEPTED` is true. With the gate false it lists `cpu` and `memory`, and a service stored with `rps` reports `node request-rate autoscaling is not available yet` with a null `value` and `desired`. Swarm lists none.
- `value` and `desired` come from the last recorded node sample and return to null 90 seconds after it, with `waiting for fresh node metrics`.
- `holding` names the reason, for example `a deploy or canary is in progress`, `node autoscale capacity is not confirmed`, `waiting for a complete node serving-traffic window`, `node autoscale database networks changed; redeploy to prepare capacity`, `node autoscale transition awaits recovery` or `node autoscale evaluation failed; see server logs`.
- `lastEvent` is always null.

The panel's **Metric** select marks a metric the placement does not support as "not available here" and disables it, unless it is the stored one. The CLI lists the acting metrics as "Metrics here" and warns when `autoscale set` stores a metric that does not act.

## Acceptance record

The dated paragraphs in this section and in [Confirmed boundaries](#confirmed-boundaries) keep the state of each increment when it was written.

Schema contract: `servingTrafficOpen` and `servingTrafficSnapshot` model ordinary serving generations separately from canary steps. Validation rejects missing/duplicate/wrong-generation replicas, unsupported fields, invalid source/counter shapes and incomplete coverage declared complete. All 802 schema tests in 40 files passed locally.

Agent observation acceptance — 2026-11-01: development source `7716cf93099e8c374ed1c1e175ce6c012b19f77e` implements separately sealed `proxy.servingTraffic.open/sample/finish/close` operations. It reuses the bounded reservation/log engine with a serving-only counter, without synthetic canary targets or altered canary operands/receipts. The node owner must opt in through `NINEDEPLOY_AGENT_PROXY_TRAFFIC`; the capability's planned release floor is 0.19.0. Serving elapsed time follows the observed sequence markers, excluding verification after the end marker. The delayed-verification regression failed before that timing adjustment.

[Hosted Docker/Traefik run 41323263997](https://github.com/ninedeploy/ninedeploy/actions/runs/41323263997) passed all nine observation controls through the actual sealed HTTP agent. Independent inspection recomputed request/target/routing hash bindings from immutable fixture identities: 20 serving requests counted, five unrelated requests excluded, all 25 HTTP responses successful, both replicas served, and a separately completed zero-traffic window was verified. Loaded but unrouted configuration, proxy restart, changed routing, stopped replica, plaintext and owner-disable controls refused observation. No active windows remained and all five owned resources were removed. The first fixture looked for the panel's default proxy during a node recheck; the corrected helper uses the observed node proxy ID for both HTTP and HTTPS. Its regression failed before the fix while the panel-default control passed. Evidence: `.temp_files/rps-serving/hosted-green-41323263997/independent-verification.json`.

[Full CI 41323263845](https://github.com/ninedeploy/ninedeploy/actions/runs/41323263845) passed 17,854 tests in 1,130 files, real Docker/PostgreSQL integration and the complete Docker/runtime job on the same source head. The local eight-file routing/deployment admission suite passed 112 tests; the routing-helper/smoke/matrix suite passed 13 tests. Five deployment/routing boundary regressions failed before the additional admission checks. Server typecheck, targeted lint and actionlint passed. The hosted-only observation smoke is mandatory in normal CI and future versioned images. This is source/agent observation evidence, not a numbered release, production cutover or RPS scaling acceptance.

The same final-head CI's normal-deploy artifact independently retained 1,892 HTTP 200 responses across HTTP, strict HTTP, TCP, running and command readiness, with previous and replacement responses in every trace and confirmed owned cleanup. Evidence: `.temp_files/rps-serving/ci-panel-health-41323263845/independent-verification.json`. This is isolated Host-header HTTP acceptance, not production DNS/TLS certification.

The agent portions of steps 1–2 below are implemented and observed. Step 3 has a private panel adapter and real SQLite-backed boundary tests; its transport boundary is mocked in those tests. Steps 4–6 now include durable one-use observation consumption, per-serving-replica RPS calculation, decision/controller integration, capability-gated capacity preparation and support reporting. `NODE_RPS_AUTOSCALING_ACCEPTED` in `lib/autoscaler.ts` is true after the hosted 1→2→1 and source-loss acceptance in [CI 41464316996](https://github.com/ninedeploy/ninedeploy/actions/runs/41464316996). That run completed successfully on `31c598ec4901963b963a1a5558580e02b1c15a1b`; subsequent development still needs its own final-source certification. This acceptance does not enable node sleep/wake or complete the wider R2 matrix.

Panel adapter implementation — 2026-11-01: `openNodeServingTraffic` accepts the selected running deployment, with matching immutable capacity, serving count and port. Before and after awaited operations it checks runtime ownership, service configuration, database bridges, queued/building/deploying work, lifecycle intents, preparation and transition journals, and the current node routing render. It refuses fanout because a node-local counter cannot measure traffic served elsewhere. Sealed capability preflight is followed by another context check before reservation. Snapshot binding retains request, target, source, proxy, routing, epoch and sequence identities; unavailable or regressing coverage is never substituted with zero.

Cancellation closes known windows even while idle; cleanup uses its own bounded call without the cancelled signal. A total observation deadline supplements the agent's existing expiry. Overlapping calls are refused, returned snapshots cannot mutate internal continuity checks, and a successful final receipt closes the client. Invalid unbound opening receipts are never used to close a foreign window; unknown reservations remain subject to agent expiry.

Local panel-adapter validation: 190 tests passed across eight files, including 52 new adapter cases against migrated in-memory SQLite. The suite covers real routing rendering and runtime-owner changes, sealed capability refusal, database placement changes, deployment/Stop conflicts, idle/in-flight cancellation, overlap, foreign receipts, unavailable sources and mutable receipt isolation. Server typecheck and targeted lint passed. Local Docker was not accessed (`DOCKER_HOST=tcp://127.0.0.1:9`). These focused checks do not certify a new release or hosted RPS scaling.

Durable consumption implementation — 2026-11-01: migration `0119_node_serving_traffic_receipts` retains consumed request/window identities per deployment. Finishing a panel observation now persists its bound completed receipt before returning it. A transaction rechecks runtime ownership/capacity and rejects duplicate request/window IDs and counter intervals at or below the source's retained high watermark. Source watermarks apply across agent epochs; a new proxy source may start a new sequence without forgetting the previous source. Canonical uint64 counters are stored as fixed-width decimal text and ordered through a covering source index, without floating-point conversion. The housekeeping step `serving-traffic-receipts` deletes a receipt 7 days after consumption unless it is the newest for its service, node and source; that row holds the high watermark, so an older interval stays refused after its own row is gone. Every row also cascades with its deployment or service.

Consumption checks the panel-captured observation interval and sample freshness before validation, before writing and before returning. Routing is checked before and after the transaction; an intervening change may spend a receipt but cannot return decision evidence. The per-replica rate is `serving.requests * 1000 / elapsedMs / serving.length`; a fully verified zero remains distinguishable from unavailable coverage. The next controller step must bind these records into durable autoscale admission and reset sustained decision windows when source, owner, route, configuration or replicas change. Persisting an observation does not itself authorize a scale mutation.

Validation of this increment: 219 focused tests passed in nine server files and all 76 database tests passed in 30 files. A new adapter replay regression failed on the previous panel adapter because its second instance accepted the same completed window. The fixed path rejects it. A separate-process SQLite fixture verifies persistence across actual process restarts and that two independent clients accept only one competing consumption; its temporary files are removed after the processes exit. Migration tests upgrade an existing deployment, retain data, verify uniqueness/cascade behavior and prove the covering-index query plan. Typecheck, targeted lint and a no-schema-drift generation check passed. Full hosted acceptance of this new increment is still required.

The preceding panel-adapter head `2fcfcbbf390bca48f56cbab2a38f7cf92e43b166` separately passed [hosted observation run 41334052103](https://github.com/ninedeploy/ninedeploy/actions/runs/41334052103): nine real sealed-agent/Docker/Traefik cases, both immutable replicas, verified zero, 25 HTTP 200 responses, no remaining windows and five owned resources removed. Hash bindings were independently recomputed. This exercises the agent observation path, not the new consumption ledger or RPS scaling.

The same preceding head's [full CI 41334052085](https://github.com/ninedeploy/ninedeploy/actions/runs/41334052085) finished with Docker/runtime and Docker/PostgreSQL integration passing, but source tests failed solely because `nodeServingTrafficContext.ts` was missing from the static Swarm runtime-reader inventory: 17,907 tests passed and one failed. The module already rejects Swarm before agent contact. Adding its documented classification reproduced red/green locally; all 65 Swarm/adapter tests passed on corrected panel head `88753950`. Full CI was restarted; the failed run is not full certification. Its independently checked normal-deploy trace contains 1,916 HTTP 200 responses across all five readiness modes, with previous and replacement responses in every mode and owned cleanup confirmed. Evidence: `.temp_files/rps-serving/ci-panel-health-41334052085/independent-verification.json`.

## Confirmed boundaries

- Ordinary serving observations require matching deployment labels and a managed HTTP load-balancer route containing exactly the selected replica URLs. Missing routes, another generation, incomplete leaf sets and weighted canary routes refuse observation rather than returning zero. Maintenance bypass routing is held; the HTTP twin is counted when it actually reaches a selected leaf. Five new Docker-boundary assertions failed before these admission checks; the covering eight-file suite passed 112 tests after the change. The nine-case hosted follow-up includes a loaded but unrouted configuration control.

- `engine/builders/nodeAutoscaleDeployment.ts` prepares RPS capacity only after a sealed `proxy.servingTraffic` capability check (step 5, 2026-11-02). Older agents are refused with a `measure node request rate` reason before any effect. The deploy pipeline also requires the capability before it selects the capacity path for an RPS service, and keeps RPS services on the existing deployment path while `NODE_RPS_AUTOSCALING_ACCEPTED` is false.
- Hosted acceptance (2026-11-02): CI and the release workflow run `scripts/smoke-node-canary.mjs --autoscale-rps-only` with default panel settings: public API and sealed agent on isolated daemons, with 1→2 under load and 2→1 on measured low traffic. A source-loss control restarts the agent with `NINEDEPLOY_AGENT_PROXY_TRAFFIC=off`, then holds for 90 s with a null value and no scale-down despite low traffic. Every routed request must return 200.  Its first hosted run (41457498775) timed out on scale-up with 14,628 requests, all HTTP 200. The decision generation included `targetHash`, which hashes the whole request including its unique `requestId`. Every window therefore restarted the sustained window. The generation now leaves it out; serving identities and `routingGeneration` still bind each window. A decider regression that varies `targetHash` per window failed before the fix. After that fix, [CI 41464316996](https://github.com/ninedeploy/ninedeploy/actions/runs/41464316996) passed: 1→2 at 23.5 rps per replica, the source loss held 2 replicas for 90 s with no value, then 2→1 at 0.6 rps. All 6,232 requests returned 200, and both immutable replicas served. `NODE_RPS_AUTOSCALING_ACCEPTED` is now true; a temporary panel preview variable used for this run was removed. Setting the constant false withdraws node RPS from the pipeline, the worker and every reported surface.
- Step 6 (2026-11-02): `GET /v1/services/:id/autoscale` returns `supportedMetrics` from `autoscaleSupportedMetrics` in `lib/autoscaler.ts`, which also holds the gate. With acceptance withdrawn, a node service with `rps` reports `node request-rate autoscaling is not available yet` with a null value and desired count, never a pending evaluation or zero. With the accepted gate on, RPS is included in node-supported metrics. The panel card disables an unsupported metric unless it is the stored one. The CLI lists "Metrics here" and warns when `autoscale set` stores a metric that does not act. Flipping the gate updates every surface.
- `lib/nodeAutoscaleWorker.ts` holds RPS while `NODE_RPS_AUTOSCALING_ACCEPTED` is false. The capacity-preparation check alone is not enough: capacity prepared under cpu or memory stays valid when the metric is switched to rps without a redeploy. Turn the gate on after step 6 and the hosted smoke.
- `lib/requestRate.ts` is a panel-local analytics counter. It cannot attest a remote proxy source, loaded routing configuration or immutable serving replicas.
- `lib/nodeProxyTrafficClient.ts` requires an unfinished canary deployment. A selected running deployment is deliberately refused.
- The existing `proxyTrafficOpen` contract still requires stable/canary sets and a canary step. Ordinary observations use the separate `servingTrafficOpen` contract and capability.
- `lib/nodeProxyTrafficDocker.ts` already verifies immutable container identities, proxy restart identity and loaded HTTP/HTTPS routing. Preserve these checks in the new observation path.

## Ordered implementation

1. Add a separate, capability-advertised serving-traffic observation contract. Bind node, service, selected deployment, immutable serving targets, loaded routing generation and a unique observation request. Keep existing canary requests and receipts compatible. Do not invent a candidate or reuse a canary step for ordinary traffic.
2. Reuse bounded proxy log transport and request-sequence markers. Count only requests attributed to the selected serving leaves. Return completed coverage, elapsed duration, source/proxy identity and target/routing hashes. Missing logs, attribution, sequence boundaries, capability or owner opt-in must hold scaling; they must never become zero RPS.
3. Add the panel adapter with before/after placement and runtime-owner checkpoints. Accept selected running deployments, reject queued deploy/lifecycle conflicts, changed targets, routing, database topology and source restarts. Close windows on cancellation and failure; preserve the agent's bounded expiry backstop.
4. Feed completed fresh windows into the existing durable autoscale admission/controller. Compute requests per second per serving replica. Reset sustained scale windows across source, route, owner, target, config and serving-count changes. Reject repeated receipts, incomplete coverage and stale or future samples.
5. Permit RPS capacity preparation only after the required serving-traffic capability is confirmed. Retain old-agent refusals, immutable spare preparation, readiness, route confirmation, drain ordering and database attachment fencing.
6. Expose precise held reasons and accurate supported metrics through the existing API/panel/SDK/CLI surfaces. Do not report unsupported RPS as a live zero measurement.

## Required evidence

- Contract and agent tests: running-generation observations, unrelated service traffic exclusion, missing markers, log loss/rotation, malformed attribution, proxy restart, replaced replica and stale routing refusal.
- Panel and decision tests: sustained up/down windows, duplicated receipts, owner/deploy/Stop races, cancellation cleanup, no traffic versus unavailable source, capability-disabled and older-agent controls.
- Public API smoke on an isolated GitHub runner: create RPS-configured capacity, generate controlled proxy load, observe one-to-two scale-up, reduce load, observe two-to-one scale-down, prove both immutable replicas served, and retain continuous HTTP outcomes and cleanup evidence. Include a source-loss control that holds scaling.
- Repeat with PostgreSQL readiness, then add the accepted scenarios to candidate-image release gates. Run the final uncached release matrix on the final code revision. No local Docker access is required for this plan.

## Decision integration — 2026-11-02

`lib/nodeServingTrafficSample.ts` opens one 10-second window per autoscale tick on the serving replicas named by the deployment's capacity receipt (`node_autoscale_capacity`), at the service port, against the node's current routing render, then finishes and consumes it. A refusal at any point throws and holds the tick; it never becomes a zero reading. A service without a routed domain is refused before a window opens. The window is always closed.

`lib/nodeAutoscaleWorker.ts` reads that sample for `metric: rps` and the container-metrics sample for cpu and memory. `measureNodeServingTraffic` accepts only a complete, fresh receipt bound to the node, service, selected deployment and exact serving names, and computes `requests * 1000 / elapsedMs / replicas`. `lib/nodeAutoscaleDecision.ts` runs it through the same sustained window as cpu and memory. The window restarts when the service configuration, serving count, replica set, proxy source, proxy, agent epoch or routing generation changes. `targetHash` is deliberately left out: it hashes the whole observation request, including its unique `requestId`, so it differs on every window (see the hosted-acceptance bullet above). A repeated receipt does not advance it. The receipt's request ID and serving identities become the admission evidence, so `admitNodeAutoscale` and the controller are unchanged.

Tests: `test/lib/nodeAutoscaleDecision.test.ts` (sustained up, verified zero scaling down, window reset per identity, repeated, incomplete, foreign and stale receipts), `test/lib/nodeServingTrafficSample.test.ts` (window inputs, close on refusal, Swarm/placement/capacity/route refusals) and `test/lib/nodeAutoscaleController.test.ts` (an RPS decision completes through durable admission and the controller; a refused window holds with no transition).
