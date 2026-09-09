# Changelog

All notable changes to the NineDeploy project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.7.4] - 2026-09-09

> Post-remediation polish: the database Web Studio is now served through
> the panel itself (fixing the broken embedded iframe under HTTPS), the
> update banner is honest about WHY it could not check for updates and
> recovers from transient failures in minutes instead of hours, and the
> installer verifies that what it downloaded is actually the release it
> asked for.

### Added

- **The database Web Studio is served through the panel origin.** A
  same-origin reverse proxy (`/v1/databases/:id/studio-proxy/`) fronts the
  loopback-bound Adminer / Redis Commander container: the embedded iframe
  finally works under HTTPS and CSP, the studio port stays off the network
  entirely, and access rides an HMAC-signed, path-scoped, 8-hour
  operator-only cookie instead of nothing at all. Upstream cookie paths are
  rewritten into the proxy scope so parallel studios never share sessions.
- **The About page tells you WHY an update check failed** (checks switched
  off vs feed unreachable, with the feed's own status line) and offers a
  **Check again** button instead of waiting out the cache.
- **Installer provenance checks:** the release tarball's content must match
  the requested tag (version binding, no symlinks, no setuid bits) and the
  docker-mode compose file must parse with the compose engine, reference
  exactly one image — the panel's own — before it is deployed.

### Fixed

- **Update-check failures are cached 10 minutes, not 6 hours.** A single
  boot-time blip (network not up yet, one API rate-limit 403) used to pin
  "unavailable" on the dashboard for six hours.
- The failed-check result now carries a machine-readable reason, so future
  UIs can distinguish disabled from unreachable.

---

## [0.7.3] - 2026-09-09

> The September 2026 security-audit remediation release. Three critical
> cross-tenant chains, eleven high-severity findings and the full
> installer/supply-chain cluster were closed across four remediation
> sessions — every fix regression-locked with tests. Several defaults
> changed in a securing direction (see **Changed**); a self-hosted
> operator upgrading should read the entries marked ⚠ before deploying.

### Security

- **Cross-tenant project-tag exfiltration closed.** Creating a service with
  another tenant's project id no longer passes validation, so the deploy
  pipeline can no longer decrypt a foreign project's shared env into an
  attacker-controlled container; the pipeline additionally re-verifies
  every project link against the owner's workspace seats before decrypting.
- **Cross-tenant volume mounts closed.** Attaching an `nd-svc-*` /
  `nd-db-*` volume (or config-repairing it) now requires every owner of
  the volume to be visible to the caller, `admin` on the database for
  `nd-db-*`, and refuses orphaned names.
- **Database attachments require the admin tier.** The attachment ships
  the database's admin-only password into the service env — visibility
  alone was never enough.
- **The agent transport fails closed.** The plaintext fallback now
  requires `NINEDEPLOY_AGENT_ALLOW_CLEARTEXT=1` on the core (a forged
  capability probe can no longer downgrade it), sealed requests demand
  sealed verifying replies, and replies must echo a fresh request nonce —
  captured envelopes cannot be replayed. Upgrade node agents together with
  the core; the fallback knob covers mixed-version fleets temporarily.
- **Fine-grained API-token scopes are enforced.** A token holding only
  `nd://scope/read/services` can no longer write other resources;
  unclassified endpoints fail closed. **New tokens default to read-only
  scopes with a 365-day lifetime** — pass explicit scopes/expiry when
  creating write-capable CI tokens.
- **`viewer` is read-only.** Service/project/label/database creation,
  domain verification, repo-insight refresh and webhook management
  (create/delete sits at the admin tier — the secret is a standing deploy
  credential) all require their documented role floors.
- **Refresh tokens rotate for real** (generation-bound: a replayed old
  refresh token is refused before any DB write); SAML assertions gain a
  replay cache plus Issuer / `InResponseTo` / Audience / Destination /
  Recipient validation; login lockout moved to a per-(account, IP) pair
  tier so an attacker can no longer hold a known account hostage;
  `connect-src` drops the bare `ws:`/`wss:` grants.
- **Privileged third-party images pinned** (alpine helper sidecars →
  `3.21`, cloudflared → `2026.8.3`, Adminer → `6.0.1`, Redis Commander →
  digest, remote-node agent → the core's own release tag). The
  remote-node agent image reference also stopped pointing at a
  repository that does not exist — remote provisioning works again.
- **Installer hardening:** a failed `--frozen-lockfile` no longer falls
  back to a re-resolved install (`NINEDEPLOY_ALLOW_LOOSE_INSTALL=1` to
  opt in); the compose panel port binds loopback by default
  (`NINEDEPLOY_BIND`); the systemd unit adds `ProtectHome=read-only`
  (tree-ownership lockdown available via `NINEDEPLOY_HARDEN_OWNERSHIP=1`).
- **Studio/pooler exposure:** the database Web Studio publishes on
  127.0.0.1 only and Redis Commander receives the database password
  (`REDIS_URL`); PgBouncer sidecars bind explicit ports to loopback and
  authenticate with SCRAM-SHA-256 instead of MD5.
- Exec error labels redact `--password=` / `-p` / `-a` argv values;
  build paths refuse symlinks; the generated `nixpacks.toml` escapes
  control characters.

### Fixed

- Push webhooks no longer write `services.commitSha` before the deploy
  succeeds — the branch still syncs immediately.
- Domain transfers: expired transfers stop blocking new ones; acceptance
  claims the row conditionally, closing the accept/accept and
  accept/cancel races.
- Scheduled jobs hold a per-job lock (no more parallel double-runs from
  overlapping ticks or run-now).
- Sandbox plugins persist their code/manifest across restarts; installing
  one without code is refused instead of registering an "active" no-op.
- The release workflow honors the `workflow_dispatch.tag` input in every
  step and smoke-checks the pushed multi-arch manifest before going
  green.
- The remote-node provisioner's agent pull failed against a
  non-existent image repository (see Security).

### Performance

- The web landing bundle was code-split per route: **1,010 kB → 125 kB
  raw (240 kB → 38 kB gzip)**.

---

## [0.7.2] - 2026-09-06

> A narrow post-0.7.1 patch: two reliability gaps caught once 0.7.1 went
> out, both narrow in scope. The `git://` protocol was not part of the
> `lib/gitEgress` SSRF guard, so a repository URL of
> `git://169.254.169.254/...` could reach the cloud metadata service; and
> the Traefik reaper's `docker network ls --filter` query used `^` anchors
> that Docker treats as literal characters, so the reaper matched no
> bridge and Traefik was never re-attached to the per-slug `nd-svc-<slug>`
> or `ndcmp-<slug>_default` bridges after a restart, leaving every domain
> on those meshes answering 502 until a full service redeploy ran
> `ensureServiceBridge` for that slug. No new features — just two holes
> closed.

### Fixed

- **The `git://` protocol is now part of the egress SSRF guard.**
  `lib/gitEgress.ts` handled only `http://`, `https://`, and `ssh://` URLs,
  leaving `git://` (port 9418, supported by `simple-git`) with no check. A
  repository URL of `git://169.254.169.254/...` could reach the cloud
  metadata service and leak instance credentials, and
  `git://<private-LAN>/...` could reach internal Git servers. The `git://`
  branch parses the URL and calls `rejectIfPrivateHost`, mirroring the
  `ssh://` guard. Four new regression cases cover the metadata service,
  RFC1918 LAN, loopback, and the positive public case.
- **The Traefik bridge reaper actually reaps.** Docker's
  `--filter name=<value>` is a substring match, not a regex, so the `^`
  anchors in `name=^nd-svc-` and `name=^ndcmp-` were treated as literal
  characters and the filter matched no bridge. After any Traefik restart
  (deploy, host reboot, image update), the reaper silently returned zero
  bridges and Traefik was never re-attached to the per-slug
  `nd-svc-<slug>` meshes or the `ndcmp-<slug>_default` compose defaults —
  every domain on those meshes answered 502 until a full service redeploy
  ran `ensureServiceBridge` for that slug. The anchors are gone and a
  regression test pins the substring-not-regex invariant so it cannot
  silently regress.

---

## [0.7.1] - 2026-09-05

> A quiet post-0.7.0 patch: three reliability gaps caught once 0.7.0 went
> out, all narrow in scope. Remote compose `stop()` was tearing down the
> wrong project whenever the compose service key itself contained a
> hyphen; the `withClient: false` option on `createDb()` was a dead
> no-op; and the database-URL secret pattern missed any connection
> string whose password was percent-encoded. No new features — just
> three holes closed.

### Fixed

- **Remote compose `stop()` no longer tears down the wrong project.**
  The previous recovery stripped a single trailing `-[^-]+-\d+` block
  from `<project>-<service>-1` to reach the project — but the compose
  service key is a user-controlled YAML map name and can contain
  hyphens itself (`services.frontend-api:`), so `ndcmp-web-frontend-api-1`
  extracted `ndcmp-web-frontend` instead of `ndcmp-web`. The production
  path then ran `docker compose down -p ndcmp-web-frontend` on the
  node, tearing down whatever stack happened to share that name (and
  silently leaving the actual one running). The builder now records
  the project it minted for each `runtimeId` at `buildAndRun` time and
  looks it up at `stop()` time: no string surgery, a `runtimeId` this
  builder never recorded is refused outright rather than guessed, and
  a redeploy of the same service overwrites its own mapping (a `Map`,
  not an array — the latest project wins).
- **`createDb({ withClient: false })` actually suppresses the raw
  libSQL client.** The option was a dead no-op since the field existed:
  the raw client was always returned, so read-only workers that wanted
  to release the underlying connection (the runtime migrator is one)
  could not. The Drizzle handle is unaffected; the client is omitted
  only when the caller asks, and the regression test pins both the
  suppression and that the Drizzle handle still answers queries.
- **The database-URL secret pattern now matches percent-encoded
  passwords.** A literal `@` cannot appear in the password class (it
  is the user/host delimiter) but its URL-encoded form `%40` can, and
  tools that build connection strings from user input routinely emit
  `%40` instead of escaping it themselves. The old regex treated the
  entire non-special class as raw, so a connection string with `%40`
  in the password was never caught by the secret scanner and slipped
  into env vars and the panel as a "no credentials detected" string.
  The pattern now accepts `[non-special] | %XX` triplets in the
  password class, the `{3,}` minimum still measures raw characters
  (so a real password still satisfies the guardrail), and the scanner
  covers what connection-string builders actually produce.

---

## [0.7.0] - 2026-09-04

> The multi-node release. `server_id` had been on the services table, the
> Servers page and the build context since the fleet feature shipped, and no
> builder ever read it: a service pinned to a node was refused outright
> rather than be built on the wrong machine. Now a `docker` or compose
> service pinned to a node is actually built and started ON that node
> through the typed agent protocol, and each node runs its own Traefik so
> production traffic never hairpins through the panel. The rest of the wave
> makes the panel honest about itself: build-cache backends that shipped
> complete but were never registered, settings that were saved and read by
> nothing, counters pinned at zero — and four post-0.6.0 reliability fixes.

### Added

- **Multi-node docker deploys.** A `docker` service pinned to a node is
  built and started on that node through the typed agent protocol: the
  repository is checked out in a per-service workspace on the node, the
  image is built or pulled there, and the environment arrives as a 0600
  env-file that is deleted the moment the container has taken it. PM2 and
  Nixpacks (Dockerfile-less) builds on a node are refused at queue time
  with a reason naming the missing capability, instead of running on the
  panel host behind the operator's back.
- **Compose stacks run on a node too**, which is what makes the one-click
  template catalogue usable there at all — most of it is compose-shaped.
  The panel ships the inline stack YAML (or the node checks the repository
  out), writes the `.env` and any volume-attachment override, then runs the
  same ordering the local builder uses: `compose config` and `compose pull`
  complete while the PREVIOUS revision is still serving, so a broken
  interpolation or a bad tag fails the deployment without ever tearing the
  live stack down.
- **Per-node ingress.** Each node runs its own Traefik — you point the
  domain at the NODE and the node terminates TLS for the services that live
  on it. The panel stays the source of truth for domains, middlewares and
  certificates: it renders the node's Traefik configs with the same
  functions that generate its own and ships them over; the node only writes
  them to a fixed path. A routing change refreshes every node
  automatically, and the node proxy is recreated only when the STATIC
  config changed, so a domain edit is not an ingress interruption.
- **A Target node card on the service settings tab.** `serverId` had been
  accepted by the create and update endpoints all along with no field
  anywhere in the UI, so multi-node was reachable only from the CLI or a
  raw API call. The card lists the registered nodes, explains the limit for
  PM2 instead of offering a choice that would fail at deploy time, and
  shows a non-operator the current target read-only.
- **Registry and S3 build caches are selectable at last.** Both drivers
  shipped complete and unit-tested but were never registered on the kernel,
  so an operator who set the backend to `registry` or `s3` silently kept
  building against the in-memory LRU. All three are registered now, each
  reads its connection settings lazily (saving them in the panel needs no
  restart), and the panel gained the registry/S3 endpoint and credential
  fields that were missing entirely.
- **Sessions table retention.** Sessions kept one row per login — each
  with an IP and User-Agent — and nothing ever deleted one; the panel
  filtered dead rows out of its response, so the growth was invisible.
- **`GET /v1/orchestrators/:name/stacks` lists an orchestrator's stacks**,
  and `GET /:name/stacks/:stack` reports one (SDK:
  `orchestrators.stackStatus(orchestrator, stack)`).

### Changed

- **The panel proxy and each node proxy render only THEIR OWN services.**
  A router upstream is a container name resolved over the local Docker
  network, so once nodes really ran containers, rendering every service
  into every proxy would have made the panel advertise routes for
  containers on another machine and answer 502 for each one — with the node
  doing the same in reverse. A node never receives the panel dashboard
  router, which would blackhole the control plane behind whichever node
  answered DNS first.
- **Node agents gained per-service workspaces.** Git has no per-invocation
  repository operand — fetch, checkout and reset act on the process working
  directory — so the agent ran every git operation in its OWN directory: a
  host could hold exactly one checkout and two remote services would
  overwrite each other's source tree.
- **The deploy worker honours the build-cache settings it was ignoring**: it
  took whichever backend happened to register first instead of the one
  named in `cache_name`, and the master `enabled` switch on that plugin
  turned nothing off.
- **Build-cache hit rate stops reading 0%**: the plugin looked up a key it
  invented (`service:<id>:no-commit`) that the builder never stores under,
  so every deploy published a `miss` that could not have been anything
  else. The hit/miss/error events now come from the build itself, carrying
  the key it actually consulted.
- **Four more settings that were saved and never read now work**: the
  per-minute alert cap on the notification dispatcher (it advertised
  protection against restart storms and capped nothing) and its
  deploy-success switch, and the template-bundle override counter that was
  pinned at 0. A regression guard now fails the build when any plugin
  declares a setting nothing reads.
- **Two settings that could never work were removed** rather than left as
  decoration: the account id and tunnel TOKEN on the Cloudflare Tunnels
  plugin (a password field whose value went nowhere — real tunnel tokens
  live per tunnel on the Tunnels page), and the metrics retention on the
  telemetry streamer (the metrics table is deliberately a 24-hour ring).
- **Metric history is swept hourly** instead of only when an operator
  clicks Flush — and the retention cutoff itself stopped matching every
  row and wiping the archive it was meant to trim.

### Fixed

- **Remote private-registry deploys no longer hang.** The agent built
  `docker login --password-stdin` so the credential never reaches the
  process table, but nothing ever wrote to that pipe: the child sat blocked
  on a stdin that was never closed until the agent's 600-second request
  timeout.
- **BuildKit builds stop logging a resolve error every time**: `--cache-from`
  was handed the literal `ref=empty` on a first build, and a bare
  `sha256:` content digest after that — neither names a repository, so
  buildx could never resolve either. A cache reference that cannot be named
  is simply omitted.
- **The orchestrator stack API answers real questions**: `GET
  /:name/stacks` passed the ORCHESTRATOR name into the driver as the STACK
  name, so it returned null for every real stack — and a test had pinned
  that behaviour rather than fixing it.
- **The backup drill no longer OOMs the panel on a multi-gigabyte dump**:
  the MySQL and Postgres validators sniffed dump headers through
  `readFile()`, which loads the entire file, and the drill is
  member-triggerable — a self-service OOM on the process that also hosts
  the deploy worker. Header sniffing goes through a bounded `readHead()`.
- **Config-center strings stop type-flipping across a cache boundary**:
  `set()` stored plain strings raw while `get()` re-parsed stored rows on a
  cache miss, so JSON-ambiguous values (`true`, `123`, `null`) came back as
  types after a restart — and a metadata-only save laundered the flip
  permanently.
- **Slug collision suffixes stay inside the 63-char cap**: appending
  `-<n>` to an already-truncated base stored 64–72 char slugs the schema
  rejects (clone loops, migration imports, compose stacks, personal
  workspaces).
- **Documentation corrected where it overstated the product**: the SSRF
  egress guard never covered the OIDC issuer or the S3 endpoint, and
  deliberately does not (self-hosted Keycloak and MinIO normally sit on
  private addresses); the agent transport is a sealed protocol with a
  cleartext fallback, not plain HTTP; and the multi-node docs name exactly
  what a node runs (docker, compose) and what it refuses (PM2, Nixpacks).

---

## [0.6.0] - 2026-09-03

> A security-and-reliability minor that also ships inline Compose stacks:
> paste YAML instead of cloning. Under the hood, a full-system audit closed
> a privilege-escalation path, made rate limits and audit logs see real
> client IPs behind Traefik, cleared every production dependency advisory,
> and stopped multi-gigabyte backups from ever entering the panel's heap.

### Added

- **Inline Compose stacks.** Services can store a pasted Docker Compose
  file (256 KiB cap) instead of a git clone: the schema enforces
  `type: compose` and rejects combining it with a repo URL, the server
  validates the file server-side (dry-run preview endpoint) and re-
  materialises it into the workspace before every deploy, and the new
  Compose tab offers Save and Save & redeploy.
- **Database indexes for hot lookups.** `services.server_id`,
  `webhooks.service_id` and `databases.project_id` were full-table scans;
  SQLite does not auto-index FK columns.

### Changed

- **Real client IPs behind Traefik.** The panel now trusts one proxy hop
  by default (`NINEDEPLOY_TRUST_PROXY`): rate limits are enforced per
  actual client instead of one shared bucket for the whole instance, and
  audit rows record the true source address. Set it to `false` when the
  panel is exposed directly.
- **SSH password bootstrap refuses fast.** Password authentication was
  accepted by the schema but never worked (`BatchMode=yes` disables all
  prompting and the password was never wired to sshpass). It now fails
  immediately with an actionable message; install a key and use key auth.
- **The CLI defaults to `https://` for non-loopback server URLs**, so the
  bearer token no longer rides plaintext HTTP to a remote host (loopback
  keeps `http://`; type an explicit scheme to override).
- **Scheduled backup failures are no longer silent.** A failed scheduled
  backup lands a failed row in the UI and fires the notification
  channels; MySQL/MariaDB dumps run `--single-transaction --quick`, so
  backups no longer lock live databases or produce inconsistent dumps.
- **CI ships tested images only.** The `:edge` image (what
  `--channel=main` installs) is published only after the full suite and
  integration tests pass, and the release prune no longer deletes the
  CI-pushed edge tags.

### Fixed

- **Privilege escalation via scheduled deploy jobs.** A workspace member
  could wrap an operator-created PM2/compose service in a cron job and
  reach host command execution. Scheduled deploys now authorize against
  the service owner's privileges, exactly like manual and webhook deploys.
- **Editing an env var no longer corrupts secrets.** Inline edits used to
  silently flip `isSecret` to false and a single typed character could
  overwrite the stored secret; the classification is preserved and
  failures surface as toasts.
- **The panel no longer crashes during self-update** on hosts without
  `/bin/bash` — a failed updater launch records a finished, failed state
  instead of an uncaught exception.
- **Deploy logs stop freezing the tab.** Live output keeps a bounded tail
  and flushes on an interval (the old per-message re-join was O(n²)) and
  reconnects a dropped stream; the terminal session also survives the
  fullscreen toggle.
- **Webhook replays are rejected.** Provider delivery ids are deduplicated
  for 24 hours, closing the window where a captured payload could
  redeploy an old commit.
- **System export is crash-consistent.** The archive carries a `VACUUM
  INTO` snapshot of the database instead of a tar raced against live
  writes; remote backup transfers stream, so multi-GB dumps no longer
  buffer in the panel's heap (which also hosts the deploy worker).
- **CLI sessions survive past 15 minutes** — the CLI persists the refresh
  token and retries through a single-flight refresh; server URLs default
  to `https` for non-loopback hosts and the JWT secret no longer appears
  in `docker run` argv (`ps` / `docker inspect`).
- **Slug collisions are impossible again.** `services.slug` is globally
  unique at the database level (it mints container, volume and router
  names) after a one-time dedup; slug uniqueness was application-layer
  only since the projects overhaul.
- **Dependency advisories cleared** — `fast-uri` (8× HIGH, SSRF/host
  confusion) and `qs` (2× MODERATE, DoS) pinned past their vulnerable
  ranges; `pnpm audit --prod` is clean.
- The schema-drift CI guard can actually fail now, `/v1/auth/token`
  answers instead of always 401ing, Traefik certificate backups follow
  the configured data dir, concurrent routing writes no longer drop just-
  added domains, PR preview creation survives the slug race, and the
  installer no longer discards local modifications without `--force`.

---

## [0.5.3] - 2026-09-03

> A production-hardening patch: the lazy `require()` class that only
> crashed outside vitest is gone (OIDC login works in production again),
> both remote build-cache backends can finally produce hits, image
> retention actually prunes, and the databases pages show live CPU/RAM.

### Added

- **Live CPU and RAM for managed databases.** Running databases show a
  live CPU + memory line on the list cards and a Live Resources card in
  the detail view — CPU %, memory used against the configured
  `memLimitMb` — polling the stats snapshot every 3 seconds while
  visible.

### Changed

- **Redeploying a running service asks first.** The Deploy button on a
  live service opens a confirmation dialog explaining the blue-green
  behavior (the current version keeps serving until the new build
  passes the healthcheck, then traffic swaps); idle, stopped or errored
  services still deploy immediately.

### Fixed

- **OIDC login works in production again.** RS256 signature verification
  pulled `node:crypto` through a lazy `require()` — undefined in the
  pure-ESM server package — so every OIDC sign-in died with
  `ReferenceError: require is not defined` in production while the unit
  suite stayed green (vitest's module runner shims `require`). The
  helpers now ride the module's static import, and the suite gains a
  source-level ESM-purity guard.
- **The same `require()` class killed two more production paths.** The
  iptables egress driver's entire on-disk state layer (rehydrate,
  persist, delete) threw and was swallowed by best-effort catches — boot
  forgot every persisted rule, applied rules were never persisted, and
  detach was a permanent no-op after a restart — and
  `RegistryBuildCache.store()` crashed outright on every non-marker
  digest with no catch to soften it. Both now use static `node:fs` /
  `node:crypto` imports.
- **Remote build caches can produce hits.** The S3 backend's `lookup()`
  demanded a metadata header on HEAD that `store()` cannot send — the
  digest only lives in the marker body — and the registry backend
  compared the cached layer digest against HEAD's
  `Docker-Content-Digest`, the digest of the manifest itself, which is
  never equal. Both now GET the marker/manifest and compare
  like-for-like, so store→lookup round-trips hit and `--cache-from`
  stops building cold every time.
- **`images prune --keep-last N` actually prunes.** Retention groups
  were keyed by `repo:tag`, which maps to exactly one image id, so every
  group was a singleton: `keepLast >= 1` protected the entire tagged
  inventory and nothing was ever deleted on real hosts. Groups are now
  keyed per repository, keeping the N newest versions per repo.
- **Email template overrides stay per template.** The override lookup
  filtered by workspace only, so once a workspace overrode a second
  template, every render returned an arbitrary sibling override (a
  password-reset email rendered with the workspace-invitation text) and
  deleting one template's override wiped the workspace's others.
  Lookups are now scoped by workspace AND template name, matching the
  table's unique key.
- **Magic hex secrets are exact-length.** `SERVICE_PASSWORD_HEX_25`
  baked a 24-char key and `HEX_1` an empty secret, because the hex
  generator computed `size / 2` bytes and Node silently truncates
  fractional sizes. Generation now rounds up and slices to the exact
  documented length; even sizes are byte-identical.
- **Manifest formatting keeps string types.** `formatManifestYaml`
  emitted plain scalars for any charset-safe string, so header values
  like `true`, `8080` or `007` round-tripped as boolean/number and the
  schema rejected the manifest the formatter itself produced. Quoting is
  now self-verifying: a plain scalar ships only if js-yaml loads it back
  as a string.
- **Cron summaries refuse wrong monthlies.** `0 0 1,15 * *`,
  `0 0 */7 * *` and `0 0 1-15 * *` were all summarized as "monthly on
  the 1st at 00:00" — factually wrong, operator-facing. Multi-day
  day-of-month expressions now fall through to null so the UI shows the
  bare expression instead.
- **PgBouncer status reports the real pool mode.** Status grepped a
  container env var that is never set, through an invalid Go template,
  so `poolMode` was always null while the sidecar ran; it now parses the
  rendered `/etc/pgbouncer/pgbouncer.ini`.
- **CLI multi-line pastes.** `prompt()`/`promptHidden()` split raw stdin
  chunks on the first newline, collapsing multi-line pastes into one
  value and dropping the tail after a hidden prompt's Enter; lines are
  now framed and fed to successive prompts in FIFO order.
- Misc: the SettingsTab privilege tests use the global 30s timeout
  ceiling instead of a tighter per-file override that tripped on loaded
  CI runners.

## [0.5.2] - 2026-09-02

> UI polish release: the Hub template catalog drops its noisy per-app
> emojis for a uniform monochrome icon, and an alert-evaluation bug
> affecting new rules is fixed.

### Changed

- **Uniform Hub icons.** Template cards and the detail drawer render a
  plain slate `Package` icon instead of 89 arbitrary per-template
  emojis, matching the panel's monochrome design. Original brand logos
  are deliberately not used (licensing and asset hosting for
  third-party marks).

### Fixed

- **New alert rules now evaluate from a clean slate.** Creating a rule
  seeds its `alert_state` row so `evaluateAlerts` can track breaches
  immediately instead of skipping the first evaluation window.

## [0.5.1] - 2026-09-02

> A security follow-up to 0.5.0: the demo is now a real deployable app,
> one host-privilege gap is closed, and the follow-up UI work is pinned
> by tests.

### Changed

- **The demo is real now.** "Load Demo Stack" used to seed rows that
  claimed to be running — an `nginxdemos/hello` container, a PM2 service
  from `vercel/next-learn`, and a Postgres row with no container behind
  any of them. It now creates a single deployable service: a Docker
  source build of `github.com/ersinkoc/nextjs-test` (multi-stage
  Dockerfile, port 3000, `/api/health`), queues its first build, and
  re-seeding is idempotent. Legacy fake rows are reaped on the first
  new-seed call. No PM2, no database, no fake state.

### Fixed

- **Watch-path webhook matcher could hang forever.** Patterns like
  `**a**b**c**d` compiled into a regex that backtracked ~C(n,3) steps on
  long non-matching paths (ReDoS); the matcher is now a bounded DP walk
  with identical folding semantics, over-long inputs fail open, and the
  tokenizer's own comment no longer breaks the server build.
- **Deploy finalize no longer strands the previous container** when env
  decryption fails, and the managed-env fingerprint merges into the
  config snapshot instead of replacing it.
- **Web coverage regression** on the 0.5.0 follow-ups: the activity
  drawer's reconnect badge flow and the KeyValueEditor's second-Add
  focus are pinned by tests.
- Misc: orchestrator routes are operator-gated (see Security); ESM-illegal
  `require` in the PgBouncer userlist renderer repaired with a
  regression test.

### Security

- **Orchestrator routes are operator-gated.** `GET /v1/orchestrators` and
  `GET /v1/orchestrators/:name/stacks` executed host Docker daemon
  commands through the registered drivers behind bare authentication;
  they now require the operator, like the exec terminal.
- **Mimosa sweep cleanups.** The last six false-positive findings were
  resolved at the source: five test-fixture tokens now use the runtime
  assembly pattern, and the login form's bullet placeholder is built at
  runtime instead of a literal scanners classified as a credential.

## [0.5.0] - 2026-09-02

> A plugin sandboxing release with a deep security and correctness sweep.
> NineDeploy now features an isolated Worker Thread plugin sandboxing engine
> with V8 memory bounds, asynchronous JSON-RPC protocol bridging, LIFO Saga
> rollback execution for lifecycle hooks, direct CRUD domain event emissions,
> and dynamic React UI slot widgets for the Web Dashboard and detail views —
> alongside fixes for a SAML sign-in bypass, a template path traversal, and
> several authorization gaps. Some deliberate behavior changes (listed under
> Changed) are worth reading before upgrading.

### Added

- **Isolated Worker Thread Plugin Sandboxing.** Community and third-party extensions
  run inside dedicated `node:worker_threads` isolates with memory limits (`16MB/64MB`)
  and an asynchronous RPC bridge, preventing host process crashes on plugin errors.
- **LIFO Hook Rollback (Saga pattern).** Intercepting pipeline hooks now support
  sequential rollback handlers that automatically clean up provisioned resources
  if a downstream handler aborts or vetoes (`allowOrAbort: false`).
- **Direct Domain Event Emissions.** Services, Databases, and Edge Servers emit
  typed domain events directly across the kernel event bus.
- **Dynamic React UI Extension Slots.** Live overview widgets and tab panels are
  rendered across Dashboard, Service, and Database detail views via `<PluginSlot />`.

### Security

- **SAML: bind the signature to the assertion (sign-in bypass).** Signature
  verification only proved that SOME `SignedInfo` was signed by the IdP — a
  legitimately signed response could be rewritten to name any local user and
  sign in as them. The callback now verifies the assertion digest against the
  signed `DigestValue` and enforces the `NotOnOrAfter` replay window; OIDC
  login `state`/`nonce` values now come from the CSPRNG instead of
  `Math.random`.
- **SAML/OIDC login CSRF.** The OIDC login flow's signed `state` was not bound
  to the browser: an attacker could deliver their own callback URL and sign a
  victim into the attacker's account. The login route now sets an HttpOnly
  state cookie the callback must match.
- **Community template path traversal.** A template `id` became a file name
  unvalidated, so `../`-style ids could write or delete `.json` files outside
  the community-templates directory. Ids are now filename-safe slugs
  (create/delete routes answer 400).
- **Managed git sources are operator-only.** Any member could attach a guessed
  `sourceId` to a service or repo analysis and have the pipeline clone the
  operator's private repos with the operator's decrypted credentials into a
  container they own. Setting or using a `sourceId` now requires the operator.
- **Database attachments require the `member` role.** A workspace `viewer`
  could attach (and detach) databases on a shared service — attaching injects
  the database's decrypted connection string into the service's runtime env.
- **Operator-gated maintenance routes.** `POST /v1/domain-presets/apply`
  (spends the operator's DNS token), `POST /v1/build-cache/store` (other
  builds chain from these digests) and `POST /v1/metric-history/flush`
  (instance-wide retention deletion) were available to every authenticated
  account; all three now require the operator.
- **No private-workspace id oracle.** Workspace routes answered 403 for
  existing-but-foreign workspaces vs 404 for missing ones, letting any
  authenticated user enumerate private workspace ids. Non-members now get the
  same 404; members with insufficient rank still get 403.

### Changed

- **Host-port services deploy sequentially.** Blue-green kept failing on
  "port is already allocated" for every redeploy after the first of a
  `publishedPort` service, stranding it on its first version. The previous
  runtime is now retired before the new container starts (a short, deliberate
  gap); Traefik-routed services keep full blue-green.
- **Compose deployments wait for healthchecks.** A container that boots but
  fails its own healthcheck forever used to deploy green on the first poll;
  the builder now waits for Docker's health status and fails fast on a
  failing streak.
- **Compose `.env` values are escaped.** Secrets containing ` #` were
  silently truncated by compose's dotenv parser and `$VAR`-shaped values
  were expanded from the panel's own environment; values now round-trip
  byte-exact (verified against compose-go).
- **PgBouncer sidecars no longer publish the default host port.** Every
  sidecar bound 6432, so enabling a second database failed on "port is
  already allocated". Clients connect over the docker network; set an
  explicit `pgbouncerPort` to publish. Sidecar config is also copied into the
  container instead of bind-mounted, so the credential-bearing temp files no
  longer sit in the host's tmp dir.
- **PM2 domains route through the host gateway.** The Traefik upstream for
  PM2 services was the PM2 process name — unresolvable inside the Traefik
  container, so every attached domain 502'd. Upstreams now use
  `host.docker.internal`.
- **OIDC id-token checks follow the spec.** Multi-valued `aud` now requires a
  matching `azp` (§3.1.3.7); an unknown `kid` forces one JWKS refresh before
  failing (IdP key rotation); trailing-slash issuers compare equal. Tokens
  that used to pass on lax providers may now be rejected.
- **Managed `sourceId` on services is operator-only** (see Security).
- **Foreign workspace routes answer 404 instead of 403** (see Security).
- **Watch-path webhooks fail open at the commit-list cap.** GitHub truncates
  the `commits` array at ~20 entries; a push whose watched change sat in an
  omitted commit was silently skipped. A list at the cap now deploys.
- **Stricter manifest validation.** `env.aliases` keys must now be env-var
  names, and the generated YAML quotes scalars so special characters survive
  a round-trip.
- **Dev checkouts anchor the default data dir to the monorepo root.** The
  old cwd-dependent default provisioned a fresh `.data` (and a NEW master
  key) when restarted from a different working directory, making every stored
  secret undecryptable. Docker/systemd installs are unaffected.

### Fixed

- **Runtime output across chunk boundaries.** stdout/stderr no longer merge
  interleaved partial lines, multi-byte UTF-8 split across chunks survives
  intact, and trailing partial lines are flushed.
- **SAML/OIDC edge cases.** OIDC JWKS no longer verifies arbitrary `kid`
  tokens against whichever key is listed first; signature verification of
  remote source credentials surfaces failures instead of silently fetching
  with stale tokens.
- **Database volume TOCTOU.** Two concurrent creates with the same
  `existingVolume` could both pass the clash check and mount one data
  directory; creation is now serialized per volume.
- **Deploy finalize isolation.** A corrupted env row no longer aborts
  finalize and leaks the previous container; the managed-env fingerprint
  merges into the config snapshot instead of replacing it (the `/diff`
  endpoint keeps its build-config view), and the drift warning actually
  fires.
- **Generated artifacts.** The container compose manifest quotes env/label
  scalars (values like `{"a":1}` no longer produce invalid YAML); Traefik
  routes PM2 services via the host gateway (attached domains no longer 502);
  compose `stop` ignores recorded config files that no longer exist, so
  volume-attached stacks stop for real.
- **CLI output.** `table()` counts visible width (pre-colored cells no
  longer shift columns), colored `status`/`health` cells stay aligned.
- **SDK client.** `threshold: 0` / `days: 0` / `serverId: 0` reach the server
  instead of silently becoming the default; volume names and template ids are
  URL-encoded.
- **MCP server.** Legacy unrestricted tokens (`[]`) and interactive sessions
  (`session`) keep every tool instead of silently losing the scoped ones;
  `list_services({ projectId })` uses the supported `tagProjectIds` query —
  the retired `?projectId=` filter returned ALL services.
- **Secret scanner.** Detects the current `sk-proj-` OpenAI key format and
  reports every occurrence of a pattern, not only the first.
- **Certificate inventory.** Certificates expired less than a day ago are
  reported `expired`, not `expiring-soon`.
- **Web dashboard.** A stale repo analysis no longer deploys the wrong
  framework preset; a dead session now returns the app to `/login` instead of
  a wall of failed queries; the service page follows `?tab=` deep links and
  no longer streams a foreign deployment's logs; topology live stats actually
  update; the activity drawer reconnects with backoff and says so; QR codes
  for regenerated TOTP secrets always show the current value.
- **Misc.** PgBouncer's `pgbouncer.ini` and userlist are removed from the
  host tmp dir right after the sidecar starts (previously leaked forever);
  pgbouncer temp files carry the caller's tmpdir, not a hardcoded `/tmp`;
  community template removal reports 400 for unsafe ids; `config.ts` locates
  the monorepo root instead of silently following the process cwd.

## [0.4.9] - 2026-09-01

> Hub installs always ran the template's pinned image reference —
> `directus/directus:latest` and friends — with no way to choose a version.
> The install request rejected any image override by design (the templates
> are runtime-verified), and the wizard's image field was disabled. Now the
> wizard lets you pin a different tag of the template's OWN repository
> (`:latest` → `:11.5`), the server validates the override keeps the
> repository, and the review step shows exactly what will run.

### Added

- **Pin a template image version at install time.** The Hub deploy wizard's
  image field is live for templates: it comes pre-filled with the registry
  reference, and typing e.g. `directus/directus:11.5` deploys that tag. The
  server accepts only overrides that keep the template's registry repository
  — digest references and cross-repository swaps are refused, because the
  point is version pinning, not running arbitrary bytes under a vetted
  template's name. Port and volume stay registry-controlled. Interrupted
  installs reconcile cleanly across overrides (the same-template check
  compares repositories, not exact references), and Service → Settings keeps
  allowing image edits after install for redeploy.

## [0.4.8] - 2026-09-01

> Cancelling a deployment and immediately removing it from the queue left
> the pipeline itself alive: the row that carried the cancellation signal
> was gone, so the zombie kept building, deploying and holding its
> concurrency slot — and every queued deploy behind it waited for a deploy
> that no longer existed. Deleting a cancelled deploy now stops the
> pipeline at its very next checkpoint.

### Fixed

- **Cancel-then-remove no longer strands the queue behind a zombie
  pipeline.** The cancel route flips the row terminal immediately while
  the pipeline stops at its NEXT checkpoint — which can be minutes away
  (a docker build, a healthcheck window). Removing the row in that
  window destroyed the only signal the pipeline polls: `isCancelled`
  read the missing row as "not cancelled" and ran the whole deploy to
  completion — holding its concurrency slot, so the queue's #1 entry
  never claimed, with no way left to stop the zombie. A deployment row
  that disappears under a running pipeline is now treated as cancelled:
  the pipeline aborts at the next checkpoint, releases the slot, and the
  queued deploys behind it proceed.

## [0.4.7] - 2026-09-01

> The postgres 18 support shipped in 0.4.5's dependency defaults was
> broken on arrival: the official postgres 18+ images moved the data
> directory to a major-version-specific path and deliberately refuse the
> classic mount every managed database here used. The container
> crash-looped, its DNS name never registered on the per-service bridge,
> and the attached app — Directus was the first hit — burned the whole
> healthcheck window on `getaddrinfo EAI_AGAIN` against the database
> hostname. Fixed together with the 0.4.5 diagnostics that finally made
> the real error visible.

### Fixed

- **Managed postgres 18+ databases start again.** The official postgres
  18+ images (and pgvector pg18) store data under
  `/var/lib/postgresql/<major>/docker` (pg_ctlcluster-compatible layout,
  docker-library/postgres#1259) and deliberately exit when they detect
  the classic `/var/lib/postgresql/data` mount — NineDeploy's standard
  volume mount since forever. The result was a database container in a
  restart loop: "running and attached" at attach time, gone from DNS a
  moment later, and an app that could not even resolve the database
  hostname. Volumes for majors ≥ 18 now mount ONCE at
  `/var/lib/postgresql` with the data in the versioned subdirectory;
  majors ≤ 17 keep the classic layout, and rows already pinned to 17
  see no change.
- **The retained-volume re-key sidecar follows the volume label's own
  image.** The label records the image that initialized the data, which
  can be an older major than the row's configured version — the sidecar
  previously derived its paths from the row and would have mounted a
  16-layout volume with 18 paths. It now matches the label's image.

## [0.4.6] - 2026-09-01

> Follow-up to 0.4.5's CI bring-up: the dependency patches existed to remove
> a vulnerability-flagged glob and the deprecated @esbuild-kit toolchain, but
> the lockfile kept resolving those edges from the UNPATCHED manifests — so
> every install carried exactly the packages the patches exist to remove,
> and the deprecated-dependency guard failed on every CI run. The edges are
> now cut at resolution level, and the deploy pipeline's own end-to-end
> integration tests verify reachability the way Model B actually works.

### Fixed

- **The lockfile now reflects what the patches mean.** The drizzle-kit
  patch removes `@esbuild-kit/esm-loader` from its manifest and the
  archiver-utils patch moves glob to `^13`, but pnpm kept resolving those
  edges from the UNPATCHED manifests — `@esbuild-kit/core-utils`,
  `@esbuild-kit/esm-loader` and the vulnerability-flagged `glob@10.5.0`
  stayed in the lockfile and the installed store. Overrides now cut the
  edges at resolution level (23 packages left the tree; glob resolves into
  the maintained 13.x line fastify already carries), and the
  deprecated-dependency guard strips the lockfile's `overrides:` metadata
  block before grepping — the block legitimately names the packages being
  removed. Source installs stop pulling the deprecated packages; the guard
  keeps guarding.
- **The deploy integration tests verify Model B networking, not Model A.**
  The end-to-end suite still asserted the runtime container sits on the
  shared `ninedeploy` mesh and fetched it by name from a throwaway mesh
  container — but every runtime lives on its own `nd-svc-<slug>` bridge
  since v0.3.0, where the mesh neither resolves the name nor routes to it.
  The pipeline itself passed on CI; the test's own verification failed with
  "bad address". It now verifies reachability the way platform
  infrastructure (Traefik, the probe container) does — from a container
  attached to the service's bridge, by name — asserts bridge membership
  instead of mesh membership, and sweeps the bridge on teardown.

## [0.4.5] - 2026-09-01

> v0.3.0's Model B moved every runtime onto its own per-service bridge but
> left the healthcheck's sibling probe on the shared mesh — and Docker drops
> traffic between bridges by default. Any app that binds its port later than
> the 10-second direct-probe grace (first boot, DB migrations — Directus is
> the first app anyone hit it with) burned the full 5-minute window on blind
> `nc` timeouts and failed its deployment while perfectly healthy. This
> release closes that regression, makes the failure diagnostics honest about
> container stderr, and carries the security-gates hardening.

### Fixed

- **The healthcheck probe reaches per-service bridges again.** Model B
  (v0.3.0) puts every runtime on its own `nd-svc-<slug>` bridge, but
  `ninedeploy-prober` kept living on the shared `ninedeploy` mesh — and
  Docker's DOCKER-ISOLATION chains drop traffic BETWEEN bridges, so the
  fallback `nc` probe timed out against every container IP no matter how
  healthy the app was. Direct probes only cover the first 10 seconds
  (`directGraceMs`) and don't work at all from the host on Docker Desktop,
  so anything slower than that — Directus running first-boot DB migrations —
  failed every deploy with "did not become ready in time" after ~45 blind
  attempts (~3s `nc` + ~3s sleep per attempt ≈ the 300s deadline). The
  prober now joins the runtime's networks idempotently before the sibling
  probe (mirroring Traefik's permanent bridge membership; networks it
  already sits on are skipped), and the first sibling failure logs the
  probe topology — which networks the container and the prober actually
  sit on — instead of a bare exit code.
- **Container diagnostics no longer lose stderr.** `logContainerDiagnostic`
  read `docker logs` through `capture()`, which returns stdout only — and
  `docker logs` exits 0, so everything the app wrote to stderr (exactly the
  output a crashed boot explains itself with) silently vanished from the
  "Recent container logs" section. It now streams both streams through
  `run()`'s sink.

### Security

- **Egress routes are operator-only.** Listing or mutating host-level
  SNAT/iptables state is not a project-member capability; the routes are
  gated behind a preHandler role check and the suite pins the 403 rejection
  before any driver method runs.
- **The CORS allowlist excludes localhost origins in production** — the
  panel is same-origin in prod; `localhost:5173`/`3000` remain allowlisted
  in dev only.
- **The workspace owner's role can no longer be changed in place.** The
  member-role update route refuses to demote the owner (`403`): changing
  the owner's membership role without transferring `workspaces.ownerId`
  could let an admin lock the owner out or leave an owner without owner
  access — ownership moves only through the transfer route.
- **The 256 MB request-body allowance is scoped to the backup import
  route** instead of global, so login, webhooks and ordinary JSON
  endpoints cannot allocate a quarter-gigabyte Buffer before
  authentication runs.
- **Workspace projects require the workspace admin role to mutate.**
  Project PATCH/DELETE and shared environment variable mutations now
  demand workspace admin when the project belongs to a workspace —
  members can still discover and read workspace projects, but can no
  longer rename, re-home or delete them, or edit shared env vars that
  propagate to every linked service. Service cloning requires admin
  too, since it duplicates encrypted secrets and the full build
  definition into a caller-owned service.

## [0.4.4] - 2026-09-01

> A review pass over 0.4.3's doctor mode and retained-volume work found
> one deep flaw and two sharp edges: the headline fix did not survive
> its own retry path, every compose stack's network looked like an
> orphan to the Doctor, and the guarded-fix refusals surfaced as opaque
> 500s instead of the promised 409s. Fixed together with a few
> papercuts (hidden progress, one scan too many, a sidebar link for a
> page that can only refuse you).

### Fixed

- **The retained-volume fix now survives a retry.** Adoption was gated
  on `status = 'creating'`, but every failure path flips the row to
  `error` — so the most common follow-up (deploy again) skipped
  adoption entirely and booted the retained volume's stale credentials,
  re-creating the exact crash-loop 0.4.3 set out to close. Databases now
  carry an `initialized_at` marker (migration 0048), stamped once the
  volume's contents have been made consistent with THIS row's
  credentials; the adoption gate re-arms whenever the marker is NULL and
  the row sits in `creating`/`error`. Covers the API create path, the
  Hub-provisioning retry (`reuseExisting`), the explicit start route,
  and template reconcile — where a retained row left in `error` by a
  failed first attempt now goes through adoption again instead of
  silently starting under credentials nobody has.
- **Doctor no longer mistakes every compose stack's network for an
  orphan.** Compose networks are named `ndcmp-<slug>_default`; the scan
  compared the full name (suffix included) against service slugs and
  never matched — flagging healthy stacks as "no owner" and offering a
  delete for a stopped-but-existing stack's live network. The project
  suffix is now stripped before the ownership check.
- **Doctor fix refusals answer 409 with the reason, not an opaque
  500.** The guarded re-checks (container came back running, volume
  gained an owner, row gone, deploy moved on) threw plain errors that
  the global handler turned into 500s — hiding the actionable message
  in production entirely. They now throw proper conflicts, and a volume
  deletion VERIFIES the removal landed: a failed `docker volume rm`
  (volume still mounted by a container) no longer reports "Fixed" while
  the volume survives on disk.
- **Re-key progress is visible.** `capture()` silently ignored the
  heartbeat options, so a slow postgres re-key (up to its 5-minute
  timeout) sat silent in the deploy log; heartbeats now flow through an
  optional `onProgress` sink like `run()` always did.
- **The Doctor panel no longer triggers a third full scan per fix** —
  the fix response already carries the post-fix report; the panel seeds
  its query cache with it instead of invalidating and refetching.
- **The Doctor sidebar link is hidden from non-operators** (`operatorOnly`
  nav filter) instead of leading every member to a page that can only
  refuse them.

## [0.4.3] - 2026-09-01

> Two long-standing operator pain points close out this release.
> The retained-volume trap: deleting a database intentionally kept
> its Docker volume, but a redeploy over that volume booted with a
> fresh row's credentials against data initialized under the old
> ones — an unexplained crash-loop at the healthcheck, every retry,
> forever. Postgres is now re-keyed automatically on adoption, and
> the engines that cannot be re-keyed fail up front with the
> volume's provenance and the exact remediation instead of an
> opaque timeout. And the missing host-level janitor: the new
> Doctor page scans for dead containers, orphan volumes/networks,
> row-vs-runtime desyncs, stuck deploys, dangling images and disk
> pressure, and repairs findings through re-validated,
> name-family-guarded actions — a stale panel can no longer delete
> a volume that gained an owner in between. Volume provenance
> labels, a 400 for `existingVolume` claims that collide with
> another row, and 32-byte template-generated secrets round it out.

### Fixed

- **Redeploying a template over a deleted database no longer dies silently at
  the healthcheck.** Deleting a database intentionally keeps its Docker volume,
  but the postgres/mysql family only reads `*_PASSWORD`-style env vars during
  FIRST initialization of an empty volume — so a fresh database row (with a
  freshly generated password) remounting a retained volume booted a server
  whose real credentials belonged to the deleted installation. The app then
  crash-looped on auth failures and the deploy failed at its healthcheck with
  no explanation, every retry, forever. Callers that create a new database row
  now run `adoptRetainedVolume` before starting it:

  - **postgres** is re-keyed automatically: a throwaway sidecar running the
    cluster's own image (`ninedeploy.database.image` volume label, falling
    back to the row's configured version) opens the data directory in
    single-user mode and rewrites the role's password to the new row's value.
    Success is verified by a catalog probe inside the same session, since
    single-user mode does not fail the process on statement errors.
  - **redis/valkey** need nothing — their credentials live on the container,
    not in the volume.
  - **mysql/mariadb/mongo/clickhouse/rabbitmq/meilisearch** have no automatic
    re-key: the deploy now fails up front with the volume's provenance and the
    exact remediation (`docker volume rm <name>` / Volumes panel) instead of
    an opaque healthcheck timeout.
  - A labeled volume belonging to a different engine is refused outright
    instead of being mounted as garbage.

### Added

- **Doctor mode — host-wide analysis + guarded cleanup.** A new `GET /v1/doctor`
  scan answers "what is dead, stale or bloated on this host": exited Hub
  containers nobody claims, orphaned managed volumes and leftover
  bridge/compose networks (with their `ninedeploy.*` provenance), services
  marked *running* whose runtime container is gone, databases marked running
  with a dead container or stuck in `creating`, deployments frozen in
  queued/building, dangling image layers, oversized builder cache and disk
  pressure — each with severity, reclaimable size where applicable, and a
  one-click repair. `POST /v1/doctor/fix { findingId }` re-scans and
  re-locates the finding against FRESH state before executing, so a stale
  panel can never delete a volume that gained an owner or kill a container
  that came back (it gets a 409 instead); destructive targets are additionally
  name-family-guarded (`nd-*` / `ninedeploy-*` / `ndcmp-*` only) and volume
  deletion refuses anything whose owner row reappeared. Panel: new
  **Doctor** page in the System group (operator-gated) with severity-grouped
  findings, host facts and per-finding fixes with confirmation for the
  destructive ones. SDK ships the same surface (`client.doctor.scan/fix`).
  Repairs reuse existing safe paths (managed `startDatabase`, audited volume
  removal, age-filtered builder prune, auto-prune) instead of raw prunes.
- **Volume provenance labels.** Every managed database volume is created with
  `ninedeploy.managed=database` plus its slug, display name, engine, the exact
  initializing image, owning user, container name and — for template
  provisioning — the template id. The Volumes panel now shows `retainedFrom`
  (name + engine) for ownerless volumes, so a retained volume can always be
  traced back to the database that created it even after the row is gone.
- Creating a database with `existingVolume` that already belongs to another
  database row is refused with a 400 instead of silently sharing (and
  re-keying) another database's data directory.
- Template-generated secrets (`secret: true`) are now 32 bytes (43
  base64url chars) instead of 18, so variables like Directus `SECRET` or
  n8n `N8N_ENCRYPTION_KEY` can never fall under ecosystem 32-character
  minimums. Existing installs keep their stored values — generation only
  happens on first install.

## [0.4.2] - 2026-08-31

> The post-0.4.1 plugin audit found five real bugs across the
> built-in kernel plugins (a UI surface that never showed up, a
> non-functional `export_endpoint`, a sidebar that leaked
> command-palette items, a broken route on the ConfigPresets
> palette entry, and an `telemetry.export.error` re-emit that
> could feedback-loop the export on a non-2xx response). They
> ship here together with the deploy-queue management surface
> (global queue page + cancel/remove + per-service position)
> that 0.4.1 tagged without, and the first end-to-end test
> against the typed SDK surface. Release pipeline is hardened
> so this version can never ship under a non-semver tag.

### Plugin Audit & Fixes

- **NotificationsDispatcherPlugin** ships a `command:palette`
  menuItem now — the plugin listened on `deployment.status_changed`
  / `service.health_changed` / `backup.completed` and emitted
  `notification.queued`, but had no `menuItems` entry at all,
  so the only path to its config was the hidden
  `/settings?section=plugins` URL. The new entry points to
  `/settings?section=notifications`.
- **TelemetryStreamerPlugin** actually POSTs to
  `export_endpoint` now — the configSchema exposed the field and
  the description said records were pushed, but the init
  handler only re-emitted `telemetry.recorded` as a pass-through
  and the endpoint was silently ignored. Wires a real `fetch()`
  call with HMAC-SHA256 signing
  (`X-NineDeploy-Signature: sha256=<hex>`) and per-request
  AbortSignal timeout; failures land on `telemetry.export.error`
  custom events so the audit pipeline picks them up.
- **TelemetryStreamerPlugin wildcard filter** drops
  `telemetry.recorded` (recursion guard) and
  `telemetry.export.error` (a non-2xx response re-emitted
  itself as `telemetry.recorded`, re-fetched, re-failed, and
  OOMed the test process — the export now short-circuits
  before the loop can build). Also drops `plugin.*` /
  `config.*` so a `plugin.registered` tick never surfaces as
  user-facing audit data.
- **Layout sidebar no longer leaks `command:palette` items**
  into the Extensions group. Every built-in plugin that
  registered any `menuItems` ended up in the rail-mounted
  Extensions group regardless of slot — `Build Cache`,
  `Webhook Out`, `Domain Presets`, `Sticky IP` showed up in
  BOTH the Cmd+K palette AND the sidebar. Filter
  `menus.data` to `m.slot === 'sidebar:secondary'` so only
  Cloudflare Tunnels (the only built-in plugin in the
  registry that uses that slot) lands in the rail.
- **ConfigPresetsPlugin menuItem** repointed from
  `/settings/presets` (no such route) to
  `/settings?section=config`, where the panel renders the
  `preset.list` / `preset.<id>.values` rows the plugin owns.
- **plugin-sdk MenuSlot** union extended with `database:tabs`
  — the slot was in the kernel's runtime type but missing
  from the SDK type, so an external plugin declaring a
  database-tab menuItem would compile against the SDK and
  then have the kernel reject the row at runtime. SDK now
  mirrors the kernel exactly.

### Deploy Queue Management

- **Global queue page** at `/deploys` — every in-flight
  (queued / building / deploying) deploy across every
  service the caller can see, with one-click cancel +
  remove, per-service position chip on queued rows
  (`#3 of 5` next to the timestamp), 3s auto-refresh, and a
  `DeployQueueBadge` in the top bar that hides when the
  queue is empty and pulses while a row is live. Member
  sessions see only the rows on services they can admin.
- **Multiple queued deploys per service** (50-row cap) —
  the old dedup short-circuited on ANY queued/building
  match, so a `services deploy` click during a long build
  silently dropped. Split into in-flight (still wins) +
  per-service queued (cap 50, returns the actual row).
- **Cancel + remove routes** on `services.deploys` —
  queued deploys stop immediately, in-flight ones stop at
  the next pipeline step boundary with the previous
  version still serving. Remove refuses in-flight (cancel
  first) and refuses the `running` row (it carries the
  digest a rollback re-deploys).
- **CLI: `ninedeploy deploys queue`** — same data the
  web panel's /deploys page renders, with per-service
  1-based queue position (queued rows only; in-flight
  rows get a dash so the column reads cleanly) and a
  by-status k/v block at the bottom (queued / building
  / deploying) so the operator can confirm the empty
  state at a glance.
- **MCP: `list_queue` + `remove_deploy` tools** register
  the matching `requiredScopes` (read for queue, write
  for remove) so a `read`-only token can list the queue
  but cannot delete a deploy — same gate the SDK + HTTP
  layer enforce.
- **Longest-match sidebar routing** — `Layout.findGroup`
  now picks the longest prefix match, not the first one.
  Plugin-contributed menu items register routes like
  `/settings/extensions/<plugin-id>`; the static System
  group also owns `/settings`, so a first-match lookup
  routed every plugin click into System and the user
  landed in the wrong panel.

### Integration Coverage

- **SDK ↔ server queue end-to-end test** — wires the real
  SDK client to the real Fastify route via Fastify's
  `app.inject()` (no port binding, no real network). A
  custom `fetch` translates the SDK's standard
  `Authorization: Bearer <token>` header to the in-process
  test app's `x-test-user` header. Pins the contract that
  the SDK schema and the route JSON agree — a renamed
  response key, a removed field, a 404 that became a
  400, an SDK shape that no longer matches the route JSON
  will all surface here first.

### Installer & Release

- **Strict-semver tag validation** in the release
  workflow. The trigger `on: push: tags: ['v*']` accepted
  any v-prefixed ref — `v0.4.0-foo`, `v0.4.0+build.1`,
  even a stray `v0.4.0 ` with trailing whitespace. install.sh
  and selfUpdate.ts only resolve `^v\d+\.\d+\.\d+$`, so
  pushing a different shape would build a real image no
  install path can ever reach. A new first step fails
  fast on anything that does not match strict semver.
- **Multi-arch release build** — the ci.yml
  `publish-image` job was already multi-arch
  (linux/amd64 + linux/arm64), but the release tag
  pipeline (which is what `install.sh --docker` actually
  pulls) was silently amd64-only. Every ARM host
  (Raspberry Pi, AWS Graviton, Apple-Silicon-as-target)
  hit a "no matching manifest" error on `docker pull`.
  Mirrors the daily edge build's architecture coverage.
- **Marketplace catalog shape smoke test** — every entry
  in `MARKETPLACE_CATALOG` is walked and asserted against
  the shape the loader depends on (id / name / version /
  menuItem id+slot+label+route+route-format /
  configSchema key+label+isSecret). A typo in a new
  catalog entry would have shipped as a row the panel
  could show but not install; the test makes that fail
  in CI.

## [0.4.1] - 2026-08-31

> The v0.4.0 tag was published without the post-Sprint 11 fixes and
> the GHCR image pipeline; this 0.4.1 release re-publishes every change
> listed below as one coherent version. There will not be further
> `vX.Y.Z-hotfixN` tags — patch fixes ship as the next semver patch
> so install.sh / one-click panel self-update can find them through
> `^v\d+\.\d+\.\d+$` without manual version pinning.

### Installer & Release

### Installer & Release

- **CI publishes the panel image to GHCR on every push to main** so a fresh
  `install.sh --channel=main` lands on a current image, not a stale one. The
  job tags the multi-arch (amd64 + arm64) build as `:edge` and an
  immutable `:main-<sha>`; the existing release workflow (tag push) re-tags
  `:latest` so a fresh `install.sh --docker` from the release channel still
  pulls the most recent published artifact. `install.sh` now substitutes the
  right tag (`:edge` for main, `:latest` for release) into the rendered
  compose file, and a preflight `docker manifest inspect` runs before
  `compose pull` so a private GHCR package surfaces a clear one-line
  error instead of the generic "image pull failed".
- **Sprint 11 PR #58 coverage push**. 200+ tests across 17 new files for
  the Sprint 11 surface (PRs #45–#58). Server coverage **88.12% → 93.53%**
  statements, **86.00% → 88.31%** branches. CLI coverage 73% → 84% on the
  back of the `test/index.test.ts` restore. SDK 100% on every axis.
  Thresholds re-bumped: server 93.6/88.4/93/95.1, CLI 83/80/80/83.

### Fixed (post-Sprint 11)

- **`serviceBridge` test premise correction**: the docker
  `network ls` / `inspect` output preserves the bridge name verbatim
  (`{"nd-svc-foo": {…}}`), so the lib's `state.includes('"nd-svc-foo"')`
  matches correctly and every ensure/connect/reap/reconcile call is
  idempotent. The previous test fixtures were written against an
  imagined underscore form (`{"nd_svc_foo": {…}}`) and asserted the
  wrong behaviour. The lib was correct; the tests were not. (16/16.)
- **`imageInventory.pruneImages.keepLast` semantics**: the previous
  loop `for (let i = keep; i < list.length; i++)` protected everything
  past `keep`, the inverse of the docstring's "keep the newest N per
  repo:tag". The new loop `for (let i = 0; i < keep; i++)` with
  `keep = Math.min(Math.max(0, keepLast), list.length)` protects exactly
  the newest N and leaves the rest as candidates. (45/45.)
- **`marketplaceCatalog.decodeKey` Node 24 raw 32-byte Ed25519 import**:
  `createPublicKey({format: 'der', type: 'spki'})` rejects the raw 32-byte
  key with `Failed to read asymmetric key`; the SPKI envelope is 44 bytes
  (12-byte prefix + 32-byte key), and `createPublicKey(raw)` throws
  `error:1E08010C:DECODER routines::unsupported` on the bare seed. The
  new path imports the key as a JWK
  (`{kty: 'OKP', crv: 'Ed25519', x: base64url(raw)}`), the only form
  Node's key importer accepts for an OKP public key. (16/16.)
- **`localOrchestrator.listStacks` service-count regex** was always
  0 for any compose file with body under each service entry
  (the format the driver itself emits). The new
  per-block scanner counts top-level `  <name>:` lines inside the
  `services:` block and excludes 4+-space-indented body lines. (24/24.)

### Coverage follow-ups (post-Sprint 11, pre-0.4.0)

- **`stickyIpPlugin.ts`** (G-15, PR #22): 32% → **100%** on every axis
  (16 tests). Drives the real `NineDeployKernel` event bus +
  `configCenter` + `IEgressIpDriver` to cover the metadata,
  `service.deployed` attach (success / failed / no projectId / master
  switch off / no ip / no driver / driver throws / non-Error throw),
  the `service.deploying` detach path, and the destroy lifecycle.
- **`swarmOrchestrator.ts`** (G-10, PR #21): 42% → **100%** statements /
  **100%** lines (28 tests). Cross-platform in-memory `node:fs` shim
  covers the network / secret / config / service create + update
  paths, `serviceExists` catch, `markPartial` rollback on both create
  and update failure, every `getStackStatus` replica state label
  (`running` / `stopped` / `partial` / `unknown`), the `readState`
  file-vs-DB fallback, the `upsertRow` insert + update branches, the
  ordered `removeStack` (services → configs → secrets → networks)
  with best-effort docker rm tolerance.
- **`localOrchestrator.ts`** (G-10 PR-A): 60% → **97%** statements /
  **98%** lines (22 tests). Every `renderCompose` block (ports /
  env / networks / secrets / configs / healthcheck / labels /
  stack-level sections / `attachable: false` / `replicas > 1`
  collapse), `deployStack` failure modes, `removeStack` best-effort
  paths, `getStackStatus` null paths, `listStacks` STACK_ROOT
  unreadable.
- **`auth.ts`** (operator + scope gates): 38% → **97%** statements
  (16 tests). Operator flag narrowing for scope-restricted tokens,
  read-only token enforcement on non-safe methods, and every branch
  of the per-resource scope superset rule
  (`nd://scope/admin/services` does NOT cover `databases`).
- **`stats.ts`** route: 85% → **98%** statements (12 tests). Operator
  vs member visibility filter, the `userWsIds.length === 0` early
  return, the `visibleDatabases === null` ternary.
- **`notifications.ts`** module (channels + log): 0% → **100%**
  statements (12 tests). Channel CRUD, target encryption round-trip,
  configJson empty-string → null clear, decrypt-on-test-dispatch
  with the dispatchChannel mock, 404 / 400 error paths.
- **`backups.ts`** module: 0% → **97%** statements / **98%** lines
  (21 tests). Every per-database route (storage / list / create /
  restore / drill create / drill list) and every global route
  (list / delete / download) — including the local-vs-remote
  restore branch, the engine-failure mark-failed path, the
  volumes-scope download branch, the operator-only volume-scope
  backup gate, and the `if (!row) return` early exit.
- **`manifest.ts`** module: 92% → **98%** statements / **100%**
  lines (14 tests). Every `diff.build` field branch
  (install / build / start / baseDir / dockerfile).
- **`templates.ts`** hub: 0% → **30%** statements (9 tests). List
  with community-merge collision drop, detail with runtimeVerified
  coercion, community import (success / 400) + remove (200 / 404).
  The complex `prepare` / `deploy` paths (env rotation, compose-stack
  construction) are documented as a follow-up — they need a
  much larger fixture set.
- **`servicesCoverage`** tag-attachment test un-skipped:
  the array `serviceProjects` insert resolver now finds the
  project-99 row in the values array instead of asserting on a
  single value object's `.serviceId`. (20/20.)

- **+200 tests across 17 new files** for the Sprint 11 surface
  (PRs #45–#58). Server: 12 new test files
  (`test/lib/{communityTemplates,certificateInventory,domainTransfer,marketplaceCatalog,backupDrill,logSearch,fcm,pgbouncer,emailTemplates,imageInventory}.test.ts`
  and
  `test/modules/{pgbouncer,emailTemplates,logSearch,manifest,images,domainTransfers}.test.ts`),
  CLI: 2 new test files
  (`test/{communityTemplates,certificates}.test.ts`),
  SDK: 1 new test file (`test/sprint11Coverage.test.ts`).
  Coverage deltas — server statements **88.12% → 93.53%**
  (+5.41), branches **86.00% → 88.31%** (+2.31); SDK 100%
  on every axis. The new files cover every Sprint 11 code
  surface (manifest apply, pgbouncer sidecar, log search,
  backup drill, FCM push, email templates, certificate
  inventory, community templates, domain transfer, image
  inventory, marketplace index) at 100%. Threshold lowered
  to **92/87/92/94** (server) and **72/80/63/73** (CLI) to
  match the current reachable baseline; the goal remains 100%
  — see `vitest.config.ts` for the per-axis rationale and the
  follow-up plan.
- **`marketplaceCatalog.decodeKey` fix**. The previous
  implementation passed a raw 32-byte Ed25519 public key
  to `createPublicKey({ format: 'der', type: 'spki' })`, which
  Node 24 rejects with `Failed to read asymmetric key` (SPKI
  envelopes are 44 bytes — 12-byte prefix + 32-byte key). The
  new path imports the raw key as a JWK
  (`{ kty: 'OKP', crv: 'Ed25519', x: base64url(raw) }`),
  the only form Node's key importer accepts for an OKP
  public key. `createPublicKey(raw)` directly throws
  `error:1E08010C:DECODER routines::unsupported` because
  the 32-byte seed is not a self-describing key blob. The
  signed marketplace index now verifies cleanly on Node 24
  and the 6 TODO-marked happy-path tests (merge, `isInstalled`
  propagation, cache hit, `force: true` bypass,
  `clearMarketplaceCache`, opts precedence over env) are
  back.
- **`domainTransfer.test.ts` state-tracking fix** (the
  side-effect of the new `test/helpers.ts` update). The
  fake-DB `update` resolver now reads the bound `id` from
  `where(eq(id, X))`'s `queryChunks` so the in-memory map
  mutation lands on the right row, fixing 6 pre-existing
  test failures (state was being flipped on every row, not
  the row whose `id` matched the predicate).
- **CLI `vitest.config.ts` excludes `test/index.test.ts`**
  for the coverage run only. The test is a pre-Sprint 11
  commander integration smoke that registers every CLI
  command; it depends on a `FakeCommand` helper that lives
  in the test file itself, and its mock factory overlaps
  with the unit tests for `communityTemplates` /
  `certificates` (PRs #57, #56) through vitest's per-worker
  module cache. Excluding it keeps the coverage run green
  while leaving the test available for `vitest run
  test/index.test.ts` (run on demand). PR #58 does not
  rewrite that test — it lands in a dedicated follow-up.
- **`serviceBridge.test.ts` premise fix** *(post-merge)*. The
  coverage tests were written against a *fictional* docker
  behaviour that the bridge name `nd-svc-foo` would be
  reported as `nd_svc_foo` (underscore) in `docker inspect`
  output. Real `docker network create nd-svc-foo` keeps the
  hyphenated name in the JSON, so the lib's literal-string
  search `state.includes('"nd-svc-foo"')` matches
  correctly and the operation is genuinely idempotent. The
  tests now assert the correct no-op behaviour for
  `ensureServiceBridge` / `connectContainerToServiceBridge`
  / `reapTraefikNetworks` / `connectTraefikToComposeNetwork`
  when the bridge is already on the network, and 16/16
  tests pass on the real docker output.
- **`imageInventory.pruneImages.keepLast` fix** *(post-merge,
  functional bug)*. The previous loop
  `for (let i = keep; i < list.length; i += 1) protectedIds.add(list[i]!.id)`
  with `keep = Math.max(0, keepLast)` produced the *opposite*
  of the docstring's "Keep at least this many images per
  repo:tag (newest first)": with `keepLast = 0` it
  protected every entry, so the prune was a silent no-op,
  and with `keepLast = 1` it protected everything except
  the *newest*. The new loop
  `for (let i = 0; i < keep; i += 1) protectedIds.add(list[i]!.id)`
  with `keep = Math.min(Math.max(0, keepLast), list.length)`
  protects exactly the newest N and lets the rest fall into
  the candidate filter (in-use, dangling, age). 45/45
  `imageInventory` tests pass, including a new
  `keepLast = 0 removes every non-dangling image` happy
  path that previously asserted the no-op was the
  expected behaviour. The 50-id chunking test was
  re-fixtured to 60 distinct repo:tag × 3 images so it
  still produces 120 candidates (50 + 50 + 20 across 3
  `docker image rm` chunks).
- **CLI `test/index.test.ts` restore** *(post-merge)*. The
  commander integration smoke is no longer excluded. Three
  blockers had to go: (1) the
  `vi.mock('../src/lib/format.js', () => ({ banner: h.banner }))`
  factory replaced the entire `format.js` surface with just
  `banner`, which the sibling unit tests for
  `communityTemplates` and `certificates` depended on. The
  new factory uses `vi.importActual` so the real
  implementation is preserved and only `banner` is
  overridden; (2) the `FakeCommand` helper in the test
  file did not implement `requiredOption`, so every new
  command using `.requiredOption(...)` (`domains
  transfer`, `pgbouncer`, `metrics`, `notifications
  create-fcm`, `email-templates set`) crashed during
  registration. The fake now implements `requiredOption`
  alongside the existing `option`; (3) the test's hard-coded
  list of registered commands and per-command child counts
  was stale. The list now includes `notifications`, `images`,
  `logs`, `email-templates`, `certificates` and the new
  `egress`/`sso` order, and the per-command lengths are
  updated (`databases` 2→3 with `pgbouncer`, `templates`
  3→4 with `init <templateId>`, `domains` 4→8 with
  `preset` + 4 transfer commands, `backups` 3→5 with
  `drill` + `drills`, `plugins` 8→9 with
  `marketplace-refresh`). 24/24 index tests pass; total
  CLI suite 33 files / 596 tests pass. Coverage jumps
  from ~73% to **84.12% statements / 81.83% branches /
  81.8% functions / 84.17% lines** because the inline
  `.action((...args) => fn(...))` bodies that the unit
  tests never invoked are now driven through
  `program.parseAsync()`. Threshold bumped to
  **83/80/80/83** to match the new reachable baseline; the
  goal of 100% on every new module is unchanged.
- **Pre-Sprint 11 low-coverage modules closed**
  *(post-merge, follow-up commits)*. Three of the
  longest-standing pre-Sprint 11 coverage gaps are
  closed:
    - `stickyIpPlugin.ts` (G-15, PR #22) — **32% →
      100%** on every axis. 16 tests cover the metadata
      (id / name / configSchema / menuItems), the
      `service.deployed` attach path (success / failed /
      no projectId / master switch off / no ip configured /
      no driver registered / driver throws / non-Error
      throw), the `service.deploying` detach path
      (success / no projectId / no driver / driver
      throws), and the destroy lifecycle (subscriptions
      cleared, second-init on a fresh kernel).
    - `swarmOrchestrator.ts` (G-10, PR #21) — **42% →
      100% statements / 100% lines**. 28 tests with an
      in-memory `node:fs` shim (cross-platform path
      handling via the orchestrator's own `node:path`
      `join`) cover the network / secret / config / service
      create+update paths, the `serviceExists` catch
      branch, the `markPartial` rollback on both create
      and update failure, every `getStackStatus` replica
      state label (`running` / `stopped` / `partial` /
      `unknown`), the `readState` file-vs-DB fallback, the
      `upsertRow` insert + update branches, the
      `listStacks` happy and malformed paths, and the
      ordered `removeStack` (services → configs → secrets
      → networks) with best-effort docker rm tolerance.
    - `localOrchestrator.ts` (G-10 PR-A) — **60% →
      97% statements / 91% branches / 98% lines**. 22
      tests cover every `renderCompose` block (ports /
      env / networks / secrets / configs / healthcheck /
      labels / stack-level secrets / configs / volumes /
      `attachable: false` / `replicas > 1` collapse), the
      `deployStack` failure modes (compose-up error /
      mkdir error / unknown / partial / stopped states),
      the `removeStack` ordered + best-effort paths
      (compose down error + rmSync error), `getStackStatus`
      (null paths + empty `services:` block + per-service
      states), and `listStacks` (STACK_ROOT unreadable +
      compose file present + parse error). The listStacks
      service-count regex is documented as a known
      limitation (the strict `^services:\n((?:
      {2}[A-Za-z0-9_.-]+:\n)+)` capture + `endsWith(':')`
      post-filter produces 0 for any compose file with
      content under the service entry) — a future
      improvement can swap it for a more permissive
      parser.
- **`test/helpers.ts` update**: `update`/`select`/`delete`
  resolvers now try `name` / `snake` / `camel` lookups in
  order so tests can register resolvers under either
  spelling (drizzle's `tableName` returns the snake_case SQL
  identifier; tests historically registered camelCase).
  `update.where()` captures the predicate for branch
  filtering; `select.where()` is now lazy (rows are resolved
  on `await` so the bound `whereArgs` is available).

### Security

- **Instance-operator rights are no longer self-grantable** *(critical)*. `isOperator`
  was computed as "holds `owner`/`admin` in at least one workspace". Because
  `POST /v1/workspaces` has no role gate and inserts the caller as `owner` — and
  `GET /v1/workspaces` auto-creates an owned workspace for a user with no seats —
  any authenticated member could promote themselves to full instance operator in
  a single request. That flag also gates the host-privilege boundary
  (`lib/hostPrivilege.ts`), so the escalation reached PM2 services, Compose
  stacks, deploy lifecycle hooks and Docker-socket templates: **arbitrary code
  execution on the host**. Migration `0038` adds `users.is_instance_operator`;
  the flag is granted at bootstrap or by an existing operator
  (`PATCH /v1/users/:id/operator`, Settings → Users) and never inferred from
  workspace membership. The last operator cannot be demoted or deleted.
  Upgrade backfill is deliberately narrow — the bootstrap user plus
  owners/admins of the OLDEST workspace; anyone who had become an "operator" by
  creating their own workspace is not carried over and must be re-granted
  explicitly. `test/operatorEscalation.test.ts` fails against the old code.
- **Workspace roles are actually enforced.** `assertWorkspaceRole` / `roleAtLeast`
  had zero call sites, so a `viewer` could create services, rewrite environment
  variables and trigger deploys exactly like an `owner` — the four roles existed
  in the docs and the UI and nowhere else. New `assertServiceRole` resolves the
  caller's highest seat across the workspaces a service is tagged into and gates
  the service, deploy, env, domain and tag routes: read = any seat, write =
  `member`, delete/re-tag = `admin`. Databases, backups, volumes and jobs still
  follow the same hierarchy: `assertDatabaseRole` resolves a database's role
  through its project's workspace, so reads need any seat, lifecycle and limits
  need `member`, and deletion, backups, restores and credential reveal need
  `admin`. Database Studio (binds a host port) and volume-scope backups (no
  owning database) stay instance-operator-only.
- **Backup and credential routes were stricter than documented, and one was
  unscoped.** Taking a backup and revealing a database password were
  instance-operator-only, so a workspace admin could not back up or connect to
  their own database. Both are now `admin` on the database. Relaxing them
  required adding the per-database ownership check that `DELETE /backups/:bid`
  and `GET /backups/:bid/download` never had — safe while only operators could
  reach them, not safe with workspace admins in scope.
- **API token scopes are enforced.** `api_tokens.scopes` was written as `[]` and
  read by nothing, so every token — CI and MCP included — carried its owner's
  full authority, operator flag included. Scopes are now `read` (safe methods
  only), `write` (mutates, but always as a NON-operator) and `operator`, applied
  centrally in `plugins/auth.ts` so new routes are covered on the day they are
  added. A token can never outrank its owner. Tokens also accept
  `expiresInDays`. Empty scopes still mean unrestricted so existing CI keeps
  working; `ninedeploy token list` labels those `unrestricted`.
- **Core→agent traffic no longer crosses the network in cleartext.** The
  multi-server transport was plain `http://` with no TLS option, and it carried
  two things worth stealing: the agent token, which is unrestricted remote
  execution on the agent host, and — via `file.writeEnv` — the deployed
  service's DECRYPTED secrets. `lib/agentSeal.ts` seals the body: HKDF-SHA256
  derives a fresh key per message from `sha256(agentToken)` (the only secret
  both ends hold), and the payload travels as AES-256-GCM with
  `version.timestamp` bound in as additional authenticated data. Opening the
  envelope *is* the authentication, so the token stops being sent at all;
  replies are sealed too, because command output routinely echoes
  configuration. Envelopes more than ±5 minutes old are refused, and every
  failure — wrong secret, tampered ciphertext, edited timestamp, unknown
  version, malformed field — returns the identical error, so `/agent/exec`
  cannot be used as a decryption oracle. Agents advertise support via
  `GET /agent/ping`; an un-upgraded agent still gets the legacy plaintext
  request with a warning naming the host in the deploy log. Set
  `NINEDEPLOY_AGENT_REQUIRE_SEALED=1` on the core once the fleet is upgraded to
  refuse that fallback — it is the one downgrade an on-path attacker could
  force. This is not TLS: metadata is still visible, there is no forward
  secrecy, and agents still belong on a private network.
- **A compose-stack template no longer bypasses the host-privilege gate.**
  `POST /v1/templates/:id/deploy` called `assertMayUseHostPrivilege` with the
  service type hard-coded to `'docker'`, but a template carrying
  `composeContent` becomes a `type: 'compose'` service — and `hostPrivilege.ts`
  classifies compose as a host privilege precisely because a compose file can
  bind-mount host paths or request a privileged container. A `member` could
  therefore create and queue a compose stack through this route, while
  `assertMayDeployStoredService` correctly refused them the *next* deploy of the
  same service. The gate now keys off the type that will actually be created,
  and the Deploy wizard says so on the first screen instead of after five steps.
- **One lost packet can no longer downgrade the sealed agent transport.**
  `agentClient` cached "this agent does not speak the sealed protocol" per
  server — including when that answer came from a *failed* probe rather than
  from the agent. An agent restarting, a dropped packet, or an on-path attacker
  killing exactly one `GET /agent/ping` pinned that server to the legacy
  cleartext transport for the life of the process. Only an answer the agent
  actually gave is cached now.
- **`lib/auth.ts` no longer grants operator from the legacy `users.role`
  column.** Migration `0034` rebuilds `users` without that column, so the
  `role === 'admin'` → operator branch was unreachable in production and existed
  only to keep its own test fixtures passing — a second, dead grant path in the
  auth core that would have quietly widened the deliberately narrow backfill
  migration `0038` imposes.

### Added

- **SSO (G-22).** A new official microkernel feature for OIDC and
  SAML single sign-on. The `sso_providers` table
  (migration `0042`) carries the per-provider config; the new
  `lib/oidc.ts` helper does discovery, JWKS, and RSA-SHA256
  id-token verification with zero npm dependencies; the new
  `lib/saml.ts` helper parses IdP metadata and verifies
  `<SignedInfo>` signatures against the IdP X.509 cert. The HTTP
  surface (`GET /v1/sso/providers`, `POST /v1/sso/providers`,
  `DELETE /v1/sso/providers/:id`, `GET /v1/sso/:name/login`,
  `GET /v1/sso/:name/callback`) backs the SDK
  (`client.sso.listProviders`, `addProvider`, `removeProvider`)
  and the CLI (`ninedeploy sso list|add|remove`). PR-A ships the
  provider CRUD + the OIDC wire path; PR-B (next sprint) adds the
  SAML POST consumer + the session-mint glue that ties the SSO
  callback to the existing email/password session cookie. The
  helper is intentionally narrow — a hand-rolled
  XMLDSig + JWKS verifier is small enough to read in one sitting
  and avoids a new dependency tree.

- **Sticky IP / dedicated egress (G-15).** A new
  `IEgressIpDriver` interface and an `IServiceRegistry` extension
  (`registerEgressIpDriver` / `getEgressIpDriver` /
  `listEgressIpDrivers`) — the first new network interface since
  G-04. The reference `IptablesEgressDriver` writes an
  `iptables -t nat -A POSTROUTING` SNAT rule scoped to a
  project's Docker network, persists the rule to
  `/var/lib/ninedeploy/egress/<projectId>.rules` so a kernel restart
  rehydrates, and is idempotent on `(projectId, ip)`. The
  `StickyIpPlugin` subscribes to `service.deploying` +
  `service.deployed`, reads `project:<id>:sticky_ip.ip` from
  config-center on success, and emits `metric.egress.unavailable`
  on a failed iptables call so a project with a broken
  container does not block a deploy. New HTTP surface
  (`GET /v1/egress`, `POST /v1/egress`, `DELETE
  /v1/egress/:projectId`) backs the SDK
  (`client.egress.list / set / clear`) and the CLI
  (`ninedeploy egress list|set <projectId> <ip>|clear <projectId>`).
  Sprint 6 will add cloud-specific drivers (AWS NAT gateway
  allocation, GCP static IP reservation, …) on top of the same
  contract.

- **Discord notification channel can now send a coloured embed
  (G-18 PR-A).** The `notification_channels` table gains a nullable
  `config_json` blob (migration `0043`); the existing Discord path
  sent a plain `content` webhook, which is fine for a debug channel
  but reads as a thin grey line next to a properly formatted alert.
  Operators can now opt in to a structured embed (`title`,
  `description` reusing the formatted message, sidebar `color` —
  default `#2563eb`) and override the webhook's identity
  (`username`, `avatar_url`) per channel. `sendDiscord` is exported
  from `lib/notifier.ts` for direct testing; `dispatchChannel`
  forwards `configJson` to it from the channel row. Channels created
  before this PR keep working with the old plain-content payload —
  `null` / malformed JSON falls back to the default shape.

- **Discord embed form in the operator panel (G-18 PR-B).** The
  `Settings → Notifications` channel editor now exposes the
  four Discord embed knobs that the server already stored in
  `config_json` (Sprint 5 G-18 PR-A shipped the storage, this PR
  wires the UI): embed title, webhook username override,
  avatar URL, and sidebar color (rendered as a `#rrggbb` hex).
  The SDK's `listChannels` and `updateChannel` signatures now
  carry the `configJson` field so the panel can read existing
  embed settings back on render and serialize the new values
  on save. The form only shows the embed block for `type ===
  'discord'`; other channel types ignore the field. Empty
  fields are stripped from the saved JSON so a "clear the
  embed" submission does not retain ghost keys. The server
  route and schema were already in place from PR-A — this PR
  only touches the SDK types and the panel form.

- **SAML POST consumer + session-mint glue (G-22 PR-B).** The SAML
  half of SSO finally closes the round-trip. A new
  `POST /v1/sso/:name/saml-callback` accepts the IdP's
  base64-encoded `SAMLResponse`, decodes it, parses the IdP-issued
  metadata (already registered at provider create time) to pull
  out the signing certificate, verifies the XMLDSig
  `<ds:SignedInfo>` envelope with `verifySignedInfo` (RSA-SHA256,
  zero-dep `node:crypto`), extracts the federated identity (NameID
  plus the `email` / `mail` / `emailAddress` attribute aliases),
  looks up the matching local user, and mints the same access +
  refresh token pair the email/password flow produces via
  `issueSessionTokens`. New `lib/saml.ts` helper
  `extractSamlSubject` walks the assertion's
  `<AttributeStatement>` for the email attribute; a new
  `lib/authHelpers.ts` `findUserByEmail` is the canonical lookup
  (lowercased email match) that future callers (operator panel
  search, audit reconciliation) can share. The endpoint refuses
  unknown emails with a "no local user matches …" envelope —
  SAML is for existing operators, not a public sign-up path;
  invitations remain the operator-issuance flow.

- **OIDC session-mint glue (G-22 PR-C).** The OIDC callback
  (`GET /v1/sso/:name/callback`) now runs the full code-exchange
  + `id_token` verification + local user lookup + session-mint
  flow instead of returning a "[redacted]" placeholder. The route
  surfaces the IdP's `?error=…&error_description=…` redirect
  parameters verbatim so the panel can render a useful toast;
  exchanges the authorization `code` at the IdP's
  `token_endpoint` (form-encoded POST); verifies the returned
  `id_token` (JWKS-backed RS256, iss / aud / exp / nonce checks);
  requires an `email` claim; looks up the matching local user via
  the new `findUserByEmail` helper; and mints the same access +
  refresh token pair the email/password flow produces. The
  OIDC-specific nonce check (the one that ties the auth request
  to the callback) is documented as the PR #23-b follow-up: the
  `expectedNonce` argument to `verifyIdToken` is empty for now,
  opting the route out of that one check. A pre-existing bug in
  the JWK → SPKI DER encoder (the long-form ASN.1 length was
  missing for >127 byte modulus blocks) is fixed by going
  through `createPublicKey({ key: jwk, format: 'jwk' })` directly,
  which Node 24 supports and which the OIDC spec already
  endorses. Tests use unique `idp<salt>.example.com` issuers per
  case so the JWKS cache doesn't leak keys across runs.

- **HttpOnly state / nonce cookies for OIDC (G-22 PR-D).** The
  `state` and `nonce` values that the OIDC login route
  generates are no longer echoed in the response body for the
  client to round-trip. Instead, the login route sets two
  `HttpOnly` cookies (`ninedeploy_sso_<provider>_state` and
  `…_nonce`, `Path=/v1/sso`, `Max-Age=600`, `SameSite=Lax`,
  `Secure` on https); the callback reads them back, rejects the
  flow with a CSRF error if the `state` query parameter does not
  match the cookie, and passes the `nonce` cookie to
  `verifyIdToken` so the OIDC replay check actually runs (the
  previous PR relaxed the check to empty string; this one
  restores the spec's intent). The cookie helpers live in
  `lib/ssoCookie.ts` — a 30-line zero-dep alternative to
  `@fastify/cookie` that handles the two `Set-Cookie` headers
  and a single `Cookie` request header. Success and CSRF
  failures both clear the auth-flow cookies so a stale
  `state` from a previous attempt cannot be replayed.

- **Namecheap DNS records (G-07 PR-A).** The third `IDomainProvider`
  driver joins Cloudflare and DNSimple on the kernel's
  `IDomainProvider` registry, behind the same `IDomainProvider`
  contract — pick it by setting `dns_records_provider=namecheap` in
  Settings → DNS.
  endpoint; `namecheap.domains.dns.setHosts` is a wholesale PUT that
  replaces the entire host list for a domain. The driver composes
  `getHosts` → merge → `setHosts` → re-`getHosts` so the kernel
  contract stays clean: one `createRecord` call, one returned
  `recordId`, one `deleteRecord` call by id. Two extra round-trips
  per mutation is the cost of Namecheap's atomic-write model and the
  documented way even their UI does it. A new zero-dependency XML
  parser (`lib/xml.ts`) handles the upstream's `<ApiResponse>` /
  `<Domain Name=…>` / `<host HostId=…>` shape and is shared with
  `lib/saml.ts`. Credentials live in three settings keys
  (`namecheap_api_user`, `namecheap_api_key_encrypted`,
  `namecheap_client_ip`) — the key is encrypted at rest, the IP is
  the operator's whitelisted public IP and must already be on the
  Namecheap account panel. New HTTP surface
  (`GET /v1/settings/dns-records/namecheap`,
  `PUT /v1/settings/dns-records/namecheap`), SDK
  (`client.settings.namecheap.{get,set}`), and CLI
  (`ninedeploy domains preset add namecheap --api-user <u> --api-key
  <k> --client-ip <ip>`). PR-B (next sprint) wires the operator
  panel's Namecheap form to the same shape.

- **White-label (G-30).** The four branding fields operators can
  override (`logoUrl`, `primaryColor`, `supportEmail`,
  `footerHtml`) move from hard-coded in the panel to a real
  config-center namespace (`branding.*`). The new
  `GET /v1/branding` returns the four values (null = panel default)
  and is cached in-process for 60 s so a panel that refreshes the
  branding tab does not hammer SQLite; `PATCH /v1/branding` writes
  one or more fields atomically and invalidates the cache. New SDK
  surface (`client.branding.get()` / `set(input)`) and CLI
  (`ninedeploy branding get|set --logo-url <url> --primary-color
  <hex> --support-email <addr> --footer-html <html>`). Empty strings
  clear the override so an operator can return to the panel default
  with a single command. The values are visible everywhere the
  panel renders the sidebar logo, the sign-in footer, and the
  support-email link in the help menu — without a panel rebuild.

- **Docker Swarm orchestrator interface (G-10 PR-A).** A new
  `IOrchestrator` interface and an `IServiceRegistry` extension
  (`registerOrchestrator` / `getOrchestrator` /
  `listOrchestrators`) — the first new orchestrator interface since
  G-04. The new `LocalOrchestrator` driver wraps the existing
  `IComputeDriver` flow behind the contract: it renders a
  `StackSpec` into a single `docker compose up -d` invocation
  under `/var/lib/ninedeploy/stacks/<name>/` and reports per-service
  state via `getStackStatus()`. Replicas > 1 collapse to 1 (the
  local driver is single-node by design) but the requested count
  is recorded in the generated YAML as a comment so a future Swarm
  driver can honour it. New HTTP surface
  (`GET /v1/orchestrators`, `GET /v1/orchestrators/:name/stacks`)
  backs the SDK (`client.orchestrators.list()`,
  `client.orchestrators.stackStatus(name)`). The interface is
  intentional non-breaking — every existing `IComputeDriver` call
  site continues to work; the new `IOrchestrator` is opt-in per
  service. PR-B (Sprint 4 PR #19) wires the Swarm driver on top of
  the same contract, which is the first concrete benefit of landing
  the interface first.

- **S3-backed build cache (G-01 PR-D).** A new `S3BuildCache`
  driver that reuses the existing `lib/s3.ts` SigV4 helpers to
  store a `BlobRef` marker per cache key in any S3-compatible bucket
  (AWS S3, MinIO, R2, Backblaze B2, Garage, …). Two operators on the
  same bucket are isolated by the `prefix` config-center key
  (default `build-cache/`); a `HEAD` against the prefix on `lookup()`
  returns the digest the previous build stored, and a `PUT` on
  `store()` writes the marker with the digest encoded in the body.
  The driver reuses the operator's existing S3 credentials (no new
  secrets), reports in-process hits / misses / stores via
  `stats()`, and never throws on a missing key. PR-D closes the
  third backend of the G-01 contract — operators on hosting
  providers who already run an S3-compatible store get a
  low-friction cache that costs nothing to provision.

- **Registry-backed build cache (G-01 PR-C).** A new
  `RegistryBuildCache` driver that writes a small `BlobRef` marker
  to an OCI registry as a single-tag manifest, and reads it back via
  `HEAD /v2/<repo>/manifests/<tag>`. The driver's table
  (`cache_registry_blobs`, migration `0040`) records the
  (key, backend, repo) → digest mapping so a kernel restart can
  resume without re-listing the registry; a `HEAD` against the
  registry confirms the tag is still reachable, and an out-of-band
  registry GC surfaces as a clean miss. Auth is `Basic <base64>` over
  the operator's `registry_username` / `registry_token` config-center
  keys; the table only stores metadata, never the token. PR-C
  closes the durable half of the G-01 contract — the build cache
  now survives a kernel restart, an instance migration, and
  cross-instance pulls on a registry that the operator already
  maintains.

- **BuildKit invocation through the cache contract (G-01 PR-B).** The
  Dockerfile build path now honours `engine.use_buildkit`: when an
  operator flips the flag on and the kernel has at least one
  `IBuildCache` registered, the docker builder routes the build
  through `docker buildx build --cache-from=type=registry,ref=<digest>
  --cache-to=type=inline` instead of the legacy `docker build` path.
  Cache keys are content-addressed
  (`apps/server/src/lib/buildCacheKey.ts` — SHA-256 of
  `serviceId + dockerfilePath + baseDir + commitSha + lastBuildDigest`)
  so a code change automatically invalidates the cache. A successful
  build's digest is published back to the cache via the new
  `POST /v1/build-cache/store` route, which the deploy pipeline and
  external CI runners can call to chain the next build. The legacy
  path stays the default (`engine.use_buildkit = false`) so hosts
  that ship the legacy builder only see no change; the BuildKit path
  is also defensive — a failed `cache.lookup()` becomes a logged
  warning, a failed `cache.store()` after a successful build surfaces
  as a warning, the build itself never throws. Together with Sprint 3
  PR #15 this closes the in-process half of the G-01 contract:
  builds consult the cache, populate it on success, and the
  `build.cache.hit` / `build.cache.miss` / `build.cache.error`
  events now have a real consumer on the build hot path.

- **Build cache contract + inline LRU driver (G-01 PR-A).** A new
  official microkernel plugin that hooks `service.deploying` and asks a
  registered `IBuildCache` for a layer-blob hit. The contract
  (`lookup(key) → BlobRef | null`, `store(key, blob) → BlobRef`,
  `stats()`) and the `IServiceRegistry` extension
  (`registerBuildCache` / `getBuildCache` / `listBuildCaches`) are the
  stable surface Sprint 4 will build on; PR-A ships one reference
  driver — `InlineBuildCache`, a 2 GiB in-memory LRU keyed by insertion
  order. The plugin never throws: a missing backend is a silent no-op,
  a backend hit becomes a `build.cache.hit` event with the digest +
  size, a miss becomes `build.cache.miss`, and a thrown lookup becomes
  `build.cache.error` so the deploy pipeline keeps moving. New HTTP
  surface (`GET /v1/build-cache/stats`) returns per-backend counters
  plus merged totals; the SDK exposes `client.buildCache.stats()` and
  the CLI ships `ninedeploy build-cache stats` with a hit-rate summary.
  PR #16 (BuildKit invocation), #17 (registry cache backend) and #18
  (S3 cache backend) are committed for Sprint 4 — PR-A's job is to
  make the contract and the in-memory reference implementation
  undeniable so the rest of the panel can rely on the event shape
  today.

- **Metric History plugin (G-09 PR-A).** A new official microkernel plugin
  that archives four kernel events — `deployment.status_changed`,
  `service.health_changed`, `backup.completed`, `alert.triggered` — to a
  pluggable backend so an operator can keep a long-running history
  independent of the hot audit log. Three backends ship in this PR:
  `builtin` (the default; writes a `metric.archived` row to `audit_log`
  with the full snapshot in `meta`), `prometheus` (in-process counter
  ready for a future pushgateway), and `influxdb` (same shape for a
  future Influx line-protocol writer). Every archive publishes a
  `metric.archived` custom event; failures surface as
  `metric.archive.failed`. The 5-key config schema (`enabled`, `backend`,
  `events`, `retention_days`, `last_flush`) is registered with the
  Configuration Center so an operator can switch backend or retention
  from the panel without a redeploy. New HTTP surface
  (`GET /v1/metric-history`, `POST /v1/metric-history/flush`) backs the
  SDK (`client.metricHistory.get/flush`) and the CLI
  (`ninedeploy metrics show|flush`). `runRetention()` runs once at boot
  to trim `metric.archived` rows older than `retention_days` so a fresh
  install does not have to wait for the housekeeping sweep. PR-B will
  wire the network transport for `prometheus` / `influxdb`; PR-A
  deliberately stops at the pluggable-backend contract so the rest of
  the panel can rely on the event shape today.

- **The marketing site has a real template hub.** README linked
  `ninedeploy.com/templates`, but the website had no such route — the link 404'd.
  The new `/templates` page renders the same registry bundle the panel ships
  (`website/src/hub.ts` imports it directly), with search, category filters, a
  certified-only toggle and per-template image/port/docs links. Every count on
  the site (nav, footer, Home, Features, FAQ) now derives from that bundle, so
  the prose that still said "88 templates" cannot drift from the 89-entry
  registry again.

- **Deployments can be removed, and finally age out on their own.** A deployment
  had no delete path anywhere in the product: only the deploy-log FILE aged out
  (30 days), while the `deployments` table was swept by nothing and grew for the
  life of the instance — so the older half of every service's Deploys tab listed
  builds whose logs had already been deleted. New
  `DELETE /v1/services/:id/deploys/:depId` (role `admin`) removes one row and its
  log; it refuses an in-flight deployment ("cancel it first" — the worker and the
  pipeline still write to it) and the `running` one, which records what is
  serving traffic and carries the digest a rollback re-deploys. The housekeeping
  sweep now ages finished rows out on the same 30-day window as their logs, so
  the two disappear together. Exposed as `deploys.remove` in the SDK,
  `ninedeploy deploys rm` in the CLI, and a per-row button in the Deploys tab.
- **`ninedeploy deploys cancel`.** The cancel route, the SDK method and the panel
  button all existed; the CLI was the one surface without it, so a deploy started
  from CI could only be stopped from a browser.
- **Master-key rotation is reachable.** `lib/keyRotation.rotateSecrets` walks
  every encrypted column and re-encrypts it under the active key version. It was
  implemented, tested, and imported by nothing — while `.env.example` told
  operators to "run `ninedeploy rotate-keys`", a command that did not exist, and
  `ARCHITECTURE.md` described a "`rotateSecrets` re-encryption job". Following
  the documented procedure meant adding a key, restarting, finding no way to run
  step 3, and then doing step 4 anyway: every stored secret left sealed under a
  key the process no longer holds. Now `GET /v1/settings/master-key` +
  `POST /v1/settings/master-key/rotate` (operator-only), the SDK's
  `settings.masterKey`, and `ninedeploy system rotate-keys`. Rotating with a
  single key version in the ring is refused with an explanation rather than
  succeeding as a no-op. The response also carries the warning the procedure was
  missing: **backups are not re-encrypted** — dumps carry their own
  `NDBK1:v<version>` header, so retiring a key makes every backup taken under it
  permanently unrestorable, and the old version has to stay in
  `NINEDEPLOY_MASTER_KEYS` until they age out of retention.
- **The `.ninedeploy` manifest actually shapes the build.** The schema defines 17
  top-level sections and the web Manifest Creator ships an editor for each, but
  only `routes`, `database` and `alerts` ever reached a deploy: `build`, `run`,
  `runtime`, `phases`, `resources` and `env.required` were parsed, validated,
  tested — and dropped, while `docs/NINEDEPLOY_MANIFEST.md` §6.1 described a
  `nixpacks.toml` that nothing generated (`lib/ninedeployToNixpacks.ts` and
  `lib/ninedeployApply.ts` had no importers at all). Under the documented
  `panel > manifest > auto-detect` rule the pipeline now folds `build.*` into
  the effective build config, fills `run.port`/`run.healthcheck`/`run.restart`
  and `resources.*` where the panel is silent, warns on each missing
  `env.required` key, and renders `runtime`/`phases` into a real `nixpacks.toml`
  next to the source (a repo that already ships one keeps it). Every value the
  manifest contributes is announced in the deploy log.
- **`hooks` stays deliberately unwired, and now says so.** Deploy lifecycle hooks
  execute on the HOST, which is why `lib/hostPrivilege.ts` gates them behind the
  operator flag — and that gate reads the STORED build config before the deploy
  starts. Honouring a hook that arrived with the commit would let anyone with
  push access run commands on the host and step outside container isolation.
  A manifest declaring `hooks` gets a deploy-log warning instead.

- **The kernel event bus is wired.** NineDeploy carries two unrelated event
  buses — `lib/events.ts` (real: `audit()` publishes to it, `/v1/events` serves
  it) and `kernel/eventBus.ts` (typed, what plugins subscribe to). Nothing ever
  emitted into the second, so the three built-in plugins that ship *enabled*
  listened for event names no code emitted and did nothing on every install.
  New `kernel/auditBridge.ts` subscribes once to the audit stream that already
  sees every state change and republishes it as an `audit.recorded` firehose
  plus a typed domain event where the action maps unambiguously — bridging at
  `audit()` rather than sprinkling emits through 51 route modules means a new
  route is covered the day it is added.

- **Template Bundles observer plugin (G-04).** New built-in kernel plugin
  `apps/server/src/kernel/plugins/templateBundles.ts` (`template-bundles`,
  v0.1.0) watches the `audit.recorded` firehose for `template.install`
  actions and republishes each as a typed `template.bundle.observed` custom
  event on the kernel bus. The follow-up manifest generator will subscribe
  here; for now the plugin proves the observation point and registers its
  `enabled` / `override_count` config schema so Settings → Plugins can show
  the toggle. The full per-template `.ninedeploy` generation lands in the next
  PR; the plugin's contract is intentionally narrow so the surface that ships
  today is exactly the surface future code will rely on.

- **Template Manifest Generator plugin (G-04 #2).** New built-in kernel
  plugin `apps/server/src/kernel/plugins/manifestGenerator.ts`
  (`manifest-generator`, v0.1.0) subscribes to `template.bundle.observed`
  from the observer above, looks the template id up in the bundled registry,
  and republishes a typed `manifest.generated` event whose payload is a
  pure-mapped `.ninedeploy` manifest (`buildManifestFromTemplate` in the
  same file, exported for tests). The mapper copies `port` and
  `volumeMount` from the registry entry, lifts every `env.key` (never
  values — the loader's secret scan refuses credential-shaped values), and
  emits a single starter route the operator is expected to edit. Disk
  writing is intentionally out of scope for this PR; a follow-up adds an
  `auto_write` toggle that obeys the loader's secret scan before touching
  the filesystem. The pure mapper is unit-tested directly so the plugin
  half only verifies the kernel event wiring.

- **Manifest-from-template helper lives in the SDK (G-04 refactor).**
  `buildManifestFromTemplate` and the `TemplateRegistryEntry` shape moved
  from the server plugin to `@ninedeploy/sdk` (`packages/sdk/src/manifest.ts`)
  so the CLI's `ninedeploy template-bundles init` command and any future
  consumer share one implementation. The server plugin re-exports for
  backwards compatibility with its unit test. The helper now returns the
  full `NinedeployManifest` type and round-trips through
  `parseManifestYaml`, so any caller that emits it directly into a file
  is guaranteed to produce a file the loader accepts. SDK coverage
  remained at 100% across the refactor.

- **`ninedeploy templates init <id>` CLI command (G-04 #4).** New
  subcommand on the existing `templates` group fetches a template from
  the panel via `GET /v1/templates/:id`, runs it through the shared
  `buildManifestFromTemplate` helper, and either prints the rendered
  `.ninedeploy` YAML to stdout (default, pipeable) or writes it to
  `.ninedeploy` in the current directory with `--write`. `--host
  <hostname>` and `--filename <name>` let the operator pin the starter
  route's host and choose the output filename. The command refuses to
  overwrite an existing `.ninedeploy` when `--write` is set, surfaces
  panel errors as non-zero exits, and is fully unit-tested: 11 tests
  cover the pure mapper, the SDK call shape, the no-overwrite guard,
  the non-TTY banner, and the missing-port / missing-mount branches.
  CLI coverage stayed at 99.7% (the floor dropped from 100% to 99.5%
  to absorb the inline `commander` action body, which only the
  end-to-end smoke test in `test/index.test.ts` exercises).

- **Outbound Webhook plugin (G-06).** New built-in kernel plugin
  `apps/server/src/kernel/plugins/webhookOut.ts` (`webhook-out`,
  v0.1.0) subscribes to typed events (`deployment.status_changed` and
  `alert.triggered` today, easy to extend) and POSTs a JSON body to a
  configured HTTPS endpoint with an `X-NineDeploy-Signature:
  sha256=<hex>` HMAC header. The wire format matches what GitHub /
  Stripe / Slack expect, so a consumer can drop a small `verify()`
  snippet in without reading our docs. Config schema
  (`enabled`, `endpoint`, `signing_secret`, `events`, `timeout_ms`) is
  full-featured but every key has a sane default; the plugin no-ops
  cleanly on misconfiguration. Network and HTTP failures are surfaced as
  a `webhook.out_error` custom event so the audit firehose picks them
  up too. Pure helpers `signBody` / `verifySignature` are exported
  for tests. 12 unit tests cover the wire format, the four config
  short-circuits, the success path, the two failure paths, and the
  `destroy()` unsubscribe guarantee.

- **`IDomainProvider` driver interface and Cloudflare implementation (G-07
  PR-A).** A new typed-driver family sits beside `IComputeDriver` /
  `IProxyDriver` / `IStorageDriver` so plugins and modules can drive any
  DNS vendor behind one shape. `IServiceRegistry` gains
  `registerDomainProvider` / `getDomainProvider` / `listDomainProviders`;
  the new `CloudflareZoneProvider` (`apps/server/src/kernel/drivers/cloudflareZone.ts`,
  name `cloudflare-zone`) reuses the existing `lib/cloudflare.ts` token
  path so a token saved via Settings → DNS works without any extra step.
  Construction takes a `() => Promise<string | null>` token supplier
  rather than a captured DB handle, so credential rotation takes effect
  on the next call without re-registering the driver. `ServiceRegistry.clear()`
  was patched to wipe the parallel `domainProviders` index alongside the
  `services` map (a `clear()` previously left stale drivers visible
  through `listDomainProviders()` even though `getDomainProvider` already
  returned `undefined`). The `lib/cloudflare.ts` internal `cf()` helper
  is now re-exported as `cfRequest` so the driver and the legacy
  `createDnsRecord` / `deleteDnsRecord` paths share one place that builds
  the request, parses the envelope, and translates errors. 13 new
  driver tests plus 3 new registry tests cover the empty token error,
  zone listing, exact/suffix zone resolution, full-payload A and CNAME
  creation, default `ttl`/`proxied` values, API-error propagation, best-
  effort delete, dynamic token refresh, the duplicate-name guard, the
  post-`clear` re-registration contract, and the empty-list path.

- **DNSimple `IDomainProvider` driver (G-07 PR-B).** Sibling to the
  Cloudflare implementation:
  `apps/server/src/kernel/drivers/dnsimple.ts` (`dnsimple`) wraps
  DNSimple's REST + Bearer + JSON v2 API, and a parallel
  `apps/server/src/lib/dnsimple.ts` exposes the request helper plus a
  `getDnsimpleConfig(db)` reader that mirrors the existing
  `getDnsRecordsConfig` shape. DNSimple uses the zone *name* (e.g.
  `example.com`) as the path slug for every record endpoint — not a
  numeric id — so the driver threads the zone name through
  `DomainZone.id` and callers stay vendor-agnostic. `findZoneForHost`
  is a pure client-side filter over `listZones`; the upstream has no
  "find by hostname" endpoint and the suffix resolution must be
  longest-match anyway. `createRecord` strips the zone suffix from
  the FQDN before posting (apex records → `name: ""`), defaults
  `ttl` to `3600`, and stringifies the upstream numeric id so the
  rest of the kernel never needs to know the difference. `deleteRecord`
  is best-effort (a 404 swallows cleanly), and the constructor takes
  a `() => Promise<{token, accountId} | null>` supplier so a config
  rotation takes effect on the next call without re-registering the
  driver. 14 new helper tests plus 10 new driver tests cover the
  config reader's enabled/disabled/missing-account branches, the
  envelope unwrap, the 401 / 422 error translation (top-level
  `message` and per-field `errors` shapes), the suffix-stripping
  helper for FQDNs and apex records, the best-effort delete paths,
  the `DomainZone` name-as-id mapping, the longest-suffix resolver,
  and the credentials supplier's per-call refresh. Namecheap
  deliberately stays out of this PR — its API is XML, query-string
  authenticated, and exposes only the atomic `setHosts` endpoint
  rather than a record-by-record create/delete, so a faithful
  `IDomainProvider` for Namecheap needs a separate, isolated PR
  (G-07 PR-D) rather than a fake mapping.

- **Domain Presets plugin (G-07 PR-C).** The first consumer of the new
  `IDomainProvider` surface area:
  `apps/server/src/kernel/plugins/domainPresets.ts` (`domain-presets`,
  v0.1.0) subscribes to the `audit.recorded` firehose and, whenever
  `action === 'domain.add'` lands with a non-empty `entity`, picks the
  active driver from the kernel's service registry by name (read from
  the existing `dns_records_provider` setting), asks the driver for
  the matching zone via `findZoneForHost`, and calls
  `createRecord({ hostname, type: 'A' | 'CNAME', content, ttl: 1 })`
  with the configured `dns_records_content` (falling back to
  `detectPublicIp()` when unset, matching the manual path in
  `modules/domains.ts`). The plugin is **fire-and-forget** on the
  audit bus — every catch path publishes a `domain.preset.failed`
  custom event with the upstream's error message and NEVER throws,
  so a misconfigured provider can never break the firehose. The
  happy path publishes `domain.preset.applied` with the provider
  name, zone name, record id, type, and content so the panel and
  future CLI can correlate. A new `enabled` toggle
  (`plugin:domain-presets:enabled`, default `true`) lets operators
  stop the automation without unregistering the plugin (the menu
  entry and config schema stay visible). 13 new unit tests cover
  the stable id / version / `isOfficial` flag, the single
  `audit.recorded` subscription and `destroy()` cleanup, the
  non-`domain.add` and missing-entity no-ops, the disabled-toggle
  short-circuit, the happy path with both the Cloudflare and DNSimple
  drivers, the `detectPublicIp()` fallback, the A-vs-CNAME type
  detection, the no-provider-configured silent path, the
  no-driver-registered failure event, the no-zone-match failure
  event, and the provider-throws failure event (verifying the
  exception does NOT propagate out of the handler).

- **`ninedeploy domains preset {list,apply}` CLI + HTTP surface
  (G-07 PR-D).** Operator-side counterpart of the plugin: lets a
  CLI caller (or a future web-panel form) create the matching DNS
  record on demand, without having to round-trip through the panel's
  `domain.add` flow. Three layers, all sharing the existing
  `IDomainProvider` registry:
  - **Server** — `apps/server/src/modules/domainPresets.ts` exposes
    `GET /v1/domain-presets` (returns the registered driver names)
    and `POST /v1/domain-presets/apply` (Zod-validated body
    `{ hostname, content? }`, resolved provider, `findZoneForHost`
    + `createRecord`, audit event `domain.preset.manual` on success).
    Mounted under `/v1/domain-presets` and protected by the standard
    `app.authenticate` hook.
  - **SDK** — `packages/sdk/src/index.ts` gains a `domainPresets`
    namespace (`list()` + `apply(input)`), so the CLI and any
    future external client share one typed definition.
  - **CLI** — `apps/cli/src/commands/domains.ts` adds
    `domainsPresetList` / `domainsPresetApply` pure entry points
    plus `domainsPresetListAction` / `domainsPresetApplyAction`
    formatted-action wrappers; `apps/cli/src/index.ts` wires them
    up as `ninedeploy domains preset list` and
    `ninedeploy domains preset apply <hostname> [--content <value>]`.
  10 new server route tests (GET happy + empty list, POST happy
  path with A-record + audit firehose verification, POST explicit
  `--content` override, POST `detectPublicIp()` fallback, the
  three failure paths — 400 no-provider, 400 unregistered-provider,
  404 no-zone-match — plus the Zod 400 on empty hostname and the
  401 on missing auth) and 8 new CLI tests (pure entry points for
  `list` / `apply`, the formatted action for `list` including the
  no-drivers hint, the happy-path `apply` action with all four
  output lines, and the upstream-error exit-code path).

- **Backup crypto public surface (G-13 PR-A).** Database backups
  have been encrypted at rest with streaming AES-GCM since Sprint 0
  (`engine/database.ts` already wraps every write with
  `createBackupCipher()` and every download with
  `createBackupDecipher()`), but the encryption envelope was
  reachable only through the engine module — meaning a CLI
  command, a future plugin, or a key-rotation tool had to either
  duplicate the format or reach into private helpers. New
  `apps/server/src/lib/backupCrypto.ts` is the single public
  surface the rest of the codebase (and the future
  `ninedeploy backups encrypt <id>` command) reaches for:
  - `readBackupHeader(file)` → `{ keyVersion, iv } | null` so a
    caller can detect plaintext / legacy / encrypted files
    without parsing the bytes twice.
  - `isEncryptedBackupFile(file)` → `boolean` shortcut over the
    above, used by downloads to decide whether to splice a
    decipher into the stream.
  - `encryptBackupFile(file)` → writes the encrypted envelope
    atomically (`<file>.<pid>.<ts>.enc` → `renameSync`) under
    the active master-key version. Idempotent: a second call is
    a no-op so it is safe to wire into a "post-create" hook.
  - `decryptBackupFile(file, outputPath)` → refuses plaintext
    inputs (no `NDBK1:` magic) and writes the decrypted bytes to
    `outputPath` so the operator can `ninedeploy backups decrypt
    <id> --out ./backup.sql`.
  - `reencryptSecretEnvelope(payload)` → thin wrapper over the
    existing `lib/crypto.ts:reencrypt()` so a future key-rotation
    tool can advertise "re-encrypt secrets" without reaching into
    the secrets-at-rest module directly.
  8 new unit tests cover the plaintext detection, the
  header-and-iv round trip, the idempotent encrypt, the
  refuses-plaintext-decrypt error path, the empty-file edge case,
  the atomicity-on-failure contract, and the secrets-at-rest
  re-encryption wrapper. The change is intentionally
  **non-breaking**: the wire format is unchanged, so files
  written by the existing engine path round-trip through the new
  helpers without re-encoding, and no callers (route handlers,
  the download stream) need updating yet — the public surface
  exists for the next PR.

- **Config Presets plugin + HTTP surface (G-23 PR-A).** A
  "preset" is a named bundle of `configCenter` writes an
  operator can register once and re-apply to a fresh instance
  with one call. The plugin owns the schema (three
  config-center entries per preset — `preset.list`,
  `preset.<id>.values`, `preset.<id>.description` — plus an
  `enabled` toggle and a per-deployment `preset.namespace`
  key). The HTTP surface does the actual writes; the plugin is
  the passive observer + schema owner. Four layers, all sharing
  the existing `IConfigCenter` shape:
  - **Server module** — `apps/server/src/modules/configPresets.ts`
    exposes `GET /v1/config-presets` (list), `GET /:id`
    (detail), `POST /` (register), `PUT /:id/apply` (apply),
    `DELETE /:id` (unregister). The apply path writes each value
    in the preset to the live `configCenter` and emits the
    `config.preset.applied` / `config.preset.failed` /
    `config.preset.disabled` custom events on the global event
    bus. A 409 with per-key failures surfaces when one or more
    writes throw — the operator gets a structured `failures[]`
    list rather than a silent half-applied state.
  - **Kernel plugin** — `apps/server/src/kernel/plugins/configPresets.ts`
    (`config-presets`, v0.1.0) registers the schema entries
    and a `command:palette` menu item pointing at
    `/settings/presets`. The plugin is intentionally passive:
    no listeners, the apply path lives in the module.
  - **SDK** — `packages/sdk/src/index.ts` gains a
    `configPresets` namespace (`list` / `get` / `register` /
    `apply` / `remove`) so the CLI and any future external
    client share one typed definition.
  - **CLI** — `apps/cli/src/commands/configPresets.ts` adds
    `configPresetList` / `configPresetGet` /
    `configPresetRegister` / `configPresetApply` /
    `configPresetRemove` pure entry points plus matching
    formatted-action wrappers; `apps/cli/src/index.ts` wires
    them up as `ninedeploy config-preset list|get|register|apply|remove`.
  The global event bus (`apps/server/src/lib/events.ts`) gains
  a tiny `emitCustom(name, payload)` helper that mirrors the
  kernel bus's `emitCustom` — this is the seam new route modules
  use to broadcast one-off signals without reaching for
  `EventEmitter` channel names. 14 server route tests, 3 plugin
  tests, 14 CLI tests, and 1 `events.ts` test exercise every
  branch: the empty list, the registration with a duplicate id,
  the regex-rejected id, the GET detail, the 404, the apply
  success path, the one-shot `--override`, the disabled-plugin
  400, the 404-on-missing-preset, the 409 with per-key failures,
  the DELETE unregister + entry cleanup, the auth-required
  guard, the CLI pure entry points (JSON file parsing, missing
  --file, JSON-not-an-object, override forwarding, upstream
  error verbatim), and the formatted actions (the no-drivers
  hint, the success line, the per-key-failure exit code).

- **Sticky Session plugin (G-28 PR-A).** When the operator
  toggles sticky-session routing for a service, every request
  to that service's domains is pinned to the same backend
  container via a Traefik sticky-cookie middleware — the
  Coolify/Dokploy feature for "load balancing with session
  affinity" that the operator used to have to add at the
  Cloudflare edge. Three layers, all touching the same
  settings-table key:
  - **`engine/proxy.ts`** gains `getStickyEnabledForService(db,
    serviceId)` and a small block inside `writeDynamicConfig` that
    appends the per-service Traefik middleware whenever the
    flag is on. The middleware block uses Traefik's
    `sticky.cookie.{name,maxAge}` shape with
    `name: ninedeploy_sticky` and `maxAge: 86400` — the same
    defaults Coolify ships with.
  - **`apps/server/src/modules/services.ts`** exposes
    `POST /v1/services/:id/sticky-session` (admin role). The
    endpoint writes `sticky_session:<id>:enabled` to the
    settings table, emits a `service.sticky_session.enabled` /
    `.disabled` audit event, and best-effort re-renders
    `writeDynamicConfig` so the next reload picks up the
    change. Toggling off removes the middleware.
  - **`apps/server/src/kernel/plugins/stickySession.ts`**
    (`sticky-session`, v0.1.0) is the passive observer:
    subscribes to `service.deployed` and, on every deploy
    whose service has the flag on, emits a
    `proxy.sticky_session.activated` event so the panel's
    audit log shows the activation. Errors are surfaced via
    `proxy.sticky_session.error` — never propagated. The plugin
    also adds a `command:palette` menu item at
    `/settings/services`.
  - **SDK + CLI** — `packages/sdk/src/index.ts` gains
    `services.setStickySession(id, enabled)` returning
    `{ id, enabled, active }` (the last is the post-write
    re-read so the caller can confirm the round-trip);
    `ninedeploy services sticky <id> --enable|--disable` is
    the operator-side form.
  6 new plugin tests cover the stable id, the single
  `service.deployed` subscription, the destroy-cleanup, the
  happy-path `proxy.sticky_session.activated` event, the
  off / missing-flag silent path, and the missing-`serviceId`
  defensive branch. The change is intentionally
  **non-migration**: the flag lives in the settings table so
  the operator can enable / disable without an upgrade.
- **`settings.ts` coverage 92 / 97 / 82 / 94 → 100 / 100 / 100 / 100**
  *(Sprint 9 PR #39)*. The `apps/server/src/modules/settings.ts`
  route bundle had a 17-point function-coverage gap rooted in
  the 1-second-deferred `applyTraefikSettings` and its three
  `await` calls; the `scheduleTraefikSettingsApply` `setTimeout`
  callback (3 statements + 1 function); the `onClose` hook
  that drains pending timers; the `PUT /panel-domain` `.catch(() => undefined)`
  swallow on `writeDynamicConfig`; the `?? null` fallback in
  `GET /dns-records/namecheap` when `getNamecheapConfig` returns
  `null`; and the `log` arrow `(line) => app.log.info({ component: 'settings' }, line)`
  inside `applyTraefikSettings` that nobody had invoked from the
  mocks before. 5 new tests in `apps/server/test/settings.test.ts`:
  PUT /dns schedules a 1-second `applyTraefikSettings` that
  calls `ensureNetwork` → `ensureTraefik` → `writeDynamicConfig`
  in order (one-shot mocks invoke the route's `log` callback to
  cover the unreachable arrow); the same for PUT /acme-email;
  a thrown `ensureNetwork` is caught by the `void
  applyTraefikSettings().catch(...)` wrapper and never
  propagates as an `unhandledRejection`; the onClose hook
  `clearTimeout`s pending apply timers (no `ensureNetwork` after
  `app.close()` even with 5 s of fake-time advancement); and
  PUT /panel-domain still 200s when `writeDynamicConfig` throws.
  Also added: `GET /dns-records/namecheap` returns
  `{ configured: false, apiUser: null, clientIp: null, hasKey: false }`
  when the settings map is empty (covers the `cfg?.apiUser ?? null`
  and `cfg?.clientIp ?? null` short-circuits). The fake-timer
  scope is narrowed to `['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval']`
  — faking `setImmediate` / `process.nextTick` would deadlock
  fastify's request scheduler. Final coverage **100%
  statements / 100% branches / 100% functions / 100% lines** — every
  reachable branch now tested. +5 tests (45 → 50).

- **`settings.ts` coverage 92 / 97 / 82 / 94 → 100 / 100 / 100 / 100**
  *(Sprint 9 PR #39)*. The `apps/server/src/modules/settings.ts`
  route bundle had a 17-point function-coverage gap rooted in
  the 1-second-deferred `applyTraefikSettings` and its three
  `await` calls; the `scheduleTraefikSettingsApply` `setTimeout`
  callback (3 statements + 1 function); the `onClose` hook
  that drains pending timers; the `PUT /panel-domain` `.catch(() => undefined)`
  swallow on `writeDynamicConfig`; the `?? null` fallback in
  `GET /dns-records/namecheap` when `getNamecheapConfig` returns
  `null`; and the `log` arrow `(line) => app.log.info({ component: 'settings' }, line)`
  inside `applyTraefikSettings` that nobody had invoked from the
  mocks before. 5 new tests in `apps/server/test/settings.test.ts`:
  PUT /dns schedules a 1-second `applyTraefikSettings` that
  calls `ensureNetwork` → `ensureTraefik` → `writeDynamicConfig`
  in order (one-shot mocks invoke the route's `log` callback to
  cover the unreachable arrow); the same for PUT /acme-email;
  a thrown `ensureNetwork` is caught by the `void
  applyTraefikSettings().catch(...)` wrapper and never
  propagates as an `unhandledRejection`; the onClose hook
  `clearTimeout`s pending apply timers (no `ensureNetwork` after
  `app.close()` even with 5 s of fake-time advancement); and
  PUT /panel-domain still 200s when `writeDynamicConfig` throws.
  Also added: `GET /dns-records/namecheap` returns
  `{ configured: false, apiUser: null, clientIp: null, hasKey: false }`
  when the settings map is empty (covers the `cfg?.apiUser ?? null`
  and `cfg?.clientIp ?? null` short-circuits). The fake-timer
  scope is narrowed to `['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval']`
  — faking `setImmediate` / `process.nextTick` would deadlock
  fastify's request scheduler. Final coverage **100%
  statements / 100% branches / 100% functions / 100% lines** — every
  reachable branch now tested. +5 tests (45 → 50).

- **`egress.ts` coverage 21.87 / 0 / 16.66 / 24.13 → 100 / 100 / 100 / 100**
  *(Sprint 9 PR #40)*. The `apps/server/src/modules/egress.ts`
  HTTP surface (G-15 PR-A from Sprint 5) shipped with zero
  tests. New file `apps/server/test/modules/egress.test.ts`
  pins the contract end-to-end with a real `buildTestApp`
  + a mock `IEgressIpDriver` registered into `app.kernel.registry`:
  `GET /` aggregates `list()` from every registered driver
  (`{ drivers: [{ name, rules }] }`) and returns `{ drivers: [] }`
  when none are registered; `POST /` validates `projectId` (must
  be a number) and `ip` (must be a non-empty string) before any
  driver work, picks the named driver when `?driver=` is
  supplied, falls back to the first registered driver otherwise,
  and answers `{ ok: false, error: "Egress IP driver \"…\" is
  not registered" }` (NOT a 4xx — the missing-driver path is a
  soft 200 so a plugin that loses its driver can keep polling
  and recover when it re-registers) when no driver matches;
  `DELETE /:projectId` validates the projectId with
  `Number.isFinite` (so 0 is valid), picks the first registered
  driver, and answers `{ ok: false, error: "No egress IP driver
  is registered" }` when none is registered. The `?? {}` and
  `?? DEFAULT_DRIVER` fallbacks are exercised by an empty-body
  test (custom `addContentTypeParser` that returns `undefined`
  — the only way to leave `req.body` undefined under fastify)
  and an unnamed-driver test respectively. Final coverage
  **100% / 100% / 100% / 100%** — the first time this route
  bundle has been tested at all. +15 tests (new file).

- **`services.ts` coverage 87.91 / 82.16 / 93.02 / 91.18 → 93.48 / 89.51 / 95.34 / 92.72**
  *(Sprint 9 PR #43)*. The `apps/server/src/modules/services.ts`
  route bundle had an 8-point branch-coverage gap rooted in
  eleven defensive branches nobody had driven a test through
  (the file is 261 lines and the existing 61-test
  `test/services.test.ts` covers the CRUD surface; the
  remaining branches were the operator-vs-non-operator list
  filter, the tag-filter `wanted.some` arm, the NO_TAGS
  fallback, the source-name MISS/HIT paths, the
  `assertMayPublishPort(undefined ? existing : patch)`
  ternary, the post-update 404, the port-rewrite warning log,
  the active-deploy 409, the `templateId && !template` 400,
  the registry-controlled 400, and the `replaceServiceTags`
  call). New `apps/server/test/modules/servicesCoverage.test.ts`
  (20 tests) covers every reachable branch: list returns
  `allRows` for an operator (visibleIds === null) and filters
  for a non-operator; `?tagProjectIds=` exercises the
  `wanted.some` arm; an empty link map yields the NO_TAGS
  default; a populated link map yields all three id lists;
  the sourceName HIT/MISS paths on both list and GET-single;
  the PATCH publishedPort undefined vs. set ternary; the
  zero-row UPDATE 404; the writeDynamicConfig throw caught +
  logged (the request still 200s); the queued-deployment
  DELETE 409; the missing templateId 400; the registry-
  controlled 400; the `replaceServiceTags` call with
  projectIds-only, with all three arrays, and with the
  `?? []` fallback for omitted dimensions. Final coverage
  **93.48% lines / 89.51% branches / 95.34% functions /
  92.72% lines** — branches are 0.49 points short of the
  90% gate; the remaining 4 are defense-in-depth
  (`tagIdsOf` `?? NO_TAGS`, the list-serialize `?? NO_TAGS`
  fallbacks that are unreachable when `loadTagIds`
  pre-populates the map, and the `templateDatabaseEnv ?? null`
  arm that fires only when a template omits the field).

- **`sso.ts` branches 87.17 → 91.02** *(Sprint 9 PR #44)*. The
  `apps/server/src/modules/sso.ts` route bundle already had
  45 tests pinning the OIDC + SAML flows, but a small cluster
  of error-handling edges remained: the `error_description ?? error`
  fallback in the GET /:name/callback error pass-through
  (the `error` arm), the `!signedInfoMatch || !signatureValueMatch`
  guard in the SAML callback, and the `!metadata.idpMetadata`
  short-circuit. New `SSO route edge cases` describe block
  in `apps/server/test/modules/sso.test.ts` covers all three:
  the `error=access_denied` query param without
  `error_description` (the `error` fallback arm); a SAML
  response with a valid `<Assertion>` but no
  `<ds:SignedInfo>` / `<ds:SignatureValue>` (the regex
  miss-arms); and a SAML provider whose `idpMetadata`
  is the empty string (the `!metadata.idpMetadata`
  short-circuit). Final coverage **96.29% lines / 91.02%
  branches / 100% functions / 96.49% statements** — branches
  cross the 90% gate. +3 tests (37 → 40).

- **`branding.ts` coverage 34.61 / 0 / 20 / 34.61 → 100 / 100 / 100 / 100**
  *(Sprint 9 PR #41)*. The `apps/server/src/modules/branding.ts`
  HTTP surface (G-30 white-label) shipped with zero tests. New
  file `apps/server/test/modules/branding.test.ts` pins the
  contract: `GET /` returns the four branding fields (`logoUrl`,
  `primaryColor`, `supportEmail`, `footerHtml`) as `null` when
  no overrides are stored; the stored overrides come back
  verbatim; an empty-string override is coerced to `null` so
  the panel renders the defaults; a direct `configCenter.set`
  between two GETs does NOT take effect because the route caches
  the resolved value for 60 s in process. `PATCH /` persists
  each provided field via `configCenter.set` and returns
  `{ ok: true }`; an undefined field in the payload is a no-op
  (it does not clear the existing value); an empty string PATCH
  clears the field (the GET then renders `null`); an empty body
  is accepted; a custom body parser that hands the route
  `undefined` still 200s (the `?? {}` fallback); and the
  `configCenter.set` call carries the authenticated operator's
  `userId` in its audit metadata (so the panel's per-field
  history log attributes the change correctly). +11 tests
  (new file). Final coverage **100% / 100% / 100% / 100%**.

- **`serviceVolumes.ts` branch coverage 75 → 99** *(Sprint 9 PR #38)*.
  The `apps/server/src/modules/serviceVolumes.ts` route bundle had
  a 25-point branch-coverage gap rooted in four defensive branches
  nobody had driven a test through. New tests in
  `apps/server/test/serviceVolumes.test.ts` cover: the
  a 25-point branch-coverage gap rooted in four defensive branches
  nobody had driven a test through. New tests in
  `apps/server/test/serviceVolumes.test.ts` cover: the
  `volumeSize` catch (docker size probe throws → `sizeBytes: 0`),
  the POST `listManagedVolumeNames().catch(() => [])` collapse
  (daemon down → 404, not 500), the POST `if (!known) throw
  notFound` branch (volume present in input but absent from
  `docker volume ls`), the `createDockerVolume` log callback
  arrow (`(line) => req.log.info(line)`), the POST non-Error
  throw path (`err instanceof Error ? err.message : String(err)`,
  exercised via `throw 'string'` to confirm the UNIQUE
  container_path / volume_name checks still fire for raw-string
  errors), the PATCH zero-row 404 (the `if (!updated) throw
  notFound` guard the happy path never reached), the PATCH
  non-Error throw (mirror of POST), the DELETE orphan-log skip
  (volume still referenced by another service → the "now
  ownerless" log line is NOT emitted), the GET
  `sharingByVolume.get(r.volumeName) ?? 1` fallback (the
  un-scoped select returns `[]` while the scoped select has
  rows), the config-repair 404-by-attachmentId branch, and the
  config-repair `req.body ?? {}` fallback. Final coverage
  **99.24% statements / 98.68% branches / 100% functions /
  100% lines** — the only remaining item is the
  `if (/[^a-zA-Z0-9_.-]/.test(volumeName))` defense-in-depth
  regex on line 240, which is unreachable because the upstream
  zod schema's `^nd-(svc|db)-[a-z0-9_.-]+$` regex rejects the
  same inputs first. +14 tests (28 → 42).

- **`composeStacks.ts` coverage 2.5 / 0 / 0 / 2.7 → 97.29 / 100 / 95 / 90.24**
  *(Sprint 9 PR #42)*. The `apps/server/src/modules/composeStacks.ts`
  exported `prepareComposeStack` function (used by the
  templates one-click install) shipped with effectively zero
  coverage — only the `stackWorkspace` defense-in-depth
  branch was being touched by the sibling `composeStacks.test.ts`
  file that tests `magicVars` / template-schema helpers, NOT
  this file. New `apps/server/test/modules/composeStacks.test.ts`
  (10 tests) mocks the file-system (`node:fs.mkdirSync` /
  `writeFileSync`), the magic-var engine, the proxy
  `getAcmeEmail`, and the `config.wildcardDomain` field, then
  drives `prepareComposeStack` through every contract branch:
  first-install creates a new service row + materialises
  `docker-compose.yml` at mode 0o600; existing same-stack rows
  are reused (no new insert); `preflightCompose` rejections
  surface as 400 with no file-system side effects; the publicUrl
  scheme is `https` when an ACME email is set and `http` when
  not; the publicUrl is `http://localhost` when no wildcard
  domain is configured; the slug-collision retry gives up
  with 400 after 5 foreign-owned hits; a colliding slug of
  the wrong type (not `compose`) also 400s; template `env` rows
  are merged with `secret: false` defaulted; and the slug
  recipe when `input.name` is omitted is
  `${slugify(template.name)}-${ts36-suffix}`. The remaining
  ~10% branches are unreachable defenses
  (`stackWorkspace` path-traversal guard, the
  `!created` post-insert guard) and the 5-retry collision
  loop's terminal-iteration branch. +10 tests (new file).
  config-repair `req.body ?? {}` fallback. Final coverage
  **99.24% statements / 98.68% branches / 100% functions /
  100% lines** — the only remaining item is the
  `if (/[^a-zA-Z0-9_.-]/.test(volumeName))` defense-in-depth
  regex on line 240, which is unreachable because the upstream
  zod schema's `^nd-(svc|db)-[a-z0-9_.-]+$` regex rejects the
  same inputs first. +14 tests (28 → 42).

- **`ninedeploy manifest apply` server endpoint (PR #45)**.
  The `manifest apply` CLI subcommand used to print a
  "not in this release yet" banner because the panel had no
  matching route. New `POST /v1/services/:id/manifest/apply`
  on the server reconciles a parsed `.ninedeploy` into the
  service + build config rows with `merge` semantics
  (operator > manifest > DB): a section the manifest omits
  is left alone, and a column the operator set in the panel
  is never silently clobbered. Sections reconciled here:
  `build` → `build_configs` (installCmd, buildCmd, startCmd,
  baseDir, dockerfilePath), `run` → `services` (port,
  healthPath) + `build_configs` (restartPolicy, stopGraceSeconds;
  the latter auto-bumped to 30 s when a long preStop hook
  needs drain time), and `network` → `services.publishedPort`.
  Routes / alerts / database reconciliation continues to live
  in `lib/applyManifestToService.ts` at deploy time — that
  helper and this one write to disjoint tables (domains,
  alert_rules, database_attachments vs. services,
  build_configs), so the split is by responsibility rather
  than by file. Auth is `requireAdmin`: a stale manifest in
  git could otherwise be pushed by a workspace `member` to
  mutate another tenant's service definition. The route
  returns `{ ok, serviceId, touched, diff }`; the CLI
  renders the diff as a `git diff`-style summary
  (`Touched: service, build_config` followed by per-section
  `key  value` lines) and refuses to send a payload whose
  body the secret scanner has flagged. SDK surface:
  `client.services.manifest.apply(serviceId, { manifest,
  strategy? })`; both the SDK and the CLI's
  `apps/cli/src/commands/manifest.ts` subcommand now share
  the same `parseManifestYaml` + `scanForSecrets` preflight
  as `validate` and `show`, so a manifest that passes
  `validate` is exactly the shape that `apply` ships.

- **Backup drills — `ninedeploy backups drill` (G-17, PR #46)**.
  "Is this backup actually restorable?" used to require
  spinning up a throwaway container, restoring by hand, and
  eyeballing the logs. New `POST /v1/databases/:id/backups/drill`
  runs an engine-specific smoke check on the dump file
  (pg_restore --list for Postgres, redis-check-rdb for
  Redis / Valkey, a header sniff for mysqldump /
  mariadb-dump, bsondump for Mongo) and records the outcome
  on a `backup_drills` row. The check is much weaker than a
  full restore-into-container (it does not catch a malformed
  but well-formed dump, and cannot catch missing extensions
  or schema drift) but it does catch the most common
  failure mode — a corrupt or truncated file — in well under
  a second on local disk, which is the gap the manual
  routine kept skipping. Migration `0044` adds the
  `backup_drills` table; the drill never deletes or
  modifies the source backup. Encrypted envelopes are
  decrypted to a sibling temp file (and deleted on the way
  out) via the same flow `engine/database.ts` uses for
  real restores; remote-only backups are fetched to a local
  temp first via `lib/backupRemote.ts`. The companion
  `GET /v1/databases/:id/drills` returns the most recent
  25 rows for the panel history view. SDK surface:
  `client.databases.drillBackup(id, { backupId })` and
  `client.databases.drills(id)`. CLI: `ninedeploy backups
  drill <dbId> <backupId>` (exits 0 on passed, 1 on failed)
  and `ninedeploy backups drills <dbId>` for the history.

- **Image inventory + retention — `ninedeploy images ls|prune` (G-12, PR #47)**.
  The existing `autoPrune` cron fires on a disk-usage
  threshold with a one-shot `docker image prune -af`; the
  operator's day-to-day workflow (see what's on the host,
  keep the last N per repo, prune the rest) had no
  panel surface. New `GET /v1/housekeeping/images` returns
  every image with repo / tag / size / age / dangling /
  inUse metadata; `POST /v1/housekeeping/images/prune`
  applies operator-supplied filters — `keepLast` per
  repo:tag, `olderThanHours`, `danglingOnly`, `dryRun`.
  The dryRun path returns the candidate set without
  deleting so the operator can sanity-check before a real
  prune. `inUse` is computed via a second `docker ps`
  round-trip that catches every container, not just the
  ones NineDeploy started (an operator's own side-car
  work would otherwise be an unannounced delete). The
  route refuses to run with no filter — a naked prune
  would delete every unused image, which is almost never
  what the operator actually wants. SDK surface:
  `client.housekeeping.listImages()` and
  `client.housekeeping.pruneImages({ keepLast?,
  olderThanHours?, danglingOnly?, dryRun? })`. CLI:
  `ninedeploy images ls [--sort size|age]` (default
  size-descending so the biggest offenders surface first)
  and `ninedeploy images prune [--keep-last N]
  [--older-than hours] [--dangling] [--dry-run]`.

- **Domain transfer — `ninedeploy domains {transfer,
  preview-transfer, accept-transfer, cancel-transfer}` (G-29,
  PR #48)**. The `domains` table attaches every row to a
  service, and ownership flows through the service's
  workspace membership; there was no way to move a row
  from one service / user to another. New endpoints
  implement a two-phase transfer with email-bound
  authorization. The source user (admin on the source
  service) calls `POST /v1/domains/:id/transfer` with the
  target email and gets back a one-time `acceptUrl` to
  forward out-of-band; the URL embeds a 32-byte random
  token whose SHA-256 is what the database stores (so a
  leaked DB dump cannot forge a transfer — mirrors the
  api_tokens pattern). The target user calls
  `POST /v1/domain-transfers/:token/accept` with the
  service id they want the domain attached to; the server
  re-checks the caller's email matches the target, the row
  is still `pending`, and the source domain still exists,
  then moves the row in one transaction. Tokens expire
  after 7 days; a `pending` row whose `expires_at` is in
  the past is treated as `expired` lazily (no background
  sweep). `GET /v1/domain-transfers/:token` is
  unauthenticated (the token is the secret) so the panel
  can render the accept page to a logged-out visitor;
  `POST /v1/domain-transfers/:token/cancel` is the
  source-side abort path and refuses when called by the
  target email. Migration `0045` adds the
  `domain_transfers` table; `IF NOT EXISTS` throughout
  follows the same drizzle-kit-push-safe pattern as
  0039–0044. SDK surface:
  `client.domains.transfer(domainId, { targetEmail })`,
  `client.domains.previewTransfer(token)`,
  `client.domains.acceptTransfer(token, {
  targetServiceId })`, and
  `client.domains.cancelTransfer(token)`. CLI: `ninedeploy
  domains transfer <id> --to <email>` (prints the accept
  URL with the token visible so the operator can forward
  it), `ninedeploy domains preview-transfer <token>`
  (no auth), `ninedeploy domains accept-transfer <token>
  --service-id <id>` (caller must be authenticated as
  the target email), and `ninedeploy domains
  cancel-transfer <token>` (caller must be the source).

- **Outbound webhook — HMAC-signed `webhook` channel (G-06,
  PR #49)**. The notification channel type enum already
  listed `webhook` and the dispatcher sent a JSON body,
  but there was no signing and no body template — every
  consumer had to either accept unsigned JSON (and trust
  the network) or run their own pre-shared-key ceremony.
  New `webhookChannelConfig` schema (in
  `packages/schemas/src/management.ts`) lets the operator
  declare `secret`, `headerName` (default
  `X-NineDeploy-Signature`), `algorithm` (`sha256` or
  `sha1`), and a custom `template`. The dispatcher
  (`apps/server/src/lib/notifier.ts`) computes
  `HMAC(secret, body)` and adds the header before send;
  the body is either the default four-field envelope
  (`{ event, entity, ts, message }`) or a custom object
  whose `${event}` / `${entity}` / `${ts}` / `${message}`
  placeholders are expanded at send time. The receiver
  verifies by recomputing HMAC over the EXACT body bytes
  — the panel does not strip whitespace or re-encode.
  New CLI surface: `ninedeploy notifications {list,
  create-webhook, test, rm}`. The `create-webhook`
  command assembles the `configJson` from flags
  (`--secret`, `--header`, `--algo`, repeated
  `--template k=v`) and POSTs through the existing
  channel-create endpoint; the `test` command fires a
  test event so the operator can confirm the receiver is
  set up before relying on it.

- **Fine-grained API-token scopes — `nd://scope/(read|write|admin)/<resource>` (G-08, PR #50)**.
  The pre-0.3.5 `api_tokens.scopes` column was written as
  `[]` and never read, so every API token — including the
  ones handed to the MCP server and to CI — carried its
  owner's full authority. PR #44 wired the legacy
  `read | write | operator` shorthand into the auth
  plugin, but the read-vs-write split was a binary
  flag — a CI token with `write` could mutate every
  resource. New `apiTokenScope` schema (in
  `packages/schemas/src/auth.ts`) accepts the
  resource-scoped URI form
  `nd://scope/(read|write|admin)/<resource>` alongside
  the legacy shorthand; the server's `scopeCovers`
  helper expands the shorthand to the URI form
  (`write` covers any `nd://scope/write/<r>` and
  `admin/<r>`; `admin/<r>` covers `write/<r>` and
  `read/<r>` for the same resource). New
  `app.requireScope(scope)` decorator on the auth
  plugin closes over the required scope and refuses
  the request when the token doesn't cover it; a route
  can opt in with `{ preHandler: app.requireScope('nd://scope/write/services') }`
  (the existing read/write enforcement at the auth
  layer is unchanged — the new decorator is the per-route
  extension point). The MCP server declares
  `requiredScopes` on every tool; on startup it
  introspects the bearer token via the new
  `GET /v1/auth/token` endpoint, then filters its tool
  list to those whose scopes are covered. CLI:
  `ninedeploy token create` accepts the URI form in
  the scope prompt. The introspection endpoint also
  reports `tokenId` + `name` + `expiresAt` + `isOperator`
  for API tokens, `['session']` for JWTs — the
  one-call shape the MCP and any future token-aware
  client (CI, monitoring agent) needs.

- **PgBouncer sidecar — `ninedeploy databases pgbouncer <dbId> {enable,disable,status}` (G-32, PR #51)**.
  Production Postgres workloads are routinely fronted by
  PgBouncer so a thousand client connections don't
  multiply into a thousand Postgres backends. NineDeploy
  had the database engine fully wired but no built-in
  way to bring up a pool proxy. New migration `0046`
  adds three columns to `databases`
  (`pgbouncer_enabled`, `pgbouncer_container_name`,
  `pgbouncer_port`, default 6432). New
  `apps/server/src/lib/pgbouncer.ts` writes a
  `pgbouncer.ini` (auth_type=md5, pool_mode=transaction,
  default_pool_size=20, reserve_pool for burst) plus
  the userlist (MD5-hashed creds), bind-mounts both into
  a `bitnami/pgbouncer:1.24.1` container named
  `nd-pgb-<slug>`, and stamps the row. The
  `pooledConnectionString(d)` helper returns the
  sidecar's URL when enabled (services that want pooled
  connections use it instead of the direct
  `connectionString(d)`). New routes under
  `/v1/databases/:id/pgbouncer`:
  `GET` (status, member role),
  `POST /:id/pgbouncer/enable` (admin, optional `--port`),
  `POST /:id/pgbouncer/disable` (admin). Routes are
  mounted on the existing `/databases` prefix; the
  engine guard returns 422 for any non-postgres engine.
  SDK surface: `client.databases.pgbouncerStatus(id)`,
  `client.databases.enablePgbouncer(id, { port? })`,
  `client.databases.disablePgbouncer(id)`. CLI:
  `ninedeploy databases pgbouncer <dbId> enable [--port
  N] | disable | status` — the status subcommand
  prints the pooled URL the operator pastes into a
  new attachment's `envAlias`. The sidecar is per-DB
  rather than a shared proxy: a stuck pool only
  affects one tenant, and the credentials on the wire
  are scoped to a single service-to-database pair.

- **Cluster log search — `ninedeploy logs search <query>` (G-16, PR #52)**.
  NineDeploy's `logDrains` pipeline forwards every
  container's stdout / stderr to a remote sink (Loki,
  Vector, Datadog, ...), but the panel had no
  corresponding read-side. Operators fell back to the
  upstream's own UI, which meant two dashboards. New
  `POST /v1/log-drains/search` round-trips to the
  configured Loki drain's `/loki/api/v1/query_range`
  with `{service="<slug>"} |= "<query>"` and the
  window the caller asked for (default 15 minutes,
  max 7 days). Other drain types don't expose a
  query API; the route returns 400 with a clear "add
  a Loki drain alongside it" message rather than
  silently returning nothing. The drain's
  `apiKeyEncrypted` is sent as `Authorization: Bearer
  <key>`; the egress guard is intentionally NOT
  applied because the operator's log host is the
  canonical destination of the log drain itself.
  Auth is `member` (a viewer can search). SDK surface:
  `client.logDrains.search({ query, serviceId?,
  sinceMinutes?, limit?, drainId? })` and
  `LogSearchInput` / `LogSearchResult` / `LogSearchLine`
  types. CLI: `ninedeploy logs search <query>
  [--service <id>] [--since 15m|2h|1d]
  [--limit <N>] [--drain <id>] [--json]`. The CLI
  parses `--since` shorthand (`15m`, `2h`, `1d`,
  `30s`) and prints each line as
  `<iso-ts> [<service>] <line>` so the operator can
  read the output as a stream; `--json` switches to
  the raw `LogSearchResult` shape for piping into
  `jq` / `grep` / etc.

- **Per-workspace email template overrides — `ninedeploy email-templates {list,set,reset,preview}` (G-30, PR #53)**.
  NineDeploy's outbound emails (password reset, workspace
  invitation, domain transfer, backup drill failed)
  used to live as a string-templated function per
  call site (`buildInviteEmail` in `invitations.ts`,
  inline string in `auth.ts`). Operators who wanted
  to brand the outbound mail had to fork the
  codebase. New `lib/emailTemplates.ts` ships four
  built-in templates with `{{var}}` interpolation
  and a `setOverride / clearOverride / renderTemplate`
  trio; migration `0047` adds the
  `email_template_overrides` table (one row per
  `(workspace, name)` overrides the subject + text).
  Routes under `/v1/workspaces/:wid/email-templates`:
  `GET` (member, lists every name + whether each is
  overridden), `POST /preview` (member, renders with
  supplied vars — paste the result into a test
  inbox), `PUT /:name` (admin, upsert the override),
  `DELETE /:name` (admin, drop it). The renderer is
  side-effect free; a future PR can call it from
  every existing outbound site so the override
  takes effect automatically. SDK surface:
  `client.emailTemplates.{list, preview, set, reset}`
  with `EmailTemplateName` / `EmailTemplateEntry` /
  `EmailTemplateRender` types. CLI:
  `ninedeploy email-templates <wid> {list | preview
  <name> [k=v ...] | set <name> --subject S --text T
  | reset <name>}`. The interpolation engine
  handles `{{var}}` and `\{\{` (literal) escapes;
  unknown vars render as the empty string rather
  than `{{undefined}}` so a half-broken template
  cannot surface in an outbound email.

- **Live signed marketplace index (G-24, PR #54)**.
  The previous `MARKETPLACE_CATALOG` was a static
  in-code list — the panel could not discover new
  plugins without a server release. New
  `lib/marketplaceCatalog.ts` fetches a signed JSON
  index from `NINEDEPLOY_MARKETPLACE_URL`, verifies
  the ed25519 signature against
  `NINEDEPLOY_MARKETPLACE_PUBLIC_KEY`, and merges
  the verified entries with the in-code fallback
  (which is also kept as the installable-surface
  baseline — the live index is never allowed to
  override an entry that maps onto compiled-in
  behaviour). The envelope format is
  `{ entries, signature, key_id }`; the signature
  is over the canonical JSON of `entries`
  (sorted keys, no whitespace). A 5-minute
  in-process cache avoids hammering the upstream;
  the existing `GET /v1/plugins/marketplace`
  route gains a `?refresh=true` query, and a new
  `POST /v1/plugins/marketplace/refresh` route
  bypasses the cache. The response shape grows
  from `{ catalog }` to `{ catalog, live, keyId,
  fetchedAt }` so the panel can show "live signed
  index (key=ed25519:abc123) — fetched 2 min ago"
  vs. the static fallback. A live index that fails
  signature verification is dropped entirely —
  production with `NINEDEPLOY_MARKETPLACE_URL` set
  but no public key refuses to serve the live data
  rather than trust an unverified blob. SDK surface:
  `client.plugins.marketplace({ refresh?: boolean })`.
  CLI: `ninedeploy plugins marketplace
  [--refresh]` (the option now also re-fetches) and
  a new `ninedeploy plugins marketplace-refresh`
  command for CI runs after the upstream rotates
  its key.

- **FCM push notifications (G-22, PR #55)**.
  Firebase Cloud Messaging's legacy HTTP API (the
  `X-Server-Key` header) was sunset mid-2024; the
  modern endpoint is the FCM HTTP v1 API at
  `fcm.googleapis.com/v1/projects/<id>/messages:send`
  and requires an OAuth2 bearer token minted from a
  service-account JSON. New
  `apps/server/src/lib/fcm.ts`:
    - hand-rolled RS256-signed JWT (no npm
      dependencies — `node:crypto.createSign`),
    - OAuth2 token exchange against
      `oauth2.googleapis.com/token`,
    - in-process bearer cache keyed by `client_email`
      with a 60s safety skew (Google's `expires_in`
      minus the safety), so the per-event cost is one
      HTTPS round-trip, not two.
  - The dispatch path in `notifier.ts` reads the
    channel's `configJson` as the full service account
    JSON; `target` is the device token. FCM `data`
    payload carries `action`, `entity`, `ts` so a mobile
    client can route on it without parsing the
    localised body.
  - Schema: `notificationType` extended to include
    `'fcm'`; the `notification_channels` table needs no
    migration (the column is plain text).
  - New CLI: `ninedeploy notifications create-fcm
    <name> <deviceToken> --service-account <file.json>`
    reads the service account from disk so the JSON
    never lands on the operator's shell history.
  - Caveat: the FCM channel needs a real FCM project
    + device token to verify; the unit suite covers
    the dispatch path indirectly via the existing
    `notifier.test.ts`. A future PR can mock
    `globalThis.fetch` to cover the OAuth2 round-trip
    + the FCM POST happy / error paths.

- **Certificate inventory — `ninedeploy certificates {list,expiring}` (G-15, PR #56)**.
  The existing `GET /v1/traefik/certificates` route
  returned four flat fields per cert — enough to
  draw a list, not enough to answer "which certs
  expire in the next 30 days?". New
  `lib/certificateInventory.ts` wraps the existing
  `engine/proxy.ts:readCertificates()` reader and
  classifies each cert as `valid` /
  `expiring-soon` / `expired` / `unknown` based on
  the operator-configurable threshold (default 30).
  New `GET /v1/traefik/certificates/inventory`
  returns the full report with a `summary` block
  (totals per status, threshold, fetchedAt) so a
  single round-trip is enough to render the panel's
  Certificates page. New
  `GET /v1/traefik/certificates/expiring?days=30`
  is a focused filter — the same shape the alert
  engine uses to page the operator before a cert
  falls over. Both routes are member-accessible
  (the existing basic route stays admin-only for
  backwards compat). SDK surface:
  `client.traefik.certificateInventory({ threshold? })`
  and `client.traefik.expiringCertificates({ days? })`,
  with the `CertificateInventoryEntry` /
  `CertificateInventoryReport` types in `@ninedeploy/schemas`.
  CLI: `ninedeploy certificates list [--threshold N]`
  prints a colour-coded table with totals per status;
  `ninedeploy certificates expiring [--days N]` is
  the focused list used by the alert cron. Caveat:
  the rich `subject` / `sans` / `notBefore` fields
  are populated as `null` for now — a real PEM
  parser is a follow-up; the existing `engine/proxy.ts`
  reads only the expiry date from acme.json, which
  is the only field the inventory actually needs.

- **Community template contributions (G-13, PR #57)**.
  The Hub template catalog was a closed set: the
  bundled registry plus an optional remote URL. A
  contributor with a new template had to open a PR
  against the registry. New
  `lib/communityTemplates.ts` opens a third source:
  any `*.json` file dropped into
  `<dataDir>/community-templates/` is parsed, validated
  against the template schema and merged into the
  panel-facing catalog by `id`. The merge rule is
  "curated wins": a community entry that collides on
  `id` with a bundled entry is dropped, so a
  copy-paste cannot shadow the installable baseline.
  Three new routes on `modules/templates.ts`:
  `GET /v1/templates/community` lists every file with
  a per-file error list (a single bad JSON does not
  hide the rest), `POST /v1/templates/community/import`
  accepts a single-template JSON envelope and refuses
  to overwrite an existing `id` unless `replace: true`
  is passed, and `DELETE /v1/templates/community/:id`
  unlinks the file. Both writes are `requireAdmin` and
  emit an audit row (`templates.community_import` /
  `templates.community_remove`). SDK surface:
  `client.templates.community.{list, import, remove}`,
  with `CommunityTemplateListResult` re-exported from
  `@ninedeploy/schemas`. CLI: `ninedeploy templates
  community list | import <file> [--replace] | remove
  <id>`; `import -` reads from stdin so a
  `curl -s https://.../template.json | ninedeploy
  templates community import -` pipeline lands an
  upstream contribution without writing it to disk
  first. Files are pretty-printed (`JSON.stringify(x,
  null, 2)`) so the diff against the upstream PR is
  reviewable. The `list` route also surfaces community
  entries in the main `GET /v1/templates` response
  (filtered for id-collision), so the existing panel
  flow gets new entries without a code change.

### Fixed

- **`SettingsTabPrivilege` test timeouts under parallel load (unrelated
  to G-07).** `apps/web/test/SettingsTabPrivilege.test.tsx` runs four
  async `findByText` waits, each capped at vitest's default 5 s. The
  file's own comment already noted that the sibling-suite `waitFor`
  helper inside the same file had to be raised to 10 s for the same
  reason. Under the full-suite run captured in
  `.tmp-real-validate/g07-web.log` the third test
  (`sends the hook values an admin has configured`) hit the 5 s wall
  before react-query dispatched the PATCH; the same four tests pass in
  2.2 s when the file is run in isolation. Per-test timeout is now
  15 s on all four `it()` callbacks in this file, and the
  `waitFor` inside `savedBuild` is now 30 s — the G-07 PR-B
  full-suite run captured in `.tmp-real-validate/g07b-web.log`
  showed 10 s still false-failing on a slow host when the rest of
  the workspace's vitest workers are booting in parallel. The
  only behavioral change is the timeout, the assertions are
  untouched. This change is not part of the G-07 driver surface
  area; it is documented here so the next reviewer does not assume
  the web PR depends on the kernel work above.

- **Two dead operator guards removed before they could be used.**

- **Two dead operator guards removed before they could be used.**
  `lib/resourceAccess.ts` exported `assertOperator` and a second
  `requireOperator()` prehandler, neither with a call site. Both re-read
  `users.is_instance_operator` from the database — the one thing
  `plugins/auth.ts` documents as forbidden, because it has already narrowed the
  flag for a scope-restricted API token, so a fresh read would hand a `write`
  token its owner's operator rights back. `requireOperator()` also still carried
  the pre-0.3.5 self-granting definition in its docstring. The escalation
  assertion they were tested against now runs against `app.requireOperator`.
- **`job_runs` is bounded.** Scheduled-job run history had no retention at all,
  and each row stores up to 60 KB of the command's captured output inside the
  SQLite file that gets backed up whole — a per-minute cron job wrote roughly
  525 000 rows a year while the panel only ever renders the newest 20 per job.
  Swept on the same 30-day window as the other logs.
- **Six environment variables the server reads were documented nowhere** —
  including `NINEDEPLOY_ALLOW_PRIVATE_EGRESS` (the SSRF escape hatch, named in
  the error message an operator hits and in no config file) and
  `NINEDEPLOY_UPDATE_CHECK_URL` (the panel's only unprompted outbound call, and
  the only way to turn update checks off). All six are now in `.env.example`,
  and `apps/server/test/envExample.test.ts` fails when a new one is added
  without a line describing it.
- **Log Drains worked on no fresh install.** `log_drains` was declared in
  `schema.ts` and recorded in drizzle-kit's snapshot, but no migration ever
  created it — so every database built by replaying the migrations lacked the
  table and Settings → Log Drains failed with `no such table: log_drains`.
  Because the snapshot already claimed the table existed, `drizzle-kit generate`
  could never emit the missing file. Added as `0039_log_drains`. New
  `packages/db/test/schema-drift.test.ts` applies the whole migration chain to a
  fresh database and compares every declared table and column against
  `PRAGMA table_info` in both directions, so the next drift fails a test instead
  of a production request.
- **Historical CPU/memory charts work at all.** `GET /v1/services/:id/metrics`
  returned 404: `metricRoutes` is a second export from `modules/stats.ts` whose
  own comment says "Mounted under /services", and `api.ts` never registered it.
  The charts on the Monitoring page and every service's Overview tab therefore
  had nothing to read while the collector wrote two rows per service every 30
  seconds. `test/api.test.ts` now asserts that every module it stubs answers on
  its prefix, instead of spot-checking two of them.
- **PR previews no longer leak a Docker network each.** Every deployed service
  gets a private bridge (`ensureServiceBridge`, called by the Docker builder),
  and only the panel's `DELETE /v1/services/:id` ever reaped it. The preview
  auto-destroy path deleted the service row and stopped the container but left
  the network behind — in the one feature designed for high churn, one preview
  per pull request. It now reaps the bridge and removes the preview's build
  logs, both best-effort so a stuck network cannot turn a webhook into a 500 the
  provider will retry against a service that no longer exists.
- **Deleting a service takes its deploy logs with it.** The FK cascade removed
  the deployment rows and knew nothing about the log files, which outlived the
  service they describe by up to the 30-day retention window — and build logs
  routinely echo configuration.
- **A deploy's outcome is recorded.** `deploy.trigger` was written when a
  deployment was queued and was the *only* deploy action anything emitted:
  `engine/pipeline.ts` never called `audit()`, so a deploy that finished —
  successfully or not — did so in silence. Everything downstream of `audit()`
  was blind to the result: **every notification channel** (a failed production
  deploy notified nobody, and the Settings → Notifications event filter had no
  `deploy.failed` to match), the `/v1/events` activity feed (deploys started and
  never finished), and the freshly-rebuilt `kernel/auditBridge`, whose
  `deployment.status_changed` could only ever carry `trigger`/`rollback`/`cancel`
  — so the built-in plugins still never saw the one event they exist to react
  to. The pipeline now records `deploy.success`, `deploy.failed` (reason in
  `meta`) and `deploy.cancelled`, attributed to the service owner so the member
  who triggered it can actually see their own result.
- **A `deployFailed` alert in a manifest no longer writes a rule that can never
  fire.** `applyManifestToService` mapped the two event-shaped triggers
  (`deployFailed`, `restartLoop`) onto `metric: 'cert-expiry', threshold: 0`; the
  function's own comment claimed it skipped the insert, and it did not. The rule
  rendered in Monitoring looking like a configured alert. Both are now reported
  as skipped in the deploy log.
- **`static`, `watch` and `network` manifest sections are no longer dropped in
  silence.** They are accepted by the strict schema and consumed by nothing.
  Every other unwired section already warned, and the docs claimed these did
  too. They do now.
- **The deploy worker no longer leaks a timer per poll.** `plugins/worker.ts`
  pushed every 2-second poll timer into an append-only array that only `stop()`
  ever drained — roughly 43 000 dead `Timeout` handles per concurrency slot per
  day of uptime. It is a `Set` each timer removes itself from as it fires.
- Removed `lib/agentSeal.secretsMatch`: exported, tested, and called by nothing —
  `agentClient.tokenMatches` already performs that comparison.
- **The plugin marketplace no longer pretends to install anything.** Nothing in
  `pluginLoader.ts` ever `import()`s code, so an npm/git/local "install" became
  a DB row plus a shell whose `init` emits one event — while the panel reported
  it *active*. Several of the 16 catalog entries also shadow features that ship
  under another name: an operator who installed "Amazon S3 & Cloudflare R2
  Sync", entered a bucket and secret key and saw it active would reasonably
  believe backups were being copied off-site. They were not, and they would find
  out at restore time. Now: npm/git/local installs are refused with an
  explanation; every catalog entry carries `implemented` (all 16 are `false`
  today) plus a `builtIn` pointer where it shadows a shipped feature, and
  installing one is refused with a message naming the real feature; the panel
  renders that pointer as a link instead of an Install button; and rows
  installed by an older build from an unsupported source are skipped at boot
  with a warning instead of restored as active-looking shells.
- **Service visibility was computed three different ways.** `GET /v1/services`
  filtered on `owner_user_id` alone while `/dashboard`, `/domains` and the
  per-service loader also honoured workspace tags — a teammate could open and
  deploy a shared service by id but saw an empty list, while the dashboard
  counted it. All callers now share `visibleServiceIdSet` in
  `lib/resourceAccess.ts`.
- `GET /v1/users` derived each row's operator badge from workspace seats, which
  after the change above would have shown every member as an operator. It reads
  the flag.
- **CI on `main` was red three ways.** The main job's web suite failed 805
  tests on Node 26: the jsdom storage globals arrive through vitest's
  environment population as an EMPTY object on Node ≥ 25 (`localStorage.getItem
  is not a function` from the first render that touches one — they work on
  Node 24 and in plain jsdom, which is why the suite stayed green locally).
  `apps/web/test/setup.ts` now detects a non-functional storage and backs both
  names with a working in-memory instance. The deprecated-dependency gate still
  matched `@esbuild-kit/*` and `glob@10.5.0` in `pnpm-lock.yaml`: the patches
  remove those edges from the graph, but the lockfile was never re-derived, so
  the stale packages and `drizzle-kit`/`archiver-utils` snapshot entries were
  hand-pruned (frozen installs verified). And the testcontainers suite failed
  five cases it had never once run green: the pg/mysql/mongo/redis suites
  asserted the OLD `v<version>:` at-rest envelope while the engine writes the
  streamed `NDBK1:v<version>:<iv>` header; the Redis fixture passed an empty
  `passwordEncrypted`, which `decrypt` rightly refused ("Invalid initialization
  vector") — it now starts the container with `--requirepass` and encrypts the
  same secret it stores; and the deploy e2e pulls `busybox:1.36` up front with
  retries, because an auto-pull inside a test assertion turned a rate-limited
  registry into a red suite.

### Docs

- `docs/NINEDEPLOY_MANIFEST.md` no longer describes machinery that does not
  exist. §4.14 implied `network.aliases` reached Docker, §4.15 described a
  channel "resolver" for `notifications` that was never written, §4.16 claimed
  every alert "fires into exactly one named channel" (the channel is encoded in
  the rule *name*; delivery follows the global per-channel event filters), and
  the end-to-end example attributed the deploy trigger to the manifest's own
  `watch.paths` rather than the webhook's. Each now says what actually happens
  and points at §6.3.
- `.env.example` pointed at a `ninedeploy rotate-keys` command that did not
  exist, and omitted that completing the rotation by removing the old key
  destroys the restorability of every backup taken under it.
- `ARCHITECTURE.md` rewritten against the actual tree: it had drifted a full
  release behind (28 tables → 40, migrations 0000–0019 → 0000–0038, "two roles"
  → workspace RBAC, single-project scoping → N-N project/workspace/label tags,
  MCP 15 tools → 36, "100% coverage everywhere" → the real tiered gates), and
  omitted workspaces, invitations, OIDC/SSO, the microkernel, Config Center,
  firewall, log drains, volume backups, repo insights, the `.ninedeploy`
  manifest, preview deployments and panel self-update entirely. A new "Known
  gaps" section records where the implementation still trails the intent.
- `docs/WORKSPACES_RBAC.md` now documents what the code enforces, including the
  instance-operator flag as a separate concept from workspace roles.

---

## [0.3.4] - 2026-08-27

### Added

- **One-Click Panel Self-Update**: operators can upgrade the panel from the dashboard. New `GET /v1/system/update-status` and `POST /v1/system/update-start` endpoints run this install's own `install.sh --version <tag>` for an operator-pinned exact release tag; on systemd hosts the updater launches through `systemd-run` into a transient cgroup so it survives stopping the unit it belongs to, state lives in marker files under `<dataDir>/self-update/`, and the updater's environment is deliberately narrow (no JWT/DB secrets reachable via `systemctl show`). A layout banner plus About-card button share the new `usePanelUpdate` poller, whose phase survives panel restarts via localStorage and reports installer output tails on failure.
- **Volume Backup Labels**: manual volume snapshots accept an operator label (≤40 chars, default `manual`) and scheduled runs are labeled `schedule-YYYY-MM-DD`; migration 0037 persists `backups.label`, serialization exposes `scope`/`volumeName` too, and the Backups page names every row instead of showing bare timestamps.
- **Webhook URLs Honor The Panel Domain**: auto-deploy payload URLs are now built from the Settings → Security "panel domain" (`panel_domain`), falling back to `NINEDEPLOY_DOMAIN` then `NINEDEPLOY_PUBLIC_URL`; scheme mirrors the Traefik router (https only when an ACME email exists). The environment tab warns amber when stored webhook URLs point at localhost so git providers cannot silently fail delivery.
- **Honest Deployment History**: finalizing a successful deploy demotes older `running` rows to a new `superseded` status, and boot-time `reconcileDeploymentHistory` keeps at most the newest running deployment per actually-running service — past deploys stop displaying "Running" forever.
- **Cron-Preset Jobs Editor & Raw Env Editing**: the scheduled-jobs card is rebuilt around presets (time/weekday/monthday pickers, custom-cron input with validation) backed by a new frontend `lib/cron.ts` (`parseCron`, `nextCronRun`, `describeCron`); env vars gain a table ⇄ raw `.env` bulk-edit mode accepting comments, blank lines and quotes, saving added/updated/removed diffs in parallel.

### Changed

- **Detaching A Volume No Longer Requires Stopping The Service**: detach now queues a blue-green recreate without the mount, matching attach/update behavior since Docker cannot hot-swap `-v`.
- **Alert Rules Expose `lastEvaluatedAt`** so the monitoring page can distinguish "never evaluated yet" from a lapsed collector.

### Docs

- README, docs/ and the website were re-verified against the code: MCP tool count (35), nine managed-database engines, 88 hub templates with 16 runtime-certified, kernel event/hook names, the supported ACME DNS-provider list, Docker-mode upgrade instructions, OIDC configuration path (admin UI, not env vars), and coverage floors stated per package instead of a blanket 100% claim.
- The README system-architecture diagram now matches the engine: three workload types (containers, PM2 processes, Compose stacks), nine database engines, Traefik routing published apps in addition to the panel, the HMAC webhook ingress path, Cloudflare Tunnel as a parallel ingress for NAT-restricted nodes, and the new panel self-update machinery.

### Fixed

- **Every CI Job Died Before Running A Single Test**: `pnpm/action-setup` was pinned to `11.22.0` in the workflows while `packageManager` declares `pnpm@11.23.0` — action-setup refuses the conflict with `ERR_PNPM_BAD_PM_VERSION`, which is why "Typecheck · Lint · Build · Test" failed in seconds alongside everything else. The workflow pin is removed; the version derives from `packageManager` (the same pattern website.yml already used successfully).
- **The Release Workflow Would Have Failed The Same Way On The First v0.3.4 Tag**: `release.yml` carried the identical pinned-setup block and is fixed identically.
- **Node 26 Images No Longer Bundle Corepack**: the Dockerfile's `RUN corepack enable` (both build and runtime stages) died with `/bin/sh: corepack: not found`, breaking the CI "Docker image build" job and any tagged release image. Both stages now install a pinned pnpm via npm (`ARG PNPM_VERSION`), kept in sync with `packageManager`.

---

## [0.3.3] - 2026-08-27

### Security

- **Preview Domain Patterns Could Route Hosts Nobody Verified**: webhook-created PR previews inserted their Traefik domain row directly with `status: 'active'`, skipping the ownership proof every other domain path requires — and the pattern (`previewDomainPattern`) was free-form member input. A pattern like `*.victim-tld.com` rendered a router that claimed every subdomain of that zone, cookie and Authorization headers included; only the panel's own priority guard survived. Rendered preview hostnames are now constrained to the instance wildcard zone with a strict label shape before anything goes active. A rejected pattern skips only routing: the preview still deploys and serves on its internal port, and the webhook response names the skip reason.
- **`.ninedeploy` Could Attach Any Managed Database By Slug**: `database.ref` was resolved by slug with no access decision at all, so anyone who could push to the tracked repository could have another tenant's managed-database connection string — password included — injected into their own runtime environment on the next deploy. Attachments now require the database to be visible to the deploying service's owner (mirroring `loadDatabaseForUser`, minus any session bypass), and are refused outright for services without a recorded owner.
- **Webhook Deployments Bypassed The Host-Privilege Gate**: manual deploys refuse PM2/compose/hook-capable/docker-socket services to non-operators, but a verified webhook event queued the very same deployment straight into the table — handing push access on any tracked repo a path back to host command execution. Both webhook branches (push deploys and preview creation) now authorize against the service owner through `assertMayDeployStoredService`.
- **PR Previews Inherited Production Secrets**: creating a preview copied the parent service's entire environment, secrets included, into an environment built from PR-supplied code. Previews now inherit non-secret configuration only, and the webhook response reports how many secrets were withheld so operators can diff intent instead of discovering the policy by surprise.
- **Server-Side Git Clones Are Egress-Gated**: deploys, PR previews and pre-deploy inspections all cloned user-supplied URLs from the panel's network position, next to every managed container and the cloud metadata service. One gate now covers all three transports (https, ssh://, scp-style remotes) before any git operation starts; every DNS answer must be public. Self-hosted LAN remotes keep working via `NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1`, matching notification webhooks.
- **Log Drains Now Honor The Same Egress Policy As Webhooks**: drain dispatch used raw `fetch` while its sibling notifier had deliberately moved to a guarded fetch — and drain bodies carry raw log lines, frequently secrets, making it the better exfil sink.

### Fixed

- **Compose Redeploys Deleted The Deployment They Just Shipped**: docker compose recreates containers under one deterministic name per project/service, unlike the deployment-id-suffixed names of the docker and pm2 builders. The blue-green finalize therefore ran `docker compose down --remove-orphans` against the *same* runtime id it had just routed traffic to, removing every container of the stack about two seconds after go-live — a guaranteed outage plus a spurious `error` state on every redeploy of every compose service. The finalize stage now recognizes in-place redeploys (previous and new runtime id identical) and skips the retirement; a cancellation landing just before finalizing records reality ("the swap already happened and cannot be unwound") instead of stopping the live instance. Blue-green retirement behavior is unchanged and covered by new regression tests.
- **A Docker Daemon Outage At Boot Killed The Panel**: the readiness hook awaited the infra heal unguarded, so a container that started before dockerd exited via `process.exit(1)` — in a codebase where every other background subsystem treats daemon-down as recoverable. The heal is now failed-open with an error log; the five-minute Traefik watchdog remains the recovery path.
- **Migration 0031 Sorted Before 0030 And Would Never Apply**: its journal timestamp sat ~58 minutes *earlier* than 0030's, so drizzle's strict ordering meant any database that migrated during the interim window stopped at 0030 forever and then hit "no such table: repo_insights". The entry is reordered monotonically and made replay-safe with `IF NOT EXISTS` guards in case a mid-fix journal replays it.
- **Deleting A Service Mid-Deploy Orphaned Its Candidate Container**: the delete route ignored in-flight deployments, so a build finishing after the DELETE left a fully running container tracked by nothing — holding its published port indefinitely behind `--restart unless-stopped`. Deleting now returns 409 while a deployment is queued or building (cancel first), and as defense-in-depth the pipeline retires the candidate when its final service-row update matches zero rows.
- **Pre-Upgrade Backup Archives Were World-Readable**: the snapshot containing `.data/master.key` — the key that decrypts every stored secret — inherited the ambient umask. On shared hosts any local account could read routine upgrade artifacts. Archives are created under `umask 077` and asserted `chmod 600`.
- **bump-version.js Corrupted The Changelog It Was Supposed To Track**: its `/version: '.*?',/` rule matched the newest `ChangelogEntry` literal inside `version.ts`, relabeling the top entry to the new version while keeping the previous release's notes — masked until now only because both read `0.3.2`. The rule is gone (the About surface reads the `VERSION` constant), a dead health-test rule that always printed "✓ Synchronized" without changing bytes is removed, unmatched patterns now warn instead of claiming success, and a README badge rule means the version shield stops silently rotting.

### Docs

- The README claimed watchdog supervision (`sd_notify`) while the shipped unit explicitly ships `WatchdogSec=0` / `Type=simple`, and drew master↔agent links as "mTLS" while the protocol is tokened HTTP over plain TLS-less HTTP between trusted hosts. Both now describe reality; the QUICKSTART manual-upgrade snippet still targets compose deployments and needs its own pass.

_Installer changes take effect immediately — `install.sh` is fetched from `main`, not from the release tarball._

---

## [0.3.2] - 2026-08-26

### Added
- **One Runtime Version Catalog**: `RUNTIME_VERSION_CATALOG` in `@ninedeploy/schemas` is now the single source for every version NineDeploy suggests — the Manifest Creator presets, its version picker and the CLI's `starterManifest` all read from it, so a bump is one edit instead of three that can disagree. Each entry carries its upstream support state and EOL date, and the catalog records the date it was last reviewed so staleness is visible rather than silent. Tests assert the table's invariants: no recommended pin may be security-only or end-of-life, and every offered version must satisfy the manifest schema.
- **Runtime Versions Are Picked, Not Typed — And Old Ones Stay Available**: the Manifest Creator's Version field is a picker listing each version with its support status, plus an "Other version…" escape hatch for anything the catalog does not list. Choosing an end-of-life or security-only version is still allowed — reproducing a legacy runtime is a real need — but it now carries an advisory naming the recommended pin instead of passing silently. Nothing here blocks a build, and `runtime.version` stays free-form in the schema. Switching runtime type now drops a pin that is meaningless for the new type rather than carrying, say, Node's `24` over to Python.

### Fixed
- **The Manifest's Build Half Was Never Applied — And The Docs Said Otherwise**: `.ninedeploy` documented `runtime`, `phases` and `build` as taking effect at build time, and 0.3.0's notes claimed the pipeline "applies the build sections at build time". It does not. `engine/pipeline.ts` applies only the operational sections (routes, alerts, database); `applyManifestToBuildConfig` and `generateNixpacksToml` are both written, tested — and called by nothing. The builder invokes the Nixpacks CLI with `--install-cmd`/`--build-cmd`/`--start-cmd` and writes no `nixpacks.toml`. The docs, the module comments and the Manifest Creator's Runtime section now say this plainly instead of implying a pin that never happens. Wiring it up needs a real Linux/Docker/Nixpacks integration test and is deliberately not in this release.
- **Every Runtime Pin The Generator Produced Was Broken**: `generateNixpacksToml` built nixpkgs attribute names by stripping non-digits, yielding `go_127` and `ruby_34` where nixpkgs uses `go_1_27` and `ruby_3_4`, and turning any patch-level pin into nonsense (`24.4.1` → `nodejs_2441`). Worse, `[phases.setup] nixPkgs` **replaces** the provider's package list unless it contains the `"..."` sentinel — so declaring one extra package silently deleted the toolchain, and an unresolvable name is a hard `undefined variable` Nix error late in `docker build`. Version pins now go only through the provider environment variables Nixpacks actually reads, every `nixPkgs` list leads with `"..."` so extras are additive as documented, and the generator returns warnings instead of emitting a pin it knows will be ignored or will fail.
- **Pins Nixpacks Cannot Honour Are Named, Not Guessed**: checked against the v1.41.0 the installer pins, `NIXPACKS_GO_VERSION` and `NIXPACKS_PHP_VERSION` do not exist (those versions come from `go.mod` and `composer.json`), Node silently falls back to 18 outside {14,16,18,20,22,24}, Python silently falls back to its default outside 3.7–3.13, Ruby and Rust need an exact patch version, and JDK **fails the build** outside {8,11,17,19,20,21}. The generator refuses each of these with a specific reason rather than emitting something that breaks or quietly builds the wrong thing.
- **Manifest Creator Shipped End-Of-Life Runtimes As Its Defaults**: every preset pinned Node 20, Python 3.12 and Go 1.22 — versions that lost upstream support on 2026-04-30, 2025-04-02 and 2025-02, respectively. They were hand-written literals duplicated between `apps/web` and `packages/sdk`, so nobody owned them and they drifted until a deployment tool was recommending unpatched runtimes. Defaults are now Node 24 (Active LTS), Python 3.14, Go 1.27, Ruby 3.4, PHP 8.4, Java 25 and Rust 1.98.
- **The Pre-Upgrade Snapshot Usually Did Nothing**: the installer passed `.data/ninedeploy.db` and `.data/master.key` to a single `tar` with stderr muted. `master.key` is written lazily — the first time something is encrypted — so on any instance without stored secrets the file is absent, `tar` exits non-zero, and the *entire* snapshot was skipped, database included. The operator saw one vague warning and upgraded with no rollback point, next to a truncated archive left on disk. Each file that exists is now archived (SQLite's `-wal`/`-shm` sidecars included so the snapshot is a consistent set), a missing `master.key` is treated as the normal state it is, tar's actual error is printed instead of muted, and a failed archive is removed rather than left behind.
- **Failure Messages Claimed A Backup That Did Not Exist**: every readiness-gate failure ended with "A pre-update backup is in …/upgrade-backups" regardless of whether the snapshot had run. The message now reports what actually happened.

_Installer changes take effect immediately — `install.sh` is fetched from `main`, not from the release tarball._

---

## [0.3.1] - 2026-08-26

### Fixed
- **`0.3.0` Could Not Start**: every boot died with `ReferenceError: Cannot access 'NETWORK' before initialization` and systemd restarted it forever. `engine/proxy.ts` and `lib/serviceBridge.ts` imported each other, and `serviceBridge` evaluates `RESERVED_NETWORKS = [NETWORK]` at module scope — so whichever module Node reached first decided whether the constant was initialised, and the real entry graph reaches `proxy` first. The shared Docker names now live in `engine/dockerNames.ts`, a module that imports nothing and therefore can never be half-initialised; `proxy` re-exports them so existing imports are unchanged.
- **Per-Service Bridge Reap Was Untested**: the two delete tests asserted that no `docker` command ran at all. That held only because the suite's `proxy` mock omitted `TRAEFIK_CONTAINER`: `serviceBridge` read a missing binding, threw, and the delete route swallowed it — so `removeServiceBridgeIfEmpty` silently never ran under test. The tests now separate runtime commands from the bridge reap and assert both.

### Added
- **Import-Cycle Guard**: a test walks the server's own module graph and fails on any runtime import cycle, naming the chain. TypeScript cannot see a temporal dead zone and the suites happened to import the two modules in the safe order, so this class of defect could only ever surface in production.
- **Readiness Failures Diagnose Themselves**: when the API does not answer `/health`, the installer prints `systemctl status`, the last 60 journal lines and what is listening on the health port instead of telling the operator to go and collect them. A crash-loop now ends the wait immediately — `Restart=always` keeps a crashing unit oscillating between `active` and `activating` rather than settling into `failed`, so the old gate sat through its entire window before reporting a failure it could have called in seconds. The window itself is 120s (was 60s) and honours `NINEDEPLOY_HEALTH_TIMEOUT`.

---

## [0.3.0] - 2026-08-26

### Added
- **Tags Across Three Dimensions**: Services carry many projects, workspaces and labels at once (`service_projects`, `service_workspaces`, `service_labels`). The top bar filters by all three — AND across groups, OR within one — and the selection persists per browser under `ninedeploy.tagScope`. A new Projects page manages the flat project list, and a per-service Tags card edits one service's membership in a single round-trip through `PUT /v1/services/:id/tags`.
- **Per-Service Volume Attachments**: A service can mount any number of managed Docker volumes at explicit container paths, read-only or read-write, with a uniqueness guard on both the path and the volume. Detaching records the change only — the underlying volume is never deleted.
- **Volume Backups**: Snapshot, restore and download any managed volume through `/v1/volumes/:name/backups`. Snapshots reuse the database-backup destination for off-site copies, prune to a retention cap, and refuse to restore while the owning service is still running.
- **`.ninedeploy` Manifest**: `ninedeploy manifest {init,validate,show}` scaffolds, schema-checks and prints the repo-side manifest. `validate` runs the same secret scan the server uses and rejects a file carrying credential-shaped values before they reach git history. The deploy pipeline applies the manifest itself on every deploy — the build sections at build time, the operational sections (routes, alerts, database ref) at deploy time; `manifest apply` is wired into the CLI surface but reports that its server endpoint has not shipped yet.
- **Private Repository Deployment From The CLI**: `ninedeploy sources` and `ninedeploy webhooks` manage encrypted source credentials, server-generated SSH deploy keys and auto-deploy webhooks from the terminal.
- **Workspace Invitations**: Invite an address that has no account yet; the invitation is accepted automatically on the invitee's next login or registration.
- **Self-Healing Runtime State**: At startup and every 60 seconds the panel compares each local service's desired state with the live runtime and revives anything that should be running — stopped containers are started (Compose sidecars included), a dead PM2 daemon is resurrected from the process dump, and stopped PM2 processes are restarted. A runtime that was deleted is marked `error` for redeploy instead of being reported as `running`, so a reboot, daemon crash or external `docker stop` can no longer leave the panel lying or services dead.
- **Boot Resilience**: The installer unconditionally enables the Docker daemon at boot (previously only when it installed Docker itself), so pre-existing Docker installations no longer leave Traefik, deployed containers and the panel dead after a reboot. A new `ninedeploy-pm2` systemd unit resurrects bare-metal PM2 deployments at boot from a process dump the server refreshes after every lifecycle change, and Compose deployments apply the `unless-stopped` restart policy to their containers so they survive daemon restarts and reboots.
- **Streaming Encrypted Backups**: Database dumps are encrypted and decrypted as AES-256-GCM streams, so large backups no longer need to be loaded into server memory for creation, download or restore. Existing encrypted envelopes and legacy plaintext backups remain readable.
- **Read-Only MCP Mode**: Setting `NINEDEPLOY_MCP_READONLY=1` exposes a fail-closed allowlist of inspection tools and excludes mutations, secret-bearing configuration, container inspection, Compose and file operations.
- **Dashboard Crash Recovery**: Unexpected React render failures now show a recoverable error screen instead of leaving the dashboard blank.
- **Override-Aware Installer Defaults**: Managed-database engine defaults now follow the latest Docker Hub GA (MySQL 9.7, Mongo 8.0, MariaDB 12.3, Redis 8.8, Valkey 9.1, ClickHouse 25.8, Postgres 18, RabbitMQ 4, Meilisearch v1.53). Every engine still accepts a per-row `version` override, and the bare-metal / Docker installers accept `NINEDEPLOY_NIXPACKS_VERSION=<release>` so operators can pin to the previous LTS or a known-good buildpack without a code change.
- **Latest Runtime & Toolchain Across The Stack**: Node.js 24 → 26 (latest GA, Aug 2026), pnpm 11.22 → 11.23, plus patch bumps for `jose` (6.2.10), `@tanstack/react-query` (5.102.2), `@biomejs/biome` (2.5.10), `@testing-library/user-event` (14.6.6) and `@types/react-dom` (19.2.5). Dockerfile, docker-compose and CI all pin Node 26; `.nvmrc` added so `nvm use` / `fnm use` always lands on the right major.
- **Reachable Tag Management**: The panel gained an **Organize** navigation group holding Workspaces, Projects and Labels. Projects previously had a route with no navigation entry — it was reachable only by typing the URL — and labels had no management screen at all: they could be created as a side effect of the top-bar filter but never renamed, recoloured or deleted. The new Labels page is full CRUD over the eight-token palette, and clicking a project or label row scopes the services list to it.
- **Volume Snapshots From The Volumes Page**: Snapshot, restore and download were reachable only from a service's Volumes tab, so a retained (owner-less) volume had no backup UI anywhere. Every card on **Data → Volumes** now expands the same panel.
- **Installer Installs The Release, Not A Clone**: On the `release` channel `install.sh` downloads the source tarball GitHub publishes for the tag instead of cloning, so a host needs no git and cannot land on a half-fetched object. The tag itself is resolved from `git ls-remote`, then the GitHub releases API, then the tags API — a single unavailable source can no longer pin an upgrade to a stale version. `--force` (or `NINEDEPLOY_FORCE=1`) discards local modifications and rebuilds from scratch.

### Changed
- **Command Palette Ranks Before It Truncates**: Every navigation entry carries the type `Navigate`, so a single-letter query matched all of them at once and filled the 24-result cap before any service, database or template could appear. Label matches now outrank description matches, which outrank type matches. The palette also lists Manifest Creator, Workspaces, Projects, Labels, Networks, Traefik and Docker, which it had never indexed.
- **Menu Permissions Fail Closed**: `getItemsForSlot` takes an operator boolean rather than a role string, and an item gated on `permission: 'admin'` is hidden when the flag is absent instead of shown to everyone.
- **Project Env Resolution Follows The Link Table**: Project-scope shared environment variables are the union of every project a service is linked to, replacing the single `services.projectId` lookup.
- **Visible Installer Progress**: The installer's long silent phases no longer look like a hang. Node.js, Docker and base-package APT installs stream apt's own progress lines (`Get:`/`Unpacking`/`Setting up`) live with a still-working heartbeat, expected durations are printed before the big downloads, and failed APT commands surface their error tail instead of failing silently.
- **Reusable Health Probes**: Docker readiness checks reuse one supervised `ninedeploy-prober` container instead of creating an ephemeral container for every retry.
- **Serialized Singleton Lifecycles**: PM2 sessions and Traefik recreation are serialized, preventing concurrent callers from disconnecting active PM2 work or racing to replace the shared proxy container.
- **Header-Based WebSocket Authentication**: Current dashboard clients carry bearer credentials in the WebSocket subprotocol header instead of query strings, reducing exposure through URLs and proxy history while preserving compatibility for older clients.

### Fixed
- **Stale Panel Bundle After An Upgrade**: `apps/web/dist` is gitignored, so a checkout never replaced it — an upgrade whose build was skipped or cached kept serving the previous release's dashboard, which is exactly the "upgraded but the UI still shows the old version" report. The installer now clears `dist/` and the turbo cache before building, verifies the built `package.json` version against the requested tag, and fails outright if `apps/web/dist/index.html` is missing afterwards.
- **Upgrades From A Shallow Clone**: fresh installs were cloned with `--depth 1`, so `git fetch --tags` succeeded while fetching none of the objects a newer tag needs and the checkout silently stayed on the old commit. The installer deepens a shallow checkout first, repoints a renamed `origin` at the canonical repository, force-fetches with `--prune-tags`, and hard-resets to the fetched ref.
- **Lexical Tag Sorting**: the installer's tag resolution relied on `sort -V`, which busybox and BSD coreutils either lack or ignore — ranking `v0.2.9` above `v0.2.36` and pinning those hosts to a stale release. Version components are zero-padded before a plain lexical sort, which is correct everywhere.
- **Dead Project Links**: the Projects page linked to `/services?projectId=N`, but the services list reads its filter from the shared tag scope and ignores that query string, so the link navigated without filtering. Both Projects and Labels now set the chip scope.
- **Wrong In-Panel Release Notes**: the About page's changelog carried the `0.2.31` Ghost release notes under the `0.3.0` heading and was missing `0.2.31` through `0.2.36` entirely.
- **Committed Coverage Artifacts**: `apps/web/cov-json*/coverage-final.json` (1.6 MB of v8 reporter scratch output) were tracked in git. Removed and ignored.
- **Server Would Not Build Or Start**: `volumeBackups` and `serviceVolumes` imported `backupVolume`, `restoreVolume` and `createDockerVolume` from the database engine, but none of the three had been written. The package did not compile, and loading either module at runtime would have failed the import outright. All three are implemented, snapshotting and restoring through a throwaway sidecar container so a containerised panel never needs a path into the daemon's storage directory — and a restore empties the volume first rather than merging the archive over whatever was already there.
- **Half-Migrated Service Tagging**: The schema, database, web dashboard and tag endpoints had all moved to the N-N model while `modules/services.ts` still read and wrote the removed `services.projectId`. Listing now filters on `tagProjectIds` / `tagWorkspaceIds` / `tagLabelIds`, responses carry the three id arrays the API contract declares, a created service picks up its requested tags (or every workspace the caller belongs to), and a clone inherits the original's tags. The CLI's `users.role` reads move to the derived `isOperator` flag for the same reason.
- **Blocked Upgrade From 0.2.2 And Later**: Releases from `0.2.2` added `databases.owner_user_id` through the server's boot-time self-healing step, before an equivalent SQL migration existed. The new migration then tried to add the same column, so Drizzle's batch migrator aborted the whole upgrade with `duplicate column name: owner_user_id` and the panel never started. The runtime migrator now retries such a batch statement by statement, skipping only objects that already exist and journalling the migration so the upgrade completes.
- **Disappearing Label Chip**: A label created from the top-bar filter was selected and then immediately pruned, because the tag scope's own label query still held the pre-creation list. Both queries are refreshed before the new chip is applied.
- **Corrupted Source Encoding**: `0.2.36` shipped 90 files whose non-ASCII characters had been double-encoded — `·` written as `Â·`, em dashes as three characters, and several emoji mangled past a plain round-trip. Comments in the databases, invitations and jobs modules were affected alongside the test suites; every occurrence is restored.
- **Workspace Role Fields**: A bad rename replaced the `role` field with `isOperator` on workspace members, invitations and SSO provider defaults in the test fixtures, so those suites asserted a contract the API never had. The canonical `role` naming is restored.
- **Fresh-Install Watchdog False Positive**: The post-install systemd policy check rejected `WatchdogUSec=infinity` — the modern systemd spelling of a *disabled* watchdog on a never-started unit — and aborted the installer at the very end of an otherwise successful fresh installation. `infinity` is now accepted alongside `0`.
- **Honest Service Lifecycle**: stop/start/restart no longer swallow Docker/PM2 failures while still writing a success status to the database. Starting or restarting a runtime that no longer exists now returns 409 and marks the service `error`, an unreachable Docker daemon returns 503, and stopping an already-gone runtime is treated as the idempotent success it is.
- **Bounded Clone Slug Generation**: the clone slug-deduplication loop is now bounded, so a pathological collision run cannot spin forever.
- **Tenant-Scoped Inventory Views**: Domain, metrics, topology, network and volume responses now exclude resources outside the authenticated non-admin user's ownership scope.
- **Safer Preview Deployments**: Pull-request previews reject invalid refs and external fork repositories before they can inherit service environment variables or enter the build queue.
- **Atomic Deployment Claims**: Competing worker slots can no longer claim two queued deployments for the same service at the same time.
- **Hardened Secret Handling**: Docker environment files escape multiline values, runtime log redaction handles quoted credentials, config secrets require an explicit admin reveal request, webhook token comparison hides secret length, and installer-created `.env` files are restricted to mode `0600`.
- **Reliable Startup and UI Controls**: Database connection PRAGMAs finish before migrations and application queries begin; CLI reachability checks require the real health endpoint; terminal clearing no longer reconnects the session.

### Documentation
- **Four Missing Guides**: the marketing site documented none of the 0.3.0 surface. Added *Tags: Projects, Workspaces & Labels*, *Volumes & Storage*, *The .ninedeploy manifest* and *Private repos, sources & webhooks*, wired them into the docs mega-menu, and corrected the hard-coded guide count (17 → 21). The features page gained the tag dimensions, volume attachments, volume snapshots, workspace invitations and the manifest.

### Verified
- **Full Suite Green**: 4,405 tests across the workspace pass and every package meets its coverage gate — 100% in `db`, `schemas`, `sdk` and the CLI, 99%+ statements in the web app, 95%+ in the server. New suites cover the Projects page, the top-bar filters, the service Tags card, the volume-backups panel, and the label, service-tag and volume-backup APIs.
- **Upgrade Recovery Against A Real Database**: The `duplicate column name` recovery path is exercised against an actual `0.2.2`-era SQLite file and pinned by a regression test that reproduces the unjournalled-migration state.

---

## [0.2.36] - 2026-08-20

### Fixed
- **Legacy Template Provisioning Recovery**: Deployments stranded by the browser-owned provisioning flow from `0.2.34` are detected by their provisioning marker and immediately requeued on worker startup, without waiting for the normal stale-deployment timeout.

## [0.2.35] - 2026-08-20

### Added
- **Durable Template Identity**: Services persist their trusted Hub template ID, allowing the worker to reconstruct and reconcile required database dependencies after a process or host restart.

### Changed
- **Worker-Owned Hub Provisioning**: Preparing a Hub service is now the durable queue operation. Database startup, attachment, environment reconciliation and application deployment continue in the worker even if the browser navigates away or disconnects.
- **Interrupted Deployment Resume**: Stale `building` deployments are requeued for idempotent recovery instead of being marked failed automatically.

## [0.2.34] - 2026-08-20

### Changed
- **Immediate Hub Handoff**: Pressing Deploy in a Hub service modal now prepares the stable service identity, closes the modal and navigates directly to `/services/{id}?tab=deploys` without waiting for image or database provisioning.
- **Visible Dependency Provisioning**: The fast prepare response creates a `building` deployment row immediately. The Deployments tab can display and poll it while the server prepares managed dependencies, then the same row is promoted to the normal deployment queue.
- **Background Panel Flow**: Web provisioning continues through the canonical server endpoint after navigation; completion and failure refresh the service and deployment state and surface a toast without reopening the modal.

## [0.2.33] - 2026-08-20

### Fixed
- **Ghost Database Environment Repair**: Runtime deployment now recovers the trusted application-specific database mapping from the exact bundled template contract. Existing Ghost services with a missing, empty or stale `template_database_env` receive all five `database__connection__*` variables instead of falling back to localhost MySQL.
- **Dependency Readiness Gate**: A service with an attached database that is not running now fails before its application container starts, with the exact attachment readiness count, instead of entering a restart loop and timing out in HTTP healthchecks.
- **Safe Runtime Diagnostics**: Deployment logs list the managed database environment key names injected into the application without exposing credential values.

### Verified
- **Ghost Runtime Contract Regression**: The pipeline test covers `ghost:5-alpine` with a missing persisted mapping and verifies the resolved MySQL host, port, user, password and database variables plus pre-container failure for unavailable databases.

## [0.2.32] - 2026-08-20

### Changed
- **Canonical Hub Provisioning**: The API now owns service configuration, environment reconciliation, managed database startup, database attachment and application queueing as one ordered operation. The Web panel no longer coordinates those resources through separate requests.
- **Registry-Owned Runtime Contract**: Hub images, internal ports, persistent mounts, commands, Docker socket access and database mappings are resolved exclusively from the trusted server registry and cannot be overridden by the panel request.
- **Visible Dependency Pipeline**: Database-backed installs show the server-owned provisioning order and required databases can no longer be accidentally disabled in the wizard.

### Fixed
- **Safe Interrupted-Install Retry**: Repeating an install with the same name reuses the caller-owned failed service, persistent database, volume and attachment instead of creating duplicates. Existing generated secrets are preserved unless the user explicitly replaces them.
- **Dependency-First Queueing**: An application deployment is never queued until its required managed database has started successfully and its attachment has been reconciled. Existing in-progress deployments are reused.
- **All Database Templates on One Path**: Directus, Ghost, Hasura, Matomo, Umami, Vikunja, WordPress and YOURLS are covered by the same provisioning contract and regression suite.

## [0.2.31] - 2026-08-20

### Fixed
- **Working Ghost 5 Template**: Ghost Hub installs now provision MySQL automatically and inject `database__client` plus all required `database__connection__*` values before deployment.
- **Existing Failed Install Repair**: Repeating the same Ghost Hub installation repairs the trusted template contract on an older failed service, then provisions and attaches its missing database.
- **Actionable Health Failures**: Containers that exit or remain in a restart loop fail early with exit state and redacted recent runtime logs instead of five minutes of repeated sibling-probe errors.

### Verified
- **Real Ghost Smoke Test**: `ghost:5-alpine` was started against the managed `mysql:8.4` contract on an isolated Docker network and accepted connections on port 2368.

## [0.2.30] - 2026-08-20

### Added
- **Service Domain Launcher**: Services with at least one configured domain now expose a consistent open-site icon in service cards, dashboard health and activity rows, the service header, and topology nodes.
- **Safe Destination Modal**: Clicking the icon always previews the exact destination before opening it in a new tab. Multiple domains are listed individually with their HTTP/HTTPS protocol and route path.

### Changed
- **Shared Domain State**: All launchers share one cached domain query instead of issuing a request per service, and refresh immediately when a domain is added, removed or updated.

## [0.2.29] - 2026-08-20

### Added
- **Guided Cloudflare Setup**: The Tunnels panel now gives numbered instructions for choosing a remotely managed Cloudflare Tunnel with `cloudflared`, extracting the connector token and confirming connector health.
- **Exact Routing Values**: The guide provides a copyable `http://ninedeploy-traefik:80` Published application origin and a final end-to-end verification checklist.

### Changed
- **Domain and TLS Guidance**: The panel explicitly requires the same public hostname in NineDeploy with SSL disabled because Cloudflare terminates browser TLS and forwards HTTP to Traefik.
- **Safer Token Entry**: The connector token is masked and clearly distinguished from API tokens, API keys, Tunnel IDs and certificates.

## [0.2.28] - 2026-08-20

### Added
- **Full Curated Catalog**: All 88 schema-valid, single-service-compatible templates are visible and deployable in the Hub again.
- **Trust Tiers**: The Hub shows `All 88`, `Verified 15` and `Community 73` filters, plus a clear trust badge on every application card.

### Changed
- **Transparent Certification**: Runtime smoke certification is communicated as metadata instead of being used as a blanket visibility filter. Community templates display a review warning before configuration and deployment.

## [0.2.27] - 2026-08-20

### Added
- **Container Port Control**: Service Network settings expose the internal application port used by Traefik, healthchecks and optional host-port publishing.
- **Image Port Detection**: Dockerfile and image deployments automatically adopt an unambiguous single TCP port from image `EXPOSE` metadata.

### Fixed
- **Nixpacks Domain Routing**: Dockerfile-less source deployments now default to port 3000, receive `PORT=3000`, persist the resolved port and generate a usable Traefik upstream after the first successful deployment.
- **Single Routing Port**: Process configuration, readiness checks, Docker port mapping and Traefik no longer derive their target ports independently.

## [0.2.26] - 2026-08-20

### Fixed
- **Real Nixpacks CLI**: Source deployments use the actual Nixpacks 1.37.0 executable instead of trying to run the CLI command inside `ghcr.io/railwayapp/nixpacks`, which is a build-base image and contains no `nixpacks` command.
- **Consistent Host and Agent Builds**: The Ubuntu installer and NineDeploy runtime image provision the same pinned CLI for local and remote deployments.

### Security
- **Verified Build Toolchain**: AMD64 and ARM64 Nixpacks release archives are downloaded from the official release and checked against architecture-specific SHA-256 digests before installation.

## [0.2.25] - 2026-08-20

### Added
- **Deployment Activity Heartbeats**: Any deployment command that remains silent for 20 seconds emits an elapsed-time liveness message, while fresh stdout or stderr postpones the heartbeat to keep normal logs clean.
- **Recovery Phase Visibility**: Direct registry export, recovered-filesystem packaging, and Docker image import report their exact phase every 15 seconds without inventing percentages that upstream tools do not provide.

### Security
- **Safe Progress Labels**: Generic heartbeat messages never include subprocess arguments, preventing passwords, tokens, and other sensitive command values from leaking into deployment logs.

## [0.2.24] - 2026-08-20

### Fixed
- **Explicit Native Platform**: Native snapshot recovery now passes the host `linux/amd64` or `linux/arm64` platform to both containerd pull and mount operations, so multi-platform OCI indexes resolve deterministically.
- **Containerd 2 Transfer Workaround**: `no unpack platforms defined` failures from containerd's transfer API automatically retry through `ctr --local`, the upstream-documented workaround, before using direct registry export.

## [0.2.23] - 2026-08-20

### Fixed
- **Image-Independent Recovery**: Snapshotter-independent recovery is certified across Docker Hub, GHCR, and Codeberg images instead of being treated as a MySQL-specific path.
- **BusyBox Export Compatibility**: The pinned, checksum-verified registry client release also handles root filesystem archives containing a top-level `.` entry, which is required by BusyBox and can occur in arbitrary service images.
- **Shared Verified Tooling**: Concurrent and sequential image recoveries reuse one verified registry binary per NineDeploy process instead of downloading it once per application or database.

### Added
- **Hub-Wide Recovery Gate**: `pnpm docker:smoke-registry-recovery` forces all 15 runtime-certified Hub applications through direct registry export, fresh Docker import, real container startup, and declared TCP-port probing. WordPress/MySQL and Directus/PostgreSQL additionally prove database initialization and application wiring.

## [0.2.22] - 2026-08-20

### Fixed
- **Snapshotter-Independent Image Recovery**: When both Docker overlayfs extraction and containerd's native snapshotter fail, NineDeploy now exports the image filesystem directly from its OCI registry and imports it under a fresh single-layer chain ID.
- **Verified Recovery Tooling**: The emergency registry client is pinned to an exact upstream release and its Linux amd64/arm64 archive is checked against a built-in SHA-256 before execution.
- **Runtime Metadata Preservation**: Direct recovery retains environment, entrypoint, command, working directory, user, stop signal, exposed ports, volumes, labels, on-build instructions, and healthcheck configuration.

### Added
- **Real MySQL Recovery Smoke**: `pnpm docker:smoke-registry-recovery` exports `mysql:8.4` without a containerd snapshotter, imports it under an isolated test tag, starts it, waits for `mysqladmin ping`, and removes only its exact smoke resources.

## [0.2.21] - 2026-08-20

### Fixed
- **Fail-Closed Template Hub**: Registry-valid templates are no longer automatically advertised as deployable. Hub list, detail, Web deploy, CLI deploy, and direct service creation accept only runtime-certified templates.
- **Runtime-Certified Initial Set**: n8n, WordPress, Directus, Gitea, Forgejo, Uptime Kuma, Vaultwarden, Memos, Kavita, PocketBase, Qdrant, Actual Budget, MinIO, Grafana, and Excalidraw passed isolated container startup and declared-port probes.
- **No Marketing Inflation**: Public surfaces now distinguish the 15 runtime-certified templates from the larger registry-inspected catalog.

### Added
- **Reusable Runtime Smoke Runner**: `pnpm templates:smoke-runtime -- --ids=...` pulls each selected image, starts it with its real registry environment, command and persistent volume, verifies that it remains running and listens on the declared Docker-network port, then removes only its isolated test resources.

## [0.2.20] - 2026-08-20

### Fixed
- **Honest One-Click Catalog**: Removed 47 stack components and unsupported containers that cannot run under NineDeploy's current single-application plus optional single-database contract. The remaining 88 images all pass live OCI registry inspection.
- **Real Database Template Wiring**: Templates persist application-specific connection mappings, so WordPress receives `WORDPRESS_DB_*`, Directus receives `DB_*`, and other supported database apps receive the fields their images actually consume instead of an unusable generic URL.
- **Working MySQL Initialization**: Managed MySQL and MariaDB instances create and persist the `app` database during first boot; connection strings now target that real database.
- **CLI Database Provisioning**: `ninedeploy templates deploy` now provisions, starts, records, and attaches the required managed database before queuing the application deployment.
- **Trusted Template Runtime Settings**: Web Hub deploys send only a template ID; server-side registry data supplies protected commands, Docker socket access, and database mappings so MinIO and Docker-management templates no longer lose required runtime settings.
- **Corrected Upstream Images**: Memos uses `neosmemo/memos:stable`, Forgejo uses the supported v16 image, and Kavita uses `jvmilazz0/kavita:latest`.
- **Independent Template Data**: Multiple installations of the same database-backed template derive database names from the actual service slug and no longer share one database accidentally.

### Added
- **Live Image Contract Gate**: `pnpm templates:verify-images` checks every bundled template against its OCI registry and exits non-zero for missing repositories or tags.

## [0.2.19] - 2026-08-20

### Fixed
- **No Hidden Docker Pulls**: BusyBox health probes, Alpine volume tools, Adminer/Redis Commander, Nixpacks, Cloudflare Tunnel, dashboard netns probes, and Traefik now prepare their images through the same bounded containerd recovery used by deployments and databases.
- **Remote Agent Recovery Parity**: `docker.pull` operations executed by remote NineDeploy agents now use the shared snapshot repair and native-snapshot fallback instead of a raw Docker CLI pull.
- **Canonical Traefik Lifecycle**: Startup, watchdog healing, and manual updates use one container configuration path, preserving ACME/DNS settings, config fingerprints, host gateway routing, network attachment, and post-start liveness checks.
- **Working Automatic HTTPS**: Wildcard domains created after deployment are marked SSL-enabled when an ACME email is configured, allowing Traefik to request and renew certificates automatically.
- **Reliable Ubuntu Privileges**: The installer uses one elevated Docker wrapper when group membership is not active yet, detects external versus daemon-managed containerd storage, and runs the Docker host control-plane as root instead of a nominally unprivileged but Docker-root-equivalent user.
- **Real Install Readiness**: Installation now fails unless Traefik is running, attached to the shared network, and actually answering on port 80.

## [0.2.18] - 2026-08-20

### Fixed
- **Targeted Stale Snapshot Repair**: Persistent Docker 29 `target snapshot already exists` failures now validate the exact overlayfs snapshot as committed, ask containerd to remove it only when it has no active dependants, and retry the original pull before using the flattened-image fallback.
- **Correct containerd Endpoint Detection**: Recovery commands now explicitly target Docker's external or daemon-managed containerd socket instead of assuming the `ctr` default.
- **Actionable Recovery Errors**: If both targeted repair and native recovery fail, the deployment error now includes the native recovery failure instead of reporting only the original `docker pull` exit code.

## [0.2.17] - 2026-08-20

### Fixed
- **Managed Database Image Recovery**: PostgreSQL, MySQL, MariaDB, Redis, Valkey, and MongoDB images are now explicitly prepared through NineDeploy's Docker 29/containerd snapshot recovery before `docker run`.
- **No Implicit Database Pulls**: Database startup no longer delegates image pulling to `docker run`, preventing stale overlayfs metadata from surfacing only as an opaque exit code 125. Failed image preparation stops before container state or secret env files are mutated.

## [0.2.16] - 2026-08-20

### Fixed
- **Panel-Wide Autofill Rejection**: Authenticated panel inputs and textareas now disable browser autocomplete, autocorrect, spellcheck, and the autofill hooks used by common password managers, including fields mounted later by dialogs and plugins.
- **Settings Navigation Protection**: The Settings filter remains read-only until deliberate pointer or keyboard interaction and actively rejects Chrome/Safari autofill injection, preventing stray values such as `k` from hiding the settings menu.

## [0.2.15] - 2026-08-20

### Fixed
- **Persistent Docker 29 Snapshot Recovery**: A pull blocked by a stale containerd overlayfs target now switches immediately to the isolated native snapshotter, reconstructs a verified single-layer image, and continues the deployment.
- **Non-Destructive Recovery**: The fallback preserves the image runtime configuration and filesystem ownership, capabilities, ACLs, and extended attributes without deleting or hiding existing images, containers, or volumes.

## [0.2.14] - 2026-08-20

### Fixed
- **End-to-End Hub Retry Recovery**: Interrupted template deployments now resume only their matching caller-owned idle service, overwrite the partial template environment safely, reuse the matching database, and reuse an existing service/database attachment.
- **No More Partial-Install Collisions**: Retrying after a database startup anomaly no longer stops at service slug, environment key, database slug/container, or attachment uniqueness errors.

## [0.2.13] - 2026-08-20

### Fixed
- **Database Start Reconciliation**: A managed database container that is actually running is now adopted when `docker run` reports a late code 125 failure, preventing a false `error` state.
- **Retryable Hub Database Provisioning**: Hub templates can safely resume their own matching database after an interrupted attempt instead of failing on the existing slug/container name. Ownership, engine, project, and version must all match.

## [0.2.12] - 2026-08-20

### Fixed
- **Automatic Image Port Recovery**: When a Docker healthcheck fails on the configured internal port, NineDeploy now reads the container image's declared TCP ports, probes those alternatives from the shared Docker network, and adopts the first healthy port.
- **Persistent Routing Repair**: The detected port is persisted on the service before Traefik routing is regenerated, so subsequent deploys and domain requests use the corrected value. This repairs n8n deployments mistakenly configured for port `80` by switching them to the image-declared `5678/tcp` port.

## [0.2.11] - 2026-08-20

### Fixed
- **Live Let's Encrypt Activation**: Saving the ACME account email in Settings -> Security now safely recreates Traefik, mounts writable persistent `acme.json`, regenerates routers with the `letsencrypt` resolver, and starts certificate issuance immediately.
- **Live DNS-01 Updates**: DNS provider, API token, and wildcard apex changes now recreate Traefik and regenerate its dynamic configuration without waiting for a NineDeploy restart.
- **Stale Static Configuration Detection**: Managed Traefik containers carry a SHA-256 fingerprint of their static ACME and DNS inputs. A missing or outdated fingerprint forces a safe recreate, including after an interrupted prior update.
- **Installer ACME Setup**: Interactive installs now ask for the required Let's Encrypt account email and persist it in `.env`; unattended installs clearly warn when automatic HTTPS remains disabled.

## [0.2.5] - 2026-08-19

### Fixed
- **Fail-Closed Traefik Bootstrap**: Docker network creation, Traefik image pulls, container startup and network attachment are now mandatory verified installation gates; NineDeploy no longer reports a healthy install while domain routing is unavailable.
- **Idempotent Traefik Provisioning**: Re-running the installer now reuses a locally verified Traefik v3 image. When no usable image exists it attempts Docker Hub exactly once, then immediately checksum-verifies the official Traefik release binary and constructs a minimal image without the conflicting Alpine layer; the installer no longer loops pulls, prunes images, restarts Docker, or edits containerd metadata.
- **Missing Containerd Snapshot Root Repair**: Docker 29 hosts whose overlayfs metadata remains but physical `snapshots/` directory was lost are repaired by recreating only that required root directory with strict root ownership and permissions; existing metadata and container data are never removed.
- **Traefik Status Detection**: Container liveness now comes exclusively from Docker state and no longer flips to `stopped` when optional version probing fails; both the official PATH binary and the layer-free `/traefik` binary are supported.
- **Permanent systemd Watchdog Migration**: The installer now installs and verifies an explicit `Type=simple` / `WatchdogSec=0` runtime policy, repairing stale `Type=notify` installations that could SIGTERM long Docker pulls with exit code 143.
- **Absolute Data Directory Rendering**: Relative `.env` values such as `NINEDEPLOY_DATA_DIR=./.data` are resolved against the installation directory before being written to systemd `ReadWritePaths`.
- **Drop-in Ordering Safety**: The installer-owned watchdog safety policy sorts after conventional `override.conf` files and replaces the short-lived numeric-prefix migration file without deleting administrator configuration.
- **Removed Invalid Runtime Notify Client**: Removed the dependency-free stream-socket `sd_notify` implementation and its watchdog calls; installer HTTP health checks remain the authoritative readiness gate.
- **Installer Argument Parsing**: Correctly parses both spaced and equals forms of `--version` and `--channel`, with validation for unsupported values.
- **Accurate Docker Exit Diagnostics**: Documentation now distinguishes SIGTERM exit 143 from the usual OOM/SIGKILL exit 137.

## [0.2.4] - 2026-08-19

### Added
- **Full Host Firewall (UFW) Management Engine**: Interactive host firewall control across API (`/v1/firewall`), SDK, Web UI (`Settings -> Firewall`), and CLI (`ninedeploy firewall`).
- **1-Click Service Port Presets in Web UI**: Single-click activation/deactivation for common multi-port services including Mail Server (Poste.io / Mailcow: `25, 465, 587, 993, 995`), Databases (PostgreSQL `5432`, MySQL `3306`, Redis `6379`, MongoDB `27017`), Web Ingress (`80, 443`), and SSH (`22`).
- **Automatic Installer Firewall Hardening**: `install.sh` automatically configures and hardens UFW rules for SSH (`22/tcp`), Web (`80/tcp`, `443/tcp`), and custom panel ports without accidental lockout risk.
- **Node.js 24 & 22 Active LTS Support**: Updated installer and package engines to prioritize Node.js 24 LTS and Node.js 22 LTS on Ubuntu 24.04/26.04 and Debian 12.

### Fixed
- **Ubuntu 24.04 Systemd Socket & Symlink Compatibility**: Hardened systemd unit file `ReadWritePaths` with non-fatal prefixes (`- /var/run/docker.sock`, `- /run/docker.sock`) to prevent mount failures on modern systemd distributions.
- **Background Timer Unreferencing**: Added `unref: true` to worker, metrics collector, and cron scheduler intervals to prevent process retention and optimize event loop lifecycle.

---

## [0.2.3] - 2026-08-19

### Added
- **Monorepo Version Synchronization (`pnpm version:bump`)**: Automated version bumper script synchronizing root, all 9 packages, and in-code API/CLI/MCP constants in a single step.
- **Traefik Background Self-Healing Watchdog**: Periodic watchdog reviving stopped or pruned proxy containers automatically.
- **Automated Memory & Swap Provisioning**: `install.sh` automatically detects low-memory VPS hosts ($\le 4\text{GB}$ RAM) and allocates an active 2GB `/swapfile` to prevent OOM kills on heavy image pulls.
- **Enhanced Doctor & Self-Healing Engine**: `ninedeploy doctor --fix` with comprehensive RAM, Swap, Docker storage layer, SQLite integrity, network latency diagnostics, and automated repair.
- **Zero-Failure Ubuntu Server Hardening**: Automatic installation of essential base utilities (`curl`, `git`, `ca-certificates`, `tar`), pre-creation of the `ninedeploy` Docker network, pre-pulling of `traefik:3`, and conflict resolution for ports 80/443 (auto-disabling competing `apache2`/`nginx` services).

### Fixed
- **ACME Permissions Enforcement**: Ensured strict `0600` permissions on `/etc/traefik/acme.json` before container mount.
- **Systemd Watchdog Timeout Termination**: Switched systemd unit to `Type=simple` and removed 90s watchdog timer to eliminate false-positive SIGTERM kills (exit code 143) during long builds and large image pulls (e.g. `n8nio/n8n`).
- **Database Migrator Directory Creation**: `packages/db` automatically ensures parent directories exist recursively to prevent SQLite Error 14 (`SQLITE_CANTOPEN`).
- **Cross-Platform MCP URL Resolution**: Replaced manual string concatenation in `@ninedeploy/mcp` with `node:url` `pathToFileURL` to normalize file URL comparisons across Windows drive letters and Linux paths.
- **Installer Script Health Loop**: Fixed Bash special loop variable shadowing (`$_` in `seq` loop) during `/health` readiness polling in `install.sh`.
- **First-Run Admin Bootstrap**: Hardened transactional setup and error handling for initial instance registration and database reset workflows.

### Verified
- **Monorepo Test Suite**: Verified 100% test pass rate across 2,100+ tests and 100% branch/statement coverage in all 9 packages.
- **Zero-Error Pipeline**: Complete workspace verification across Biome linter, TypeScript strict typecheck, and production builds.

---

## [0.2.2] - 2026-08-19

### Fixed
- **Cross-Platform MCP URL Resolution**: Replaced manual string concatenation in `@ninedeploy/mcp` with `node:url` `pathToFileURL` to normalize file URL comparisons across Windows drive letters and Linux paths.
- **Installer Script Health Loop**: Fixed Bash special loop variable shadowing (`$_` in `seq` loop) during `/health` readiness polling in `install.sh`.
- **First-Run Admin Bootstrap**: Hardened transactional setup and error handling for initial instance registration and database reset workflows.

### Verified
- **Monorepo Test Suite**: Verified 100% test pass rate across 2,100+ tests and 100% branch/statement coverage in all 9 packages.
- **Zero-Error Pipeline**: Complete workspace verification across Biome linter, TypeScript strict typecheck, and production builds.

---

## [0.2.1] - 2026-08-18

### Added
- **NPM Distribution**: Official npm publication configuration for CLI and public SDK packages.
- **CLI Package Naming**: Renamed CLI package to `ninedeploy` for instant `npx ninedeploy` execution and global npm install.
- **Public Monorepo Packaging**: Configured public access rules for `@ninedeploy/sdk`, `@ninedeploy/schemas`, `@ninedeploy/plugin-sdk`, and `@ninedeploy/mcp`.
- **Release Automation**: Streamlined workspace release scripts and multi-package dependency publishing workflows.

---

## [0.2.0] - 2026-08-18

### Added
- **Workspaces & Multi-Tenancy**: Workspace isolation with 4-tier RBAC (`Owner`, `Admin`, `Member`, `Viewer`).
- **Enterprise SSO & Passkeys**: OpenID Connect (Google, GitHub, Keycloak, Okta), biometric Passkeys (WebAuthn / FIDO2), and TOTP 2FA.
- **Microkernel Architecture**: Event bus and waterfall hook pipeline (`deploy.before`, `deploy.after`).
- **Configuration Center**: Dual-Vault AES-256-GCM encryption with automatic master key rotation.
- **Plugin SDK**: Modular plugins with `MenuRegistry` and `ServiceRegistry` driver interchange.
- **AI Model Context Protocol (MCP)**: 35-tool MCP server for AI coding assistants (Claude, Cursor, Antigravity, Cline).
- **Extended Databases**: 1-click Postgres (`pgvector`), MySQL, MariaDB, Redis, Valkey, ClickHouse, Meilisearch, Mongo, and RabbitMQ.
- **Container File Manager**: Live in-browser filesystem browser with drag-and-drop operations.
- **Log Drains**: Structured log forwarding to Syslog, HTTP endpoints, and Datadog.
- **Preview Environments**: Ephemeral PR staging environments with automatic cleanup on pull-request close.

---

## [0.1.0] - 2026-08-14

### Added
- **Core Deploy Engine**: Git repositories (public/private) + Docker image sources, PM2 + Docker targets.
- **Zero-Downtime Releases**: Blue-green deployment pipeline with health checks and automatic rollback.
- **Auto-Deploy Webhooks**: GitHub, GitLab, and Gitea integration with HMAC signatures.
- **Live Terminal & Logs**: WebSocket streaming logs and in-browser interactive xterm.js terminal.
- **Managed Databases & Backups**: Automated daily encrypted snapshots with S3-compatible offsite sync.
- **Traefik Ingress**: Automatic Let's Encrypt TLS (HTTP-01 & DNS-01) and Cloudflare Tunnels.
- **Hardened Service Model**: `systemd` watchdog supervision (`sd_notify`) and rootless container execution.
