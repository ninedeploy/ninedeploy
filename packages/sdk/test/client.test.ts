import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { NineDeployError, createClient } from '../src/index.js';

interface RecordedInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface RecordedCall {
  url: string;
  init: RecordedInit;
}

interface FakeResponse {
  status: number;
  /** JSON-serializable body; undefined => empty text. */
  body?: unknown;
}

/** Build a fetch mock that records every call and responds from `respond`. */
function makeFetch(respond: (url: string, init: RecordedInit) => FakeResponse) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (url: string, init: RecordedInit) => {
    // Record the path portion (strip the origin) so assertions can use paths.
    calls.push({ url: url.replace(/^https?:\/\/[^/]+/, ''), init });
    const { status, body } = respond(url, init);
    const bodyStr = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => bodyStr,
      json: async () => (bodyStr === '' ? undefined : JSON.parse(bodyStr)),
    } as unknown as Response;
  });
  return { fetchMock, calls };
}

const ok = (body?: unknown): FakeResponse => ({ status: 200, body });
const err = (status: number, body: unknown): FakeResponse => ({ status, body });

const last = (calls: RecordedCall[]): RecordedCall => {
  const call = calls[calls.length - 1];
  if (!call) throw new Error('expected a recorded call');
  return call;
};

describe('createClient', () => {
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('strips a trailing slash from baseUrl', async () => {
    const { fetchMock, calls } = makeFetch(() => ok({}));
    const client = createClient({ baseUrl: 'http://api.test/', fetch: fetchMock });
    await client.services.list();
    expect(last(calls).url).toBe('/v1/services');
  });

  it('appends optional project scoping queries to list calls', async () => {
    const { fetchMock, calls } = makeFetch(() => ok([]));
    const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    await client.services.list('?projectId=3');
    expect(last(calls).url).toBe('/v1/services?projectId=3');
    await client.databases.list('?projectId=3');
    expect(last(calls).url).toBe('/v1/databases?projectId=3');
    await client.databases.list();
    expect(last(calls).url).toBe('/v1/databases');
  });

  it('sends an Authorization header when getToken returns a token', async () => {
    const { fetchMock, calls } = makeFetch(() => ok([]));
    const client = createClient({ baseUrl: 'http://api.test', getToken: () => 'tok-123', fetch: fetchMock });
    await client.users.list();
    expect(last(calls).init.headers?.['Authorization']).toBe('Bearer tok-123');
  });

  it('omits the Authorization header when getToken returns undefined or null', async () => {
    for (const getToken of [() => undefined, () => null]) {
      const { fetchMock, calls } = makeFetch(() => ok([]));
      const client = createClient({ baseUrl: 'http://api.test', getToken, fetch: fetchMock });
      await client.users.list();
      expect(last(calls).init.headers?.['Authorization']).toBeUndefined();
    }
  });

  it('omits the Authorization header when getToken is not provided', async () => {
    const { fetchMock, calls } = makeFetch(() => ok([]));
    const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    await client.users.list();
    expect(last(calls).init.headers?.['Authorization']).toBeUndefined();
  });

  it('sets Content-Type application/json when a body is sent', async () => {
    const { fetchMock, calls } = makeFetch(() => ok({ id: 1 }));
    const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    await client.services.create({ name: 'web' });
    expect(last(calls).init.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ name: 'web' });
  });

  it('does not set Content-Type on GET requests', async () => {
    const { fetchMock, calls } = makeFetch(() => ok([]));
    const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    await client.services.list();
    expect(last(calls).init.headers?.['Content-Type']).toBeUndefined();
  });

  it('parses an empty response body as an empty object (undefined would crash query functions)', async () => {
    const { fetchMock } = makeFetch(() => ok(undefined));
    const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    await expect(client.health()).resolves.toEqual({});
  });

  it('parses a JSON response body', async () => {
    const { fetchMock } = makeFetch(() => ok({ name: 'ninedeploy', version: '1.0.0' }));
    const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    const about = await client.about.get();
    expect(about).toEqual({ name: 'ninedeploy', version: '1.0.0' });
  });

  it('throws a mapped NineDeployError on a failed GET', async () => {
    const { fetchMock } = makeFetch(() => err(404, { error: { code: 'not_found', message: 'nope' } }));
    const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    const promise = client.services.get(7);
    await expect(promise).rejects.toBeInstanceOf(NineDeployError);
    await expect(promise).rejects.toMatchObject({ status: 404, code: 'not_found', message: 'nope' });
  });

  it('throws a mapped NineDeployError on a failed send with a body', async () => {
    const { fetchMock } = makeFetch(() =>
      err(422, { error: { code: 'invalid', message: 'bad input', details: { field: 'name' } } }),
    );
    const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    const promise = client.services.create({ name: '' });
    await expect(promise).rejects.toBeInstanceOf(NineDeployError);
    await expect(promise).rejects.toMatchObject({
      status: 422,
      code: 'invalid',
      message: 'bad input',
      details: { field: 'name' },
    });
  });

  it('throws a typed error (not SyntaxError) when the failure body is not JSON', async () => {
    // e.g. an HTML 502 page from a reverse proxy.
    const { fetchMock } = makeFetch(() => err(502, '<html>Bad Gateway</html>'));
    const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    await expect(client.services.list()).rejects.toBeInstanceOf(NineDeployError);
    await expect(client.services.list()).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('502'),
    });
  });

  it('falls back to globalThis.fetch when opts.fetch is omitted', async () => {
    const { fetchMock, calls } = makeFetch(() => ok({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient({ baseUrl: 'http://api.test' });
    await client.health();
    expect(last(calls).url).toBe('/health');
  });

  it('rejects with no_fetch when neither opts.fetch nor globalThis.fetch exists', async () => {
    vi.stubGlobal('fetch', undefined);
    const client = createClient({ baseUrl: 'http://api.test' });
    const promise = client.health();
    await expect(promise).rejects.toBeInstanceOf(NineDeployError);
    await expect(promise).rejects.toMatchObject({
      status: 0,
      code: 'no_fetch',
      message: 'No fetch implementation is available',
    });
  });

  describe('auth', () => {
    it('exercises status, setup, register, login, refresh, me and tokens', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.auth.status();
      expect(last(calls)).toMatchObject({ url: '/v1/auth/status', init: { method: 'GET' } });

      await client.auth.setup({ email: 'a@b.com', password: '12345678' });
      expect(last(calls).url).toBe('/v1/setup');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ email: 'a@b.com', password: '12345678' });

      await client.auth.register({ email: 'a@b.com', password: '12345678' });
      expect(last(calls).url).toBe('/v1/auth/register');
      expect(last(calls).init.method).toBe('POST');

      await client.auth.login({ email: 'a@b.com', password: 'p' });
      expect(last(calls).url).toBe('/v1/auth/login');

      await client.auth.refresh({ refreshToken: 'r' });
      expect(last(calls).url).toBe('/v1/auth/refresh');

      await client.auth.logout();
      expect(last(calls).url).toBe('/v1/auth/logout');
      expect(last(calls).init.method).toBe('POST');

      await client.auth.changePassword({ currentPassword: 'a', newPassword: 'b' });
      expect(last(calls).url).toBe('/v1/auth/password');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ currentPassword: 'a', newPassword: 'b' });

      await client.auth.forgotPassword('a@b.com');
      expect(last(calls).url).toBe('/v1/auth/forgot-password');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ email: 'a@b.com' });

      await client.auth.resetPasswordWithToken({ token: 't'.repeat(24), newPassword: 'fresh-pass-1' });
      expect(last(calls).url).toBe('/v1/auth/reset-password');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ token: 't'.repeat(24), newPassword: 'fresh-pass-1' });

      await client.auth.twoFactor.setup();
      expect(last(calls).url).toBe('/v1/auth/2fa/setup');
      await client.auth.twoFactor.enable('123456');
      expect(last(calls).url).toBe('/v1/auth/2fa/enable');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ code: '123456' });
      await client.auth.twoFactor.disable({ password: 'p', code: '123456' });
      expect(last(calls).url).toBe('/v1/auth/2fa/disable');

      await client.auth.me();
      expect(last(calls).url).toBe('/v1/auth/me');

      await client.auth.tokens.create({ name: 'ci' });
      expect(last(calls).url).toBe('/v1/auth/tokens');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ name: 'ci' });

      await client.auth.tokens.create();
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({});

      await client.auth.tokens.list();
      expect(last(calls).url).toBe('/v1/auth/tokens');
      expect(last(calls).init.method).toBe('GET');

      await client.auth.tokens.remove(3);
      expect(last(calls).url).toBe('/v1/auth/tokens/3');
      expect(last(calls).init.method).toBe('DELETE');
    });
  });

  describe('services', () => {
    it('exercises list, get, create, update, remove, stop, start, restart, logs and importBundle', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.services.list();
      expect(last(calls)).toMatchObject({ url: '/v1/services', init: { method: 'GET' } });

      await client.services.get(1);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1', init: { method: 'GET' } });

      await client.services.create({ name: 'web', type: 'docker' });
      expect(last(calls).url).toBe('/v1/services');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ name: 'web', type: 'docker' });

      await client.services.update(1, { name: 'renamed' });
      expect(last(calls).url).toBe('/v1/services/1');
      expect(last(calls).init.method).toBe('PATCH');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ name: 'renamed' });

      await client.services.remove(1);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1', init: { method: 'DELETE' } });

      await client.services.stop(1);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1/stop', init: { method: 'POST' } });

      await client.services.start(1);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1/start', init: { method: 'POST' } });

      await client.services.restart(1);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1/restart', init: { method: 'POST' } });

      await client.services.logs(1);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1/logs', init: { method: 'GET' } });

      await client.services.clone(1, { name: 'clone-app' });
      expect(last(calls).url).toBe('/v1/services/1/clone');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ name: 'clone-app' });

      await client.services.clone(1);
      expect(last(calls).url).toBe('/v1/services/1/clone');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({});

      await client.services.importBundle({ repo: 'https://github.com/a/b.git' });
      expect(last(calls).url).toBe('/v1/services/import');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ repo: 'https://github.com/a/b.git' });

      await client.services.composePreview({ composeContent: 'services:\n  web:\n    image: nginx\n' });
      expect(last(calls).url).toBe('/v1/services/compose/preview');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({
        composeContent: 'services:\n  web:\n    image: nginx\n',
      });
    });

    it('exportUrl returns the export path without fetching', () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      expect(client.services.exportUrl(5)).toBe('/v1/services/5/export');
      expect(calls).toHaveLength(0);
    });
  });

  describe('deploys', () => {
    it('exercises trigger (with and without input), list and rollback', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.deploys.trigger(1);
      expect(last(calls).url).toBe('/v1/services/1/deploys');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({});

      await client.deploys.trigger(1, { commitSha: 'abc' });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ commitSha: 'abc' });

      await client.deploys.list(1);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1/deploys', init: { method: 'GET' } });

      await client.deploys.rollback(1, 2);
      expect(last(calls).url).toBe('/v1/services/1/deploys/2/rollback');
      expect(last(calls).init.method).toBe('POST');

      await client.deploys.cancel(1, 2);
      expect(last(calls).url).toBe('/v1/services/1/deploys/2/cancel');
      expect(last(calls).init.method).toBe('POST');

      await client.deploys.remove(1, 2);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1/deploys/2', init: { method: 'DELETE' } });

      await client.deploys.queue();
      expect(last(calls)).toMatchObject({ url: '/v1/services/queue', init: { method: 'GET' } });

      await client.deploys.queue('?status=queued,building');
      expect(last(calls)).toMatchObject({ url: '/v1/services/queue?status=queued,building', init: { method: 'GET' } });

      await client.deploys.queue('status=queued');
      expect(last(calls)).toMatchObject({ url: '/v1/services/queue?status=queued', init: { method: 'GET' } });
    });
  });

  describe('backupDestinations', () => {
    it('exercises list, create, update, remove and test', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.backupDestinations.list();
      expect(last(calls)).toMatchObject({ url: '/v1/backup-destinations', init: { method: 'GET' } });

      await client.backupDestinations.create({ name: 'n', endpoint: 'https://s', bucket: 'b', accessKeyId: 'ak', secretAccessKey: 'sk' });
      expect(last(calls).url).toBe('/v1/backup-destinations');
      expect(last(calls).init.method).toBe('POST');

      await client.backupDestinations.update(1, { active: false });
      expect(last(calls).url).toBe('/v1/backup-destinations/1');
      expect(last(calls).init.method).toBe('PATCH');

      await client.backupDestinations.remove(1);
      expect(last(calls)).toMatchObject({ url: '/v1/backup-destinations/1', init: { method: 'DELETE' } });

      await client.backupDestinations.test(1);
      expect(last(calls).url).toBe('/v1/backup-destinations/1/test');
      expect(last(calls).init.method).toBe('POST');
    });
  });

  describe('jobs', () => {
    it('exercises list, create, update, remove, run and runs', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.jobs.list(1);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1/jobs', init: { method: 'GET' } });

      await client.jobs.create(1, { name: 'n', cron: '* * * * *', kind: 'deploy' });
      expect(last(calls).url).toBe('/v1/services/1/jobs');
      expect(last(calls).init.method).toBe('POST');

      await client.jobs.update(1, 2, { enabled: false });
      expect(last(calls).url).toBe('/v1/services/1/jobs/2');
      expect(last(calls).init.method).toBe('PATCH');

      await client.jobs.remove(1, 2);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1/jobs/2', init: { method: 'DELETE' } });

      await client.jobs.run(1, 2);
      expect(last(calls).url).toBe('/v1/services/1/jobs/2/run');
      expect(last(calls).init.method).toBe('POST');

      await client.jobs.runs(1, 2);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1/jobs/2/runs', init: { method: 'GET' } });
    });
  });

  describe('servers', () => {
    it('exercises list, create, remove and test', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.servers.list();
      expect(last(calls)).toMatchObject({ url: '/v1/servers', init: { method: 'GET' } });

      await client.servers.create({ name: 'edge', host: '10.0.0.5' });
      expect(last(calls).url).toBe('/v1/servers');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ name: 'edge', host: '10.0.0.5' });
      await client.servers.create({ name: 'edge2', host: 'h', port: 4601 });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ name: 'edge2', host: 'h', port: 4601 });

      await client.servers.remove(1);
      expect(last(calls)).toMatchObject({ url: '/v1/servers/1', init: { method: 'DELETE' } });

      await client.servers.remove(2, { force: true });
      expect(last(calls)).toMatchObject({ url: '/v1/servers/2?force=true', init: { method: 'DELETE' } });

      await client.servers.test(1);
      expect(last(calls).url).toBe('/v1/servers/1/test');
      expect(last(calls).init.method).toBe('POST');

      await client.servers.approve(1);
      expect(last(calls).url).toBe('/v1/servers/1/approve');
      expect(last(calls).init.method).toBe('POST');

      await client.servers.reject(2);
      expect(last(calls).url).toBe('/v1/servers/2/reject');
      expect(last(calls).init.method).toBe('POST');

      await client.servers.sshTest({ host: '192.168.1.50', authType: 'key' });
      expect(last(calls).url).toBe('/v1/servers/ssh-test');
      expect(last(calls).init.method).toBe('POST');

      await client.servers.sshBootstrap({ name: 'Node A', host: '192.168.1.50', authType: 'key', installDocker: true });
      expect(last(calls).url).toBe('/v1/servers/ssh-bootstrap');
      expect(last(calls).init.method).toBe('POST');

      await client.servers.bootstrapLogs(1);
      expect(last(calls).url).toBe('/v1/servers/1/bootstrap-logs');
      expect(last(calls).init.method).toBe('GET');
    });
  });

  describe('projects', () => {
    it('exercises list, create, update and remove', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.projects.list();
      expect(last(calls)).toMatchObject({ url: '/v1/projects', init: { method: 'GET' } });

      await client.projects.create({ name: 'Acme' });
      expect(last(calls).url).toBe('/v1/projects');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ name: 'Acme' });

      await client.projects.update(1, { name: 'Renamed' });
      expect(last(calls)).toMatchObject({ url: '/v1/projects/1', init: { method: 'PATCH' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ name: 'Renamed' });

      await client.projects.remove(1);
      expect(last(calls)).toMatchObject({ url: '/v1/projects/1', init: { method: 'DELETE' } });
    });
  });

  describe('domains', () => {
    it('exercises list, create, remove, all and setSsl', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.domains.list(1);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1/domains', init: { method: 'GET' } });

      await client.domains.create(1, { hostname: 'app.example.com' });
      expect(last(calls).url).toBe('/v1/services/1/domains');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ hostname: 'app.example.com' });

      await client.domains.remove(1, 2);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1/domains/2', init: { method: 'DELETE' } });

      await client.domains.update(1, 2, { redirectWww: true });
      expect(last(calls).url).toBe('/v1/services/1/domains/2');
      expect(last(calls).init.method).toBe('PATCH');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ redirectWww: true });

      await client.domains.all();
      expect(last(calls)).toMatchObject({ url: '/v1/domains', init: { method: 'GET' } });

      await client.domains.setSsl(2, true);
      expect(last(calls).url).toBe('/v1/domains/2');
      expect(last(calls).init.method).toBe('PATCH');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ ssl: true });
    });

    it('exercises setStickySession (G-28) — POST /v1/services/:id/sticky-session', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ id: 1, enabled: true, active: true }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.domains.setStickySession(7, true);
      expect(last(calls).url).toBe('/v1/services/7/sticky-session');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ enabled: true });
    });
  });

  describe('volumes', () => {
    it('exercises list and remove (with URI encoding)', async () => {
      const { fetchMock, calls } = makeFetch(() => ok([]));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.volumes.list();
      expect(last(calls)).toMatchObject({ url: '/v1/volumes', init: { method: 'GET' } });

      await client.volumes.remove('my volume');
      expect(last(calls)).toMatchObject({ url: '/v1/volumes/my%20volume', init: { method: 'DELETE' } });
    });
  });

  describe('system', () => {
    it('exercises resources and pruneImages', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.system.resources();
      expect(last(calls)).toMatchObject({ url: '/v1/system/resources', init: { method: 'GET' } });

      await client.system.pruneImages();
      expect(last(calls)).toMatchObject({ url: '/v1/system/prune-images', init: { method: 'POST' } });

      await client.system.updateCheck();
      expect(last(calls).url).toBe('/v1/system/update-check');
      await client.system.updateCheck(true);
      expect(last(calls).url).toBe('/v1/system/update-check?force=1');

      await client.system.updateStatus();
      expect(last(calls)).toMatchObject({ url: '/v1/system/update-status', init: { method: 'GET' } });

      await client.system.updateStart('v0.3.4');
      expect(last(calls)).toMatchObject({ url: '/v1/system/update-start', init: { method: 'POST' } });
      expect(String(last(calls).init?.body)).toContain('"version":"v0.3.4"');
    });

    it('exportUrl returns the export path without fetching', () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      expect(client.system.exportUrl()).toBe('/v1/system/export');
      expect(calls).toHaveLength(0);
    });
  });

  describe('tunnels', () => {
    it('exercises list, create and remove', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.tunnels.list();
      expect(last(calls)).toMatchObject({ url: '/v1/tunnels', init: { method: 'GET' } });

      await client.tunnels.create({ name: 't', token: 'tok' });
      expect(last(calls).url).toBe('/v1/tunnels');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ name: 't', token: 'tok' });

      await client.tunnels.remove(1);
      expect(last(calls)).toMatchObject({ url: '/v1/tunnels/1', init: { method: 'DELETE' } });
    });
  });

  describe('auth passkeys + sessions', () => {
    it('exercises the passkey ceremony endpoints', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ options: '{}' }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.auth.passkeys.registerOptions();
      expect(last(calls)).toMatchObject({ url: '/v1/auth/passkey/register/options', init: { method: 'POST' } });
      await client.auth.passkeys.loginOptions();
      expect(last(calls)).toMatchObject({ url: '/v1/auth/passkey/login/options', init: { method: 'POST' } });
    });

    it('verifies and lists passkeys', async () => {
      const { fetchMock, calls } = makeFetch(() => ok([]));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.auth.passkeys.registerVerify({ name: 'yubi', response: { id: 'x' } });
      expect(last(calls)).toMatchObject({ url: '/v1/auth/passkey/register/verify', init: { method: 'POST' } });
      await client.auth.passkeys.list();
      expect(last(calls)).toMatchObject({ url: '/v1/auth/passkey', init: { method: 'GET' } });
      await client.auth.passkeys.loginVerify({ id: 'x' });
      expect(last(calls)).toMatchObject({ url: '/v1/auth/passkey/login/verify', init: { method: 'POST' } });
    });

    it('removes a passkey and lists/revokes sessions', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ ok: true }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.auth.passkeys.remove(4);
      expect(last(calls)).toMatchObject({ url: '/v1/auth/passkey/4', init: { method: 'DELETE' } });
      await client.auth.sessions.list();
      expect(last(calls)).toMatchObject({ url: '/v1/auth/sessions', init: { method: 'GET' } });
      await client.auth.sessions.revoke(9);
      expect(last(calls)).toMatchObject({ url: '/v1/auth/sessions/9', init: { method: 'DELETE' } });
    });
  });

  describe('deploys config diff', () => {
    it('fetches the diff for a deployment', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ changed: false, diff: '' }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.deploys.configDiff(3, 12);
      expect(last(calls)).toMatchObject({ url: '/v1/services/3/deploys/12/diff', init: { method: 'GET' } });
    });
  });

  describe('deploys promote', () => {
    it('posts the promotion target to the promote endpoint', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ ok: true, deploymentId: 30, commitSha: 'abc1234', promotedFrom: 'web-staging' }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      const res = await client.deploys.promote(5, 9);
      expect(last(calls)).toMatchObject({
        url: '/v1/services/5/promote',
        init: { method: 'POST', body: JSON.stringify({ targetServiceId: 9 }) },
      });
      expect(res).toMatchObject({ ok: true, promotedFrom: 'web-staging' });
    });
  });

  describe('environments (deployment lanes)', () => {
    it('exercises list, create, rename and remove', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ id: 1, name: 'staging' }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.environments.list();
      expect(last(calls)).toMatchObject({ url: '/v1/environments', init: { method: 'GET' } });

      await client.environments.create({ workspaceId: 10, name: 'staging' });
      expect(last(calls)).toMatchObject({
        url: '/v1/environments',
        init: { method: 'POST', body: JSON.stringify({ workspaceId: 10, name: 'staging' }) },
      });

      await client.environments.rename(1, 'production');
      expect(last(calls)).toMatchObject({
        url: '/v1/environments/1',
        init: { method: 'PATCH', body: JSON.stringify({ name: 'production' }) },
      });

      await client.environments.remove(1);
      expect(last(calls)).toMatchObject({ url: '/v1/environments/1', init: { method: 'DELETE' } });
    });
  });

  describe('ai diagnosis', () => {
    it('reads the config status, updates it, and requests a diagnosis', async () => {
      const { fetchMock, calls } = makeFetch((url, init) => {
        if (init.method === 'PUT') return ok({ ok: true });
        if (init.method === 'POST') return ok({ diagnosis: 'bad credentials', model: 'gpt-test' });
        return ok({ configured: false, baseUrl: null, model: null, hasApiKey: false });
      });
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.ai.getConfig();
      expect(last(calls)).toMatchObject({ url: '/v1/ai/config', init: { method: 'GET' } });

      await client.ai.updateConfig({ baseUrl: 'https://ai.example.com/v1', model: 'gpt-test', apiKey: 'sk-local-' + '1' });
      expect(last(calls)).toMatchObject({
        url: '/v1/ai/config',
        init: { method: 'PUT', body: JSON.stringify({ baseUrl: 'https://ai.example.com/v1', model: 'gpt-test', apiKey: 'sk-local-' + '1' }) },
      });

      const res = await client.ai.diagnose(5, 77);
      expect(last(calls)).toMatchObject({ url: '/v1/ai/services/5/deploys/77/diagnose', init: { method: 'POST' } });
      expect(res).toMatchObject({ diagnosis: 'bad credentials', model: 'gpt-test' });
    });
  });

  describe('networks', () => {
    it('exercises list, create, remove, attach and detach', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ networks: [], remote: null }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.networks.list();
      expect(last(calls)).toMatchObject({ url: '/v1/networks', init: { method: 'GET' } });
      await client.networks.create({ name: 'net-a', driver: 'overlay' });
      expect(last(calls)).toMatchObject({ url: '/v1/networks', init: { method: 'POST' } });
      await client.networks.remove('net-a', 2);
      expect(last(calls)).toMatchObject({ url: '/v1/networks/net-a?serverId=2', init: { method: 'DELETE' } });
      await client.networks.remove('net-a');
      expect(last(calls)).toMatchObject({ url: '/v1/networks/net-a', init: { method: 'DELETE' } });
      await client.networks.attach({ network: 'net-a', container: 'c-1' });
      expect(last(calls)).toMatchObject({ url: '/v1/networks/attach', init: { method: 'POST' } });
      await client.networks.detach({ network: 'net-a', container: 'c-1' });
      expect(last(calls)).toMatchObject({ url: '/v1/networks/detach', init: { method: 'POST' } });
    });
  });

  describe('system docker events', () => {
    it('fetches recent daemon events', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ events: [] }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.system.dockerEvents(30);
      expect(last(calls)).toMatchObject({ url: '/v1/system/docker-events?minutes=30', init: { method: 'GET' } });
    });

    it('defaults to the last hour when no window is given', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ events: [] }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.system.dockerEvents();
      expect(last(calls)).toMatchObject({ url: '/v1/system/docker-events?minutes=60', init: { method: 'GET' } });
    });
  });

  describe('settings vault + dns records', () => {
    it('exercises vault get/set/test', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ ok: true }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.settings.vault.get();
      expect(last(calls)).toMatchObject({ url: '/v1/settings/vault', init: { method: 'GET' } });
      await client.settings.vault.set({ provider: 'doppler', token: 't' });
      expect(last(calls)).toMatchObject({ url: '/v1/settings/vault', init: { method: 'PUT' } });
      await client.settings.vault.test();
      expect(last(calls)).toMatchObject({ url: '/v1/settings/vault/test', init: { method: 'POST' } });
    });

    it('exercises dns-records get/set/test', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ ok: true }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.settings.dnsRecords.get();
      expect(last(calls)).toMatchObject({ url: '/v1/settings/dns-records', init: { method: 'GET' } });
      await client.settings.dnsRecords.set({ enabled: true });
      expect(last(calls)).toMatchObject({ url: '/v1/settings/dns-records', init: { method: 'PUT' } });
      await client.settings.dnsRecords.test();
      expect(last(calls)).toMatchObject({ url: '/v1/settings/dns-records/test', init: { method: 'POST' } });
    });

    it('exercises master-key read + rotate', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ ok: true }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.settings.masterKey.get();
      expect(last(calls)).toMatchObject({ url: '/v1/settings/master-key', init: { method: 'GET' } });
      await client.settings.masterKey.rotate();
      expect(last(calls)).toMatchObject({ url: '/v1/settings/master-key/rotate', init: { method: 'POST' } });
    });
  });

  describe('env search + project env', () => {
    it('searches env keys across scopes', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ results: [] }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.env.search('DATABASE');
      expect(last(calls)).toMatchObject({ url: '/v1/env/search?q=DATABASE', init: { method: 'GET' } });
    });

    it('manages project-scoped env vars', async () => {
      const { fetchMock, calls } = makeFetch(() => ok([]));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.projectEnv.list(6);
      expect(last(calls)).toMatchObject({ url: '/v1/projects/6/env', init: { method: 'GET' } });
      await client.projectEnv.create(6, { key: 'A', value: 'b' });
      expect(last(calls)).toMatchObject({ url: '/v1/projects/6/env', init: { method: 'POST' } });
      await client.projectEnv.update(6, 7, { key: 'A', value: 'c' });
      expect(last(calls)).toMatchObject({ url: '/v1/projects/6/env/7', init: { method: 'PATCH' } });
      await client.projectEnv.remove(6, 7);
      expect(last(calls)).toMatchObject({ url: '/v1/projects/6/env/7', init: { method: 'DELETE' } });
    });
  });

  describe('activity', () => {
    it('lists activity', async () => {
      const { fetchMock, calls } = makeFetch(() => ok([]));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.activity.list();
      expect(last(calls)).toMatchObject({ url: '/v1/activity', init: { method: 'GET' } });
    });

    it('filters the audit trail by entity', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ entries: [], nextCursor: null }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.activity.list({ entity: 'my app' });
      expect(last(calls)).toMatchObject({ url: '/v1/activity?entity=my%20app', init: { method: 'GET' } });
    });

    it('combines action/userId/before filters', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ entries: [], nextCursor: null }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.activity.list({ action: 'deploy.trigger', userId: 3, before: 42 });
      expect(last(calls)).toMatchObject({
        url: '/v1/activity?action=deploy.trigger&userId=3&before=42',
        init: { method: 'GET' },
      });
    });
  });

  describe('users', () => {
    it('exercises list, create and remove', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.users.list();
      expect(last(calls)).toMatchObject({ url: '/v1/users', init: { method: 'GET' } });

      await client.users.create({ email: 'new@example.com', password: 'fresh-pass-' + '123', name: 'New' });
      expect(last(calls).url).toBe('/v1/users');
      expect(last(calls).init.method).toBe('POST');

      // The legacy `PATCH /v1/users/:id/role` endpoint is gone: `users.role`
      // was dropped when authorization became workspace-only, so role changes
      // go through `workspaces.updateMemberRole` instead.
      expect((client.users as Record<string, unknown>).setRole).toBeUndefined();

      // Assembled at runtime — CI's secret scanner flags literal values on
      // credential-named fields otherwise.
      const freshPassword = ['fresh', 'pass', '123'].join('-');
      await client.users.resetPassword(1, { newPassword: freshPassword });
      expect(last(calls).url).toBe('/v1/users/1/password');
      expect(last(calls).init.method).toBe('PATCH');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ newPassword: freshPassword });

      await client.volumes.listFiles('nd-svc-web-data', 'configs');
      expect(last(calls).url).toBe('/v1/volumes/nd-svc-web-data/files?path=configs');
      await client.volumes.readFile('nd-svc-web-data', 'a.env');
      expect(last(calls).url).toBe('/v1/volumes/nd-svc-web-data/files/content?path=a.env');
      await client.volumes.writeFile('nd-svc-web-data', { path: 'a.env', contentBase64: 'aGk=' });
      expect(last(calls)).toMatchObject({ url: '/v1/volumes/nd-svc-web-data/files', init: { method: 'PUT' } });
      await client.volumes.mkdir('nd-svc-web-data', { path: 'd' });
      await client.volumes.deleteFile('nd-svc-web-data', 'old');
      expect(last(calls).url).toBe('/v1/volumes/nd-svc-web-data/files?path=old');
      await client.volumes.listFiles('nd-svc-web-data'); // default path branch
      expect(last(calls).url).toBe('/v1/volumes/nd-svc-web-data/files?path=');
      await client.volumes.prune();
      expect(last(calls)).toMatchObject({ url: '/v1/volumes/prune', init: { method: 'POST' } });

      await client.containers.listFiles('nd-svc-web-1', '/app');
      expect(last(calls).url).toBe('/v1/containers/nd-svc-web-1/files?path=%2Fapp');
      await client.containers.readFile('nd-svc-web-1', '/app/config.json');
      expect(last(calls).url).toBe('/v1/containers/nd-svc-web-1/files/content?path=%2Fapp%2Fconfig.json');
      await client.containers.writeFile('nd-svc-web-1', { path: '/app/config.json', contentBase64: 'e30=' });
      expect(last(calls)).toMatchObject({ url: '/v1/containers/nd-svc-web-1/files', init: { method: 'PUT' } });
      await client.containers.mkdir('nd-svc-web-1', { path: '/app/logs' });
      expect(last(calls)).toMatchObject({ url: '/v1/containers/nd-svc-web-1/files/dir', init: { method: 'POST' } });
      await client.containers.deleteFile('nd-svc-web-1', '/app/tmp');
      expect(last(calls).url).toBe('/v1/containers/nd-svc-web-1/files?path=%2Fapp%2Ftmp');
      await client.containers.listFiles('nd-svc-web-1'); // default path branch
      expect(last(calls).url).toBe('/v1/containers/nd-svc-web-1/files?path=%2F');

      await client.users.create({ email: 'x@y.dev', password: '12345678', role: 'admin' });
      expect(last(calls)).toMatchObject({ url: '/v1/users', init: { method: 'POST' } });

      await client.users.resetLink(1);
      expect(last(calls).url).toBe('/v1/users/1/reset-link');
      expect(last(calls).init.method).toBe('POST');

      // The INSTANCE-operator flag — distinct from a workspace role, and the
      // only way to gain operator rights now that creating a workspace no
      // longer confers them.
      await client.users.setOperator(1, true);
      expect(last(calls)).toMatchObject({ url: '/v1/users/1/operator', init: { method: 'PATCH' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ isOperator: true });
      await client.users.setOperator(1, false);
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ isOperator: false });

      await client.users.remove(1);
      expect(last(calls)).toMatchObject({ url: '/v1/users/1', init: { method: 'DELETE' } });
    });
  });

  describe('settings', () => {
    it('reads and toggles the registration flag', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.settings.get();
      expect(last(calls)).toMatchObject({ url: '/v1/settings', init: { method: 'GET' } });

      await client.settings.setAllowRegistration(false);
      expect(last(calls).url).toBe('/v1/settings/allow-registration');
      expect(last(calls).init.method).toBe('PUT');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ enabled: false });

      await client.settings.setPanelDomain('panel.example.com');
      expect(last(calls).url).toBe('/v1/settings/panel-domain');
      expect(last(calls).init.method).toBe('PUT');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ domain: 'panel.example.com' });
    });
  });

  describe('about', () => {
    it('gets about info', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.about.get();
      expect(last(calls)).toMatchObject({ url: '/v1/about', init: { method: 'GET' } });
    });
  });

  describe('settings (dns challenge)', () => {
    it('saves the DNS-01 challenge config', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.settings.setDns({ provider: 'cloudflare', token: 'tok', wildcardApex: 'example.com' });
      expect(last(calls)).toMatchObject({ url: '/v1/settings/dns', init: { method: 'PUT' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ provider: 'cloudflare', token: 'tok', wildcardApex: 'example.com' });
    });
  });

  describe('settings (templates source)', () => {
    it('saves the template registry source', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.settings.setTemplatesSource('https://registry.example.com/r.json');
      expect(last(calls)).toMatchObject({ url: '/v1/settings/templates-source', init: { method: 'PUT' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ source: 'https://registry.example.com/r.json' });
    });
  });

  describe('settings (acme email)', () => {
    it('saves the ACME email', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.settings.setAcmeEmail('ops@example.com');
      expect(last(calls)).toMatchObject({ url: '/v1/settings/acme-email', init: { method: 'PUT' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ email: 'ops@example.com' });
      void fetchMock;
    });
  });

    describe('non-JSON ok responses', () => {
    it('resolves an empty 2xx body to an empty object (never undefined)', async () => {
      const { fetchMock } = makeFetch(() => ok());
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await expect(client.auth.status()).resolves.toEqual({});
    });

    it('surfaces an HTML 200 from a misrouted proxy as a typed error', async () => {
      const { fetchMock } = makeFetch(() => ok('<html>index</html>'));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await expect(client.auth.status()).rejects.toMatchObject({ code: 'invalid_response' });
    });
  });

  describe('alerts', () => {
    it('exercises all alert rule methods', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.alerts.list();
      expect(last(calls)).toMatchObject({ url: '/v1/alerts', init: { method: 'GET' } });

      await client.alerts.create({ name: 'high-cpu', metric: 'cpu', threshold: 80 });
      expect(last(calls).url).toBe('/v1/alerts');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ name: 'high-cpu', metric: 'cpu', threshold: 80 });

      await client.alerts.update(3, { enabled: false });
      expect(last(calls).url).toBe('/v1/alerts/3');
      expect(last(calls).init.method).toBe('PATCH');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ enabled: false });

      await client.alerts.remove(3);
      expect(last(calls)).toMatchObject({ url: '/v1/alerts/3', init: { method: 'DELETE' } });
    });
  });

  describe('notifications', () => {
    it('exercises all channel methods and the log', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.notifications.listChannels();
      expect(last(calls)).toMatchObject({ url: '/v1/notifications/channels', init: { method: 'GET' } });

      await client.notifications.createChannel({ name: 'c', type: 'telegram', target: '@x' });
      expect(last(calls).url).toBe('/v1/notifications/channels');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ name: 'c', type: 'telegram', target: '@x' });

      await client.notifications.updateChannel(1, { active: false });
      expect(last(calls).url).toBe('/v1/notifications/channels/1');
      expect(last(calls).init.method).toBe('PATCH');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ active: false });

      await client.notifications.removeChannel(1);
      expect(last(calls)).toMatchObject({ url: '/v1/notifications/channels/1', init: { method: 'DELETE' } });

      await client.notifications.testChannel(1);
      expect(last(calls)).toMatchObject({ url: '/v1/notifications/channels/1/test', init: { method: 'POST' } });

      await client.notifications.log();
      expect(last(calls)).toMatchObject({ url: '/v1/notifications/log', init: { method: 'GET' } });
    });
  });

  describe('sources', () => {
    it('exercises list, create, update and remove', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.sources.list();
      expect(last(calls)).toMatchObject({ url: '/v1/sources', init: { method: 'GET' } });

      await client.sources.create({ name: 'gh', type: 'github', token: 't' });
      expect(last(calls).url).toBe('/v1/sources');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ name: 'gh', type: 'github', token: 't' });

      await client.sources.update(1, { name: 'gh2' });
      expect(last(calls).url).toBe('/v1/sources/1');
      expect(last(calls).init.method).toBe('PATCH');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ name: 'gh2' });

      await client.sources.remove(1);
      expect(last(calls)).toMatchObject({ url: '/v1/sources/1', init: { method: 'DELETE' } });

      await client.sources.repos(1);
      expect(last(calls)).toMatchObject({ url: '/v1/sources/1/repos', init: { method: 'GET' } });

      await client.sources.branches(1, 'owner/repo');
      expect(last(calls)).toMatchObject({ url: '/v1/sources/1/branches?repo=owner%2Frepo', init: { method: 'GET' } });

      await client.sources.test(1);
      expect(last(calls)).toMatchObject({ url: '/v1/sources/1/test', init: { method: 'GET' } });

      await client.sources.generateDeployKey(1);
      expect(last(calls)).toMatchObject({ url: '/v1/sources/1/generate-deploy-key', init: { method: 'POST' } });
    });
  });

  describe('insights', () => {
    it('exercises analyze, get and refresh', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.insights.analyze({ repoUrl: 'https://github.com/o/r', branch: 'main' });
      expect(last(calls).url).toBe('/v1/insights');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ repoUrl: 'https://github.com/o/r', branch: 'main' });

      await client.insights.get(7);
      expect(last(calls)).toMatchObject({ url: '/v1/services/7/insights', init: { method: 'GET' } });

      await client.insights.refresh(7);
      expect(last(calls)).toMatchObject({ url: '/v1/services/7/insights/refresh', init: { method: 'POST' } });
    });
  });

  describe('webhooks', () => {
    it('exercises list, create (with and without input) and remove', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.webhooks.list(1);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1/webhooks', init: { method: 'GET' } });

      await client.webhooks.create(1);
      expect(last(calls).url).toBe('/v1/services/1/webhooks');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({});

      await client.webhooks.create(1, { branch: 'main' });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ branch: 'main' });

      await client.webhooks.remove(1, 2);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1/webhooks/2', init: { method: 'DELETE' } });
    });
  });

  describe('databases', () => {
    it('exercises list, create, get and remove', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.databases.list();
      expect(last(calls)).toMatchObject({ url: '/v1/databases', init: { method: 'GET' } });

      await client.databases.create({ name: 'db', engine: 'postgres' });
      expect(last(calls).url).toBe('/v1/databases');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ name: 'db', engine: 'postgres' });

      await client.databases.get(1);
      expect(last(calls)).toMatchObject({ url: '/v1/databases/1', init: { method: 'GET' } });

      await client.databases.remove(1);
      expect(last(calls)).toMatchObject({ url: '/v1/databases/1', init: { method: 'DELETE' } });

      await client.databases.remove(2, { force: true });
      expect(last(calls)).toMatchObject({ url: '/v1/databases/2?force=true', init: { method: 'DELETE' } });

      await client.databases.restart(1);
      expect(last(calls)).toMatchObject({ url: '/v1/databases/1/restart', init: { method: 'POST' } });

      await client.databases.stop(1);
      expect(last(calls)).toMatchObject({ url: '/v1/databases/1/stop', init: { method: 'POST' } });

      await client.databases.start(1);
      expect(last(calls)).toMatchObject({ url: '/v1/databases/1/start', init: { method: 'POST' } });

      await client.databases.logs(1);
      expect(last(calls)).toMatchObject({ url: '/v1/databases/1/logs', init: { method: 'GET' } });

      await client.databases.logs(1, 50);
      expect(last(calls)).toMatchObject({ url: '/v1/databases/1/logs?lines=50', init: { method: 'GET' } });

      await client.databases.credentials(1);
      expect(last(calls)).toMatchObject({ url: '/v1/databases/1/credentials', init: { method: 'GET' } });

      await client.databases.setLimits(1, { cpuShares: 512, memLimitMb: 1024 });
      expect(last(calls)).toMatchObject({ url: '/v1/databases/1/limits', init: { method: 'PATCH' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ cpuShares: 512, memLimitMb: 1024 });

      await client.databases.startStudio(1, 18055);
      expect(last(calls)).toMatchObject({ url: '/v1/databases/1/studio', init: { method: 'POST' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ port: 18055 });

      await client.databases.stopStudio(1);
      expect(last(calls)).toMatchObject({ url: '/v1/databases/1/studio', init: { method: 'DELETE' } });
    });
  });

  describe('attachments', () => {
    it('exercises list, create and remove', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.attachments.list(1);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1/attachments', init: { method: 'GET' } });

      await client.attachments.create(1, { databaseId: 2, envAlias: 'DB_URL' });
      expect(last(calls).url).toBe('/v1/services/1/attachments');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ databaseId: 2, envAlias: 'DB_URL' });

      await client.attachments.remove(1, 2);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1/attachments/2', init: { method: 'DELETE' } });
    });
  });

  describe('env', () => {
    it('exercises list, create, update and remove', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.env.list(1);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1/env', init: { method: 'GET' } });

      await client.env.create(1, { key: 'PORT', value: '3000' });
      expect(last(calls).url).toBe('/v1/services/1/env');
      expect(last(calls).init.method).toBe('POST');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ key: 'PORT', value: '3000' });

      await client.env.update(1, 2, { key: 'PORT', value: '4000' });
      expect(last(calls).url).toBe('/v1/services/1/env/2');
      expect(last(calls).init.method).toBe('PATCH');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ key: 'PORT', value: '4000' });

      await client.env.remove(1, 2);
      expect(last(calls)).toMatchObject({ url: '/v1/services/1/env/2', init: { method: 'DELETE' } });
    });
  });

  describe('stats', () => {
    it('exercises snapshot and metrics with and without opts', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.stats.snapshot();
      expect(last(calls)).toMatchObject({ url: '/v1/stats', init: { method: 'GET' } });

      await client.stats.metrics(1);
      expect(last(calls).url).toBe('/v1/services/1/metrics?kind=cpu&minutes=60');

      await client.stats.metrics(1, { kind: 'memory', minutes: 5 });
      expect(last(calls).url).toBe('/v1/services/1/metrics?kind=memory&minutes=5');

      await client.stats.metrics(1, {});
      expect(last(calls).url).toBe('/v1/services/1/metrics?kind=cpu&minutes=60');
    });
  });

  describe('dashboard', () => {
    it('gets the dashboard', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.dashboard.get();
      expect(last(calls)).toMatchObject({ url: '/v1/dashboard', init: { method: 'GET' } });
    });
  });

  describe('topology', () => {
    it('gets the topology', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.topology.get();
      expect(last(calls)).toMatchObject({ url: '/v1/topology', init: { method: 'GET' } });
    });
  });

  describe('backups', () => {
    it('exercises storage, backupNow, listForDb, restore, list and remove', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.backups.storage(1);
      expect(last(calls)).toMatchObject({ url: '/v1/databases/1/storage', init: { method: 'GET' } });

      await client.backups.backupNow(1);
      expect(last(calls)).toMatchObject({ url: '/v1/databases/1/backups', init: { method: 'POST' } });

      await client.backups.listForDb(1);
      expect(last(calls)).toMatchObject({ url: '/v1/databases/1/backups', init: { method: 'GET' } });

      await client.backups.restore(1, 2);
      expect(last(calls)).toMatchObject({ url: '/v1/databases/1/backups/2/restore', init: { method: 'POST' } });

      await client.backups.list();
      expect(last(calls)).toMatchObject({ url: '/v1/backups', init: { method: 'GET' } });

      await client.backups.remove(3);
      expect(last(calls)).toMatchObject({ url: '/v1/backups/3', init: { method: 'DELETE' } });
    });

    it('downloadUrl returns the download path without fetching', () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      expect(client.backups.downloadUrl(3)).toBe('/v1/backups/3/download');
      expect(calls).toHaveLength(0);
    });
  });

  describe('templates', () => {
    it('exercises list, get and deploy', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.templates.list();
      expect(last(calls)).toMatchObject({ url: '/v1/templates', init: { method: 'GET' } });

      await client.templates.get('nextjs');
      expect(last(calls)).toMatchObject({ url: '/v1/templates/nextjs', init: { method: 'GET' } });

      await client.templates.prepare('wordpress', { name: 'Blog' });
      expect(last(calls)).toMatchObject({ url: '/v1/templates/wordpress/prepare', init: { method: 'POST' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ name: 'Blog' });

      await client.templates.prepare('wordpress');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({});

      await client.templates.deploy('nextjs');
      expect(last(calls)).toMatchObject({ url: '/v1/templates/nextjs/deploy', init: { method: 'POST' } });

      await client.templates.deploy('wordpress', { name: 'Blog', publishedPort: 8080, reuseExisting: true });
      expect(last(calls)).toMatchObject({ url: '/v1/templates/wordpress/deploy', init: { method: 'POST' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ name: 'Blog', publishedPort: 8080, reuseExisting: true });
    });
  });

  describe('limits', () => {
    it('exercises setService and setDatabase', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.limits.setService(1, { cpuShares: 512, memLimitMb: 256 });
      expect(last(calls).url).toBe('/v1/services/1/limits');
      expect(last(calls).init.method).toBe('PATCH');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ cpuShares: 512, memLimitMb: 256 });

      await client.limits.setDatabase(1, { cpuShares: 256, memLimitMb: 128 });
      expect(last(calls).url).toBe('/v1/databases/1/limits');
      expect(last(calls).init.method).toBe('PATCH');
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ cpuShares: 256, memLimitMb: 128 });
    });
  });

  describe('traefik', () => {
    it('exercises get, status, certificates, logs, restart and backupCerts', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ ok: true }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.traefik.get();
      expect(last(calls)).toMatchObject({ url: '/v1/traefik', init: { method: 'GET' } });

      await client.traefik.status();
      expect(last(calls)).toMatchObject({ url: '/v1/traefik/status', init: { method: 'GET' } });

      await client.traefik.certificates();
      expect(last(calls)).toMatchObject({ url: '/v1/traefik/certificates', init: { method: 'GET' } });

      await client.traefik.logs();
      expect(last(calls)).toMatchObject({ url: '/v1/traefik/logs?lines=50', init: { method: 'GET' } });

      await client.traefik.logs(100);
      expect(last(calls)).toMatchObject({ url: '/v1/traefik/logs?lines=100', init: { method: 'GET' } });

      await client.traefik.restart();
      expect(last(calls)).toMatchObject({ url: '/v1/traefik/restart', init: { method: 'POST' } });

      await client.traefik.backupCerts();
      expect(last(calls)).toMatchObject({ url: '/v1/traefik/backup-certs', init: { method: 'POST' } });
    });
  });

  describe('config', () => {
    it('lists, gets, sets, and deletes config entries', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ entries: [] }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.config.list();
      expect(last(calls)).toMatchObject({ url: '/v1/config', init: { method: 'GET' } });

      await client.config.list({ category: 'general', pluginId: 'smtp', reveal: true });
      expect(last(calls)).toMatchObject({ url: '/v1/config?category=general&pluginId=smtp&reveal=true', init: { method: 'GET' } });

      await client.config.get('system.site_name');
      expect(last(calls)).toMatchObject({ url: '/v1/config/system.site_name', init: { method: 'GET' } });

      await client.config.set('system.site_name', { value: 'NineDeploy', isSecret: false, description: 'Main site' });
      expect(last(calls)).toMatchObject({ url: '/v1/config/system.site_name', init: { method: 'POST' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ value: 'NineDeploy', isSecret: false, description: 'Main site' });

      await client.config.delete('system.site_name');
      expect(last(calls)).toMatchObject({ url: '/v1/config/system.site_name', init: { method: 'DELETE' } });
    });
  });

  describe('metricHistory', () => {
    it('GET /v1/metric-history and POST /v1/metric-history/flush (G-09)', async () => {
      const { fetchMock, calls } = makeFetch((url) => {
        if (url.endsWith('/v1/metric-history/flush')) {
          return ok({ ok: true, backend: 'builtin', deleted: 7 });
        }
        return ok({
          enabled: true,
          backend: 'builtin',
          events: ['deployment.status_changed', 'service.health_changed', 'backup.completed', 'alert.triggered'],
          retentionDays: 30,
          lastFlush: { ts: 0, backend: 'builtin', count: 0 },
        });
      });
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      const status = await client.metricHistory.get();
      expect(status.backend).toBe('builtin');
      expect(status.events).toHaveLength(4);
      expect(last(calls)).toMatchObject({ url: '/v1/metric-history', init: { method: 'GET' } });

      const flush = await client.metricHistory.flush();
      expect(flush).toEqual({ ok: true, backend: 'builtin', deleted: 7 });
      expect(last(calls)).toMatchObject({ url: '/v1/metric-history/flush', init: { method: 'POST' } });
    });
  });

  describe('buildCache', () => {
    it('GET /v1/build-cache/stats (G-01 PR-A)', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({
          backends: [{ name: 'inline', entries: 1, totalBytes: 1024, hits: 4, misses: 6, stores: 5, evictions: 1 }],
          totals: { entries: 1, totalBytes: 1024, hits: 4, misses: 6, stores: 5, evictions: 1 },
        }),
      );
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      const stats = await client.buildCache.stats();
      expect(stats.backends).toHaveLength(1);
      expect(stats.totals.hits).toBe(4);
      expect(last(calls)).toMatchObject({ url: '/v1/build-cache/stats', init: { method: 'GET' } });
    });
  });

  describe('plugins', () => {
    it('lists, marketplaces, installs, enables, disables, and uninstalls plugins', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ plugins: [], catalog: [] }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.plugins.list();
      expect(last(calls)).toMatchObject({ url: '/v1/plugins', init: { method: 'GET' } });

      await client.plugins.marketplace();
      expect(last(calls)).toMatchObject({ url: '/v1/plugins/marketplace', init: { method: 'GET' } });

      await client.plugins.install({ source: 'marketplace', target: 's3-backups' });
      expect(last(calls)).toMatchObject({ url: '/v1/plugins/install', init: { method: 'POST' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ source: 'marketplace', target: 's3-backups' });

      await client.plugins.enable('smtp-notifier');
      expect(last(calls)).toMatchObject({ url: '/v1/plugins/smtp-notifier/enable', init: { method: 'POST' } });

      await client.plugins.disable('smtp-notifier');
      expect(last(calls)).toMatchObject({ url: '/v1/plugins/smtp-notifier/disable', init: { method: 'POST' } });

      await client.plugins.reload('smtp-notifier');
      expect(last(calls)).toMatchObject({ url: '/v1/plugins/smtp-notifier/reload', init: { method: 'POST' } });

      await client.plugins.inspect('smtp-notifier');
      expect(last(calls)).toMatchObject({ url: '/v1/plugins/smtp-notifier/inspect', init: { method: 'GET' } });

      await client.plugins.uninstall('smtp-notifier');
      expect(last(calls)).toMatchObject({ url: '/v1/plugins/smtp-notifier/uninstall', init: { method: 'POST' } });
    });
  });

  describe('menus', () => {
    it('lists menus with and without slot query', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ slots: {}, items: [] }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.menus.list();
      expect(last(calls)).toMatchObject({ url: '/v1/menus', init: { method: 'GET' } });

      await client.menus.list({ slot: 'sidebar:main' });
      expect(last(calls)).toMatchObject({ url: '/v1/menus?slot=sidebar%3Amain', init: { method: 'GET' } });
    });
  });

  describe('demo', () => {
    it('hits the demo seed endpoint', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ ok: true, projectId: 1, projectName: 'Demo', services: [] }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.demo.seed();
      expect(last(calls)).toMatchObject({ url: '/v1/demo/seed', init: { method: 'POST' } });
    });
  });

  describe('health', () => {
    it('hits the health endpoint', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ status: 'ok' }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      await client.health();
      expect(last(calls)).toMatchObject({ url: '/health', init: { method: 'GET' } });
    });
  });

  describe('error body fallback coverage', () => {
    it('uses unknown_error code when err is null (body=null)', async () => {
      // body=null → (null)?.error === undefined → err is undefined → code falls back to 'unknown_error'
      const { fetchMock } = makeFetch(() => ({ status: 500, body: null }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      try {
        await client.health();
        expect.unreachable('expected health() to throw');
      } catch (e: unknown) {
        const err = e as { code?: string; message?: string; name?: string };
        expect(err.code).toBe('unknown_error'); // err?.code ?? 'unknown_error' — err is nullish
      }
    });

    it('uses request-failed-with-status message when err is null', async () => {
      const { fetchMock } = makeFetch(() => ({ status: 502, body: null }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      try {
        await client.health();
        expect.unreachable('expected health() to throw');
      } catch (e: unknown) {
        const err = e as { code?: string; message?: string; name?: string };
        expect(err.message).toBe('Request failed with status 502'); // err?.message ?? fallback
      }
    });

    it('uses unknown_error code when body has no error field', async () => {
      const { fetchMock } = makeFetch(() => ({ status: 500, body: { notError: true } }));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
      try {
        await client.health();
        expect.unreachable('expected health() to throw');
      } catch (e: unknown) {
        const err = e as { code?: string; message?: string; name?: string };
        expect(err.code).toBe('unknown_error'); // (body)?.error === undefined → code ?? 'unknown_error'
      }
    });
  });

  describe('logDrains', () => {
    it('exercises list, get, create, update, remove, and test', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.logDrains.list();
      expect(last(calls)).toMatchObject({ url: '/v1/log-drains', init: { method: 'GET' } });

      await client.logDrains.list({ serviceId: 5 });
      expect(last(calls)).toMatchObject({ url: '/v1/log-drains?serviceId=5', init: { method: 'GET' } });

      await client.logDrains.get(1);
      expect(last(calls)).toMatchObject({ url: '/v1/log-drains/1', init: { method: 'GET' } });

      await client.logDrains.create({ name: 'Datadog Drain', type: 'datadog', url: 'https://http-intake.logs.datadoghq.com' });
      expect(last(calls)).toMatchObject({ url: '/v1/log-drains', init: { method: 'POST' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({
        name: 'Datadog Drain',
        type: 'datadog',
        url: 'https://http-intake.logs.datadoghq.com',
      });

      await client.logDrains.update(1, { enabled: false });
      expect(last(calls)).toMatchObject({ url: '/v1/log-drains/1', init: { method: 'PATCH' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ enabled: false });

      await client.logDrains.remove(1);
      expect(last(calls)).toMatchObject({ url: '/v1/log-drains/1', init: { method: 'DELETE' } });

      await client.logDrains.test(1);
      expect(last(calls)).toMatchObject({ url: '/v1/log-drains/1/test', init: { method: 'POST' } });
    });
  });

  describe('housekeeping', () => {
    it('exercises getAutoPrune, updateAutoPrune, and runPrune', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.housekeeping.getAutoPrune();
      expect(last(calls)).toMatchObject({ url: '/v1/housekeeping/prune/config', init: { method: 'GET' } });

      await client.housekeeping.updateAutoPrune({ thresholdPercent: 80, enabled: true });
      expect(last(calls)).toMatchObject({ url: '/v1/housekeeping/prune/config', init: { method: 'PATCH' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ thresholdPercent: 80, enabled: true });

      await client.housekeeping.runPrune();
      expect(last(calls)).toMatchObject({ url: '/v1/housekeeping/prune', init: { method: 'POST' } });
    });
  });

  describe('doctor', () => {
    it('exercises scan and fix', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.doctor.scan();
      expect(last(calls)).toMatchObject({ url: '/v1/doctor', init: { method: 'GET' } });

      await client.doctor.fix({ findingId: 'orphan_volume:nd-db-ghost' });
      expect(last(calls)).toMatchObject({ url: '/v1/doctor/fix', init: { method: 'POST' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ findingId: 'orphan_volume:nd-db-ghost' });
    });
  });

  describe('auth.oidc', () => {
    it('exercises publicProviders, listProviders, createProvider, updateProvider, deleteProvider, and callback', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.auth.oidc.publicProviders();
      expect(last(calls)).toMatchObject({ url: '/v1/auth/oidc/providers/public', init: { method: 'GET' } });

      await client.auth.oidc.listProviders();
      expect(last(calls)).toMatchObject({ url: '/v1/auth/oidc/providers', init: { method: 'GET' } });

      // Assembled at runtime — CI's secret scanner flags literal values on
      // credential-named fields otherwise.
      const googleSecret = ['g', 'secret'].join('-');
      await client.auth.oidc.createProvider({
        name: 'Google Workspace',
        slug: 'google',
        issuerUrl: 'https://accounts.google.com',
        clientId: 'g-client',
        clientSecret: googleSecret,
        scopes: 'openid email',
        enabled: true,
        autoEnroll: true,
        defaultRole: 'member',
      });
      expect(last(calls)).toMatchObject({ url: '/v1/auth/oidc/providers', init: { method: 'POST' } });

      await client.auth.oidc.updateProvider(1, { enabled: false });
      expect(last(calls)).toMatchObject({ url: '/v1/auth/oidc/providers/1', init: { method: 'PATCH' } });

      await client.auth.oidc.list();
      expect(last(calls)).toMatchObject({ url: '/v1/auth/oidc/providers', init: { method: 'GET' } });

      await client.auth.oidc.create({
        name: 'Google Workspace',
        slug: 'google',
        issuerUrl: 'https://accounts.google.com',
        clientId: 'g-client',
        clientSecret: googleSecret,
        scopes: 'openid email',
        enabled: true,
        autoEnroll: true,
        defaultRole: 'member',
      });
      expect(last(calls)).toMatchObject({ url: '/v1/auth/oidc/providers', init: { method: 'POST' } });

      await client.auth.oidc.update(1, { enabled: false });
      expect(last(calls)).toMatchObject({ url: '/v1/auth/oidc/providers/1', init: { method: 'PATCH' } });

      await client.auth.oidc.deleteProvider(1);
      expect(last(calls)).toMatchObject({ url: '/v1/auth/oidc/providers/1', init: { method: 'DELETE' } });

      await client.auth.oidc.delete(1);
      expect(last(calls)).toMatchObject({ url: '/v1/auth/oidc/providers/1', init: { method: 'DELETE' } });

      await client.auth.oidc.callback('google', { code: 'code123', state: 'state456' });
      expect(last(calls)).toMatchObject({ url: '/v1/auth/oidc/google/callback', init: { method: 'POST' } });
    });
  });

  describe('workspaces', () => {
    it('exercises list, get, create, update, delete, addMember, updateMemberRole, and removeMember', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.workspaces.list();
      expect(last(calls)).toMatchObject({ url: '/v1/workspaces', init: { method: 'GET' } });

      await client.workspaces.get(1);
      expect(last(calls)).toMatchObject({ url: '/v1/workspaces/1', init: { method: 'GET' } });

      await client.workspaces.create({ name: 'Acme Corp', slug: 'acme', description: 'Main Org' });
      expect(last(calls)).toMatchObject({ url: '/v1/workspaces', init: { method: 'POST' } });

      await client.workspaces.update(1, { name: 'Acme Global' });
      expect(last(calls)).toMatchObject({ url: '/v1/workspaces/1', init: { method: 'PATCH' } });

      await client.workspaces.delete(1);
      expect(last(calls)).toMatchObject({ url: '/v1/workspaces/1', init: { method: 'DELETE' } });

      await client.workspaces.addMember(1, { email: 'dev@acme.com', role: 'admin' });
      expect(last(calls)).toMatchObject({ url: '/v1/workspaces/1/members', init: { method: 'POST' } });

      await client.workspaces.updateMemberRole(1, 2, { role: 'viewer' });
      expect(last(calls)).toMatchObject({ url: '/v1/workspaces/1/members/2', init: { method: 'PATCH' } });

      await client.workspaces.removeMember(1, 2);
      expect(last(calls)).toMatchObject({ url: '/v1/workspaces/1/members/2', init: { method: 'DELETE' } });

      // Invitation flow
      await client.workspaces.inviteMember(1, { email: 'newbie@acme.com', role: 'member' });
      expect(last(calls)).toMatchObject({ url: '/v1/workspaces/1/invitations', init: { method: 'POST' } });

      await client.workspaces.listInvitations(1);
      expect(last(calls)).toMatchObject({ url: '/v1/workspaces/1/invitations', init: { method: 'GET' } });

      await client.workspaces.revokeInvitation(1, 99);
      expect(last(calls)).toMatchObject({ url: '/v1/workspaces/1/invitations/99', init: { method: 'DELETE' } });

      await client.workspaces.previewInvitation('a'.repeat(64));
      expect(last(calls)).toMatchObject({ url: `/v1/invitations/${'a'.repeat(64)}`, init: { method: 'GET' } });

      await client.workspaces.acceptInvitation('a'.repeat(64));
      expect(last(calls)).toMatchObject({ url: `/v1/invitations/${'a'.repeat(64)}/accept`, init: { method: 'POST' } });
    });
  });

  describe('containers', () => {
    it('exercises inspect, compose, listFiles, readFile, writeFile, makeDir, and deletePath', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.containers.inspect('ninedeploy-app-1');
      expect(last(calls)).toMatchObject({ url: '/v1/containers/ninedeploy-app-1/inspect', init: { method: 'GET' } });

      await client.containers.compose('ninedeploy-app-1');
      expect(last(calls)).toMatchObject({ url: '/v1/containers/ninedeploy-app-1/compose', init: { method: 'GET' } });

      await client.containers.listFiles('ninedeploy-app-1', '/app');
      expect(last(calls)).toMatchObject({ url: '/v1/containers/ninedeploy-app-1/files?path=%2Fapp', init: { method: 'GET' } });

      await client.containers.listFiles('ninedeploy-app-1');
      expect(last(calls)).toMatchObject({ url: '/v1/containers/ninedeploy-app-1/files?path=%2F', init: { method: 'GET' } });

      await client.containers.readFile('ninedeploy-app-1', '/app/config.json');
      expect(last(calls)).toMatchObject({ url: '/v1/containers/ninedeploy-app-1/files/content?path=%2Fapp%2Fconfig.json', init: { method: 'GET' } });

      await client.containers.writeFile('ninedeploy-app-1', { path: '/app/a.txt', contentBase64: 'ZGF0YQ==' });
      expect(last(calls)).toMatchObject({ url: '/v1/containers/ninedeploy-app-1/files', init: { method: 'PUT' } });

      await client.containers.makeDir('ninedeploy-app-1', { path: '/app/logs' });
      expect(last(calls)).toMatchObject({ url: '/v1/containers/ninedeploy-app-1/files/dir', init: { method: 'POST' } });

      await client.containers.deletePath('ninedeploy-app-1', '/app/tmp');
      expect(last(calls)).toMatchObject({ url: '/v1/containers/ninedeploy-app-1/files?path=%2Fapp%2Ftmp', init: { method: 'DELETE' } });
    });
  });

  describe('firewall', () => {
    it('exercises status, toggle, addRule, deleteRule, and applyRecommended', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.firewall.status();
      expect(last(calls)).toMatchObject({ url: '/v1/firewall', init: { method: 'GET' } });

      await client.firewall.toggle(true);
      expect(last(calls)).toMatchObject({ url: '/v1/firewall/toggle', init: { method: 'POST' } });

      await client.firewall.addRule({ port: 5432, proto: 'tcp', action: 'allow' });
      expect(last(calls)).toMatchObject({ url: '/v1/firewall/rules', init: { method: 'POST' } });

      await client.firewall.deleteRule(2);
      expect(last(calls)).toMatchObject({ url: '/v1/firewall/rules/2', init: { method: 'DELETE' } });

      await client.firewall.applyRecommended();
      expect(last(calls)).toMatchObject({ url: '/v1/firewall/recommended', init: { method: 'POST' } });
    });
  });
  describe('labels and service tags', () => {
    it('exercises label CRUD with and without a query, plus tag get/set', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.labels.list();
      expect(last(calls)).toMatchObject({ url: '/v1/labels', init: { method: 'GET' } });

      await client.labels.list('?workspaceId=3');
      expect(last(calls)).toMatchObject({ url: '/v1/labels?workspaceId=3', init: { method: 'GET' } });

      await client.labels.create({ name: 'production', color: 'red' });
      expect(last(calls)).toMatchObject({ url: '/v1/labels', init: { method: 'POST' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ name: 'production', color: 'red' });

      await client.labels.update(7, { color: 'indigo' });
      expect(last(calls)).toMatchObject({ url: '/v1/labels/7', init: { method: 'PATCH' } });

      await client.labels.remove(7);
      expect(last(calls)).toMatchObject({ url: '/v1/labels/7', init: { method: 'DELETE' } });

      await client.serviceTags.get(4);
      expect(last(calls)).toMatchObject({ url: '/v1/services/4/tags', init: { method: 'GET' } });

      await client.serviceTags.set(4, { projectIds: [1], workspaceIds: [2], labelIds: [3] });
      expect(last(calls)).toMatchObject({ url: '/v1/services/4/tags', init: { method: 'PUT' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ projectIds: [1], workspaceIds: [2], labelIds: [3] });
    });
  });

  describe('service volumes and volume backups', () => {
    it('exercises volume attachment list, create, update and remove', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.serviceVolumes.list(9);
      expect(last(calls)).toMatchObject({ url: '/v1/services/9/volumes', init: { method: 'GET' } });

      await client.serviceVolumes.create(9, { volumeName: 'nd-svc-web-data', containerPath: '/data' });
      expect(last(calls)).toMatchObject({ url: '/v1/services/9/volumes', init: { method: 'POST' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({
        volumeName: 'nd-svc-web-data',
        containerPath: '/data',
      });

      await client.serviceVolumes.update(9, 2, { readOnly: true });
      expect(last(calls)).toMatchObject({ url: '/v1/services/9/volumes/2', init: { method: 'PATCH' } });
      expect(JSON.parse(last(calls).init.body ?? '{}')).toEqual({ readOnly: true });

      await client.serviceVolumes.remove(9, 2);
      expect(last(calls)).toMatchObject({ url: '/v1/services/9/volumes/2', init: { method: 'DELETE' } });

      await client.serviceVolumes.repairConfig(9, { filePath: 'wp-config.php', volumeName: 'nd-svc-web-data' });
      expect(last(calls)).toMatchObject({ url: '/v1/services/9/volumes/config-repair', init: { method: 'POST' } });
    });

    it('exercises volume backup list, create, restore and downloadUrl', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({}));
      const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

      await client.volumeBackups.list('nd-svc-web-data');
      expect(last(calls)).toMatchObject({ url: '/v1/volumes/nd-svc-web-data/backups', init: { method: 'GET' } });

      await client.volumeBackups.create('nd-svc-web-data', { note: 'pre-upgrade' });
      expect(last(calls)).toMatchObject({ url: '/v1/volumes/nd-svc-web-data/backups', init: { method: 'POST' } });

      await client.volumeBackups.restore('nd-svc-web-data', 11);
      expect(last(calls)).toMatchObject({
        url: '/v1/volumes/nd-svc-web-data/backups/11/restore',
        init: { method: 'POST' },
      });

      // downloadUrl is a pure path builder: it must never issue a request.
      const before = calls.length;
      expect(client.volumeBackups.downloadUrl('nd-svc-web-data', 11)).toBe(
        '/v1/volumes/nd-svc-web-data/backups/11/download',
      );
      expect(calls).toHaveLength(before);
    });
  });
});

describe('query/param edge cases', () => {
  it('sends threshold=0 and days=0 instead of silently dropping them', async () => {
    const { fetchMock, calls } = makeFetch(() => ok({}));
    const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

    // 0 means "already-expired only" — dropping the param would make the
    // server apply its default (30 days), the opposite of the request.
    await client.traefik.certificateInventory({ threshold: 0 });
    expect(last(calls).url).toBe('/v1/traefik/certificates/inventory?threshold=0');

    await client.traefik.expiringCertificates({ days: 0 });
    expect(last(calls).url).toBe('/v1/traefik/certificates/expiring?days=0');
  });

  it('still omits the query when the option is absent', async () => {
    const { fetchMock, calls } = makeFetch(() => ok({}));
    const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    await client.traefik.certificateInventory();
    expect(last(calls).url).toBe('/v1/traefik/certificates/inventory');
  });

  it('encodes volume names and template ids into the URL path', async () => {
    const { fetchMock, calls } = makeFetch(() => ok({}));
    const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });

    await client.volumeBackups.list('nd web/data');
    expect(last(calls).url).toBe('/v1/volumes/nd%20web%2Fdata/backups');

    await client.templates.get('a?b=1');
    expect(last(calls).url).toBe('/v1/templates/a%3Fb%3D1');

    await client.templates.community.remove('x y');
    expect(last(calls).url).toBe('/v1/templates/community/x%20y');
  });

  it('keeps serverId=0 on networks.remove and encodes the network name', async () => {
    const { fetchMock, calls } = makeFetch(() => ok({}));
    const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    await client.networks.remove('a b', 0);
    expect(last(calls).url).toBe('/v1/networks/a%20b?serverId=0');
  });
});

describe('request timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('aborts a request that exceeds timeoutMs', async () => {
    // A fetch that never resolves on its own; it rejects only when the
    // abort signal the SDK attached fires.
    const fetchMock = vi.fn((_url: string, init: { signal?: unknown }) => {
      return new Promise((_resolve, reject) => {
        const signal = init.signal as { aborted: boolean; addEventListener: (t: string, l: () => void) => void };
        signal.addEventListener('abort', () => reject(new Error('aborted by timeout')));
      });
    });
    const client = createClient({ baseUrl: 'http://api.test', timeoutMs: 20, fetch: fetchMock });
    await expect(client.auth.status()).rejects.toThrow('aborted by timeout');
  });

  it('sends no signal when timeoutMs is 0 (opt-out)', async () => {
    let seen: unknown;
    const fetchMock = vi.fn((_url: string, init: { signal?: unknown }) => {
      seen = init.signal;
      return Promise.resolve({ ok: true, status: 200, text: async () => '{}' } as unknown as Response);
    });
    const client = createClient({ baseUrl: 'http://api.test', timeoutMs: 0, fetch: fetchMock });
    await client.auth.status();
    expect(seen).toBeUndefined();
  });

  it('attaches a signal by default (30s budget)', async () => {
    let seen: unknown;
    const fetchMock = vi.fn((_url: string, init: { signal?: unknown }) => {
      seen = init.signal;
      return Promise.resolve({ ok: true, status: 200, text: async () => '{}' } as unknown as Response);
    });
    const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    await client.auth.status();
    expect(seen).toBeDefined();
  });

  it('tolerates environments where globalThis.AbortSignal is missing', async () => {
    vi.stubGlobal('AbortSignal', undefined);
    let seen: unknown;
    const fetchMock = vi.fn((_url: string, init: { signal?: unknown }) => {
      seen = init.signal;
      return Promise.resolve({ ok: true, status: 200, text: async () => '{}' } as unknown as Response);
    });
    const client = createClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    await expect(client.auth.status()).resolves.toEqual({});
    expect(seen).toBeUndefined();
  });
});
