# @ninedeploy/mcp

The official **Model Context Protocol (MCP)** server for [NineDeploy](https://github.com/ninedeploy/ninedeploy) — give your AI assistant (Claude Desktop, Cursor, Cline, …) typed, scoped access to your panel.

## Setup

```json
{
  "mcpServers": {
    "ninedeploy": {
      "command": "npx",
      "args": ["-y", "@ninedeploy/mcp"],
      "env": {
        "NINEDEPLOY_URL": "https://your-ninedeploy-server.com",
        "NINEDEPLOY_TOKEN": "nd_tok_xxxxxxxxxxxx"
      }
    }
  }
}
```

## Environment variables

| Variable | Meaning |
| --- | --- |
| `NINEDEPLOY_URL` | Base URL of the panel (`https://…`). |
| `NINEDEPLOY_TOKEN` | An API token from the panel (Settings → API tokens). |
| `NINEDEPLOY_MCP_READONLY` | Set to `1` to expose only the read-only tool subset (no deploys, no mutations). |

## Least privilege

The MCP server enforces the panel's own scope model: each tool declares the API-token scopes it needs, and a tool that outruns the token's scopes is hidden from the model. Recommendations:

- **Read-only usage** — set `NINEDEPLOY_MCP_READONLY=1` and mint a token with read scopes only.
- **Deploys** — add the deploy write scopes; no `operator` scope needed for your own services.
- **Instance administration** (users, plugins, config center, pruning) — requires an operator token. Treat that as giving the agent operator power: it can read instance-wide inventories, and container inspection reveals container environment variables. **Secret values in the Config Center always come back masked over MCP** — the panel UI is the only reveal surface.

Requires Node **>= 22.13**. Full tool catalogue and CLI/SDK docs: [`docs/AI_MCP_CLI.md`](https://github.com/ninedeploy/ninedeploy/blob/main/docs/AI_MCP_CLI.md).
