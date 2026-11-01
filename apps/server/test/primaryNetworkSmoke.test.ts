import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/smoke-primary-network-readiness.mjs', import.meta.url));
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
