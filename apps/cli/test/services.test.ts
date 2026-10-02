import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  servicesCompose,
  servicesCreate,
  servicesDelete,
  servicesDeploy,
  servicesExport,
  servicesGet,
  servicesInspect,
  servicesLifecycle,
  servicesList,
  servicesLogs,
  servicesSticky,
  servicesStickyAction,
} from '../src/commands/services.js';

const h = vi.hoisted(() => {
  class NineDeployError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    NineDeployError,
    prompt: vi.fn(),
    writeFileSync: vi.fn(),
    loadConfig: vi.fn(),
  };
});

vi.mock('@ninedeploy/sdk', () => ({ NineDeployError: h.NineDeployError }));
vi.mock('../src/prompts.js', () => ({ prompt: h.prompt }));
vi.mock('../src/config.js', () => ({ loadConfig: h.loadConfig, saveConfig: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  writeFileSync: h.writeFileSync,
}));

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let fetchMock: ReturnType<typeof vi.fn>;

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    services: {
      list: vi.fn(),
      create: vi.fn(),
      get: vi.fn(),
      logs: vi.fn(),
      stop: vi.fn(),
      start: vi.fn(),
      restart: vi.fn(),
      remove: vi.fn(),
    },
    containers: {
      compose: vi.fn(),
      inspect: vi.fn(),
    },
    deploys: { trigger: vi.fn() },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = 0;
  h.prompt.mockResolvedValue('');
  fetchMock = vi.fn().mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue('{"data":1}') });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('servicesList', () => {
  it('prints a hint when there are no services', async () => {
    const client = makeClient({ services: { list: vi.fn().mockResolvedValue([]) } });

    await servicesList(client);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No services yet.'));
  });

  it('tables services, defaulting a missing port', async () => {
    const list = vi.fn().mockResolvedValue([
      { id: 1, name: 'api', type: 'docker', status: 'running', port: 3000, updatedAt: '2026-01-01T00:00:00Z' },
      { id: 2, name: 'web', type: 'git', status: 'stopped', port: null, updatedAt: '2026-01-02T00:00:00Z' },
    ]);
    const client = makeClient({ services: { list } });

    await servicesList(client);

    expect(list).toHaveBeenCalledOnce();
    const text = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(text).toContain('api');
    expect(text).toContain('3000');
    expect(text).toContain('—');
  });
});

describe('servicesCreate', () => {
  it('requires a name', async () => {
    h.prompt.mockResolvedValueOnce('');

    await servicesCreate(makeClient(), undefined as never);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Name is required'));
    expect(process.exitCode).toBe(1);
  });

  it('creates from a git repo and deploys when confirmed', async () => {
    const create = vi.fn().mockResolvedValue({ id: 7, name: 'api' });
    const trigger = vi.fn().mockResolvedValue({ deploymentId: 12 });
    const client = makeClient({ services: { create }, deploys: { trigger } });
    h.prompt
      .mockResolvedValueOnce('api') // name
      .mockResolvedValueOnce('1') // repo mode
      .mockResolvedValueOnce('https://github.com/acme/api') // repo url
      .mockResolvedValueOnce('main') // branch
      .mockResolvedValueOnce('') // port
      .mockResolvedValueOnce('') // publishedPort
      .mockResolvedValueOnce('') // volume
      .mockResolvedValueOnce('y'); // deploy now

    await servicesCreate(client);

    expect(create).toHaveBeenCalledWith({
      name: 'api',
      type: 'docker',
      repoUrl: 'https://github.com/acme/api',
      image: undefined,
      branch: 'main',
      port: undefined,
      publishedPort: undefined,
      volumeMount: undefined,
    });
    expect(trigger).toHaveBeenCalledWith(7);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Service "api" created'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Deployment #12 queued'));
  });

  it('requires a repo url in git mode', async () => {
    h.prompt.mockResolvedValueOnce('api').mockResolvedValueOnce('1').mockResolvedValueOnce('');

    await servicesCreate(makeClient(), undefined as never);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Repository URL is required'));
  });

  it('creates from a docker image and skips deployment when declined', async () => {
    const create = vi.fn().mockResolvedValue({ id: 3, name: 'img' });
    const trigger = vi.fn();
    const client = makeClient({ services: { create }, deploys: { trigger } });
    h.prompt
      .mockResolvedValueOnce('img') // name
      .mockResolvedValueOnce('2') // docker mode
      .mockResolvedValueOnce('nginx:alpine') // image
      .mockResolvedValueOnce('80') // port
      .mockResolvedValueOnce('8080') // publishedPort
      .mockResolvedValueOnce('/data') // volume
      .mockResolvedValueOnce('n'); // deploy now

    await servicesCreate(client);

    expect(create).toHaveBeenCalledWith({
      name: 'img',
      type: 'docker',
      repoUrl: undefined,
      image: 'nginx:alpine',
      branch: 'main',
      port: 80,
      publishedPort: 8080,
      volumeMount: '/data',
    });
    expect(trigger).not.toHaveBeenCalled();
  });

  it('requires an image in docker mode', async () => {
    h.prompt.mockResolvedValueOnce('img').mockResolvedValueOnce('2').mockResolvedValueOnce('');

    await servicesCreate(makeClient(), undefined as never);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Image is required'));
  });

  it('reports a NineDeployError from the client', async () => {
    const create = vi.fn().mockRejectedValue(new h.NineDeployError(409, 'conflict'));
    h.prompt
      .mockResolvedValueOnce('api')
      .mockResolvedValueOnce('1')
      .mockResolvedValueOnce('https://github.com/acme/api')
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('y');

    await servicesCreate(makeClient({ services: { create } }), undefined as never);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('conflict'));
    expect(process.exitCode).toBe(1);
  });

  it('reports a generic Error from the client', async () => {
    const create = vi.fn().mockRejectedValue(new Error('network down'));
    h.prompt
      .mockResolvedValueOnce('api')
      .mockResolvedValueOnce('1')
      .mockResolvedValueOnce('https://github.com/acme/api')
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('y');

    await servicesCreate(makeClient({ services: { create } }), undefined as never);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('network down'));
  });
});

describe('servicesGet', () => {
  it('requires a numeric service id', async () => {
    await servicesGet(makeClient(), 'abc');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('prints every detail field', async () => {
    const get = vi.fn().mockResolvedValue({
      id: 1,
      name: 'api',
      slug: 'api',
      type: 'docker',
      status: 'running',
      repoUrl: 'https://github.com/acme/api',
      branch: 'main',
      image: 'nginx',
      port: 3000,
      publishedPort: 8080,
      volumeMount: '/data',
      healthPath: '/health',
      runtimeId: 'rt-1',
      commitSha: 'abc123',
      autoUrl: 'api.example.com',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    });
    const client = makeClient({ services: { get } });

    await servicesGet(client, '17');

    expect(get).toHaveBeenCalledWith(17);
    const text = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(text).toContain('api');
    expect(text).toContain(':8080');
    expect(text).toContain('http://api.example.com');
  });

  it('prints dashes for missing fields and skips the URL when absent', async () => {
    const get = vi.fn().mockResolvedValue({
      id: 2,
      name: 'web',
      slug: 'web',
      type: 'git',
      status: 'weird',
      repoUrl: null,
      branch: 'main',
      image: null,
      port: null,
      volumeMount: null,
      healthPath: '/',
      runtimeId: null,
      commitSha: null,
      autoUrl: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const client = makeClient({ services: { get } });

    await servicesGet(client, '17');

    const text = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(text).toContain('—');
    expect(text).not.toContain('http://');
  });
});

describe('servicesDeploy', () => {
  it('requires a numeric service id', async () => {
    await servicesDeploy(makeClient(), '0');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('triggers a deployment', async () => {
    const trigger = vi.fn().mockResolvedValue({ deploymentId: 5 });
    const client = makeClient({ deploys: { trigger } });

    await servicesDeploy(client, '3');

    expect(trigger).toHaveBeenCalledWith(3);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Deployment #5 queued.'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ninedeploy services logs 3'));
  });

  it('reports a failure', async () => {
    const client = makeClient({ deploys: { trigger: vi.fn().mockRejectedValue(new Error('denied')) } });

    await servicesDeploy(client, '3');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('denied'));
  });

  it('reports a non-Error rejection', async () => {
    const client = makeClient({ deploys: { trigger: vi.fn().mockRejectedValue('boom') } });

    await servicesDeploy(client, '3');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

describe('servicesLogs', () => {
  it('requires a numeric service id', async () => {
    await servicesLogs(makeClient(), 'x');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('prints a notice for empty logs', async () => {
    const client = makeClient({ services: { logs: vi.fn().mockResolvedValue({ lines: '   ' }) } });

    await servicesLogs(client, '9');

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No logs yet.'));
  });

  it('prints the log lines', async () => {
    const client = makeClient({ services: { logs: vi.fn().mockResolvedValue({ lines: 'line one\nline two' }) } });

    await servicesLogs(client, '9');

    const text = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(text).toContain('line one');
    expect(text).toContain('line two');
  });

  it('reports a failure', async () => {
    const client = makeClient({ services: { logs: vi.fn().mockRejectedValue(new Error('gone')) } });

    await servicesLogs(client, '9');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('gone'));
  });

  it('reports a non-Error rejection', async () => {
    const client = makeClient({ services: { logs: vi.fn().mockRejectedValue('boom') } });

    await servicesLogs(client, '9');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

describe('servicesLifecycle', () => {
  it('requires a numeric service id', async () => {
    await servicesLifecycle(makeClient(), 'stop', 'abc');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('services stop <id>'));
  });

  it.each(['stop', 'start', 'restart'])('%s a service', async (action) => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ services: { [action]: fn } });

    await servicesLifecycle(client, action as 'stop', '4');

    expect(fn).toHaveBeenCalledWith(4);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`Service ${action}ed.`));
  });

  it('reports a failure', async () => {
    const client = makeClient({ services: { stop: vi.fn().mockRejectedValue(new Error('refused')) } });

    await servicesLifecycle(client, 'stop', '4');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('refused'));
  });

  it('reports a non-Error rejection', async () => {
    const client = makeClient({ services: { start: vi.fn().mockRejectedValue('boom') } });

    await servicesLifecycle(client, 'start', '4');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

describe('servicesDelete', () => {
  it('requires a numeric service id', async () => {
    await servicesDelete(makeClient(), '');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('cancels when the confirmation does not match', async () => {
    h.prompt.mockResolvedValueOnce('999');

    await servicesDelete(makeClient(), '5');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Cancelled.'));
  });

  it('deletes after confirmation', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    h.prompt.mockResolvedValueOnce('5');

    await servicesDelete(makeClient({ services: { remove } }), '5');

    expect(remove).toHaveBeenCalledWith(5);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Service deleted.'));
  });

  it('reports a failure', async () => {
    h.prompt.mockResolvedValueOnce('6');
    const client = makeClient({ services: { remove: vi.fn().mockRejectedValue(new Error('locked')) } });

    await servicesDelete(client, '6');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('locked'));
  });

  it('reports a non-Error rejection', async () => {
    h.prompt.mockResolvedValueOnce('6');
    const client = makeClient({ services: { remove: vi.fn().mockRejectedValue('boom') } });

    await servicesDelete(client, '6');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

describe('servicesExport', () => {
  it('requires a numeric service id', async () => {
    await servicesExport(makeClient(), 'no');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('downloads and writes the export when no token is configured', async () => {
    h.loadConfig.mockReturnValue({ baseUrl: 'http://localhost:3000' });
    const get = vi.fn().mockResolvedValue({ slug: 'api' });
    const client = makeClient({ services: { get } });

    await servicesExport(client, '7');

    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:3000/v1/services/7/export');
    expect((fetchMock.mock.calls[0]![1] as { headers: Headers }).headers.has('Authorization')).toBe(false);
    expect(h.writeFileSync).toHaveBeenCalledWith('api-export.json', '{"data":1}');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Exported to api-export.json'));
  });

  it('includes a token when the config has one', async () => {
    h.loadConfig.mockReturnValue({ baseUrl: 'http://srv:3000', token: 'tok' });
    const client = makeClient({
      services: { get: vi.fn().mockResolvedValue({ slug: 'api' }) },
    });

    await servicesExport(client, '7');

    expect(fetchMock.mock.calls[0]![0]).toBe('http://srv:3000/v1/services/7/export');
    expect((fetchMock.mock.calls[0]![1] as { headers: Headers }).headers.get('Authorization')).toBe('Bearer tok');
  });

  // r550: was a bare fetch with the saved bearer — no refresh on 401 and a
  // sub-path base URL (`https://host/panel`) lost its prefix.
  it('refreshes an expired token on 401 and retries the export once', async () => {
    let cfg: Record<string, string> = { baseUrl: 'https://host.test/panel/', token: 'stale', refreshToken: 'rt' };
    h.loadConfig.mockImplementation(() => cfg);
    const { saveConfig } = await import('../src/config.js');
    vi.mocked(saveConfig).mockImplementation((next) => { cfg = next as Record<string, string>; });
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ tokens: { accessToken: 'fresh', refreshToken: 'rt2' } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: vi.fn().mockResolvedValue('{"data":2}') });
    const client = makeClient({ services: { get: vi.fn().mockResolvedValue({ slug: 'api' }) } });

    await servicesExport(client, '7');

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://host.test/panel/v1/services/7/export',
      'https://host.test/panel/v1/auth/refresh',
      'https://host.test/panel/v1/services/7/export',
    ]);
    expect((fetchMock.mock.calls[2]![1] as { headers: Headers }).headers.get('Authorization')).toBe('Bearer fresh');
    expect(h.writeFileSync).toHaveBeenCalledWith('api-export.json', '{"data":2}');
  });

  it('reports an HTTP error instead of writing the error body as the export', async () => {
    h.loadConfig.mockReturnValue({ baseUrl: 'http://srv:3000', token: 'tok' });
    const client = makeClient({
      services: { get: vi.fn().mockResolvedValue({ slug: 'api' }) },
    });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: vi.fn().mockResolvedValue('{"error":{}}') });

    await servicesExport(client, '7');

    expect(h.writeFileSync).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('HTTP 404'));
  });

  it('reports a fetch failure', async () => {
    h.loadConfig.mockReturnValue({ baseUrl: 'http://localhost:3000' });
    fetchMock.mockRejectedValue(new Error('offline'));
    const client = makeClient({ services: { get: vi.fn().mockResolvedValue({ slug: 'api' }) } });

    await servicesExport(client, '7');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });

  it('reports a non-Error fetch rejection', async () => {
    h.loadConfig.mockReturnValue({ baseUrl: 'http://localhost:3000' });
    fetchMock.mockRejectedValue('boom');
    const client = makeClient({ services: { get: vi.fn().mockResolvedValue({ slug: 'api' }) } });

    await servicesExport(client, '7');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

describe('servicesCompose', () => {
  it('guards against invalid id', async () => {
    const client = makeClient();
    await servicesCompose(client, 'abc');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: ninedeploy services compose <id>'));
  });

  it('fetches and prints generated Docker Compose manifest', async () => {
    const get = vi.fn().mockResolvedValue({ slug: 'web', runtimeId: 'nd-svc-web-1' });
    const compose = vi.fn().mockResolvedValue({
      yaml: 'services:\n  nd-svc-web-1:\n    image: node:20',
      inspect: { name: 'nd-svc-web-1' },
    });
    const client = makeClient({ services: { get }, containers: { compose } });

    await servicesCompose(client, '3');

    expect(get).toHaveBeenCalledWith(3);
    expect(compose).toHaveBeenCalledWith('nd-svc-web-1');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('services:'));
  });

  it('falls back to default container name when runtimeId is absent in servicesCompose', async () => {
    const get = vi.fn().mockResolvedValue({ slug: 'api', runtimeId: null });
    const compose = vi.fn().mockResolvedValue({ yaml: 'services:\n  nd-svc-api-1:', inspect: {} });
    const client = makeClient({ services: { get }, containers: { compose } });

    await servicesCompose(client, '4');

    expect(compose).toHaveBeenCalledWith('nd-svc-api-1');
  });

  it('handles compose errors gracefully', async () => {
    const get = vi.fn().mockRejectedValue(new Error('service not found'));
    const client = makeClient({ services: { get } });

    await servicesCompose(client, '3');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('service not found'));
  });

  it('handles non-Error compose rejections', async () => {
    const get = vi.fn().mockRejectedValue('compose failed');
    const client = makeClient({ services: { get } });

    await servicesCompose(client, '3');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('compose failed'));
  });
});

describe('servicesInspect', () => {
  it('guards against invalid id', async () => {
    const client = makeClient();
    await servicesInspect(client, '0');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: ninedeploy services inspect <id>'));
  });

  it('fetches and prints container inspect metadata and traefik tags', async () => {
    const get = vi.fn().mockResolvedValue({ slug: 'web', runtimeId: null });
    const inspect = vi.fn().mockResolvedValue({
      id: 'cid123',
      name: 'nd-svc-web-1',
      image: 'node:20-alpine',
      state: { status: 'running', running: true },
      resources: { memoryLimitBytes: 536870912, cpuShares: 512, restartPolicy: 'unless-stopped' },
      traefikTags: {
        'traefik.enable': 'true',
        'traefik.http.routers.web.rule': 'Host(`web.dev`)',
      },
    });
    const client = makeClient({ services: { get }, containers: { inspect } });

    await servicesInspect(client, '5');

    expect(get).toHaveBeenCalledWith(5);
    expect(inspect).toHaveBeenCalledWith('nd-svc-web-1');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('512 MB'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Host(`web.dev`)'));
  });

  it('handles stopped container with zero resource limits and empty traefik tags', async () => {
    const get = vi.fn().mockResolvedValue({ slug: 'api', runtimeId: 'nd-svc-api-1' });
    const inspect = vi.fn().mockResolvedValue({
      id: 'cid456',
      name: 'nd-svc-api-1',
      image: 'node:20',
      state: { status: 'stopped', running: false },
      resources: { memoryLimitBytes: 0, cpuShares: 0, restartPolicy: 'no' },
      traefikTags: {},
    });
    const client = makeClient({ services: { get }, containers: { inspect } });

    await servicesInspect(client, '6');

    expect(get).toHaveBeenCalledWith(6);
    expect(inspect).toHaveBeenCalledWith('nd-svc-api-1');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('false'));
  });

  it('handles inspect errors gracefully', async () => {
    const get = vi.fn().mockRejectedValue(new Error('container down'));
    const client = makeClient({ services: { get } });

    await servicesInspect(client, '5');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('container down'));
  });

  it('handles non-Error inspect rejections', async () => {
    const get = vi.fn().mockRejectedValue('inspect failed');
    const client = makeClient({ services: { get } });

    await servicesInspect(client, '5');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('inspect failed'));
  });
});

describe('servicesSticky', () => {
  it('requires a numeric service id', async () => {
    await expect(servicesSticky(makeClient(), 'abc', { enable: true })).rejects.toThrow(/Usage:/);
  });

  it('requires one of --enable or --disable', async () => {
    await expect(servicesSticky(makeClient(), '5', {})).rejects.toThrow(/Specify either/);
  });

  it('refuses both --enable and --disable together', async () => {
    await expect(servicesSticky(makeClient(), '5', { enable: true, disable: true })).rejects.toThrow(/only one/);
  });

  it('forwards the toggle to client.domains.setStickySession', async () => {
    const setStickySession = vi.fn().mockResolvedValue({ id: 5, enabled: true, active: true });
    const client = makeClient({ domains: { setStickySession } });
    await servicesSticky(client, '5', { enable: true });
    expect(setStickySession).toHaveBeenCalledWith(5, true);
  });
});

describe('servicesStickyAction', () => {
  it('prints success and exitCode=0 on enable', async () => {
    const setStickySession = vi.fn().mockResolvedValue({ id: 5, enabled: true, active: true });
    const client = makeClient({ domains: { setStickySession } });
    await servicesStickyAction(client, '5', { enable: true });
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Sticky session enabled/));
    expect(process.exitCode).toBe(0);
  });

  it('prints success on disable', async () => {
    const setStickySession = vi.fn().mockResolvedValue({ id: 5, enabled: false, active: false });
    const client = makeClient({ domains: { setStickySession } });
    await servicesStickyAction(client, '5', { disable: true });
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Sticky session disabled/));
    expect(process.exitCode).toBe(0);
  });

  it('surfaces a thrown error and sets exitCode=1', async () => {
    const setStickySession = vi.fn().mockRejectedValue(new Error('network error'));
    const client = makeClient({ domains: { setStickySession } });
    await servicesStickyAction(client, '5', { enable: true });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('network error'));
    expect(process.exitCode).toBe(1);
  });

  it('falls back to String() when a non-Error is rejected', async () => {
    const setStickySession = vi.fn().mockRejectedValue('plain failure');
    const client = makeClient({ domains: { setStickySession } });
    await servicesStickyAction(client, '5', { enable: true });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('plain failure'));
    expect(process.exitCode).toBe(1);
  });
});
