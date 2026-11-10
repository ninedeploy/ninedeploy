import { describe, expect, it, vi } from 'vitest';
import { createClient, NineDeployError, VOLUME_IMPORT_FINISHED_STATUSES, type VolumeImport } from '../src/index.js';

/** A1: service volume imports — route mapping, the chunked upload with a required sha256, polling. */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function client(respond: (call: Call) => { status?: number; body?: unknown } | undefined = () => undefined) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: { method?: string; body?: unknown }) => {
    const raw = init.body;
    const call: Call = {
      url: url.replace(/^https?:\/\/[^/]+/, ''),
      method: init.method ?? 'GET',
      body: raw instanceof Uint8Array ? Array.from(raw) : typeof raw === 'string' ? JSON.parse(raw) : undefined,
    };
    calls.push(call);
    const reply = respond(call) ?? {};
    const status = reply.status ?? 200;
    const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
    return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
  });
  return { api: createClient({ baseUrl: 'http://api.test', fetch: fetchMock }), calls };
}

const row = (over: Partial<VolumeImport> = {}): VolumeImport => ({
  id: 9, serviceId: 3, volumeName: 'nd-svc-shop-data', status: 'uploading', sizeBytes: 5, receivedBytes: 0, chunkSize: 2,
  sha256: 'a'.repeat(64), filename: null, safetyBackupId: null, error: null, createdByUserId: 1,
  createdAt: '', updatedAt: '', startedAt: null, completedAt: null, ...over,
});

describe('volumeImports', () => {
  it('maps list, get, cancel, start and wait onto /v1/services/:id/volume-imports', async () => {
    let polls = 0;
    const { api, calls } = client((c) => {
      if (c.method === 'GET' && c.url === '/v1/services/3/volume-imports/9') return { body: row({ status: ++polls > 1 ? 'completed' : 'running' }) };
      return { body: c.url.endsWith('volume-imports') ? [row()] : row() };
    });
    await api.volumeImports.list(3);
    await api.volumeImports.cancel(3, 9);
    await api.volumeImports.start(3, 9);
    const seen: string[] = [];
    const done = await api.volumeImports.wait(3, 9, { intervalMs: 1, onStatus: (r) => seen.push(r.status) });
    expect(done.status).toBe('completed');
    expect(seen).toEqual(['running', 'completed']);
    expect(calls.slice(0, 3).map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /v1/services/3/volume-imports',
      'DELETE /v1/services/3/volume-imports/9',
      'POST /v1/services/3/volume-imports/9/start',
    ]);
    expect(VOLUME_IMPORT_FINISHED_STATUSES).toEqual(['completed', 'failed', 'cancelled', 'expired']);
    expect((await api.volumeImports.get(3, 9)).id).toBe(9);
  });

  it('creates with the sha256, uploads ordered chunks, starts', async () => {
    let received = 0;
    const { api, calls } = client((c) => {
      if (c.method === 'POST' && c.url === '/v1/services/3/volume-imports') return { status: 201, body: row() };
      if (c.method === 'PUT') {
        received += (c.body as number[]).length;
        return { body: row({ receivedBytes: received, status: received === 5 ? 'pending' : 'uploading' }) };
      }
      return { status: 202, body: row({ status: 'running', receivedBytes: 5 }) };
    });
    const created: number[] = [];
    const out = await api.volumeImports.importFile(3, new Uint8Array([1, 2, 3, 4, 5]), { sha256: 'a'.repeat(64), filename: 'shop.tar.gz', onCreated: (r) => created.push(r.id) });
    expect(out.status).toBe('running');
    expect(created).toEqual([9]);
    expect(calls[0]!.body).toEqual({ sizeBytes: 5, sha256: 'a'.repeat(64), filename: 'shop.tar.gz' });
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.url)).toEqual([
      '/v1/services/3/volume-imports/9/chunks/0', '/v1/services/3/volume-imports/9/chunks/1', '/v1/services/3/volume-imports/9/chunks/2',
    ]);
    const bare = await client((c) => (c.method === 'POST' ? { status: 201, body: row({ sizeBytes: 1 }) } : { body: row({ status: 'pending', sizeBytes: 1, receivedBytes: 1 }) }))
      .api.volumeImports.importFile(3, new Uint8Array([1]), { sha256: 'b'.repeat(64), start: false });
    expect(bare.status).toBe('pending');
  });

  it('refuses to create without a sha256', async () => {
    const { api, calls } = client();
    const err = await api.volumeImports.importFile(3, new Uint8Array([1])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NineDeployError);
    expect((err as NineDeployError).code).toBe('import_sha256_required');
    expect(calls).toHaveLength(0);
  });
});
