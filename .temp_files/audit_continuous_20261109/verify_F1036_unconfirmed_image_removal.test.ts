import { expect, it, vi } from 'vitest';
import { pruneImages, type ImageCommands } from '../../apps/server/src/lib/imageInventory.js';
const ids = ['a', 'b', 'c'].map(c => `sha256:${c.repeat(64)}`);
function execution(images: string[], replies: Record<string, string | Error>, removeFails = true) {
  let deletes = 0;
  const commands: ImageCommands = {
    capture: async (_cmd, args = []) => {
      if (args[0] === 'image' && args[1] === 'ls') return images.map(ID => JSON.stringify({ ID, Repository: 'fixture', Tag: ID.at(-1), Size: '1MB', CreatedAt: '2020-01-01T00:00:00Z' })).join('\n');
      if (args[0] === 'ps') return '';
      if (args[0] === 'image' && args[1] === 'inspect') {
        const value = replies[args[2]!]; if (value instanceof Error) throw value; return value ?? args[2]!;
      }
      throw new Error('Unexpected command');
    },
    run: async () => { deletes++; if (removeFails) throw new Error('Removal unconfirmed'); },
  };
  return { commands, deletes: () => deletes };
}
it('credits only proven removal across unknown, absent, present, partial, empty and protected cases', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
  try {
    for (const message of ['Cannot connect to the Docker daemon', 'permission denied', 'timed out', 'API 500']) {
      const fake = execution([ids[0]!], { [ids[0]!]: new Error(message) });
      for (let call = 0; call < 2; call++) {
        const result = await pruneImages({}, new Set(), fake.commands);
        expect(result).toMatchObject({ removed: [], removedLabels: [], freedBytes: 0 });
      }
    }
    const success = execution([ids[0]!], {}, false);
    expect((await pruneImages({}, new Set(), success.commands)).removed).toEqual([ids[0]]);
    for (const message of ['No such image: fixture', 'Error response from daemon: No such object: fixture']) {
      const gone = execution([ids[0]!], { [ids[0]!]: new Error(message) });
      expect((await pruneImages({}, new Set(), gone.commands)).freedBytes).toBe(1024 * 1024);
    }
    const partial = execution(ids, { [ids[0]!]: new Error('No such image'), [ids[1]!]: new Error('inspect timeout'), [ids[2]!]: ids[2]! });
    expect(await pruneImages({}, new Set(), partial.commands)).toMatchObject({ removed: [ids[0]], removedLabels: ['fixture:a'], freedBytes: 1024 * 1024 });
    const empty = execution([], {});
    expect((await pruneImages({}, new Set(), empty.commands)).removed).toEqual([]); expect(empty.deletes()).toBe(0);
    const protectedImage = execution([ids[0]!], {});
    expect((await pruneImages({}, new Set([ids[0]!]), protectedImage.commands)).removed).toEqual([]); expect(protectedImage.deletes()).toBe(0);
    console.log('FIX VERIFIED');
  } finally { vi.useRealTimers(); }
});
