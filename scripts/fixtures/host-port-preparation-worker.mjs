import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(process.env.DOCKER_HOST, 'unix://' + config.socket);
assert.ok(config.directory.startsWith(config.root + '/.temp_files/host-port-preparation/'));
process.env.NINEDEPLOY_DATA_DIR = join(config.directory, 'data');
process.env.NINEDEPLOY_DB_PATH = join(config.directory, 'data', 'panel.db');
process.env.NINEDEPLOY_JWT_SECRET = randomBytes(32).toString('hex');
const { dockerBuilder } = await import('../../apps/server/src/engine/builders/docker.ts');
const logs = [];
const context = {
  deploymentId: 5,
  service: {
    id: 1, slug: config.slug, name: 'Preparation proof', type: 'docker', status: 'running', image: config.image,
    port: 3000, healthPath: '/', healthCheck: 'http-strict', volumeMount: '/data', cpuShares: 0, cpuLimitMilli: 0,
    memLimitMb: 0, replicas: 1, runtimeId: config.old, publishedPort: config.port,
    dockerSocket: false, cmd: ['node', '/fixture.mjs', 'server', 'new'], runtimeOptions: null,
    portMappings: [{ hostPort: config.udp, containerPort: 5060, protocol: 'udp' }, { hostPort: config.udp + 10, hostPortEnd: config.udp + 12, containerPort: 10000, protocol: 'udp' }],
  },
  workDir: config.directory, commitSha: '', env: config.multiline ? { CERT: 'line1\nline2' } : { RELEASE: 'new' },
  fileMounts: [{ hostPath: join(config.root, 'scripts', 'fixtures', 'persistent-port-runtime.mjs'), containerPath: '/fixture.mjs' }],
  log: line => logs.push(line),
};
const previous = { runtimeId: config.old, port: 3000, healthPath: '/' };
try {
  if (config.failCreate) await assert.rejects(() => dockerBuilder.buildAndRun(context, previous), /Injected candidate create acknowledgement failure/);
  else {
    const runtime = await dockerBuilder.buildAndRun(context, previous);
    assert.equal(await dockerBuilder.isHealthy(runtime, 30000, 250, line => logs.push(line)), true);
  }
  writeFileSync(join(config.directory, 'worker-result.json'), JSON.stringify({ passed: true, failCreate: config.failCreate, multiline: config.multiline }));
} finally { writeFileSync(join(config.directory, 'build.log'), logs.join('\n')); }
