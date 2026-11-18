import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Direct Vitest invocation: these guards must run even when a previous full
// suite is cached. Builds run first so workspace packages resolve current code.
const tests = [
  'test/releaseNotes.test.ts',
  'test/release-workflows.test.ts',
  'test/contractPreflight.test.ts',
  'test/docsIndex.test.ts',
  'test/auditCoverage.test.ts',
  'test/serviceCapabilities.test.ts',
  'test/nodeFeatureRefusals.test.ts',
  'test/proxySettingApplication.test.ts',
  'test/maintenance.test.ts',
  'test/engine/pitrCheckpoint.test.ts',
  'test/lib/pitrRemote.test.ts',
  'test/lib/pitrContinuous.test.ts',
  'test/lib/pitrOrphans.test.ts',
  'test/lib/nodePitr.test.ts',
  'test/agentOpsPitr.test.ts',
  'test/envExample.test.ts',
  'test/smokeInventory.test.ts',
  'test/ownedSettings.test.ts',
  'test/ownedSettingSchemas.test.ts',
  'test/importCycles.test.ts',
  'test/swarmRuntime.test.ts',
  'test/openapi/openapiDocument.test.ts',
  'test/turboCache.test.ts',
];

console.log(`Checking ${tests.length} contract suites before full coverage`);
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
  'run', ...tests, '--no-coverage', '--maxWorkers=1',
], {
  cwd: fileURLToPath(new URL('../apps/server/', import.meta.url)),
  stdio: 'inherit', windowsHide: true, timeout: 5 * 60_000,
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
