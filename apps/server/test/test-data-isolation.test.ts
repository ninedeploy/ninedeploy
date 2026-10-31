import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { config } from '../src/config.js';

it('uses a dedicated temporary data directory and database for server tests', () => {
  const root = path.resolve(config.paths.dataDir);
  expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(root)).toMatch(/^ninedeploy-vitest-/);
  expect(path.resolve(config.paths.dbFile)).toBe(path.join(root, 'test.db'));
});
