import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/** Bundle the pinned development SQL client into the isolated smoke image. */
export function nodeReplicaDatabaseApp() {
  // The existing server tsx toolchain owns esbuild. Resolve it through tsx
  // rather than relying on a globally installed or hoisted bundler.
  const serverRequire = createRequire(new URL('../../apps/server/package.json', import.meta.url));
  const buildRequire = createRequire(serverRequire.resolve('tsx/cli'));
  const { buildSync } = buildRequire('esbuild');
  const source = `
    const { Client } = require('pg');
    const http = require('node:http');
    const os = require('node:os');
    http.createServer(async (_request, response) => {
      const client = new Client({ connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 1000, query_timeout: 1000, statement_timeout: 1000 });
      try {
        await client.connect();
        const result = await client.query(process.env.DB_QUERY_FAIL === '1'
          ? 'SELECT value FROM ninedeploy_missing_fixture_table' : 'SELECT 42::integer AS value');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ready: true, value: result.rows[0].value, replica: os.hostname() }));
      } catch (error) {
        response.statusCode = 503;
        const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : error.name;
        response.end(JSON.stringify({ ready: false, code, configured: Boolean(process.env.DATABASE_URL) }));
      } finally { await client.end().catch(() => undefined); }
    }).listen(8080, '0.0.0.0');
  `;
  return buildSync({ stdin: { contents: source, resolveDir: resolve(import.meta.dirname, '../..') },
    bundle: true, platform: 'node', format: 'cjs', external: ['pg-native'], write: false,
  }).outputFiles[0].text;
}
