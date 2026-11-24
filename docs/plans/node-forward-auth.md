# Panel sign-in for services on nodes (N11): design record

Status: design record of November 24, 2026. Nothing in it is implemented. It records what the code does today, compares the two ways the roadmap names for checking panel sign-in on a node, recommends one, and states the behaviour its acceptance has to prove with two daemons and a real proxy. The owner decides; the decisions are in section 11.

## 1. The limit

Panel sign-in (forward auth, G2.3) puts an app behind the panel's sign-in, per domain. It works for a service on the panel host. For a service on a node, or with a fan-out target, it is refused, in four places that hold on their own:

- `forwardAuth` is `unavailable` on a node: `forward_auth_unsupported` (`apps/server/src/lib/serviceCapabilities.ts:45-49,84-87`).
- A node's proxy never routes a protected domain, whatever wrote the row: `if (forNode && forwardAuthIds.has(d.id)) continue` (`apps/server/src/engine/proxy.ts:1256`).
- A protected service cannot move to a node or gain a fan-out target: `move_panel_host_only` (`apps/server/src/lib/maintenance.ts:86-106`).
- A bundle import skips sign-in for a node service (`apps/server/src/lib/portableSettings.ts:203-207`), and node pages leave sign-in domains out (`apps/server/src/lib/nodePagesSync.ts:57-63`).

The reason is one sentence in the code: such a service "would be routed by their proxies, which cannot ask the panel" (`apps/server/src/modules/forwardAuth.ts:68`). The roadmap leaves the choice open, "a node-side verifier of signed sessions … or a route to the panel through the agent" (`docs/plans/COMPETITIVE_ROADMAP_2026-11.md:146`).

## 2. What exists today

Paths and line numbers are as of `9df2e517`.

**The check.** Traefik's `forwardAuth` middleware asks `/_nd/fa/verify/<domainId>` about every request, and it is the first middleware on the router (`apps/server/src/engine/proxy.ts:1277-1284`). The panel answers from its database. The session cookie `nd_fa_<id>` is an HMAC value keyed from `jwt.secret`; it lives 12 hours and holds the user id, the domain id and the user's token version (`apps/server/src/lib/forwardAuth.ts:34,86-119`). Unless a 30-second cache answers first, the panel loads the user and the service and admits only a user who is active, whose token version is unchanged and whose role on the service is at least `minRole` (`apps/server/src/modules/forwardAuth.ts:157-173`). A browser without a session is sent to the panel's `/forward-auth` page with a `state` cookie; anything else gets 401 (`:176-184`).

**Sign-in.** Signed in on the panel, the page calls `POST /v1/forward-auth/grant` and receives a one-time code. The panel keeps its codes in memory for 60 seconds, each bound to the user, the domain, the return URL and the state (`apps/server/src/lib/forwardAuth.ts:139-162`; `apps/server/src/modules/forwardAuth.ts:86-112`). The browser opens `/_nd/fa/callback?code=…` on the app's own domain. The panel spends the code there, only together with the matching `state` cookie, sets the session cookie and sends the visitor back.

**Panel and node.** The panel calls the agent at `/agent/exec`; the agent calls the panel only to announce itself, every 60 seconds, and only when `NINEDEPLOY_MASTER_URL` is set (`apps/server/src/agent.ts:1440-1469,1530-1549`). The rule is written down: "A node proxy cannot assume a route to the panel" (`docs/NODE_SLEEP_WAKE.md:44`). The proxy container on a node gets no panel address; its `host.docker.internal` is the node's own host (`apps/server/src/agent.ts:543-556`). Operations travel sealed, AES-256-GCM under a key derived from the node token, inside a five-minute clock window (`apps/server/src/lib/agentSeal.ts:33-34`, `MAX_SKEW_MS`). The panel reads a node as offline five minutes after it last heard from it (`apps/server/src/modules/servers.ts:76`), and its health watcher pings every node itself (`apps/server/src/lib/nodeHealth.ts:187-194`).

**Older agents.** The panel asks an agent for nothing but `agent.ping`, and learns what it can do from the sealed answer. A capability the agent does not advertise is a refusal, never a send: `422 node_agent_outdated` for an older agent, `403 node_feature_disabled` for one whose owner switched the feature off (`apps/server/src/lib/agentCapabilities.ts:514-540`).

**Node-local precedents.** Two services on a node already answer its proxy without the panel. The page server `ninedeploy-pages` serves maintenance and error pages from files written by the sealed operations `proxy.pages.write`, `proxy.pages.prune` and `proxy.pages.ensure` (`apps/server/src/agentOps/nodePages.ts`). The wake catcher accepts a request only with the node's wake key, a per-node secret that arrives in a sealed operation (`apps/server/src/lib/nodeWakeKey.ts`, `apps/server/src/wakeCatcher.ts`).

**Keys.** Every value the panel signs today is an HMAC keyed from `jwt.secret`. The agent strips `NINEDEPLOY_JWT_SECRET` and `NINEDEPLOY_MASTER_URL` from the environment of every container it starts (`apps/server/src/lib/spawnValidated.ts:27-46`), and it never verifies a JWT. ed25519 is used once, to verify the marketplace index with `node:crypto` (`apps/server/src/lib/marketplaceCatalog.ts:30`); `jose` signs the panel's own sessions (`apps/server/src/lib/jwt.ts`).

## 3. Two ways to check a request on a node

### A. The node asks the panel (agent-mediated verification)

The node's proxy sends its auth requests to a small relay on the node. The relay passes the visitor's cookie and the forwarded headers to the panel's public `/_nd/fa/verify/<domainId>` over HTTPS and returns the answer. The panel's check stays as it is.

- Every uncached request waits for one round trip between the node and the panel. A cache on the relay spares repeat visitors that wait, and adds the same staleness.
- Revocation is the panel's: it holds as soon as the panel knows, after the panel's 30-second cache.
- When the node cannot reach the panel, every protected request fails at once, unless the relay is told to let requests through. Letting them through removes the protection; failing takes the app down with the link.
- It needs a path from the node to the panel's public origin, which the proxy is documented not to assume. It would be the first feature whose serving depends on that path. Visitor cookies would travel from the node to the panel along it.
- The other reading, a check carried "through the agent" on today's channel, cannot serve each request: the panel dials the agent, and the agent has no way to call back. A long-poll like the wake demand's would add its interval, two seconds, to every request.

### B. The node verifies a signed value (short-lived signed authorization)

The panel signs, and the node checks the signature and admits the request without asking anyone. Three values:

- **Grant.** What the visitor's browser holds, in a second cookie `nd_fg_<domainId>` beside today's session cookie. The panel signs it with its own ed25519 key. It holds the user id, the domain id, the token version, the user's email (for `X-Forwarded-User`), the key id, the time it was issued and the time it ends. It lives as long as the session, 12 hours.
- **Ticket.** What takes the place of the one-time code at sign-in. `POST /v1/forward-auth/grant` answers with a signed value: the grant's fields, the return URL, the state, and an end 60 seconds away. The browser opens the callback with it. The node checks the signature, the end time, the domain, the host of the return URL and the `state` cookie, sets the grant cookie and sends the visitor back. The node calls no one, and the panel remembers nothing, so a sign-in survives a panel restart.
- **Lease and revocations.** A sealed operation from the panel to the agent, `proxy.forwardAuth.sync`, every P seconds while the node serves protected domains. It brings the public keys, a signed lease, the panel's clock and the grants denied since the last sync. The agent writes them for the verifier and answers with the claims of the grants it is honoring. The panel judges those claims with today's rule and names the ones that no longer pass in the next sync. The verifier honors a grant only while the last sync is at most L old.

In B the node needs no route to the panel. It needs the panel to reach it, which every operation already needs.

## 4. Comparison

| | A: the node asks the panel | B: the node verifies a grant |
|---|---|---|
| Cost of one request | one round trip to the panel, unless cached | one signature check in the node's memory |
| Where the check's data lives | the panel's database, as today | the grant, and what the last sync brought |
| Revocation, panel and node connected | at once, after the panel's 30-second cache | at the next sync: within P, plus the same cache |
| Sign out everywhere, user deactivated, seat removed, role lowered | the same | the same: the panel judges every grant it is told about |
| Panel down, or the panel cannot reach the node | every request fails at once, or fails open | visitors keep working for L, then every request fails closed |
| A revocation while the panel is down | nothing is served anyway | cannot be issued; all access ends within L, and it applies at the first sync before access resumes |
| Sign-in while the panel is down | impossible | impossible: the sign-in page and the ticket are the panel's |
| Route the node needs | to the panel's public origin, over HTTPS | none |
| Visitor cookies leave the node | yes, for the panel | no |
| Key material on the node | none | public keys only, so a node cannot mint a grant |
| Panel restart during a sign-in | as today | nothing is lost: the ticket is signed, not remembered |
| Parts to build | a relay on the node, a reachability check | a verifier on the node, a signing key, a sealed operation, a sync loop |
| An older agent | a refusal | a refusal |

A is the smaller change, and it fails closed the moment the panel is out of reach. B costs more to build. It keeps a node's protected apps serving through a short panel outage, at a staleness that is stated and bounded.

## 5. Recommendation

B, with the lease, failing closed when the lease runs out.

1. **It keeps the documented rule.** Nothing on the node dials the panel, so a node behind a NAT or a firewall can offer panel sign-in, and serving never waits for the panel.
2. **Its revocation is as quick as today's cache and complete by construction.** The panel judges each grant with the rule it already has, so no change of role, seat, token version or `minRole` needs a hook of its own.
3. **Its failure is explicit and bounded.** A node that cannot hear the panel admits nobody after L, as a panel-host app behind sign-in is unreachable while the panel is down. No stale authorization survives a reconnection: access resumes only after a sync.
4. **A compromised node cannot sign anyone in.** It holds public keys.

If the owner wants the smaller change first, and every node that would use it can reach the panel's public origin, A is sound as long as it fails closed. B can replace it later without changing the setting or the name of a cookie.

## 6. Specified behaviour

The values are proposals, to be fixed in the first slice and measured in the acceptance: P is 30 seconds, L is 5 minutes, a ticket lives 60 seconds, a grant 12 hours, and times are judged with 30 seconds of leeway. L is the time after which the panel reads a node as offline, and the sealed transport's clock window.

**While the panel and the node hear each other**

- The node's `forwardAuth` middleware is first on the router, as on the panel host, and points at the verifier on the node's own `ninedeploy` network. Nothing else on the router runs for a visitor who is not admitted, so an unknown visitor does not wake a sleeping service.
- The verifier answers 200 and `x-forwarded-user` for a grant whose signature, key id, domain id and end time are good and that is not denied.
- A browser without one is sent to the panel's `/forward-auth` page, with a `state` cookie, as today. Anything else gets 401.

**Sign-in**

- As today up to the grant: the panel's page asks for the panel's own session and checks, and that the caller's role on the service is at least `minRole`. It then signs a ticket.
- The node checks the ticket and the `state` cookie, and sets the grant cookie: HttpOnly, SameSite=Lax, Secure on HTTPS. The callback answers `cache-control: no-store` and `referrer-policy: no-referrer`.
- A service moved from the panel host to a node asks its visitors to sign in once more. Their browsers hold a session cookie, not a grant.

**Revocation and role changes**

- At each sync the agent reports the claims of the grants it honors. The panel judges them in batches with today's rule: the user is active, the token version is unchanged, the role is at least `minRole`. A grant that fails is named in the next sync and denied from then on. Sign out everywhere, a deactivated user, a removed seat, a lower role and a raised `minRole` each take effect within P, plus the panel's cache.
- A raised `minRole`, or a protection saved again, sends every visitor of that domain to sign in again.
- Protection turned off: the save writes the node's routes and confirms them before it answers, as maintenance does (`apps/server/src/lib/proxySettingApply.ts:54-78`). Until they follow, the node keeps protecting.

**The panel down, or the panel unable to reach the node**

- For L after the last sync, nothing changes for visitors.
- After L the verifier admits nobody: a browser gets a 503 page that says the panel cannot be reached, an API client gets 401. The verifier queues nothing and retries nothing.
- Nobody can sign in.
- When the panel is back, the first sync brings the revocations made in the meantime, then the lease. Visitors whose grants still pass continue without signing in again.

**Clocks**

- The lease is measured on the node's own clock, from the arrival of the last sync, so it does not depend on the two clocks agreeing.
- Grant and ticket times are judged on the panel's clock. Each sync carries it, and the verifier keeps the offset. The sealed transport already needs the two clocks within five minutes of each other.

**Keys**

- One signing key per panel, ed25519, made at first use and stored encrypted like the node wake key. The private key never leaves the panel.
- Every sync brings the current public key and the one before. A grant names its key id. To rotate: make a key, sync it, sign with it, keep the old public key in the sync for as long as a grant signed with it can live, then drop it.
- The verifier keeps its last state across a restart of the node. Each sync carries a number that only grows, and a sync with a lower number is refused.

## 7. Older agents and mixed versions

- A new capability, `proxy.forwardAuth`, advertised by the agent that carries the verifier, and one sealed operation under it, `proxy.forwardAuth.sync`. A node switch, `NINEDEPLOY_AGENT_NODE_FORWARD_AUTH`, on by default as the page server's is; `off` removes the capability.
- Until the first cell ships, nothing changes. After it, an agent that does not advertise the capability is answered as today for any other missing one: `422 node_agent_outdated`, `403 node_feature_disabled` when its owner switched it off, `422 node_transport_unsealed` when the panel reaches it only unencrypted. The capability table answers `limited` for a node that can verify and `unavailable` for any other.
- A node without the capability keeps today's guards: its proxy does not route a protected domain, and a protected service cannot move to it.
- A newer agent under an older panel changes nothing, as for every capability: it advertises one more name, and the panel ignores it.
- The panel host keeps today's mechanism. Whether it moves to grants later is outside N11.

## 8. Cells, and the guards each one releases

A cell is accepted on its own evidence. Until it is, its guards stay as they are.

| Cell | What it accepts | Guards it releases |
|---|---|---|
| 1. A service on one node (primary, Docker) | Sign-in on its domains, checked on the node | The render skip (`proxy.ts:1256`) for a node that advertises the capability. The move refusal, for a move to one such node and never to a fan-out target, on the pattern of `nodeServesPages`. The import skip (`portableSettings.ts:203-207`) on the same condition. The node answer of the capability table. |
| 2. Revocation, roles, key rotation, clocks | Section 6, on the evidence of its scenarios | None new |
| 3. Sign-in with node sleep and wake, and with maintenance and error pages | The order on the router, proven | The exclusion of sign-in domains from node pages (`nodePagesSync.ts:57-63`) |
| 4. Compose stacks and other runtimes on a node | To be designed after the render for them is read | None yet |
| 5. A service with fan-out targets | Not designed here: every target proxy would need the verifier and the sync | Stays refused |

The save route changes with cell 1. For a node service it asks the node's agent for the capability, where today it asks whether Traefik can reach the panel, and it applies through the node branch of `applyProxySetting` (`requireNode`, `confirmNodeRouting`), as maintenance does.

## 9. What a node can and cannot do

- The proxy enforces; the verifier only answers. Any container on the node's `ninedeploy` network can call the verifier, as it can call the wake catcher, and an answer grants nothing by itself. Service containers share that network, so sign-in protects the public route of a domain, not traffic between containers. That is so on the panel host today.
- A node holds public keys only. It cannot mint a grant or a ticket. It can stop checking, which the proxy of that node could always do.
- A grant is a bearer value, as the session cookie is: a stolen one works until it ends or is denied. It is bound to its domain id and travels only as an HttpOnly cookie of that domain.
- The ticket sits in a URL for 60 seconds, as the code does today, and is bound to the `state` cookie, so nobody can sign a visitor in as someone else. The callback answer sends no referrer.
- The verifier makes no request of its own, so a flood of unknown visitors cannot turn a node into a relay onto the panel.
- A grant shows the user's email to the user's own browser. The app receives the same address in `X-Forwarded-User`.

## 10. Acceptance: two daemons and a real proxy

Two Docker daemons, one for the panel host and one for the node, and a real Traefik on the node. The precedents are the multi-node and proxy-settings smokes (`scripts/smoke-multinode.mjs`, `scripts/smoke-proxy-settings.mjs`). Each line names what is measured.

| Scenario | Expected |
|---|---|
| An API client without a grant, a browser without one, a signed-in browser | 401; 302 to the panel with a `state` cookie; 200 with `X-Forwarded-User` |
| A grant that was changed, has ended, belongs to another domain or names an unknown key; a ticket without its `state` cookie, or after 60 seconds | refused |
| Sign out everywhere; a deactivated user; a removed seat; a role below `minRole` | denied within P and the cache |
| `minRole` raised | every visitor signs in again |
| The panel stopped while visitors work | no change for L, then 503 to browsers and 401 to API clients; nobody signs in |
| The panel back | denied grants are refused before any other resumes; the others continue |
| The panel up, its path to the node blocked, visitors still arriving | the same two lines |
| The node restarted | it resumes within L; after L it admits nobody until a sync |
| The previous agent version on the node | `422 node_agent_outdated`; the protected domain is still not routed; the move is still refused |
| The switch off; an unsealed transport | `403 node_feature_disabled`; `422 node_transport_unsealed` |
| The key rotated while visitors work | nobody signs in again; the old key leaves the sync after 12 hours |
| The node's clock off by two minutes | the same answers |
| A protected service given a fan-out target | refused, as today |
| The cost of a request | the difference between a protected and an unprotected service on the same node, p50 and p99, with the method recorded |
| A flood of requests without a grant | no request leaves the node for the panel |

None of it shows a person using it. A manual pass on a node behind a NAT belongs to the acceptance of cell 1.

## 11. Decisions for the owner

1. **B or A.** B is recommended.
2. **Behaviour in an outage.** Failing closed after L, five minutes, is recommended. The alternative lets a node keep admitting visitors for longer while the panel is down. It would be an explicit setting, off by default, and it means that a revoked user keeps access until the panel is back or the grant ends.
3. **The node switch.** On by default, like the page server's, is recommended. The alternative is opt-in.
4. **Fan-out.** Whether it is needed. It stays refused until it is designed.
5. **The panel host.** Keep today's mechanism, recommended for N11, or move it to grants as well.

## 12. Slices

1. Cell 1: the verifier, the signing key, tickets and grants, the sealed sync with the lease, the capability and its switch, and the guards of cell 1. A unit test for every value and every refusal; the scenarios of section 10 that need one node and one signed-in visitor.
2. Cell 2: revocation and roles over the reported grants, key rotation and the clock offset, with their scenarios.
3. Cell 3: sleep and wake, maintenance and error pages, with sign-in.
4. Cells 4 and 5, after the decisions above.

## 13. What this record has not verified

- The cost of one signature check in Node on a node. It is to be measured, together with the verifier's own overhead.
- Traefik's `forwardAuth` against a container on the node's `ninedeploy` network. The page server and the wake catcher are called that way, but not by a `forwardAuth` middleware.
- How compose stacks and runtimes other than Docker are rendered for a node.
- What a visitor receives today for a protected domain on a node. The domain is not routed, and no test states the answer.
- The inside of `scripts/smoke-multinode.mjs`.
- Whether the verifier belongs in the `ninedeploy-pages` container or in one of its own. The page server already runs from the agent's pinned image on that network and receives its files through sealed operations.
