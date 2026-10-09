import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { backups, createDb, databases, type DB, runMigrations, servers, services, serviceVolumeAttachments } from '@ninedeploy/db';
import { MULTI_NODE_CAPABILITIES } from '@ninedeploy/schemas';

/**
 * Multi-node T5 (design §4): volumes on nodes, panel side.
 *
 *  - the refusal for a node docker service with a command, the Docker socket
 *    or attachments (lib/remoteVolumes.ts), and the cross-host rule;
 *  - the run phase on `docker.runSpec` with volumes pre-created
 *    (engine/builders/remoteRun.ts), and the 0.15 `docker.runEnv` baseline;
 *  - node volume list / create through the agent, the panel-only file manager
 *    (modules/volumes.ts);
 *  - node volume backups and restores through the stream channel into the
 *    panel's backups directory, encrypted like a panel-host backup
 *    (lib/nodeVolumes.ts, modules/volumeBackups.ts), with the panel host's
 *    behaviour pinned.
 *
 * Nothing here reaches Docker or a node: the agent and the stream channel are
 * fakes that behave like a current agent (or a 0.15 one).
 */

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-node-volumes-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const h = vi.hoisted(() => ({
  ping: '' as string,
  sealed: true,
  ops: [] as Array<{ op: string; params: Record<string, unknown> }>,
  /** Volumes on the fake node. */
  volumes: new Map<string, Record<string, string>>(),
  /** `docker.volumeUsage` lines. */
  usage: [] as string[],
  usageThrows: false,
  /** What `volume.export` streams; `exportFails` makes its end check fail. */
  exportBytes: Buffer.alloc(0),
  exportFails: false,
  /** What `volume.import` received. */
  imported: [] as Buffer[],
  streams: [] as Array<{ kind: string; params: Record<string, unknown> }>,
}));

vi.mock('../src/lib/agentClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentClient.js')>()),
  agentTransportSealed: async () => h.sealed,
  agentOp: async (_db: unknown, _id: number, op: string, params: Record<string, unknown>, _sink: unknown, opts?: { tolerateExit?: boolean }) => {
    h.ops.push({ op, params });
    const answer = (exitCode: number, lines: string[] = []) => {
      if (exitCode !== 0 && !opts?.tolerateExit) throw new Error(`agent ${op} exited with ${exitCode}: ${lines.join(' ')}`);
      return { exitCode, lines };
    };
    switch (op) {
      case 'agent.ping':
        return answer(0, h.ping ? [h.ping] : []);
      case 'docker.volumeList':
        return answer(0, [...h.volumes].map(([name, labels]) => JSON.stringify({ Name: name, Driver: 'local', Labels: Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(','), Mountpoint: `/var/lib/docker/volumes/${name}/_data` })));
      case 'docker.volumeUsage':
        if (h.usageThrows) throw new Error('connect ECONNREFUSED 10.0.0.5:4600');
        return answer(0, h.usage);
      case 'docker.volumeSize':
        return h.volumes.has(params['name'] as string) ? answer(0, [`4096\t/v`]) : answer(4, [`ND-VOLUME-MISSING ${params['name']}`]);
      case 'docker.volumeInspect':
        return answer(h.volumes.has(params['name'] as string) ? 0 : 1);
      case 'docker.volumeCreate':
        if (params['ifExists'] === 'fail' && h.volumes.has(params['name'] as string)) return answer(3, [`ND-VOLUME-EXISTS ${params['name']}`]);
        h.volumes.set(params['name'] as string, (params['labels'] as Record<string, string>) ?? {});
        return answer(0, [params['name'] as string]);
      default:
        throw new Error(`agent ${op} failed (400): {"error":{"code":"unknown_op"}}`);
    }
  },
}));

vi.mock('../src/lib/agentStream.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentStream.js')>()),
  openAgentStream: async (_db: unknown, _serverId: number, kind: string, params: Record<string, unknown>) => {
    h.streams.push({ kind, params });
    if (kind === 'volume.export') {
      const sha256 = createHash('sha256').update(h.exportBytes).digest('hex');
      const readable = new PassThrough();
      let fail!: (e: Error) => void;
      const done = new Promise((resolve, reject) => {
        fail = reject;
        readable.on('end', () => (h.exportFails ? reject(new Error('the stream ended short: integrity check failed')) : resolve({ bytes: h.exportBytes.length, sha256, result: { volume: params['volume'] } })));
      });
      setImmediate(() => readable.end(h.exportBytes));
      return { kind, direction: 'agent-to-panel', readable, done, abort: () => fail?.(new Error('aborted')) };
    }
    const writable = new PassThrough();
    writable.on('data', (c: Buffer) => h.imported.push(Buffer.from(c)));
    const done = new Promise((resolve) => writable.on('finish', () => resolve({ bytes: Buffer.concat(h.imported).length, sha256: '', result: { volume: params['volume'] } })));
    return { kind, direction: 'panel-to-agent', writable, done, abort: () => undefined };
  },
}));

const engine = vi.hoisted(() => ({
  panelVolumes: new Set<string>(),
  created: [] as Array<{ name: string; labels: Record<string, string> }>,
  restored: [] as string[],
}));
vi.mock('../src/engine/database.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/database.js')>()),
  volumeExists: async (name: string) => engine.panelVolumes.has(name),
  createDockerVolume: async (name: string, _log: unknown, labels: Record<string, string>) => {
    engine.created.push({ name, labels });
    engine.panelVolumes.add(name);
  },
  restoreVolume: async (name: string) => {
    engine.restored.push(name);
  },
}));
// The panel host's restore guard probes `docker ps` (F183); nothing runs here.
vi.mock('../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/exec.js')>()),
  capture: async () => '',
}));
const files = vi.hoisted(() => ({ listVolumeDir: vi.fn(async () => []) }));
vi.mock('../src/engine/volumeFiles.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/volumeFiles.js')>()),
  listVolumeDir: files.listVolumeDir,
}));
vi.mock('../src/lib/inventory.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/inventory.js')>()),
  listManagedVolumeNames: async () => [...engine.panelVolumes],
}));
const audits = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => audits);
const remote = vi.hoisted(() => ({
  uploadBackup: vi.fn(async () => undefined),
  fetchRemoteBackup: vi.fn(async () => undefined),
  deleteRemoteBackupForRetention: vi.fn(async () => 'deleted'),
}));
vi.mock('../src/lib/backupRemote.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/backupRemote.js')>()),
  ...remote,
}));
vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return { config: { ...actual.config, volumeBackupRetainCount: 2, paths: { ...actual.config.paths, backupsDir: tmp } } };
});

const caps = await import('../src/lib/agentCapabilities.js');
const rv = await import('../src/lib/remoteVolumes.js');
const nv = await import('../src/lib/nodeVolumes.js');
const { runRemoteContainer, runSpecParams } = await import('../src/engine/builders/remoteRun.js');
const { parseRunSpec, runSpecArgv } = await import('../src/agentOps/runSpec.js');
const { volumeRoutes } = await import('../src/modules/volumes.js');
const { volumeBackupRoutes, backupServiceVolumes, pruneOldBackups } = await import('../src/modules/volumeBackups.js');
const { createBackupReadStream } = await import('../src/engine/database.js');
const { HttpError } = await import('../src/lib/errors.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const pingLine = (version: string, list: readonly string[]) => `ND-AGENT ${JSON.stringify({ version, caps: list })}`;
const CAPS_015_LIST = ['build-path-guard', 'workspace.remove', 'git.credential', 'terminal', 'terminal.host'];
const CAPS_015 = pingLine('0.15.1', CAPS_015_LIST);
const CAPS_ALL = pingLine('0.15.2', [...CAPS_015_LIST, ...MULTI_NODE_CAPABILITIES]);

let db: DB;
let node: number;
let other: number;
let web: number;
let api: number;

beforeEach(async () => {
  h.ping = CAPS_ALL;
  h.sealed = true;
  h.ops = [];
  h.volumes = new Map();
  h.usage = [];
  h.usageThrows = false;
  h.exportBytes = Buffer.from('a gzipped tar of the volume, as the agent streams it');
  h.exportFails = false;
  h.imported = [];
  h.streams = [];
  engine.panelVolumes = new Set();
  engine.created = [];
  engine.restored = [];
  vi.clearAllMocks();
  caps.resetNodeCapabilityCache();
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  const [n1] = await db.insert(servers).values({ name: 'edge-1', host: '10.0.0.5', port: 4600, tokenEncrypted: encrypt('t'), status: 'online' }).returning();
  const [n2] = await db.insert(servers).values({ name: 'edge-2', host: '10.0.0.6', port: 4600, tokenEncrypted: encrypt('t'), status: 'online' }).returning();
  node = n1!.id;
  other = n2!.id;
  const [w] = await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', serverId: node, runtimeId: 'web-7', volumeMount: '/data' }).returning();
  const [a] = await db.insert(services).values({ name: 'api', slug: 'api', type: 'docker', serverId: null, runtimeId: 'api-3' }).returning();
  web = w!.id;
  api = a!.id;
});

const ops = () => h.ops.map((o) => o.op);
const webRow = async () => (await db.query.services.findFirst({ where: (s, { eq }) => eq(s.id, web) }))!;

// ── lib/remoteVolumes.ts ────────────────────────────────────────────────────

describe('remoteVolumeRefusal / assertRemoteVolumeSupported (replaces the r266 clause)', () => {
  const probeAgent = async (op: string, params: Record<string, unknown>) => {
    h.ops.push({ op, params });
    return { exitCode: 0, lines: h.ping ? [h.ping] : [] };
  };
  const probe = async () => ({ agent: probeAgent, nodeLabel: '"edge-1" (#1)', sealed: h.sealed });

  it('a node docker service needing nothing new is null without asking the node anything (0.15 baseline)', async () => {
    expect(await rv.remoteVolumeRefusal(db, await webRow(), { probe })).toBeNull();
    expect(ops()).toEqual([]);
    // Panel-host and compose services are never refused here.
    expect(await rv.remoteVolumeRefusal(db, { id: api, serverId: null, cmd: ['x'] })).toBeNull();
    expect(await rv.remoteVolumeRefusal(db, { id: web, serverId: node, type: 'compose', cmd: ['x'] })).toBeNull();
    expect(ops()).toEqual([]);
  });

  it('a 0.15 agent: 422 node_agent_outdated naming the update, only agent.ping, nothing written', async () => {
    h.ping = CAPS_015;
    await db.insert(serviceVolumeAttachments).values({ serviceId: web, volumeName: 'nd-svc-web-cache', containerPath: '/cache' });
    const refusal = await rv.remoteVolumeRefusal(db, { ...(await webRow()), cmd: ['server', '/data'], dockerSocket: true }, { probe });
    expect(refusal).toEqual({
      status: 422,
      code: 'node_agent_outdated',
      message: expect.stringMatching(/^The agent on node "edge-1" \(#1\) \(version 0\.15\.1\) cannot run a service with volume attachments, a command or the Docker socket\. Update the node agent to v0\.15\.2 or newer/),
    });
    expect(ops()).toEqual(['agent.ping']);
    expect(h.volumes.size).toBe(0);
  });

  it('a command alone needs only docker.runSpec; a volume needs volume.manage too', async () => {
    h.ping = pingLine('0.15.2', [...CAPS_015_LIST, 'docker.runSpec']);
    expect(await rv.remoteVolumeRefusal(db, { id: api, serverId: node, cmd: ['x'] }, { probe })).toBeNull();
    expect((await rv.remoteVolumeRefusal(db, { ...(await webRow()), cmd: ['x'] }, { probe }))?.code).toBe('node_agent_outdated');
    expect(rv.nodeRunCapabilities({ volumeMount: null }, [])).toEqual(['docker.runSpec']);
    expect(rv.nodeRunCapabilities({ volumeMount: '/d' }, [])).toEqual(['docker.runSpec', 'volume.manage']);
  });

  it('the env-file and command never go in clear: 422 node_transport_unsealed before any ping', async () => {
    h.sealed = false;
    expect((await rv.remoteVolumeRefusal(db, { id: api, serverId: node, dockerSocket: true }, { probe }))?.code).toBe('node_transport_unsealed');
    expect(ops()).toEqual([]);
  });

  it('a current agent passes', async () => {
    await db.insert(serviceVolumeAttachments).values({ serviceId: web, volumeName: 'nd-svc-web-cache', containerPath: '/cache' });
    expect(await rv.remoteVolumeRefusal(db, await webRow(), { probe })).toBeNull();
    expect(ops()).toEqual(['agent.ping']);
  });

  it('an attached volume used on another host: 409 attachment_host_mismatch, before the node is asked', async () => {
    // api (panel host) owns nd-svc-api-data; a panel database owns nd-db-pg-data.
    await db.insert(databases).values({ name: 'pg', slug: 'pg', engine: 'postgres', passwordEncrypted: encrypt('p'), volumeName: 'nd-db-pg-data' });
    await db.insert(serviceVolumeAttachments).values([
      { serviceId: web, volumeName: 'nd-svc-api-data', containerPath: '/a' },
      { serviceId: web, volumeName: 'nd-db-pg-data', containerPath: '/b' },
    ]);
    const refusal = await rv.remoteVolumeRefusal(db, await webRow(), { probe });
    expect(refusal).toMatchObject({ status: 409, code: 'attachment_host_mismatch' });
    expect(refusal!.message).toMatch(/^This service runs on node #\d+, but its attached volumes .* live on another host\./);
    expect(refusal!.message).toContain('nd-svc-api-data (used by service "api" on the panel host)');
    expect(refusal!.message).toContain('nd-db-pg-data (used by database "pg" on the panel host)');
    expect(ops()).toEqual([]);
    await expect(rv.assertRemoteVolumeSupported(db, await webRow(), { probe })).rejects.toBeInstanceOf(HttpError);
    // A volume shared with a service on the SAME node is fine; one on another node is not.
    const conflicts = await rv.attachmentHostConflicts(db, { id: api, serverId: null }, ['nd-svc-web-data']);
    expect(conflicts).toEqual([{ volume: 'nd-svc-web-data', user: 'service "web"', serverId: node }]);
    expect(await rv.attachmentHostConflicts(db, { id: api, serverId: node }, ['nd-svc-web-data'])).toEqual([]);
    expect(await rv.attachmentHostConflicts(db, { id: api, serverId: other }, [])).toEqual([]);
  });

  it('the default probe asks the real node (agentOp) and persists the capability cache', async () => {
    h.ping = CAPS_015;
    await expect(rv.assertRemoteVolumeSupported(db, { ...(await webRow()), cmd: ['x'] })).rejects.toMatchObject({ statusCode: 422, code: 'node_agent_outdated' });
    expect(ops()).toEqual(['agent.ping']);
    expect((await db.query.servers.findFirst({ where: (s, { eq }) => eq(s.id, node) }))!.agentVersion).toBe('0.15.1');
  });
});

describe('ensureNodeVolumes and the compose pre-create (D9)', () => {
  const agent = async (op: string, params: Record<string, unknown>) => {
    h.ops.push({ op, params });
    if (op === 'agent.ping') return { exitCode: 0, lines: h.ping ? [h.ping] : [] };
    if (op === 'docker.volumeInspect') {
      if (h.volumes.has(params['name'] as string)) return { exitCode: 0, lines: [] };
      throw new Error('agent docker.volumeInspect exited with 1');
    }
    if (op === 'docker.volumeCreate') h.volumes.set(params['name'] as string, params['labels'] as Record<string, string>);
    return { exitCode: 0, lines: [] };
  };

  it('creates only the missing service volumes, never a database volume, never a bind mount', async () => {
    h.volumes.set('nd-svc-a-data', {});
    const log: string[] = [];
    const out = await rv.ensureNodeVolumes(agent, ['nd-svc-a-data', 'nd-svc-b', 'nd-svc-b', 'nd-db-pg-data'], { 'ninedeploy.managed': 'volume' }, (l) => log.push(l));
    expect(out).toEqual({ created: ['nd-svc-b'], missingDatabaseVolumes: ['nd-db-pg-data'] });
    expect(h.volumes.get('nd-svc-b')).toEqual({ 'ninedeploy.managed': 'volume' });
    expect(log).toEqual(['Created volume nd-svc-b on the node']);
    await expect(rv.ensureNodeVolumes(agent, ['/etc'], {}, () => undefined)).rejects.toThrow(/bind mounts are never attachable/);
    expect(rv.nodeVolumeLabels({ serviceId: 3, userId: 9 })).toEqual({ 'ninedeploy.managed': 'volume', 'ninedeploy.owner': '9', 'ninedeploy.service': '3' });
  });

  it('a 0.15 agent keeps the 0.15 behaviour: nothing created, one log line naming the update', async () => {
    h.ping = CAPS_015;
    const log: string[] = [];
    const created = await rv.precreateComposeVolumes(agent, {
      nodeLabel: '"edge-1" (#1)',
      service: { id: 1 },
      attachments: [{ volumeName: 'nd-svc-x', containerPath: '/x' }],
      log: (l) => log.push(l),
    });
    expect(created).toEqual([]);
    expect(ops()).toEqual(['agent.ping']);
    expect(log.join('\n')).toMatch(/not pre-created on node "edge-1" \(#1\).*v0\.15\.2 or newer.*compose up needs them to exist/s);
  });

  it('a missing database volume is reported, not created; non-managed names are left to compose', async () => {
    const log: string[] = [];
    const created = await rv.precreateComposeVolumes(agent, {
      nodeLabel: '#1',
      service: { id: 2, ownerUserId: 5 },
      attachments: [{ volumeName: 'nd-db-pg-data', containerPath: '/pg' }, { volumeName: 'nd-svc-y', containerPath: '/y' }, { volumeName: 'legacy', containerPath: '/l' }],
      log: (l) => log.push(l),
    });
    expect(created).toEqual(['nd-svc-y']);
    expect(h.volumes.get('nd-svc-y')).toEqual({ 'ninedeploy.managed': 'volume', 'ninedeploy.owner': '5', 'ninedeploy.service': '2' });
    expect(log.join('\n')).toMatch(/Database volume nd-db-pg-data does not exist on node #1/);
    expect(await rv.precreateComposeVolumes(agent, { nodeLabel: '#1', service: { id: 2 }, attachments: [{ volumeName: 'legacy', containerPath: '/l' }], log: () => undefined })).toEqual([]);
  });
});

// ── engine/builders/remoteRun.ts ────────────────────────────────────────────

describe('runRemoteContainer on docker.runSpec (design §4.2, §1.6)', () => {
  const service = (over: Record<string, unknown> = {}) =>
    ({ id: 11, name: 'minio', slug: 'minio', serverId: 1, port: 9000, cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, volumeMount: null, publishedPort: null, cmd: null, dockerSocket: false, ownerUserId: 4, ...over }) as never;
  function nodeAgent(opts: { ping?: string; runFails?: boolean } = {}) {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const agent = async (op: string, params: Record<string, unknown>) => {
      calls.push({ op, params });
      if (op === 'agent.ping') return { exitCode: 0, lines: [opts.ping ?? CAPS_ALL] };
      if (op === 'docker.volumeInspect') {
        if (h.volumes.has(params['name'] as string)) return { exitCode: 0, lines: [] };
        throw new Error('agent docker.volumeInspect exited with 1');
      }
      if (op === 'docker.volumeCreate') h.volumes.set(params['name'] as string, params['labels'] as Record<string, string>);
      if (op === 'file.writeEnv') return { exitCode: 0, lines: [`wrote .agent-env/${params['name']}.env`] };
      if (op === 'docker.runSpec' && opts.runFails) throw new Error('agent docker.runSpec exited with 125');
      return { exitCode: 0, lines: [] };
    };
    return { agent, calls, ops: () => calls.map((c) => c.op) };
  }
  const input = (svc: never, over: Record<string, unknown> = {}) => ({ service: svc, deploymentId: 7, env: { A: '1' }, name: 'minio-7', image: 'minio/minio:latest', log: () => undefined, ...over });

  it('the regression baseline: nothing new needed → docker.runEnv exactly as 0.15, no ping', async () => {
    const n = nodeAgent({ ping: CAPS_015 });
    await runRemoteContainer(n.agent, input(service({ volumeMount: '/data' })));
    expect(n.ops()).toEqual(['file.writeEnv', 'docker.runEnv', 'file.deleteEnv']);
    expect(n.calls[1]!.params).toEqual({ name: 'minio-7', image: 'minio/minio:latest', envFile: '.agent-env/minio-7.env', volume: 'nd-svc-minio-data', mount: '/data' });
  });

  it('cmd + socket + attachments: capability check, volumes pre-created, then runSpec — which the agent accepts', async () => {
    h.volumes.set('nd-svc-shared', {});
    const n = nodeAgent();
    const log: string[] = [];
    await runRemoteContainer(
      n.agent,
      input(service({ volumeMount: '/data', cmd: ['server', '/data'], dockerSocket: true, publishedPort: 9001, cpuShares: 512, cpuLimitMilli: 1500, memLimitMb: 256 }), {
        volumeAttachments: [{ volumeName: 'nd-svc-shared', containerPath: '/shared', readOnly: true }],
        nodeLabel: '"edge-1" (#1)',
        log: (l: string) => log.push(l),
      }),
    );
    expect(n.ops()).toEqual(['agent.ping', 'docker.volumeInspect', 'docker.volumeCreate', 'docker.volumeInspect', 'file.writeEnv', 'docker.runSpec', 'file.deleteEnv']);
    expect(h.volumes.get('nd-svc-minio-data')).toEqual({ 'ninedeploy.managed': 'volume', 'ninedeploy.owner': '4', 'ninedeploy.service': '11' });
    const spec = n.calls.find((c) => c.op === 'docker.runSpec')!.params;
    expect(spec).toEqual({
      name: 'minio-7',
      image: 'minio/minio:latest',
      envFile: '.agent-env/minio-7.env',
      restart: 'unless-stopped',
      network: 'ninedeploy',
      deploymentId: 7,
      serviceId: 11,
      volumes: [{ name: 'nd-svc-minio-data', mount: '/data' }, { name: 'nd-svc-shared', mount: '/shared', readOnly: true }],
      dockerSocket: true,
      cmd: ['server', '/data'],
      publish: '9001:9000',
      cpuShares: 512,
      cpuLimitMilli: 1500,
      memLimitMb: 256,
    });
    // The agent's own validator takes exactly this request.
    expect(runSpecArgv(parseRunSpec(spec, {}), 'run')).toEqual([
      'run', '-d', '--name', 'minio-7', '--restart', 'unless-stopped', '--network', 'ninedeploy',
      '--label', 'ninedeploy.managed=service', '--label', 'ninedeploy.deployment=7', '--label', 'ninedeploy.service=11',
      '--cpu-shares', '512', '--cpus', '1.5', '--memory', '256m', '--memory-swap', '256m',
      '-v', 'nd-svc-minio-data:/data', '-v', 'nd-svc-shared:/shared:ro', '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '--env-file', '.agent-env/minio-7.env', '-p', '9001:9000', 'minio/minio:latest', 'server', '/data',
    ]);
    expect(log).toContain('Created volume nd-svc-minio-data on the node');
  });

  it('a 0.15 agent: refused with the update message, only agent.ping, no env-file written', async () => {
    const n = nodeAgent({ ping: CAPS_015 });
    await expect(runRemoteContainer(n.agent, input(service({ cmd: ['server'] }), { nodeLabel: '"edge-1" (#1)' }))).rejects.toThrow(
      /"edge-1" \(#1\) \(version 0\.15\.1\) cannot run a service with volume attachments, a command or the Docker socket\. Update the node agent to v0\.15\.2/,
    );
    expect(n.ops()).toEqual(['agent.ping']);
  });

  it('an attached database volume missing on the node fails before anything is written', async () => {
    const n = nodeAgent();
    await expect(runRemoteContainer(n.agent, input(service(), { volumeAttachments: [{ volumeName: 'nd-db-pg-data', containerPath: '/pg' }] }))).rejects.toThrow(
      /Database volume nd-db-pg-data does not exist on node #1/,
    );
    expect(n.ops()).not.toContain('file.writeEnv');
    expect(n.ops()).not.toContain('docker.volumeCreate');
  });

  it('a failed runSpec removes the half-made container and still deletes the env-file', async () => {
    const n = nodeAgent({ runFails: true });
    await expect(runRemoteContainer(n.agent, input(service({ dockerSocket: true })))).rejects.toThrow(/125/);
    expect(n.ops().slice(-3)).toEqual(['docker.runSpec', 'docker.rm', 'file.deleteEnv']);
  });

  it('runSpecParams falls back to the computed env-file path when the agent answered another shape', () => {
    expect(runSpecParams(service(), { name: 'n', image: 'i', envFile: '/abs/x.env', envFileName: 'minio-7', deploymentId: 7, volumes: [] })).toMatchObject({ envFile: '.agent-env/minio-7.env' });
  });
});

// ── modules/volumes.ts ──────────────────────────────────────────────────────

async function volumesApp() {
  const app = await buildTestApp({ db });
  await app.register(volumeRoutes, { prefix: '/volumes' });
  await app.register(volumeBackupRoutes, { prefix: '/volumes' });
  return app;
}

describe('node volumes on the Volumes routes (design §4.3)', () => {
  it('GET ?serverId= lists the node volumes: owners on that node only, inUse from the node, sizes, provenance', async () => {
    h.volumes.set('nd-svc-web-data', { 'ninedeploy.managed': 'volume' });
    h.volumes.set('nd-svc-api-data', {}); // api lives on the panel host: this copy is ownerless here
    h.volumes.set('nd-db-old-data', { 'ninedeploy.managed': 'database', 'ninedeploy.database.name': 'old', 'ninedeploy.database.engine': 'postgres' });
    h.volumes.set('random', {});
    h.usage = ['web-7\trunning\tnd-svc-web-data,/etc/hosts', 'gone\texited\tnd-svc-api-data'];
    const app = await volumesApp();
    const res = await app.inject({ method: 'GET', url: `/volumes?serverId=${node}`, headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { name: 'nd-svc-web-data', sizeBytes: 4096, owner: { kind: 'service', id: web, name: 'web' }, inUse: true, serverId: node },
      { name: 'nd-svc-api-data', sizeBytes: 4096, owner: null, inUse: false, serverId: node },
      { name: 'nd-db-old-data', sizeBytes: 4096, owner: null, inUse: false, serverId: node, retainedFrom: { name: 'old', engine: 'postgres' } },
    ]);
    expect((await app.inject({ method: 'GET', url: '/volumes?serverId=abc', headers: asUser() })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/volumes?serverId=999', headers: asUser() })).statusCode).toBe(404);
    await app.close();
  });

  it('GET ?serverId= on a 0.15 agent: 422 node_agent_outdated after agent.ping only', async () => {
    h.ping = CAPS_015;
    const app = await volumesApp();
    const res = await app.inject({ method: 'GET', url: `/volumes?serverId=${node}`, headers: asUser() });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('node_agent_outdated');
    expect(ops()).toEqual(['agent.ping']);
    await app.close();
  });

  it('POST /volumes creates on a node (labelled, audited) and refuses an existing one with 409', async () => {
    const app = await volumesApp();
    const res = await app.inject({ method: 'POST', url: '/volumes', headers: asUser(), payload: { name: 'nd-svc-cache', serverId: node } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true, name: 'nd-svc-cache', serverId: node });
    expect(h.volumes.get('nd-svc-cache')).toEqual({ 'ninedeploy.managed': 'volume', 'ninedeploy.owner': '1' });
    expect(h.ops.find((o) => o.op === 'docker.volumeCreate')!.params).toMatchObject({ ifExists: 'fail' });
    expect(audits.audit).toHaveBeenCalledWith(expect.anything(), 1, 'volume.create', `nd-svc-cache on node #${node}`);
    const again = await app.inject({ method: 'POST', url: '/volumes', headers: asUser(), payload: { name: 'nd-svc-cache', serverId: node } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('node_volume_exists');
    expect((await app.inject({ method: 'POST', url: '/volumes', headers: asUser(), payload: { name: '/etc', serverId: node } })).statusCode).toBe(400);
    await app.close();
  });

  it('POST /volumes without a serverId creates on the panel host; an existing one is 409', async () => {
    const app = await volumesApp();
    const res = await app.inject({ method: 'POST', url: '/volumes', headers: asUser(), payload: { name: 'nd-svc-panel' } });
    expect(res.statusCode).toBe(201);
    expect(engine.created).toEqual([{ name: 'nd-svc-panel', labels: { 'ninedeploy.managed': 'volume', 'ninedeploy.owner': '1' } }]);
    expect(audits.audit).toHaveBeenCalledWith(expect.anything(), 1, 'volume.create', 'nd-svc-panel');
    expect((await app.inject({ method: 'POST', url: '/volumes', headers: asUser(), payload: { name: 'nd-svc-panel', serverId: null } })).statusCode).toBe(409);
    expect(ops()).toEqual([]);
    await app.close();
  });

  it('the file manager refuses a node volume instead of touching the panel host namesake', async () => {
    const app = await volumesApp();
    for (const [method, url] of [
      ['GET', `/volumes/nd-svc-web-data/files?serverId=${node}`],
      ['GET', `/volumes/nd-svc-web-data/files/content?path=a&serverId=${node}`],
      ['DELETE', `/volumes/nd-svc-web-data/files?path=a&serverId=${node}`],
    ] as const) {
      const res = await app.inject({ method, url, headers: asUser() });
      expect(res.statusCode, url).toBe(422);
      expect(res.json().error.code).toBe('node_volume_files_unsupported');
    }
    expect(files.listVolumeDir).not.toHaveBeenCalled();
    // The panel host's file manager is unchanged.
    expect((await app.inject({ method: 'GET', url: '/volumes/nd-svc-web-data/files', headers: asUser() })).statusCode).toBe(200);
    await app.close();
  });
});

// ── node volume backups (design §4.2) ───────────────────────────────────────

const decrypted = async (file: string) => {
  const chunks: Buffer[] = [];
  for await (const c of await createBackupReadStream(file)) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
};

describe('node volume backups and restores through the stream channel', () => {
  it('backs a node volume up into the backups directory, encrypted like a panel-host backup, with server_id', async () => {
    h.volumes.set('nd-svc-web-data', {});
    const app = await volumesApp();
    const res = await app.inject({ method: 'POST', url: `/volumes/nd-svc-web-data/backups?serverId=${node}`, headers: asUser(), payload: { label: 'before-upgrade' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ volumeName: 'nd-svc-web-data', scope: 'volumes', status: 'completed', label: 'before-upgrade', serverId: node });
    const row = (await db.select().from(backups))[0]!;
    // Same directory and file name as a panel-host backup of the volume.
    expect(path.dirname(row.path)).toBe(path.join(tmp, 'volumes', 'nd-svc-web-data'));
    expect(path.basename(row.path)).toMatch(/^nd-svc-web-data-.*-before-upgrade\.tar\.gz$/);
    // At rest: the NDBK1 envelope, never the plaintext archive.
    const raw = readFileSync(row.path);
    expect(raw.subarray(0, 6).toString()).toBe('NDBK1:');
    expect(raw.includes(h.exportBytes)).toBe(false);
    expect(await decrypted(row.path)).toEqual(h.exportBytes);
    expect(row.sizeBytes).toBe(raw.length);
    expect(h.streams).toEqual([{ kind: 'volume.export', params: { volume: 'nd-svc-web-data' } }]);
    expect(remote.uploadBackup).toHaveBeenCalledWith(expect.anything(), row.id, row.path, expect.any(Function));
    expect(audits.audit).toHaveBeenCalledWith(expect.anything(), 1, 'volume.backup.create', expect.stringMatching(new RegExp(`^nd-svc-web-data on node #${node} → `)));
    // No temporary file is left next to it.
    expect(readdirSync(path.dirname(row.path)).filter((f) => f.endsWith('.part'))).toEqual([]);
    await app.close();
  });

  it('a stream that fails its end check leaves no file and a failed row', async () => {
    h.volumes.set('nd-svc-web-data', {});
    h.exportFails = true;
    const app = await volumesApp();
    const res = await app.inject({ method: 'POST', url: `/volumes/nd-svc-web-data/backups?serverId=${node}`, headers: asUser(), payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/integrity check failed/);
    const row = (await db.select().from(backups))[0]!;
    expect(row.status).toBe('failed');
    expect(existsSync(row.path)).toBe(false);
    expect(readdirSync(path.dirname(row.path)).filter((f) => f.startsWith(path.basename(row.path)))).toEqual([]);
    await app.close();
  });

  it('a 0.15 agent: 422 node_agent_outdated, only agent.ping, no row', async () => {
    h.volumes.set('nd-svc-web-data', {});
    h.ping = CAPS_015;
    const app = await volumesApp();
    const res = await app.inject({ method: 'POST', url: `/volumes/nd-svc-web-data/backups?serverId=${node}`, headers: asUser(), payload: {} });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('node_agent_outdated');
    expect(ops().filter((o) => o !== 'docker.volumeInspect')).toEqual(['agent.ping']);
    expect(await db.select().from(backups)).toEqual([]);
    expect(h.streams).toEqual([]);
    await app.close();
  });

  it('404s a volume that is not on the node', async () => {
    const app = await volumesApp();
    const res = await app.inject({ method: 'POST', url: `/volumes/nd-svc-web-data/backups?serverId=${node}`, headers: asUser(), payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toMatch(/does not exist on node #/);
    await app.close();
  });

  it('restores on the node through volume.import; refused while the service runs there; cross-host needs acrossHosts', async () => {
    h.volumes.set('nd-svc-web-data', {});
    const app = await volumesApp();
    await app.inject({ method: 'POST', url: `/volumes/nd-svc-web-data/backups?serverId=${node}`, headers: asUser(), payload: {} });
    const row = (await db.select().from(backups))[0]!;
    h.ops = [];

    // The service runs on the node: the panel host's "stop the service" message.
    h.usage = ['web-7\trunning\tnd-svc-web-data'];
    const busy = await app.inject({ method: 'POST', url: `/volumes/nd-svc-web-data/backups/${row.id}/restore?serverId=${node}`, headers: asUser() });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.message).toBe('Service "web" is running — stop the service before restoring');
    h.usage = ['stray\trunning\tnd-svc-web-data'];
    expect((await app.inject({ method: 'POST', url: `/volumes/nd-svc-web-data/backups/${row.id}/restore?serverId=${node}`, headers: asUser() })).json().error.message).toMatch(
      /in use on node #\d+ by stray — stop it/,
    );
    expect(h.streams.filter((s) => s.kind === 'volume.import')).toEqual([]);

    h.usage = ['web-7\texited\tnd-svc-web-data'];
    const ok = await app.inject({ method: 'POST', url: `/volumes/nd-svc-web-data/backups/${row.id}/restore?serverId=${node}`, headers: asUser() });
    expect(ok.statusCode).toBe(200);
    expect(Buffer.concat(h.imported)).toEqual(h.exportBytes); // the decrypted archive, not the envelope
    expect(engine.restored).toEqual([]);
    expect(audits.audit).toHaveBeenCalledWith(expect.anything(), 1, 'volume.backup.restore', expect.stringMatching(/^nd-svc-web-data on node #\d+ ← /));

    // To the panel host (or another node), only when confirmed.
    engine.panelVolumes.add('nd-svc-web-data');
    const across = await app.inject({ method: 'POST', url: `/volumes/nd-svc-web-data/backups/${row.id}/restore`, headers: asUser() });
    expect(across.statusCode).toBe(409);
    expect(across.json().error).toMatchObject({ code: 'backup_host_mismatch', message: expect.stringMatching(/taken on node #\d+ and the restore targets the panel host/) });
    const confirmed = await app.inject({ method: 'POST', url: `/volumes/nd-svc-web-data/backups/${row.id}/restore?acrossHosts=true`, headers: asUser() });
    expect(confirmed.statusCode).toBe(200);
    expect(engine.restored).toEqual(['nd-svc-web-data']);
    await app.close();
  });

  it('a restore on a node that cannot answer the usage probe fails closed (503); junk usage lines are ignored', async () => {
    h.volumes.set('nd-svc-web-data', {});
    const [row] = await db.insert(backups).values({ volumeName: 'nd-svc-web-data', scope: 'volumes', status: 'completed', path: path.join(tmp, 'missing.tar.gz'), serverId: node }).returning();
    const app = await volumesApp();
    const url = `/volumes/nd-svc-web-data/backups/${row!.id}/restore?serverId=${node}`;
    h.usageThrows = true;
    const res = await app.inject({ method: 'POST', url, headers: asUser() });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toMatch(/Could not verify on node #\d+ that nothing uses nd-svc-web-data .*restore refused/);
    h.usageThrows = false;
    h.usage = ['garbage'];
    // Nothing mounts it → on to the backup file, which is gone locally and remotely → 404.
    expect((await app.inject({ method: 'POST', url, headers: asUser() })).statusCode).toBe(404);
    expect(h.streams).toEqual([]);
    await app.close();
  });

  it('lists per host with ?serverId=, and every row says where it was taken', async () => {
    engine.panelVolumes.add('nd-svc-web-data');
    h.volumes.set('nd-svc-web-data', {});
    await db.insert(backups).values([
      { volumeName: 'nd-svc-web-data', scope: 'volumes', status: 'completed', path: '/x/a', createdAt: new Date(1000) },
      { volumeName: 'nd-svc-web-data', scope: 'volumes', status: 'completed', path: '/x/b', createdAt: new Date(2000), serverId: node },
    ]);
    const app = await volumesApp();
    const all = (await app.inject({ method: 'GET', url: '/volumes/nd-svc-web-data/backups', headers: asUser() })).json() as Array<{ path?: string; serverId: number | null }>;
    expect(all.map((r) => r.serverId)).toEqual([node, null]);
    const onNode = (await app.inject({ method: 'GET', url: `/volumes/nd-svc-web-data/backups?serverId=${node}`, headers: asUser() })).json() as Array<{ serverId: number | null }>;
    expect(onNode.map((r) => r.serverId)).toEqual([node]);
    await app.close();
  });
});

describe('scheduled backups of a node service (backupServiceVolumes)', () => {
  it('streams every volume of a node service from its node, rows carry server_id', async () => {
    h.volumes.set('nd-svc-web-data', {});
    h.volumes.set('nd-svc-web-cache', {});
    await db.insert(serviceVolumeAttachments).values([
      { serviceId: web, volumeName: 'nd-svc-web-cache', containerPath: '/cache' },
      { serviceId: web, volumeName: 'nd-svc-gone', containerPath: '/gone' },
    ]);
    const log: string[] = [];
    expect(await backupServiceVolumes({ db } as never, web, (l) => log.push(l))).toEqual({ created: 2, failed: 1 });
    const rows = await db.select().from(backups);
    expect(rows.map((r) => [r.volumeName, r.serverId, r.status]).sort()).toEqual([
      ['nd-svc-web-cache', node, 'completed'],
      ['nd-svc-web-data', node, 'completed'],
    ]);
    expect(rows.every((r) => r.label?.startsWith('schedule-'))).toBe(true);
    expect(log).toContain(`Skipping nd-svc-gone — not on node #${node}`);
    expect(engine.restored).toEqual([]);
  });

  it('a 0.15 agent: every volume counted failed with the update message, nothing written', async () => {
    h.ping = CAPS_015;
    const log: string[] = [];
    expect(await backupServiceVolumes({ db } as never, web, (l) => log.push(l))).toEqual({ created: 0, failed: 1 });
    expect(log.join('\n')).toMatch(/Skipping nd-svc-web-data on node #\d+: .*v0\.15\.2 or newer/);
    expect(await db.select().from(backups)).toEqual([]);
    expect(ops()).toEqual(['agent.ping']);
  });
});

describe('upgrade safety: panel-host backups behave exactly as before', () => {
  it('retention is per host: node copies never push panel-host copies out (and every pre-0.16 row is panel-host)', async () => {
    const mk = (n: number, serverId: number | null) => {
      const file = path.join(tmp, `ret-${n}-${serverId ?? 'p'}.tar.gz`);
      writeFileSync(file, 'x');
      return { volumeName: 'nd-svc-web-data', scope: 'volumes' as const, status: 'completed' as const, path: file, createdAt: new Date(n * 1000), serverId };
    };
    await db.insert(backups).values([mk(1, null), mk(2, null), mk(3, null), mk(4, node), mk(5, node), mk(6, node)]);
    expect(await pruneOldBackups(db as never, 'nd-svc-web-data')).toEqual({ deleted: 1, kept: 2 });
    let rows = await db.select().from(backups);
    expect(rows.filter((r) => r.serverId === null).map((r) => r.createdAt.getTime()).sort()).toEqual([2000, 3000]);
    expect(rows.filter((r) => r.serverId === node)).toHaveLength(3);
    expect(await pruneOldBackups(db as never, 'nd-svc-web-data', () => undefined, node)).toEqual({ deleted: 1, kept: 2 });
    rows = await db.select().from(backups);
    expect(rows.filter((r) => r.serverId === node).map((r) => r.createdAt.getTime()).sort()).toEqual([5000, 6000]);
  });

  it('a panel-host service still backs up through the panel host (no agent, no stream)', async () => {
    const res = await backupServiceVolumes({ db } as never, api, () => undefined);
    expect(res).toEqual({ created: 0, failed: 0 }); // api has no volumes: nothing to do, as before
    expect(ops()).toEqual([]);
    expect(h.streams).toEqual([]);
  });

  it('restoring a pre-0.16 row (server_id NULL) on the panel host needs no confirmation', async () => {
    engine.panelVolumes.add('nd-svc-api-data');
    const file = path.join(tmp, 'legacy.tar.gz');
    writeFileSync(file, 'legacy plaintext tarball');
    const [row] = await db.insert(backups).values({ volumeName: 'nd-svc-api-data', scope: 'volumes', status: 'completed', path: file }).returning();
    const app = await volumesApp();
    const res = await app.inject({ method: 'POST', url: `/volumes/nd-svc-api-data/backups/${row!.id}/restore`, headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(engine.restored).toEqual(['nd-svc-api-data']);
    expect(ops()).toEqual([]);
    const listed = (await app.inject({ method: 'GET', url: '/volumes/nd-svc-api-data/backups', headers: asUser() })).json() as Array<Record<string, unknown>>;
    expect(listed[0]).toMatchObject({ id: row!.id, serverId: null });
    await app.close();
  });
});

describe('parsers', () => {
  it('parseNodeVolumeList keeps managed names and splits labels', () => {
    expect(nv.parseNodeVolumeList(['{"Name":"nd-svc-a","Labels":"a=1,b=x=y","Mountpoint":"/m"}', 'junk', '{"Name":"other"}', '{"Name":"nd-db-b"}'])).toEqual([
      { name: 'nd-svc-a', labels: { a: '1', b: 'x=y' }, mountpoint: '/m' },
      { name: 'nd-db-b', labels: {}, mountpoint: null },
    ]);
  });
  it('parseNodeVolumeUsage maps volumes to containers and their running state', () => {
    const usage = nv.parseNodeVolumeUsage(['a\trunning\tnd-svc-x,nd-db-y', '/b\trestarting\tnd-svc-x', 'c\texited\t', 'bad line']);
    expect(usage.get('nd-svc-x')).toEqual([{ container: 'a', running: true }, { container: 'b', running: true }]);
    expect(usage.get('nd-db-y')).toEqual([{ container: 'a', running: true }]);
  });
  it('volumeHostId: absent or empty is the panel host', () => {
    expect(nv.volumeHostId(undefined)).toBeNull();
    expect(nv.volumeHostId({ serverId: '' })).toBeNull();
    expect(nv.volumeHostId({ serverId: '7' })).toBe(7);
    expect(() => nv.volumeHostId({ serverId: '0' })).toThrow(/positive integer/);
    expect(() => nv.volumeHostId({ serverId: ['1', '2'] })).toThrow(/positive integer/);
  });
});

void Readable;
