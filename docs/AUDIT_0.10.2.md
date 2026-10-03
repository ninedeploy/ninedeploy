# 0.10.2 preparation audit

Date: 2026-09-18. Starting revision: `ef64074` (0.10.1), initially clean checkout.

Status: implementation and regression-test preparation, then local validation
on 2026-09-18 (Windows, Node 24.13): dependency install, migration generation
(no schema drift), and the serialized release checks — typecheck, lint, build
and every workspace test suite pass (server: 297 files / 4424 tests, exit 0;
SDK branch coverage restored to 100%). The server coverage FLOORS measure
93.37/87.37/91.29 locally — below the configured 93.4/87.5/92.2 — but
revision `ef64074` measures identically low on the same machine, matching the
vitest.config.ts note that the floors are calibrated on the CI runner
(Node 26, Linux) where v8 accounts synthetic functions differently. CI
remains the authoritative gate for those floors; no floor was changed.
Remaining unverified locally: Docker backup/restore integration, installer
paths, and real-browser login/logout/SSO-linking flows. `git diff --check`
was run successfully.

Post-validation fix: the 0.10.1 CI run had also failed its Docker image
build — Debian trixie (node:26-slim) split the Docker CLI into a separate
`docker-cli` package, so `docker.io` alone no longer provides
`/usr/bin/docker` and the plugin stage's `docker compose version` check
exited 127. The runtime image now installs `docker-cli` (verified in the
base image: CLI present, both pinned plugin checksums pass, compose v5.5.1
and buildx v0.37.1 report their versions).

## Release record — v0.10.2 (2026-09-19)

Tag `v0.10.2` (d95f2de) pushed after a fully green CI run on main — the
first green push CI since v0.10.0 (0.10.1 and 0.10.2's first candidate had
failed on the SDK coverage branch gap, the trixie docker-cli split, a
Storage.prototype spy that does not intercept on the Linux runner, and
coverage floors stale since 0.10.1). The Release workflow passed its full
gate chain (release checks, database integration, multi-arch image build)
and published the GitHub release plus `ghcr.io/ninedeploy/ninedeploy:v0.10.2`
and `:latest`. Artifact smoke test on the published image: `/health`
answers 200 with `"version":"0.10.2"` and `db: ok`; `/v1/about` reports
0.10.2; `docker compose version` (v5.5.1) and `docker buildx version`
(v0.37.1) both run inside the container. npm packages were not published:
the registry lineage intentionally stops at 0.7.0 and no 0.8+/0.9+/0.10.x
release has published packages.

## Findings addressed in source

| Surface | Fault | Change |
| --- | --- | --- |
| Agent registration and approval | Connection probes sent the raw execution token over HTTP and accepted a public unauthenticated ping as proof of authentication | Sealed nonce-bound `agent.ping`; invalid operation exit codes fail closed |
| Workspace invitations | Self-asserted email addresses automatically accepted pending invitations | Automatic acceptance requires verified email ownership; explicit invitation-token acceptance remains available |
| Project environment API | Project-scoped tokens could bypass the dedicated environment scope | Project environment routes require the `env` scope |
| Public OIDC | Callback could bypass local TOTP and perform workspace changes before refusing deactivated users | Refuse these accounts before mutation or session issuance |
| SSO identity linking | Matching only by email could merge an attacker-precreated local account with the genuine SSO user | Stable provider/subject identity mapping and explicit authenticated account linking; migration and regressions prepared |
| Account recovery | Password reset could preserve another holder's passkeys and API credentials | Atomically replace the password and revoke sessions, API tokens, passkeys and external identity links |
| Secondary SSO callbacks | Scoped API credentials could be exchanged for full sessions and callbacks could target another local user | Require an interactive session and matching local account |
| Web authentication | Cached private data survived account changes; late auth responses could restore or clear another session | Clear query cache and invalidate stale session work |
| Token refresh | Transient server/network failures erased credentials | Only explicit authentication rejection clears credentials |
| Web imports and exports | Raw authenticated requests ignored `VITE_API_URL` | Use the configured API origin |
| Backup retention | Failed/running attempts displaced successful recovery points | Independent successful/failed retention; in-progress backups preserved |
| Volume retention failures | Cleanup errors marked a completed snapshot failed and removed its file | Retention errors warn without discarding the new recovery point |
| Database operations | Concurrent operations shared staging paths and could interleave restores | Unique staging files and a per-database operation queue within the server process |
| Backup decryption | Failed authentication could leave partial plaintext on disk | Remove partial decrypted output on failure |
| Volume restore | Corrupt archives could erase current data before extraction failed | Validate archive readability before deletion |
| Volume downloads | Entire archives were read into server memory | Stream the response |
| Scheduled remote backups | Local pruning deleted metadata while leaving remote objects | Retain metadata for remote recovery points |
| Image publication | Main publishing used uppercase repository names; release pruning deleted historic image versions | Canonical lowercase repository; remove destructive historical pruning |
| Release checks | Release jobs omitted database integration checks and ran competing coverage suites | Add integration gate before push; serialize release checks |
| Version tooling | Accepted version strings that installer/release workflows reject | Accept strict numeric release versions only |
| Documentation | Claimed automatic plaintext agent fallback and encrypted volume archives | Correct claims to match implementation |

## Coverage and limits

Source inspection covered authentication/authorization, invitations, OIDC/SSO,
API scope dispatch, agent transport and registration, database/volume backup
lifecycles, the web authentication/cache layer, raw API requests, SDK integration,
and CI/release configuration. Existing tests and historical audit notes informed
the inspection; historical findings were not assumed to remain current.

This is not proof that every route, builder, template, plugin, CLI/MCP command,
installer path, or deployment topology is defect-free. Full gates and runtime
verification remain necessary. No production endpoint or external control plane
was changed. No release was published, tagged, committed, or pushed.

## Upgrade considerations

- Upgrade agents alongside the panel: connection tests require `agent.ping`.
- Existing local and legacy SSO accounts must explicitly link their provider in
  account settings. A legacy SSO-only account can recover via password reset,
  sign in, then link; configure working mail delivery before upgrading.
- Generate and verify the database migration snapshot before release. Do not
  hand-edit generated snapshots to make the drift gate pass.

### Limits listed at audit time — all since closed

Every operational limit this audit documented as remaining was subsequently
closed, verified, and shipped:

- Volume extraction IS NOW atomic (0.10.3): archives extract into a hidden
  staging directory and swap in via same-filesystem renames — extraction
  failures leave the previous contents untouched.
- Database/volume operation serialization IS NOW cross-process (0.10.3):
  an O_EXCL lock file with a liveness heartbeat under `op-locks/`; a busy
  lock answers 409 and a crashed holder's lock is reclaimed once stale.
- Remote backup records NOW record their destination (0.10.3, migration
  0062): switching the active destination no longer orphans earlier
  recovery points. Volume tarballs ARE NOW encrypted at rest (0.10.3)
  under the same master-key envelope as database dumps.
- Scaling past one replica no longer collapses to a single container nor
  502s (0.10.4, migration 0063): replica clones stop inheriting the
  published host port and the proxy renders the achieved replica count.
- Real-browser verification of the first-run setup, admin registration,
  login (wrong-password refusal + success), logout and session persistence
  was performed on the published 0.10.4 image (2026-09-19).
- Dependency advisories (`pnpm audit`, prod + dev) and a tracked-file
  secret scan reported clean (2026-09-20).

## Required validation before release

1. Generate the new identity-table migration snapshot and verify schema drift.
2. Build workspace dependencies, then run the new authentication, agent, backup,
   SDK and web regressions. Include existing adjacent tests, not just new cases.
3. Run typecheck, lint, build and the complete serialized coverage suites.
4. Run isolated Docker backup/restore integration and installer/CI checks.
5. Exercise login/logout/account switching and SSO linking in a real browser.
6. Only after checks pass, synchronize 0.10.2 version surfaces and release notes.
