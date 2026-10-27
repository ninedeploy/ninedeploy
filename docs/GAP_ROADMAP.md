# Competitor gap roadmap: 2026-10-27

This plan comes from a code-level analysis of the current releases of Coolify v4.5.0, Dokploy v0.30.10, CapRover v1.15.5, Dokku v0.38.32, Kamal v2.12.0 / kamal-proxy v0.10.2 and Komodo v2.3.4, plus Kubero, Canine, Tsuru, ZaneOps, Uncloud, Disco, Haloy and piku. Their repositories were cloned and read, not just their docs. Each gap below was checked against NineDeploy `main` (0.18.4). An item is counted as present only when it is reachable from the UI or the CLI, not merely implemented. The working notes and per-competitor evidence (file paths) are kept outside the repository.

The work runs **next to** the R2–R6 release sequence in [ROADMAP.md](ROADMAP.md); it does not replace it. Items ship as **patch releases**, each a coherent slice. They follow the rule every release follows: additive migrations only, new behaviour opt-in or defaulting to the old behaviour, and `smoke:upgrade` extended to exercise the item after an upgrade.

Status: ⬜ not started · 🟨 in progress · ✅ done (with the release that shipped it)

---

## G1: Quick wins

Small items that close a visible gap against Coolify or Dokploy. Each one is a single patch release or less.

| ID | Item | Who has it | Our approach | Size | Status |
|---|---|---|---|---|---|
| G1.1 | **Inline Dockerfile.** Paste a Dockerfile instead of keeping one in the repo; also works with a plain image-less "Dockerfile only" service. | Coolify (`deploy_simple_dockerfile`), CapRover (`dockerfileLines`), Komodo | Nullable `dockerfileContent` on the build config (size-capped, validated like `composeContent`). The builder writes it into the build context before `buildx`; with no repo, the context is an empty directory. Panel and node builders. | S | ⬜ |
| G1.2 | **Self-hosted GitLab.** Repository and branch listing against any GitLab URL. | Coolify (OAuth app + system hook), Dokploy (`gitlabUrl`) | A `baseUrl` on `gitlab` sources, the same https and egress rules as Gitea. Webhooks already verify `X-Gitlab-Token`. | S | ✅ unreleased; also added GitLab branch listing, which had always fallen back to main/master |
| G1.3 | **Restart-loop limit.** Stop a container that keeps crashing and notify. | Coolify (`max_restart_count`, `RestartLimitReached`) | The collector already samples container state. Count restarts per window, stop at the limit (opt-in per service, off by default), emit a `restart_limit` event through `audit()` so notifications fire. | S | ⬜ |
| G1.4 | **Workspace-enforced 2FA.** | Coolify (`Team.is_two_factor_required`) | A workspace flag. Members without TOTP or a passkey are sent to enrolment after sign-in, and only enrolment routes answer until they finish. SSO sign-ins are exempt when the IdP enforces MFA (setting). | S | ⬜ |
| G1.5 | **Web UI for API-only features.** PgBouncer toggle, Loki log search, static egress IP, config and domain presets, FCM channel form, backup drill, email templates. | Rivals expose these in the UI | Cards in the existing tabs, calling the routes that are already mounted. No server change. | M | 🟨 PgBouncer, backup drill, log search, FCM, egress IP, email templates done; domain presets wait for the concurrent Domains UI edit; config presets left to the CLI (operator internals) |
| G1.6 | **SAML status.** ROADMAP.md lists SAML as shipped, but provider creation is refused (`SAML_UNAVAILABLE`). | Dokploy (enterprise) | Correct the docs now. The implementation (a vetted XML-DSig library with c14n and an AuthnRequest flow) becomes G3.6. | S | ✅ docs corrected |
| G1.7 | **Registry push webhooks.** Deploy when an image is pushed, instead of waiting for the 30-minute digest sweep. | Dokploy (Docker Hub and GHCR `registry_package`) | A per-service token URL, as for deploy hooks. The payload's repository and tag must match the service image; the digest is then resolved as the sweep does. | S | ⬜ |
| G1.8 | **Backups for the remaining engines.** ClickHouse, Meilisearch and RabbitMQ are offered but answer "backup not supported". | Coolify (ClickHouse native backup) | ClickHouse `BACKUP … TO File`, Meilisearch's dump API, RabbitMQ definitions export, each through the existing encrypted stream and restore path. | M | ✅ unreleased (panel host; node databases of these engines still refuse) |

## G2: Compose, routing and access

| ID | Item | Who has it | Our approach | Size | Status |
|---|---|---|---|---|---|
| G2.1 | **A domain per compose service.** Today every domain of a stack routes to its main service. | Coolify (`docker_compose_domains`, `SERVICE_FQDN_<SVC>_<PORT>`), Dokploy (`createDomainLabels`) | A nullable `targetService` (and port) on the domain. The router targets that compose service; `null` keeps today's main-service routing. Magic variables gain the per-service form. | M | ⬜ |
| G2.2 | **Maintenance mode and custom error pages.** | Coolify 4.5 (error-pages container + Traefik `errors` middleware), Kamal (`maintenance`, request pausing) | Per-service maintenance switch routing to a panel-served page (the wake route shows the pattern), plus optional custom 502/503/504 pages through Traefik `errors`. Request pausing is a follow-up. | M | ⬜ |
| G2.3 | **Put any app behind panel sign-in (forward auth).** | Dokploy (enterprise, oauth2-proxy), Canine | A Traefik `forwardAuth` middleware pointing at a panel endpoint that checks the panel session or OIDC and the caller's access to the service. No extra container. Per domain, off by default. | M | ⬜ |
| G2.4 | **Skip a compose build when its inputs are unchanged.** | Coolify (build fingerprint), Komodo (deploy-if-changed) | Hash the resolved compose, build contexts and env; reuse the recorded images when the hash matches. | S | ⬜ |

## G3: Data, secrets and integrations

| ID | Item | Who has it | Our approach | Size | Status |
|---|---|---|---|---|---|
| G3.1 | **Move a service with its volume data** between the panel host and nodes. Today only configuration moves. | Dokploy (`transfer.ts`, tar streamed through the panel), Coolify (`VolumeCloneJob`) | Stop, then stream each volume as tar over the sealed agent channel with progress and a checksum, then deploy on the target. The source is kept until the operator removes it. | L | ⬜ |
| G3.2 | **More secret managers through one generic mechanism.** | Dokploy (8 providers), Kamal (9, through vendor CLIs) | Add AWS Parameter Store, Azure Key Vault, GCP Secret Manager and 1Password Connect natively. Add an operator-only `exec` provider (Uncloud's idea: run a command with a timeout and read stdout) to cover the rest. | M | ⬜ |
| G3.3 | **Backup replica destinations.** | Coolify (S3 replicas) | A backup policy may list extra destinations, each with its own retention. | S | ⬜ |
| G3.4 | **More log-drain targets.** CloudWatch, Elasticsearch/OpenSearch, Splunk HEC, Better Stack, New Relic, Axiom. | Dokploy (Vector, config checked by `vector validate`), Coolify (Fluent Bit, CloudWatch) | Generate a Vector sink config from the drain rows and validate it in a throwaway container before switching. | M | ⬜ |
| G3.5 | **More DNS record providers.** Route53, OVH, Porkbun, Hetzner DNS. | Dokploy (5 providers) | New drivers behind the existing DNS driver interface. | S each | ⬜ |
| G3.6 | **SAML that actually works.** | Dokploy (enterprise) | Use a maintained XML-DSig and c14n library, add an SP-initiated AuthnRequest, and lift `SAML_UNAVAILABLE`. | M | ⬜ |
| G3.7 | **More notification channels.** Mattermost, Google Chat, Matrix, PagerDuty, Opsgenie. The last two are ROADMAP item 7. | Dokploy (Mattermost) | New channel types in `notifier.ts`. | S | ⬜ |

## G4: Fleet operations (approved 2026-10-27)

Several of these were listed under "Not planned for now" in ROADMAP.md. Coolify spent most of 2026 here. **The owner approved all of G4 on 2026-10-27.**

| ID | Item | Who has it | Our approach | Size | Status |
|---|---|---|---|---|---|
| G4.1 | **More Linux distributions.** RHEL, Alma, Rocky, Fedora, Alpine (and SLES/Arch later) for `install.sh` and SSH bootstrap. | Coolify, Dokploy | Distribution detection with package-manager branches; the systemd unit and the Alpine OpenRC variant; extend the installer test matrix. | M | ⬜ approved |
| G4.2 | **OS security updates from the panel.** | Coolify 4.5 (unattended-upgrades or dnf-automatic, reboot detection) | A typed agent op group for listing updates, enabling automatic security updates and reporting a pending reboot. Never an automatic reboot. | M | ⬜ approved |
| G4.3 | **Create servers through cloud APIs.** Hetzner first, then DigitalOcean and Vultr. | Coolify (Hetzner, DigitalOcean, Vultr, Hostinger) | Create the VM with cloud-init that runs the existing SSH bootstrap, then enrol the agent. API tokens in the vault. | L | ⬜ approved |
| G4.4 | **Heroku and Paketo buildpacks.** | Dokploy, Dokku, Kamal | A `buildpacks` build pack wrapping `pack build`, checksum-pinned like Nixpacks. | S | ⬜ approved |
| G4.5 | **GitHub Actions runners on your own servers.** | Coolify 4.4 (`generate-jitconfig`, one container per job, dind or Sysbox) | Through the GitHub App: on `workflow_job` queued, start a just-in-time runner container on a build node. This could be a cheaper first step for R5. | M | ⬜ approved |
| G4.6 | **Interface translations.** Turkish and English first. | Coolify (20 languages), CapRover | Add an i18n layer to the web app, extract strings route by route, ship the Turkish locale. | L | ⬜ approved |
| G4.7 | **A larger template catalog.** Dokploy has 586, CapRover 361, Coolify 352, NineDeploy 305. | — | A converter for Dokploy blueprints (`template.toml` + compose) next to the Coolify mirror, with every stack smoke-run before promotion as in 0.15.7. | M | ⬜ approved |

## G5: Ahead of the field

None of the Docker-based rivals has these.

| ID | Item | Inspiration | Size | Status |
|---|---|---|---|---|
| G5.1 | **Image vulnerability scanning.** Trivy in a throwaway container after each build and on a schedule, with a severity summary and an optional gate on critical findings. | Kubero | M | ⬜ |
| G5.2 | **Pending changes tray.** Edits accumulate as field-level changes, are reviewed as a diff and applied atomically on deploy. This fits protected lanes and approvals. | ZaneOps, Coolify "changes pending" | M | ⬜ |
| G5.3 | **Instance-wide GitOps.** The whole instance (projects, services, domains, grants) as files in a repository, with a drift diff, an alert and an optional write-back of UI edits. | Komodo Resource Sync | L | ⬜ |
| G5.4 | **Sentry-compatible error ingest** per project, grouped by fingerprint and linked to the deploy that introduced it. | Canine | M | ⬜ |
| G5.5 | **Deploy freeze.** An admin block on deploys for a project or environment, with a reason and an expiry, checked by the queue. | Tsuru event blocks | S | ⬜ |
| G5.6 | **Autoscale on schedules and right-sizing hints.** Cron-scheduled replica floors, and memory and CPU limit suggestions from the metric history. | Tsuru | M | ⬜ |
| G5.7 | **Certificates shared across node proxies,** so any ingress node can serve any domain. | Uncloud 0.21 | M | ⬜ |
| G5.8 | **`ninedeploy tunnel`.** Forward a local port to a service or database through the panel, so database ports stay closed. | Haloy, Disco | S | ⬜ |

---

## Order of work

1. **G1** in the order listed. Each item is self-contained and ships when its gates pass.
2. **G2.1 and G2.2.** These are the most visible to template users.
3. **G3** in parallel where it does not touch the same files. G3.1 waits for R2's node lifecycle work to settle, because both change node runtime transitions.
4. **G4**, item by item, after the owner decides.
5. **G5**, interleaved where a release has room.
