import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerStaticFiles } from '../../apps/server/src/plugins/staticFiles.js';

const cases = process.env['F1125_VERIFY']
  ? [false, true].flatMap((dashboard) => ['GET', 'POST', 'HEAD'].map((method) => ({ dashboard, method })))
  : [{ dashboard: true, method: 'GET' }, { dashboard: false, method: 'GET' }];

for (const { dashboard, method } of cases) {
  it(`F1125 ${dashboard ? 'dashboard control' : 'API-only'} ${method} does not log query credentials`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'nd-f1125-'));
    writeFileSync(join(root, 'index.html'), '<html>owned dashboard</html>');
    const lines: string[] = [];
    const app = Fastify({ logger: {
      stream: { write: (line: string) => { lines.push(String(line)); } },
      serializers: { req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.split('?')[0] }) },
    } });
    try {
      await registerStaticFiles(app, dashboard ? root : null);
      const response = await app.inject({ method: method as 'GET' | 'POST' | 'HEAD', url: '/v1/missing?token=owned-secret-F1125' });
      expect(response.statusCode).toBe(404);
      const leaked = lines.some((line) => line.includes('owned-secret-F1125'));
      console.log(`EXPECTED: no logged query credential; ACTUAL: leaked=${leaked}; dashboard=${dashboard}; method=${method}`);
      console.log(leaked ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED');
      expect(leaked).toBe(false);
      expect(lines.some((line) => line.includes('incoming request'))).toBe(true);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
