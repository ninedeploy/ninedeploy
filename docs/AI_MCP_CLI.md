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
```

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
```
