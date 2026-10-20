# NineDeploy roadmap

This plan was drawn up on 2026-10-08 from a feature-gap analysis against Dokploy v0.30.0 and Coolify v4.4.x. Every gap listed here was checked against the NineDeploy source code.

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

**Already ahead.** Several of the most-voted open requests in Coolify and Dokploy already ship here:
- zero-downtime blue-green deploys (Coolify's #1 open request, 161 votes);
- replicas (102 and 64);
- pre/post-deploy hooks (Dokploy, 42);
- moving services between servers and workspaces, export/import bundles (85 and 38);
- panel self-backup with offline restore (62);
- image auto-update (45);
- commit statuses and PR comments (50);
- SSO/SAML/SCIM without a paid tier (Dokploy sells them).

Each item below ships as its own patch release, opt-in, with the upgrade smoke extended to cover it.

1. **Uptime monitors and public status pages** (done, 0.16.8; see [UPTIME.md](UPTIME.md)). HTTP, keyword and TCP checks from the panel, with response times, down/up alerts through the existing channels, and opt-in public status pages with a 90-day history. No competitor has this built in.
2. **Canary releases** (done, 0.16.9; see [DEPLOYMENTS.md](DEPLOYMENTS.md#canary-releases-0169)). Weighted traffic between the stable and the new release in steps (for example 10 → 50 → 100 %). Each step is gated on the health check and on the error rate and latency from traffic analytics, and an abort rolls back automatically. Only Vercel ships this among hosted platforms; no self-hosted tool does.
3. **Autoscaling and scale-to-zero** (done: autoscaling in 0.16.10, scale to zero in 0.16.11; see [DEPLOYMENTS.md](DEPLOYMENTS.md#autoscaling-01610)). Replicas between a minimum and a maximum, driven by CPU, memory or requests per second. An idle service can sleep and is woken by its first request. This is the top open scaling request in both Coolify and Dokploy.
4. **A database branch per preview** (done, 0.16.12, for PostgreSQL and the Redis family; see [DEPLOYMENTS.md](DEPLOYMENTS.md#a-database-copy-per-preview-01612)). Each PR preview gets its own copy of the parent's database (from the latest backup or a live dump), with migrations run by the preview's pre-deploy hook. It is dropped when the PR closes. Netlify has this as a hosted service; no self-hosted tool does.
5. **Protected environments and deploy approvals** (done: lanes and approvals in 0.16.13, fork PR previews in 0.16.14; see [DEPLOYMENTS.md](DEPLOYMENTS.md#protected-lanes-and-deploy-approvals-01613)). Production variables and logs hidden from members while git deploys keep working. Approval before a production deploy, and before a preview of a fork's PR builds; a fork is cloned with no credential.
6. **AI that fixes, not only explains:**
   - a failed-deploy diagnosis that proposes a concrete change, applied in one click or opened as a PR through the GitHub App;
   - an automatic investigation when an alert fires;
   - runtime-log analysis;
   - Claude as a first-class provider next to OpenAI-compatible endpoints.
7. **Observability:**
   - a Prometheus `/metrics` endpoint and OTLP export;
   - per-container utilisation history (Coolify, 139 votes);
   - error-rate and latency alerts;
   - PagerDuty and Opsgenie channels.
8. **Git:** commit statuses for GitLab, Gitea and Bitbucket, and "wait for CI", which skips an auto-deploy whose checks failed.
9. **Usage and cost:** CPU-hours, memory, disk and bandwidth per workspace, project and service, priced from a per-server cost. No self-hosted tool has this.
10. **The remaining node gaps:**
    - port mappings with an allow list;
    - node database public access, PgBouncer and Studio;
    - the container terminal and file browser;
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
