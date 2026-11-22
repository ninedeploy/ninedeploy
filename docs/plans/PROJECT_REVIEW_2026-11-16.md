# NineDeploy: broad review and work plan — November 16, 2026

This document began as a review of the local working tree based on `f238463e` / `0.18.28`. No product fixes, releases, deployments, or operations on live customer data were performed during that initial review. The user subsequently authorized the implementation packages; see the [first-package record](#first-package-implementation-record) and [N03 record](#second-package-implementation-record). N04's checkpoint, continuous-WAL and node archive slices are recorded in the [third](#third-package-implementation-record--november-17-2026), [fourth](#fourth-package-implementation-record--november-17-2026) and [fifth](#fifth-package-implementation-record--november-17-2026) package records. The original findings and acceptance goals below retain their review-time scope. [Current status](../CURRENT_STATUS.md) is the current implementation/acceptance/publication summary.

## Assessment

The feature surface is broad. The highest-value next work is **recovery after losing a host, an accurate feature contract, user journeys that protect releases, and operational reliability**. Adding more integrations should follow these foundations.

Keep three distinctions clear:

- A working feature with limits should not be treated as entirely missing: major database upgrades, isolation, a durable log delivery queue, and platform import tools already exist.
- Unit tests, real Docker/agent acceptance, browser journeys, and real DNS/ACME acceptance provide different evidence. Each has its own scope.
- A risk found in source is not a reproduced defect. Risk items below require reproduction first; this review does not claim to have proved a new security vulnerability or data-loss defect.

**Release blocker observed in the initial review — R01:** `pnpm release:check` failed. The populated `Unreleased` section in `CHANGELOG.md` lacks the required `Highlights` and `Action needed` summary. `test/releaseNotes.test.ts:53` failed for the same reason in both the full suite and a focused rerun. This is a release metadata gap; it does not establish a defect in the published `0.18.28` release. Completing this summary is the first task under N01.

## Scope and method

The review covered server entry points and runtime producers; Docker, agent, and networking code; PITR, backups, major upgrades, and preview limits; settings, GitOps, and portability; web onboarding and feature cards; CLI/SDK/MCP contracts; desktop packaging; CI, release, and browser acceptance flows; and existing roadmaps. Large areas received targeted source and test inspection. This was not a line-by-line audit of the entire repository or a comprehensive penetration test.

Structural inventory: 686 TypeScript files / approximately 146,608 lines under server `src`; 269 TS/TSX files / approximately 66,867 lines under web `src`; and 126 SQL migrations. These are file and line counts, not test-case counts. Generated output and dependencies were excluded from content inspection.

Toolchain: Node `26.13.0`, pnpm `11.23.0`, TypeScript, Biome, Vitest/V8, and Turborepo. CI uses Node `26.12.1`. Sources: [root package](../../package.json), [server package](../../apps/server/package.json), [web package](../../apps/web/package.json), and [CI](../../.github/workflows/ci.yml). Desktop and Playwright have separate installations outside the root workspace; the root checks do not cover them.

Changes already present when the review began:

- `CHANGELOG.md`
- `apps/server/src/lib/databaseImport.ts`
- `apps/server/src/lib/volumeImport.ts`
- `apps/server/src/plugins/databaseImports.ts`
- Four new import regression files: `databaseImportExpiryRace`, `databaseImportGzip`, `volumeImportExpiryRace`, and `databaseImportsLifecycle`.

This review did not modify those files. They form an existing work package whose acceptance should remain separate from new features.

## Work we should avoid repeating

| Impression left by the older plan | Current source | Planning consequence |
|---|---|---|
| Services share one bridge; isolation must be built from scratch (X4). | [serviceBridge.ts](../../apps/server/src/lib/serviceBridge.ts), `ensureServiceBridge`; [Docker builder](../../apps/server/src/engine/builders/docker.ts), `ensureServiceBridge(service.slug)`: each service has an `nd-svc-*` bridge. Compose and Swarm networks are handled separately. | Reflect existing isolation in the matrix and tests. Project/environment network policy is a separate requirement; preserve the existing design when defining it. This inspection does not certify isolation across every runtime. |
| Major database upgrades are missing (the original O2 description). | [databaseUpgrade.ts](../../apps/server/src/lib/databaseUpgrade.ts), `UPGRADE_ENGINES` and `upgradeRefusal`: PostgreSQL/MySQL/MariaDB are implemented. | Remaining scope includes nodes, MongoDB, and custom-image/PITR transitions. HA is separate work. |
| Durable log delivery is missing. | [logShipper.ts](../../apps/server/src/engine/logShipper.ts), SQLite queue/cursor; [observability guide](../OBSERVABILITY.md). Build logs are also written to disk. | Remaining needs include application log browsing/search across deployments and sources outside the capture scope. Reuse the queue. |
| Importers, README images, and community files are missing. | [README](../../README.md), [importing guide](../IMPORTING.md), `apps/cli/src/commands`, `e2e/tests/screens.spec.ts`, and root contribution/security documents exist. | Close completed items. Focus on remaining real-platform data migration acceptance, guides, and onboarding. |
| Node maintenance pages, restart limits, and deploy hooks are entirely missing. | [Support matrix](../SUPPORT_MATRIX.md), [November plan P2](COMPETITIVE_ROADMAP_2026-11.md). | Track remaining forward auth, relevant Compose/build limits, and fan-out scope as separate cells. |

## Prioritized work packages

**Completed locally:** N01, N02 and N21. **N03 is implemented and passes its focused/native acceptance; its full release gate is not clean.** See the [first-package record](#first-package-implementation-record) and [N03 record](#second-package-implementation-record) for the separate verdicts. Other packages retain their priorities below.

P1: address in the next releases. P2: follow the foundational guarantees. S: a small slice; M: several slices; L: split across multiple releases. These are relative scope estimates, not calendar commitments.

### 1. Release and feature contracts

**N01 — Close the existing import work and establish the current acceptance baseline. P1 / S–M.**

- Evidence: import cleanup/lifecycle/gzip changes and four new regression tests in the working tree; [Unreleased](../../CHANGELOG.md).
- R01 locations: `CHANGELOG.md:10`, `apps/server/test/releaseNotes.test.ts:53`, and `scripts/release-notes.mjs:45`. Root cause: the test selects the populated `Unreleased` section, which starts directly with `### Fixed`, so the summary parser rejects it. Focused rerun: **6 passed / 1 failed**. An independent proof accepts the published `0.18.28` section as an unaffected control and produces the same error for `Unreleased`: `.temp_files/planning-review-20261116/prove_release_summary.mjs`. `CHANGELOG.md` was preserved because it belongs to ongoing work and this round was for planning.
- Work: review this as a separate package; verify chunk refresh versus expiry, prevention of new maintenance work after shutdown, and bounded gzip expansion. Then record the root checks and relevant Linux acceptance against the same source identity.
- Acceptance: first close R01 with 1–3 user-facing highlights and `Action needed`; then pass focused regressions, the full server suite, coverage, and typecheck/lint/build. Identify the exact source/working tree verified and remaining platform differences. Publication remains a separate step.

**N02 — One current status table and consistent capability responses. P1 / M.**

- Source contradiction: [serviceCapabilities.ts](../../apps/server/src/lib/serviceCapabilities.ts), `scaleToZero`, says a node does not sleep until acceptance. [env.ts](../../apps/server/src/env.ts) defaults automation to `on`; the [sleeper plugin](../../apps/server/src/plugins/sleeper.ts) starts the coordinator/poller; [nodeSleepCoordinator.ts](../../apps/server/src/lib/nodeSleepCoordinator.ts) admits candidate services. [NODE_SLEEP_WAKE](../NODE_SLEEP_WAKE.md) records acceptance of a specific public cycle. These facts do not establish completion of all R2 work.
- Other drift: [ARCHITECTURE](../../ARCHITECTURE.md) retains outdated table/file/test counts and a shared-network description; [OBSERVABILITY](../OBSERVABILITY.md) describes an older worker-metrics limit while worker aggregation exists in the November plan and code.
- Work: distinguish `implemented / locally verified / hosted accepted / published / restricted`. Bind each acceptance record to its commit and scope. Keep historical records dated and maintain one current summary. Extend the existing nine service capabilities in slices to cover decisions about databases, PITR, previews, backups, and builds.
- Acceptance: UI, API, and support matrix agree for each feature; runtime defaults match that answer; one place lists the remaining R2 acceptance work. Source tests must check the behavior gate as well as the wording.

**N03 — Distinguish saving a setting from applying it in the proxy. P1 / M; prove first.**

- Source risk: the [forward-auth route](../../apps/server/src/modules/forwardAuth.ts) can log a `writeDynamicConfig` failure after `setForwardAuth` and continue to return success. The [maintenance route](../../apps/server/src/modules/maintenance.ts) behaves similarly on the panel host; node pages have a rollback check.
- No actual render failure was injected in this review, and no violation in visitor traffic was proved.
- Work: inject write/render/ack failures in an isolated test. Compare the success response and UI state with actual routing. If reproduced, implement a `desired/applied` contract with visible pending/failure status or appropriate rollback.
- Acceptance: an unapplied access or maintenance rule is never shown as applied; retries and restarts preserve consistency.

### 2. Data and operational guarantees

**N04 — PITR that survives losing the host. P1 / L. Former O1.**

Implementation update: panel checkpoints and continuous archives passed the full local Linux gate. The node archive adapter, operator controls and abandoned-upload collection are recorded in the [fifth](#fifth-package-implementation-record--november-17-2026), [sixth](#sixth-package-implementation-record--november-17-2026) and [seventh](#seventh-package-implementation-record--november-17-2026) package records; the original review-time finding below remains historical.

- Verified limit: [pitrArchive.ts](../../apps/server/src/engine/pitrArchive.ts) and the [postgresPitr engine](../../apps/server/src/engine/postgresPitr.ts) keep WAL and base backups in a local archive volume. [pitrUnavailable](../../apps/server/src/lib/pitr.ts) refuses node databases. Sending an existing database dump to S3 does not make the PITR archive remotely recoverable.
- Work: ship base backups and WAL to an encrypted remote destination with integrity verification; expose archive lag, the recoverable window, and missing segments. Add the node adapter afterward. Retention must preserve the segments required for remote recovery.
- Acceptance: recover to a selected point on a clean daemon/host after all relevant source-host volumes are gone; verify transaction values before and after the point. Missing or damaged segments must not produce success with silent data omission. Publish measured RPO/RTO; tiny-fixture timing is not a production commitment.

**N05 — A combined disaster recovery drill for the panel, applications, and databases. P1 / M–L. Narrowed former O3.**

- Existing capability: [panelBackup.ts](../../apps/server/src/lib/panelBackup.ts) provides encrypted, scheduled off-host snapshots; [PANEL_BACKUP](../PANEL_BACKUP.md) already includes a new-server runbook. The snapshot excludes application volumes, database contents, and node state. A panel backup alone therefore does not prove full-system recovery.
- Work: combine the existing runbook into one drill covering panel DB/keys/Traefik, application volumes, database dumps/PITR, node re-enrollment, and DNS in order. Show backup age and the latest successful restore drill. Measure and configure more frequent snapshots if needed.
- Make backup contents explicit per engine: for example, [extraEngineBackups](../../apps/server/src/engine/extraEngineBackups.ts) exports RabbitMQ definitions but excludes queued messages; the database guide already documents this. The combined recovery plan must preserve that distinction.
- Acceptance: recover using only the operator-held passphrase and remote backups, without the original host or key files; stop the old panel from writing; check old tokens and node registrations; record elapsed time and manual steps. Resolve backup semantics before enabling WAL.

**N06 — Capacity and resilience budgets. P1 / M; measurement work.**

- Evidence: one panel process/SQLite; [client.ts](../../packages/db/src/client.ts) deliberately leaves WAL disabled; the [log shipper](../../apps/server/src/engine/logShipper.ts) stores its durable queue in the same DB. These facts alone do not prove a performance defect. No current load test was run during this review.
- Work: define representative service/node/deployment/log volumes; measure API p95, event-loop delay, SQLite busy errors, disk growth, log backlog, recovery duration, and queue wait. Include full disk, a slow node, and an unreachable log destination.
- Acceptance: a repeatable fixture, fixed workload, predefined acceptance thresholds, and recorded measurements. Select architectural changes only for measured bottlenecks.

The [capacity baseline](../CAPACITY_BASELINE.md) records the healthy load and controlled restart. Separate [resilience drills](../CAPACITY_BASELINE.md#resilience-measurements-on-november-19-2026) cover a slow agent node, a full panel data volume, and a log destination that refuses connections.

**N07 — Restart behavior for user-visible in-memory state. P2 / M. Former S6.**

- Source: [canaryState.ts](../../apps/server/src/engine/canaryState.ts) intentionally keeps measurements in memory; the durable runtime recovery journal is separate. Recovery is therefore not entirely absent.
- Work: inventory canary observations, idle observations, one-time forward-auth codes, export status, and similar state. Choose resume, safe abort, or restart behavior for each. Persist only the state that needs it.
- Acceptance: test the expected behavior and operator message after a hard kill at critical transitions; stale asynchronous work cannot publish into a newer generation.

### 3. User journeys and adoption

**N08 — Make browser journeys a release gate. P1 / M. Former S7.**

- Evidence: [.github/workflows/browser-e2e.yml](../../.github/workflows/browser-e2e.yml) runs after main CI/nightly and is non-blocking. `promote-release.needs` in [release-publish](../../.github/workflows/release-publish.yml) does not wait for this browser workflow. Other release smokes already exist.
- At review time, `e2e/tests` lacked a Git-backed preview journey. [09-domain-tls](../../e2e/tests/09-domain-tls.spec.ts) exercises TLS routing configuration with a fixture domain.
- Work: add a Git fixture, PR preview, and cleanup; browser restore, permission denial, and failure feedback; and release-blocking core journeys against the candidate image digest. Verify real DNS/ACME separately in a controlled acceptance environment.
- Acceptance: a failing core browser journey blocks publication of that same candidate; cover desktop/phone and classic/compact transitions. Reading a CI definition does not prove that its current run passed.

The [digest-pinned browser release gate](../../scripts/README.md#browser-journeys) covers PostgreSQL snapshot restore, member permission denial, and Classic–Compact switching at phone width. Its desktop project also covers Git-backed PR preview creation and teardown, including the browser feedback from a deliberately failed build. Provider DNS and ACME staging are tracked in the recovery runbook.

**N09 — First successful HTTPS deployment and framework guides. P1 / M. Former A2/A4.**

- Existing features: installer domain/email options, the first-deploy card, and README screenshots. [Dashboard](../../apps/web/src/routes/Dashboard.tsx) shows the checklist only to operators. [proxy.ts](../../apps/server/src/engine/proxy.ts) routes the panel domain through `host.docker.internal:${config.port}`; bind/port behavior needs acceptance from the user's perspective.
- Work: onboarding appropriate to member permissions; first-deploy error messages; and clean-host timing for install → sign-in → sample application → real HTTPS. Start with working starters/manifests/guides for Next.js, Laravel, and FastAPI; add others based on demand.
- Acceptance: guides pass a real deployment smoke in CI; a new user encounters no unexplained admin step. Run account/domain-dependent acceptance when those resources are available.
- On 2026-11-22, Next.js, Laravel, and FastAPI passed source upload, manifest readiness, and isolated Traefik HTTP checks on a locally built panel image. The run exercised the fix for the panel's sibling HTTP probe. The first hosted `Framework starters` run is pending. Member onboarding, first-deploy feedback, and clean-host install → sign-in → public HTTPS timing remain open. [Framework starters and local evidence](../FRAMEWORK_STARTERS.md#local-acceptance-on-2026-11-22)

**N10 — Complete the compact UI transition with user evidence. P2 / M. Former A3.**

- [layout.ts](../../apps/web/src/lib/layout.ts) defaults to `classic`; compact is opt-in and has browser projects. The breadth of instance Settings remains separate work.
- Work: evaluate tasks: new deployment, environment change, finding logs, rollback, backup/restore, and team access. Change the default based on results; group Settings by task. Include keyboard/focus behavior, screen-reader labels, Turkish, and phone layouts in acceptance.
- Acceptance: deep links and active feature cards remain discoverable; the same journeys complete in the new layout. Base behavior changes on task evidence.

### 4. Remaining runtime and data feature scope

**N11 — Node forward auth and remaining runtime cells. P2 / L. Former P2.**

- Verified limit: [serviceCapabilities.ts](../../apps/server/src/lib/serviceCapabilities.ts), `forwardAuth`, refuses node/fan-out placements. Much of maintenance pages, restart limits, and hooks already exists.
- Work: write a design record for node access to the panel and authorization revocation while the panel is down. Compare agent-mediated verification and short-lived signed authorization for latency, revocation, and failure behavior. Preserve older-agent behavior and accept remaining cells individually.
- Acceptance: prove the specified behavior under access revocation, role changes, and panel/node disconnection using two daemons and a real proxy. Preserve guards until the corresponding cell is supported.

**N12 — Expand major upgrades, then add HA. P2 / L. Former O2.**

- Source: [databaseUpgrade.ts](../../apps/server/src/lib/databaseUpgrade.ts), `upgradeRefusal`, has limits for nodes, MongoDB, pgvector, and enabled PITR. Panel-host PostgreSQL/MySQL/MariaDB upgrades exist.
- Work: first add the stop/copy/compare/switch/rollback journal for node upgrades, then MongoDB's stepped version/FCV transitions. Clearly show the recovery gap created by disabling and re-enabling PITR. Follow with a PostgreSQL replica and manual promotion; Redis/Valkey is a separate package. Keep automatic failover outside the first slice.
- Legacy-install follow-up: [databaseVersionPin](../../apps/server/src/lib/databaseVersionPin.ts) deliberately leaves some stopped rows with an unknown version and an older volume unchanged; its log says the next Start uses the default image as before. This is a compatibility choice, not a newly proved bug. Design Doctor/UI visibility and controlled version selection for ambiguous rows; do not assume every legacy row was safely pinned.
- Acceptance: identical data/roles on a clean target; correct credentials work and incorrect credentials fail; crash/rollback at every critical stage; correct PITR windows and retained-volume ownership.

**N13 — Broader preview database copies. P2 / L. Former P3.**

- Verified limit: [previewDatabases.ts](../../apps/server/src/lib/previewDatabases.ts), `PREVIEW_COPY_ENGINES` and `previewCopyRefusal`: PostgreSQL/Redis family only; no nodes.
- Work: separate MySQL/MariaDB/Mongo copied data from production users/passwords; use agent streaming for node sources; add optional data masking separately.
- Acceptance: the preview application connects to its copy; production credentials fail on the preview and preview credentials fail in production; closing the PR removes only preview resources. Define masking and permission scope before using real data.

**N14 — GitOps and Compose artifact limits. P2 / L. Former X3/P4.**

- Source: [instanceGitops](../../apps/server/src/lib/instanceGitops.ts) covers projects/services/domains/grants and applies without deletion; [composeRelease](../../apps/server/src/lib/composeRelease.ts) refuses external configuration, env_file, profiles, bind mounts, and similar inputs, and restores by local image ID.
- Work: extend GitOps with databases, builds, storage, and secret references; design plan/diff and optional reviewed deletion. For Compose, show recordability before deployment, retain eligible external inputs encrypted, and resolve digest-based artifact access on a clean target.
- Acceptance: export → plan → apply → second apply is a no-op; unsupported fields are never silently lost; supported restores work without the checkout or the old host's image cache. Add Terraform only after the API/schema stabilizes.

### 5. Operations, security, and target users

**N15 — Application observability. P2 / L. Former X1.**

- Existing features: build log files, durable drain queue/cursors, Loki search, and infrastructure metric export. [runtimeLogs](../../apps/server/src/lib/runtimeLogs.ts) reads the current runtime; [errorIngest](../../apps/server/src/lib/errorIngest.ts) groups errors but provides no source-map symbolication. A durable queue does not guarantee lossless capture from every source; PM2 and secondary Compose services are outside drain coverage.
- Work order: bounded deployment-linked runtime log history and retention → source coverage/queue-gap visibility → release source-map uploads → external OTLP trace backend integration.
- Acceptance: a previous deployment's logs remain available after redeployment; disk/retention bounds are tested; full queues and unavailable hosts are visible; source-map failure preserves the raw event.

**N16 — Narrow metric tokens and guided credential rotation. P2 / M. Extends former O5.**

- Source: [stats routes](../../apps/server/src/modules/stats.ts), `/prometheus`, requires operator access. [keyRotation](../../apps/server/src/lib/keyRotation.ts) re-encrypts under a new master key; it does not renew every external-provider credential.
- Work: a revocable, expiring token authorized only for the necessary metric reads; credential inventory/age/owner; controlled rotation for hook/API/ingest keys we issue; and step-by-step guidance for external providers.
- Acceptance: a scrape token cannot deploy, change settings, or read secrets; the old token is revoked; rotation never logs secret values. This is a least-privilege improvement, not evidence of an existing authorization bypass.

**N17 — Workspace resource quotas. P2 / L. Former X7.**

- Evidence: the [workspaces schema](../../packages/db/src/schema.ts) has no limit fields; this review found no admission layer enforcing workspace quotas. Per-service limits and usage reports do not provide an aggregate workspace quota.
- Work: reservation-based admission for service/database counts, CPU/RAM, and concurrent builds/deployments first; then storage/backup budgets and usage exports. UI, CLI, and MCP must use the same gate.
- Acceptance: concurrent requests cannot exceed quota; failed deployments release reservations; scaling, imports, templates, and previews are counted. Support agencies without requiring paid plans.

**N18 — External acceptance and distribution trust. P2 / M; resource-dependent. Former A9/O6.**

- The desktop workflow supports signing conditionally on signing material; [DESKTOP](../DESKTOP.md) documents unsigned builds and physical-Mac Keychain acceptance limits. This review did not query current repository secrets or inspect published installer signatures remotely.
- Work: when certificates are available, verify Windows signing and macOS notarization/Keychain/installed DMG behavior; when cloud accounts are available, exercise real create/enroll/lost-response/owned-delete scenarios on Hetzner/DO/Vultr.
- Acceptance: signature verification on the published artifact and real-device login/restart; cloud cleanup leaves no billable fixture resources. Missing accounts/certificates should not block other local work.

**N19 — Agent sandboxes, managed object storage, and further expansion. After P2 / L. Former X5/X6.**

- Remote MCP and approvals exist; short-lived agent workspaces are a separate product surface.
- Prerequisites: quotas, resource ownership, expiry cleanup, secret scope, egress policy, and an approval model. Limit the first sandbox to one provider/runtime with an explicit TTL. Object storage is a separate proposal; existing backup destinations do not provide a managed bucket/key API.
- Acceptance: an agent cannot elevate its own privileges or deploy to production without approval; crash/TTL cleanup removes only owned resources. Schedule this after foundational recovery work.

**N20 — Singleton settings schemas and focused extraction from large modules. P2 / M. Remaining former S1/S5/S9.**

- Owned-settings registration, validation, and cleanup exist. [settings.ts](../../apps/server/src/lib/settings.ts), `getSettingJson<T>`, can treat generic JSON as `T` without schema validation; singleton GitOps settings use this helper. This inspection does not prove a particular malformed row causes a user-facing failure.
- Work: declare singleton keys, stored schemas, secret/rotation policy, and export policy; provide safe fallbacks and visible diagnostics for invalid legacy rows. Move hot or relational state into tables through additive migrations only when a requirement or measurement justifies it.
- Large files: pipeline 2,400 lines; services route 2,036; Docker builder 1,913; agent 1,869; proxy 1,820; DeployWizard 1,596. Size alone is not a defect. Extract responsibilities at natural boundaries while changing a file for an existing task; avoid a separate broad refactor.
- Acceptance: malformed singleton values are rejected or fall back safely; upgrade/export/rotation behavior is preserved. Keep module wiring and behavioral tests intact; LOC or coverage percentages alone do not define success.

**N21 — Cache contracts for test inputs outside the package. P1 / S–M. New source observation.**

- Evidence: [turbo.json](../../turbo.json) declares environment files, tsconfig, and biome as global inputs; the test task has no additional `inputs`. [docsIndex.test.ts](../../apps/server/test/docsIndex.test.ts) reads the root `docs` tree; installer tests read root `install.sh`. `pnpm exec turbo run test --filter=@ninedeploy/server --dry=json` listed 1,650 inputs for the server test task; those root installer/docs inputs and corresponding global files were absent. Output: `.temp_files/planning-review-20261116/test-cache-dry.json`.
- Risk: changing only a source outside the package may reuse a stale test result. This review did not deliberately break a source to produce a false-green result; the observation concerns missing declared cache inputs. Current CI uses a pnpm store cache, and no Turbo cache restore step was found. The directly supported risk therefore concerns local reruns with an existing cache; this review does not claim hosted CI passed incorrectly. The broad environment glob also includes environment files in research checkouts under `.temp_files`, which may cause unnecessary invalidation.
- Work: inventory test inputs outside each package; explicitly include required root files in task inputs/global dependencies and exclude temporary worktrees. Make the cache policy for critical release checks explicit.
- Measure feedback time too: the same base commit's hosted main CI `Test` step took **35 minutes 47 seconds** (`hosted-verify.json`). This single measurement does not prove a performance defect. Following the existing early Swarm guard, group critical contract/documentation/environment checks into a fast preflight gate while preserving the full coverage run. Shard or parallelize only after proving separate DB/directory/daemon ownership for every job.
- Acceptance: valid docs/installer content changes alter the relevant test hash; unrelated `.temp_files` changes do not. In an isolated checkout, prove that deliberately breaking an external input cannot reuse an old green result.

## Execution order and dependencies

| Phase | Packages | Exit criteria |
|---|---|---|
| A — Accurate baseline | N01, N02, N21, N03 reproduction | Current checks recorded; obsolete plan assumptions corrected; setting-application failure behavior understood; concurrent changes in the same scope kept distinct. |
| B — Reliable operation | N04/N05, N06, N08 | Host-loss recovery drill; measured capacity/RPO/RTO; blocking browser journeys against the same candidate. |
| C — User success | N09, N10; N11 design record | First HTTPS deployment evidence, the first three working framework guides, validated simpler UI, and a reasoned node-auth decision. |
| D — Controlled expansion | N07, N11–N17, N20 | Small patches, each with data/role/crash/compatibility acceptance. Node upgrades/PITR/previews use the same runtime authority. |
| External track | N18 | Independent acceptance as accounts/certificates/real devices become available. |
| Later product package | N19 | Quota, TTL, secret, and approval prerequisites completed. |

Recommended first implementation package: **N01 + N02 + N21**, followed by **N03 fault injection** and **N04's first panel-host remote archive slice**. Reuse R2's existing durable authority and acceptance records to close its remaining list.

No day estimates were assigned without knowing team capacity and resources for real-host acceptance. Split L packages into reviewable releases. Define acceptance, migration/backward-compatibility requirements, and the operator-visible change for each slice.

## Initial review checks and limits

Local log: `.temp_files/planning-review-20261116/release-check.log` (git-ignored).

- `pnpm release:check`: **EXIT 1**, approximately **38 minutes 35 seconds** for the coverage task phase, in addition to the preceding runtime/static/build checks. Runtime check, workspace typecheck, lint, and build passed. The other seven packages had **5,394 passing tests**. Server: **876 files passed / 1 failed; 14,533 tests passed / 1 failed / 2 skipped**. R01 (`releaseNotes.test.ts`) was the only failure. Root totals: **19,927 passed / 1 failed / 2 skipped**. The full run failed and produced no server coverage summary, so the server coverage gate is not reported as passed.
- R01 focused rerun: `pnpm --filter @ninedeploy/server exec vitest run test/releaseNotes.test.ts --no-coverage` → **6 passed, 1 failed**; `.temp_files/planning-review-20261116/release-notes-check.log`. Reproduced without changing product or test code. No fix or post-fix verification was performed in this planning round.
- The root gate includes runtime checks, typecheck, lint, build, and serialized coverage suites. It excludes some additional CI guards/smokes.
- The four new import regression files plus `docsIndex.test.ts` and `serviceCapabilities.test.ts` were run directly through Vitest, bypassing the cache: **6 files, 25 tests passed** (`--no-coverage`). This focused run uses a separate temporary data root and in-memory databases, with no real Docker or production data. Log: `.temp_files/planning-review-20261116/focused-check.log`.
- `pnpm --dir desktop typecheck` passed; `pnpm --dir desktop test`: **5 files, 27 tests passed**. This does not establish Electron installer/OS credential store acceptance. Local log: `.temp_files/planning-review-20261116/desktop-check.log`.
- The GitHub connector returned an empty commit-status list; Actions check-runs were queried separately through read-only `gh api`. All 27 returned checks for `f238463e292cf5145356b41c86d179a6661d6796` were `completed/success`: [main CI](https://github.com/ninedeploy/ninedeploy/actions/runs/43463890083), [release acceptance](https://github.com/ninedeploy/ninedeploy/actions/runs/43474401644), and [browser journey](https://github.com/ninedeploy/ninedeploy/actions/runs/43706059714). Main CI includes real Docker/PostgreSQL integration and node autoscaling jobs; the release workflow includes nine image smoke slices and desktop packaging on three platforms. This evidence covers the **base commit**, not the uncommitted import changes above it. A compact job-step summary is saved in `hosted-verify.json`.
- Linux Docker/agent smokes and browser E2E were not rerun locally during this review; the existing hosted results above were inspected. A new clean-host recovery drill, real DNS/ACME, cloud APIs, and physical-Mac Keychain behavior were not verified. Published installer signatures/asset integrity were not independently downloaded and checked.
- The production runtime version and current backup configuration were not queried. A feature's presence in source does not show it is enabled in production.
- No dependency advisory scan, penetration test, or comprehensive security certification was performed. Security-related plan items are focused source observations.
- `git diff --check` passed; the new plan's local file links and trailing whitespace were checked. The documentation index test passed in the 25-test run above. Final `git status --short` showed only this plan and its `docs/README.md` link in addition to the original four modified and four untracked import/changelog files. This review did not touch those pre-existing files.

The initial review produced this document and its index link. It did not apply product fixes, commit, push, or publish a release. The subsequently authorized implementation is recorded below.


## First-package implementation record

Implemented in the requested order: **N01 → N02 → N21**. The original import source changes were reviewed and preserved byte-for-byte; the added release summary and subsequent package changes are ours. No commit, push, release, production deployment or operations on existing application containers were performed.

### N01 — Import acceptance and release summary

- Reproduced R01 on the original populated `Unreleased` section: **1 failed / 6 passed**. Added three operator-facing highlights and `Action needed: No.` while preserving the existing fix entries. The release summary test now passes.
- Ran the unchanged four import regression files against preserved HEAD implementations in an isolated source copy: **9 failed / 9 passed**, including unaffected controls. Failures showed expiry deleting refreshed staging, maintenance continuing after close, and a 32 MiB gzip allocation against a 64 KiB budget.
- Current source, expanded import/release coverage: **13 files / 199 tests passed**.
- Linux Node 26.12.1, built from the N01 source snapshot: the **18 import regressions passed three consecutive times**. Containers used no network, published ports, host data mounts or Docker socket, and were removed after each run.
- Snapshot setup initially needed complete workspace dependency links; those import/setup errors were not counted as RED evidence. The final RED log contains assertion failures with controls.

### N02 — Accurate contracts and a current status summary

- Added behavior regressions that boot the real sleeper plugin with automation on and off, compare observer registration with the capability endpoint, and cover node fan-out. Before the fix: **3 failed / 5 passed**. After the fix: **8 passed**.
- `scaleToZero` now reports `limited` with actual automation/agent requirements or the automation-off/fan-out condition. Runtime admission, agent guards, defaults and public API shapes are unchanged.
- Expanded the generated support matrix using the real PITR, upgrade, preview and build-admission guards, plus the restore adapter registry. Database APIs and the preview/build producers continue to use those same implementations; no parallel engine allow-list was introduced.
- Added `docs/CURRENT_STATUS.md`: implemented, locally verified, hosted accepted, published and restricted are distinct. It centralizes the remaining aggregate R2 checklist without rewriting dated receipts.
- Corrected current deployment/observability/network descriptions, removed misleading current numerical claims, and linked historical roadmaps to the current summary.
- Windows: **17 tests in 4 server files** and **34 tests in 3 web files** passed; server typecheck passed. Linux: **10 tests in 2 files** passed against the current source and docs.

### N21 — Cache inputs and contract preflight

- Proved the real cache failure in an isolated Git workspace: after a valid task was cached, a broken root document still returned exit 0. A separate control showed an unrelated `.temp_files/research/.env` changed the hash. The final test on the original config has **2 failures**; the same assertions pass on the corrected config.
- Preserved `$TURBO_DEFAULT$` and declared root documentation, installer/configuration, workflows, scripts, systemd, patches and cross-package source/test inputs. Environment hashing is limited to the root and app/package roots. An actual repository dry run includes the installer, current status, changelog, workflow and preflight script, with **no `.temp_files` inputs**.
- Source/test trees are conservatively shared test inputs because contract guards inspect sibling packages and clients. Generated build output and scratch checkouts are not added to those globs. Build task input policy remains unchanged.
- Added `pnpm check:contracts`, a direct, cache-independent Vitest invocation with a five-minute process bound. CI and `release:check` run it after build, before forcing the complete serialized coverage suites with `--force`.
- Updated the existing release-workflow invariants to require the same phase order, Docker-unavailable preflight and forced full suite. CLI tests prove child exit codes 0 and 42 are preserved; an isolated exit-swallowing mutant failed the latter test while its control passed.
- Windows wiring/cache checks: **36 tests in 3 files** passed. Final cache/launcher checks: **4 tests in 2 files** passed on Windows and Linux.
- The first Linux fixture run exposed pnpm normalizing its minimal lockfile during cold bootstrap. This was a harness issue, not a product failure. The fixture now bootstraps explicitly, warms the settled inputs, asserts their hash is stable and only then tests the cache hit. No sleep/retry or weakened cache assertion was added; the updated test was rerun RED against the original config.
- Configuration semantics were checked against [Turborepo's configuration reference](https://turborepo.dev/docs/reference/configuration#inputs): root-relative inputs use `$TURBO_ROOT$`, and `$TURBO_DEFAULT$` preserves default input behavior. The installed Turbo 2.11.2 is exercised by the permanent fixtures.

### Combined final validation

**PASS — `pnpm release:check`, exit 0.** Runtime baseline, workspace typecheck, lint, build, contract preflight and all complete coverage suites passed on the final product/test/config snapshot.

| Package | Passed | Failed | Skipped |
|---|---:|---:|---:|
| schemas | 808 | 0 | 0 |
| db | 85 | 0 | 0 |
| plugin-sdk | 7 | 0 | 0 |
| sdk | 396 | 0 | 0 |
| mcp | 53 | 0 | 0 |
| web | 2,840 | 0 | 0 |
| CLI | 1,206 | 0 | 0 |
| server | 14,541 | 0 | 2 |
| **Total** | **19,936** | **0** | **2** |

Server: **879 files passed**. The two skips were already present in the initial review; no tests or coverage thresholds were removed or weakened. All other workspace coverage gates passed too.

| Server coverage | Observed | Required |
|---|---:|---:|
| Statements | 93.37% | 93.25% |
| Branches | 88.37% | 87.3% |
| Functions | 91.74% | 91.0% |
| Lines | 96.46% | 95.1% |

The complete Turbo test phase reported **12/12 tasks successful, 0 cached**, in **40 minutes 31 seconds**. The preceding direct preflight passed **13 files / 119 tests**. Existing lint warnings remain; lint exited successfully.

N21 was also exercised inside a real forced Turbo parent task (`--only --force`, `--no-coverage` for those two isolated fixture files): **4 tests passed**, with **0 cached parent tasks**. Linux `CI=true` checks passed **4 tests in 2 files**. The parent-task check did not rebuild dependencies or write the main suite's coverage output.

At the first package's completion, its product/test/config inputs still matched `.temp_files/package-1-20261116/validated-source-manifest.json`; only its result record and current-status publication row changed after that gate. Subsequent N03 changes are recorded separately below. The first package's final documentation/contract recheck: **PASS**, `pnpm check:contracts` — **13 files / 119 tests**, after the documentation-only result updates. Local links, whitespace and `git diff --check` also passed.

**Completion:** N01, N02 and N21 are locally complete and verified. Hosted CI for this dirty package, publication, public DNS/ACME, real cloud accounts and physical-Mac Keychain acceptance were not run; they are not claimed by these results.

Evidence is retained in `.temp_files/package-1-20261116/`, including starting status/source hashes, preserved unfixed copies, RED/GREEN logs, native build/test logs and actual cache input metadata. Unfixed copies contain dependency junctions and must not be recursively cleaned through their targets. Disposable test fixture directories and containers are owned and cleaned by their runners. Published base-commit CI evidence from the initial review does not certify these uncommitted changes.

The two owned Docker test image tags (`ninedeploy-review:n01-20261116` and `ninedeploy-review:n21-20261116`) were removed after label verification. Their disposable containers were removed by `--rm`; source snapshots and logs remain as evidence. Existing project/application containers and images were not removed.


## Second-package implementation record

The next reviewable package is **N03**, in phase A after N01/N02/N21. N04 remains next and will be split into its first panel-host remote archive slice; this package does not claim off-host PITR. Work is local on `f238463e` plus the preserved first-package tree. No publication or production changes were performed.

### N03 — Saving and applying proxy settings

**Confirmed failure:** the three management handlers returned HTTP 200 after a failed proxy render/write. A saved forward-auth rule, maintenance mode or custom error page could therefore be shown as applied while visitors still saw previous routing. The original review labelled this a source risk; this package reproduced it before patching.

The implementation uses **acknowledgement and safe rollback**:

- A save first records the exact previous setting in a durable, entity-owned rollback journal. Management reads and writes serialize per database; an overlapping setting request cannot undo a newer save.
- Success requires the existing HTTP/TLS proxy routing acknowledgement, including middleware definitions. Node changes also require the selected node's routing acknowledgement, preserving the node page-server readiness check and existing capability restrictions.
- A failed apply restores the previous raw setting and confirms the restored routing. For node pages, restoration also requires a fresh page-server acknowledgement; an older successful pages outcome cannot certify the restored page. The API returns `502 proxy_setting_unapplied`; existing node-page refusals retain their specific error code.
- If restoration also fails, the journal remains and the API returns `503 proxy_setting_unconfirmed`. Reads refuse to present the setting as applied. UI cards show the unconfirmed state and offer a status reload; a failed save invalidates cached status. English and Turkish are covered.
- Retry, panel boot and the five-minute proxy watchdog restore interrupted operations. This is a safe-abort policy: a crash after a write but before durable success restores the previous setting. A deleted owner is not recreated, and malformed journal data remains unconfirmed.

No migration or dependency was added. Journal prefixes declare owner, stored schema and drop-on-export behavior in the existing owned-settings registry. Access/role guards and runtime feature restrictions remain authoritative. The acknowledgement is evidence at save time, not a promise that Traefik will remain available afterward.

### Evidence and validation

| Check | Observed result |
|---|---|
| Same regression against preserved original handlers | **12 failed / 1 successful-save control passed**. Five recovery-specific cases were outside this filtered RED run. Failed handlers returned 200 instead of the asserted 502. |
| Same application proof after patch | **13 passed**; `PROBLEM NOT REPRODUCED`. |
| Complete focused verifier | Initial **18 passed, three consecutive runs**; after the node restoration correction, **39 passed / 2 files, three consecutive runs**; `FIX VERIFIED`. Includes render/write/ack failures, failed disable, exact rollback, failed rollback, malformed legacy protection/journal, deleted owner, boot/watchdog wiring and barrier-ordered overlapping saves. |
| Focused UI and locale checks | **22 passed / 5 files**. Unconfirmed reads hide state controls, show the error, and recover after status reload. |
| Authorization fault-boundary checks | **8 affected route/grant cases passed**. The harness's no-delay polling caused heap exhaustion after acknowledgement became mandatory; it now fails the external acknowledgement seam immediately and still records that effect for unauthorized-call assertions. Full matrix stays in the full suite. |
| Linux focused suite | **67 passed / 6 files** on the final source. Node 26.12.1, with no network or Docker socket. Includes all new setting regressions plus existing forward-auth, maintenance, acknowledgement, ownership-schema and Traefik-plugin cases. |
| Candidate runtime identity | All **8 changed compiled runtime files** in the final candidate match the current local build byte-for-byte. Node **26.12.1**. |
| Real Docker/Traefik acceptance | **PASS — 7 scenarios on the final candidate** through a labelled disposable daemon: real atomic-write failure, lost HTTP/TLS acknowledgement, retry and visitor denial/opening, maintenance response, hard-killed in-flight application restored at boot, and a custom error page served from a real backend 502. All three owned resources were removed. Report: `.temp_files/package-2-20261116/native-final/result.json`. |
| Full forced release gate | **NOT PASS.** Windows: all **19,961 assertions passed**, two existing skips, coverage floors met, but one native worker error caused exit 1. Local Linux/Node 26.12.1: **871/880 server files passed; 14,530 passed / 67 failed, one unhandled rejection**, exit 1 in the disconnected container. Log: `.temp_files/package-2-20261116/linux-release-check-3.log`. Contract preflight **15 files / 158 passed**; all seven other workspace coverage suites passed, including **2,843 web tests**. These attempts are not release certification. |
| Static checks | Typecheck, lint and build passed in the release run; scoped Biome checked **20 files**, plus the preview fixture with no findings. |

A second finding was proved during self-review: an existing node page could still be shown as restored when the node did not take that previous page. An older successful page-write outcome could also be mistaken for restoration. The final helper clears that outcome and requires the restored page to be served before deleting the journal. Four regression cases (maintenance/error pages × missing/stale acknowledgement) failed against the preserved earlier helper, with a separate healthy-node control passing; all 39 node/panel setting cases passed three consecutive runs after correction. The second full run was deliberately stopped using only its verified owned process tree, and validation restarted against this corrected source. That interrupted run is not a full pass.

The third full attempt completed its coverage calculation and met every floor, but was **not a pass**: 879/880 server files and 14,562 cases passed, two cases were skipped, and the preview-database worker terminated with Windows native access violation `3221225477`. Its unchanged 11-case file passed alone. An independent lifecycle probe retained the 11 created client objects and observed that none was explicitly closed by the fixture (`closed === false` on all 11). The fixture now closes its client in `afterEach`; the probe and all 11 cases passed three consecutive runs with every retained client reporting `closed === true`. This proves deterministic client cleanup; it does **not** measure an OS-level handle leak or establish the native crash's cause. The corrected 11-case preview fixture also passed on Linux/Node 26.12.1. Production runtime source did not change. The fourth full gate verifies this final test snapshot; earlier failed/interrupted gates remain retained.

The fourth Windows run passed **all 19,961 test assertions** (server: 880 files / 14,563 passed / two existing skips) and all coverage floors, but still failed the gate because a different worker exited with the same native access violation in `githubRunners.test.ts`. That unchanged 29-case file passed alone. The native failure remains unresolved; neither Windows run is called a clean release check. The complete gate also ran locally on Linux/Node 26.12.1 with the project's required tools, read-only Git history/docs/workflows, a non-root user, no network and no host Docker socket. It exited 1: nine server files failed (67 assertions), with one unhandled rejection. DNS-dependent egress checks could not resolve hosts in the disconnected fixture; the container marker selected container-only self-update/host-path branches in tests expecting a host install. This is a failed local attempt, not hosted CI. No product guard or assertion was weakened. A separate nine-file environment diagnostic is recorded below. The production runtime source is unchanged from the accepted native candidate.

The first full release attempt is retained as a failed attempt: one unchanged UploadSource navigation test missed its wait; that file passed alone, then the entire 2,843-case web suite passed in the second forced run without editing the test or upload implementation. The first expanded authorization run is also retained as failed; no heap limit or test assertion was weakened to make the corrected harness pass.

Native harness setup errors (daemon endpoint, explicit virtual-host request and workspace module resolution) are recorded separately from product failures. The final native run was repeated after the node correction, includes the hard-kill and visitor assertions, and passed without skipped cases. This native smoke covers panel-host routing; node page failure/restoration is covered by the four explicit agent-boundary regressions and the existing node suites. Earlier harness attempts remain recorded, including the cold reachability admission guard and the separate backend network-timeout case; production code was unchanged between these attempts.

The environment diagnostic passed **all nine files / 588 tests** on the same Linux/Node 26.12.1 source, with DNS available and the disposable container's own `/.dockerenv` marker removed to select the host-install branches expected by those fixtures. No source, assertions, timeouts or coverage floors changed. This establishes the observed environment dependence of those failures; it is a targeted no-coverage run, not a replacement full release gate. Log: `.temp_files/package-2-20261116/linux-environment-recheck.log`. Before publication, obtain a clean full gate on a suitable host/hosted CI and investigate the Windows worker failures; the current package is not release-certified.

### Scope and retained work

The original import sources/tests, N02 capability work and N21 cache policy are preserved. Changes to the prior package's contract launcher/test, changelog and scripts index are intentional N03 preflight/documentation additions. The runtime/setting patch is confined to the confirmed finding and its recovery paths.

Evidence lives in `.temp_files/package-2-20261116/` and `.temp_files/ledger_n03-proxy-settings.md`: starting status and hashes, the preserved original handlers, executable proofs/verifier, logs, candidate hashes and native results. Preserved snapshots contain dependency junctions; do not recursively clean through their targets.

Final documentation/contract recheck: **PASS**, `pnpm check:contracts` — **15 files / 158 tests**, exit 0. `git diff --check` passed. All product/test/config inputs still match the validated source manifest; only three Markdown result files changed afterward. The original seven import files remain byte-for-byte unchanged. All owned native/CI containers and volumes were removed; three Linux CI image tags were verified by label and digest before removal (the earlier root-tools image was already absent). Evidence snapshots and logs are retained.

**Completion: N03 implementation and scoped acceptance complete; full release verification remains open.** Hosted CI, publication, production changes, public DNS/ACME, cloud-provider and physical-device acceptance were not run and are not implied by local results. Next priority: **N04's first panel-host remote archive slice**.


## Third-package implementation record — November 17, 2026

### N04 first slice — panel-host remote recovery checkpoints

**Implemented and locally verified for the stated slice; full release certification remains open.** This package publishes opt-in, self-contained PostgreSQL checkpoints containing a completed base backup and its required contiguous WAL. It does not complete all of N04: continuous/incremental shipping, nodes, automatic remote retention, a browser configuration screen, and external-provider/production acceptance remain separate work. Checkpoint windows can have gaps across base-backup rollover; local retention does not promise continuous remote coverage.

The operator API and SDK configure an existing HTTPS S3 destination, a separately held recovery passphrase and a 15–1440 minute interval. A minute tick runs due checkpoints. Manual requests answer 202 only after durable admission; success requires downloading the uploaded ciphertext and comparing its SHA-256 hash. Failure preserves the last verified object, with lag/window/missing-segment diagnostics. Interrupted running records are shown as failed; orderly shutdown drains admitted work. Configuration and manual admission are audited with the operator's identity.

The format validates recovery metadata, exact file names, lengths and file hashes. It uses the existing streaming NDPB1 authenticated passphrase envelope, independent of the lost master key. Additional PostgreSQL tablespaces are refused on export and import because their separate archives are outside this slice. A copy holds the database operation lock and an archive read pin against retention, disable and base backups. Once copied, the complete object is independent of local retention and older remote objects; no remote object is automatically deleted. Configuration/state/passphrase keys declare ownership, schema, export-drop behavior and secret rotation. No migration or dependency upgrade was added.

The packaged `recover-pitr-checkpoint.mjs` tool authenticates/decrypts and verifies the remote object before importing to a fresh staging archive, then uses the existing PostgreSQL replay engine to recover a new data volume. It needs the object key/credentials and off-host passphrase, not the old panel database or master key. Existing targets are refused. It does not create a managed panel row; validate and adopt the retained volume through the existing database creation flow. The [English runbook](../PITR_REMOTE_CHECKPOINTS.md) explains the API, SDK, recovery procedure and limits.

### Final-source verification

| Check | Observed result |
|---|---|
| Related server suites | **16 files / 1,279 passed**, covering all PITR layers, new routes, framing/encryption, pin/retention races, ownership, key rotation, dependency cycles, the 1,114-case authorization matrix, audit coverage and the isolated autoscaler suite. `final-related.log`. |
| Linux focused checks | **9 files / 81 passed**, Node 26.12.1, with no network or Docker socket. `linux-focused-final.log`. |
| Runtime/static checks | Node baseline, workspace typecheck, lint and build passed after the final code corrections. `final-typecheck.log`, `final-lint.log`, `final-build.log`. |
| Contract preflight | **18 files / 190 passed** after adding the audit scanner to the uncached launcher. `final-contracts.log`; final documentation recheck recorded below. |
| Full workspace run | **FAILED**, exit 1. All seven other workspace suites passed (5,399 assertions, with coverage). Server reported **880 passed / 1 failed file out of 882**, **14,591 passed / 1 failed / 2 skipped**, plus one native worker error. No server coverage verdict was produced. `release-check-verified.log`. |
| Final-source native drill | **9 scenarios passed** on the accepted image identified below. Complete source-daemon/volume/key loss, selected/latest recovery, missing source WAL, a real additional tablespace, and wrong-passphrase/missing-object/damaged-object refusals. All owned resources removed. |
| Input identity | The accepted image's **11 changed compiled runtime/tool files** match the final local build byte-for-byte. Final product/test/config inputs are recorded in `validated-source-manifest.json`; the earlier full-run snapshot is retained separately as `release-input-manifest.json`. |

All local evidence paths above are under `.temp_files/package-3-20261117/`. SDK remote-method coverage also passed in its **397-case full suite**. The full run preceded the final admission/audit corrections below; it is not a clean gate for the final snapshot. The related suites, static/build checks, contract preflight, Linux checks and native drill were repeated for the corrected source. Hosted CI, publication, cloud-account and production acceptance were not run.

### Proven corrections and full-gate limits

- **Additional tablespaces:** the earlier producer published only `base.tar.gz` even when PostgreSQL's manifest named an additional tablespace. The direct regression ran RED (one failed, one ordinary-layout control passed; thirteen unrelated cases filtered out). The same refusal failed against an earlier real-PostgreSQL image in `native-tablespace-red-2`; it passed against corrected images. Export/import now reject these manifests, including encoded paths. The first real-tablespace attempt failed on fixture DDL transaction setup and is not a RED product proof.
- **Base-backup admission under a copy pin:** the mounted endpoint answered 202 while the underlying operation refused to start. `admission-red.log` records actual 202 versus expected 409, with the successful checkpoint control passing. The route now checks the archive read pin synchronously and returns `409 pitr_busy`. The regression is permanent in `pitrRemote.test.ts` and passed in the final Windows/Linux suites.
- **Audit coverage:** the full run's sole assertion failure named the two new mutation routes. Configuration already audited inside its helper; the scanner now recognizes that helper, with a runtime audit assertion guarding it. Manual checkpoint admission now explicitly audits the operator at the route. No exemption or assertion was weakened; the scanner is now in contract preflight.
- **Windows native worker failure remains unresolved:** the full run also ended with exit `3221225477` in the unchanged `autoscaler.test.ts`. Its **36 cases passed alone** in the final affected group. Similar native worker errors were recorded before N04 in the N03 package, in other files; no common cause or fix is claimed. The full run and the deliberately interrupted earlier run are retained, and neither is a pass. A clean final full gate on a suitable host/hosted CI remains necessary before release.

Native harness setup failures (nested-daemon certificate transfer, runtime fixture directory creation/permissions, migration-helper package resolution) are retained separately from product defects. No such attempt counts as passed acceptance. Every attempt's owned resources were removed; proof/log directories are retained.

### Final native receipt and measurements

Accepted image: `ninedeploy-review:n04-acceptance-20261117`, **`sha256:d6e3ea7af35ea6bc8b659c720c24c530c0343e81e02a0dee018d1f219bbd27dd`**. Receipt: `.temp_files/package-3-20261117/native-acceptance/result.json`. The HTTPS fixture verifies signed-request shape and payload hashes; it is not AWS/MinIO certification.

Measured tiny fixture: **8.700 s verified archive age at host loss**, **20.880 s selected-time restore wall time**, and **all four rows captured by the verified checkpoint recovered** at the latest point. The later tablespace-failure fixture committed one additional row after the checkpoint; it is explicitly outside the protected window (`postCheckpointFaultFixtureRowsExcluded: 1`). These values are not a zero-loss host RPO or production RTO commitment. The earlier receipt's ambiguous `latestCommittedRowsLost` label is clarified in `native-metrics-clarification.json`; the permanent smoke now uses `verifiedCheckpointRowsLost`.

### Preserved scope and remaining work

Starting revision/tree: `starting-head.txt`, `starting-status.txt`, `starting-hashes.json`. The original seven import files remain byte-for-byte unchanged. Prior capability/cache/N03 runtime work is preserved. Additions to ownership declarations, the authorization matrix, changelog, documentation and contract launcher are intentional N04 integration. No git commit, push, deployment or release was performed.

Remaining N04 work includes continuous/incremental shipment and remote coverage across base rollover, automatic retention with recovery guarantees, node adapters, broader operator UI and external-provider acceptance. N05 retains its combined panel/application/database recovery and cutover drill. Local checkpoint recovery is not aggregate disaster-recovery certification.

Final documentation/contract recheck: **18 files / 190 passed**, exit 0 (`final-doc-contracts.log`). Whitespace checks passed. Only Markdown result/guide edits followed the final source manifest; all product/test/config inputs remain unchanged. Cleanup verified **13 run owners**, removed **7 owned image tags** by label and digest, and left no owned containers, volumes or networks. Proofs and logs are retained.

## Fourth-package implementation record — November 17, 2026

### N04 second slice — continuous WAL and safe remote retention

Continuous mode is opt-in through the existing operator API/SDK. It ships up to 128 new closed WAL segments per minute pass, validates the exact PostgreSQL cluster identity and previous decompressed WAL boundary, and publishes each new base only after extending its predecessor across the handoff. Existing configurations retain full-checkpoint mode and its immutable objects. Nodes and additional tablespaces remain refused.

Encrypted immutable anchors, segments and catalogs live under a server-allocated archive UUID. Signed conditional head publication prevents a stale writer from overwriting progress; a nonce probe refuses providers that ignore conditions. Upload read-back checks precede publication. Restart resumes from the authenticated remote catalog, including when the panel lost its local progress record. Known missing/rolled-back heads, gaps and boundary/cluster changes hold publication.

Retention keeps the boundary base and every newer generation, always preserving the newest. Retirement is committed before deletion; exact recorded keys become intents with one-hour grace. Later passes delete at most 200 objects, retry interruptions and verify all retained base/WAL references before destructive data cleanup. Cleanup never lists/deletes unrelated prefixes or legacy checkpoints. Unknown crash/orphan uploads remain retained. Local pruning waits for protection of the newest local base, so outages during rollover can increase local disk use. The [English runbook](../PITR_REMOTE_CHECKPOINTS.md) describes limits, configuration, passphrase/namespace rotation and recovery.

The existing offline tool reads continuous heads or retained immutable catalogs, selects the recovery generation and verifies every required encrypted/plaintext object before creating a data volume. Latest recovery requires the complete newest tail. Long restores must finish before retired data expires or pause the producer: this slice has no distributed restore lease.

### Validation and candidate

Evidence root: `.temp_files/package-4-20261117/`. Base revision remains `f238463e292cf5145356b41c86d179a6661d6796` with earlier uncommitted packages preserved.

- Related Windows source checks: 16 files / **1,311 tests passed**, including the actual operator API, 1,114 authorization cases, all PITR layers, S3 bounds/signing, ownership/key rotation, scheduler, dependency cycles and contract-launcher checks (`final-related.log`). Server/SDK type checks and scoped Biome checks passed.
- Continuous native acceptance: **12 scenarios passed**, including incremental WAL without replacing the anchor, three real PostgreSQL base generations, grace-period retirement/deletion, stale-writer refusal, complete source-daemon/volume/key loss, selected/latest recovery, and wrong-passphrase/missing-index/missing-WAL/damaged-WAL/damaged-index refusal before target volume creation. All labelled resources were removed (`native-stream/result.json`).
- Native image: `ninedeploy-review:n04-stream-20261117`, `sha256:ad47a7ebdbf9bf82ffbf0b9b2d6f8f619b5fc475ec1edbec4a3bf43e1cc00e5c`. The source and recovery use independent disposable Docker daemons and a separate HTTPS protocol fixture. It checks signed-request shape, payload hashes, ETags and conditional semantics; it is not external-provider certification.
- The tiny continuous fixture measured **5.231 seconds** verified archive age at source-host loss and **21.571 seconds** selected-time restore wall time. Latest restore contains all seven protected rows; these measurements do not establish production RPO/RTO. Retention time is injected; PostgreSQL backup/replay and remote deletion are real.

- Legacy native compatibility: **9 scenarios passed** on the same image, including source loss, selected/latest recovery, missing local WAL, extra tablespace refusal and invalid remote objects. All native resources were removed (`native-legacy/result.json`).
- Local Linux `pnpm release:check`: type checks, lint, builds and **19 contract files / 217 tests passed**. All seven non-server package suites passed **5,399 tests** with their coverage gates: schemas 808, DB 85, plugin SDK 7, SDK 397, MCP 53, web 2,843 and CLI 1,206. The server run completed **309 files / 9,733 tests**, including the new continuous archive tests, before Docker Desktop shut down at 12:10 local time. **The full gate is interrupted, not passed; there is no complete server coverage verdict.** `linux-release-check.log`, `linux-partial-summary.json` and `linux-ci-run.json` retain the evidence. Backend logs show orderly shutdown (`ExitHealthyState`, stop as requested); no cause or product fix is inferred. The engine remained stopped.
- Linux environment: Node 26.12.1, non-root container, frozen-lock install, DNS available, no host Docker socket. Its own `/.dockerenv` marker was removed to exercise the host-install fixtures used by CI. `linux-input-hashes.json` matches all product/test/config inputs in the recorded candidate; the only pre-gate Markdown difference was a blank-line cleanup.
- Cleanup limitation: native fixtures are completely removed. The stopped full-gate container `nd-n04-ci-5fce1539daa7` and three local review image tags cannot be inspected/removed while the engine is unavailable. `cleanup-owned.mjs` checks daemon availability, captured owner labels and image identities before removing only these resources. Cleanup remains pending until that command succeeds after Docker is available.

**Initial outcome before resumption: continuous archive implementation and focused/native acceptance complete; full release verification and remaining Docker cleanup incomplete.** The earlier Windows native-worker problem is not claimed fixed by this run. No commit, push, hosted CI, deployment or production changes are performed by this package. Remaining N04 work: node adapters, broader operator UI, orphan collection and external-provider acceptance. N05 still owns combined panel/application/database recovery and cutover acceptance.

Final Windows documentation/contract recheck: **19 files / 217 passed**, exit 0 (`final-contracts.log`). The SDK transport case and server/SDK type checks passed; workspace lint passed with existing warnings. `git diff --check` passed. `final-input-hashes.json` records the final tree: product/test/config inputs match the frozen candidate, and all seven earlier import files remain byte-for-byte preserved. Only English Markdown guide/result edits followed the candidate capture. Docker cleanup remains pending as described above.

### Resumed full validation and cleanup — November 17, 2026

**Current outcome: this N04 slice is implemented and locally verified; the full local Linux release gate and owned-resource cleanup are complete.** The interrupted run above remains retained as an interrupted result. No production code or tests changed during the resumed work.

Docker Desktop was started for verification after the continuation request. The old labelled container had exit code 137 with `OOMKilled: false`; its final state/logs were captured before removing it. All three saved image identities matched their captured labels and digests. A new labelled, non-root container used the same candidate image, Node 26.12.1 and a frozen-lock installation with DNS available and no host Docker socket. Its own `/.dockerenv` marker was removed for the host-install fixtures, as in the prior run. All 84 captured dirty inputs matched the final pre-resumption source manifest exactly (`resume/linux-input-hashes.json`, `resume/linux-input-differences.json`). This is local container-based validation, not hosted CI or an operator-host certification.

`pnpm release:check` completed with **exit 0**: runtime baseline, workspace type checks, lint, builds, 19 direct contract files / **217 passed**, and all eight forced coverage suites. Turbo reported **12 successful tasks / 0 cached**. The full workspace suites passed **20,063 tests, 0 failed, 0 skipped**:

| Package | Passed tests |
|---|---:|
| Server | 14,664 |
| Web | 2,843 |
| CLI | 1,206 |
| Schemas | 808 |
| SDK | 397 |
| DB | 85 |
| MCP | 53 |
| Plugin SDK | 7 |

Server coverage met every unchanged threshold: **93.49% statements, 88.45% branches, 92.01% functions, 96.62% lines**. The 27 continuous-WAL/retention cases passed under full coverage as well as contract preflight. Evidence: `resume/linux-release-check.log`, `resume/linux-ci-run.json`, `resume/gate-summary.json`, `resume/linux-server-coverage.json`.

The resumed runner removed its container. The earlier interrupted container and all three review image tags were also removed after ownership/digest checks. A final audit found no owned containers, volumes, networks or review images for any of the four native/CI run owners (`cleanup-result.json`, `resume/previous-container-cleanup.json`, `resume/final-cleanup-audit.json`). Logs and source manifests are retained.

The previous 21 native scenarios remain evidence for the unchanged product/test source; they were not redundantly rerun during this resumption. Only English status/validation Markdown changed afterward. Earlier Windows native-worker failures are not claimed fixed by the Linux pass. Hosted CI, cloud-provider acceptance, publication and production disaster recovery remain separate. No commit, push, deployment or release was performed. Remaining N04/N05 scope is unchanged.

## Fifth-package implementation record — November 17, 2026

### N04 third slice — remote PostgreSQL archives on nodes

Node PostgreSQL databases can opt into archive enable/disable, base backups, status and remote checkpoint/continuous production through the existing database-admin archive controls and operator remote API/SDK. The normal node database markers remain separate from panel Docker names. A typed `db.pitr` operation and `db.pitr.export` stream are gated by the live `db.pitr.archive` capability and sealed transport. Published v0.18.28 agents do not have that capability; matching candidate agents do. The node owner can disable it with `NINEDEPLOY_AGENT_PITR=off` or the existing database switch.

The agent binds each request to the managed data/archive volume ids, database slug/id, actual image, data and WAL mounts, and PostgreSQL archive flags. It exports a private read-only snapshot of a complete checkpoint or selected closed WAL through the existing authenticated binary stream. The panel verifies framing, names, lengths, hashes and exact cluster identity before its existing encryption/S3 read-back/publication/retention flow. Destination credentials and the recovery passphrase never go to the agent.

Node database operation/lifecycle locks protect panel-side copies and base/retention work; the agent has its own mutation/copy lease. Read-only status remains available during base backups. The first base backup is admitted after releasing the enable operation's lifecycle lease. Source failures preserve the last verified head. Disabling archiving recreates the node database without WAL flags and removes its local archive; previously published remote data is retained. The existing browser card exposes archive controls while disabling managed replay with an explanation. Managed node replay/adoption remains separate; published archives use the offline clean-host recovery tool.

### Verification record

Evidence root: `.temp_files/package-5-20261117/`. Starting revision is still `f238463e292cf5145356b41c86d179a6661d6796`; the 84 earlier dirty paths and their bytes were recorded before this slice. Prior import/capability/proxy/archive work is preserved. The English [runbook](../PITR_REMOTE_CHECKPOINTS.md) documents node setup, required capabilities, owner switches, transport, disk use, outages and recovery limits.

The first native run exposed an integration error: the stream framework forwards its envelope fields to kind handlers, while the new strict schema rejected `kind`, `direction` and `maxBytes`. Two permanent tests now exercise the registered `stream.open` operation, reproduce the rejection and verify the corrected operand boundary while still rejecting unknown fields (`stream-envelope-red.log`, `stream-envelope-green.log`). The failed native receipt and its successful cleanup remain retained. A timeout policy test also reproduced pruning's default RPC budget being shorter than inventory plus the existing engine's maximum pruning work; both the request policy and adapter now allow that bounded work (`timeout-red.log`, `node-final-tests.log`). No assertion, test retry or coverage floor was weakened.

A component regression first reproduced the managed-replay button remaining enabled when node status explained that replay was unavailable (`ui-node-red.log`). The node card now honors that status while keeping archive/base-backup controls usable; all 13 card tests passed. Workspace type checks, lint, server/SDK builds and the generated support matrix passed. The final native and complete release-gate results are recorded below. No commit, push, deployment or publication is performed by this package.

The first complete gate stopped at the schema capability-order contract, whose expected list still lacked `db.pitr.archive`. The strict expected list now appends that entry and parses it explicitly; its 24 tests pass (`schema-contract-green.log`). The next gate was intentionally stopped, with owned cleanup confirmed, to close a newly exercised safety requirement: raw volume restore must also refuse the node's data and WAL archive while PITR remains enabled.

The mounted restore API reproduced **200 instead of 409** for a node WAL volume and noncanonical node data/archive markers; three control cases already passed. The guard now resolves the owning database from its actual node volume marker and target host, preserving legitimate restores when PITR is off or the database lives elsewhere (`volume-guard-red.log`, `volume-guard-green.log`: 68 tests across the node/volume suites). The initial command-level quoting error is retained separately and is not counted as a failing proof. All seven earlier import files remain untouched. No other volume ownership or restore behavior was rewritten.


The guarded full Linux run completed **20,100 passed / 1 failed / 0 skipped**. The sole failure was the exhaustive old-agent refusal fixture: its feature-label map lacked the newly declared capability (`guarded/linux-release-check.log`). The missing map entry is now included, and that entire compatibility suite runs in contract preflight. A separate permanent case reproduced a current agent with the owner switch off being misreported as outdated (**422** instead of **403**); the panel capability-to-owner-switch map now includes `NINEDEPLOY_AGENT_PITR` (`owner-switch-red.log`). Updated node, registry, compatibility and launcher suites pass **117 tests** (`compatibility-green.log`). The old failed gate remains recorded as failed; its server coverage verdict is incomplete. No test assertions or coverage thresholds were relaxed.


### Final native acceptance

The final runtime image `ninedeploy-review:n04-node-compat-20261117` (`sha256:8fa431ef4937fe346cd16b05d5a2d2e250aab4c006d6130de88c0d3ab2063d03`) passed **16 native scenarios**, with all labelled resources removed (`native-node-compat/result.json`). A separate real agent serves sealed RPC and binary streams while the panel's Docker endpoint is deliberately unavailable. Both continuous and self-contained checkpoint modes pass. The fixture verifies live owner-switch refusal, preserving the remote head, and archive disable preserving SQL rows and remote recovery while removing only the node's local archive.

Three real PostgreSQL base generations hand off with overlapping WAL; expired data is retired and deleted after injected grace, retained generations recover, and stale conditional writers are refused. After removing the source daemon, agent, database/archive volumes, panel database and old master key, selected-time and latest recovery run on a clean daemon. Wrong passphrase, missing index/WAL and damaged index/WAL refuse before target-volume creation. Latest recovery contains all **seven protected rows**, with **zero protected-row loss**.

The tiny fixture measured **14.759 seconds** verified archive age at host loss and **27.128 seconds** selected-time restore wall time. These are fixture measurements, not production RPO/RTO guarantees. The separate HTTPS S3 protocol fixture checks signed-request shape, payload hashes, ETags and conditional semantics; it does not certify an external provider. PostgreSQL backup/replay and object deletion are real; only producer retention time advances through injection.


### Final full release gate

**Outcome: the node archive slice is implemented and locally verified.** The final local Linux `pnpm release:check` completed with **exit 0**: runtime check, workspace type checks, lint, builds, **22 direct contract files / 332 tests**, and all eight forced coverage suites. Turbo reported **12 successful tasks / 0 cached**. The complete workspace suites passed **20,102 tests, 0 failed, 0 skipped**:

| Package | Passed tests |
|---|---:|
| Server | 14,702 |
| Web | 2,844 |
| CLI | 1,206 |
| Schemas | 808 |
| SDK | 397 |
| DB | 85 |
| MCP | 53 |
| Plugin SDK | 7 |

All unchanged coverage gates passed. Server coverage: **93.42% statements, 88.39% branches, 91.90% functions, 96.60% lines**. All 885 server files passed, including the 21 registered-agent cases, 16 panel/node integration cases and 78 mixed-agent refusal cases (`compat/linux-release-check.log`, `compat/linux-server-coverage.json`, `compat/gate-summary.json`).

The final gate used a new labelled non-root Linux container, Node 26.12.1, pnpm 11.23.0 and a frozen-lock installation. DNS remained available; no host Docker socket was mounted. The container's own `/.dockerenv` marker was removed to select the project's supported host-install fixtures. This is local container-based validation, not hosted CI or physical operator-host certification. All **106 captured dirty inputs** matched the frozen pre-gate manifest inside the container (`compat/linux-input-hashes.json`, `compat/linux-input-differences.json`). Only English Markdown result/guide edits followed; product/test/config inputs remain unchanged. The original seven import files remain byte-for-byte identical to their task-start copies.

Earlier failed and intentionally interrupted runs remain retained with their actual outcomes. The Linux pass does not claim to fix the older Windows native-worker crash. No commit, push, hosted CI, deployment or publication was performed. Managed node replay/adoption, broader operator UI, orphan collection and external-provider acceptance remain separate N04 work; N05 retains combined panel/application/database recovery and cutover acceptance.


Cleanup completed after identity checks: **nine run owners and ten review image labels are clear**. The final CI container and all native fixtures were removed; every review image tag was checked against its captured digest/label before removal. No owned containers, volumes, networks or review images remain (`cleanup-result.json`, `owned-images.json`). Proofs, failed/interrupted receipts and logs are retained under the evidence root.


Final English documentation/contract recheck: **7 files / 47 tests passed**, exit 0 (`final-doc-contracts.log`). Whitespace checks passed. `final-input-hashes.json` records the final 106-file dirty snapshot; only Markdown result/guide changes followed the full gate, with all product/test/config inputs and the seven preserved import files unchanged.


## Sixth-package implementation record — November 17, 2026

### N04 fourth slice — operator remote archive controls

The PostgreSQL database Backups tab now includes an instance-operator-only remote archive card for both panel and node databases, using the existing SDK/API. It configures the destination, continuous/checkpoint mode, interval/retention and confirmed recovery passphrase. Legacy mode defaults remain checkpoints. Destination or passphrase changes receive a recovery-details review; existing remote objects and their original recovery information remain retained.

The status view distinguishes shipment admission from verification, displays verified ranges/key/time, WAL archive age, missing segments, failures and continuous cleanup count, and polls running passes. It preserves unsaved edits during background reads and prevents unsaved settings being mistaken for the configuration sent by a manual pass. Source eligibility/first-base readiness and HTTPS destination availability gate enabling/shipment; saving a paused configuration remains possible during source/destination outages. Role/database changes discard the form; successful saves clear secret inputs. No passphrase is put in mutation variables, query data, browser storage or URLs. English messages have matching Turkish catalogue entries.

Evidence root: `.temp_files/package-6-20261117/`. The starting revision remains `f238463e292cf5145356b41c86d179a6661d6796`; all **106** earlier dirty paths and their bytes were captured before this slice. Server/agent/archive protocol, SDK, migrations and retention/recovery engines are unchanged. No commit, push, publication or production action is authorized or performed by this slice.

### Verification in progress

Four related component/catalogue/parent-route suites passed **79 tests**. The mode-switch regression first reproduced invalid hidden interval/retention values blocking another mode, then passed after resetting only invalid hidden values (`mode-poll-red.log`, `related-green.log`). The tests cover operator isolation (including cached data), bounds, omitted/stored passphrases, rotation review, outage pause, failed requests and actual timed polling from admitted to verified state. Workspace type checks and lint passed.

The first browser harness accidentally fell through to the full app instead of its fixture page; this was a harness failure, not a product proof. A corrected harness passed desktop and phone English flows. Its Turkish pass initially used a guessed label that differed from the existing translation. Those failed receipts remain retained and are not counted as successful acceptance. Final browser/full-suite results follow below.


### Browser acceptance and narrow layout fix

The permanent `node scripts/smoke-pitr-ui.mjs --proof=<scratch directory>` mounts the actual local component, authentication provider and SDK against closed HTTP fixtures. It starts an ephemeral loopback Vite server, blocks external HTTP requests and closes its own server/browser; it uses no live panel, Docker or S3. Manual smoke inventory and setup instructions are in `scripts/README.md`.

Visual review found a clipped Cancel button despite no page-level horizontal overflow: the long new confirmation label pushed Cancel to **x = −40.875** at 320px. The strengthened browser proof checks every footer button against the dialog bounds (`dialog-red.log`). The card now uses the existing short **Save changes** label without changing the shared dialog. The same proof passed at **1366px English, 390px English and 320px Turkish**, including configuration, admitted/polled shipment, long recovery keys and the review dialog. The final fixture asserts zero console/page errors, no unexpected requests and no persisted passphrase. Screenshots/receipts are retained. The affected three component/catalogue files passed **40 tests** after the label change; the new permanent card suite has **21 tests**, including role/database navigation discarding secrets/drafts.

### Full-suite concurrency diagnosis

The default local Windows coverage run used **31 Vitest workers** and ended with **2,845 passed / 19 failed / 0 skipped** across 245 files (`web-coverage.log`, `parallel-summary.json`). All 20 new-card tests then present passed. The failures were missing DOM elements after bounded waits and two 30-second ManifestCreator timeouts, across 17 other files. The same 17 files passed all **353 assertions** with one worker and unchanged test assertions/timeouts/retry settings (`failed-files-serial.log`). That diagnostic command deliberately kept coverage enabled on the subset, so its **exit 1** reflects incomplete global coverage (about 26%), not failed assertions; it is not a successful full gate.

The complete full-suite reruns and their outcomes are recorded below. No coverage floors, retries, test timeouts or repository worker defaults were changed. The initial high-concurrency run remains a failed result and is not claimed repaired by this UI package.


The first full one-worker run completed **2,861 passed / 4 failed / 0 skipped**. These four failures were a verification-input mistake: the final short-label change was made while Vitest was active. The catalogue imported an earlier translation object but scanned the newer source, and the three rotation tests expected the new label while seeing the cached old component. The two affected files passed together in the separate 40-test final-label check. This mixed-input full run is retained as failed (`web-serial-coverage.log`, `serial-failure-summary.json`); its coverage is incomplete and is not counted as a pass. Product/test/config inputs were then frozen before the complete four-worker rerun; no repository worker defaults, assertions, retries, timeouts or coverage floors changed.


### Final frozen verification

**Outcome: the N04 operator remote archive screen is implemented and locally verified.** A new complete four-worker process used the frozen final product/test/config inputs and passed **245 files / 2,865 tests, 0 failed, 0 skipped**, with **exit 0** (`web-frozen-coverage.log`, `web-frozen-exit.txt`, `verification-summary.json`). All unchanged coverage gates passed: **98.46% statements, 93.35% branches, 98.15% functions, 99.03% lines**. All 21 card tests passed within this complete coverage run. The normal repository worker default remains unchanged; this pass does not claim the earlier 31-worker Windows timing failures are fixed.

Workspace build and final type checks passed. Workspace lint passed, and a final explicit lint of all seven changed UI/mock/browser files was clean. Final browser acceptance from the reusable smoke passed all three viewport/locale flows, including every confirmation button being fully within the dialog, with zero page/console errors and no unexpected external requests. Receipt: `browser-verified/run-YhrTa8/browser-result.json`; screenshots are alongside it. The browser and ephemeral Vite server were closed. This slice created no Docker verification resources.

Final source snapshot: `frozen-input-hashes.json` (112 dirty paths). Only English Markdown results changed afterward; product/test/config inputs match the frozen snapshot. The complete server/agent/archive-protocol and SDK source remained unchanged from the accepted node archive package. Their earlier full Linux/native receipts remain evidence for that unchanged core; this UI package does not claim a new full-workspace release gate or external-provider acceptance. No commit, push, deployment or publication was performed. Remaining N04 work includes node managed replay/adoption, orphan collection and external-provider acceptance; N05 retains the combined recovery/cutover drill.


Final documentation/contract check: **7 files / 47 tests passed**, exit 0 (`final-doc-contracts.log`), including registration of the reusable smoke in the manual inventory. Final whitespace/source-preservation checks passed. All **100** earlier dirty files outside the six intentional catalogue/documentation integrations remain byte-identical; the seven original import files and all prior server/agent/SDK implementation bytes are preserved. Proofs and failed-run receipts are retained under the evidence root.


## Seventh-package implementation record — November 17, 2026

### N04 fifth slice — safe abandoned-upload collection

The next N04 scope is bounded, opt-in collection of abandoned continuous-archive uploads. Node enrollment/cutover remains N05 work; provider acceptance requires a separate environment. `collectOrphans` is available through the existing operator API/SDK and PostgreSQL Backups card. Existing configurations stay opted out. No new agent operation, secret transfer, migration or remote catalog format is introduced.

Discovery validates a single 200-key/1-MiB URL-encoded listing from the active UUID namespace. Current head/catalog, live generations, existing garbage, fresh objects and foreign layout stay protected. Managed objects at least 24 hours old are staged into existing catalog intents, committed by conditional head publication, then wait another hour. That publication fences old producers; a collector that loses the head race does not commit orphan intents. Cursor progress commits only after publication; disabling discovery leaves existing intents to complete. Listing failures hold before new source copies/uploads and before deletion.

Evidence root: `.temp_files/package-7-20261117/`. Starting HEAD remains `f238463e292cf5145356b41c86d179a6661d6796`; all **112** prior dirty paths were copied/hashed before work. Prior packages remain uncommitted and preserved. Documentation is English.

### Verification record

The new parser/planner suite initially exposed invalid timestamps being considered old; it now excludes them (`orphans-initial.log`). Controller proofs found and fixed rediscovery of keys deleted from an earlier listing in the same pass (`requeue-red.log`), and redundant WAL uploads before a denied/malformed listing (`list-failure-red.log`: 3 failing cases, one passing control). Both publication orders are exercised with real encrypted objects and conditional HTTP behavior. The first related seven-file run passed **103 tests**; the final controller/metadata/broader results follow below.

The first native node candidate passed **17 scenarios**. The initial panel fixture stopped before any scenario because `pg_isready` observed PostgreSQL's temporary initialization server before database `app` existed; its receipt records zero cases and successful cleanup. The fixtures now wait for a real query over TCP. Final native acceptance uses a new image after the ordering and readiness fixes; the earlier candidate is retained as historical evidence, not final acceptance.


### Final native and focused acceptance

The final runtime image `ninedeploy-review:n04-orphans-runtime-final-20261117` (`sha256:135eeef6e037d1f0593e3620445189e049cffb40965f09afaecec0b4ad9f8d32`) passed **30 native scenarios: 17 on the node path and 13 on the panel path**. Both receipts confirm complete labelled fixture cleanup and **zero loss of the seven protected rows**. Aged unpublished objects were committed as retirement intents, survived grace and were then deleted, while foreign-layout keys and all live references survived. After the source daemon/agent/volumes/panel state/old master key were removed, selected/latest recovery succeeded; wrong passphrase, missing index/WAL and damaged index/WAL refused before target-volume creation (`native-node-final/result.json`, `native-panel-final/result.json`).

Tiny-fixture archive age at host loss / selected recovery wall time: node **14.089 s / 21.523 s**; panel **9.254 s / 21.224 s**. These are fixture measurements, not production RPO/RTO guarantees. PostgreSQL replay and S3 object deletion are real; retention/orphan age advances through the producer clock. The HTTPS protocol fixture validates request shape, hashes and conditions; this does not certify an external storage provider.

Final parser/controller checks: **2 files / 57 passed**, including both publication races, cursor commit/continuation, explicit opt-in, disabled discovery consuming existing intents, listing failures and no redundant uploads (`final-controller.log`; later broader coverage supersedes this focused result). Web/catalogue checks passed **28 tests**. The three Chromium viewport/locale flows passed with the additional operator option and no console/page errors, unexpected requests, overflow or persisted passphrase (`browser/run-BU466U/browser-result.json`). Related type checks passed after rebuilding the SDK; scoped lint passed with the existing fixture environment-deletion warning. No test assertions, retries, timeouts or coverage thresholds were weakened.

The final product/test/config snapshot was then frozen at **114 dirty inputs**. A new non-root local Linux container uses the final CI image, Node 26.12.1, a frozen-lock installation, DNS access and no host Docker socket. Its own `/.dockerenv` marker selects the project's supported host-install fixtures. All captured inputs match inside that container (`linux/linux-input-hashes.json`, `linux/linux-input-differences.json`). Only English Markdown verification records are edited while the complete `pnpm release:check` is running.


### Final full release gate

**Outcome: the N04 abandoned-upload collection slice is implemented and locally verified.** The complete frozen local Linux `pnpm release:check` finished with **exit 0**: runtime check, workspace type checks, lint/builds, **23 direct contract files / 362 tests**, and all eight forced coverage suites. Turbo reported **12 successful tasks / 0 cached**. The workspace suites passed **20,154 tests, 0 failed, 0 skipped**:

| Package | Passed tests |
|---|---:|
| Server | 14,732 |
| Web | 2,866 |
| CLI | 1,206 |
| Schemas | 808 |
| SDK | 397 |
| DB | 85 |
| MCP | 53 |
| Plugin SDK | 7 |

All unchanged coverage thresholds passed. Server coverage: **93.43% statements, 88.41% branches, 91.92% functions, 96.60% lines**. All **886 server files** passed, including the 21 new discovery/parser cases and 36 continuous producer/reader cases (`linux/linux-release-check.log`, `linux/linux-server-coverage.json`, `linux/gate-summary.json`). All final product/test/config inputs matched the frozen candidate. Only English Markdown result/guide edits followed that snapshot.

This is local Linux container-based verification, with the fixture environment described above; hosted CI, external-provider acceptance, physical-host acceptance and production disaster recovery remain separate. Earlier failed/provisional receipts remain retained with their actual outcomes. No Windows worker/concurrency issue is claimed fixed by this Linux pass. No commit, push, deployment or publication was performed.

## Ninth-package implementation record — November 17, 2026

### N05 combined panel-host disaster recovery drill

The [combined runbook](../DISASTER_RECOVERY.md) and `scripts/smoke-disaster-recovery.mjs` exercise the public panel API with separate disposable source and recovery Docker daemons and a separately stored RustFS 1.0.4 bucket over HTTPS. The recovery host starts with no application containers or volumes. The fixture restores an encrypted panel snapshot, two volumes and two PostgreSQL 18 logical dumps, then checks the application through Traefik and both managed database connections from its network namespace.

The drill exposed two recovery defects. Remote-only volume restore staged the download alongside the source backup path, whose parent did not exist on the recovery host. The download now uses a unique file under the current panel's backup directory. Panel import replaces the Traefik configuration directory. Docker kept the original inode mounted across the panel restart, and a healthy application failed the proxy swap. The proxy boot check now detects the replaced mount and recreates it. Each fix has a regression that failed before the patch and passed afterward.

| Check | Observed result |
| --- | --- |
| Clean-daemon recovery | **7 checks passed.** The source panel, daemon and data volume were removed before the target started its restore. The target restored the original login, the file-backed master key and the route file. It refused an incorrect recovery passphrase and old JWTs, recreated the stale proxy mount, restored both volumes and both dumps, and redeployed the application with all four protected rows and both protected files. |
| Artifact age and elapsed recovery | **6.9–12.2 seconds** at source loss and **56.7 seconds** to verified application recovery. The fixture used public images pre-pulled on the recovery daemon. See the [artifact table](../DISASTER_RECOVERY.md#verified-result-on-november-17-2026) for sizes and per-resource ages. |
| Focused server tests | **189 passed in six files** for volume restore, proxy boot, route acknowledgement and settings. The server typecheck and scoped Biome checks passed. |
| Contract and documentation checks | **362 passed in 23 files** on retry. The preceding Windows run exited on native worker error `3221225477` in `pitrContinuous.test.ts` after 357 tests passed. The retry used the same product and test source. The separate documentation cohort passed all **13 tests**. |
| Candidate and receipts | Image `sha256:02f3276d7100e3801d281d2d20c31fef8f221acea4846c76bc5c61f742b9adee`. Final receipt `.temp_files/package-9-20261117/run-fBiRen/result.json`. Earlier receipts retain the Docker Desktop interruptions, host reboot and routing acknowledgement failures. |
| Cleanup and workspace | The audit found no owned Docker resources or scratch TLS private keys across all ten attempts. It removed the three labelled candidate image tags. The starting revision and 110 unrelated dirty files matched the starting manifest. |

This slice verified local routing and logical PostgreSQL recovery. Node re-enrollment and private DNS/ACME cutover are covered in the next record. Public-provider acceptance and combined recovery to a selected WAL point remain follow-up work. The changes are local and unpublished.

## Tenth-package implementation record — November 17, 2026

### N05 node re-enrollment and DNS/ACME cutover

The [cutover runbook](../DISASTER_RECOVERY.md#re-enroll-nodes-and-cut-over-dns-and-acme) adds `--cutover` to the combined recovery smoke. The additional topology consists of a surviving node daemon, the real agent, a private DNS server and Pebble 2.10.1. The isolated Traefik image trusts Pebble's API certificate. The visitor independently trusts the issuing root and verifies the recovered hostname. The app, panel snapshot, volume archives and database dumps follow the same restore path as the first slice.

The first run uncovered two fixture problems. The DNS fixture's add endpoint kept both addresses, so the single-answer gate halted progression until the owned record was manually replaced. The TLS client then recovered both application files after valid HTTP-01 issuance, but the log assertion expected a phrase Pebble does not emit. The corrected drill clears the old DNS RRset before publishing the new address and asserts the recorded HTTP-01 request and successful authorization. The initial result is retained as a failed receipt.

| Check | Observed result |
| --- | --- |
| Final cutover drill | **11 checks passed.** The surviving node re-announced against the restored panel and retained its original ID and running workload. The panel refused stale enrolment credentials and a mismatched identity. After source fencing, the old DNS answer could not serve the application. The private DNS update published one recovery address. Pebble completed HTTP-01, the client verified the certificate and hostname, both restored files returned HTTPS 200, and HTTP redirected with 302. |
| Elapsed recovery | **61.7 seconds** to private application verification, **75.7 seconds** to completed cutover and **9.9 seconds** from the start of DNS cutover to verified HTTPS and redirect. The zero-TTL resolver represents this isolated fixture. |
| Focused checks | **274 server tests in seven files** covered node registration, enrolment credentials, agent transport, domains, proxy routing and Traefik startup. **13 documentation and inventory tests** passed, along with Node syntax, scoped Biome and whitespace checks. |
| Candidate and receipts | Image `sha256:2333940944c397f9ca975193c9d734ac39b31f4a906b348cd6c9b13d1ef259eb`. Final receipt `.temp_files/package-10-20261117/run-prSMZv/result.json`. |

This slice covered a surviving auto-discovered node and the application ingress. The clean-node replacement and public staging preflight are recorded below. Production CA issuance and combined recovery to a selected WAL point remain separate acceptance cases.

## Eleventh-package implementation record — November 17, 2026

### N05 clean node replacement and public staging preflight

| Check | Observed result |
| --- | --- |
| Combined clean-node recovery | **11 checks passed.** The old node, Docker volumes and agent state were removed. The recovered panel refused the old SSH fingerprint, then used the verified replacement fingerprint to re-bootstrap the same endpoint with a fresh agent credential. Service and database placement survived. The workload served the restored file and queried both protected rows. The later file and SQL writes were absent. |
| Node recovery interval and artifacts | **193.1 seconds** from node removal to data verification, including panel recovery and cold image pulls. The node volume archive was **767 bytes** and the PostgreSQL dump **1,520 bytes**. Candidate `sha256:7c0ae50d92181ffe598b8e74925f5689ebeb60f26a80fbebca7450b0fb3824d0`. Receipt `.temp_files/package-11-20261117/run-KNnPFV/result.json`. |
| Focused checks | **278 server tests in eight files** and **13 documentation and inventory tests** passed. Three staging input checks verified zone suffix and credential validation. |
| Public DNS and staging CA | The existing hostname resolved through Cloudflare and answered HTTPS 200. The Let's Encrypt staging directory returned a replay nonce and its official test site passed staging chain verification. The disposable Cloudflare cutover and new DNS-01 order remain pending a zone-scoped API token. The preflight made zero DNS changes. |

[Clean-node and public staging runbooks](../DISASTER_RECOVERY.md#recover-a-node-after-complete-local-state-loss)


Owned-resource cleanup completed: all **five run owners and five review image labels** are clear (`cleanup-result.json`, `owned-images.json`). Each image tag was checked against its recorded digest/label before removal. Native fixtures and the final CI container are gone; proofs, failed/provisional receipts and logs remain under the evidence root.


Final English documentation/contract recheck: **7 files / 47 tests passed**, exit 0 (`final-doc-contracts.log`). Final whitespace checks passed. All **89** earlier dirty files outside the 23 intentional integration paths remain byte-identical, including the seven original import files. `final-input-hashes.json` records the final 114-path tree; product/test/config bytes match the full-gate snapshot. Only English Markdown verification/guide edits followed it.

## Eighth-package implementation record — November 17, 2026

N04 passed provider acceptance against **RustFS 1.0.4 over HTTPS**. The test used a self-hosted RustFS container with a dedicated storage volume and test bucket in a private Docker Desktop network. Each run used separate source and recovery daemons. The provider and its volume stayed online when the drill removed the source daemon, PostgreSQL data and WAL volumes, panel database and master key. The node run also removed its agent.

- **Provider protocol.** RustFS returned HTTP 200 for signed bucket creation and HTTP 403 for a request with an incorrect signing secret. The production listing parser read all 201 escaped keys across pages of 200 and one using the provider’s continuation token. The drill emptied that test prefix and confirmed it was empty. The producer’s conditional-write probes and the independent stale-writer test passed.
- **Shipment and cleanup.** New closed WAL shipped without replacing the base anchor. Three PostgreSQL base generations handed off with overlapping WAL. An expired generation and an abandoned upload survived the grace period and were deleted on a later pass. Two recovery generations, their live references and an unmanaged key survived. The drill advanced the producer clock to exercise age and grace boundaries. RustFS performed the actual listing and deletes.
- **Recovery.** The offline tool restored into new volumes on a fresh daemon. Selected-time recovery contained `one`, `two`, `three` and `four`. Latest recovery contained all seven protected rows. The recovered database accepted the new password. Wrong passphrase, missing index, missing WAL, damaged WAL and damaged index were refused before creating target volumes. The node run also verified checkpoint publication, the live owner switch and safe disable.

| Source | Scenarios passed | Archive age at source loss | Selected restore wall time | Protected rows lost |
|---|---:|---:|---:|---:|
| Panel | 15 | 7.716 s | 24.402 s | 0 |
| Node | 19 | 15.426 s | 21.827 s | 0 |

These timings describe the PostgreSQL 18 test dataset and local Docker network. The acceptance scope is the tested RustFS build and configuration. Cloud accounts, provider failover, bucket versioning and Object Lock were outside this run.

The tested NineDeploy candidate was built from the local tree at base `f238463e292cf5145356b41c86d179a6661d6796`. Its image ID was `sha256:792567148132ab524c1eb9b0d837e75e0d5186f4f2f9f49e293e91d2c3e8ffe7`. The RustFS image ID was `sha256:ed9210d6411d77ffceb70d94b964a3cb7d225983368bc25bebe01e995293dcc2`. This package adds a reusable `--rustfs` smoke mode and keeps all archive runtime source bytes from the preceding package.

Related server tests passed **93 tests across five files**. Documentation and contract checks passed **47 tests across seven files**. Script syntax and scoped Biome lint checks passed. Evidence is under `.temp_files/package-8-20261117/`. The final panel and node receipts are `panel-1/result.json` and `node-final/result.json`, with exact row checks in `verify.log` and `latest-verify.log` beside each. The initial node run, before the extra pagination scenario was added, passed 18 scenarios. The post-run audit confirmed all three resource labels were clear, both copies of each temporary TLS private key were removed, and the candidate image tag was removed after its identity was verified. See `verified-results.json`.
