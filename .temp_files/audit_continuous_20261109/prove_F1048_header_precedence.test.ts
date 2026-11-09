import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
vi.mock('../../apps/server/src/lib/crypto.js', () => ({ decrypt: (value: string) => value }));
import { dispatchLogToDrain } from '../../apps/server/src/engine/logDrainManager.js';
import { searchLogs } from '../../apps/server/src/lib/logSearch.js';
it('applies identical HTTP header precedence for differently cased names', async () => {
  let expectedType = 'application/json';
  const server = createServer((req, res) => {
    req.resume(); res.setHeader('connection', 'close');
    const valid = req.headers.authorization === 'Bearer fixture-token' && (req.method === 'GET' || req.headers['content-type'] === expectedType);
    if (!valid) { res.writeHead(401); res.end('header precedence mismatch'); return; }
    if (req.method === 'POST') { res.writeHead(204); res.end(); return; }
    res.end(JSON.stringify({ status: 'success', data: { result: [] } }));
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/loki/api/v1/push`;
  const entry = { service: 'fixture', container: 'fixture', timestamp: '2026-11-09T00:00:00Z', line: 'fixture' };
  try {
    const results: Array<{ label: string; pushed: boolean; queried: boolean }> = [];
    for (const lower of [false, true]) {
      expectedType = 'application/x-ndjson';
      const headers = lower ? { authorization: 'Basic replaced', 'content-type': expectedType } : { Authorization: 'Basic replaced', 'Content-Type': expectedType };
      const pushed = await dispatchLogToDrain({ url, type: 'loki', format: 'json', apiKey: 'fixture-token', headers }, entry, fetch);
      const drain = { id: 1, name: 'fixture', type: 'loki', enabled: true, url, apiKeyEncrypted: 'fixture-token', headersJson: JSON.stringify(headers) };
      const db = { query: { logDrains: { findMany: async () => [drain] } } } as never;
      let queried = false;
      try { queried = !(await searchLogs(db, { query: 'fixture' })).unsupported; } catch { /* upstream refused */ }
      results.push({ label: lower ? 'lowercase' : 'canonical control', pushed: pushed.ok, queried });
    }
    expect(results[0]).toMatchObject({ pushed: true, queried: true });
    console.log('CONTROL EXPECTED: canonical header names accepted | ACTUAL:', results[0]);
    console.log('EXPECTED: casing does not change precedence | ACTUAL:', results[1]);
    console.log(results[1]?.pushed && results[1]?.queried ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
    expect(results[1]).toMatchObject({ pushed: true, queried: true });
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
