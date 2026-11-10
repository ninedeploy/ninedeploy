set -euo pipefail
pnpm --dir apps/server exec vitest run \
  test/lib/crossProcessLock.test.ts \
  test/lib/crossProcessLockWrite.test.ts \
  test/lib/crossProcessLockInit.test.ts \
  test/lib/registryLock.test.ts \
  test/lib/registryLockStore.test.ts \
  test/lib/registryCredentialLogout.test.ts \
  test/lib/imageWatch.test.ts \
  test/lib/imageWatchDigest.test.ts \
  test/lib/imageWatchIntegrity.test.ts \
  test/lib/imageRefValidation.test.ts \
  test/lib/imageRefHostValidation.test.ts \
  test/plugins/backupSchedulerPolicyRace.test.ts \
  test/plugins/backupSchedulerShutdown.test.ts \
  test/lib/backupDrillHelperLifecycle.test.ts \
  test/lib/backupDrillHistory.test.ts \
  test/lib/autoscaler.test.ts \
  test/plugins/autoscaler.test.ts \
  test/lib/autoscaleSchedule.test.ts \
  test/modules/databaseImportChunkRace.test.ts \
  test/modules/databaseImportShortWrite.test.ts \
  test/lib/requestRateLargeHistory.test.ts \
  test/lib/requestRateRetention.test.ts \
  test/gitLfs.test.ts \
  test/lib/gitLfsCleanup.test.ts \
  test/lib/gitLfsPointer.test.ts \
  test/lib/gitLfsObjectSizes.test.ts \
  test/lib/gitLfsEmpty.test.ts \
  test/lib/gitCommitStatus.test.ts \
  test/lib/gitCommitStatusResponse.test.ts \
  test/lib/notifierG37.test.ts \
  test/lib/incidentResponse.test.ts \
  test/lib/notifier.test.ts \
  test/lib/notifierResponse.test.ts \
  test/lib/notifierCustomResponse.test.ts \
  test/tenancyIsolation.test.ts \
  test/lib/oauth.test.ts \
  test/lib/oauthIdentity.test.ts \
  test/edgeCasesGitAndOAuth.test.ts \
  test/lib/oauthResponse.test.ts \
  test/plugins/staticFilesLogging.test.ts \
  test/engine/elasticsearchAcknowledgement.test.ts \
  test/engine/elasticsearchEndpoint.test.ts \
  test/engine/cloudWatchAcknowledgement.test.ts \
  --coverage=false --reporter=verbose --maxWorkers=1 \
  2>&1 | tee "$AUDIT_LOG_DIR/unit.log"
