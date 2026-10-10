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

## Ongoing, every release

- Templates: 305 since 0.15.7 (175 stacks from the Coolify mirror converter, each smoke-deployed). The mirror has about 110 more stacks that did not start cleanly in the smoke; they are fixed or dropped one at a time.
- Extra engines and notification channels: done in 0.15.6 (KeyDB, Dragonfly, Microsoft Teams, Resend).
- The unproven leads in the audit hints list, proven or dropped one by one.

## Not planned for now

The following get revisited only if users ask for them:

- Caddy as an alternative proxy.
- Cloud-API server provisioning (Hetzner, DigitalOcean).
- Heroku/Paketo buildpacks.
- "Patches" file overlays.
