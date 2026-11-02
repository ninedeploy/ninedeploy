# Node scale to zero and wake (R2)

Status, 2026-11-02: design accepted; step 1 (agent idle watch) implemented, its hosted cases pending. Scale to zero (`sleepAfterMinutes`) runs on the panel host only. `lib/sleep.ts` refuses node services with "scale to zero runs on the panel host only for now", and [DEPLOYMENTS.md](DEPLOYMENTS.md) documents that limit. This document records why the panel-host mechanism cannot be reused on a node, the decisions that replace it, and the ordered steps with their acceptance.

## Why the panel-host mechanism does not carry over

- **Idle evidence.** The panel host counts requests from its own Traefik access log (traffic analytics). A node's access log never reaches the panel. The node serving-traffic windows used by RPS autoscaling ([NODE_RPS_AUTOSCALING.md](NODE_RPS_AUTOSCALING.md)) are bounded reservations of at most 60 s with gaps between them. A zero there proves only that window was idle, not the minutes before it. Sleeping on that would stop a service that is in use.
- **Wake path.** A sleeping panel-host domain routes to the panel's own wake endpoint (`/_nd/wake`, `modules/wake.ts`) over the local Docker network. On a node, the panel calls the agent and the agent never calls the panel. A node proxy cannot assume a route to the panel, and the panel's Traefik does not know node domains.

## Decisions

1. **Continuous idle watch (new sealed agent operations).** `proxy.idleWatch.open/sample/finish/close` is a separately advertised capability under the existing owner opt-in `NINEDEPLOY_AGENT_PROXY_TRAFFIC=on`. It reuses the serving-window engine with `purpose: 'idle'` and windows of 1 minute to 1 hour (`idleWatchOpen`). A window counts requests to the selected serving leaves continuously between its start and end sequence markers. The engine releases a window that is not sampled within 30 s, so the panel samples every 15 s; that is the lease. Because `sleepAfterMinutes` can reach 24 hours, the panel chains windows. It opens the next window before finishing the previous one, so the next start counter is below the previous end counter, and requires the same source, proxy and agent epoch. Overlapping chained receipts therefore leave no unobserved gap. A proxy restart, source change, routing change, lease lapse, agent restart or any refusal ends coverage, and the idle clock starts again. A service sleeps only after a verified zero count over continuous coverage of `sleepAfterMinutes`. Unavailable coverage never counts as idle, the same rule RPS uses.
2. **Node wake catcher.** The agent manages one fixed container per node, `ninedeploy-wake`, on the node's `ninedeploy` network. It runs from the agent's own pinned image with no host mounts and no Docker socket. It answers every request with the "waking up" page: `503` with `Retry-After` and a self-reloading HTML body, and `HEAD` works too. It records demand per opaque wake token taken from the routed path prefix. Tokens map to services on the panel only, so the catcher holds no service data. Demand is kept in memory, bounded and expiring.
3. **Routing.** A sleeping node domain routes to the catcher after the domain's own middlewares, so basic auth and IP allow lists still run before anything wakes, as on the panel host. Routes are written through the panel-rendered node dynamic config and confirmed with `proxy.routingAck` before any container stops.
4. **Wake.** For each node with sleeping services, the panel polls the sealed `wake.demand` operation every 2 s. On demand it acquires the service runtime owner and starts the recorded serving count by immutable ID through the ordered node lifecycle. It then waits for readiness, restores the routes with routing confirmation, and records `service.wake`. The visitor's page reloads into the app. A cross-host redirect is not used, because a non-GET body cannot be replayed anyway.
5. **Sleep effect order.** Sleep follows a strict sequence:
   1. reserve the runtime owner;
   2. switch routes to the catcher;
   3. confirm routing;
   4. stop the serving members by immutable ID with a sleep intent, distinct from Stop;
   5. record `service.sleep`.
   
   A failure at any step before the containers stop restores the routes, and the service stays awake.
6. **Authority.** Explicit Stop, deploy and Restart supersede sleep and wake, as on the panel host. The autoscaler holds while a node service sleeps; nothing sleeps during a deploy, canary or autoscale transition. Fan-out and Swarm services stay refused with their own reasons.

## Ordered implementation

1. Agent: the `proxy.idleWatch` contract and capability, on the bounded log transport and sequence markers. Cover lease lapse, restart, source change and refusal with tests, and add a hosted observation case (continuous zero, a single request breaks the zero, proxy restart resets coverage). *Implemented 2026-11-02:*
   - `lib/nodeIdleWatch.ts` and `agentOps/idleWatch.ts`.
   - Agent tests: `test/agentOps/idleWatch.test.ts` (two-minute verified zero under a 15 s lease, a single request, lease lapse, overlapping chain, owner disable).
   - Hosted cases in `scripts/fixtures/serving-traffic-agent.mjs`: a verified zero over one minute, a chained window broken by one request, and a proxy restart ending coverage.
   - The agent now also closes serving and idle windows when it shuts down.
2. Agent: the `ninedeploy-wake` catcher (an idempotent ensure/remove operation, pinned image, no mounts) and the sealed `wake.demand` operation. Cover token bounds, expiry and missing-catcher refusal.
3. Panel: the node idle clock in the sleep tick, using the idle watch. Report hold reasons (capability, coverage, opt-in) through the existing sleep status. Never sleep on unavailable coverage.
4. Panel: the node sleep effect (decision 5), with its routing render for sleeping node domains pointing at the catcher with the domain middlewares kept.
5. Panel: the wake poller and wake effect (decision 4), with deploy/Stop/Restart supersession and Stop arriving during a wake.
6. Surfaces: lift the node refusal in `sleepHoldReason`, the service API validation and the panel/CLI copy, but only for nodes that confirm both capabilities. Older agents keep the refusal.
7. Hosted smoke (`smoke-node-canary.mjs --sleep-only`) on isolated daemons:
   - an idle service sleeps after the window;
   - a request through the node proxy wakes it, and the reloaded page is served by the app;
   - a basic-auth domain asks for credentials before waking;
   - a request during the idle window prevents sleep;
   - agent opt-in off never sleeps;
   - Stop during a wake leaves the service stopped.

   Run it in CI and on the release image before node sleep is enabled.
