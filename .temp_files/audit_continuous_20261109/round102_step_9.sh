set -euo pipefail
if ! command -v docker >/dev/null 2>&1; then brew install docker; fi
docker --version | tee "$AUDIT_LOG_DIR/docker-cli.log"
