import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
vi.mock('../../apps/server/src/lib/crypto.js', () => ({ decrypt: (value: string) => value }));
import { dispatchLogToDrain } from '../../apps/server/src/engine/logDrainManager.js';
import { searchLogs } from '../../apps/server/src/lib/logSearch.js';
it('queries the same reverse-proxy prefix that accepts the configured push endpoint', async () => {
  let prefix = '';
  const server = createServer((req, res) => {
    req.resume(); res.setHeader('connection', 'close');
    const pathname = new URL(req.url!, 'http://fixture.invalid').pathname;
    if (req.method === 'POST' && pathname === `${prefix}/loki/api/v1/push`) { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && pathname === `${prefix}/loki/api/v1/query_range`) {
      res.end(JSON.stringify({ status: 'success', data: { result: [] } })); return;
    }
    res.writeHead(404); res.end('outside configured proxy prefix');
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const results: Array<{ prefix: string; pushed: boolean; queried: boolean }> = [];
    for (const selected of ['', '/gateway/team-a']) {
      prefix = selected;
      const url = `${base}${prefix}/loki/api/v1/push`;
      const pushed = await dispatchLogToDrain({ url, type: 'loki', format: 'json' }, { timestamp: '2026-11-09T00:00:00Z', service: 'fixture', container: 'fixture', line: 'fixture' }, fetch);
      expect(pushed.ok).toBe(true);
      const drain = { id: 1, name: 'fixture', type: 'loki', enabled: true, url, apiKeyEncrypted: null, headersJson: null };
      const db = { query: { logDrains: { findMany: async () => [drain] } } } as never;
      let queried = false;
      try { queried = !(await searchLogs(db, { query: 'fixture' })).unsupported; } catch { /* actual404 */ }
      results.push({ prefix, pushed: pushed.ok, queried });
    }
    expect(results[0]?.queried).toBe(true);
    console.log('CONTROL EXPECTED: root push/query accepted | ACTUAL:', results[0]);
    console.log('EXPECTED: configured prefixed push and query both work | ACTUAL:', results[1]);
    console.log(results[1]?.queried ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
    expect(results[1]?.queried).toBe(true);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
