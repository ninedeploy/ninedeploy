import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const data = mkdtempSync(join(tmpdir(), 'nd-audit-continuous-'));
export default defineConfig({
  resolve: { alias: [
    { find: /^@ninedeploy\/schemas$/, replacement: r('../../packages/schemas/dist/index.js') },
    { find: /^@ninedeploy\/db$/, replacement: r('../../packages/db/dist/index.js') },
    { find: /^fastify$/, replacement: r('../../apps/server/node_modules/fastify/fastify.js') },
  ] },
  test: { environment: 'node', fileParallelism: false, testTimeout: 30000,
    env: { NINEDEPLOY_DATA_DIR: data, NINEDEPLOY_DB_PATH: join(data, 'test.db') },
    include: ['.temp_files/audit_continuous_20261109/*.test.ts'], coverage: { enabled: false } },
});
