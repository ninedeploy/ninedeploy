import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runOp } from '../apps/server/dist/agent.js';
import { parseNodeContainerStats } from '../apps/server/dist/lib/nodeMetrics.js';

// Uses the current built agent and real Docker. The workload needs only Node;
// reuse a local NineDeploy image with --image=... to avoid a network pull.
const image = process.argv.find((a) => a.startsWith('--image='))?.slice(8) ?? 'node:26-alpine';
const name = `nd-node-smoke-${randomUUID()}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const op = async (operation, params) => {
  const lines = [];
  const code = await runOp(operation, params, (line) => lines.push(line), { sealed: true });
  assert.equal(code, 0, `${operation}: ${lines.join('\n')}`);
  return lines;
};
const probe = async (protocol) => {
  const lines = await op('docker.probe', { name, port: 3000, protocol, path: '/ready' });
  const line = lines.find((s) => s.startsWith('ND-PROBE '));
  assert.ok(line, 'node returned no probe verdict');
  return JSON.parse(line.slice(9));
};

try {
  docker('run', '-d', '--name', name, '--entrypoint', 'node', image, '-e',
    `const fs=require('node:fs'); require('node:http').createServer((req,res)=>{res.statusCode=fs.existsSync('/tmp/nd-ready')?200:503;res.end('readiness');}).listen(3000,'0.0.0.0',()=>console.log('node-operations-smoke listening'));`);
  let listening = false;
  for (let attempt = 0; attempt < 5 && !listening; attempt++) listening = (await probe('tcp')).ready;
  assert.ok(listening, 'workload never listened');
  assert.deepEqual(await probe('http'), { ready: false, protocol: 'http', status: 503 });
  docker('exec', name, 'node', '-e', `require('node:fs').writeFileSync('/tmp/nd-ready','ready')`);
  assert.deepEqual(await probe('http'), { ready: true, protocol: 'http', status: 200 });
  assert.equal(docker('inspect', name, '--format', '{{json .HostConfig.PortBindings}}'), '{}', 'a readiness probe must not publish a host port');
  // agent.stats is a Linux node operation (df is not available on Windows).
  // On Windows run the current compiled agent in the Linux runtime image,
  // against this same Docker daemon, rather than mistaking host telemetry for node telemetry.
  const statsLines = process.platform === 'win32'
    ? docker('run', '--rm', '--name', `${name}-agent`, '--user', '0:0', '--entrypoint', 'node',
      '-e', 'NODE_ENV=development', '-v', '/var/run/docker.sock:/var/run/docker.sock',
      ...['apps/server', 'packages/schemas', 'packages/sdk', 'packages/db'].flatMap((p) => ['--mount', `type=bind,source=${resolve(p, 'dist')},target=/app/${p}/dist,readonly`]),
      image, '--input-type=module', '-e', `const {runOp}=await import('./apps/server/dist/agent.js');process.exitCode=await runOp('agent.stats',{},console.log);`).split('\n')
    : await op('agent.stats', {});
  const stats = parseNodeContainerStats(statsLines);
  assert.ok(stats.has(name), 'node telemetry omitted the real workload');
  const logs = await op('docker.logsSince', { name, since: '1970-01-01T00:00:00.000Z' });
  assert.ok(logs.some((line) => line.includes('node-operations-smoke listening')), 'node log tail omitted workload output');
  assert.equal(docker('ps', '-aq', '--filter', `label=ninedeploy.probe.target=${name}`), '', 'probe helpers leaked');
  console.log('PASS: TCP reachable while HTTP 503 remains unready; HTTP 200 becomes ready; no published port; real node stats and timestamped logs; helpers removed.');
} finally {
  try { docker('rm', '-f', `${name}-agent`); } catch { /* --rm normally removed it */ }
  try { docker('rm', '-f', name); } catch { /* only this smoke owns this name */ }
}
