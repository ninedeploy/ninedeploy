set -euo pipefail
pnpm --dir apps/server exec vitest run \
  --config vitest.integration.config.ts \
  test/integration/registryCredentialStore.test.ts \
  test/integration/registryCredentialLogout.test.ts \
  test/integration/registryImageReference.test.ts \
  test/integration/backupDrillHelperLifecycle.test.ts \
  --coverage=false --reporter=verbose --maxWorkers=1 \
  2>&1 | tee "$AUDIT_LOG_DIR/native-cli.log"
