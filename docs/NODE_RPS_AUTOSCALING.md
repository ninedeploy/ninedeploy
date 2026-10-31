# Node request-rate autoscaling implementation plan

Status: implementation pending. Memory autoscaling has real single-node and PostgreSQL acceptance; those results do not accept request-rate autoscaling.

Contract checkpoint: `servingTrafficOpen` and `servingTrafficSnapshot` now model ordinary serving generations separately from canary steps. Validation rejects missing/duplicate/wrong-generation replicas, unsupported fields, invalid source/counter shapes and incomplete coverage declared complete. The complete schema suite passed 780 tests at 100% statement, branch, function and line coverage; schema typecheck and lint passed (lint reported informational suggestions). No agent operation, advertised capability, panel observation or RPS scaling is enabled by this schema increment. Step 1 remains incomplete until the agent capability and observation path are implemented.

## Confirmed boundaries

- `engine/builders/nodeAutoscaleDeployment.ts` refuses RPS capacity preparation.
- `lib/nodeAutoscaleWorker.ts` refuses RPS before measurement and admission.
- `lib/nodeAutoscaleDecision.ts` refuses RPS before its sustained decision window.
- `lib/requestRate.ts` is a panel-local analytics counter. It cannot attest a remote proxy source, loaded routing configuration or immutable serving replicas.
- `lib/nodeProxyTrafficClient.ts` requires an unfinished canary deployment. A selected running deployment is deliberately refused.
- `packages/schemas/src/proxyTraffic.ts` requires nonempty stable and canary sets plus a canary step. It cannot truthfully represent an ordinary serving generation.
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
