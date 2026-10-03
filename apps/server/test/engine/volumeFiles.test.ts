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
