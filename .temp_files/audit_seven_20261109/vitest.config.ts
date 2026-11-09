import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  resolve: { alias: [
    { find: /^@ninedeploy\/db$/, replacement: r('../../packages/db/dist/index.js') },
    { find: /^drizzle-orm(.*)$/, replacement: `${r('../../apps/server/node_modules/drizzle-orm')}$1` },
    { find: /^fastify$/, replacement: r('../../apps/server/node_modules/fastify/fastify.js') },
  ] },
  test: { environment: 'node', fileParallelism: false, testTimeout: 30000,
    include: ['.temp_files/audit_seven_20261109/*.test.ts'], coverage: { enabled: false } },
});
