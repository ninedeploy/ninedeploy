import { describe, expect, it } from 'vitest';
import {
  BUILD_CONCURRENCY_MAX,
  BUILD_CONCURRENCY_MIN,
  buildOn,
  createDatabase,
  effectiveBuildOn,
  effectiveOrchestrator,
  hostVolumeEntry,
  IMAGE_TRANSFERS_LIMIT_MAX,
  imageTransfer,
  imageTransfersQuery,
  managedDatabase,
  managedVolumeName,
  MULTI_NODE_CAPABILITIES,
  multiNodeCapability,
  multiNodeErrorCode,
  pushRepository,
  serverAgentInfo,
  serverFeatures,
  serverRoles,
  servicePlacement,
  servicePlacementView,
  serviceSwarmStatus,
  source,
  sourcePatch,
  swarmInit,
  swarmSettings,
  swarmStatus,
  volumeCreate,
  volumeHostQuery,
} from '../src/index.js';

describe('agent capabilities (multi-node §1.1)', () => {
  it('lists the nine new capabilities in their advertised order', () => {
    expect(MULTI_NODE_CAPABILITIES).toEqual([
      'stream',
      'docker.runSpec',
      'volume.manage',
      'image.manage',
      'build.nixpacks',
      'build.railpack',
      'git.sshkey',
      'db.manage',
      'swarm',
    ]);
    expect(multiNodeCapability.parse('db.manage')).toBe('db.manage');
    // A 0.15 capability is not one of them.
    expect(multiNodeCapability.safeParse('terminal').success).toBe(false);
  });

  it('names the shared refusal codes', () => {
    expect(multiNodeErrorCode.parse('node_agent_outdated')).toBe('node_agent_outdated');
    expect(multiNodeErrorCode.parse('node_feature_disabled')).toBe('node_feature_disabled');
    // T5: node volume backups across hosts, and the panel-only file manager.
    expect(multiNodeErrorCode.parse('backup_host_mismatch')).toBe('backup_host_mismatch');
    expect(multiNodeErrorCode.parse('node_volume_files_unsupported')).toBe('node_volume_files_unsupported');
    // T8: the Swarm codes the 0.15.4 routes answer with.
    for (const code of ['node_swarm_not_enabled', 'swarm_node_unverified', 'swarm_overlay_unavailable', 'server_swarm_member']) {
      expect(multiNodeErrorCode.parse(code)).toBe(code);
    }
    expect(multiNodeErrorCode.safeParse('nope').success).toBe(false);
  });

  it('describes the cached agent and the derived features', () => {
    expect(serverAgentInfo.parse({ version: null, capabilities: [], checkedAt: null })).toEqual({
      version: null,
      capabilities: [],
      checkedAt: null,
    });
    expect(
      serverAgentInfo.safeParse({ version: '0.15.2', capabilities: ['stream'], checkedAt: '2026-10-09T10:00:00.000Z' }).success,
    ).toBe(true);
    const off = { nixpacks: false, railpack: false, privateClones: false, volumes: false, databases: false, imageTransfer: false, swarm: false };
    expect(serverFeatures.parse(off)).toEqual(off);
    expect(serverFeatures.parse({ ...off, reason: 'Update the node agent' }).reason).toBe('Update the node agent');
    expect(serverFeatures.safeParse({ ...off, swarm: 'yes' }).success).toBe(false);
  });
});

describe('build placement (multi-node §6)', () => {
  it('maps a NULL placement to 0.15 behaviour', () => {
    expect(effectiveBuildOn(null)).toBe('target');
    expect(effectiveBuildOn(undefined)).toBe('target');
    expect(effectiveBuildOn('panel')).toBe('panel');
    expect(effectiveOrchestrator(null)).toBe('container');
    expect(effectiveOrchestrator(undefined)).toBe('container');
    expect(effectiveOrchestrator('swarm')).toBe('swarm');
    expect(buildOn.options).toEqual(['target', 'panel', 'server']);
  });

  it('accepts a partial, strict placement update with nulls', () => {
    expect(servicePlacement.parse({})).toEqual({});
    expect(servicePlacement.parse({ buildOn: 'server', buildServerId: 3 })).toEqual({ buildOn: 'server', buildServerId: 3 });
    expect(
      servicePlacement.parse({ buildOn: null, buildServerId: null, pushRegistrySourceId: null, pushRepository: null, orchestrator: null }),
    ).toEqual({ buildOn: null, buildServerId: null, pushRegistrySourceId: null, pushRepository: null, orchestrator: null });
    expect(servicePlacement.parse({ pushRegistrySourceId: 9, pushRepository: 'team/app', orchestrator: 'swarm' })).toMatchObject({
      pushRepository: 'team/app',
    });
    expect(servicePlacement.safeParse({ buildOn: 'cloud' }).success).toBe(false);
    expect(servicePlacement.safeParse({ buildServerId: 0 }).success).toBe(false);
    expect(servicePlacement.safeParse({ orchestrator: 'k8s' }).success).toBe(false);
    expect(servicePlacement.safeParse({ serverId: 1 }).success).toBe(false);
  });

  it('accepts only a registry repository path, no host, tag or uppercase', () => {
    for (const ok of ['app', 'team/app', 'team/sub.app-x_1']) expect(pushRepository.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['Team/app', 'ghcr.io:443/app', 'app:latest', '/app', 'app/', 'a//b', 'x'.repeat(256)]) {
      expect(pushRepository.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('reads back the stored placement', () => {
    const view = { buildOn: null, buildServerId: null, pushRegistrySourceId: null, pushRepository: null, orchestrator: null };
    expect(servicePlacementView.parse(view)).toEqual(view);
    expect(servicePlacementView.safeParse({ ...view, buildOn: undefined }).success).toBe(false);
  });

  it('bounds the build-server role', () => {
    expect(serverRoles.parse({})).toEqual({});
    expect(serverRoles.parse({ isBuildServer: true, buildConcurrency: BUILD_CONCURRENCY_MAX })).toEqual({
      isBuildServer: true,
      buildConcurrency: 8,
    });
    expect(serverRoles.parse({ buildConcurrency: BUILD_CONCURRENCY_MIN }).buildConcurrency).toBe(1);
    expect(serverRoles.safeParse({ buildConcurrency: 0 }).success).toBe(false);
    expect(serverRoles.safeParse({ buildConcurrency: 9 }).success).toBe(false);
    expect(serverRoles.safeParse({ buildConcurrency: 1.5 }).success).toBe(false);
    expect(serverRoles.safeParse({ name: 'x' }).success).toBe(false);
  });

  it('describes an image transfer row and bounds the history query', () => {
    const row = {
      id: 1,
      deploymentId: null,
      serviceId: 2,
      sourceServerId: null,
      targetServerId: 4,
      method: 'stream',
      imageRef: 'ninedeploy/web:abc1234-b9',
      imageId: `sha256:${'a'.repeat(64)}`,
      bytes: 0,
      sha256: null,
      status: 'running',
      error: null,
      startedAt: '2026-10-09T10:00:00.000Z',
      finishedAt: null,
      durationMs: null,
    };
    expect(imageTransfer.parse(row)).toEqual(row);
    expect(imageTransfer.safeParse({ ...row, method: 'scp' }).success).toBe(false);
    expect(imageTransfer.safeParse({ ...row, status: 'queued' }).success).toBe(false);
    expect(imageTransfer.safeParse({ ...row, bytes: -1 }).success).toBe(false);

    expect(imageTransfersQuery.parse({})).toEqual({ limit: 20 });
    expect(imageTransfersQuery.parse({ limit: String(IMAGE_TRANSFERS_LIMIT_MAX) })).toEqual({ limit: 100 });
    expect(imageTransfersQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(imageTransfersQuery.safeParse({ limit: '0' }).success).toBe(false);
    expect(imageTransfersQuery.safeParse({ before: '1' }).success).toBe(false);
  });
});

describe('node volumes (multi-node §4)', () => {
  it('accepts managed volume names only', () => {
    for (const ok of ['nd-svc-web-data', 'nd-db-app-data', 'nd-svc-web-cache.v2']) {
      expect(managedVolumeName.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['data', '/srv/data', 'nd-svc-', 'nd-other-x', 'nd-svc-Web', 'nd-db-x:/etc', `nd-svc-${'a'.repeat(128)}`]) {
      expect(managedVolumeName.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('takes the host from an optional query parameter', () => {
    expect(volumeHostQuery.parse({})).toEqual({});
    expect(volumeHostQuery.parse({ serverId: '7' })).toEqual({ serverId: 7 });
    expect(volumeHostQuery.safeParse({ serverId: '0' }).success).toBe(false);
    expect(volumeHostQuery.safeParse({ host: 'x' }).success).toBe(false);
  });

  it('creates on the panel host by default, or on a node', () => {
    expect(volumeCreate.parse({ name: 'nd-svc-web-data' })).toEqual({ name: 'nd-svc-web-data' });
    expect(volumeCreate.parse({ name: 'nd-svc-web-data', serverId: null })).toEqual({ name: 'nd-svc-web-data', serverId: null });
    expect(volumeCreate.parse({ name: 'nd-svc-web-data', serverId: 2 }).serverId).toBe(2);
    expect(volumeCreate.safeParse({ name: 'web' }).success).toBe(false);
    expect(volumeCreate.safeParse({ name: 'nd-svc-web-data', driver: 'local' }).success).toBe(false);
  });

  it('adds the host to a volume list item', () => {
    const item = { name: 'nd-svc-web-data', sizeBytes: 0, owner: null, inUse: false, serverId: null };
    expect(hostVolumeEntry.parse(item)).toEqual(item);
    expect(hostVolumeEntry.safeParse({ ...item, serverId: undefined }).success).toBe(false);
  });
});

describe('Swarm (multi-node §7)', () => {
  it('initialises on an IP address, with an optional step-up password', () => {
    expect(swarmInit.parse({ advertiseAddr: '10.0.0.5' })).toEqual({ advertiseAddr: '10.0.0.5' });
    expect(swarmInit.parse({ advertiseAddr: 'fd00::5', password: 'pw' })).toEqual({ advertiseAddr: 'fd00::5', password: 'pw' });
    for (const bad of ['eth0', '10.0.0.5:2377', 'panel.example.com', '']) {
      expect(swarmInit.safeParse({ advertiseAddr: bad }).success, bad).toBe(false);
    }
    expect(swarmInit.safeParse({ advertiseAddr: '10.0.0.5', password: '' }).success).toBe(false);
    expect(swarmInit.safeParse({ advertiseAddr: '10.0.0.5', force: true }).success).toBe(false);
  });

  it('toggles the feature', () => {
    expect(swarmSettings.parse({ enabled: false })).toEqual({ enabled: false });
    expect(swarmSettings.parse({ enabled: true, password: 'pw' })).toEqual({ enabled: true, password: 'pw' });
    expect(swarmSettings.safeParse({}).success).toBe(false);
  });

  it('describes the cluster and a service stack, never a join token', () => {
    const status = {
      enabled: true,
      localState: 'active',
      controlAvailable: true,
      managerAddr: '10.0.0.5:2377',
      nodes: [
        { id: 'n1', hostname: 'panel', role: 'manager', availability: 'active', state: 'ready', serverId: null },
        { id: 'n2', hostname: 'node-1', role: 'worker', availability: 'active', state: 'ready', serverId: 1 },
      ],
    };
    expect(swarmStatus.parse(status)).toEqual(status);
    expect(swarmStatus.parse({ ...status, joinToken: 'SWMTKN-1-x' })).not.toHaveProperty('joinToken');
    expect(swarmStatus.safeParse({ ...status, nodes: [{ ...status.nodes[0], role: 'leader' }] }).success).toBe(false);

    const stack = { stack: 'nd-web', desired: 2, running: 2, tasks: [{ node: 'panel', state: 'running', error: null, image: 'ninedeploy/web:abc' }] };
    expect(serviceSwarmStatus.parse(stack)).toEqual(stack);
    expect(serviceSwarmStatus.parse({ stack: null, desired: 0, running: 0, tasks: [] }).stack).toBeNull();
    expect(serviceSwarmStatus.safeParse({ ...stack, desired: -1 }).success).toBe(false);
  });
});

describe('additive fields on existing contracts (multi-node)', () => {
  it('createDatabase takes an optional, nullable node and keeps every 0.15 body valid', () => {
    expect(createDatabase.parse({ name: 'db', engine: 'postgres' })).not.toHaveProperty('serverId');
    expect(createDatabase.parse({ name: 'db', engine: 'postgres', serverId: null }).serverId).toBeNull();
    expect(createDatabase.parse({ name: 'db', engine: 'postgres', serverId: 3 }).serverId).toBe(3);
    expect(createDatabase.safeParse({ name: 'db', engine: 'postgres', serverId: 0 }).success).toBe(false);
    expect(createDatabase.safeParse({ name: 'db', engine: 'postgres', serverId: '3' }).success).toBe(false);
  });

  it('sourcePatch takes allowOnNodes and a step-up password and keeps every 0.15 body valid', () => {
    expect(sourcePatch.parse({ name: 'gh' })).toEqual({ name: 'gh' });
    expect(sourcePatch.parse({ allowOnNodes: true, password: 'pw' })).toEqual({ allowOnNodes: true, password: 'pw' });
    expect(sourcePatch.parse({ allowOnNodes: false })).toEqual({ allowOnNodes: false });
    expect(sourcePatch.safeParse({ allowOnNodes: 'yes' }).success).toBe(false);
    expect(sourcePatch.safeParse({ password: '' }).success).toBe(false);
    expect(sourcePatch.safeParse({ password: 'x'.repeat(1025) }).success).toBe(false);
  });

  // ── 0.16 T8 surfaces ──
  const dbRow = {
    id: 1, projectId: null, name: 'db', slug: 'db', engine: 'postgres', version: '16', status: 'running',
    host: 'nd-db-db', port: 5432, username: 'u', database: 'd', connectionString: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };

  it('managedDatabase reads the node fields and still reads a 0.15.2 row without them', () => {
    expect(managedDatabase.parse(dbRow)).not.toHaveProperty('serverId');
    expect(managedDatabase.parse({ ...dbRow, serverId: null, serverName: null, reachable: null })).toMatchObject({ serverId: null, serverName: null, reachable: null });
    expect(managedDatabase.parse({ ...dbRow, serverId: 2, serverName: 'edge-1', reachable: false })).toMatchObject({ serverId: 2, serverName: 'edge-1', reachable: false });
    expect(managedDatabase.safeParse({ ...dbRow, serverId: '2' }).success).toBe(false);
    expect(managedDatabase.safeParse({ ...dbRow, reachable: 'yes' }).success).toBe(false);
  });

  it('source reads allowOnNodes and still reads a row without it', () => {
    const row = { id: 1, name: 'gh', type: 'github', hasToken: true, hasDeployKey: false, defaultBranch: null, createdAt: '2026-01-01T00:00:00Z' };
    expect(source.parse(row)).not.toHaveProperty('allowOnNodes');
    expect(source.parse({ ...row, allowOnNodes: true }).allowOnNodes).toBe(true);
    expect(source.safeParse({ ...row, allowOnNodes: 1 }).success).toBe(false);
  });
  // ── end 0.16 T8 ──
});
