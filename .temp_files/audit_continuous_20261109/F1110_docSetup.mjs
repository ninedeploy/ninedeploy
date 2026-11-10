import fs from 'node:fs';const file='docs/MACOS_DEVELOPMENT.md';let text=fs.readFileSync(file,'utf8').replaceAll('\r\n','\n');const marker='## Open the same source revision\n';if(!text.includes(marker))throw Error('Mac guide anchor missing');const section=`### Fresh workspace MCP executable

The MCP package now exposes a tracked \`bin/ninedeploy-mcp.mjs\` launcher so
pnpm can create its command link during a fresh install, before TypeScript has
created \`dist/index.js\`. Build is still required before starting the server.
The Mac setup helper verifies the workspace command after its root build.

\`\`\`sh
node scripts/check-workspace-mcp.mjs
\`\`\`

This read-only smoke removes the API token from child environments. The child
entrypoints deliberately refuse startup with the required-token message; those
exit-1 refusals mean the launcher resolved, and the checker itself exits zero.
No panel or credential is contacted. Cold/prebuilt/offline-reinstall fixtures,
MCP's full 52-test coverage gate and actual npm-layout packing passed locally.
The package was packed for inspection, not published.

Fresh MCP native Mac follow-up: pending the new workflow run.

`;text=text.replace(marker,section+marker);fs.writeFileSync(file,text);
