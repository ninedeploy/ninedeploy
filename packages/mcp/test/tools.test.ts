import { describe, expect, it, vi } from 'vitest';
import { SPEC_READ_ONLY_TOOL_NAMES, SPEC_TOOLS } from '../src/generated/specTools.js';
import { READ_ONLY_TOOL_NAMES } from '../src/index.js';
import { apiOperations, searchApi, TOOLS } from '../src/tools.js';
import type { NineDeployClient } from '@ninedeploy/sdk';

/** A client where every method is a spy returning a marker. */
function fakeClient(): NineDeployClient {
  const list = vi.fn(async () => 'LIST');
  return {
    services: {
      list,
      get: vi.fn(async () => 'GET'),
      logs: vi.fn(async () => 'LOGS'),
      restart: vi.fn(async () => 'RESTART'),
      update: vi.fn(async () => 'UPDATE'),
    },
    deploys: {
      list: vi.fn(async () => 'DEPLOYS'),
      trigger: vi.fn(async () => 'TRIGGER'),
      rollback: vi.fn(async () => 'ROLLBACK'),
      cancel: vi.fn(async () => 'CANCEL'),
      remove: vi.fn(async () => 'REMOVED'),
      queue: vi.fn(async () => 'QUEUE'),
    },
    domains: { all: vi.fn(async () => 'DOMAINS') },
    databases: {
      list: vi.fn(async () => 'DBS'),
      publicAccess: { get: vi.fn(async () => 'PUBLIC_ACCESS') },
      imports: { list: vi.fn(async () => 'IMPORTS') },
    },
    projects: { list: vi.fn(async () => 'PROJECTS') },
    alerts: { list: vi.fn(async () => 'ALERTS') },
    activity: { list: vi.fn(async () => 'ACTIVITY') },
    stats: { snapshot: vi.fn(async () => 'STATS') },
    topology: { get: vi.fn(async () => 'TOPO') },
    health: vi.fn(async () => 'HEALTH'),
    api: { get: vi.fn(async () => 'API_GET') },
    demo: { seed: vi.fn(async () => 'DEMO_SEEDED') },
    plugins: {
      list: vi.fn(async () => 'PLUGINS_LIST'),
      marketplace: vi.fn(async () => 'MARKETPLACE'),
      install: vi.fn(async () => 'INSTALLED'),
      enable: vi.fn(async () => 'ENABLED'),
      disable: vi.fn(async () => 'DISABLED'),
      uninstall: vi.fn(async () => 'UNINSTALLED'),
    },
    config: {
      list: vi.fn(async () => 'CONFIG_LIST'),
      get: vi.fn(async () => 'CONFIG_GET'),
      set: vi.fn(async () => 'CONFIG_SET'),
      delete: vi.fn(async () => 'CONFIG_DELETE'),
    },
    menus: {
      list: vi.fn(async () => 'MENUS_LIST'),
    },
    workspaces: {
      list: vi.fn(async () => 'WORKSPACES_LIST'),
      get: vi.fn(async () => 'WORKSPACE_GET'),
    },
    containers: {
      listFiles: vi.fn(async () => 'CONTAINER_FILES'),
      inspect: vi.fn(async () => 'CONTAINER_INSPECT'),
      compose: vi.fn(async () => 'CONTAINER_COMPOSE'),
    },
    logDrains: {
      list: vi.fn(async () => 'LOG_DRAINS_LIST'),
    },
    housekeeping: {
      runPrune: vi.fn(async () => 'PRUNE_RUN'),
    },
    githubApps: {
      list: vi.fn(async () => [
        { id: 1, name: 'App one', appId: 11, webBaseUrl: 'https://github.com' },
        { id: 2, name: 'GHES', appId: 22, webBaseUrl: 'https://ghe.example' },
      ]),
      installations: vi.fn(async (id: number) => [{ id: id * 10, accountLogin: 'acme', sourceId: 7 }]),
    },
  } as unknown as NineDeployClient;
}

const byName = (name: string) => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
};

describe('MCP tools', () => {
  it('exposes 42 hand-written tools plus the generated ones, every name unique', () => {
    expect(TOOLS).toHaveLength(42 + SPEC_TOOLS.length);
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    for (const t of TOOLS) expect(t.description.length).toBeGreaterThan(10);
  });

  it('r472: list_configs declares no reveal parameter (mask-only over MCP)', () => {
    // The SDK supports reveal=true; the tool must not forward the model that
    // choice — transcripts persist and prompt injection has no human loop.
    const shape = (byName('list_configs').input as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape)).not.toContain('reveal');
  });

  it('list_services scopes by project when given', async () => {
    const c = fakeClient();
    await byName('list_services').handler(c, {});
    await byName('list_services').handler(c, { projectId: 3 });
    expect(c.services.list).toHaveBeenNthCalledWith(1, '');
    // The server dropped the legacy `?projectId=` query (it reads only
    // tagProjectIds/tagWorkspaceIds/tagLabelIds) — the old query made the
    // project filter a silent no-op returning ALL services.
    expect(c.services.list).toHaveBeenNthCalledWith(2, '?tagProjectIds=3');
  });

  it('id-based tools forward the parsed service id', async () => {
    const c = fakeClient();
    expect(await byName('get_service').handler(c, { serviceId: 7 })).toBe('GET');
    expect(c.services.get).toHaveBeenCalledWith(7);
    expect(await byName('service_logs').handler(c, { serviceId: 7 })).toBe('LOGS');
    expect(await byName('list_deploys').handler(c, { serviceId: 7 })).toBe('DEPLOYS');
    expect(await byName('deploy_service').handler(c, { serviceId: 7 })).toBe('TRIGGER');
    expect(c.deploys.trigger).toHaveBeenCalledWith(7);
    expect(await byName('restart_service').handler(c, { serviceId: 7 })).toBe('RESTART');
  });

  it('rollback passes both ids', async () => {
    const c = fakeClient();
    await byName('rollback_deploy').handler(c, { serviceId: 4, deploymentId: 9 });
    expect(c.deploys.rollback).toHaveBeenCalledWith(4, 9);
  });

  it('cancel passes both ids', async () => {
    // Paired with deploy_service on purpose: an agent that can start a build
    // must be able to stop one, or a runaway deploy it triggered can only be
    // halted from a browser.
    const c = fakeClient();
    await byName('cancel_deploy').handler(c, { serviceId: 4, deploymentId: 9 });
    expect(c.deploys.cancel).toHaveBeenCalledWith(4, 9);
  });

  it('remove_deploy forwards serviceId+deploymentId and requires a write scope', async () => {
    const c = fakeClient();
    await byName('remove_deploy').handler(c, { serviceId: 4, deploymentId: 9 });
    expect(c.deploys.remove).toHaveBeenCalledWith(4, 9);
    expect(byName('remove_deploy').requiredScopes).toEqual(['nd://scope/write/deploys']);
  });

  it('list_queue returns the global in-flight view and requires a read scope', async () => {
    const c = fakeClient();
    expect(await byName('list_queue').handler(c, {})).toBe('QUEUE');
    expect(c.deploys.queue).toHaveBeenCalled();
    // r333: /v1/services/queue is classified `services` by the server's
    // route map — `read/deploys` alone was always a 403 there.
    expect(byName('list_queue').requiredScopes).toEqual(['nd://scope/read/services']);
  });

  it('activity_log forwards the optional entity filter', async () => {
    const c = fakeClient();
    await byName('activity_log').handler(c, {});
    await byName('activity_log').handler(c, { entity: 'my-api' });
    expect(c.activity.list).toHaveBeenNthCalledWith(1, { entity: undefined });
    expect(c.activity.list).toHaveBeenNthCalledWith(2, { entity: 'my-api' });
  });

  it('parameterless tools call their SDK counterpart', async () => {
    const c = fakeClient();
    expect(await byName('list_domains').handler(c, {})).toBe('DOMAINS');
    expect(await byName('list_databases').handler(c, {})).toBe('DBS');
    expect(await byName('list_projects').handler(c, {})).toBe('PROJECTS');
    expect(await byName('list_alerts').handler(c, {})).toBe('ALERTS');
    expect(await byName('system_stats').handler(c, {})).toBe('STATS');
    expect(await byName('topology').handler(c, {})).toBe('TOPO');
    expect(await byName('health').handler(c, {})).toBe('HEALTH');
  });

  it('exercises plugin tools', async () => {
    const c = fakeClient();
    expect(await byName('list_plugins').handler(c, {})).toBe('PLUGINS_LIST');
    expect(await byName('marketplace_plugins').handler(c, {})).toBe('MARKETPLACE');

    await byName('install_plugin').handler(c, { source: 'marketplace', target: 's3-backups' });
    expect(c.plugins.install).toHaveBeenCalledWith({ source: 'marketplace', target: 's3-backups' });

    await byName('enable_plugin').handler(c, { id: 's3-backups' });
    expect(c.plugins.enable).toHaveBeenCalledWith('s3-backups');

    await byName('disable_plugin').handler(c, { id: 's3-backups' });
    expect(c.plugins.disable).toHaveBeenCalledWith('s3-backups');

    await byName('uninstall_plugin').handler(c, { id: 's3-backups' });
    expect(c.plugins.uninstall).toHaveBeenCalledWith('s3-backups');
  });

  it('exercises config tools', async () => {
    const c = fakeClient();
    // r472: list_configs deliberately exposes NO reveal param — an MCP result
    // lands in agent transcripts, so secret disclosure must not be a
    // per-call model decision. The input schema rejects it; the handler
    // forwards only the filters.
    await byName('list_configs').handler(c, { category: 'security' });
    expect(c.config.list).toHaveBeenCalledWith({ category: 'security' });

    await byName('get_config').handler(c, { key: 'site_name' });
    expect(c.config.get).toHaveBeenCalledWith('site_name');

    await byName('set_config').handler(c, { key: 'site_name', value: 'NineDeploy', isSecret: false, description: 'Desc' });
    expect(c.config.set).toHaveBeenCalledWith('site_name', { value: 'NineDeploy', isSecret: false, description: 'Desc' });

    await byName('delete_config').handler(c, { key: 'site_name' });
    expect(c.config.delete).toHaveBeenCalledWith('site_name');
  });

  it('exercises menu tools', async () => {
    const c = fakeClient();
    await byName('list_menus').handler(c, { slot: 'sidebar:main' });
    expect(c.menus.list).toHaveBeenCalledWith({ slot: 'sidebar:main' });
  });

  it('exercises demo and service update tools', async () => {
    const c = fakeClient();
    expect(await byName('seed_demo').handler(c, {})).toBe('DEMO_SEEDED');
    expect(c.demo.seed).toHaveBeenCalled();

    await byName('update_service').handler(c, { serviceId: 10, publishedPort: 8080 });
    expect(c.services.update).toHaveBeenCalledWith(10, { publishedPort: 8080 });
  });

  it('exercises workspaces, containers, logDrains, and housekeeping tools', async () => {
    const c = fakeClient();
    expect(await byName('list_workspaces').handler(c, {})).toBe('WORKSPACES_LIST');
    expect(c.workspaces.list).toHaveBeenCalled();

    expect(await byName('get_workspace').handler(c, { id: 1 })).toBe('WORKSPACE_GET');
    expect(c.workspaces.get).toHaveBeenCalledWith(1);

    expect(await byName('list_container_files').handler(c, { container: 'srv-app', path: '/app' })).toBe('CONTAINER_FILES');
    expect(c.containers.listFiles).toHaveBeenCalledWith('srv-app', '/app');

    expect(await byName('inspect_container').handler(c, { container: 'srv-app' })).toBe('CONTAINER_INSPECT');
    expect(c.containers.inspect).toHaveBeenCalledWith('srv-app');

    expect(await byName('get_container_compose').handler(c, { container: 'srv-app' })).toBe('CONTAINER_COMPOSE');
    expect(c.containers.compose).toHaveBeenCalledWith('srv-app');

    expect(await byName('list_log_drains').handler(c, { serviceId: 5 })).toBe('LOG_DRAINS_LIST');
    expect(c.logDrains.list).toHaveBeenCalledWith({ serviceId: 5 });

    expect(await byName('system_autoprune').handler(c, {})).toBe('PRUNE_RUN');
    expect(c.housekeeping.runPrune).toHaveBeenCalled();
  });

  it('input schemas validate and reject malformed inputs', () => {
    expect(byName('get_service').input.safeParse({ serviceId: 0 }).success).toBe(false);
    expect(byName('get_service').input.safeParse({}).success).toBe(false);
    expect(byName('get_service').input.safeParse({ serviceId: 5 }).success).toBe(true);
    expect(byName('rollback_deploy').input.safeParse({ serviceId: 5 }).success).toBe(false);
    expect(byName('cancel_deploy').input.safeParse({ serviceId: 5 }).success).toBe(false);
    expect(byName('cancel_deploy').input.safeParse({ serviceId: 5, deploymentId: 9 }).success).toBe(true);
    expect(byName('list_services').input.safeParse({ projectId: 'x' }).success).toBe(false);
    expect(byName('install_plugin').input.safeParse({ target: 'pkg' }).success).toBe(true);
    expect(byName('set_config').input.safeParse({ key: 'k1', value: 123 }).success).toBe(true);
    expect(byName('update_service').input.safeParse({ serviceId: 1, publishedPort: 9000 }).success).toBe(true);
    expect(byName('get_workspace').input.safeParse({ id: 1 }).success).toBe(true);
    expect(byName('list_container_files').input.safeParse({ container: 'srv_app', path: '/etc' }).success).toBe(true);
    expect(byName('list_container_files').input.safeParse({}).success).toBe(false);
    expect(byName('inspect_container').input.safeParse({ container: 'srv_app' }).success).toBe(true);
    expect(byName('inspect_container').input.safeParse({ container: '' }).success).toBe(false);
    expect(byName('get_container_compose').input.safeParse({ container: 'srv_app' }).success).toBe(true);
    expect(byName('get_container_compose').input.safeParse({}).success).toBe(false);
    expect(byName('list_log_drains').input.safeParse({ serviceId: 1 }).success).toBe(true);
    expect(byName('system_autoprune').input.safeParse({}).success).toBe(true);
  });

  // 0.13: read-only GitHub App installation listing (operator, coarse tokens only).
  describe('list_github_installations', () => {
    it('lists every App with its installations, or one App by id', async () => {
      const c = fakeClient();
      const tool = byName('list_github_installations');
      expect(tool.coarseTokenOnly).toBe(true);
      expect(tool.requiredScopes).toEqual(['operator']);
      expect(await tool.handler(c, {})).toEqual([
        { githubAppId: 1, name: 'App one', appId: 11, webBaseUrl: 'https://github.com', installations: [{ id: 10, accountLogin: 'acme', sourceId: 7 }] },
        { githubAppId: 2, name: 'GHES', appId: 22, webBaseUrl: 'https://ghe.example', installations: [{ id: 20, accountLogin: 'acme', sourceId: 7 }] },
      ]);
      const one = (await tool.handler(c, { githubAppId: 2 })) as Array<{ githubAppId: number }>;
      expect(one.map((a) => a.githubAppId)).toEqual([2]);
      expect(tool.input.safeParse({ githubAppId: 0 }).success).toBe(false);
    });

    it('tolerates a non-array App list', async () => {
      const c = fakeClient();
      (c.githubApps.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});
      expect(await byName('list_github_installations').handler(c, {})).toEqual([]);
    });
  });

  // 0.14: read-only database public access and import history (read/databases).
  describe('database network and data access', () => {
    it('maps get_database_public_access and list_database_imports onto the SDK', async () => {
      const c = fakeClient();
      expect(await byName('get_database_public_access').handler(c, { databaseId: 4 })).toBe('PUBLIC_ACCESS');
      expect(c.databases.publicAccess.get).toHaveBeenCalledWith(4);
      expect(await byName('list_database_imports').handler(c, { databaseId: 4 })).toBe('IMPORTS');
      expect(c.databases.imports.list).toHaveBeenCalledWith(4);
      for (const name of ['get_database_public_access', 'list_database_imports']) {
        expect(byName(name).requiredScopes).toEqual(['nd://scope/read/databases']);
        expect(byName(name).coarseTokenOnly).toBeUndefined();
        expect(byName(name).input.safeParse({}).success).toBe(false);
        expect(byName(name).input.safeParse({ databaseId: 0 }).success).toBe(false);
      }
    });
  });

  // 0.15 (DESIGN §3.4): read-only tools generated from the route specs.
  describe('generated spec tools', () => {
    it('are GET-only through client.api.get and all read-only listed', async () => {
      expect(SPEC_TOOLS.length).toBeGreaterThan(0);
      expect([...SPEC_READ_ONLY_TOOL_NAMES].sort()).toEqual(SPEC_TOOLS.map((t) => t.name).sort());
      for (const name of SPEC_READ_ONLY_TOOL_NAMES) expect(READ_ONLY_TOOL_NAMES.has(name)).toBe(true);
      for (const tool of SPEC_TOOLS) {
        const c = fakeClient();
        // Satisfy any path parameter (integers are positive; strings non-empty).
        const shape = (tool.input as unknown as { shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }> }).shape;
        const args: Record<string, unknown> = {};
        for (const [k, s] of Object.entries(shape)) if (!s.safeParse(undefined).success) args[k] = s.safeParse(7).success ? 7 : 'x';
        expect(await tool.handler(c, tool.input.parse(args))).toBe('API_GET');
        const [path] = (c.api.get as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
        expect(path).toMatch(/^\/v1\/[A-Za-z0-9/_.-]+$/);
      }
    });

    it('forward path ids and query filters', async () => {
      const c = fakeClient();
      await byName('get_database').handler(c, { databaseId: 3 });
      expect(c.api.get).toHaveBeenLastCalledWith('/v1/databases/3');
      await byName('list_jobs').handler(c, { serviceId: 9 });
      expect(c.api.get).toHaveBeenLastCalledWith('/v1/services/9/jobs');
      expect(byName('get_database').input.safeParse({ databaseId: 0 }).success).toBe(false);
      expect(byName('list_volumes').requiredScopes).toEqual(['operator', 'nd://scope/read/volumes']);
      expect(byName('doctor_report')).toMatchObject({ coarseTokenOnly: true, requiredScopes: ['operator'] });
      expect(byName('list_environments').coarseTokenOnly).toBe(true);
      expect(byName('list_environments').requiredScopes).toBeUndefined();
    });
  });

  describe('search_api', () => {
    const doc = {
      paths: {
        '/v1/services': {
          get: { summary: 'List services', tags: ['services'], 'x-ninedeploy-floor': 'authed', 'x-ninedeploy-scope': 'nd://scope/read/services' },
          post: { summary: 'Create a service', tags: ['services'], 'x-ninedeploy-floor': 'member', 'x-ninedeploy-scope': 'nd://scope/write/services' },
        },
        '/v1/doctor': { get: { summary: 'Scan the host', tags: ['doctor'], 'x-ninedeploy-floor': 'operator', 'x-ninedeploy-scope': null } },
        '/v1/odd': { get: { tags: 'nope' }, put: null },
      },
    };

    it('is read-only listed and coarse-token only', () => {
      const tool = byName('search_api');
      expect(tool.coarseTokenOnly).toBe(true);
      expect(tool.requiredScopes).toBeUndefined();
      expect(READ_ONLY_TOOL_NAMES.has('search_api')).toBe(true);
      expect(tool.input.safeParse({}).success).toBe(true);
      expect(tool.input.safeParse({ limit: 0 }).success).toBe(false);
    });

    it('matches every term case-insensitively, fetching the document once per client', async () => {
      const c = fakeClient();
      (c.api.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(doc);
      const hit = (await byName('search_api').handler(c, { query: 'SERVICES post' })) as { total: number; operations: unknown[] };
      expect(hit).toEqual({
        total: 1,
        operations: [{ method: 'POST', path: '/v1/services', summary: 'Create a service', tag: 'services', floor: 'member', scope: 'nd://scope/write/services' }],
      });
      const all = await searchApi(c, { limit: 2 });
      expect(all.total).toBe(4);
      expect(all.operations).toHaveLength(2);
      expect(c.api.get).toHaveBeenCalledTimes(1);
      expect(c.api.get).toHaveBeenCalledWith('/v1/openapi.json');
      expect((await searchApi(c, { query: 'doctor' })).operations[0]).toMatchObject({ floor: 'operator', scope: null });
    });

    it('retries after a failed fetch and tolerates a partial document', async () => {
      const c = fakeClient();
      const get = c.api.get as unknown as ReturnType<typeof vi.fn>;
      get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
      await expect(searchApi(c, {})).rejects.toThrow('offline');
      expect(await searchApi(c, {})).toEqual({ total: 0, operations: [] });
      expect(apiOperations(undefined)).toEqual([]);
      expect(apiOperations({ paths: { '/v1/odd': { get: { tags: 'nope' } } } })).toEqual([
        { method: 'GET', path: '/v1/odd', summary: '', tag: null, floor: null, scope: null },
      ]);
    });
  });
});
