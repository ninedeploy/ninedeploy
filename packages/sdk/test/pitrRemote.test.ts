import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

describe('operator remote PITR client', () => {
  it('uses the mounted paths, sends configuration and polls checkpoint status', async () => {
    const fetch = vi.fn(async (_url: string, _init: { body?: string }) => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = createClient({ baseUrl: 'https://panel.example.test', getToken: () => 'operator-token', fetch });
    const body = { enabled: true, destinationId: 3, intervalMinutes: 15, passphrase: 'operator held passphrase', mode: 'continuous' as const, remoteRetentionDays: 7, collectOrphans: true, resetStream: true };
    await client.databases.pitr.remote.set(7, body);
    await client.databases.pitr.remote.checkpoint(7);
    await client.databases.pitr.remote.get(7);
    expect(fetch.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://panel.example.test/v1/databases/7/pitr/remote',
      'https://panel.example.test/v1/databases/7/pitr/remote/checkpoint',
      'https://panel.example.test/v1/databases/7/pitr/remote',
    ]);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual(body);
  });
});
