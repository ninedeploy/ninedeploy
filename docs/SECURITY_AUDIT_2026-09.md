# Security Audit Remediation — September 2026

This document consolidates the remediation of the September 2026 security
audit across four working sessions. Every item lists the behavior change,
the operator-facing configuration it introduces, and the tests that lock it
in. Commits live on `main` (see `git log --grep "audit"` or the per-area
messages below).

## 1. Cross-tenant data chains (critical)

| Threat | Closure |
|---|---|
| Tagging a service with another tenant's project id leaked that project's decrypted shared env into the attacker's container at deploy time | `POST /v1/services` validates `tagProjectIds` / `tagWorkspaceIds` / `tagLabelIds` against caller visibility (same rule as `PUT /:id/tags`). Defence in depth: `engine/pipeline.ts → filterTrustworthyProjectLinks` re-verifies every `service_projects` link against the owner's workspace seat before decrypting; NULL-workspace projects never inject env |
| Any member could attach another tenant's `nd-svc-*` / `nd-db-*` volume read-write, or delete files from its root via config-repair | `serviceVolumes.ts → assertVolumeOwnership` runs before the docker probe on attach and config-repair: every attaching service must be visible to the caller, `nd-db-*` additionally requires `admin` on every candidate database, orphan/unknown managed names are operator-only |
| A member could attach a database they could merely SEE and read its admin-only password from the container env | `POST /:id/attachments` requires `assertDatabaseRole(..., 'admin')` (same tier as `/credentials`) |
| `visibleDatabaseIds` disagreed with `loadDatabaseForUser` (databases hidden from lists but open by id) | List visibility now derives from project workspace membership — identical rule to the detail loader |

Tests: `servicesCoverage.test.ts`, `serviceVolumes.test.ts`, `rbacRegression.test.ts`, `pipeline.test.ts`, `dashboard.test.ts`.

## 2. Remote agent transport (critical)

- Whether the agent "supports sealing" was decided by an **unauthenticated**
  probe and the plaintext fallback fired by default: one forged probe answer
  sent the agent token (full remote-execution authority) and the decrypted
  service secrets over HTTP. The fallback is now **opt-in** via
  `NINEDEPLOY_AGENT_ALLOW_CLEARTEXT=1`; `NINEDEPLOY_AGENT_REQUIRE_SEALED=1`
  remains the stricter alias and always wins.
- A sealed request now **requires** a sealed reply that verifies: plaintext
  responses and envelope failures are refused ("possible tampering").
- Sealed requests carry a fresh **nonce**; the agent echoes it inside the
  sealed reply and the core refuses mismatches — a captured envelope can no
  longer be replayed within the 5-minute seal window.
- Only an affirmative probe answer is cached.
- **Fleet upgrade note:** a node agent older than the nonce-echo change must
  be upgraded (agents and core ship the same binary); to temporarily keep a
  not-yet-upgraded fleet running, set `NINEDEPLOY_AGENT_ALLOW_CLEARTEXT=1`
  on the core and upgrade as soon as possible.

Tests: `agentClient.test.ts` (downgrade/refusal/nonce/replay cases), `agentApp.test.ts`.

## 3. RBAC and API-token scopes

- Fine-grained `nd://scope/{read,write,admin}/<resource>` tokens were stored
  but never enforced — any fine-grained token could use EVERY resource.
  `plugins/auth.ts` now classifies each request (method + route, with
  sub-resource overrides for `env`, `webhooks`, `deploys`, `volumes`,
  `insights`, `domains` under `/services/:id`) and requires a covering
  scope; unclassified paths fail closed for fine-grained tokens.
  `NINEDEPLOY_AGENT_REQUIRE_SEALED`-style coarse scopes (`read`, `write`,
  `operator`) keep their previous meaning.
- `viewer` is now actually read-only: service/project/label/database
  creation requires `member`; domain verification and repo-insight refresh
  require `member` on the service; webhook create/delete require `admin`
  (the webhook secret is a standing deploy credential).
- The `/v1/events` WebSocket applies the same operator narrowing as HTTP
  (a scope-restricted token of an operator no longer sees the global feed).
- Instance-wide branding `PATCH` requires the operator flag.
- **New API tokens default to `['read']` scopes and a 365-day lifetime**
  (previously: unrestricted, never-expiring). Legacy `[]` tokens keep their
  old unrestricted meaning. CLI `tokens.create({ name })` therefore yields a
  read-only token — pass explicit scopes for write/CI usage.

Tests: `plugins/auth.test.ts` (central narrowing + classification),
`rbacRegression.test.ts`, `events.test.ts`, `auth.test.ts`.

## 4. Sessions, SAML, lockout, CSP

- Refresh tokens carry a `gen` claim bound to the session row's expiry:
  rotation advances the row, so a replayed/stolen old refresh token is
  refused **before any DB write** and cannot slide the session. Pre-rotation
  tokens migrate on first refresh.
- SAML: assertion-ID replay cache (checked after signature + digest
  verification), response/assertion `Issuer` must equal the IdP entityID,
  `InResponseTo` refused (the panel never initiates SAML), and
  `Audience` / `Destination` / `Recipient` are enforced when the operator
  configures `spEntityId` / `spAcsUrl` on the provider.
- Login lockout is two-tier: 5 failures lock the **(account, IP) pair** (the
  guesser locks itself out; the real user is unaffected — the old
  per-account lock was a 15-minute DoS lever), and 25 failures across
  sources lock the account for distributed brute-force. Both land in the
  audit log.
- CSP `connect-src` drops the bare `ws:` / `wss:` grants; same-origin
  WebSockets remain covered by `'self'`.

Tests: `sessions.test.ts`, `sso.test.ts`, `loginLockout.test.ts`,
`securityHeaders` assertions in `app.test.ts`.

## 5. Installer, supply chain and exposure surface

- `pnpm install --frozen-lockfile` failure no longer falls back to a
  re-resolved install on a production host; opt in with
  `NINEDEPLOY_ALLOW_LOOSE_INSTALL=1` if you accept the supply-chain risk.
- The compose panel port binds **127.0.0.1** by default
  (`NINEDEPLOY_BIND` overrides); the generated public URL is localhost.
  Terminate TLS via Traefik and set `NINEDEPLOY_PUBLIC_URL`.
- The systemd unit adds `ProtectHome=read-only`. Optionally hand the
  install tree to root with `NINEDEPLOY_HARDEN_OWNERSHIP=1` (future
  updates then need `sudo`).
- Privileged third-party images are pinned: alpine helper sidecars →
  `alpine:3.21` (`lib/inventory.ts HELPER_IMAGE`), cloudflared → `2026.8.3`,
  Adminer → `6.0.1`, Redis Commander → digest
  `sha256:19cd0c49f418779fa2822a0496c5e6516d0c792effc39ed20089e6268477e40a`
  (the project publishes no version tags). Bump deliberately.
- The remote-node agent image reference was corrected from the
  non-existent `ghcr.io/ninedeploy/server:latest` to
  `ghcr.io/ninedeploy/ninedeploy:v<core version>` — provisioning previously
  always failed at pull time; the version match keeps node/core protocol
  (seal/nonce) in lockstep.
- The database Web Studio (Adminer / Redis Commander) publishes on
  **127.0.0.1** only. Redis Commander receives the database password via
  `REDIS_URL` (`REDIS_HOSTS` cannot carry one), so password-protected
  instances list keys instead of an empty tree. PgBouncer sidecars bind
  explicit host ports to loopback and authenticate with SCRAM-SHA-256
  (previously MD5).
- Exec error labels redact `--password=` / `-p` / `-a` values, keeping
  database passwords out of journald, the audit log and notifications.
- `resolveInRepo` refuses build paths that walk through symlinks (dangling
  included) and the generated `nixpacks.toml` escapes control characters —
  a repo-controlled manifest can no longer rewrite the file structure or
  write through an absolute symlink as root.

## 6. Functional races and honesty fixes

- Push webhooks sync `services.branch` immediately but leave `commitSha`
  to the deploy pipeline's success finalize — a failed build no longer
  reports a commit that never ran.
- Domain transfers: the pending-check filters on the clock (an expired
  transfer no longer blocks new ones forever) and acceptance claims the row
  conditionally before moving the domain (accept/accept and accept/cancel
  races resolved).
- Scheduled jobs hold a per-job lock: overlapping cron ticks or run-now
  double-clicks are skipped instead of running twice concurrently.
- Sandbox plugins persist `code`/`manifest` across restarts; a sandbox
  install without code is refused instead of registering an "active"
  plugin that executes nothing.
- The release workflow honors the `workflow_dispatch.tag` input in every
  step (checkout, validation, image tags, GHCR prune, GitHub Release) and
  smoke-checks the pushed multi-arch manifest before going green.
- `pnpm typecheck`, `pnpm lint` and the `r057` test were repaired to green;
  the untracked `deploys-r069` test (which tested a fictional function and
  contradicted the shipped queued-stacking design) was removed — the real
  behaviors are covered in `deploys.test.ts`.

## 7. Known accepted risks (documented, not fixed by design)

- ~~Member-reachable git-host API calls in `sources.ts` are a conditional
  SSRF surface (member-controlled hosts).~~ **Closed (r077):** every
  `sources.ts` route has been operator-only since the RBAC overhaul, all
  its provider hosts are hardcoded, and the outbound calls now run
  through `guardedFetch` like every other panel webhook/API client —
  pinned by a wiring test, so the hardcoded-host invariant cannot drift.
- Exec/spawn everywhere passes arguments as **argv** through
  `lib/exec.ts` / `lib/spawnValidated.ts` (never a shell). Static scanners
  report these as "command injection" sinks; the pattern is the audited
  choke point of this codebase.
- `lib/loginLockout.ts`, `lib/totpReplay.ts` and similar in-process state
  resets on restart — accepted for a single-node self-hosted panel.
- The database Web Studio still serves its own plain-HTTP UI (loopback +
  DB-level credentials). Proxying it through the panel origin (to remove
  the separate port entirely) is a design follow-up that needs live-docker
  validation.
- The web landing bundle was code-split: 1,009 kB → 125 kB raw
  (240 kB → 38 kB gzip).

## 8. Verification status

`pnpm typecheck` 11/11 · `pnpm lint` 8/8 · server 260 files / 3,913 tests ·
web 89 files / 1,479 tests · CLI 617 · mcp+sdk 212 — all green on the
remediated tree. A post-remediation Mimosa deep scan
(`scan-2026-09-09T06-23-32.811Z-b2660f48c9b1`, seal
`sha256:2dd830a6…`) re-raised none of the closed chains; its remaining
candidates were triaged 1:1 against existing runtime tests.
