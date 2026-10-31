import { expect, it } from 'vitest';
import { ciPipeline } from '../src/ci.js';

const pipeline = { image: 'node:26-slim', script: 'npm test' };

it('accepts ordinary job variables and preserves CI pipeline defaults', () => {
  expect(ciPipeline.parse({ ...pipeline, secrets: ['DATABASE_URL', 'APP_TOKEN', '_BUILD_ID'] })).toEqual({
    ...pipeline, secrets: ['DATABASE_URL', 'APP_TOKEN', '_BUILD_ID'], labels: [], timeoutMinutes: 30,
    maxAttempts: 2, requireApproval: false, runOnPush: false, gateDeploys: false,
  });
});

it.each(['DOCKER_HOST', 'docker_context', 'PATH', 'HOME', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
  'BASH_ENV', 'BASH_FUNC_payload', 'NODE_OPTIONS', 'NPM_CONFIG_PREFIX', 'HTTP_PROXY', 'no_proxy',
  'BUILDKIT_HOST', 'SSL_CERT_FILE', 'NINEDEPLOY_MASTER_KEY', 'CI'])('refuses runner-control variable %s', name => {
  const parsed = ciPipeline.safeParse({ ...pipeline, secrets: [name] });
  expect(parsed.success).toBe(false);
  if (!parsed.success) expect(parsed.error.issues.some(issue => issue.message.includes('reserved'))).toBe(true);
});

it.each(['', '1TOKEN', 'TOKEN-NAME', 'APP TOKEN', 'A'.repeat(129)])('refuses malformed variable names: %j', name => {
  expect(ciPipeline.safeParse({ ...pipeline, secrets: [name] }).success).toBe(false);
});
