import { execFile, spawnSync } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { primaryNetworkProxyClient } from '../../../scripts/lib/primary-network-proxy-client.mjs';

const script = fileURLToPath(new URL('../../../scripts/smoke-primary-network-readiness.mjs', import.meta.url));
it('sends the router Host header with the actual Node runtime', async () => {
  const hosts: string[] = [];
  const server = http.createServer((request, response) => {
    hosts.push(request.headers.host ?? '');
    response.writeHead(request.headers.host === 'readiness.invalid' ? 200 : 404).end('fixture');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', primaryNetworkProxyClient('127.0.0.1', 3, port)], { timeout: 5000, windowsHide: true });
    expect(JSON.parse(result.stdout)).toEqual([200, 200, 200]);
    expect(hosts).toEqual(['readiness.invalid', 'readiness.invalid', 'readiness.invalid']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
it.each([
  { env: { GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'github-hosted', DOCKER_HOST: 'unix:///var/run/docker.sock' }, message: 'Use an isolated GitHub Actions runner' },
  { env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted', DOCKER_HOST: 'unix:///var/run/docker.sock' }, message: 'Use a GitHub-hosted runner' },
  { env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', DOCKER_HOST: 'tcp://127.0.0.1:9' }, message: 'Use only the hosted runner daemon' },
])('refuses Docker access outside the isolated hosted daemon: $message', ({ env, message }) => {
  const result = spawnSync(process.execPath, [script, '--image=unused:1'], {
    encoding: 'utf8', windowsHide: true, timeout: 5000,
    env: { ...process.env, ...env, PATH: '', Path: '' },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
});
