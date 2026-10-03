import { describe, expect, it, vi } from 'vitest';

const osMock = vi.hoisted(() => ({
  cpus: vi.fn(),
  freemem: vi.fn(),
  loadavg: vi.fn(),
  totalmem: vi.fn(),
}));

const execMock = vi.hoisted(() => ({
  capture: vi.fn(),
}));

vi.mock('node:os', () => osMock);
vi.mock('../../src/lib/exec.js', () => execMock);

const { collectContainerStats, collectHostStats } = await import('../../src/lib/stats.js');

const DOCKER_OUTPUT = [
  'web|1.23%|10.5MiB / 64MiB',
  'db|0.00%|12.34GiB / 1.5GiB',
  '',
  '|5%|1b / 2b', // no name → skipped
  'api|abc|5.0MB / 977kB', // non-numeric cpu → 0
  'all-units|9%|1kb / 1kib',
  'u2|9%|1mb / 1mib',
  'u3|9%|1gb / 1gib',
  'u4|9%|1tb / 1tib',
  'u5|9%|1xb / 2B', // unknown unit → 1x
  'u6|9%|junk / ', // unparseable → 0 bytes
  'loner', // no pipes at all → cpu/mem undefined
  'num|9%|123 / 456', // number-only sizes → 'b' unit fallback
  'nolit|9%|100', // no limit after '/' → limit fallback
  '',
].join('\n');

describe('collectContainerStats', () => {
  it('parses docker stats output into a map', async () => {
    // 'web' has a configured 64MiB limit (docker inspect); everything else is
    // unlimited → memLimitBytes 0 (NOT docker stats' host-total fallback).
    execMock.capture.mockImplementation(async (_c: unknown, args: unknown[]) => {
      const a = args as string[];
      if (a[0] === 'ps') return 'id1\nid2\n';
      if (a[0] === 'inspect') return '/web|67108864\n/db|0\n';
      return DOCKER_OUTPUT;
    });
    const map = await collectContainerStats();

    expect(map.size).toBe(12);
    expect(map.get('web')).toEqual({ name: 'web', cpuPct: 1.23, memBytes: 10.5 * 1024 ** 2, memLimitBytes: 64 * 1024 ** 2 });
    expect(map.get('db')).toEqual({ name: 'db', cpuPct: 0, memBytes: 12.34 * 1024 ** 3, memLimitBytes: 0 });
    expect(map.get('api')).toMatchObject({ cpuPct: 0, memBytes: 5 * 1024 ** 2, memLimitBytes: 0 });
    expect(map.get('all-units')).toEqual({ name: 'all-units', cpuPct: 9, memBytes: 1024, memLimitBytes: 0 });
    expect(map.get('u2')).toEqual({ name: 'u2', cpuPct: 9, memBytes: 1024 ** 2, memLimitBytes: 0 });
    expect(map.get('u3')).toEqual({ name: 'u3', cpuPct: 9, memBytes: 1024 ** 3, memLimitBytes: 0 });
    expect(map.get('u4')).toEqual({ name: 'u4', cpuPct: 9, memBytes: 1024 ** 4, memLimitBytes: 0 });
    expect(map.get('u5')).toEqual({ name: 'u5', cpuPct: 9, memBytes: 1, memLimitBytes: 0 });
    expect(map.get('u6')).toMatchObject({ memBytes: 0, memLimitBytes: 0 });
    expect(map.get('loner')).toEqual({ name: 'loner', cpuPct: 0, memBytes: 0, memLimitBytes: 0 });
    expect(map.get('num')).toEqual({ name: 'num', cpuPct: 9, memBytes: 123, memLimitBytes: 0 });
    expect(map.get('nolit')).toEqual({ name: 'nolit', cpuPct: 9, memBytes: 100, memLimitBytes: 0 });
    expect(execMock.capture).toHaveBeenCalledWith('docker', expect.arrayContaining(['stats']));
  });

  it('returns an empty map when docker is unavailable', async () => {
    execMock.capture.mockRejectedValue(new Error('ENOENT'));
    await expect(collectContainerStats()).resolves.toEqual(new Map());
  });

  it('skips limit probing when nothing is running', async () => {
    execMock.capture.mockImplementation(async (_c: unknown, args: unknown[]) => {
      const a = args as string[];
      if (a[0] === 'ps') return '\n';
      return DOCKER_OUTPUT;
    });
    const map = await collectContainerStats();
    // no inspect call happened → no configured limits → 0
    expect(map.get('web')).toMatchObject({ memLimitBytes: 0 });
  });

  it('handles a single line with no trailing newline', async () => {
    // limit probing degrades to zero when ps/inspect fail — stats still parse
    execMock.capture.mockImplementation(async (_c: unknown, args: unknown[]) => {
      const a = args as string[];
      if (a[0] === 'ps') throw new Error('docker ps failed');
      return 'solo|5%|1MiB / 2MiB';
    });
    const map = await collectContainerStats();
    expect(map.get('solo')).toEqual({ name: 'solo', cpuPct: 5, memBytes: 1024 ** 2, memLimitBytes: 0 });
  });
});

describe('collectHostStats', () => {
  it('combines os metrics with df output', async () => {
    osMock.cpus.mockReturnValue([{}, {}, {}, {}]);
    osMock.totalmem.mockReturnValue(16 * 1024 ** 3);
    osMock.freemem.mockReturnValue(4 * 1024 ** 3);
    osMock.loadavg.mockReturnValue([0.5, 0.4, 0.3]);
    execMock.capture.mockImplementation(async (cmd: string) => {
      if (cmd === 'df') return 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/sda1 1000 400 600 40% /';
      return '';
    });

    const host = await collectHostStats();
    expect(host).toEqual({
      cpuCores: 4,
      load1: 0.5,
      memTotalBytes: 16 * 1024 ** 3,
      memUsedBytes: 12 * 1024 ** 3,
      diskTotalBytes: 1000 * 1024,
      diskUsedBytes: 400 * 1024,
    });
  });

  it('falls back to zero load when loadavg is empty', async () => {
    osMock.loadavg.mockReturnValue([] as number[]);
    osMock.cpus.mockReturnValue([{}]);
    osMock.totalmem.mockReturnValue(1024);
    osMock.freemem.mockReturnValue(512);
    execMock.capture.mockResolvedValue('Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/sda1 1000 400 600 40% /');

    const host = await collectHostStats();
    expect(host.load1).toBe(0);
  });

  it('returns zero disk when df output is missing the data line', async () => {
    execMock.capture.mockResolvedValue('Filesystem 1024-blocks Used Available Capacity Mounted\n');
    const host = await collectHostStats();
    expect(host.diskTotalBytes).toBe(0);
    expect(host.diskUsedBytes).toBe(0);
  });

  it('returns zero disk when df fails', async () => {
    execMock.capture.mockRejectedValue(new Error('ENOENT'));
    const host = await collectHostStats();
    expect(host.diskTotalBytes).toBe(0);
    expect(host.diskUsedBytes).toBe(0);
  });
});
