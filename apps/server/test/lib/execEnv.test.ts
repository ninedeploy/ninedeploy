import { afterEach, describe, expect, it } from 'vitest';
import { buildEnv } from '../../src/lib/exec.js';

/**
 * Regression r082: under the hardened systemd unit /root is read-only
 * (ProtectHome=read-only) and modern buildx writes builder-activity files
 * under $DOCKER_CONFIG/buildx/activity. The unit exports DOCKER_CONFIG
 * pointing at a writable data path — buildEnv must pass it through to every
 * spawned docker CLI, or every `docker build` fails with
 * "read-only file system" before a single layer is built.
 */
describe('buildEnv — DOCKER_CONFIG passthrough', () => {
  afterEach(() => {
    delete process.env.DOCKER_CONFIG;
  });

  it('inherits DOCKER_CONFIG when the host defines it', () => {
    process.env.DOCKER_CONFIG = '/var/lib/ninedeploy/.data/docker-config';
    expect(buildEnv().DOCKER_CONFIG).toBe('/var/lib/ninedeploy/.data/docker-config');
  });

  it('stays absent when the host does not define it (compose mode keeps its default)', () => {
    delete process.env.DOCKER_CONFIG;
    expect(buildEnv().DOCKER_CONFIG).toBeUndefined();
  });
});
