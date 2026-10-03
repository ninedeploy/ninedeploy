# 0.10.8 preparation audit

Date: 2026-09-25. Starting revision: `5db995a` (0.10.7), clean checkout, CI
green, `pnpm audit` clean.

Method: six parallel read-only reviews (deploy engine; route authorization in
the less-audited modules; client ↔ server contract across web, SDK, CLI and
MCP; lib/plugins/retention/migrations; node agent, installer, CI and the
template catalog; web UI correctness). Every candidate was re-confirmed against
the code before fixing. Each fix carries a regression test that was run against
the pre-fix source (old file written back with `git show`, never a stash) and
seen to fail. Defect ids r260–r362.

Validation: the serialized release gate (`pnpm release:check` — typecheck,
lint, build, every workspace test suite with coverage floors) passes on the
release tree. Not exercised end to end: real remote nodes, the installer on a
live host (the tty guard and the EXIT trap were exercised in a container and
with a fake `systemctl`), and real-browser flows.

## Fixed

| Area | Id | Fault | Change |
| --- | --- | --- | --- |
| API tokens | r260 | `parseId` accepted `1e0`/`0x1`/`+1`, the sub-resource scope overrides matched only `\d+` — a services-only token reached env, webhooks and deploys | Canonical decimal ids only; overrides match any id segment |
| Authorization | r280 | Members could delete operator exec/backup jobs; viewers read exec commands and output | Operator-only delete, 404 on miss; command/output redacted for non-operators |
| Authorization | r281 | `GET /alerts` listed every tenant's rules | Filtered to visible services; host-wide rules for operators |
| Authorization | r285 | Tag PUT stripped other workspaces' labels | Invisible labels are preserved |
| Authorization | r287 | Any drain (disabled, other service's) usable by non-operators, spending its API key | Enabled global or same-service drains only |
| Audit trail | r282, r283, r286 | Env overwrite, service export (plaintext secrets), metric flush, build-cache store skipped `audit()` | Audited; marketplace refresh operator-only; plugin inspect no longer invents telemetry |
| Secrets | r284 | Applying a config preset rewrote an ad-hoc secret as plaintext | Secrecy resolved from the existing row |
| Secrets | r310 | Egress refusals echoed the full URL (webhook tokens) into logs and `notification_log` | Origin only |
| Deploy engine | r272 | Cancel + redeploy ran two pipelines in one checkout | Worker waits for the cancelled pipeline to exit |
| Deploy engine | r273 | A failed `git pull` (force-push) was swallowed and the old HEAD deployed green | Checkout moves to the fetched remote tip; real failures fail the deploy |
| Deploy engine | r274, r274b | The generated `nixpacks.toml` froze later manifest changes | Marked, regenerated or removed per deploy; pre-marker files recognised as untracked |
| Deploy engine | r321 | Docker services never mounted their attached volumes | One `-v` per attachment |
| Data loss | r275, r277 | Container/volume file editors silently truncated files over 1 MiB to their tail, then saved it | Refused with 413 |
| Backups | r276 | A failed backup left the plaintext dump on disk and in the container | Cleaned on every failure path |
| Backups | r312 | A 200 `CompleteMultipartUpload` carrying `<Error>` recorded a phantom remote recovery point | Treated as failure, upload aborted |
| Concurrency | r314 | Two waiters could both take a stale cross-process lock; release deleted others' locks | Ownership token; rename-based stale takeover |
| Webhooks | r313 | Replay guard keyed on the unsigned delivery-id header | Also dedupes sha256(body) per service |
| Remote nodes | r264–r270 | Published-port redeploys always failed; crash loops passed health; cmd/socket/volumes dropped silently; multi-line env and `_KEY` rejected; changed repo URL ignored; credentialed repos and DB templates deployed broken; tags recorded as digests | Fixed or refused up front with a reason (`lib/remoteDeploy.ts`) |
| Database | r300 | `services.environment_id` and `backups.destination_id` had no `ON DELETE SET NULL` in SQL — lane and destination deletes 500'd | Migration 0064 rebuilds both tables; drift test now compares foreign keys |
| Database | r301 | Revoke → re-invite the same email 500'd on a full unique index | Partial unique index (outstanding invites only) |
| Retention | r302 | `backup_drills`, `workspace_invitations`, `domain_transfers`, `cache_registry_blobs` unswept; running deploys' logs pruned; drill plaintext left behind | Sweeps added; live logs kept; leftovers removed |
| Scheduling | r303 | A disabled job kept firing up to 5 minutes | Scheduled runs re-check `enabled` |
| Images | r311 | "In use" compared image references with ids — always false | Resolves container image ids |
| Installer | r261–r263 | ACME prompt aborted tty-less self-updates after stopping the panel; failed upgrades left the panel stopped; `--docker` could never pass its image check and ignored `--version` | Real tty probe; EXIT trap restarts the unit; lowercase image, pinned `:vX.Y.Z` |
| Templates | r320, r330 | wud mounted a volume where the Docker socket belongs; speedtest-tracker lacked APP_KEY; community templates 404'd on open/deploy | Fixed |
| Contract | r331–r335, r340–r347 | Stale PgBouncer responses; no domain verify in SDK/CLI/web; MCP scopes that could never pass; SDK types that disagreed with the server; PATCH silently dropping tag fields; Web Studio link to a loopback port; clearing a volume mount ignored; stale caches after saves; unpaginated Activity; no way to set a deployment lane | Fixed |
| Web UI | r290–r299 | Log autoscroll trap, repeating update toast, keyboard-inaccessible Hub cards and dialogs, focus not restored, invite landing in the wrong workspace, stale env table, stale analysis, doubled log lines | Fixed |
| Test hygiene | — | Two suites booted the real Traefik plugin, recreating the host's `ninedeploy-traefik` container on a developer machine; the webhook suite called the real builders (`docker stop/rm`, `compose down`, a PM2 daemon that outlived the run) | Stubbed |
| Proxy | r350 | A Traefik container serving another data dir's config matched the fingerprint and was kept | Mount source compared too |
| Tenancy | r351 (was r096b) | A new service under a deleted service's slug mounted its retained data volume | 409 `slug_volume_retained` on every create path |
| Compose | r352 | A repo-committed `.env` was replaced by panel values, then deleted | Panel values layered on top, original restored |
| Fan-out | r353 | Extra nodes cloned credentialed repos anonymously, with no egress gate | Skipped with a log line; gate added |
| SSO | r354 | SAML could never sign anyone in, yet providers could be created | Refused with `saml_unavailable` |
| Egress | r355 (was r099b) | DNS rebinding between the git egress check and git's own resolution | `http.curloptResolve` pinned to the vetted addresses (https) |
| Backups | r356 | Drills used host tools no installer provides and could not read Mongo archives | In-image checks, completion trailers, `unverifiable` status |
| Installer | r357, r362 | A failed tarball upgrade left the panel down; `db:migrate` migrated a stray database | Rollback to the previous release (DB restored when migrated); relative DB path anchored at the repo root |
| Panel | r358–r361 | Transfer accept link 404; enrolment token unreachable; branding invisible; 404/403 existence leak | Pages/cards added; uniform 404 |

Dependencies: fastify 5.12.5, @fastify/static 10.1.4, @fastify/websocket
11.3.1, jose 6.2.12, pm2 7.0.4, MCP SDK 1.30.1, TanStack Query 5.103.2,
xyflow 12.11.6.

## Behaviour changes operators may notice

- Migration 0064 rebuilds the `services` and `backups` tables (foreign keys
  off, ids and AUTOINCREMENT counters preserved). The installer's pre-upgrade
  database backup covers it.
- Deploy checkouts now reset to the remote branch tip (`checkout -f`): local
  edits inside the panel's working copies are discarded on every deploy.
- Node-pinned services that need a template command, the Docker socket, extra
  volumes, a Git credential or a managed database are now refused with a
  reason instead of deploying broken. Upgrade node agents to pick up
  `_`-prefixed env keys and repository-URL changes.
- Route ids must be canonical decimals (`01`, `1e0` → 400). `PATCH
  /v1/services/:id` answers 400 `tags_via_put` for tag fields.
- Plugin inspect reports `null` for runtime counters the kernel does not
  track.

## Known, not fixed in this release

- SAML sign-in (r354 refuses it): needs a vetted XML-signature library and an
  AuthnRequest bound to `InResponseTo` + a RelayState cookie.
- ssh / git:// remotes are egress-checked but not DNS-pinned; node-side
  (`git.ensure`) clones re-resolve on the node.
- Remote compose still overwrites a repo's `.env` on the node (agent
  protocol unchanged in a patch).
- Compose-stack named volumes (`ndcmp-<slug>_*`) outlive a deleted stack and
  are not covered by the r351 slug check.
- The upgrade rollback (r357) protects upgrades started by this installer
  onward; a health-gate failure after the restart is not rolled back
  automatically (the rollback folder is kept and named).
- Some branding fields (`primaryColor`, `footerHtml`) are not applied —
  footer HTML would need a sanitiser.
- r094b is closed by refusal: TOTP users cannot sign in through OIDC (they
  use password + code); a pending-2FA step would let them.
- Wave 4 of the 2026-09 security plan (host/supply chain) has not started.
