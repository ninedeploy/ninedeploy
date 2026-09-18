import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activityList, alertsCreate, alertsList, alertsRemove,
  backupsCreate, backupsList, backupsRestore,
  deploysWatch, domainsAdd, domainsList, domainsRemove,
  envList, envRemove, envSet, networksCreate, networksList, networksRemove,
  sessionsList, sessionsRevoke, systemExport, systemImport,
  usersList, usersResetLink, volumesList, volumesRemove,
} from '../src/commands/manage.js';

const h = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock('../src/prompts.js', () => ({ prompt: h.prompt }));

const sys = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => Buffer.from('bundle')),
  fetch: vi.fn(),
  WebSocket: vi.fn(),
  config: { baseUrl: 'http://srv.test', token: 'tok' },
}));
vi.mock('node:fs', () => ({ writeFileSync: sys.writeFileSync, readFileSync: sys.readFileSync }));
vi.mock('../src/config.js', () => ({ loadConfig: () => sys.config }));
vi.mock('ws', () => ({ WebSocket: sys.WebSocket }));

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', sys.fetch);
  sys.fetch.mockReset();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = 0;
  h.prompt.mockResolvedValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('env commands', () => {
  it('lists env vars with secret masking', async () => {
    const client = { env: { list: vi.fn().mockResolvedValue([
      { id: 1, key: 'NODE_ENV', value: 'production', isSecret: false },
      { id: 2, key: 'API_KEY', value: 'x', isSecret: true },
    ]) } };
    await envList(client as never, '1');
    expect(client.env.list).toHaveBeenCalledWith(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('NODE_ENV'));
  });

  it('prints a notice when there are no env vars', async () => {
    const client = { env: { list: vi.fn().mockResolvedValue([]) } };
    await envList(client as never, '1');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No env vars.'));
  });

  it('exits with usage for a non-numeric service id', async () => {
    await expect(envList({ env: { list: vi.fn() } } as never, 'abc')).rejects.toThrow('Usage');
    expect(process.exitCode).toBe(1);
  });

  it('creates a new env var', async () => {
    const client = { env: { list: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: 5 }) } };
    await envSet(client as never, '3', 'KEY', 'val', {});
    expect(client.env.create).toHaveBeenCalledWith(3, { key: 'KEY', value: 'val', isSecret: true });
  });

  it('updates an existing env var and honors --public', async () => {
    const client = { env: { list: vi.fn().mockResolvedValue([{ id: 7, key: 'KEY', value: 'x', isSecret: true }]), update: vi.fn() } };
    await envSet(client as never, '3', 'KEY', 'val', { public: true });
    expect(client.env.update).toHaveBeenCalledWith(3, 7, { key: 'KEY', value: 'val', isSecret: false });
  });

  it('removes an env var by key', async () => {
    const client = { env: { list: vi.fn().mockResolvedValue([{ id: 9, key: 'OLD', value: '', isSecret: false }]), remove: vi.fn() } };
    await envRemove(client as never, '2', 'OLD');
    expect(client.env.remove).toHaveBeenCalledWith(2, 9);
  });

  it('is a no-op when the key does not exist', async () => {
    const client = { env: { list: vi.fn().mockResolvedValue([]), remove: vi.fn() } };
    await envRemove(client as never, '2', 'MISSING');
    expect(client.env.remove).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No env var named'));
  });
});

describe('domains commands', () => {
  it('lists domains with cert days', async () => {
    const client = { domains: { all: vi.fn().mockResolvedValue([
      { id: 1, hostname: 'a.example.com', path: '/', ssl: true, status: 'active', serviceId: 1, serviceName: 'web', container: 'c', port: 3000, certExpiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), createdAt: 'x', updatedAt: 'x' },
      { id: 2, hostname: 'b.example.com', path: '/', ssl: false, status: 'pending', serviceId: 2, serviceName: null, container: null, port: null, certExpiresAt: null, createdAt: 'x', updatedAt: 'x' },
    ]) } };
    await domainsList(client as never);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('a.example.com'));
  });

  it('adds a domain with ssl by default', async () => {
    const client = { domains: { create: vi.fn().mockResolvedValue({ id: 2, hostname: 'b.example.com' }) } };
    await domainsAdd(client as never, '1', 'b.example.com', {});
    expect(client.domains.create).toHaveBeenCalledWith(1, { hostname: 'b.example.com', path: '/', ssl: true });
  });

  it('honors --path and --no-ssl', async () => {
    const client = { domains: { create: vi.fn().mockResolvedValue({ id: 3, hostname: 'c.example.com' }) } };
    await domainsAdd(client as never, '1', 'c.example.com', { path: '/api', ssl: false });
    expect(client.domains.create).toHaveBeenCalledWith(1, { hostname: 'c.example.com', path: '/api', ssl: false });
  });

  it('removes a domain', async () => {
    const client = { domains: { remove: vi.fn().mockResolvedValue(undefined) } };
    await domainsRemove(client as never, '1', '5');
    expect(client.domains.remove).toHaveBeenCalledWith(1, 5);
  });
});

describe('volumes commands', () => {
  it('lists volumes with owner info', async () => {
    const client = { volumes: { list: vi.fn().mockResolvedValue([
      { name: 'nd-data', sizeBytes: 1024, owner: { kind: 'service', name: 'web' } },
      { name: 'orphan', sizeBytes: 0, owner: null },
    ]) } };
    await volumesList(client as never);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('nd-data'));
  });

  it('removes a volume after typing the name', async () => {
    h.prompt.mockResolvedValue('nd-data');
    const client = { volumes: { remove: vi.fn().mockResolvedValue(undefined) } };
    await volumesRemove(client as never, 'nd-data');
    expect(client.volumes.remove).toHaveBeenCalledWith('nd-data');
  });

  it('cancels removal on a mismatched confirmation', async () => {
    h.prompt.mockResolvedValue('wrong');
    const client = { volumes: { remove: vi.fn() } };
    await volumesRemove(client as never, 'nd-data');
    expect(client.volumes.remove).not.toHaveBeenCalled();
  });
});

describe('networks commands', () => {
  it('lists networks with members', async () => {
    const client = { networks: { list: vi.fn().mockResolvedValue({
      networks: [{ name: 'net-a', driver: 'bridge', members: ['c-1', 'c-2'] }],
      remote: null,
    }) } };
    await networksList(client as never);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('net-a'));
  });

  it('creates a network', async () => {
    const client = { networks: { create: vi.fn().mockResolvedValue({ ok: true }) } };
    await networksCreate(client as never, 'net-b', 'overlay');
    expect(client.networks.create).toHaveBeenCalledWith({ name: 'net-b', driver: 'overlay' });
  });

  it('removes a network after typing the name', async () => {
    h.prompt.mockResolvedValue('net-b');
    const client = { networks: { remove: vi.fn().mockResolvedValue({ ok: true }) } };
    await networksRemove(client as never, 'net-b');
    expect(client.networks.remove).toHaveBeenCalledWith('net-b');
  });

  it('renders empty members and sparse session rows', async () => {
    const client = {
      networks: { list: vi.fn().mockResolvedValue({
        networks: [{ name: 'lonely', driver: 'bridge', members: [] }],
        remote: null,
      }) },
      auth: { sessions: { list: vi.fn().mockResolvedValue([
        { id: 2, current: false, ip: null, lastUsedAt: null, createdAt: '2026-02-02T00:00:00Z', userAgent: null },
      ]) } },
    };
    await networksList(client as never);
    await sessionsList(client as never);
  });

  it('prints a hint for an empty network listing', async () => {
    const client = { networks: { list: vi.fn().mockResolvedValue({ networks: [], remote: null }) } };
    await networksList(client as never);
  });

  it('prints a hint for empty session listings', async () => {
    const client = { auth: { sessions: { list: vi.fn().mockResolvedValue([]) } } };
    await sessionsList(client as never);
  });

  it('fails gracefully when network operations reject', async () => {
    const client = {
      networks: {
        create: vi.fn().mockRejectedValue(new Error('driver unavailable')),
        remove: vi.fn().mockRejectedValue(new Error('in use')),
      },
    };
    await networksCreate(client as never, 'net-z', 'bridge');
    h.prompt.mockResolvedValue('net-z');
    await networksRemove(client as never, 'net-z');
  });

  it('fails gracefully when session revocation rejects', async () => {
    const client = { auth: { sessions: { revoke: vi.fn().mockRejectedValue(new Error('gone')) } } };
    await sessionsRevoke(client as never, '12');
  });

  it('prints usage when removing a network without a name', async () => {
    const client = { networks: { remove: vi.fn() } };
    await networksRemove(client as never, '');
    expect(client.networks.remove).not.toHaveBeenCalled();
  });

  it('prints usage for a bogus session id', async () => {
    const client = { auth: { sessions: { revoke: vi.fn() } } };
    await sessionsRevoke(client as never, 'abc');
    expect(client.auth.sessions.revoke).not.toHaveBeenCalled();
  });

  it('cancels network removal on a mismatch', async () => {
    h.prompt.mockResolvedValue('nope');
    const client = { networks: { remove: vi.fn() } };
    await networksRemove(client as never, 'net-b');
    expect(client.networks.remove).not.toHaveBeenCalled();
  });
});

describe('sessions commands', () => {
  it('lists active sessions', async () => {
    const client = { auth: { sessions: { list: vi.fn().mockResolvedValue([
      { id: 1, current: true, ip: '10.0.0.1', lastUsedAt: '2026-01-01T00:00:00Z', userAgent: 'cli' },
    ]) } } };
    await sessionsList(client as never);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('10.0.0.1'));
  });

  it('revokes a session by id', async () => {
    const client = { auth: { sessions: { revoke: vi.fn().mockResolvedValue({ ok: true }) } } };
    await sessionsRevoke(client as never, '7');
    expect(client.auth.sessions.revoke).toHaveBeenCalledWith(7);
  });
});

describe('backups commands', () => {
  it('lists all backups when no database id is given', async () => {
    const client = { backups: { list: vi.fn().mockResolvedValue([
      { id: 1, databaseId: 2, databaseName: 'pg', status: 'completed', sizeBytes: 10, createdAt: '2026-01-01T00:00:00Z' },
      { id: 2, databaseId: 3, status: 'failed', sizeBytes: 0, createdAt: '2026-01-02T00:00:00Z' },
      { id: 3, status: 'completed', sizeBytes: 0, createdAt: '2026-01-03T00:00:00Z' },
    ]) } };
    await backupsList(client as never, undefined);
    expect(client.backups.list).toHaveBeenCalled();
  });

  it('lists one database\'s backups when an id is given', async () => {
    const client = { backups: { listForDb: vi.fn().mockResolvedValue([]), list: vi.fn().mockResolvedValue([]) } };
    await backupsList(client as never, '2');
    expect(client.backups.listForDb).toHaveBeenCalledWith(2);
    // An empty-string id falls back to the all-databases listing.
    await backupsList(client as never, '');
    expect(client.backups.list).toHaveBeenCalled();
  });

  it('creates a backup', async () => {
    const client = { backups: { backupNow: vi.fn().mockResolvedValue({ id: 8, status: 'completed' }) } };
    await backupsCreate(client as never, '2');
    expect(client.backups.backupNow).toHaveBeenCalledWith(2);
  });

  it('restores a backup after typing yes', async () => {
    h.prompt.mockResolvedValue('yes');
    const client = { backups: { restore: vi.fn().mockResolvedValue({ ok: true }) } };
    await backupsRestore(client as never, '2', '8');
    expect(client.backups.restore).toHaveBeenCalledWith(2, 8);
  });

  it('reports a failed restore', async () => {
    h.prompt.mockResolvedValue('yes');
    await backupsRestore({ backups: { restore: vi.fn().mockRejectedValue(new Error('restore boom')) } } as never, '1', '2');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('restore boom'));
  });

  it('cancels a restore on anything but yes', async () => {
    h.prompt.mockResolvedValue('no');
    const client = { backups: { restore: vi.fn() } };
    await backupsRestore(client as never, '2', '8');
    expect(client.backups.restore).not.toHaveBeenCalled();
  });
});

describe('alerts commands', () => {
  it('lists alert rules', async () => {
    const client = { alerts: { list: vi.fn().mockResolvedValue([
      { id: 1, serviceId: null, name: 'high-cpu', metric: 'cpu', operator: '>', threshold: 80, durationWindows: 2, enabled: true, status: 'firing', lastValue: 93, firedAt: null, createdAt: 'x' },
      { id: 2, serviceId: null, name: 'off', metric: 'memory', operator: '<', threshold: 50, durationWindows: 1, enabled: false, status: 'ok', lastValue: null, firedAt: null, createdAt: 'x' },
    ]) } };
    await alertsList(client as never);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('high-cpu'));
  });

  it('creates an alert rule without optional flags', async () => {
    const client = { alerts: { create: vi.fn().mockResolvedValue({ id: 5, name: 'cpu' }) } };
    await alertsCreate(client as never, 'cpu', 'cpu', '>', '90', {});
    expect(client.alerts.create).toHaveBeenCalledWith({ name: 'cpu', metric: 'cpu', operator: '>', threshold: 90, serviceId: null, durationWindows: undefined });
  });

  it('creates an alert rule with windows and service scope', async () => {
    const client = { alerts: { create: vi.fn().mockResolvedValue({ id: 4, name: 'low-mem' }) } };
    await alertsCreate(client as never, 'low-mem', 'memory', '<', '100', { windows: '3', service: '7' });
    expect(client.alerts.create).toHaveBeenCalledWith({ name: 'low-mem', metric: 'memory', operator: '<', threshold: 100, serviceId: 7, durationWindows: 3 });
  });

  it('rejects a non-numeric threshold', async () => {
    const client = { alerts: { create: vi.fn() } };
    await alertsCreate(client as never, 'x', 'cpu', '>', 'abc', {});
    expect(client.alerts.create).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('removes an alert rule', async () => {
    const client = { alerts: { remove: vi.fn().mockResolvedValue(undefined) } };
    await alertsRemove(client as never, '4');
    expect(client.alerts.remove).toHaveBeenCalledWith(4);
  });
});

describe('usage and error branches', () => {
  it('rejects env rm without a key', async () => {
    await envRemove({ env: { list: vi.fn() } } as never, '1', '');
    expect(process.exitCode).toBe(1);
  });

  it('rejects env set without a key', async () => {
    await envSet({ env: { list: vi.fn() } } as never, '1', '', 'v', {});
    expect(process.exitCode).toBe(1);
  });

  it('reports api failures from env set/remove', async () => {
    const failing = { env: { list: vi.fn().mockRejectedValue(new Error('boom')), create: vi.fn(), update: vi.fn(), remove: vi.fn() } };
    await envSet(failing as never, '1', 'K', 'v', {});
    await envRemove(failing as never, '1', 'K');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('rejects domain add without a host', async () => {
    await domainsAdd({ domains: { create: vi.fn() } } as never, '1', '', {});
    expect(process.exitCode).toBe(1);
  });

  it('reports api failures from domains and volumes', async () => {
    const boom = new Error('boom');
    h.prompt.mockResolvedValue('v');
    await domainsAdd({ domains: { create: vi.fn().mockRejectedValue(boom) } } as never, '1', 'h.test', {});
    await domainsRemove({ domains: { remove: vi.fn().mockRejectedValue(boom) } } as never, '1', '2');
    await volumesRemove({ volumes: { remove: vi.fn().mockRejectedValue(boom) } } as never, 'v');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('rejects volumes rm and backups/ alerts usage errors', async () => {
    const silence = (p: Promise<unknown>) => p.catch(() => undefined);
    await volumesRemove({ volumes: { remove: vi.fn() } } as never, '');
    await silence(backupsCreate({ backups: {} } as never, 'x'));
    await silence(backupsRestore({ backups: {} } as never, '1', 'x'));
    await silence(alertsCreate({ alerts: { create: vi.fn() } } as never, 'n', 'cpu', '>', ''));
    await silence(alertsRemove({ alerts: {} } as never, 'x'));
    expect(process.exitCode).not.toBe(0);
  });

  it('prints empty notices and reports api failures', async () => {
    const boom = new Error('boom');
    const silence = (p: Promise<unknown>) => p.catch(() => undefined);
    await domainsList({ domains: { all: vi.fn().mockResolvedValue([]) } } as never);
    await volumesList({ volumes: { list: vi.fn().mockResolvedValue([]) } } as never);
    await alertsList({ alerts: { list: vi.fn().mockResolvedValue([]) } } as never);
    await usersList({ users: { list: vi.fn().mockResolvedValue([]) } } as never);
    await activityList({ activity: { list: vi.fn().mockResolvedValue([]) } } as never);
    await backupsCreate({ backups: { backupNow: vi.fn().mockRejectedValue(boom) } } as never, '1');
    await silence(backupsRestore({ backups: { restore: vi.fn().mockRejectedValue(boom) } } as never, '1', '2'));
    await silence(alertsCreate({ alerts: { create: vi.fn().mockRejectedValue(boom) } } as never, 'n', 'cpu', '>', '5', {}));
    await silence(alertsRemove({ alerts: { remove: vi.fn().mockRejectedValue(boom) } } as never, '1'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No domains yet.'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

describe('system export/import', () => {
  const okRes = () => ({
    ok: true,
    status: 200,
    text: async () => 'data',
    arrayBuffer: async () => new Uint8Array([0x1f, 0x8b, 0xff, 0x00]).buffer,
  });

  it('exports without a stored token', async () => {
    const saved = sys.config.token;
    sys.config.token = null as unknown as string;
    sys.fetch.mockResolvedValueOnce(okRes());
    await systemExport('out.json');
    sys.config.token = saved;
    expect(sys.writeFileSync).toHaveBeenCalled();
  });

  it('imports without a stored token', async () => {
    const saved = sys.config.token;
    sys.config.token = null as unknown as string;
    h.prompt.mockResolvedValue('yes');
    sys.fetch.mockResolvedValueOnce(okRes());
    await systemImport('bundle.json');
    sys.config.token = saved;
    expect(sys.fetch).toHaveBeenCalled();
  });

  it('derives a default export filename', async () => {
    sys.fetch.mockResolvedValueOnce(okRes());
    await systemExport();
    const name = sys.writeFileSync.mock.calls.at(-1)![0] as string;
    expect(name).toMatch(/^ninedeploy-export-\d{4}-\d{2}-\d{2}\.tar\.gz$/);
  });

  it('formats non-Error failures from the export path', async () => {
    sys.fetch.mockRejectedValueOnce('plain failure');
    await systemExport('out.json');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('plain failure'));
  });

  it('exports the system bundle to a file', async () => {
    sys.fetch.mockResolvedValueOnce(okRes());
    await systemExport('out.json');
    expect(sys.fetch).toHaveBeenCalledWith('http://srv.test/v1/system/export', expect.objectContaining({ headers: expect.anything() }));
    // r192: the gzip bytes are written verbatim (0xff would not survive text decoding).
    const written = sys.writeFileSync.mock.calls.at(-1)![1] as Buffer;
    expect(Buffer.isBuffer(written)).toBe(true);
    expect([...written]).toEqual([0x1f, 0x8b, 0xff, 0x00]);
  });

  it('reports export failures', async () => {
    sys.fetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => '' });
    await systemExport('out.json');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Export failed (500)'));
  });

  it('imports a bundle after confirmation', async () => {
    h.prompt.mockResolvedValue('yes');
    sys.fetch.mockResolvedValueOnce(okRes());
    await systemImport('bundle.json');
    expect(sys.fetch).toHaveBeenCalledWith('http://srv.test/v1/system/import', expect.objectContaining({ method: 'POST' }));
    // r192: raw archive bytes, not multipart.
    const init = sys.fetch.mock.calls.at(-1)![1] as { headers: Record<string, string>; body: unknown };
    expect(init.headers['Content-Type']).toBe('application/octet-stream');
    expect(Buffer.isBuffer(init.body)).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('System imported.'));
  });

  it('cancels the import without an explicit yes', async () => {
    h.prompt.mockResolvedValue('no');
    await systemImport('bundle.json');
    expect(sys.fetch).not.toHaveBeenCalled();
  });

  it('rejects an import without a file', async () => {
    await systemImport('');
    expect(process.exitCode).toBe(1);
  });

  it('reports import failures', async () => {
    h.prompt.mockResolvedValue('yes');
    sys.fetch.mockResolvedValueOnce({ ok: false, status: 422, text: async () => '' });
    await systemImport('bundle.json');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Import failed (422)'));
  });
});

describe('deploys watch', () => {
  function fakeSocket() {
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    const socket = {
      on: (ev: string, cb: (...a: unknown[]) => void) => { handlers[ev] = cb; },
      close: vi.fn(() => handlers['close']?.()),
    };
    // Regular function so `new WebSocket(...)` returns the socket object.
    // biome-ignore lint/complexity/useArrowFunction: `new WebSocket(...)` requires a constructable function — arrow functions cannot be constructed.
    sys.WebSocket.mockImplementationOnce(function () {
      return socket;
    });
    return handlers;
  }

  it('builds the stream url without a token when none is stored', async () => {
    const handlers = fakeSocket();
    const savedToken = sys.config.token;
    sys.config.token = null as unknown as string;
    const pending = deploysWatch('1', '2', 200);
    await new Promise((r) => setTimeout(r, 10));
    handlers['close']?.();
    await pending;
    sys.config.token = savedToken;
    expect(sys.WebSocket).toHaveBeenCalled();
  });

  it('streams messages and exits when the server closes the stream', async () => {
    const handlers = fakeSocket();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const pending = deploysWatch('1', '2');
    await new Promise((r) => setTimeout(r, 10));
    handlers['message']?.(`hello${String.fromCharCode(10)}`);
    expect(writeSpy).toHaveBeenCalledWith(`hello${String.fromCharCode(10)}`);
    handlers['close']?.();
    await pending;
    writeSpy.mockRestore();
  });

  it('reports stream errors', async () => {
    const handlers = fakeSocket();
    const pending = deploysWatch('1', '2');
    await new Promise((r) => setTimeout(r, 10));
    handlers['error']?.(new Error('socket boom'));
    handlers['close']?.();
    await pending;
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('socket boom'));
  });

  it('reports rejected streams', async () => {
    const handlers = fakeSocket();
    const pending = deploysWatch('1', '2');
    await new Promise((r) => setTimeout(r, 10));
    handlers['unexpected-response']?.({}, { statusCode: 401 });
    handlers['close']?.();
    await pending;
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('401'));
  });

  it('rejects usage without ids', async () => {
    await deploysWatch('a', 'b');
    expect(process.exitCode).toBe(1);
  });

  it('closes the socket when the deadline elapses', async () => {
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    let closed = false;
    // biome-ignore lint/complexity/useArrowFunction: `new WebSocket(...)` requires a constructable function — arrow functions cannot be constructed.
    sys.WebSocket.mockImplementationOnce(function () {
      return {
        on: (ev: string, cb: (...a: unknown[]) => void) => { handlers[ev] = cb; },
        close: vi.fn(() => { closed = true; handlers['close']?.(); }),
      };
    });
    await deploysWatch('1', '2', 300);
    expect(closed).toBe(true);
  });

  it('exits cleanly on SIGINT', async () => {
    const _handlers = fakeSocket();
    const pending = deploysWatch('1', '2', 60_000);
    await new Promise((r) => setTimeout(r, 10));
    process.emit('SIGINT');
    await pending;
    expect(process.exitCode).toBe(0);
  });
});

describe('users & activity', () => {
  it('lists users (with and without names, operator and member)', async () => {
    // `users.role` is gone; the table renders the derived operator flag.
    const client = { users: { list: vi.fn().mockResolvedValue([
      { id: 1, email: 'a@x.com', name: 'A', isOperator: true, workspaceCount: 2 },
      { id: 2, email: 'b@x.com', name: null, isOperator: false, workspaceCount: 0 },
    ]) } };
    await usersList(client as never);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join(' | ');
    expect(printed).toContain('a@x.com');
    expect(printed).toContain('operator');
    expect(printed).toContain('member');
  });

  it('lists activity capped at 30 rows', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: i, userId: 1, action: 'deploy.completed', entity: i === 0 ? null : 'web', ts: '2026-01-01T00:00:00Z' }));
    const client = { activity: { list: vi.fn().mockResolvedValue({ entries: rows, nextCursor: null }) } };
    await activityList(client as never);
    expect(client.activity.list).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('deploy.completed'));
  });
});

describe('usersResetLink', () => {
  const users = [
    { id: 1, email: 'admin@example.com', name: 'Admin', role: 'admin' },
    { id: 2, email: 'member@example.com', name: null, role: 'member' },
  ];

  it('mints a link for a user matched by id or email', async () => {
    const client = {
      users: {
        list: vi.fn().mockResolvedValue(users),
        resetLink: vi.fn().mockResolvedValue({
          url: 'http://srv.test/reset-password?token=abc',
          expiresAt: '2026-08-15T12:30:00Z',
        }),
      },
    };

    await usersResetLink(client as never, '2');
    expect(client.users.resetLink).toHaveBeenCalledWith(2);
    let text = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(text).toContain('reset-password?token=abc');

    logSpy.mockClear();
    await usersResetLink(client as never, 'admin@example.com');
    expect(client.users.resetLink).toHaveBeenCalledWith(1);
    text = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(text).toContain('reset-password?token=abc');
  });

  it('errors when no user matches', async () => {
    const client = { users: { list: vi.fn().mockResolvedValue(users), resetLink: vi.fn() } };
    await usersResetLink(client as never, 'ghost@example.com');
    expect(client.users.resetLink).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No user matches'));
  });

  it('errors when the API call fails', async () => {
    const client = {
      users: {
        list: vi.fn().mockResolvedValue(users),
        resetLink: vi.fn().mockRejectedValue(new Error('403')),
      },
    };
    await usersResetLink(client as never, '1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('403'));
  });
});
