# NineDeploy documentation

The guides are grouped by what you are doing. The last group holds the project's own records, such as audits, acceptance evidence and roadmaps. Those are kept for transparency; you do not need them to run NineDeploy.

## Get started

- [Quickstart](QUICKSTART.md): install, first sign-in, first deploy, upgrades.
- [Support matrix](SUPPORT_MATRIX.md): which service features work on the panel host, on nodes, on Swarm, and for Compose and PM2.
- [Troubleshooting](TROUBLESHOOTING.md): common failures and how to recover.
- [Moving from Coolify, Dokploy, CapRover or Heroku](IMPORTING.md): a read-only import plan (`ninedeploy import plan`), then `ninedeploy import apply` to create the services and databases, `ninedeploy import data` to move database contents and service volumes, and `ninedeploy import cutover` to add the domains once DNS points here.

## Guides

**Deploying**
- [Deployments](DEPLOYMENTS.md): builds, healthchecks, zero-downtime releases, canaries, autoscaling, scale to zero, previews and approvals.
- [Rolling back a release](ROLLBACK.md)
- [Private repositories](PRIVATE_REPO_GUIDE.md): sources, deploy keys and commit statuses.
- [GitHub App](GITHUB_APP.md): one-click setup, PR previews and required CI.
- [CI on your own runners](CI_RUNNERS.md)
- [The `.ninedeploy` manifest](NINEDEPLOY_MANIFEST.md)

**Data**
- [Databases and backups](DATABASES_BACKUPS.md)
- [Restore verification and point-in-time recovery](RESTORE_VERIFICATION.md)
- [Panel self-backup](PANEL_BACKUP.md)

**Networking**
- [Ingress, routing and tunnels](TRAEFIK_INGRESS.md)
- [Remote nodes](MULTI_NODE.md)
- [Node operations](NODE_OPERATIONS.md): readiness, metrics and logs on nodes.

**Access and security**
- [Security and single sign-on](SECURITY_SSO.md): 2FA, passkeys, OIDC, SAML and the panel IP allow-list.
- [SSO account linking](SSO_ACCOUNT_LINKING.md)
- [Workspaces and roles](WORKSPACES_RBAC.md)
- [Secret managers](SECRET_MANAGERS.md)
- [Terminals](TERMINALS.md)

**Observability**
- [Resource history, metrics export and durable logs](OBSERVABILITY.md)
- [Uptime monitors and status pages](UPTIME.md)
- [AI assistant](AI.md)

## Reference

- [API, MCP server, CLI and SDK](AI_MCP_CLI.md)
- [Plugins and the microkernel](PLUGINS_MICROKERNEL.md)
- [Instance GitOps](INSTANCE_GITOPS.md)
- [Template mirrors](TEMPLATE_MIRRORS.md)
- [Interface translations](TRANSLATIONS.md)
- [Desktop client](DESKTOP.md)
- [Developing on macOS](MACOS_DEVELOPMENT.md)
- The architecture guide, at [../ARCHITECTURE.md](../ARCHITECTURE.md).

## Project records

These documents are kept for transparency. They are dated, and parts of them describe work in progress.

- [Roadmap](ROADMAP.md) and the current plan, [plans/COMPETITIVE_ROADMAP_2026-11.md](plans/COMPETITIVE_ROADMAP_2026-11.md)
- [Competitor gap roadmap, 2026-10](GAP_ROADMAP.md)
- [Competitive delivery: acceptance evidence](COMPETITIVE_DELIVERY.md)
- Node work in progress: [request-rate autoscaling](NODE_RPS_AUTOSCALING.md) and [scale to zero and wake](NODE_SLEEP_WAKE.md)
- [Swarm runtime acceptance](SWARM_RUNTIME_ACCEPTANCE.md)
- Audits: [0.10.2](AUDIT_0.10.2.md), [0.10.8](AUDIT_0.10.8.md), [security remediation, 2026-09](SECURITY_AUDIT_2026-09.md)
- [Persistent port ingress plan](plans/persistent-port-ingress.md)
