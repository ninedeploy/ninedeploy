import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  containerdCliArgs,
  ensureDockerImage,
  isTransientSnapshotFailure,
  normalizeContainerdImageRef,
  pullDockerImage,
} from '../../src/lib/dockerPull.js';

const h = vi.hoisted(() => ({
  run: vi.fn(),
  capture: vi.fn(),
  sleep: vi.fn(async () => undefined),
}));

vi.mock('../../src/lib/exec.js', () => ({ capture: h.capture, run: h.run, sleep: h.sleep }));

// Pin the containerd socket probe to "absent" so `containerdCliArgs` never
// prepends `--address`: runners where a standalone containerd daemon happens to
// be listening (e.g. GitHub's Ubuntu images since late August 2026) would
// otherwise make every literal ctr argument array below diverge from the
// expectation. Socket discovery itself is covered directly in the
// "targets Docker managed containerd" case above.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: () => false };
});

describe('pullDockerImage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('recognizes containerd snapshot extraction races', () => {
    expect(isTransientSnapshotFailure(['target snapshot "sha256:abc" already exists'])).toBe(true);
    expect(isTransientSnapshotFailure(['parent snapshot sha256:abc does not exist'])).toBe(true);
    expect(isTransientSnapshotFailure(['unauthorized: authentication required'])).toBe(false);
  });

  it('normalizes Docker Hub references without corrupting private registry ports', () => {
    expect(normalizeContainerdImageRef('gitea/gitea:latest')).toBe('docker.io/gitea/gitea:latest');
    expect(normalizeContainerdImageRef('postgres:16')).toBe('docker.io/library/postgres:16');
    expect(normalizeContainerdImageRef('registry.example:5000/acme/app:v1')).toBe('registry.example:5000/acme/app:v1');
  });

  it('does not pull a helper image that already exists locally', async () => {
    h.capture.mockResolvedValueOnce('sha256:local');

    await ensureDockerImage('busybox:1.36', vi.fn());

    expect(h.capture).toHaveBeenCalledWith('docker', ['image', 'inspect', 'busybox:1.36', '--format', '{{.Id}}']);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('routes a missing helper image through the recoverable pull path', async () => {
    h.capture.mockRejectedValueOnce(new Error('No such image'));
    h.run.mockResolvedValueOnce(undefined);
    const log = vi.fn();

    await ensureDockerImage('busybox:1.36', log);

    expect(h.run).toHaveBeenCalledWith(
      'docker',
      ['pull', 'busybox:1.36'],
      { heartbeatMs: 20_000, heartbeatLabel: 'Pulling application image busybox:1.36' },
      expect.any(Function),
    );
  });

  it('targets Docker managed containerd when its socket is present', () => {
    expect(containerdCliArgs(['images', 'list'], (candidate) => candidate.includes('/docker/containerd/'))).toEqual([
      '--address', '/var/run/docker/containerd/containerd.sock', '--namespace', 'moby', 'images', 'list',
    ]);
    expect(containerdCliArgs(['images', 'list'], () => false)).toEqual(['--namespace', 'moby', 'images', 'list']);
  });

  it('retries a transient snapshot failure and preserves streamed logs', async () => {
    h.run
      .mockImplementationOnce(async (_cmd, _args, _opts, sink) => {
        sink('unable to prepare extraction snapshot: parent snapshot sha256:abc does not exist');
        throw new Error('docker pull exited 1');
      })
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();

    await pullDockerImage('traefik:3', log);

    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.sleep).toHaveBeenCalledWith(2000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('retrying (2/3)'));
  });

  it('does not retry unrelated pull failures', async () => {
    h.run.mockImplementationOnce(async (_cmd, _args, _opts, sink) => {
      sink('unauthorized: authentication required');
      throw new Error('docker pull exited 1');
    });

    await expect(pullDockerImage('private/image', vi.fn())).rejects.toThrow('docker pull exited 1');
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it('stops after the bounded attempt count', async () => {
    h.run.mockImplementation(async (cmd, args, _opts, sink) => {
      if (cmd === 'docker' && args[0] === 'pull') {
        sink('failed to prepare extraction snapshot: parent snapshot sha256:x does not exist');
        throw new Error('still broken');
      }
      throw new Error('native recovery unavailable');
    });

    await expect(pullDockerImage('n8nio/n8n', vi.fn())).rejects.toThrow('still broken');
    expect(h.run).toHaveBeenCalledTimes(5);
    expect(h.sleep).toHaveBeenCalledTimes(2);
  });

  it('bypasses both broken snapshotters with a checksum-verified registry export', async () => {
    h.run.mockImplementation(async (cmd, args, _opts, sink) => {
      if (cmd === 'docker' && args[0] === 'pull') {
        sink('unable to prepare extraction snapshot: target snapshot "sha256:abc" already exists');
        throw new Error('docker pull exited 1');
      }
      if (cmd === 'ctr' && args.includes('native')) throw new Error('native snapshotter exited 1');
    });
    h.capture
      .mockResolvedValueOnce(JSON.stringify({
        config: {
          Env: ['MYSQL_VERSION=8.4'],
          Entrypoint: ['docker-entrypoint.sh'],
          Cmd: ['mysqld'],
          ExposedPorts: { '3306/tcp': {} },
          Volumes: { '/var/lib/mysql': {} },
        },
      }))
      .mockResolvedValueOnce('sha256:flattened')
      .mockResolvedValueOnce(JSON.stringify({ config: { Cmd: ['postgres'] } }))
      .mockResolvedValueOnce('sha256:flattened-postgres');
    const log = vi.fn();

    await pullDockerImage('mysql:8.4', log, 1);
    await pullDockerImage('postgres:16', log, 1);

    expect(h.run).toHaveBeenCalledWith(
      'sha256sum',
      ['--check', '--strict', '-'],
      {},
      log,
      expect.any(Buffer),
    );
    expect(h.run).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]crane$/),
      expect.arrayContaining(['export', 'mysql:8.4', '--platform', 'linux/amd64']),
      expect.any(Object),
      log,
    );
    expect(h.run).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'image', 'import',
        '--platform=linux/amd64',
        '--change', 'ENTRYPOINT ["docker-entrypoint.sh"]',
        '--change', 'CMD ["mysqld"]',
        'mysql:8.4',
      ]),
      expect.any(Object),
      log,
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('containerd extraction was bypassed'));
    expect(h.run.mock.calls.filter(([cmd]) => cmd === 'curl')).toHaveLength(1);
  });

  it('repairs an unused committed overlayfs snapshot before falling back to flattening', async () => {
    const key = `sha256:${'a'.repeat(64)}`;
    let pulls = 0;
    h.run.mockImplementation(async (cmd, args, _opts, sink) => {
      if (cmd === 'docker' && args[0] === 'pull' && pulls++ === 0) {
        sink(`unable to prepare extraction snapshot: target snapshot "${key}" already exists`);
        throw new Error('docker pull exited 1');
      }
    });
    h.capture.mockResolvedValueOnce(JSON.stringify({ Kind: 'Committed', Name: key }));
    const log = vi.fn();

    await pullDockerImage('mysql:8.4', log, 1);

    expect(h.run).toHaveBeenCalledWith(
      'ctr',
      ['--namespace', 'moby', 'snapshots', '--snapshotter', 'overlayfs', 'remove', key],
      {},
      log,
    );
    expect(h.run).toHaveBeenLastCalledWith(
      'docker',
      ['pull', 'mysql:8.4'],
      { heartbeatMs: 20_000, heartbeatLabel: 'Pulling mysql:8.4 after snapshot repair' },
      log,
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('targeted snapshot metadata repair'));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('isolated native snapshotter'));
  });

  it('recovers through ctr local mode when the transfer API loses the unpack platform', async () => {
    h.run.mockImplementation(async (cmd, args, _opts, sink) => {
      if (cmd === 'docker' && args[0] === 'pull') {
        sink('unable to prepare extraction snapshot: target snapshot "sha256:abc" already exists');
        throw new Error('docker pull exited 1');
      }
      if (cmd === 'ctr' && args.includes('pull') && !args.includes('--local')) {
        sink('ctr: unable to initialize unpacker: no unpack platforms defined: invalid argument');
        throw new Error('ctr transfer pull exited 1');
      }
    });
    h.capture
      .mockResolvedValueOnce(JSON.stringify({ Target: { Digest: 'sha256:manifest' } }))
      .mockResolvedValueOnce(JSON.stringify({ config: { digest: 'sha256:config' } }))
      .mockResolvedValueOnce(JSON.stringify({
        config: {
          Env: ['USER=git'],
          Entrypoint: ['/usr/bin/entrypoint'],
          Cmd: ['/bin/s6-svscan', '/etc/s6'],
          WorkingDir: '/data',
          User: '1000',
          ExposedPorts: { '3000/tcp': {} },
          Volumes: { '/data': {} },
          Labels: { 'org.opencontainers.image.title': 'Gitea' },
          Healthcheck: { Test: ['CMD', 'wget', '-qO-', 'http://localhost:3000/'], Interval: 30_000_000_000 },
        },
      }))
      .mockResolvedValueOnce('sha256:recovered');
    const log = vi.fn();

    await pullDockerImage('gitea/gitea:latest', log, 1);

    expect(h.run).toHaveBeenCalledWith(
      'ctr',
      [
        '--namespace', 'moby', 'images', 'pull', '--snapshotter', 'native',
        '--platform', 'linux/amd64', 'docker.io/gitea/gitea:latest',
      ],
      expect.any(Object),
      expect.any(Function),
    );
    expect(h.run).toHaveBeenCalledWith(
      'ctr',
      [
        '--namespace', 'moby', 'images', 'pull', '--local', '--snapshotter', 'native',
        '--platform', 'linux/amd64', 'docker.io/gitea/gitea:latest',
      ],
      expect.any(Object),
      log,
    );
    expect(h.run).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'image', 'import',
        '--platform=linux/amd64',
        '--change', 'ENV USER="git"',
        '--change', 'ENTRYPOINT ["/usr/bin/entrypoint"]',
        '--change', 'EXPOSE 3000/tcp',
        '--change', 'VOLUME ["/data"]',
        '--change', 'HEALTHCHECK --interval=30000000000ns CMD ["wget","-qO-","http://localhost:3000/"]',
        'gitea/gitea:latest',
      ]),
      expect.any(Object),
      log,
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('existing Docker state was preserved'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('retrying through ctr local mode'));
    expect(h.sleep).not.toHaveBeenCalled();
  });
});
