import path from 'node:path';
import { expect, it, vi } from 'vitest';
const paths = vi.hoisted(() => ({ reposDir: '' }));
vi.mock('../../apps/server/src/config.js', () => ({ config: { paths } }));
import { stackWorkspace } from '../../apps/server/src/lib/composeWorkspace.js';
it('verifies root, nested, trailing and invalid paths without writing at root', () => {
  const root = path.parse(process.cwd()).root;
  for (const directory of [root, path.join(root, 'fixture'), path.join(root, 'fixture') + path.sep]) {
    paths.reposDir = directory;
    for (const id of [1, 42, 999]) expect(stackWorkspace(id)).toBe(path.join(directory, String(id)));
    for (const invalid of [NaN, Infinity, 1.5, '../escape', '42', null, undefined]) {
      expect(() => stackWorkspace(invalid as number)).toThrow(/invalid workspace id/);
    }
  }
  console.log('EXPECTED: 9 valid children, 21 invalid IDs rejected | ACTUAL: all passed');
  console.log('FIX VERIFIED');
});
