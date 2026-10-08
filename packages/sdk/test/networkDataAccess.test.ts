import { describe, expect, it, vi } from 'vitest';
import { createClient, DATABASE_IMPORT_FINISHED_STATUSES, NineDeployError, type DatabaseImport } from '../src/index.js';

/**
 * 0.14 surfaces: public database access, dump imports (chunked upload,
 * resume, polling), backup-destination objects, the Traefik custom config and
 * certificates, and the Vault / AWS secret providers.
 */

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; body?: unknown };

function client(respond: (call: Call) => Reply | undefined = () => undefined) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    const raw = init.body;
    const call: Call = {
      url: url.replace(/^https?:\/\/[^/]+/, ''),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: raw instanceof Uint8Array ? raw : typeof raw === 'string' ? JSON.parse(raw) : undefined,
    };
    calls.push(call);
    const reply = respond(call) ?? {};
    const status = reply.status ?? 200;
    const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
    return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
  });
  return { api: createClient({ baseUrl: 'http://api.test', fetch: fetchMock }), calls };
}

const strip = (c: Call) => ({ method: c.method, url: c.url, body: c.body });

describe('0.14 route mapping', () => {
  it('maps public access, imports, objects, custom config, certificates and secret providers', async () => {
    const { api, calls } = client();
    const pem = { name: 'wild', certPem: 'C', keyPem: 'K' };
    const cases: Array<[() => Promise<unknown>, string, string, unknown]> = [
      [() => api.databases.publicAccess.get(4), 'GET', '/v1/databases/4/public-access', undefined],
      [
        () => api.databases.publicAccess.set(4, { enabled: true, port: 15432, ipAllowlist: ['203.0.113.0/24'], tlsMode: 'none' }),
        'PUT',
        '/v1/databases/4/public-access',
        { enabled: true, port: 15432, ipAllowlist: ['203.0.113.0/24'], tlsMode: 'none' },
      ],
      [() => api.databases.publicAccess.disable(4), 'DELETE', '/v1/databases/4/public-access', undefined],
      [
        () => api.databases.imports.create(4, { source: 's3', destinationId: 2, key: 'b/x.dump' }),
        'POST',
        '/v1/databases/4/imports',
        { source: 's3', destinationId: 2, key: 'b/x.dump' },
      ],
      [() => api.databases.imports.start(4, 9), 'POST', '/v1/databases/4/imports/9/start', undefined],
      [() => api.databases.imports.list(4), 'GET', '/v1/databases/4/imports', undefined],
      [() => api.databases.imports.get(4, 9), 'GET', '/v1/databases/4/imports/9', undefined],
      [() => api.databases.imports.cancel(4, 9), 'DELETE', '/v1/databases/4/imports/9', undefined],
      [() => api.databases.credentials(4), 'GET', '/v1/databases/4/credentials', undefined],
      [() => api.backupDestinations.objects(2), 'GET', '/v1/backup-destinations/2/objects', undefined],
      [() => api.backupDestinations.objects(2, 'db/a b'), 'GET', '/v1/backup-destinations/2/objects?prefix=db%2Fa%20b', undefined],
      [() => api.traefik.customConfig.get(), 'GET', '/v1/traefik/custom-config', undefined],
      [() => api.traefik.customConfig.validate('http: {}'), 'POST', '/v1/traefik/custom-config/validate', { content: 'http: {}' }],
      [() => api.traefik.customConfig.set('http: {}'), 'PUT', '/v1/traefik/custom-config', { content: 'http: {}' }],
      [() => api.traefik.customConfig.clear(), 'DELETE', '/v1/traefik/custom-config', undefined],
      [() => api.traefik.customCertificates.list(), 'GET', '/v1/traefik/certificates/custom', undefined],
      [() => api.traefik.customCertificates.upload(pem), 'POST', '/v1/traefik/certificates/custom', pem],
      [() => api.traefik.customCertificates.replace(5, pem), 'PUT', '/v1/traefik/certificates/custom/5', pem],
      [() => api.traefik.customCertificates.delete(5), 'DELETE', '/v1/traefik/certificates/custom/5', undefined],
      [() => api.settings.secretProviders.list(), 'GET', '/v1/settings/secret-providers', undefined],
      [
        () => api.settings.secretProviders.set('vault', { config: { address: 'https://vault.example', authMethod: 'token' }, credentials: { token: 't' } }),
        'PUT',
        '/v1/settings/secret-providers/vault',
        { config: { address: 'https://vault.example', authMethod: 'token' }, credentials: { token: 't' } },
      ],
      [
        () => api.settings.secretProviders.set('aws', { config: { region: 'eu-west-1' } }),
        'PUT',
        '/v1/settings/secret-providers/aws',
        { config: { region: 'eu-west-1' } },
      ],
      [() => api.settings.secretProviders.delete('aws'), 'DELETE', '/v1/settings/secret-providers/aws', undefined],
      [() => api.settings.secretProviders.test('vault'), 'POST', '/v1/settings/secret-providers/vault/test', {}],
      [
        () => api.settings.secretProviders.test('aws', { probeSecretId: 'prod/db' }),
        'POST',
        '/v1/settings/secret-providers/aws/test',
        { probeSecretId: 'prod/db' },
      ],
    ];
    for (const [run, method, url, body] of cases) {
      await run();
      expect(strip(calls[calls.length - 1]!)).toEqual({ method, url, body });
    }
  });

  it('sends a chunk as a raw octet-stream body', async () => {
    const { api, calls } = client();
    const chunk = new Uint8Array([1, 2, 3]);
    await api.databases.imports.uploadChunk(4, 9, 2, chunk);
    const call = calls[0]!;
    expect(call).toMatchObject({ method: 'PUT', url: '/v1/databases/4/imports/9/chunks/2' });
    expect(call.headers['Content-Type']).toBe('application/octet-stream');
    expect(call.body).toBe(chunk);
  });

  it('keeps the custom-config refusal findings as error details', async () => {
    const issue = { path: 'http.routers.a', message: 'name must start with custom-' };
    const { api } = client(({ url }) =>
      url.endsWith('custom-config')
        ? { status: 400, body: { error: { code: 'invalid_custom_config', message: 'bad' }, errors: [issue], warnings: [issue] } }
        : undefined,
    );
    const err = await api.traefik.customConfig.set('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NineDeployError);
    expect(err).toMatchObject({ status: 400, code: 'invalid_custom_config', message: 'bad', details: { errors: [issue], warnings: [issue] } });
  });

  it('defaults missing warnings to [] and leaves a plain error envelope alone', async () => {
    let body: unknown = { error: { code: 'custom_config_rejected', message: 'reverted' }, errors: [{ path: '', message: 'm' }] };
    const { api } = client(() => ({ status: 422, body }));
    await expect(api.traefik.customConfig.set('x')).rejects.toMatchObject({ details: { errors: [{ path: '', message: 'm' }], warnings: [] } });
    body = { error: { code: 'traefik_validation_unavailable', message: 'unavailable' } };
    await expect(api.traefik.customConfig.set('x')).rejects.toMatchObject({ code: 'traefik_validation_unavailable', details: undefined });
    // Other routes never lift top-level findings into details.
    body = { error: { code: 'x', message: 'y' }, errors: ['z'] };
    await expect(api.traefik.customConfig.validate('x')).rejects.toMatchObject({ code: 'x', details: undefined });
  });
});

// ── importFile ─────────────────────────────────────────────────────────────

const baseRow: DatabaseImport = {
  id: 9,
  databaseId: 4,
  source: 'upload',
  status: 'uploading',
  format: null,
  sizeBytes: 0,
  receivedBytes: 0,
  chunkSize: 4,
  sha256: null,
  filename: null,
  destinationId: null,
  objectKey: null,
  options: {},
  safetyBackupId: null,
  error: null,
  createdByUserId: 1,
  createdAt: '2026-10-08T00:00:00.000Z',
  updatedAt: '2026-10-08T00:00:00.000Z',
  startedAt: null,
  completedAt: null,
};

/** A fake import server: tracks received bytes; `statuses` drives the GET polls after start. */
function importServer(init: Partial<DatabaseImport>, statuses: DatabaseImport['status'][] = []) {
  const row: DatabaseImport = { ...baseRow, ...init };
  const received: number[] = [];
  const { api, calls } = client((call) => {
    if (call.method === 'POST' && call.url === '/v1/databases/4/imports') {
      const body = call.body as { sizeBytes: number };
      row.sizeBytes = body.sizeBytes;
      return { status: 201, body: row };
    }
    if (call.method === 'PUT' && call.url.includes('/chunks/')) {
      const bytes = call.body as Uint8Array;
      received.push(...bytes);
      row.receivedBytes += bytes.length;
      if (row.receivedBytes === row.sizeBytes) row.status = 'pending';
      return { body: row };
    }
    if (call.url.endsWith('/start')) {
      row.status = 'running';
      return { status: 202, body: row };
    }
    if (call.method === 'GET' && call.url === '/v1/databases/4/imports/9') {
      const next = statuses.shift();
      if (next) row.status = next;
      return { body: row };
    }
    return undefined;
  });
  return { api, calls, row, received };
}

async function* pieces(...parts: number[][]): AsyncIterable<Uint8Array> {
  for (const p of parts) yield new Uint8Array(p);
}

const chunkUrls = (calls: Call[]) => calls.filter((c) => c.url.includes('/chunks/')).map((c) => c.url.replace(/.*\/chunks\//, ''));

describe('databases.importFile', () => {
  it('uploads a Uint8Array in server-sized chunks, then starts it', async () => {
    const { api, calls, received } = importServer({});
    const created = vi.fn();
    const progress = vi.fn();
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const out = await api.databases.importFile(4, data, {
      filename: 'dump.sql',
      sha256: 'a'.repeat(64),
      options: { singleTransaction: false },
      onCreated: created,
      onProgress: progress,
    });
    expect(calls[0]!.body).toEqual({ source: 'upload', sizeBytes: 10, sha256: 'a'.repeat(64), filename: 'dump.sql', options: { singleTransaction: false } });
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }));
    expect(chunkUrls(calls)).toEqual(['0', '1', '2']);
    expect(received).toEqual([...data]);
    expect(progress.mock.calls.map(([p]) => p.receivedBytes)).toEqual([4, 8, 10]);
    expect(progress.mock.calls[2]![0]).toMatchObject({ sizeBytes: 10 });
    expect(out.status).toBe('running');
    expect(calls[calls.length - 1]).toMatchObject({ method: 'POST', url: '/v1/databases/4/imports/9/start' });
  });

  it('re-cuts an async iterable whose pieces do not match the chunk size (exact multiple, no callbacks)', async () => {
    const { api, calls, received } = importServer({});
    await api.databases.importFile(4, pieces([1, 2, 3], [4, 5], [], [6, 7, 8]), { sizeBytes: 8 });
    expect(calls[0]!.body).toEqual({ source: 'upload', sizeBytes: 8 });
    expect(chunkUrls(calls)).toEqual(['0', '1']);
    expect(received).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('requires sizeBytes for a streamed import', async () => {
    const { api, calls } = importServer({});
    await expect(api.databases.importFile(4, pieces([1]))).rejects.toMatchObject({ code: 'import_size_required' });
    expect(calls).toEqual([]);
  });

  it('refuses a stream longer or shorter than declared', async () => {
    let s = importServer({});
    await expect(api(s).databases.importFile(4, pieces([1, 2, 3, 4, 5, 6]), { sizeBytes: 5 })).rejects.toMatchObject({
      code: 'import_size_mismatch',
      message: expect.stringContaining('larger'),
    });
    // The first full chunk landed; the overflowing one never left the client.
    expect(chunkUrls(s.calls)).toEqual(['0']);
    s = importServer({});
    await expect(api(s).databases.importFile(4, pieces([1, 2]), { sizeBytes: 5 })).rejects.toMatchObject({
      code: 'import_size_mismatch',
      message: expect.stringContaining('smaller'),
    });
    expect(s.calls.some((c) => c.url.endsWith('/start'))).toBe(false);
  });

  it('resumes an uploading import from receivedBytes, skipping what the server holds', async () => {
    const s = importServer({ sizeBytes: 10, receivedBytes: 4 });
    await s.api.databases.importFile(4, pieces([1, 2], [3, 4, 5], [6, 7, 8, 9, 10]), { resumeImportId: 9, sizeBytes: 10 });
    expect(s.calls[0]).toMatchObject({ method: 'GET', url: '/v1/databases/4/imports/9' });
    expect(chunkUrls(s.calls)).toEqual(['1', '2']);
    expect(s.received).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it('resumes with a seekable factory and the server-recorded size', async () => {
    const s = importServer({ sizeBytes: 6, receivedBytes: 4 });
    const factory = vi.fn((offset: number) => pieces([1, 2, 3, 4, 5, 6].slice(offset)));
    await s.api.databases.importFile(4, factory, { resumeImportId: 9 });
    expect(factory).toHaveBeenCalledWith(4);
    expect(s.received).toEqual([5, 6]);
  });

  it('resumes a Uint8Array upload by slicing it', async () => {
    const s = importServer({ sizeBytes: 6, receivedBytes: 4 });
    await s.api.databases.importFile(4, new Uint8Array([1, 2, 3, 4, 5, 6]), { resumeImportId: 9 });
    expect(s.received).toEqual([5, 6]);
  });

  it('refuses to resume onto an import of a different size', async () => {
    const s = importServer({ sizeBytes: 6 });
    await expect(s.api.databases.importFile(4, new Uint8Array(4), { resumeImportId: 9 })).rejects.toMatchObject({
      code: 'import_size_mismatch',
      message: expect.stringContaining('smaller'),
    });
    await expect(s.api.databases.importFile(4, new Uint8Array(8), { resumeImportId: 9 })).rejects.toMatchObject({
      message: expect.stringContaining('larger'),
    });
  });

  it('starts a pending import without uploading, and refuses a finished one', async () => {
    let s = importServer({ sizeBytes: 4, receivedBytes: 4, status: 'pending' });
    const out = await s.api.databases.importFile(4, pieces([1, 2, 3, 4]), { resumeImportId: 9 });
    expect(chunkUrls(s.calls)).toEqual([]);
    expect(out.status).toBe('running');
    s = importServer({ sizeBytes: 4, status: 'failed' });
    await expect(s.api.databases.importFile(4, new Uint8Array(4), { resumeImportId: 9 })).rejects.toMatchObject({
      status: 409,
      code: 'import_not_resumable',
    });
  });

  it('stops after the upload when start is false', async () => {
    const s = importServer({});
    const out = await s.api.databases.importFile(4, new Uint8Array(3), { start: false });
    expect(out.status).toBe('pending');
    expect(s.calls.some((c) => c.url.endsWith('/start'))).toBe(false);
  });

  it('polls to completion with poll: true and with poll options', async () => {
    let s = importServer({}, ['completed']);
    await expect(s.api.databases.importFile(4, new Uint8Array(2), { poll: true })).resolves.toMatchObject({ status: 'completed' });
    s = importServer({}, ['running', 'failed']);
    const seen: string[] = [];
    const out = await s.api.databases.importFile(4, new Uint8Array(2), { poll: { intervalMs: 0, onStatus: (r) => seen.push(r.status) } });
    expect(out.status).toBe('failed');
    expect(seen).toEqual(['running', 'failed']);
  });
});

/** Read the client back off an importServer result (keeps the cases above short). */
function api(s: { api: ReturnType<typeof createClient> }) {
  return s.api;
}

describe('databases.imports.wait', () => {
  it('returns once an S3 download leaves uploading', async () => {
    const s = importServer({ source: 's3' }, ['uploading', 'pending']);
    const out = await s.api.databases.imports.wait(4, 9, { until: 'uploaded', intervalMs: 0 });
    expect(out.status).toBe('pending');
    expect(s.calls.length).toBe(2);
  });

  it('times out with a typed error', async () => {
    const s = importServer({ status: 'running' });
    await expect(s.api.databases.imports.wait(4, 9, { intervalMs: 5, timeoutMs: 1 })).rejects.toMatchObject({
      code: 'import_wait_timeout',
      message: 'Import 9 is still running',
    });
  });

  it('sleeps between polls when the deadline allows', async () => {
    const s = importServer({ status: 'running' }, ['running', 'completed_with_warnings']);
    await expect(s.api.databases.imports.wait(4, 9, { intervalMs: 1, timeoutMs: 60_000 })).resolves.toMatchObject({
      status: 'completed_with_warnings',
    });
  });

  it('lists every final status', () => {
    expect(DATABASE_IMPORT_FINISHED_STATUSES).toEqual(['completed', 'completed_with_warnings', 'failed', 'cancelled', 'expired']);
  });
});
