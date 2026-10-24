import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ call: vi.fn(), transport: vi.fn(), hostname: vi.fn() }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), hostname: h.hostname }));
vi.mock('../../src/lib/dockerTty.js', async original => ({ ...await original<typeof import('../../src/lib/dockerTty.js')>(), engineCall: h.call, dockerTransport: h.transport }));
import { DockerEngineError } from '../../src/lib/dockerTty.js';
import { startNodeStudio, stopNodeStudio, clearNodeStudio, resolveNodeStudioHttpTarget } from '../../src/lib/nodeStudioRuntime.js';

const DB = 'a'.repeat(64), NET = 'b'.repeat(64), HELPER = 'd'.repeat(64), IMAGE = 'sha256:' + 'c'.repeat(64);
type Raw = Record<string, any>;
let database: Raw, network: Raw, helper: Raw | null, createBody: Raw | undefined;
let lostCreate: boolean, refuseCleanup: boolean, nextHelperId: string;
const ensureImage = vi.fn(), probe = vi.fn();
const input = { databaseId: 7, slug: 'orders', engine: 'postgres' as const };
const deps = () => ({ ensureImage, probe });
const response = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });
beforeEach(() => {
  h.hostname.mockReturnValue('native-node');
  h.call.mockReset(); h.transport.mockReset().mockReturnValue({ kind: 'socket', socketPath: '/owned.sock' });
  ensureImage.mockReset().mockResolvedValue(undefined); probe.mockReset().mockResolvedValue(true);
  helper = null; createBody = undefined; lostCreate = false; refuseCleanup = false; nextHelperId = HELPER;
  database = { Id: DB, Name: '/nd-db-orders', State: { Running: true }, Config: { Labels: { 'ninedeploy.managed': 'database', 'ninedeploy.database.id': '7', 'ninedeploy.database.slug': 'orders' } }, NetworkSettings: { Networks: { 'nd-dbnet-orders': { NetworkID: NET, IPAddress: '172.31.0.2' } } } };
  network = { Id: NET, Name: 'nd-dbnet-orders', Driver: 'bridge', Scope: 'local' };
  h.call.mockImplementation(async (_transport, method: string, raw: string, body?: Raw) => {
    const path = decodeURIComponent(raw);
    if (method === 'GET' && path.startsWith('/images/')) return response({ Id: IMAGE });
    if (method === 'GET' && path.startsWith('/networks/')) return response(network);
    if (method === 'GET' && path.startsWith('/containers/')) {
      const name = path.slice('/containers/'.length, -'/json'.length);
      if (name === 'nd-db-orders') return response(database);
      return helper && [helper.Id, 'nd-node-studio-7'].includes(name) ? response(helper) : response({}, 404);
    }
    if (method === 'POST' && path.startsWith('/containers/create')) {
      createBody = body;
      helper = { Id: nextHelperId, Name: '/nd-node-studio-7', Image: body!.Image, Config: { Labels: body!.Labels, Env: body!.Env }, HostConfig: body!.HostConfig,
        State: { Running: false }, NetworkSettings: { Networks: { 'nd-dbnet-orders': { NetworkID: NET, IPAddress: '172.31.0.7' } } } };
      if (lostCreate) throw new Error('lost create reply');
      return response({ Id: nextHelperId }, 201);
    }
    if (method === 'POST' && path === `/containers/${helper?.Id}/start`) { helper!.State.Running = true; return response({}, 204); }
    if (method === 'DELETE' && path === `/containers/${helper?.Id}?force=1&v=1`) {
      if (refuseCleanup) throw new DockerEngineError(409, 'removal pending');
      helper = null; return response({}, 204);
    }
    throw new Error('Unexpected fake Docker boundary: ' + method + ' ' + path);
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('managed node Studio lifecycle', () => {
  it('makes the default bridge agent ready through an owned private connection, and removes that connection on stop', async () => {
    vi.stubEnv('NINEDEPLOY_AGENT', '1');
    const selfId = 'f'.repeat(64), hostname = selfId.slice(0, 12);
    h.hostname.mockReturnValue(hostname);
    const networks: Raw = { bridge: { NetworkID: '9'.repeat(64), GwPriority: 0 } };
    const self = { Id: selfId, State: { Running: true }, Config: { Hostname: hostname, Env: ['NINEDEPLOY_AGENT=1'] }, HostConfig: { NetworkMode: 'bridge' }, NetworkSettings: { Networks: networks } };
    const boundary = h.call.getMockImplementation()!;
    h.call.mockImplementation(async (transport, method, path, body, ...rest) => {
      if (method === 'GET' && [hostname, selfId].some(id => path === `/containers/${id}/json`)) return response(self);
      if (path === '/version') return response({ ApiVersion: '1.48' });
      if (path === `/networks/${NET}/connect`) { networks['nd-dbnet-orders'] = { NetworkID: NET, ...body.EndpointConfig }; return response({}); }
      if (path === `/networks/${NET}/disconnect`) { delete networks['nd-dbnet-orders']; return response({}); }
      return boundary(transport, method, path, body, ...rest);
    });
    probe.mockImplementation(async () => networks['nd-dbnet-orders']?.NetworkID === NET);
    const identity = await startNodeStudio(input, deps());
    expect(networks['nd-dbnet-orders'].Aliases).toContain('nd-studio-agent-db-7');
    await stopNodeStudio(identity); expect(helper).toBeNull();
    expect(Object.keys(networks)).toEqual(['bridge']);
    // A lost preparation receipt can leave the helper absent but its owned
    // endpoint present. Resource-only clear must still remove that endpoint.
    networks['nd-dbnet-orders'] = { NetworkID: NET, Aliases: ['nd-studio-agent-db-7'], GwPriority: -1 };
    expect(await clearNodeStudio(input)).toBeNull(); expect(Object.keys(networks)).toEqual(['bridge']);
  });
  it('starts a pinned SQL helper only on the verified private database bridge, with no published ports', async () => {
    const identity = await startNodeStudio(input, deps());
    expect(identity).toMatchObject({ databaseId: 7, slug: 'orders', engine: 'postgres', containerId: HELPER, databaseContainerId: DB, networkId: NET, imageId: IMAGE });
    expect(createBody).toMatchObject({ Image: IMAGE, Env: ['ADMINER_DEFAULT_SERVER=nd-db-orders'],
      HostConfig: { NetworkMode: NET, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], PortBindings: {}, PublishAllPorts: false },
      NetworkingConfig: { EndpointsConfig: { 'nd-dbnet-orders': { NetworkID: NET } } },
    });
    expect(createBody!.HostConfig.Binds).toBeUndefined(); expect(createBody!.HostConfig.Privileged).toBeUndefined();
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ address: '172.31.0.7', port: 8080 }), '/');
    const target = await resolveNodeStudioHttpTarget(identity); await expect(target.verify()).resolves.toBeUndefined();
  });
  it.each(['mysql', 'mariadb'] as const)('keeps the shared SQL image and default server for %s', async engine => {
    await startNodeStudio({ ...input, engine }, deps());
    expect(ensureImage).toHaveBeenCalledWith('adminer:6.0.1', expect.any(Function));
    expect(createBody!.Env).toEqual(['ADMINER_DEFAULT_SERVER=nd-db-orders']);
  });
  it.each(['redis', 'valkey', 'keydb', 'dragonfly'] as const)('configures the actual %s image with JSON credentials and its proxy subpath', async engine => {
    const password = 'fixture/@:,%value';
    await startNodeStudio({ ...input, engine, password }, deps());
    const configured = createBody!.Env.find((value: string) => value.startsWith('NODE_CONFIG='));
    expect(configured).toBeDefined();
    expect(JSON.parse(configured.slice('NODE_CONFIG='.length))).toMatchObject({ connections: [{ label:'orders', host:'nd-db-orders', port:6379, dbIndex:0, username:'default', password }] });
    expect(createBody!.Env).toContain('URL_PREFIX=/v1/databases/7/studio-proxy');
    expect(ensureImage.mock.calls[0]![0]).toContain('@sha256:');
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ port: 8081 }), '/v1/databases/7/studio-proxy/');
  });
  it('replaces an owned old KV helper with ignored configuration and then reuses the correct configuration', async () => {
    const spec = { ...input,engine:'redis' as const,password:'fixture/@,:password' };
    const first = await startNodeStudio(spec,deps());
    expect(await startNodeStudio({...spec,previous:first},deps())).toEqual(first);
    helper!.Config.Env=['REDIS_URL=ignored'];nextHelperId='e'.repeat(64);
    const corrected=await startNodeStudio({...spec,previous:first},deps());expect(corrected.containerId).toBe(nextHelperId);
    expect(await startNodeStudio({...spec,previous:corrected},deps())).toEqual(corrected);
    expect(h.call.mock.calls.filter(call=>call[1]==='POST'&&call[2].startsWith('/containers/create'))).toHaveLength(2);
  });
  it('refuses missing KV credentials and unexpected execution operands before Docker IO', async () => {
    await expect(startNodeStudio({ ...input, engine: 'redis' }, deps())).rejects.toMatchObject({ statusCode: 422 });
    await expect(startNodeStudio({ ...input, cmd: ['sh'] } as never, deps())).rejects.toThrow();
    expect(h.call).not.toHaveBeenCalled(); expect(ensureImage).not.toHaveBeenCalled();
  });
  it.each(['NINEDEPLOY_AGENT_DATABASES', 'NINEDEPLOY_AGENT_DATABASE_STUDIOS'])('honors owner switch %s before Docker IO', async variable => {
    vi.stubEnv(variable, 'off'); await expect(startNodeStudio(input, deps())).rejects.toMatchObject({ statusCode: 403 }); expect(h.call).not.toHaveBeenCalled();
  });
  it('requires the Engine API transport', async () => {
    h.transport.mockReturnValue({ kind: 'cli', reason: 'unsupported' });
    await expect(startNodeStudio(input, deps())).rejects.toMatchObject({ statusCode: 422 }); expect(h.call).not.toHaveBeenCalled();
  });
  it.each(['stopped', 'other-database', 'service-label', 'other-network', 'foreign-network-name'])('refuses %s before creating a helper', async kind => {
    if (kind === 'stopped') database.State.Running = false;
    if (kind === 'other-database') database.Config.Labels['ninedeploy.database.id'] = '8';
    if (kind === 'service-label') database.Config.Labels['ninedeploy.managed'] = 'service';
    if (kind === 'other-network') network.Id = 'e'.repeat(64);
    if (kind === 'foreign-network-name') network.Name = 'other';
    await expect(startNodeStudio(input, deps())).rejects.toMatchObject({ statusCode: 409 });
    expect(createBody).toBeUndefined();
  });
  it('returns a controlled conflict for a foreign container at the helper name without removing it', async () => {
    helper = { Id: HELPER, Name: '/nd-node-studio-7', Image: IMAGE, State: { Running: true }, Config: { Labels: { 'ninedeploy.managed': 'service' } } };
    await expect(startNodeStudio(input, deps())).rejects.toMatchObject({ statusCode: 409, code: 'node_studio_identity_changed' });
    expect(h.call.mock.calls.some(call => call[1] === 'DELETE')).toBe(false);
  });
  it('reuses the same managed ID idempotently, including concurrent starts', async () => {
    const [a, b] = await Promise.all([startNodeStudio(input, deps()), startNodeStudio(input, deps())]);
    expect(a).toEqual(b); expect(h.call.mock.calls.filter(call => call[1] === 'POST' && call[2].startsWith('/containers/create'))).toHaveLength(1);
    expect(await startNodeStudio({ ...input, previous: a }, deps())).toEqual(a);
  });
  it('refuses an identically labelled replacement when the panel recorded another immutable ID', async () => {
    const identity = await startNodeStudio(input, deps()); helper!.Id = 'e'.repeat(64);
    await expect(startNodeStudio({ ...input, previous: identity }, deps())).rejects.toMatchObject({ statusCode: 409 });
    expect(h.call.mock.calls.some(call => call[1] === 'DELETE')).toBe(false);
  });
  it.each(['database-id', 'network-id', 'helper-id', 'ip', 'published-port', 'bind', 'extra-network', 'privileged'])('refuses changed %s at request/connection verification', async kind => {
    const identity = await startNodeStudio(input, deps()), target = await resolveNodeStudioHttpTarget(identity);
    if (kind === 'database-id') database.Id = 'e'.repeat(64);
    if (kind === 'network-id') network.Id = 'e'.repeat(64);
    if (kind === 'helper-id') helper!.Id = 'e'.repeat(64);
    if (kind === 'ip') helper!.NetworkSettings.Networks['nd-dbnet-orders'].IPAddress = '172.31.0.8';
    if (kind === 'published-port') helper!.HostConfig.PortBindings = { '8080/tcp': [{ HostPort: '18000' }] };
    if (kind === 'bind') helper!.HostConfig.Binds = ['/host:/data'];
    if (kind === 'extra-network') helper!.NetworkSettings.Networks.other = { NetworkID: NET, IPAddress: '10.0.0.2' };
    if (kind === 'privileged') helper!.HostConfig.Privileged = true;
    await expect(target.verify()).rejects.toMatchObject({ statusCode: 409 });
  });
  it('stops only the recorded ID, including after its database stopped', async () => {
    const identity = await startNodeStudio(input, deps()); database.State.Running = false;
    await stopNodeStudio(identity); expect(helper).toBeNull();
    await expect(stopNodeStudio(identity)).resolves.toBeUndefined();
  });
  it('clears a recovered helper and confirms absence idempotently without requiring the database to run', async () => {
    await startNodeStudio(input, deps()); database.State.Running = false;
    expect(await clearNodeStudio(input)).toBe(HELPER); expect(helper).toBeNull();
    expect(await clearNodeStudio(input)).toBeNull();
  });
  it('waits for an in-flight preparation before confirming clear, with no late helper', async () => {
    let finish!: () => void;
    ensureImage.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const starting = startNodeStudio(input, deps());
    await vi.waitFor(() => expect(ensureImage).toHaveBeenCalled());
    const clearing = clearNodeStudio(input);
    finish(); await starting;
    expect(await clearing).toBe(HELPER); expect(helper).toBeNull();
    expect(await clearNodeStudio(input)).toBeNull();
  });
  it.each(['foreign-label', 'nonce', 'wrong-resource', 'image'])('refuses to clear a helper with changed %s', async kind => {
    await startNodeStudio(input, deps());
    if (kind === 'foreign-label') helper!.Config.Labels['ninedeploy.managed'] = 'service';
    if (kind === 'nonce') helper!.Config.Labels['ninedeploy.studio.nonce'] = 'invalid';
    if (kind === 'wrong-resource') helper!.Config.Labels['ninedeploy.database.slug'] = 'other';
    if (kind === 'image') helper!.Image = 'sha256:' + 'e'.repeat(64);
    await expect(clearNodeStudio(input)).rejects.toMatchObject({ statusCode: 409 });
    expect(helper).not.toBeNull(); expect(h.call.mock.calls.some(call => call[1] === 'DELETE')).toBe(false);
  });
  it('retains an unconfirmed clear for retry', async () => {
    await startNodeStudio(input, deps()); refuseCleanup = true;
    await expect(clearNodeStudio(input)).rejects.toThrow(); expect(helper).not.toBeNull();
    refuseCleanup = false; expect(await clearNodeStudio(input)).toBe(HELPER);
  });
  it('does not clear a replacement with identical labels after a ready receipt was published', async () => {
    const previous = await startNodeStudio(input, deps()); helper!.Id = 'e'.repeat(64);
    await expect(clearNodeStudio({ ...input, previous })).rejects.toMatchObject({ statusCode: 409 });
    expect(helper!.Id).toBe('e'.repeat(64)); expect(h.call.mock.calls.some(call => call[1] === 'DELETE')).toBe(false);
  });
  it('clears exactly a published receipt and rejects cross-resource previous metadata', async () => {
    const previous = await startNodeStudio(input, deps());
    await expect(clearNodeStudio({ ...input, previous: { ...previous, databaseId: 8 } })).rejects.toMatchObject({ statusCode: 409 });
    expect(await clearNodeStudio({ ...input, previous })).toBe(HELPER); expect(helper).toBeNull();
    expect(await clearNodeStudio({ ...input, previous })).toBeNull();
  });
  it('does not delete a replacement that reused the stopped helper name', async () => {
    const identity = await startNodeStudio(input, deps()); helper!.Id = 'e'.repeat(64);
    await stopNodeStudio(identity); expect(helper!.Id).toBe('e'.repeat(64));
  });
  it('cleans up only its newly created helper after readiness fails', async () => {
    probe.mockRejectedValue(new Error('private probe detail'));
    await expect(startNodeStudio(input, deps())).rejects.toMatchObject({ statusCode: 502, code: 'node_studio_unconfirmed' });
    expect(helper).toBeNull();
  });
  it('recovers a lost create reply through its nonce and confirms cleanup', async () => {
    lostCreate = true; await expect(startNodeStudio(input, deps())).rejects.toMatchObject({ statusCode: 502 }); expect(helper).toBeNull();
  });
  it('reports an unconfirmed cleanup instead of pretending the failed helper is gone', async () => {
    lostCreate = true; refuseCleanup = true;
    await expect(startNodeStudio(input, deps())).rejects.toMatchObject({ statusCode: 502, code: 'node_studio_cleanup_unconfirmed' });
    expect(helper).not.toBeNull();
  });
  it('times out image preparation before helper creation, even if the shared pull completes later', async () => {
    vi.useFakeTimers(); let finish!: () => void; ensureImage.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const result = startNodeStudio(input, deps()); void result.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(120001);
    await expect(result).rejects.toMatchObject({ statusCode: 504, code: 'node_studio_image_pending' });
    finish(); await Promise.resolve(); expect(createBody).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds readiness retries and removes the newly created helper on expiry', async () => {
    vi.useFakeTimers(); probe.mockResolvedValue(false);
    const result = startNodeStudio(input, deps()); void result.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30001);
    await expect(result).rejects.toMatchObject({ statusCode: 504, code: 'node_studio_not_ready' });
    expect(helper).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not accept a successful probe that completed after the readiness deadline', async () => {
    vi.useFakeTimers();
    probe.mockImplementation(() => new Promise<boolean>(resolve => setTimeout(() => resolve(true), 31000)));
    const result = startNodeStudio(input, deps()); void result.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(31001);
    await expect(result).rejects.toMatchObject({ statusCode: 504 });
    expect(helper).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
});
