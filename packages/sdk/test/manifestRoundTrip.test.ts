import { describe, expect, it } from 'vitest';
import { formatManifestYaml, parseManifestYaml } from '../src/manifest.js';

function expectRoundTrip(blocks: Record<string, unknown>) {
  const original = parseManifestYaml(JSON.stringify({ version: '1', ...blocks }));
  expect(parseManifestYaml(formatManifestYaml(original))).toEqual(original);
}

describe('manifest serialization regressions', () => {
  it.each([
    {}, { cpuShares: 0 }, { cpuLimitMilli: 0 }, { memMb: 0 }, { replicas: 1 },
    { cpuLimitMilli: 500, replicas: 3 }, { cpuLimitMilli: 512000, replicas: 10 },
    { cpuShares: 1024, cpuLimitMilli: 500, memMb: 512, replicas: 3 },
  ])('preserves resource settings %j through YAML', (resources) => {
    expectRoundTrip({ resources });
  });

  it.each([
    { build: {} }, { run: {} }, { env: { required: [] } }, { env: { aliases: {} } },
    { phases: {} }, { phases: { setup: {}, build: {} } }, { resources: {} }, { hooks: {} },
    { watch: { paths: [] } }, { routes: [] }, { alerts: [] }, { volume: {} },
    { network: { aliases: [] } }, { notifications: {} },
    { routes: [{ host: 'app.example.com', headers: {}, ipAllowlist: [] }] },
  ])('preserves empty collections %j instead of emitting null', (blocks) => {
    expectRoundTrip(blocks);
  });

  it.each([
    { build: { install: 'npm ci' } }, { build: { build: 'npm run build' } },
    { build: { start: 'npm start' } }, { build: { baseDir: 'app' } },
    { build: { dockerfile: 'Dockerfile' } }, { run: { port: 1 } },
    { run: { healthcheck: '/' } }, { run: { restart: 'no' } },
    { hooks: { preBuild: 'echo a' } }, { hooks: { postBuild: 'echo b' } },
    { hooks: { preStop: 'echo c' } }, { env: { required: ['APP'], aliases: {} } },
    { phases: { build: { cmds: ['echo a'] } } },
    { volume: { backups: { schedule: '0 3 * * *' } } },
    { network: { aliases: ['internal'] } }, { notifications: { onDeploy: ['ops'] } },
    { notifications: { onFailure: ['ops'] } }, { notifications: { onAlert: ['ops'] } },
  ])('preserves a block with one populated field %j', (blocks) => {
    expectRoundTrip(blocks);
  });

  it.each(['true', '123', 'foo: bar', 'foo # bar', 'line\nbreak', 'openssl'])(
    'preserves setup package %j as a string',
    (item) => {
      expectRoundTrip({ phases: { setup: { pkgs: [item] } } });
    },
  );
});
