# Node request-rate autoscaling implementation plan

Status: agent observation accepted; panel/controller integration pending. Memory autoscaling has real single-node and PostgreSQL acceptance; those results do not accept request-rate autoscaling.

Schema contract: `servingTrafficOpen` and `servingTrafficSnapshot` model ordinary serving generations separately from canary steps. Validation rejects missing/duplicate/wrong-generation replicas, unsupported fields, invalid source/counter shapes and incomplete coverage declared complete. All 802 schema tests in 40 files passed locally.

Agent observation acceptance — 2026-11-01: development source `7716cf93099e8c374ed1c1e175ce6c012b19f77e` implements separately sealed `proxy.servingTraffic.open/sample/finish/close` operations. It reuses the bounded reservation/log engine with a serving-only counter, without synthetic canary targets or altered canary operands/receipts. The node owner must opt in through `NINEDEPLOY_AGENT_PROXY_TRAFFIC`; the capability's planned release floor is 0.19.0. Serving elapsed time follows the observed sequence markers, excluding verification after the end marker. The delayed-verification regression failed before that timing adjustment.

[Hosted Docker/Traefik run 41323263997](https://github.com/ninedeploy/ninedeploy/actions/runs/41323263997) passed all nine observation controls through the actual sealed HTTP agent. Independent inspection recomputed request/target/routing hash bindings from immutable fixture identities: 20 serving requests counted, five unrelated requests excluded, all 25 HTTP responses successful, both replicas served, and a separately completed zero-traffic window was verified. Loaded but unrouted configuration, proxy restart, changed routing, stopped replica, plaintext and owner-disable controls refused observation. No active windows remained and all five owned resources were removed. The first fixture looked for the panel's default proxy during a node recheck; the corrected helper uses the observed node proxy ID for both HTTP and HTTPS. Its regression failed before the fix while the panel-default control passed. Evidence: `.temp_files/rps-serving/hosted-green-41323263997/independent-verification.json`.

[Full CI 41323263845](https://github.com/ninedeploy/ninedeploy/actions/runs/41323263845) passed 17,854 tests in 1,130 files, real Docker/PostgreSQL integration and the complete Docker/runtime job on the same source head. The local eight-file routing/deployment admission suite passed 112 tests; the routing-helper/smoke/matrix suite passed 13 tests. Five deployment/routing boundary regressions failed before the additional admission checks. Server typecheck, targeted lint and actionlint passed. The hosted-only observation smoke is mandatory in normal CI and future versioned images. This is source/agent observation evidence, not a numbered release, production cutover or RPS scaling acceptance.

The same final-head CI's normal-deploy artifact independently retained 1,892 HTTP 200 responses across HTTP, strict HTTP, TCP, running and command readiness, with previous and replacement responses in every trace and confirmed owned cleanup. Evidence: `.temp_files/rps-serving/ci-panel-health-41323263845/independent-verification.json`. This is isolated Host-header HTTP acceptance, not production DNS/TLS certification.

The agent portions of steps 1–2 below are implemented and observed. Panel/controller work in steps 3–6 remains open; RPS preparation, measurement admission and scaling decisions remain disabled.

## Confirmed boundaries

- Ordinary serving observations require matching deployment labels and a managed HTTP load-balancer route containing exactly the selected replica URLs. Missing routes, another generation, incomplete leaf sets and weighted canary routes refuse observation rather than returning zero. Maintenance bypass routing is held; the HTTP twin is counted when it actually reaches a selected leaf. Five new Docker-boundary assertions failed before these admission checks; the covering eight-file suite passed 112 tests after the change. The nine-case hosted follow-up includes a loaded but unrouted configuration control.

- `engine/builders/nodeAutoscaleDeployment.ts` refuses RPS capacity preparation.
- `lib/nodeAutoscaleWorker.ts` refuses RPS before measurement and admission.
- `lib/nodeAutoscaleDecision.ts` refuses RPS before its sustained decision window.
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
