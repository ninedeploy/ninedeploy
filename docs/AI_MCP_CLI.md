# AI MCP Server, CLI & TypeScript SDK

NineDeploy is API-first. You can manage and automate your infrastructure via the official **Model Context Protocol (MCP)** server, interactive CLI, or typed TypeScript SDK.

---

## 🤖 1. Model Context Protocol (MCP) for AI Assistants

NineDeploy includes an official stdio MCP server for AI agents (Claude Desktop, Cursor, Antigravity, Cline): hand-written tools plus, since 0.15, read-only tools generated from the OpenAPI document (see below).

### Adding to Claude Desktop / Cursor Config:
```json
{
  "mcpServers": {
    "ninedeploy": {
      "command": "npx",
      "args": ["-y", "@ninedeploy/mcp"],
      "env": {
        "NINEDEPLOY_URL": "https://your-ninedeploy-server.com",
        "NINEDEPLOY_TOKEN": "nd_tok_xxxxxxxxxxxx",
        "NINEDEPLOY_MCP_READONLY": "1"
      }
    }
  }
}
```

`NINEDEPLOY_MCP_READONLY=1` is recommended for inspection-only agents. It uses
a fail-closed allowlist that omits mutations and secret-bearing configuration,
container inspection, compose, and file tools. Omit it only when the agent is
explicitly trusted to operate the instance. HTTP API role checks still apply to
every MCP call through the configured token.

### Available MCP Tools (Sample):
- `list_services`, `get_service`, `deploy_service`, `rollback_deploy`, `service_logs`
- `list_databases`, `list_domains`, `list_projects`, `list_workspaces`
- `list_container_files`, `inspect_container`, `get_container_compose`
- `list_plugins`, `install_plugin`, `enable_plugin`, `disable_plugin`
- `system_stats`, `topology`, `health`, `system_autoprune`
- `list_github_installations` (0.13, read-only): registered GitHub Apps and their installations — metadata only, never a key or secret
- `get_database_public_access` (0.14, read-only, `read/databases`, admin on the database): whether the database's public TCP sidecar is configured and running, its host port, IP allow-list, TLS mode and the host clients connect to — never a credential
- `list_database_imports` (0.14, read-only, `read/databases`, admin on the database): the last 50 dump imports with status, source (upload or S3 object), detected format, upload progress, the pre-import safety backup id and any error

Both 0.14 tools take `{ "databaseId": <id> }` and stay available with
`NINEDEPLOY_MCP_READONLY=1`. Turning public access on, uploading a dump and the
proxy and secret-manager settings have no MCP write tools; use the CLI, the SDK
or the panel.

### Tools generated from the OpenAPI document (0.15)

The server describes every route in an OpenAPI 3.1 document (section 4). Routes
whose spec entry opts in become read-only MCP tools, generated into
`packages/mcp/src/generated/specTools.ts` by
`apps/server/scripts/generateMcpSpecTools.ts` (a drift test fails when the
checked-in file differs from a fresh run). Each one is a plain `GET` through
`client.api.get`; the generator refuses non-GET, sensitive and WebSocket routes,
so there is no generated write tool and no "call any endpoint" tool.

| Tool | Route | Who |
|---|---|---|
| `list_environments`, `list_labels` | `GET /v1/environments`, `GET /v1/labels` | any member, coarse token only |
| `get_database`, `get_backup_policy`, `list_backups` | `GET /v1/databases/:id…` | seat on the database (`read/databases`) |
| `list_jobs` | `GET /v1/services/:id/jobs` | seat on the service (`read/services`) |
| `traffic_summary` | `GET /v1/services/:id/traffic` | seat on the service (`read/services`) |
| `list_servers`, `list_volumes`, `list_networks`, `certificate_inventory`, `doctor_report`, `instance_traffic_summary` | operator routes | operator, coarse token only |

All of them stay available with `NINEDEPLOY_MCP_READONLY=1`. `search_api`
(hand-written, coarse token) searches the OpenAPI document by free text and
returns each matching operation's method, path, summary, minimum caller and
API-token scope. It lists operations; it never calls them.

Terminals, access grants and the traffic settings have no MCP tools: opening a
shell, granting access and recreating Traefik stay with the panel, the CLI and
the SDK.

---

## 💻 2. NineDeploy Interactive CLI (`ninedeploy`)

```bash
# Global installation
npm install -g ninedeploy

# 1-Click setup & auto-start local Docker server
ninedeploy init

# Local Docker server management
ninedeploy server start
ninedeploy server status
ninedeploy server stop
ninedeploy server logs

# System health & diagnostics
ninedeploy doctor
ninedeploy system dashboard

# List, create and deploy services
ninedeploy services list
ninedeploy services create
ninedeploy services deploy <service-id>
ninedeploy services logs <service-id>

# Deployment history
ninedeploy deploys list <service-id>
ninedeploy deploys watch <service-id> <deploy-id>     # stream the build log
ninedeploy deploys cancel <service-id> <deploy-id>    # queued or in-flight
ninedeploy deploys rollback <service-id> <deploy-id>  # re-deploy that exact commit/digest
ninedeploy deploys rm <service-id> <deploy-id>        # drop it from history, with its log

# Databases and Templates
ninedeploy databases list
ninedeploy templates list

# Git credentials and GitHub Apps (0.13) — see docs/GITHUB_APP.md
ninedeploy sources add gitea-home --base-url https://git.example.com
ninedeploy github-app list                                  # one-click setup runs in the panel
ninedeploy github-app add-manual --name ghes --app-id 12 --key-file app.pem \
  --web-base-url https://github.example.com --api-base-url https://github.example.com/api/v3
ninedeploy github-app sync <app-id>
ninedeploy services github <service-id> --migrate <gh-app-source-id>
ninedeploy services github <service-id> --status on --pr-comment on
ninedeploy services github <service-id> --finalize          # or --unlink to revert

# Secrets
ninedeploy system rotate-keys      # re-encrypt onto the newest master-key version

# Public database access (0.14, operator) — exposes the ROOT credentials; create a limited user
ninedeploy databases public-access <db-id>                       # show status, port, allow-list, endpoint
ninedeploy databases public-access <db-id> --enable --port 15432 --allow 203.0.113.0/24 198.51.100.7
ninedeploy databases public-access <db-id> --enable --allow 203.0.113.0/24   # unset flags keep their value
ninedeploy databases public-access <db-id> --enable --tls terminate --tls-host db.example.com  # not mysql/mariadb
ninedeploy databases public-access <db-id> --disable

# Dump import (0.14) — chunked, resumable upload; a pre-import backup is taken first
ninedeploy databases import <db-id> --file dump.sql.gz                       # waits for the result
ninedeploy databases import <db-id> --file app.dump --clean --no-single-transaction
ninedeploy databases import <db-id> --file dump.rdb --confirm-replace        # redis/valkey replace everything
ninedeploy databases import <db-id> --file dump.sql.gz --resume <import-id>  # continue an interrupted upload
ninedeploy databases import <db-id> --from-s3 <destination-id> --key backups/app.dump   # operator
ninedeploy databases imports <db-id> [--watch]
#   other flags: --drop (mongo), --no-safety-backup (operator, or a database created < 10 min ago), --no-wait

# Traefik custom dynamic config and uploaded certificates (0.14, operator)
ninedeploy proxy config get
ninedeploy proxy config validate --file custom.yml
ninedeploy proxy config set --file custom.yml        # prints the refusal's errors/warnings and exits 1
ninedeploy proxy config clear [-y]
ninedeploy certificates custom list
ninedeploy certificates custom upload --name wildcard --cert chain.pem --key key.pem
ninedeploy certificates custom replace <cert-id> --cert chain.pem --key key.pem [--name <n>]
ninedeploy certificates custom delete <cert-id> [-y]

# Secret managers (0.14, operator): ${{vault:path#field}}, ${{aws:secret-id}}, ${{aws:secret-id#jsonKey}}
ninedeploy secrets providers list
NINEDEPLOY_VAULT_TOKEN=… ninedeploy secrets providers set-vault --address https://vault.example.com --auth token
ninedeploy secrets providers set-vault --address https://vault.example.com --auth approle \
  --role-id-file role-id --secret-id-file secret-id [--namespace team-a] [--mount secret] [--approle-mount approle]
NINEDEPLOY_AWS_SECRET_ACCESS_KEY=… ninedeploy secrets providers set-aws --region eu-west-1 \
  --access-key-id AKIA… [--role-arn arn:aws:iam::123456789012:role/nd] [--external-id x] [--endpoint https://…]
ninedeploy secrets providers test vault --probe-path app/prod
ninedeploy secrets providers test aws --probe-secret-id prod/db
ninedeploy secrets providers delete aws [-y]
```

Secrets never travel on the command line: the Vault token, role id and secret
id, and the AWS secret access key and session token, are read from
`--*-file` paths or the `NINEDEPLOY_VAULT_TOKEN`, `NINEDEPLOY_VAULT_ROLE_ID`,
`NINEDEPLOY_VAULT_SECRET_ID`, `NINEDEPLOY_AWS_ACCESS_KEY_ID`,
`NINEDEPLOY_AWS_SECRET_ACCESS_KEY` and `NINEDEPLOY_AWS_SESSION_TOKEN`
environment variables. On an update, omitted credentials keep the stored
values. `databases import` uploads in 8 MiB chunks because Traefik's 60-second
read timeout would cut off a single multi-GB request; it prints the import id
first, so an interrupted upload continues with `--resume <import-id>`.

```bash
# Terminals (0.15, operator): history, termination and interactive shells
ninedeploy terminals list [--status active] [--target host] [--limit 50] [--before <id>]
ninedeploy terminals show <session-id>
ninedeploy terminals kill <session-id> [-y]
ninedeploy terminal service <service-id> [--replica 2] [--node <server-id>]
ninedeploy terminal db <database-id> [--client]      # --client: psql / mysql / redis-cli with the stored credentials
ninedeploy terminal container <container-name>
ninedeploy terminal host [server-id]                 # off by default; prompts for your password

# Traffic analytics (0.15, opt-in)
ninedeploy traffic settings                          # show
ninedeploy traffic settings --enable [-y]            # recreates Traefik once (about 1–2 s of refused connections)
ninedeploy traffic settings --disable [-y] [--retention 30]
ninedeploy traffic summary [--range 1h|24h|7d|30d] [--top 10]   # operator
ninedeploy traffic service <service-id> [--range 7d]

# Project and environment access grants (0.15, raise-only)
ninedeploy access grants list --workspace <id> [--user <id>] [--project <id>] [--environment <id>]
ninedeploy access grants add --workspace <id> --email dev@example.com --project <id> [--environment <id>] --role member
ninedeploy access grants update <grant-id> --workspace <id> --role viewer
ninedeploy access grants remove <grant-id> --workspace <id> [-y]
ninedeploy access me
```

`ninedeploy terminal` (alias `shell`) needs a TTY: it puts the local terminal
in raw mode, forwards window resizes, and exits with the shell's exit code (1
when the session ends any other way, with the reason printed: idle timeout,
maximum length, terminated by an operator, too many terminals). A host shell
asks for your password with a hidden prompt for every session; it is never read
from the command line. Accounts that sign in only through SSO leave it empty
within 10 minutes of `ninedeploy login`. API tokens cannot open host shells.

`deploys rm` refuses an in-flight deployment (cancel it first) and the one
currently serving traffic — that row carries the image digest a rollback
re-deploys. Finished deployments age out on their own after 30 days, together
with their build logs.

---

## 📦 3. TypeScript SDK (`@ninedeploy/sdk`)

```typescript
import { createClient } from '@ninedeploy/sdk';

const client = createClient({
  baseUrl: 'https://your-ninedeploy-instance.com',
  // The client takes a token PROVIDER, not a static `token` option.
  getToken: () => 'nd_tok_xxxxxxxxxxxx',
});

// List all services in a workspace
const services = await client.services.list();
console.log(`Found ${services.length} active services`);

// Trigger deployment
const deploy = await client.deploys.trigger(serviceId);
console.log(`Deployment ${deploy.deploymentId} started`);

// 0.13: GitHub Apps and a service's App link
const apps = await client.githubApps.list();
await client.githubApps.syncInstallations(apps[0].id);
await client.services.github.link(serviceId, { sourceId: 7, repoId: 123456 });
await client.services.github.feedback(serviceId, { reportStatus: true });

// 0.14: public database access (operator), dump import, proxy and secret managers
await client.databases.publicAccess.set(dbId, {
  enabled: true, port: 15432, ipAllowlist: ['203.0.113.0/24'], tlsMode: 'none',
});
const { publicConnectionString } = await client.databases.credentials(dbId);

// Chunked, resumable upload at the server's chunkSize (8 MiB), then start and poll.
// `data` is a Uint8Array, an AsyncIterable<Uint8Array>, or a factory
// `(offset) => AsyncIterable<Uint8Array>` that seeks for resume.
const done = await client.databases.importFile(dbId, (offset) => createReadStream('dump.sql.gz', { start: offset }), {
  sizeBytes: (await stat('dump.sql.gz')).size,
  filename: 'dump.sql.gz',
  options: { singleTransaction: true },
  onCreated: (row) => console.log(`import ${row.id}`),    // keep the id: { resumeImportId } continues it
  onProgress: ({ receivedBytes, sizeBytes }) => console.log(`${receivedBytes}/${sizeBytes}`),
  poll: true,
});

// S3 source (operator): the server downloads in the background, then you start it.
const objects = await client.backupDestinations.objects(destId);
const s3 = await client.databases.imports.create(dbId, { source: 's3', destinationId: destId, key: objects[0].key });
await client.databases.imports.wait(dbId, s3.id, { until: 'uploaded' });
await client.databases.imports.start(dbId, s3.id);

await client.traefik.customConfig.validate(yaml);   // { ok, errors, warnings }
await client.traefik.customConfig.set(yaml);        // a refusal's NineDeployError.details = { errors, warnings }
await client.traefik.customCertificates.upload({ name: 'wildcard', certPem, keyPem });
await client.settings.secretProviders.set('vault', {
  config: { address: 'https://vault.example.com', authMethod: 'token' },
  credentials: { token },                            // write-only; omit to keep the stored value
});
await client.settings.secretProviders.test('vault', { probePath: 'app/prod' });

// 0.15: terminals (operator). Create a session, then attach with its
// single-use ticket (valid 30 s) over protocol v1. Input written before the
// server's `ready` is held and flushed on `ready`.
const created = await client.terminals.create({ target: { kind: 'database', databaseId: dbId, mode: 'client' }, cols: 120, rows: 32 });
const shell = client.terminals.connect(created, {
  onData: (bytes) => process.stdout.write(bytes),
  onExit: ({ code }) => console.log(`exit ${code}`),
  onClose: ({ code, message }) => console.log(code, message),   // 4408 idle, 4409 max length, 4410 terminated, 4429 too many
}, { socketFactory: (url, protocols) => new WebSocket(url, protocols) });  // e.g. the `ws` package in Node
shell.write('\\dt\r');
shell.resize(160, 40);
// Or build the socket yourself: { url, protocols } = client.terminals.attachInfo(created)
// protocols = ['ninedeploy.terminal.v1', 'ninedeploy.ticket.<ticket>']
const { items, nextBefore } = await client.terminals.list({ status: 'active' });
await client.terminals.terminate(items[0].id);
await client.terminals.settings.set({ hostTerminalEnabled: true, password });   // step-up

// 0.15: traffic analytics (opt-in; settings and summary are operator only)
await client.traffic.settings.set({ enabled: true });   // recreates Traefik; on a network error, read settings.get() again
const summary = await client.traffic.summary({ range: '24h', top: 10 });
const svcTraffic = await client.traffic.service(serviceId, { range: '7d' });

// 0.15: access grants (workspace admin) and the caller's own access
await client.accessGrants.create(workspaceId, { email: 'dev@example.com', projectId, role: 'member' });
const grants = await client.accessGrants.list(workspaceId, { projectId });
await client.accessGrants.update(workspaceId, grants[0].id, { role: 'admin' });
await client.accessGrants.delete(workspaceId, grants[0].id);
const who = await client.access.project(projectId);   // [{ user, role, via: ['seat' | 'grant' | 'operator' | 'creator'] }]
const mine = await client.access.me();                // { grants, guestWorkspaces }

// 0.15: read-only access to any documented route
const spec = await client.api.get('/v1/openapi.json');
const backups = await client.api.get('/v1/databases/3/backups', { limit: 5 });
```

`GET /v1/servers` now carries `terminal: { host, container, reason? }` per node
(absent on older panels): a node needs agent v0.15.0 for terminals.

---

## 📜 4. OpenAPI 3.1 document (0.15)

`GET /v1/openapi.json` describes every HTTP route: its path, parameters,
request and response schemas, the minimum caller (`x-ninedeploy-floor`) and the
API-token scope it needs. It is served only behind login (a session, or a
coarse or unrestricted API token; fine-grained tokens are refused), with an
`ETag` so an unchanged document answers `304`. Add `?download=1` for a file
download.

```bash
curl -H "Authorization: Bearer $NINEDEPLOY_TOKEN" https://panel.example.com/v1/openapi.json?download=1 -o ninedeploy-openapi.json
```

Use it to generate clients in other languages, or to browse the API in any
OpenAPI viewer you run yourself. The panel does not bundle Swagger UI.
