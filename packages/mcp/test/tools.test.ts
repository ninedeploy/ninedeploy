import { describe, expect, it, vi } from 'vitest';
import { TOOLS } from '../src/tools.js';
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
    databases: { list: vi.fn(async () => 'DBS') },
    projects: { list: vi.fn(async () => 'PROJECTS') },
    alerts: { list: vi.fn(async () => 'ALERTS') },
    activity: { list: vi.fn(async () => 'ACTIVITY') },
    stats: { snapshot: vi.fn(async () => 'STATS') },
    topology: { get: vi.fn(async () => 'TOPO') },
    health: vi.fn(async () => 'HEALTH'),
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
  } as unknown as NineDeployClient;
}

const byName = (name: string) => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
};

describe('MCP tools', () => {
  it('exposes 37 unique tools with descriptions', () => {
    expect(TOOLS).toHaveLength(38);
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(38);
    for (const t of TOOLS) expect(t.description.length).toBeGreaterThan(10);
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
    await byName('list_configs').handler(c, { category: 'security', reveal: true });
    expect(c.config.list).toHaveBeenCalledWith({ category: 'security', reveal: true });

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
});
