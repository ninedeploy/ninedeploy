import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { startTunnel, stopTunnel } from '../src/engine/tunnel.js';

const h = vi.hoisted(() => {
  const decrypt = vi.fn((v: string) => `tok:${v}`);
  const run = vi.fn(async (_cmd: string, _args: unknown[], _opts: unknown, sink?: (line: string) => void) => {
    sink?.('');
  });
  const config: { paths: { dataDir: string } } = { paths: { dataDir: '' } };
  return { decrypt, run, config };
});

vi.mock('../src/lib/crypto.js', () => ({ decrypt: h.decrypt }));
vi.mock('../src/lib/exec.js', () => ({ run: h.run, capture: vi.fn(), sleep: vi.fn() }));
const dockerPullMocks = vi.hoisted(() => ({ ensureDockerImage: vi.fn(async () => undefined) }));
vi.mock('../src/lib/dockerPull.js', () => dockerPullMocks);
vi.mock('../src/config.js', () => ({ config: h.config }));

const base = mkdtempSync(path.join(os.tmpdir(), 'nd-tunnel-'));
h.config.paths = { dataDir: base };

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const tunnel = {
  id: 1,
  name: 'web',
  slug: 'web',
  tokenEncrypted: 'enc-token',
  status: 'running',
  containerName: 'nd-tunnel-web',
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe('startTunnel', () => {
  it('runs a cloudflared container with the token passed via an env-file (never argv)', async () => {
    const log = vi.fn();

    await startTunnel(tunnel, log);

    expect(dockerPullMocks.ensureDockerImage).toHaveBeenCalledWith('cloudflare/cloudflared:2026.8.3', log);
    expect(h.decrypt).toHaveBeenCalledWith('enc-token');
    expect(log).toHaveBeenCalledWith('Starting Cloudflare Tunnel web (nd-tunnel-web) …');
    const args = h.run.mock.calls[0]![1] as unknown[];
    expect(args).toEqual([
      'run', '-d', '--name', 'nd-tunnel-web', '--network', 'ninedeploy', '--restart', 'unless-stopped',
      '--env-file', expect.any(String),
      'cloudflare/cloudflared:2026.8.3', 'tunnel', '--no-autoupdate', 'run',
    ]);
    // The decrypted token is never present in the docker argv.
    expect(args).not.toContain('tok:enc-token');
    expect(args).not.toContain('--token');
    // The temp env-file was cleaned up after start.
    const fileIdx = args.indexOf('--env-file');
    expect(existsSync(args[fileIdx + 1] as string)).toBe(false);
  });

  it('still deletes the env-file when docker run fails', async () => {
    h.run.mockRejectedValueOnce(new Error('name conflict'));
    const log = vi.fn();

    await expect(startTunnel(tunnel, log)).rejects.toThrow('name conflict');

    const args = h.run.mock.calls[0]![1] as unknown[];
    const fileIdx = args.indexOf('--env-file');
    expect(existsSync(args[fileIdx + 1] as string)).toBe(false);
  });
});

describe('stopTunnel', () => {
  it('removes the tunnel container', async () => {
    await stopTunnel(tunnel);

    expect(h.run).toHaveBeenCalledWith('docker', ['rm', '-f', 'nd-tunnel-web'], {}, expect.any(Function));
  });

  it('swallows errors from the remove command', async () => {
    h.run.mockRejectedValueOnce(new Error('no such container'));

    await expect(stopTunnel(tunnel)).resolves.toBeUndefined();
  });
});
