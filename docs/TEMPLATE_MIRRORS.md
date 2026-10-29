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
- it bind-mounts a host path (`/root:…`, the Docker socket), a path outside the stack (`../files/…`, `~/…`) or an interpolated source. Named volumes, `./` paths and the read-only `/etc/localtime` and `/etc/timezone` stay.

On the catalog of 2026-10-27, **383 of 586 blueprints convert**. The largest skip groups were file mounts (91) and more than one routed service (38).

---

## 3. Promoting entries

A converted entry only reaches the bundled registry after it has started in an isolated smoke run:

```bash
node scripts/smoke-template-runtime.mjs --registry=./templates-dokploy.json --ids=dokploy-n8n,dokploy-umami
```

The script runs `compose up` with generated `SERVICE_*` values, probes the routed port and then runs `compose down -v`. `scripts/promote-templates.mjs` then moves the passing entries in.

On 2026-10-29, 30 Dokploy entries were smoke-run and 26 passed. A security review then withdrew six of them, leaving 20 in the Hub. Trilium Next bound the host's `/root`. iHateMoney, Kener and Statping-ng bound `../files` outside the stack, which the converter now refuses. FileGator starts with a publicly known admin login, and ByteStash with open sign-up and debug mode. A started stack is not enough: a promoted entry must also be safe to expose by default. Each withdrawal is recorded as a failure, with its reason, in the evidence file. The evidence is `apps/server/test/fixtures/runtime-verify-2026-10-29-dokploy.json`. Etherpad, Wiki.js and Kutt exited before they were ready, and Cloud Commander listens on 8000 where its blueprint routes 80.

A stack that fails is left out; often its upstream file is to blame. The Dokploy Ghost blueprint is an example: it has no `depends_on` or healthcheck, so Ghost restarts until MySQL is ready, and the smoke run reports "exited before readiness".
