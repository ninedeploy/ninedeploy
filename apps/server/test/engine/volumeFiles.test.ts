import { describe, expect, it, vi } from 'vitest';

const execMocks = vi.hoisted(() => ({
  run: vi.fn(async () => undefined),
  capture: vi.fn(async () => ''),
}));
vi.mock('../../src/lib/exec.js', () => execMocks);

const volumeFiles = await import('../../src/engine/volumeFiles.js');

describe('engine/volumeFiles guard', () => {
  it('operates on managed nd-* volumes', async () => {
    await expect(volumeFiles.listVolumeDir('nd-svc-web-data', '')).resolves.toBeDefined();
    expect(execMocks.capture).toHaveBeenCalled();
  });

  it('lists empty regular files alongside nonempty files in Alpine volume helpers', async () => {
    execMocks.capture.mockImplementation(async (...args: unknown[]) => (args[1] as string[])?.[0] === 'run'
      ? 'regular empty file|0|1792774000|./empty.txt\nregular file|4|1792774000|./data.txt\n'
      : '');
    const entries = await volumeFiles.listVolumeDir('nd-svc-web-data', '');
    expect(entries.find(entry => entry.name === 'data.txt')).toMatchObject({ type: 'file', sizeBytes: 4 });
    expect(entries.find(entry => entry.name === 'empty.txt')).toMatchObject({ type: 'file', sizeBytes: 0 });
  });

  it('refuses non-managed volume names at the choke point', async () => {
    // A name like `/` would make `-v /:/v` catastrophic — every operation
    // must reject it, not just the route-level callers.
    await expect(volumeFiles.listVolumeDir('/', '')).rejects.toThrow('non-managed volume');
    await expect(volumeFiles.readVolumeFile('evil', 'a')).rejects.toThrow('non-managed volume');
    await expect(volumeFiles.writeVolumeFile('evil', 'a', 'aGk=', vi.fn())).rejects.toThrow('non-managed volume');
    await expect(volumeFiles.makeVolumeDir('evil', 'a')).rejects.toThrow('non-managed volume');
    await expect(volumeFiles.deleteVolumePath('..', 'a', vi.fn())).rejects.toThrow('non-managed volume');
    expect(execMocks.run).not.toHaveBeenCalled();
  });
});
