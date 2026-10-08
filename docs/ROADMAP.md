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

## 0.12 — Backups and previews

- **Per-database backup policy:** a cron schedule, retention count and S3 destination for each database. This replaces today's single daily run with a fixed retention of 7.
- **Panel self-backup:** the panel's own export (database and settings) is written to S3 on a schedule, encrypted and kept for a set retention. A documented restore procedure ships with it.
- **Preview-only environment:** an environment set that applies only to PR previews. Previews deliberately receive no production secrets, so this set fills that gap.
- **Disk and server-offline alerts:** two new alert metrics, `disk` and `server_offline`, next to cpu, memory and certificate expiry.

## 0.13 — Git integration

- **GitHub App:**
  - one-click setup through the manifest flow;
  - short-lived installation tokens instead of long-lived PATs;
  - automatic webhook registration;
  - commit statuses and PR comments showing the preview URL and the deploy outcome.
- **Gitea:** repository listing and token test.
- **Why this comes before multi-node work:** short-lived tokens let remote nodes clone private repositories without holding a long-lived credential.

## 0.14 — Network and data access

- **Public database access:**
  - routed through a Traefik TCP/HostSNI router;
  - off by default;
  - an IP allow-list is required;
  - TLS is optional.
- **Proxy management:**
  - an editable, validated custom Traefik dynamic-config file;
  - custom certificate upload.
- **Database dump import:** import a dump from an upload or from S3.
- **Secret managers:** HashiCorp Vault / OpenBao and AWS Secrets Manager, alongside the existing Infisical and Doppler.

## 0.15 — Operations and API

- **Terminals:** a server terminal through the agent, and remote container shells. Both are operator-only and every session is audited.
- **Traffic analytics:** requests, status codes and latency, read from the Traefik access log.
- **OpenAPI 3.1:** a spec generated from the zod schemas, with MCP tools extended from that spec.
- **Project- and environment-level access grants:** layered on top of workspace roles.

## 0.16 — Multi-node

- **Remote nodes match the panel host:**
  - Nixpacks and Railpack builds;
  - private clones, using 0.13's short-lived tokens;
  - volumes;
  - managed databases on nodes, which needs a `databases.serverId` column (additive).
- **Dedicated build server:** build on one node and ship the image to the target node.
- **Swarm:** wire the existing driver into deploys.

## Ongoing, every release

- Templates: grow from 130 to about 300 through the Coolify mirror converter. Each template is smoke-deployed.
- Extra engines (Dragonfly, KeyDB) and notification channels (MS Teams, Resend).
- The unproven leads in the audit hints list, proven or dropped one by one.

## Not planned for now

The following get revisited only if users ask for them:

- Caddy as an alternative proxy.
- Cloud-API server provisioning (Hetzner, DigitalOcean).
- Heroku/Paketo buildpacks.
- "Patches" file overlays.
