import { expect, it, vi } from 'vitest';
import { pruneImages, type ImageCommands } from '../../apps/server/src/lib/imageInventory.js';
const id = `sha256:${'a'.repeat(64)}`;
async function prune(fail: boolean, inspectError = '') {
  const execution: ImageCommands = {
    capture: async (_cmd, args = []) => {
      if (args[0] === 'image' && args[1] === 'ls') return JSON.stringify({ ID: id, Repository: 'fixture', Tag: 'old', Size: '1MB', CreatedAt: '2020-01-01T00:00:00Z' });
      if (args[0] === 'ps') return '';
      if (args[0] === 'image' && args[1] === 'inspect') throw new Error(inspectError);
      throw new Error('Unexpected command');
    },
    run: async () => { if (fail) throw new Error('Docker image removal did not complete'); },
  };
  return pruneImages({}, new Set(), execution);
}
it('never credits deletion based on a failed follow-up inspection', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
  try {
    const control = await prune(false);
    expect(control.removed).toEqual([id]); expect(control.freedBytes).toBe(1024 * 1024);
    const absent = await prune(true, 'Error response from daemon: No such image: fixture');
    expect(absent.removed).toEqual([id]);
    console.log('CONTROL EXPECTED: successful removal / explicit absence credited | ACTUAL: both credited');
    const actual = await prune(true, 'Cannot connect to the Docker daemon');
    console.log('EXPECTED: removed=[] freedBytes=0 | ACTUAL:', JSON.stringify({ removed: actual.removed, freedBytes: actual.freedBytes }));
    console.log(actual.removed.length ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED');
    expect(actual.removed).toEqual([]); expect(actual.freedBytes).toBe(0);
  } finally { vi.useRealTimers(); }
});
