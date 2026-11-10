set -euo pipefail
node scripts/check-workspace-mcp.mjs 2>&1 | tee "$AUDIT_LOG_DIR/mcp-bin.log"
pnpm --dir packages/mcp exec vitest run test/workspaceBin.test.ts --coverage=false --maxWorkers=1 --reporter=verbose 2>&1 | tee "$AUDIT_LOG_DIR/mcp-cold-install.log"
