import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
vi.mock('../../apps/server/src/lib/crypto.js', () => ({ decrypt: (value: string) => value }));
import { searchLogs } from '../../apps/server/src/lib/logSearch.js';
import { dispatchLogToDrain } from '../../apps/server/src/engine/logDrainManager.js';
it('keeps successful drain authentication when querying the same upstream', async () => {
  let requireTenant = false;
  const server = createServer((req, res) => {
    const valid = req.headers.authorization === 'Bearer fixture-token' && (!requireTenant || req.headers['x-scope-orgid'] === 'fixture-tenant');
    req.resume();
    res.setHeader('connection', 'close');
    if (!valid) { res.writeHead(401); res.end('configured authentication required'); return; }
    if (req.method === 'POST') { res.writeHead(204); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'success', data: { result: [{ stream: { job: 'ninedeploy' }, values: [['1770000000000000000', 'hello']] }] } }));
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cases = [
    { label: 'plain control', key: 'fixture-token', tenant: false },
    { label: 'prefixed token', key: 'Bearer fixture-token', tenant: false },
    { label: 'tenant header', key: 'fixture-token', tenant: true },
  ];
  try {
    const results: Array<{ label: string; push: boolean; query: boolean }> = [];
    for (const entry of cases) {
      requireTenant = entry.tenant;
      const headers = entry.tenant ? { 'X-Scope-OrgID': 'fixture-tenant' } : {};
      const drain = { id: 1, name: 'fixture', type: 'loki', enabled: true, url: `${base}/loki/api/v1/push`, apiKeyEncrypted: entry.key, headersJson: JSON.stringify(headers), serviceId: null };
      const pushed = await dispatchLogToDrain({ url: drain.url, type: 'loki', format: 'json', apiKey: entry.key, headers }, { service: 'fixture', container: 'fixture', line: 'hello', timestamp: '2026-11-09T00:00:00Z' }, fetch);
      expect(pushed.ok, entry.label).toBe(true);
      const db = { query: { logDrains: { findMany: async () => [drain] } } } as never;
      let query = false;
      try { query = (await searchLogs(db, { query: 'hello' })).lines.length === 1; } catch { /* observed upstream refusal */ }
      results.push({ label: entry.label, push: pushed.ok, query });
    }
    expect(results[0]?.query).toBe(true);
    console.log('CONTROL EXPECTED: plain token push/query accepted | ACTUAL:', results[0]);
    console.log('EXPECTED: search reuses each successful drain auth context | ACTUAL:', results);
    console.log(results.every(result => result.query) ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
    expect(results.every(result => result.query)).toBe(true);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
