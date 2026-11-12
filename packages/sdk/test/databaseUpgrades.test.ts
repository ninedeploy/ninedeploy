import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

/** O2: the SDK surface of database major upgrades. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 4, databaseId: 9, engine: 'postgres', fromMajor: 16, toMajor: 18, previousVersion: '16', targetVersion: '18',
  previousVolume: 'nd-db-orders-data', targetVolume: 'nd-db-orders-data-u4', status: 'running', phase: 'dump',
  safetyBackupId: null, verification: null, error: null, createdAt: '2026-11-12T00:00:00.000Z', completedAt: null, rolledBackAt: null, finalizedAt: null,
  ...over,
});

function client(respond: (method: string, path: string, body: unknown) => unknown) {
  const calls: string[] = [];
  const api = createClient({
    baseUrl: 'https://panel.example',
    token: 't',
    fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push(`${method} ${path}${body !== undefined ? ` ${JSON.stringify(body)}` : ''}`);
      return new Response(JSON.stringify(respond(method, path, body)), { status: method === 'POST' && path.endsWith('/upgrades') ? 202 : 200 });
    }),
  });
  return { api, calls };
}

describe('databases.upgrades', () => {
  it('lists, reads options, starts, rolls back and finalizes on the documented paths', async () => {
    const { api, calls } = client((method, path) => {
      if (path.endsWith('/options')) return { databaseId: 9, currentMajor: 16, targets: [17, 18], refusal: null };
      if (path.endsWith('/finalize')) return { ...row({ status: 'finalized' }), removedVolume: 'nd-db-orders-data' };
      if (path.endsWith('/rollback')) return row({ status: 'rolled_back' });
      return method === 'POST' ? row() : [row()];
    });
    expect((await api.databases.upgrades.options(9)).targets).toEqual([17, 18]);
    expect((await api.databases.upgrades.start(9, { toMajor: 18 })).status).toBe('running');
    expect(await api.databases.upgrades.list(9)).toHaveLength(1);
    expect((await api.databases.upgrades.rollback(9, 4)).status).toBe('rolled_back');
    expect((await api.databases.upgrades.finalize(9, 4)).removedVolume).toBe('nd-db-orders-data');
    expect(calls).toEqual([
      'GET /v1/databases/9/upgrades/options',
      'POST /v1/databases/9/upgrades {"toMajor":18}',
      'GET /v1/databases/9/upgrades',
      'POST /v1/databases/9/upgrades/4/rollback {}',
      'POST /v1/databases/9/upgrades/4/finalize {}',
    ]);
  });

  it('wait polls until the upgrade leaves running', async () => {
    let n = 0;
    const { api } = client(() => [row({ status: ++n < 3 ? 'running' : 'completed', phase: n < 3 ? 'restore' : null })]);
    const done = await api.databases.upgrades.wait(9, 4, { intervalMs: 1 });
    expect(done.status).toBe('completed');
    expect(n).toBe(3);
  });

  it('wait fails for an unknown upgrade and when the time is up', async () => {
    const { api } = client(() => [row()]);
    await expect(api.databases.upgrades.wait(9, 5, { intervalMs: 1 })).rejects.toThrow('upgrade 5 of database 9 not found');
    await expect(api.databases.upgrades.wait(9, 4, { intervalMs: 1, timeoutMs: 0 })).rejects.toThrow('still running (phase dump)');
    const { api: noPhase } = client(() => [row({ phase: null })]);
    await expect(noPhase.databases.upgrades.wait(9, 4, { timeoutMs: 0 })).rejects.toThrow('(phase unknown)');
  });
});
