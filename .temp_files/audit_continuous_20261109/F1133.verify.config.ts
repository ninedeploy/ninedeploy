import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import base from '../../apps/server/vitest.config.ts';
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  ...base,
  root: r('../../apps/server/'),
  resolve: { alias: [{ find: /^@ninedeploy\/db$/, replacement: r('../../packages/db/dist/index.js') }] },
  test: {
    ...base.test,
    include: ['test/swarmDeploy.test.ts'],
    setupFiles: [r('./verify_F1133_swarmDb.setup.ts')],
    coverage: { enabled: false },
  },
});
