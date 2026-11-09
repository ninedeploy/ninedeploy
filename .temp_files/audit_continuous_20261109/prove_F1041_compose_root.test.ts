import path from 'node:path';
import { expect, it, vi } from 'vitest';
const paths = vi.hoisted(() => ({ reposDir: '' }));
vi.mock('../../apps/server/src/config.js', () => ({ config: { paths } }));
import { stackWorkspace } from '../../apps/server/src/lib/composeWorkspace.js';
it('accepts a filesystem-root reposDir without weakening ID validation', () => {
  paths.reposDir = path.join(process.cwd(), 'fixture');
  expect(stackWorkspace(42)).toBe(path.join(paths.reposDir, '42'));
  console.log('CONTROL EXPECTED: nested root accepts 42 | ACTUAL: passed');
  paths.reposDir = path.parse(process.cwd()).root;
  let actual: string;
  try { actual = stackWorkspace(42); } catch (error) { actual = String(error); }
  const expected = path.join(paths.reposDir, '42');
  console.log('EXPECTED:', expected, '| ACTUAL:', actual);
  console.log(actual === expected ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
  expect(actual).toBe(expected);
});
