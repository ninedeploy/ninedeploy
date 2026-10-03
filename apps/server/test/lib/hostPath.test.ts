import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostPathFor, resetHostPathCache } from '../../src/lib/hostPath.js';

const deps = (mounts: Array<{ Source: string; Destination: string }>, inContainer = true) => ({
  inContainer: () => inContainer,
  selfId: () => 'abc123',
  inspectMounts: vi.fn(async () => mounts),
});

describe('r245: hostPathFor', () => {
  beforeEach(() => resetHostPathCache());

  it('is the identity outside a container (bare metal)', async () => {
    const d = deps([], false);
    expect(await hostPathFor('/data/traefik', d)).toBe('/data/traefik');
    expect(d.inspectMounts).not.toHaveBeenCalled();
  });

  it('maps a path under a named-volume mount onto the volume host path', async () => {
    const d = deps([
      { Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' },
      { Source: '/var/lib/docker/volumes/ninedeploy_ninedeploy-data/_data', Destination: '/data' },
    ]);
    expect(await hostPathFor('/data/traefik', d)).toBe('/var/lib/docker/volumes/ninedeploy_ninedeploy-data/_data/traefik');
    expect(await hostPathFor('/data/traefik/acme.json', d)).toBe(
      '/var/lib/docker/volumes/ninedeploy_ninedeploy-data/_data/traefik/acme.json',
    );
    // The mount table is read once.
    expect(d.inspectMounts).toHaveBeenCalledTimes(1);
  });

  it('prefers the longest matching destination and ignores prefix look-alikes', async () => {
    const d = deps([
      { Source: '/srv/a', Destination: '/data' },
      { Source: '/srv/b', Destination: '/data/traefik' },
    ]);
    expect(await hostPathFor('/data/traefik/x', d)).toBe('/srv/b/x');
    resetHostPathCache();
    expect(await hostPathFor('/database', d)).toBe('/database');
  });

  it('falls back to the path unchanged when the daemon cannot be asked', async () => {
    const d = { ...deps([]), inspectMounts: vi.fn(async () => { throw new Error('no socket'); }) };
    expect(await hostPathFor('/data/traefik', d)).toBe('/data/traefik');
  });

  it('is what the Traefik container mounts go through (wiring guard)', () => {
    const src = readFileSync(new URL('../../src/engine/proxy.ts', import.meta.url), 'utf8');
    const d = '$';
    // r350: the config-dir host path is resolved once (it is also compared
    // with the running container's mount) and then used for the mount.
    expect(src).toContain('const hostConfigDir = await hostPathFor(dir());');
    expect(src).toContain(`\`${d}{hostConfigDir}:/etc/traefik:ro\``);
    expect(src).toContain(`\`${d}{await hostPathFor(acmePath())}:/etc/traefik/acme.json\``);
  });
});
