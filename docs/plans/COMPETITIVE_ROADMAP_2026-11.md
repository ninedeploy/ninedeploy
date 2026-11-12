# Competitive roadmap: 2026-11

**Drawn up on 2026-11-09** against `main` at e85dbf45 (0.18.25). The tree had 12 modified files from another session; they are not part of this plan.

**Sources:**
- three read-only reviews run on the same day: code health and structural debt, competitor state, and product and adoption;
- the competitive gap report in `.temp_files/competitive-gap-20261109/REPORT.md`, which pins 12 competitor sources;
- spot checks of the claims these rely on, against the source.

The working notes are git-ignored:
- `.temp_files/compet_20261109/` holds the competitor issue rankings, advisory counts and raw release notes;
- `.temp_files/competitive-gap-20261109/` holds the pinned competitor sources.

This plan follows on from [ROADMAP.md](../ROADMAP.md) and [GAP_ROADMAP.md](../GAP_ROADMAP.md), whose items are all done except R2. It does not re-plan R2 (node ordered lifecycle, autoscaling and sleep acceptance, 0.19.0), because another session owns it; see [COMPETITIVE_DELIVERY.md](../COMPETITIVE_DELIVERY.md).

Every item follows the rule every release follows: installed servers upgrade in place; migrations are additive only; new behaviour is opt-in or keeps the old default; and `smoke:upgrade` exercises the item after an upgrade.

---

## 1. What changed: features are no longer the bottleneck

Six weeks of roadmap work closed almost every feature gap found in October. What decides whether NineDeploy beats its rivals now lies elsewhere.

**Adoption is near zero.**

| Signal | NineDeploy | For comparison |
|---|---|---|
| GitHub stars | 16 | Coolify 65.8k, Dokploy 38.3k |
| Forks | 3 | |
| Issues ever opened | 0 | |
| Commits by one author | 1,925 of about 1,980 | |
| Tags in the last 30 days | 47 | |

The repository also has:
- no importer from another platform;
- no screenshots in the README;
- no CONTRIBUTING, SECURITY or CODE_OF_CONDUCT file.

**The rivals are closing in on our differentiators.**
- Coolify 4.5.1 to 4.7.0 (2026-10-20 to 11-09) shipped workspace-enforced 2FA, compose build skip, per-resource RBAC for members and tokens, update channels (stable, preview, nightly), and image scanning with API and MCP tools.
- Dokploy 0.31.0 shipped moving services between servers and audit-log export.
- GAP_ROADMAP's G5 heading, "None of the Docker-based rivals has these", is no longer true as a group claim.

**Structural debt now causes silent data loss in ordinary operations.**
- About 25 per-entity `settings` key prefixes hold feature state.
- They are untyped.
- They are orphaned when their entity is deleted.
- They are dropped on export, import and clone (§3).

**The capability story is inconsistent.**
- The server has 45 distinct `*_unsupported`, `*_unavailable` or `*_refused` codes.
- Several docs contradict each other or the code (§2).

**Security is a selling point we don't use.**

| Platform | Event in 2026 | Source |
|---|---|---|
| Coolify | 61 GitHub advisories, 16 critical | Counted on 2026-11-09 |
| Dokploy | 56 GitHub advisories, 33 critical | Counted on 2026-11-09 |
| Dokploy | A fresh instance was taken over through its open setup page | [#5156](https://github.com/Dokploy/dokploy/issues/5156) |
| Railway | Breach disclosed on 10-21 | [changelog](https://railway.com/changelog/2026-10-23-october-21-security-incident.md) |
| Northflank | Breach disclosed on 10-30 | [BleepingComputer](https://bleepingcomputer.com/news/security/northflank-security-breach-leads-to-abuse-of-customers-ai-api-keys) |

NineDeploy already has:
- argv-only command execution;
- a setup token on first boot;
- signed releases;
- real restore verification.

These are told nowhere a buyer would look.

**Hence the order of this plan:**
1. Truth: one contract for what works where.
2. Structural debt.
3. Adoption.
4. Parity across runtimes.
5. Reliability and data.
6. New modules, last.

Priority: **P0** means fix now, because it is wrong or loses data today. **P1** is the next releases. **P2** comes after P1. **P3** is a strategic choice for the owner.

Size: **S** means at most a patch. **M** is one or two patches. **L** is a multi-patch package. **XL** is architectural.

Status: ⬜ not started · 🟨 in progress · ✅ done (with the release that shipped it)

---

## 2. T0: One capability contract

| ID | Item | Evidence | Approach | Pri | Size | Status |
|---|---|---|---|---|---|---|
| C1 | **Capability registry.** A single versioned table of feature × runtime gives the support status of each feature on each runtime. The runtimes are panel-host Docker, node Docker, Compose, Swarm and PM2. Each row can also require an agent capability. | 45 refusal codes spread across modules; the UI learns a combination is unsupported only after save (REPORT G11/G12) | A typed registry in `packages/schemas`. It feeds three things: `GET /v1/capabilities?serviceId=` for the UI, which disables a control before save and says why; a generated public support matrix in the docs; and the README comparison (A5). A guard test fails when a refusal code has no registry entry, or an entry has no refusal path. | P0 | M | ✅ unreleased, narrowed: 9 service features (`lib/serviceCapabilities.ts`) evaluated structurally; their routes refuse through `assertServiceCapability` (same codes and messages); `GET /v1/services/:id/capabilities`; three cards and a limits card use it; docs/SUPPORT_MATRIX.md generated by a snapshot test. The "every refusal code maps to an entry" guard was dropped: most codes are operational. Replaced by "every feature id is refused through the shared assert" |
| C2 | **Fix doc drift now.** | Autoscaling is documented as panel-host only, but node cpu/memory/rps exists (`autoscaler.ts:61,71`; `DEPLOYMENTS.md:122`). Scale-to-zero is documented as panel-host only, but the node sleep coordinator defaults to on (`env.ts:57`; `DEPLOYMENTS.md:235`). ROADMAP's R6 row says installers are unpublished, but 0.18.25 ships them. COMPETITIVE_DELIVERY's gate snapshot calls R4 and R5 unreleased. ROADMAP's "Later" list still lists PITR. GAP_ROADMAP's G5 heading. The README's "no scheduler" wording needs to name what is actually missing. | Correct each statement from current code. Keep historical receipts, dated. | P0 | S | ✅ docs (ROADMAP, GAP_ROADMAP, COMPETITIVE_DELIVERY, DEPLOYMENTS autoscaling, README). Node scale-to-zero wording stays with R2: the coordinator defaults on (`env.ts:57`), but node sleep is not accepted yet |
| C3 | **Separate public from internal docs.** | `AUDIT_*`, `SECURITY_AUDIT_*`, `GAP_ROADMAP`, `COMPETITIVE_DELIVERY` and `SWARM_RUNTIME_ACCEPTANCE` sit next to the user guides. They are full of CI run IDs and commit SHAs. | Move them to `docs/internal/`, keeping relative links. Reorganise the rest as Get started / Guides / Reference / Operate. | P1 | S | ✅ unreleased, without moving files: `docs/README.md` indexes every document as Get started / Guides / Reference / Project records, guarded by `test/docsIndex.test.ts`. Moving files to docs/internal/ was dropped: it would break links and move files another session is editing (COMPETITIVE_DELIVERY, SWARM_RUNTIME_ACCEPTANCE) |

## 3. T1: Structural debt

| ID | Item | Evidence | Approach | Pri | Size | Status |
|---|---|---|---|---|---|---|
| S1 | **Typed settings-row registry.** | `getSettingJson<T>` casts with no validation (`lib/settings.ts:37-47`). `setSettingJson` writes through `as unknown as boolean` (`:52`). About 25 per-entity prefixes and 54+ singleton keys are each validated (or not) at their own call site. | Declare each prefix once, with: a zod schema; the owning entity kind (service, domain, database, server, githubApp, workspace or ssoProvider); whether it holds a secret; and its export/clone policy. Reads go through the declaration. An invalid row reads as the fallback and logs once. | P0 | M | ✅ ownership, key shapes and export policy in `lib/ownedSettings.ts` (source-scan guard `test/ownedSettings.test.ts`); the stored shape of all 23 prefixes in `lib/ownedSettingSchemas.ts` (completeness test `test/ownedSettingSchemas.test.ts`). `readOwnedSettingJson` reads an invalid row as the fallback and logs once; the readers that only cast (commit status, error-ingest key, SCIM suspended seats, service move, image scan) and two hand-checked ones (registry hook, SAML link) use it; those with their own zod parse keep it. Still open: the ~54 singleton keys are not declared |
| S2 | **Remove owned rows when the owner is deleted.** | Service delete (`modules/services.ts:1201`) removes no settings rows. The emitted `service.deleted` and `database.deleted` events have no listener. Database, domain, GitHub App, workspace and SSO provider deletes leave rows behind as well. Orphans keep a registry-hook token hash and an error-ingest key, and `enforceRestartLimits` iterates dead ids on every pass (`restartLimit.ts:115`). | Delete the S1-declared rows in the same transaction as the entity row. Add an idempotent sweep for existing orphans to the housekeeping plugin. IDs are AUTOINCREMENT, so no new entity ever inherited an orphan. | P0 | S | ✅ unreleased: removed after service (with its domains), database, domain, GitHub App and SSO provider deletes; the hourly `owned-settings` housekeeping sweep re-checks the owner for each row; cloud-VM links exempt |
| S3 | **Carry feature state through export, import, clone and move.** | Service export reads only services, build configs, env, domains, webhooks and attachments (`modules/serviceMigration.ts:61-125`). Clone copies only the inline Dockerfile (`services.ts:~1976`). An exported inline-Dockerfile service therefore loses its Dockerfile. Maintenance, forward auth, restart limit, sticky sessions, compose routes, CI pipeline and commit status are silently dropped. | Each item follows its S1 export policy. Non-secret state travels. Secrets such as hook tokens and ingest keys are generated fresh, and the import report lists them. Bundles keep their old format readable. | P0 | M | ✅ unreleased: `lib/portableSettings.ts`, typed and validated per field; export bundle `settings`, per-domain `settings` and `notCarried`; import reports `settings.applied`/`skipped`; clone copies all but maintenance; secrets named, never copied |
| S4 | **Prefix scans on hot paths.** | 10 `like(settings.key, 'prefix%')` scans. SQLite's `LIKE` is case-insensitive, so it cannot use the key index. `routingOverrides` and `forwardAuthDomains` run on every Traefik render (`engine/proxy.ts:1113,1193`), and `writeDynamicConfig` has 81 call sites. | Measure on a populated database first. Then switch to a key range (`key >= p AND key < p || x'ff'`) or `GLOB`, both of which use the primary key, and cache per render. | P1 | S | ✅ unreleased: `settingRowsWithPrefix` reads a primary-key range; all 10 `LIKE` scans moved onto it (EXPLAIN QUERY PLAN: `SCAN … COVERING INDEX` became `SEARCH … (key>? AND key<?)`) |
| S5 | **Promote hot or relational settings state to real columns or tables.** | Hot-path or per-entity state (maintenance, forward auth, compose route, restart limit) lives in JSON rows that have no foreign key and no cascade. | Use additive migrations, with a dual read for one release: new column first, row as fallback. Do this only for state that S4 shows to be hot or that needs a cascade. The rest stays declared in S1. | P2 | M | ⬜ |
| S6 | **Panel state lost on restart.** | 109 module-level Maps or Sets and 43 timers. A canary ends when the panel restarts (`engine/canaryState.ts:61`; `DEPLOYMENTS.md:100`). | List the in-memory state that a user would notice losing: canary, sleep tracking and forward-auth codes. Persist only that state, or document its loss in C1. | P2 | M | ⬜ |
| S7 | **Browser end-to-end tests in CI.** | Web tests run only in jsdom (`apps/web/vitest.config.ts:6`). No workflow runs Playwright. | Promote the isolated-panel Playwright capture (DinD with the panel image) into a CI job covering the ten main journeys: setup, first deploy, domain and TLS, env, rollback, database and backup, preview, approval, member access, and the Turkish locale. Run it on desktop and phone widths. | P1 | M | 🟡 **Thin slice built:** `e2e/` holds Playwright 1.64.1 with its own lockfile, outside the workspace. `scripts/smoke-browser-e2e.mjs` runs dind plus the image. `.github/workflows/browser-e2e.yml` runs after each green main CI push, on `main-<sha>`, and does not block yet. It covers setup (setup-token link, Let's Encrypt box unticked), the first image deploy through the wizard until it is running, the Turkish locale, and 10 pages plus a service at phone width (no overflow, console errors or API 4xx/5xx). Its first run found three panel bugs, all fixed: a CSP-blocked Google Fonts import, a projects 401 on the sign-in page, and a second `<main>`. Env and rollback added (a variable set in the panel, a confirmed redeploy, a rollback to the first release). Database and backup added (PostgreSQL from the wizard, then Backup now leaves a completed, non-empty backup). Approval added (a lane that requires approval; a deploy-hook deploy waits until the admin approves it, then runs). Member access added (the owner creates an account and adds it to the workspace; the member signs in, sees the services, and gets 403 on operator routes). Domain and TLS added (`09-domain-tls`, classic and compact): a domain added in the Domains tab gets a Traefik router to the running container (routing API and the Live routing card), HTTPS switched off and on follows into the router, and removing the domain removes it; no certificate is issued (no ACME account, `.test` name). **Next:** preview needs a git fixture. Generate the README screenshots from this harness. |
| S8 | **Unwired smoke scripts.** | No workflow runs 6 of the 28 `scripts/smoke-*.mjs`, and `smoke-node-operations` is referenced nowhere. | Wire each one into a workflow or delete it. | P1 | S | ✅ classified rather than wired: the six are manual tools (promotion, focused acceptance), listed in `scripts/README.md` with what they need and which daemon they touch; `smoke:node-operations` alias added; `test/smokeInventory.test.ts` fails on any smoke that is neither in a workflow nor listed. Moving any of them into CI is a separate decision |
| S9 | **Hot files.** | `engine/pipeline.ts` has 2,409 lines and `modules/services.ts` has 2,010. The panel's `DeployWizard.tsx` has 1,596. | Split a file only while an item is already changing it. This is not a refactor project. | P3 | — | ⬜ |

## 4. T2: Adoption, the biggest gap

| ID | Item | Evidence | Approach | Pri | Size | Status |
|---|---|---|---|---|---|---|
| A1 | **Importers from Coolify, Dokploy and CapRover**, then Heroku `app.json` and Procfile. | No platform importer exists: `serviceMigration.ts` moves only NineDeploy bundles. Temps ships a CapRover importer. The switchers we can win come from these platforms. | **Step 1**, read-only: an adapter reads the source through its API or a database dump and produces a normalised plan. The plan lists each unsupported option, secret, volume and database by name before anything changes. **Step 2**: import image and Git services with domains, env and limits, resumable with receipts, leaving the source untouched. **Step 3**: move data, checksummed, with DNS cutover as an explicit last step. Coolify's and Dokploy's compose templates map onto our converters. | P1 | L | 🟡 **Step 1 built (CLI):** `ninedeploy import plan coolify|dokploy|caprover` is read-only. Credentials come from env or a hidden prompt; plans hold names only, guarded by a sentinel test. Adapters were written against v4.7.0 / v0.31.0 / v1.16.0 source, and the fixtures are derived from source. **CapRover v1.16.0 checked live** (2026-11-09, dind): the capture is a test fixture, and it found three gaps the source reading missed (placeholder image, stopped apps, version). Dokploy and Coolify were captured live later (below). **Step 2 built (CLI):** `ninedeploy import apply plan.json [--yes]` creates services and empty databases from a saved plan. It never deploys and never adds a domain (that would request a certificate, or with Cloudflare write DNS, before the cutover). Env values come only from `--dotenv <service>=<file>`. It keeps a receipt (pending before each call, done after) and resumes with `reuseExisting`. **Step 3, databases built (CLI):** `ninedeploy import data plan.json` prints the no-lost-writes order and a per-database dump command (credentials read inside the container). `--dump <db>=<file> --yes` imports through the chunked dump import with sha256 checked by the panel. The receipt resumes and never imports twice. Proven live: CapRover v1.16.0 PostgreSQL 16, 500 rows, same md5 after import. **Step 3, domains built (CLI):** `ninedeploy import cutover plan.json [--yes]` adds each planned domain only when its service runs a successful deploy and its DNS (queried directly, against `--expect` or Settings → DNS records) already points here. It never adds the source's own hosts, lists wildcards for a person, verifies pending ownership proofs, and refuses `--skip-dns-check` while the Cloudflare integration is on or unknown. **Connection strings built (CLI):** `import apply --dotenv` reads each value locally. Where a value names a source database host and the panel's connection string can replace it exactly, apply attaches the new database under that variable; otherwise it lists the variable with the reason (scheme spelling, `?options`, Redis db index, Mongo, a bare host, the old platform's own host). Proven live: the deployed container's `DATABASE_URL` named the new database. The same review found and fixed a MySQL dump that put the rows beside the managed database (`--databases`), proven live with MySQL 8.4. **Volumes built (panel + CLI):** `POST /v1/services/:id/volume-imports` takes a gzipped tar in chunks with its sha256, refuses while the service runs, snapshots an existing volume (`pre-import` backup) and restores through the staged swap; `import data --volume <service>=<file>` prints the source command (the named volume mounted read-only by name) and imports it. Proven live from CapRover v1.16.0: owners, modes, symlinks and checksums equal after deploy. The proof found that the staged swap dropped symlinks whose target was not there at that moment (`[ -e ]` follows links), in every volume backup restore too; fixed. **Heroku built (CLI):** `import plan heroku --url <repo> --dir <checkout> [--app]` maps app.json and the Procfile: each process becomes a Nixpacks service with its start command (checked live: Nixpacks honours a per-service start command through a shell, sets PORT; the heroku/paketo/Dockerfile packs ignore start commands), workers get the `running` health check, `release` is explained rather than mapped (Nixpacks runs it as a build step; the panel's pre-deploy hook runs in the panel container), and the Postgres/Redis add-ons become databases attached as DATABASE_URL/REDIS_URL. **Dokploy v0.31.0 checked live** (2026-11-11): the plan matched a seeded project field for field (fixture kept), the printed pg_dump and volume commands worked on the Dokploy host, and a default API key turned out to be rate-limited (10/day; refused after 5 calls), so the 401 message and docs now say to create one without a limit. **Coolify 4.7.5 checked live** (2026-11-11, read-only: the API was read, nothing deployed): the plan matched a seeded project (two apps, PostgreSQL, Redis, a one-click service; fixture kept), a `read` token got no secret value, and the run found that every public-repository app was falsely told to reconnect private access (Coolify's built-in "Public GitHub" source, GithubApp id 0); fixed. Coolify's dump and volume commands are still unrun. **Next:** A3. |
| A2 | **First run in one flow.** | About 7 steps from a fresh VPS to an app on its own domain with TLS. The panel runs on HTTP `:3000`. The ACME email is set in a separate settings step. The first automatic URL is HTTP-only. The getting-started checklist is shown to operators only (`Dashboard.tsx:134`). | Add `install.sh --domain panel.example.com --email` (prompted for on a TTY), so the panel gets its certificate during install. Ask for the ACME email in the setup form. Deploy a sample app as the last setup step. Show the checklist to every new user. Measure the time to a healthy HTTPS app on a clean host and publish it (REPORT G14). | P1 | M | 🟡 **Built:** `install.sh --domain/--email`, with the first-install prompt, strict validation and a DNS warning. Compose passes `NINEDEPLOY_DOMAIN`. The setup form offers the admin email for Let's Encrypt. sslip.io seeding is kept through `NINEDEPLOY_PUBLIC_IP`. The sample-app step was already there (FirstDeployCard, Next.js demo). **Not done:** the checklist for every user (its routes are operator-only, so it needs a member variant), and the clean-host timing, which waits for the cloud accounts (§9 Q8). **Follow-up:** a dind proof showed Traefik reaches the panel only through the Docker gateway on host port 3000. A loopback bind, or a Docker-mode `NINEDEPLOY_PORT` other than 3000, takes the panel off its domain; the installer warns about both. The real fix is to route the panel domain to the panel container over the `ninedeploy` network, and to the configured port. |
| A3 | **A lighter interface.** | The sidebar has 26 items in 5 groups, with overlapping pairs: Hub/New, Queue/Deploys, Networks/Topology. The service page has 15 tabs, and its Settings tab has 27 cards. Instance Settings has 20 sections. Coolify's redesign drew a "revert the new UI" thread ([#11610](https://github.com/coollabsio/coolify/discussions/11610)), so don't change it all at once. | Merge the overlapping pairs. Cut the service page to about 6 tabs (Overview, Deploys, Environment, Domains, Logs, Settings) with an Advanced section. Simple mode stays the default. Ship the change behind a toggle for one release, and run S7's journeys before and after. | P1 | L | 🟡 **Step 1 built (web, opt-in):** Settings → Appearance → Layout → Compact (`lib/layout.ts`, per browser; classic stays the default). Service page: Overview, Deploys, Environment, Domains, Logs (runtime logs + activity), Settings, the other nine under More (same `?tab=` keys, More opens for a deep link). Settings folds 11 rarely used cards under More settings; a card whose feature is on never folds (`SettingsFold.tsx` watches the cards' own query cache). Sidebar 26 → 25: Hub becomes New (one for one; the Deploy panel's duplicate New resource button goes), Networks into Topology (link, Advanced mode). Queue kept: /deploys is the only cross-service list of deploys awaiting approval, and the top-bar badge hides itself when nothing is in flight. S7: projects `desktop-compact` (04, 06 under per-layout names, 08-compact) and `phone-compact`. Not in this step: the 20 Instance Settings sections. **Next release:** compact becomes the default and classic is deleted. |
| A4 | **Framework guides with starter repos.** | Next.js, Laravel, Django and Rails appear only in tables. No "Deploy X" guide exists. | Write 8–10 guides: Next.js, Laravel, Django, Rails, FastAPI, Express, Astro, Go, Spring and a static site. Each gets a starter repository and a `.ninedeploy` manifest, and the guides run in a CI smoke. | P1 | M | ⬜ |
| A5 | **README and website.** | No screenshots, GIF or comparison table. 55 lines of cosign instructions come before First boot. `old_website/` says v0.13.0 GA. The strengths below are barely mentioned. | Add a hero GIF and 4–6 screenshots. Add an honest comparison generated from C1. Move release verification below First boot. Delete or refresh `old_website/`, after confirming which source the live site is built from. Lead with: restore verification; protected lanes and approvals; remote MCP with OAuth; argv-only execution and a locked first boot; and "your secrets stay on your server". | P1 | S | 🟡 The README now leads with "Why NineDeploy" (each claim linked to its proof) and an honest "How it compares" (no yes/no matrix: the research did not verify rival depth). Release verification moved below First boot. `old_website/` deleted: the owner says the live site is built from another repository. Screenshots: a dashboard hero plus six images, generated by the browser harness (`e2e/tests/screens.spec.ts`, `ND_SCREENSHOTS`) and about 600 KB of JPEG. Not done yet: a hero GIF. |
| A6 | **Release channels and user-facing release notes.** | 47 tags in 30 days. The CHANGELOG has 6,984 lines, and its latest entries lead with CI internals. Coolify 4.6 added stable, preview and nightly channels. | Add a **stable** channel that moves only after a soak period, and keep **current** as today's patch stream. The self-updater follows the chosen channel. Each release starts with 3 user bullets and an "Action needed: yes/no" line, with an Internal section below. | P1 | M | 🟡 The stable channel is built. A daily workflow moves the `stable` tag after a 7-day soak; a release marked as a security fix is promoted at once, and a held release never. The panel runs a separate update check per channel (Settings → System → Update channel). The installer takes `--channel stable`, which also sets the panel channel. The release-notes format is built too: each CHANGELOG section opens with **Highlights** (1-3 user bullets) and **Action needed:**, CI and test entries go under `### Internal`, `scripts/release-notes.mjs` leads the GitHub release notes with the block (plain notes for older tags), and `release:tag` refuses a section without it (`test/releaseNotes.test.ts`). |
| A7 | **Community basics.** | CONTRIBUTING (only 10 lines in the README), SECURITY.md, CODE_OF_CONDUCT, issue templates and Discussions are all missing. | Add the files, a SECURITY.md with a disclosure address, a public roadmap view of this file, and Discussions. The launch date is owner decision 2 (§9). | P1 | S | 🟨 files added (CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, issue and PR templates). Repository settings wait for the owner: private vulnerability reporting (SECURITY.md relies on it), Discussions, and the Sponsors account for FUNDING.yml |
| A8 | **Template slugs named after a competitor.** | Public URLs read `/templates/coolify-*`. | Rename them with redirects, and credit the upstream catalogues in TEMPLATE_MIRRORS.md. | P2 | S | ⬜ (approved 2026-11-09) |
| A9 | **Signed desktop installers** (REPORT G15). | The 0.18.25 installers are unsigned, which triggers SmartScreen and Gatekeeper warnings. Keychain on a real Mac is unverified. | Signing is already wired to repository secrets and needs certificates. Until they exist, keep the desktop app out of the README's headline. | P2 | M | ⬜ (deferred: no certificates yet) |

## 5. T3: Parity across runtimes

C1's matrix decides each cell: close it, or keep the refusal as a stated design limit. Never remove a guard just to fill a cell.

| ID | Item | Today | Approach | Pri | Size | Status |
|---|---|---|---|---|---|---|
| P1 | **Swarm worker tasks: metrics, terminal, files, inspect** (REPORT G02). | Metrics average only the panel host's tasks. Terminal, files and inspect refuse with `swarm_task_elsewhere` (`modules/containers.ts`, `terminals.ts`). | Go through the node agent on the worker that runs the task. An unreachable worker shows as unknown, not as zero. A moved task never inherits an old terminal. Prove it on two separate daemons. | P1 | L | ✅ Built: `lib/swarmTaskTarget.ts` reaches a task on a joined worker through its agent (manager names node, state and container id; the worker must report the task and service labels); terminal sessions stay pinned to the task. Metrics average every Running task from the panel host and joined workers (`swarmServiceStat`, `measurableSwarmTasks`); unknown unless all were measured. Proven on two daemons by `smoke-multinode --swarm-only`. Jobs and one-off commands stay on panel-host tasks. |
| P2 | **Node parity for panel-only features.** | These refuse on nodes: maintenance mode and error pages (`modules/maintenance.ts:116-144`), forward auth (`modules/forwardAuth.ts:67-70`), restart limit (`modules/restartLimit.ts:28`), compose image scans (`imageScan.ts:285`), deploy hooks, the static pack, LFS, and the volume file browser. | One agent capability per feature, in the order users hit them: maintenance and error pages, forward auth, restart limit, volume files, deploy hooks. An older agent keeps refusing. | P1 | L | 🟡 **Maintenance and error pages built** (capability `proxy.pages`, agent v0.18.27):
- The node serves them from `ninedeploy-pages` (agent image, read-only, nobody, no port), with the panel-rendered pages in `.agent-proxy/pages/<id>.json` mounted read-only.
- `syncNodeProxy` writes the pages, prunes, ensures the server, and only then renders `pages: true`. A save counts only when its own sync put the service's pages on the node. Otherwise the previous value is restored and re-rendered, and the save answers 502 `node_pages_unapplied` (nothing re-syncs a node on a timer, so a kept setting would never apply).
- Same Host rule as the panel. Maintenance wins over node sleep, and a bypass address still wakes the service.
- Moves to a page-serving node are allowed; fan-out stays refused. C1 shows `limited` with the agent requirement.
- Checked live on a node DinD (503 + Retry-After, bypass, custom 502, foreign Host 404, re-ensure, switch refusal).

**Restart limit built** (no new agent capability):
- The sweep samples a node docker service through `docker.identity` (ownership by service and deployment, never the name alone) and `docker.readiness` in `running` mode, which reports `RestartCount` even while a container restarts. `docker.metrics` refuses such a container.
- A trip requests the Stop button's own ordered node Stop (`acceptNodeLifecycleIntent`). The reconciler audits `service.stop` when it settles, and `service.restart_limit` carries `stopRequested`.
- It never cancels a deploy (including `awaiting_ci` and `awaiting_approval`), a pending lifecycle command, or a sleep or wake. A failed sample keeps the history. Panel-host services are sampled first.
- C1 shows `limited` on a node and `unavailable` for a node fan-out. Turning it on, or moving with it on, checks the target agent live with `assertNodeLifecycleAvailable`.

**Forward auth waits on an owner decision:** the node must reach the panel's verify endpoint, which docs/NODE_SLEEP_WAKE.md rules out. Either a node-side verifier of signed sessions (keeps working while the panel is down) or a route to the panel through the agent.

**Volume files were already at parity** (a22f936d): `volume.fileTool` (capability `volume.files`, switch `NINEDEPLOY_AGENT_VOLUME_FILES`) behind `/v1/servers/:serverId/volumes/:name/files`, and the service's Volumes tab passes the node. Instance operators only, the same rule as on the panel host, where `requireAdmin` also means operator.

**Deploy hooks built** (capability `docker.hooks`, agent v0.18.27, switch `NINEDEPLOY_AGENT_DEPLOY_HOOKS`):
- Pre-deploy and post-deploy run in a one-off container from the release's own image on the node, with the service's env, network, limits and node database bridges (the release-phase model), not in a shell on the host.
- Pre-deploy runs in the builder (`beforeRun`) once the image is on the node and before any replica or capacity exists. Post-deploy runs from the image the new container runs.
- The agent pins the image id, execs `argv[0]` as the entrypoint, and adds no port, mount or socket, plus `no-new-privileges`. It labels the container `managed=hook`, which inventory and the creation fence never match, and removes it after a timeout or cancel.
- Pre-stop stays refused on nodes, because it acts on the running instance. Hooks are not replayed on fan-out targets. |
| P3 | **Preview database copies for more engines and for nodes** (REPORT G05). | PostgreSQL and the Redis family only, on the panel host only (`lib/previewDatabases.ts:71-73`). | MySQL, MariaDB and Mongo dumps carry users, so restore the data, then reset to the preview's own credentials and verify that the production credentials fail. Node databases go through the agent. Masking becomes a separate opt-in. | P2 | L | ⬜ |
| P4 | **Compose release fidelity** (REPORT G10). | Recorded restore covers self-contained inline stacks on the original panel host. Includes, env_file, extends, profiles and bind mounts are refused (`lib/composeRelease.ts`). | Show before deploy whether a stack can be recorded. Capture the eligible external inputs, encrypted. Pull images by digest on a clean target. | P2 | L | ⬜ |
| P5 | **Swarm with state** (REPORT G03). | Volumes, managed databases, host ports, fan-out, the restart limit and tunnels are refused. Canary, autoscaling and scale to zero are unavailable. | Owner decision: keep Swarm a stateless deployer (and say so in C1), or define a placement-local or shared-storage contract first. | — | — | ✅ decided 2026-11-09: stateless deployer, stated in C1 |

## 6. T4: Reliability and data

| ID | Item | Evidence | Approach | Pri | Size | Status |
|---|---|---|---|---|---|---|
| O1 | **PITR that survives losing the host,** and PITR on nodes (REPORT G04). | WAL and base backups sit beside the database on the panel host. `lib/pitr.ts` refuses node databases and preview copies. | Ship the WAL archive and base backups encrypted to the backup destination. Measure the recoverable window and lag. Prove recovery to a chosen point on a clean host with the original volumes gone. For nodes, use sealed streaming with bounded retention. | P1 | L | ⬜ |
| O2 | **Managed database HA and upgrades.** | No replica or failover code exists, and `redis-sentinel` and `postgres-wal-g` are catalogue placeholders. There is no major-version upgrade. Railway shipped HA, one-click major Postgres upgrades and automatic CVE patching in 2026. | In this order: (a) a one-click major upgrade by dump and restore into a new container, verified by the R3 restore-verification adapter before the switch, keeping the old one for rollback; (b) a PostgreSQL streaming replica with manual promote, and a Valkey/Redis replica; (c) an opt-in automatic minor-image or CVE update, gated by restore verification. | P1 | L | 🟡 **(a) built for PostgreSQL on the panel host** (`lib/databaseUpgrade.ts`, table `database_upgrades`, `/v1/databases/:id/upgrades`, SDK, `ninedeploy databases upgrade`, Settings card; DATABASES_BACKUPS.md §12): preflight on the running cluster (real major, other databases/roles, disk), dump through a networkless fence, restore into a new volume by the new major, compare row counts, sequences and object counts, switch under the same container name; rollback until finalize; boot recovery. Instead of the R3 adapter (a scratch restore), the copy that becomes the database is compared with the original. Live: 16 → 18 with identical rows, rollback, re-upgrade, finalize. **Next:** MySQL/MariaDB/Mongo, node databases, then (b). |
| O3 | **Panel failure domains** (REPORT G09). | One Node process, one SQLite file, the panel-host Traefik, and Swarm managed from the panel host. WAL is deliberately off (`packages/db/src/client.ts:76-81`). The panel backup is an opt-in snapshot. | Not a full HA rewrite: (a) document and test what keeps serving while the panel is down; (b) offer a continuous off-host copy of the panel database (a frequent encrypted snapshot to S3) and a tested "rebuild the panel on a new host" runbook; (c) decide later on a standby. | P2 | L | ⬜ |
| O4 | **IP allow-list for the panel itself.** | Allow-lists exist only for domains, public database access and CORS; nothing restricts who reaches the panel UI and API. Requested in Coolify [#10332](https://github.com/coollabsio/coolify/discussions/10332). | An operator setting enforced in Fastify `onRequest` and on the panel's Traefik router. Agent, webhook, registry-hook, ingest and status-page routes stay exempt by default. A recovery override through env. | P1 | S | ✅ unreleased: `plugins/panelAccess.ts` onRequest hook judged on the matched route pattern; sign-in routes and sessions restricted, tokens opt-in, machine routes and loopback exempt; lock-out refused on save; `NINEDEPLOY_PANEL_ACCESS=off` (passed through docker-compose.prod.yml); Settings → Security card |
| O5 | **Guided credential rotation.** | `lib/keyRotation.ts` re-encrypts under a new master key. It does not rotate the credentials the panel holds: Git tokens, registry passwords, S3 keys, hook tokens and API tokens. The Railway and Northflank breaches made "rotate everything" a buyer question. | A checklist page lists every stored credential by age and owner. Credentials we issue (hook tokens, API tokens, ingest keys) can be rotated in one step; external ones are linked to their provider. Market it with A5. | P2 | M | ⬜ |
| O6 | **Live cloud acceptance for DigitalOcean and Vultr** (REPORT G13). | Their guides say they were tested against fake APIs. Hetzner was not exercised against a real account either. | Run disposable real-account runs for create, enrol, deploy, a lost response, and delete-only-what-we-own. Needs an owner account. | P2 | M | ⬜ (deferred: accounts arranged later) |

## 7. T5: New modules, after T0–T2

| ID | Item | Who has it / demand | Approach | Pri | Size | Status |
|---|---|---|---|---|---|---|
| X1 | **Application observability:** traces, logs kept across deploys, and source-mapped errors. | Vercel and Railway have tracing. Coolify [#10785](https://github.com/coollabsio/coolify/discussions/10785) asks for logs kept across deploys. Temps has source maps (REPORT G06). Today we export only the panel's own telemetry, and error ingest has no symbolication. | (a) Keep a bounded tail of logs per deployment. (b) Upload source maps per release for error ingest, keeping the raw event if symbolication fails. (c) Traces: ingest OTLP into a bundled backend template linked to deploys and errors, rather than building our own store. | P2 | L | ⬜ |
| X2 | **Deploy by polling git,** for servers that cannot receive webhooks. | Coolify [#12250](https://github.com/coollabsio/coolify/discussions/12250). No poller exists. | A per-service interval of at least 1 minute, using `git ls-remote` against the stored credentials. It reuses the auto-deploy path and its CI gate. | P2 | S | ⬜ |
| X3 | **Wider GitOps coverage, then a Terraform provider** (REPORT G08). | Dokploy asks for declarative apply ([#4008](https://github.com/Dokploy/dokploy/issues/4008), 37) and Pulumi ([#1555](https://github.com/Dokploy/dokploy/issues/1555), 66). Our schema covers projects, a subset of services, domains and grants, and never deletes. | Add databases, build details, storage and secret references (without values). Add an opt-in reviewed delete. Freeze the schema, then generate a Terraform provider from the same API. | P2 | L | ⬜ |
| X4 | **Network isolation per project and environment.** | Dokploy [#4637](https://github.com/Dokploy/dokploy/issues/4637) and [#2798](https://github.com/Dokploy/dokploy/issues/2798). Our Docker services join the shared `ninedeploy` bridge (`engine/dockerNames.ts:33`). Verify Compose and database attachment before designing. | An opt-in per project: one bridge per project, Traefik attached to each, and databases attached only to the networks of the projects that use them. Existing services stay on the shared network until moved. | P2 | M | ⬜ |
| X5 | **Object storage as a managed resource.** | Hosted platforms offer buckets. Here MinIO is only a template and a placeholder plugin (`pluginLoader.ts:405`). | A Garage or SeaweedFS engine with buckets and keys per project, usable as a backup destination. | P2 | M | ⬜ |
| X6 | **Agent sandboxes behind approvals.** | Railway's Cloud Agents and Sandboxes, Fly Sprites, Canine's "agent computers" and Netlify's Agent Runners. We already have remote MCP with OAuth and protected lanes. | Short-lived isolated workspaces where an agent works on a branch. Deploys go through the existing approvals. | P2 | L | ⬜ (approved 2026-11-09) |
| X7 | **Quotas and plans per workspace,** for agencies and resellers (REPORT G16). | The `workspaces` table has no limits. Usage and cost reporting exists (`usageReport.ts:49`). | Owner decision on the target market first. If agencies: CPU/memory/service caps per workspace, then an export for billing. | P2 | M | ⬜ (approved 2026-11-09: agencies) |
| X8 | **The plugin marketplace.** | All 16 catalogue entries are `implemented: false` placeholders (`pluginLoader.ts:563-575`). | Hide placeholders from the UI now (S). A real third-party registry is a later decision. | P1 / P3 | S / L | ✅ narrowed (2026-11-09): the page already labelled placeholders honestly. PITR, Sentry ingest and Tailscale entries now point to the built-ins; the rest say "Not available" instead of "Planned" |

**Not planned:**
- a Kubernetes runtime (a different market: Kubero, Canine, Tsuru);
- Caddy;
- our own analytics, replay or RUM suite (link to Umami, PostHog or GlitchTip instead, REPORT G07);
- integrated mail.

---

## 8. Order of work

Each phase ships as patch releases. R2 continues independently in the other session.

| Phase | Items | Exit evidence |
|---|---|---|
| **1: Truth and debt** | C2, S1, S2, S3, S4, O4, X8 (hide), S8, A7 | Docs agree with code. No orphaned rows after a delete, proven by a test that deletes every entity kind. Export, import and clone round-trip every declared feature. Panel allow-list proven, including its exemptions. |
| **2: Contract and first impressions** | C1, C3, A5, A2, A6, S7 | Capability API drives the UI. The support matrix is generated. Time to HTTPS on a clean host is measured. Stable channel exists. Browser journeys run in CI. |
| **3: Switching and parity** | A1 (step 1, then 2), A3, A4, P1, P2 (maintenance, forward auth) | Import plans for one fixture each from Coolify, Dokploy and CapRover. The simpler UI passes the same journeys. Worker-task diagnostics proven on two daemons. |
| **4: Data** | O1, O2a, O2b, P3, A1 step 3 | Recovery from losing the host to a chosen point. A major upgrade with verified rollback. Preview copies for MySQL and Mongo. |
| **5: Expansion** | X1, X2, X3, X4, O3, O5, P4, S5, S6 | Each item's own acceptance. |
| **Owner tracks** | A8 (with phase 2), X6 and X7 (after phase 3), A9 and O6 (deferred) | See §9. |

## 9. Owner decisions (2026-11-09)

1. **Release channels (A6): approved; details left to us.**
   - Two channels. **current** is today's patch stream and stays the default, so upgrades behave as before. **stable** is opt-in.
   - Stable moves to the newest release that is at least **7 days** old and has no later release that fixes a regression it introduced.
   - Sooner when a release fixes a security issue: stable takes that fix, and the security bullet in the release notes says so.
   - The self-updater and `install.sh --channel stable` follow the chosen channel.
2. **Public launch (A7): approved.**
   - It happens once phase 2's exit evidence exists: screenshots, a measured first-run flow and a generated support matrix.
   - The community files ship in phase 1 regardless.
3. **Template slugs (A8): approved.** Rename `coolify-*` with redirects and credit upstream.
4. **Signing (A9): over time.**
   - No certificates yet.
   - The desktop app stays out of the README headline until signed builds exist.
5. **Swarm's scope (P5): left to us; decided as a stateless deployer.**
   - Stateful workloads belong on Docker nodes, where volumes, managed databases, backups, PITR and tunnels already work.
   - A shared-storage contract would be an XL project with new data-loss modes. The current refusals are safe.
   - C1 states the limit, and the UI offers "run on a node" when a stateful option is refused on Swarm.
   - Revisit only if users ask for it.
6. **Target market (X6, X7): both agencies and AI-agent workflows.**
   - X6 (agent sandboxes) and X7 (workspace quotas and a billing export) move from P3 to **P2**.
   - Both still come after phases 1–3.
7. **Sustainability: sponsorship only.**
   - Add `.github/FUNDING.yml` for GitHub Sponsors in A7.
   - No paid tier, no paid support and no hosted control plane.
8. **Cloud accounts (O6): later.** Arranged when the item comes up.

## 10. Claims to retire or qualify

- "Only we have MCP": Coolify and Easypanel have MCP.
- "No Docker rival scans images": Coolify 4.7.0 does.
- "None of the Docker-based rivals has these" (the GAP_ROADMAP G5 heading).
- "GitOps manages the whole instance": the schema is narrower (X3).
- "Swarm support" stated as multi-node parity (P1, P5).
- "Error ingest replaces Sentry": there are no source maps or traces yet (X1).
- Any "fastest", "most secure" or "largest catalogue" claim without a measurement.
