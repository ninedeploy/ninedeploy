# AI MCP Server, CLI & TypeScript SDK

NineDeploy is API-first. You can manage and automate your infrastructure via the official **Model Context Protocol (MCP)** server, interactive CLI, or typed TypeScript SDK.

---

## 🤖 1. Model Context Protocol (MCP) for AI Assistants

NineDeploy includes an official stdio MCP server exposing **38 dedicated tools** to AI agents (Claude Desktop, Cursor, Antigravity, Cline).

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
```
