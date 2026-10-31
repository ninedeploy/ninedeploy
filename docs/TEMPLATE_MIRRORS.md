# Template mirrors: Coolify and Dokploy

NineDeploy can convert two community template catalogs into its own compose-stack format:

- the Coolify compose templates (`coollabsio/coolify`, `templates/compose`);
- the Dokploy blueprints (`Dokploy/templates`, `blueprints/`, MIT, added in G4.7).

Each converter writes a bundle that the Hub can load as a remote source (Settings → `templates_source`), or that a maintainer can promote into the bundled registry after a smoke run.

The tools never download anything themselves. You clone the catalog first.

---

## 1. Building a bundle

```bash
# Coolify
git clone --depth 1 --filter=blob:none --sparse https://github.com/coollabsio/coolify /tmp/coolify
git -C /tmp/coolify sparse-checkout set templates/compose
pnpm --filter @ninedeploy/server exec tsx scripts/buildTemplateMirror.ts \
  --src /tmp/coolify/templates/compose --out ./templates-coolify.json

# Dokploy
git clone --depth 1 https://github.com/Dokploy/templates /tmp/dokploy-templates
pnpm --filter @ninedeploy/server exec tsx scripts/buildDokployMirror.ts \
  --src /tmp/dokploy-templates/blueprints --out ./templates-dokploy.json
```

- **Output:** each script prints how many entries it converted and why it skipped the rest.
- **Validation:** the bundle is checked by the production registry parser before it is written.
- **Not verified yet:** every entry carries `requires: "… · not runtime-verified"` until it has been smoke-run.

---

## 2. How a Dokploy blueprint is converted

A blueprint keeps its settings outside the compose file:

- `[variables]` hold generators;
- `[config.env]` is written to the stack's `.env`;
- `[[config.domains]]` routes a service;
- `[[config.mounts]]` writes files.

The converter folds the env into the compose file. It substitutes inside the parsed string values, as Docker Compose does, so a value containing `: ` or `#` cannot change the file's structure. Each generator becomes the `SERVICE_*` token that makes the same kind of value at deploy time. The value is kept across redeploys.

| Dokploy | NineDeploy |
| :--- | :--- |
| `${domain}` | `${SERVICE_FQDN_<routed service>}` |
| `${password}` / `${password:N}` | `${SERVICE_PASSWORD_<N>_<VAR>}`: N alphanumerics (16 by default) |
| `${base64}` / `${base64:32\|64\|128}` | `${SERVICE_REALBASE64_<N>_<VAR>}`: base64 of N random bytes |
| `${hash:32\|64\|128}` | `${SERVICE_HEX_<N>_<VAR>}`: N hex characters |
| `${username}` | `${SERVICE_LOWERCASEUSER_<VAR>}` |
| `${email}` | `${SERVICE_LOWERCASEUSER_<VAR>}@example.com` |

Rules that match Dokploy's own behaviour:

- **Variables:** one variable is one token, so a database and its app get the same password.
- **Precedence:** a generator name wins over a variable of the same name, as in Dokploy.
- **Env references:** an env value may refer to another env key, with or without a `:-default`, as Compose interpolates a `.env` file.

A blueprint is **skipped with its reason** whenever there is no faithful equivalent:

- it uses file mounts;
- it routes more than one service, port or sub-path;
- it routes no service;
- it uses `${uuid}`, `${jwt}`, timestamps or `${randomPort}`;
- it asks for a base64 or hash length other than 32, 64 or 128;
- it uses a variable only Dokploy provides (`DOKPLOY_*`);
- its compose file has a shape the Coolify mirror also refuses: host ports, host networking, build contexts or `env_file`;
- it reaches the host. That means it bind-mounts a host path (`/root:…`, the Docker socket), a path that leaves the stack anywhere in it (`../files/…`, `./a/../../x`, `~/…`) or an interpolated source; declares a volume with `driver_opts`, another driver or `external`; declares top-level `secrets` or `configs`, a volume or network with a fixed `name`, or an external network or one with another driver; or gives a service a key outside the safe list (image, command, environment, volumes, depends_on, healthcheck, …). That list leaves out `build`, `env_file` (and `pull_policy: build`), `privileged`, `pid`, `ipc`, `devices`, `cap_add`, `security_opt`, `volumes_from`, `userns_mode`, `sysctls`, `runtime` and every other key that can loosen isolation. Named volumes, `./` paths and the read-only `/etc/localtime` and `/etc/timezone` stay. The check runs on the blueprint and again on the converted file.

On the catalog of 2026-10-27, **383 of 586 blueprints converted**. With the host-access rules of 2026-10-29, 322 convert. The largest skip groups were file mounts (91) and more than one routed service (38).

---

## 3. Promoting entries

A converted entry only reaches the bundled registry after it has started in an isolated smoke run:

```bash
node scripts/smoke-template-runtime.mjs --registry=./templates-dokploy.json --ids=dokploy-n8n,dokploy-umami
```

The script runs `compose up` with generated `SERVICE_*` values, probes the routed port and then runs `compose down -v`. `scripts/promote-templates.mjs` then moves the passing entries in.

On 2026-10-29, 30 Dokploy entries were smoke-run and 26 passed. A security review then withdrew six of them, leaving 20 in the Hub. Trilium Next bound the host's `/root`. iHateMoney, Kener and Statping-ng bound `../files` outside the stack, which the converter now refuses. FileGator starts with a publicly known admin login, and ByteStash with open sign-up and debug mode. A started stack is not enough: a promoted entry must also be safe to expose by default. The same review was then applied to the first batch, and 18 more were withdrawn. Only AList and Healthchecks stayed; each reason is in the evidence file. A second batch of 30 left one, Dagu, after the same review; `runtime-verify-2026-10-29-dokploy-2.json` records why each other one stayed out. Reasons include mutable `latest` tags, open registration, auth switched off, a first visitor becoming admin of an app that runs code, fixed passwords, and the converter's host-access rules. Each withdrawal is recorded as a failure, with its reason, in the evidence file. The evidence is `apps/server/test/fixtures/runtime-verify-2026-10-29-dokploy.json`. Etherpad, Wiki.js and Kutt exited before they were ready, and Cloud Commander listens on 8000 where its blueprint routes 80.

A third round, on 2026-10-31, filtered before running anything. Of the 324 blueprints that convert, those already tried, those with an image not pinned to a version, a literal credential, or open registration or auth switched off in their environment were set aside, leaving 138. A reading of each one's first-run behaviour left 11: each sets its admin login or API key from a generated value. Rejections at this stage included known default logins (Umami, Grafana, BookStack, Wallabag, Zabbix), a first visitor becoming admin (n8n, Strapi, Immich, Forgejo, Docmost), open sign-up (Linkwarden, GlitchTip, GitLab), phpMyAdmin's auto-login, Keycloak in `start-dev` and Directus's `postgis:13-master` image. All 11 started in the smoke run. Each was then started again and asked, without credentials, for its admin pages, APIs, install and sign-up pages; every answer had to be a login, a 401 or 403, a locked installer or a missing page. Ten passed and are in the Hub: 9Router, Dolibarr, Graylog, Kimai, Meilisearch, Miniflux, OpenObserve, Ponos, PrivatePaste and Typesense. YOURLS stayed out: its install page answers without a login and the stack does nothing until someone runs it, and its MySQL 5.7 is end-of-life. The evidence is `runtime-verify-2026-10-31-dokploy-3.json`.

A stack that fails is left out; often its upstream file is to blame. The Dokploy Ghost blueprint is an example: it has no `depends_on` or healthcheck, so Ghost restarts until MySQL is ready, and the smoke run reports "exited before readiness".

**The bar for promotion:** the stack starts in the smoke run, every image is pinned to a version (no `latest`, no `pull_policy: always`), and nothing is open by default. That rules out a known default login, open registration, auth switched off, a first visitor becoming admin, and a form that reaches arbitrary hosts. A blueprint that needs a manual first step to be safe stays in the remote bundle (Settings → `templates_source`), not the bundled Hub.
