import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 0.16.1 panel-host addresses for a port mapping's Host IP: parsed from
 * `ip -o addr` (global scope, Docker bridges and loopback left out), read in
 * a host-network container, cached for a minute, null when Docker fails.
 */

const execMocks = vi.hoisted(() => ({ capture: vi.fn(async (..._a: unknown[]) => '') }));
vi.mock('../src/lib/exec.js', () => execMocks);
vi.mock('../src/lib/dockerPull.js', () => ({ ensureDockerImage: vi.fn(async () => undefined) }));

const { listHostAddresses, parseIpAddr, resetHostAddressCache } = await import('../src/lib/hostAddresses.js');

const IP_ADDR = [
  '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever',
  '1: lo    inet6 ::1/128 scope host \\       valid_lft forever preferred_lft forever',
  '2: eth0    inet 203.0.113.7/24 brd 203.0.113.255 scope global eth0\\       valid_lft forever preferred_lft forever',
  '2: eth0    inet 203.0.113.8/32 scope global secondary eth0\\       valid_lft forever preferred_lft forever',
  '2: eth0    inet6 2001:DB8::7/64 scope global \\       valid_lft forever preferred_lft forever',
  '2: eth0    inet6 fe80::1/64 scope link \\       valid_lft forever preferred_lft forever',
  '3: ens4@if9    inet 10.0.0.5/24 scope global ens4',
  '4: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0',
  '5: br-1a2b3c4d5e6f    inet 172.18.0.1/16 scope global br-1a2b3c4d5e6f',
  '6: eth0    inet 203.0.113.7/24 scope global eth0',
].join('\n');

afterEach(() => {
  vi.clearAllMocks();
  resetHostAddressCache();
});

describe('parseIpAddr', () => {
  it('keeps global addresses of real interfaces, once each', () => {
    expect(parseIpAddr(IP_ADDR)).toEqual([
      { ip: '203.0.113.7', family: 4, iface: 'eth0' },
      { ip: '203.0.113.8', family: 4, iface: 'eth0' },
      { ip: '2001:db8::7', family: 6, iface: 'eth0' },
      { ip: '10.0.0.5', family: 4, iface: 'ens4' },
    ]);
    expect(parseIpAddr('')).toEqual([]);
  });
});

describe('listHostAddresses', () => {
  it('asks a host-network container once a minute', async () => {
    execMocks.capture.mockResolvedValue(IP_ADDR);
    const first = await listHostAddresses(1_000);
    expect(first).toHaveLength(4);
    expect(execMocks.capture).toHaveBeenCalledWith('docker', ['run', '--rm', '--network', 'host', 'busybox:1.36', 'ip', '-o', 'addr', 'show'], { timeoutMs: 20_000 });
    expect(await listHostAddresses(30_000)).toBe(first);
    expect(execMocks.capture).toHaveBeenCalledTimes(1);
    await listHostAddresses(62_000);
    expect(execMocks.capture).toHaveBeenCalledTimes(2);
  });

  it('answers null when Docker cannot be asked', async () => {
    execMocks.capture.mockRejectedValue(new Error('Cannot connect to the Docker daemon'));
    expect(await listHostAddresses()).toBeNull();
  });
});
