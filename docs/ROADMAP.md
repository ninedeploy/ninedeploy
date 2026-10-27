# NineDeploy roadmap

This plan was drawn up on 2026-10-08 from a feature-gap analysis against Dokploy v0.30.0 and Coolify v4.4.x. Every gap listed here was checked against the NineDeploy source code.

## Current release sequence — updated 2026-10-27

Ship independently accepted increments regularly. The owner replaced the single large 0.18.0 scope with the sequence below. Published 0.18.4 includes R1 and the accepted deployment-safety/node-lifecycle maintenance work. R2 is the next feature package; later packages do not block validated maintenance releases.

| Release | Scope | Release condition |
| --- | --- | --- |
| **0.18.4 — published** | Observability/runtime/node work plus **R1: public node canary** and deployment-safety/node-lifecycle maintenance | Hosted release jobs passed; GitHub assets, signatures, multi-architecture image revisions, npm integrity and the public CLI were independently verified |
| **0.18.x**, when needed | Validated fixes, compatibility and maintenance | Focused regressions and the current patch's release/upgrade gates; ship without waiting for R2 |
| **0.19.0 target** | **R2:** ordered node Stop/deploy/scale/wake, node autoscaling/sleep and remaining Swarm support | Shared durable authority across all runtime producers; real first-deploy/handoff cancellation and recovery, scaling/wake/restart/rollback, mixed-agent upgrades and full release verification |
| **0.20.0 target** | **R3:** isolated restore verification and PostgreSQL PITR | Actual restore/query/recovery-time and point-in-time recovery evidence, followed by release verification |
| **0.21.0 target** | **R4:** remote MCP over HTTP/OAuth | Real-client authorization, expiry/revocation and stdio compatibility, followed by release verification |
| **0.22.0 target** | **R5:** durable CI and isolated runners | Actual execution, isolation, approvals and restart recovery, followed by release verification |
| **0.23.0 target** | **R6:** packaged desktop | Secure credentials/IPC/navigation and supported-platform installer acceptance, followed by release verification |

Versions 0.19.0–0.23.0 are planning targets, not publication dates. Existing 0.18.0, 0.18.1 and 0.18.3 candidate tags are preserved; they do not represent published releases. Smaller validated patches may ship between feature milestones. R7 is the recurring certification/publication gate for **every** release, not a final milestone after R6. R1 and the 0.18.4 publication gate are accepted. R2 development is underway; generation-independent Stop, durable node deployment admission and superseded-continuation fencing are development checkpoints. Physical prepare/network/retire and scale/wake wiring plus the remaining R2 acceptance gates are still open. See the detailed [incremental release plan](COMPETITIVE_DELIVERY.md#incremental-release-plan--2026-10-24) for acceptance criteria and current evidence.

Earlier dated sections and acceptance records describe their original scope. This sequence supersedes statements that all six packages must be completed before 0.18.0. Existing additive migration, compatibility, verification and publication requirements remain in force.

## Competitive follow-up — 2026-10-21

The current implementation sequence is: required CI for a pinned commit; immutable release/artifact promotion across lanes and nodes; longer metrics retention with Prometheus/OTLP export and durable log delivery; real database restore drills with measured recovery; HTTP MCP/OAuth; and remaining node management parity. These are separate acceptance packages, not a claim of overall competitor parity.

The required GitHub workflow gate and Docker artifact promotion from the panel and capable nodes are included in **0.17.1**, with UI/API/SDK support. Node-built artifacts retain a verified panel copy and their historical build-node identity. A recorded image can run without rebuilding on the panel or one node, using sealed stream transfer or an optional pinned registry archive, with target runtime settings retained. Swarm/fan-out promotion and complete environment snapshots remain open. Release publication remains gated on checks and upgrade/runtime smokes. See [GitHub App CI requirements](GITHUB_APP.md#required-ci-workflows-0171) and [artifact promotion](DEPLOYMENTS.md#docker-artifact-promotion-0171).

## Delivery in progress — 2026-10-23

The multi-release acceptance sequence is tracked in [Competitive delivery](COMPETITIVE_DELIVERY.md). Under the revised plan, **0.18.0 closes after R1 and its release checks**; R2–R6 follow in separate releases. Observability, routed primary/fan-out Docker recovery, recorded artifact fan-out/Swarm promotion and rollback, Swarm preload placement safety and durable native Swarm update recovery are implemented and locally validated; see [Observability](OBSERVABILITY.md) and [Deployments](DEPLOYMENTS.md) for limits. These increments remain unpublished; the checkout version is still 0.17.1. Explicit-host node container inspect/Compose/files are also implemented and locally validated (13,716-test frozen Linux checkpoint). Docker ↔ Swarm migration, active-runtime upgrade from published 0.17.1 and durable cross-runtime recovery are also locally validated (13,744-test frozen Linux checkpoint). Node volume file tools are also locally validated (13,857 tests in the frozen Linux checkpoint, real API/SDK/CLI and desktop/mobile browser flows). Node database client terminals are also locally validated in their own frozen checkpoint (13,943 tests, 837 files, all tasks uncached), with actual seven-engine API/SDK and desktop/mobile panel controls. Subsequent Studio work is outside that historical checkpoint; its later acceptance is recorded in the tracker. Node canary and the 0.18.0 release checks remain current-release work; autoscaling, recovery/PITR, remote MCP, runners and desktop belong to the later release sequence above.

## The rule every release follows

**Installed servers must upgrade in place without breaking.** Panels update themselves, so any release reaches every operator automatically.

- Migrations are additive only: new tables, nullable columns, or columns with defaults. A column is never dropped or renamed in the same release that stops using it.
- After an upgrade, existing data keeps behaving exactly as it did. New behaviour is opt-in, or defaults to the old behaviour.
- Before any tag, `pnpm smoke:upgrade` runs from the previous release, and from the oldest supported line whenever the schema changes. Each new feature is exercised after the upgrade.
- Releases also pass the usual gates:
  - proof → patch → verify for every defect;
  - `pnpm release:check`;
  - `pnpm smoke:user-journey` on a locally built image;
  - signed publishing.

## 0.12 — Backups and previews (done)

- **Per-database backup policy:** a cron schedule, retention count and S3 destination for each database. This replaces today's single daily run with a fixed retention of 7.
- **Panel self-backup:** the panel's own export (database and settings) is written to S3 on a schedule, encrypted and kept for a set retention. A documented restore procedure ships with it.
- **Preview-only environment:** an environment set that applies only to PR previews. Previews deliberately receive no production secrets, so this set fills that gap.
- **Disk and server-offline alerts:** two new alert metrics, `disk` and `server_offline`, next to cpu, memory and certificate expiry.

## 0.13 — Git integration (done)

Shipped in 0.13.0; see [GITHUB_APP.md](./GITHUB_APP.md).

- **GitHub App:**
  - one-click setup through the manifest flow;
  - short-lived installation tokens instead of long-lived PATs;
  - automatic webhook registration;
  - commit statuses and PR comments showing the preview URL and the deploy outcome.
- **Gitea:** repository listing and token test.
- **Why this comes before multi-node work:** short-lived tokens let remote nodes clone private repositories without holding a long-lived credential.

## 0.14 — Network and data access (done)

Shipped in 0.14.0; see [TRAEFIK_INGRESS.md](./TRAEFIK_INGRESS.md) (directory provider, custom config, certificates, public database access), [DATABASES_BACKUPS.md](./DATABASES_BACKUPS.md) (dump import), [SECRET_MANAGERS.md](./SECRET_MANAGERS.md) and [ROLLBACK.md](./ROLLBACK.md).

- **Public database access:**
  - a per-database Traefik TCP sidecar (`HostSNI(*)`) on a port of its own, so the main ingress is never touched;
  - off by default, operator-only;
  - an IP allow-list is required;
  - TLS termination is optional (not for mysql/mariadb).
- **Proxy management:**
  - the panel's Traefik reads a dynamic-config directory (one recreate on the first 0.14 boot); this also fixes remote-node proxies, which loaded no routes before;
  - an editable custom Traefik dynamic-config file, validated and preflighted in a throwaway Traefik;
  - custom certificate upload.
- **Database dump import:** chunked, resumable upload or an S3 object, behind a `pre-import` safety backup.
- **Secret managers:** HashiCorp Vault / OpenBao (KV v2) and AWS Secrets Manager, alongside the existing Infisical and Doppler.

## 0.15 — Operations and API (done)

Shipped in 0.15.0; see [TERMINALS.md](./TERMINALS.md), [TRAEFIK_INGRESS.md §10](./TRAEFIK_INGRESS.md) (traffic analytics and log rotation), [WORKSPACES_RBAC.md §2.3](./WORKSPACES_RBAC.md) (access grants), [AI_MCP_CLI.md](./AI_MCP_CLI.md) (the OpenAPI document and the generated MCP tools) and [ROLLBACK.md](./ROLLBACK.md).

- **Terminals:**
  - container, database and node shells with a real TTY (Docker installs had none before), a resize-aware protocol, single-use tickets, idle and length limits;
  - host shells on the panel host and on nodes, off by default, behind operator, an interactive session, a password re-check and kill switches on the panel and on each node;
  - node shells through the agent over an encrypted channel (agent v0.15.0);
  - every session audited as metadata; no transcripts.
- **Traffic analytics:** opt-in; requests, status classes, bytes and latency percentiles per domain and service, from a JSON access log that keeps no client address, path or header. Off, the Traefik config is byte-identical to 0.14, so the upgrade does not recreate Traefik. Traefik's container log is rotated on the json-file/local drivers.
- **OpenAPI 3.1:** `GET /v1/openapi.json` behind login, covering every route, with read-only MCP tools generated from it and a `search_api` tool. Writes stay hand-curated.
- **Project- and environment-level access grants:** raise-only on top of workspace roles, with grant-only guests, suspend/reinstate and SCIM holds; a rollback to 0.14 only ever removes access.

## 0.16 — Multi-node (done, shipped as 0.15.2 to 0.15.5)

- **Remote nodes match the panel host:**
  - Nixpacks and Railpack builds;
  - private clones, using 0.13's short-lived tokens;
  - volumes;
  - managed databases on nodes, which needs a `databases.serverId` column (additive).
- **Dedicated build server:** build on one node and ship the image to the target node.
- **Swarm:** wire the existing driver into deploys.

Shipped as patches, as the owner asked: 0.15.2 (builds, clones, volumes), 0.15.3 (build server, image transfer, node databases), 0.15.4 (Swarm, opt-in on both the panel and the node) and 0.15.5 (web, CLI, SDK and MCP, plus a two-host smoke). See [MULTI_NODE.md](MULTI_NODE.md).

## 0.16.8 onward — ahead of the field

Drawn up on 2026-10-20 from a second gap analysis against Coolify v4.4.6, Dokploy v0.30.8, Railway, Render, Fly.io, Vercel, Netlify, Kamal, Dokku, CapRover and Portainer, and against their most-voted open feature requests.

**Existing capabilities.** The following are implemented, subject to the runtime
and host limits in their guides. Their presence alone does not establish
superiority over another platform:
- blue-green deploys for eligible Docker services, with readiness and application compatibility requirements;
- replicas for supported runtimes;
- pre/post-deploy hooks on the panel host;
- moving services between servers and workspaces, export/import bundles;
- panel self-backup with offline restore;
- image auto-update;
- GitHub commit statuses and PR comments;
- SSO/SAML/SCIM in the self-hosted build.

The 0.17.0 readiness, node metric history, log-drain and availability work is
tracked in [Node operations](NODE_OPERATIONS.md), including its verification and
the remaining delivery/recovery priorities.

The next increment adds recorded restores for self-contained inline Compose
stacks on the panel host: encrypted resolved configuration/environment and local
image IDs, with explicit recovery limits. See [Deployments](DEPLOYMENTS.md#recorded-compose-releases-0171).
This is not yet general immutable releases for every runtime or an image archive.

Each item below ships as its own patch release, opt-in, with the upgrade smoke extended to cover it.

1. **Uptime monitors and public status pages** (done, 0.16.8; see [UPTIME.md](UPTIME.md)). HTTP, keyword and TCP checks from the panel, with response times, down/up alerts through the existing channels, and opt-in public status pages with a 90-day history. Checks run from the panel; an independent external probe remains separate.
2. **Canary releases** (done, 0.16.9; see [DEPLOYMENTS.md](DEPLOYMENTS.md#canary-releases-0169)). Weighted traffic between the stable and the new release in steps (for example 10 → 50 → 100 %). Each step is gated on the health check and on the error rate and latency from traffic analytics, and an abort rolls back automatically. Currently limited to plain Docker services on the panel host; node and Swarm canary are not implemented.
3. **Autoscaling and scale-to-zero** (done: autoscaling in 0.16.10, scale to zero in 0.16.11; see [DEPLOYMENTS.md](DEPLOYMENTS.md#autoscaling-01610)). Replicas between a minimum and a maximum, driven by CPU, memory or requests per second. An idle service can sleep and is woken by its first request. This is the top open scaling request in both Coolify and Dokploy.
4. **A database copy per preview** (done, 0.16.12, for PostgreSQL and the Redis family; see [DEPLOYMENTS.md](DEPLOYMENTS.md#a-database-copy-per-preview-01612)). Each PR preview gets its own copy of the parent's database (from the latest backup or a live dump), with migrations run by the preview's pre-deploy hook. It is dropped when the PR closes. This is a full dump/restore copy, not copy-on-write branching; node databases and data masking are not supported.
5. **Protected environments and deploy approvals** (done: lanes and approvals in 0.16.13, fork PR previews in 0.16.14; see [DEPLOYMENTS.md](DEPLOYMENTS.md#protected-lanes-and-deploy-approvals-01613)). Production variables and logs hidden from members while git deploys keep working. Approval before a production deploy, and before a preview of a fork's PR builds; a fork is cloned with no credential.
6. **AI that fixes, not only explains:**
   - a failed-deploy diagnosis that proposes a concrete change, applied in one click (done, 0.17.0; see [AI.md](AI.md#a-proposed-fix-0170)) or opened as a PR through the GitHub App;
   - an automatic investigation when an alert fires;
   - runtime-log analysis (done, 0.16.15; see [AI.md](AI.md));
   - Claude as a first-class provider next to OpenAI-compatible endpoints (done, 0.16.15).
7. **Observability:**
   - a Prometheus `/metrics` endpoint and OTLP export;
   - per-container utilisation history (Coolify, 139 votes);
   - error-rate and latency alerts;
   - PagerDuty and Opsgenie channels.
8. **Git:** commit statuses for GitLab, Gitea and Bitbucket, and "wait for CI", which skips an auto-deploy whose checks failed.
9. **Usage and cost:** CPU-hours, memory, disk and bandwidth per workspace, project and service, priced from a per-server cost. No self-hosted tool has this.
10. **The remaining node gaps:**
    - node database public access, PgBouncer and Studio;
    - container inspect and file browsing (node terminals already ship);
    - log drains and metrics from nodes;
    - file mounts and container options on Swarm.
11. **Later:** Postgres point-in-time recovery (WAL-G), and Tailscale/WireGuard node networking.

## Ongoing, every release

- Templates: 305 since 0.15.7 (175 stacks from the Coolify mirror converter, each smoke-deployed). Of the other 114 mirror stacks, about 80 were not attempted (68 duplicate a template we already have, the rest have more than six services or are database variants) and 35 were tried and dropped: private or pull-denied images (ente, formbricks, buzz, freescout), a broken upstream `latest` (hoppscotch's migration, vikunja's volume permissions), stacks that need a licence or an external service (foundryvtt, openclaw, unleash), and a routed port that disagrees with the app (wikijs). Each can come back when its upstream is fixed; `scripts/smoke-template-runtime.mjs --registry=<mirror bundle> --ids=…` retests one.
- Extra engines and notification channels: done in 0.15.6 (KeyDB, Dragonfly, Microsoft Teams, Resend).
- SSH host key pinning for deploy-key sources: done in 0.15.8 (opt-in per source, panel clones only; a node keeps its per-job policy).
- The unproven leads in the audit hints list, proven or dropped one by one. Most that remain need a real compose binary or a live hung daemon to prove.

## Not planned for now

The following get revisited only if users ask for them:

- Caddy as an alternative proxy.
- Cloud-API server provisioning (Hetzner, DigitalOcean).
- Heroku/Paketo buildpacks.
- "Patches" file overlays.
