set -euo pipefail
pnpm install --frozen-lockfile 2>&1 | tee "$AUDIT_LOG_DIR/install.log"
