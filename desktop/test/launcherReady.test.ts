import { describe, expect, it, vi } from 'vitest';
// The smoke runs directly under Node; keep its readiness helper in that format.
// @ts-expect-error Node script has no declaration file.
import { waitForLauncher } from '../scripts/launcher-ready.mjs';

const ready = { form: true, bridge: 'object', node: 'undefined', title: 'NineDeploy' };

describe('packaged launcher readiness', () => {
  it('waits for the preload even when the form already exists', async () => {
    const read = vi.fn().mockResolvedValueOnce({ ...ready, bridge: 'undefined' }).mockResolvedValueOnce({ ...ready, bridge: 'undefined' }).mockResolvedValue(ready);
    const pause = vi.fn();
    await expect(waitForLauncher(read, { pause })).resolves.toEqual(ready);
    expect(read).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledTimes(2);
  });

  it('waits for the document even when the preload already exists', async () => {
    const read = vi.fn().mockResolvedValueOnce({ ...ready, form: false }).mockResolvedValue(ready);
    await expect(waitForLauncher(read, { pause: vi.fn() })).resolves.toEqual(ready);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('returns immediately when the document and isolated bridge are ready', async () => {
    const pause = vi.fn();
    await expect(waitForLauncher(vi.fn().mockResolvedValue(ready), { pause })).resolves.toEqual(ready);
    expect(pause).not.toHaveBeenCalled();
  });

  it('bounds the wait for a missing bridge', async () => {
    const read = vi.fn().mockResolvedValue({ ...ready, bridge: 'undefined' });
    const pause = vi.fn();
    await expect(waitForLauncher(read, { attempts: 3, pause })).rejects.toThrow('unexpected launcher state');
    expect(read).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledTimes(2);
  });

  it('never accepts a renderer with Node exposed', async () => {
    await expect(waitForLauncher(vi.fn().mockResolvedValue({ ...ready, node: 'function' }), { attempts: 1 })).rejects.toThrow('unexpected launcher state');
  });
});
