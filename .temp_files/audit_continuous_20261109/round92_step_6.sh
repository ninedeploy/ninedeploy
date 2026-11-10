set -euo pipefail
pnpm --filter '@ninedeploy/server...' build 2>&1 | tee "$AUDIT_LOG_DIR/build.log"
pnpm --dir apps/server typecheck 2>&1 | tee "$AUDIT_LOG_DIR/typecheck.log"
