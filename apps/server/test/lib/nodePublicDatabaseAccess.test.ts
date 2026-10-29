/**
 * ROADMAP item 10: public access to a node database. The agent side
 * (agentOps/publicAccess.ts) against a fake Docker CLI in a temp agent home,
 * and the panel's agent calls (lib/nodePublicDatabaseAccess.ts) against a
 * fake agent. Nothing reaches a daemon or a node.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@ninedeploy/db';

const h = vi.hoisted(() => ({
  containers: new Map<string, { running: boolean; fp: string; args: string[] }>(),
  databases: new Map<string, string>(),
  runs: [] as string[][],
  busyPorts: new Set<number>(),
  dieOnStart: false,
  agentReply: { exitCode: 0, lines: [] as string[] } as { exitCode: number; lines: string[] } | Error,
  agentCalls: [] as Array<{ op: string; params: Record<string, unknown> }>,
  refusal: null as null | { status: number; code: string; message: string },
}));

vi.mock('../../src/lib/exec.js', () => {
  const docker = (args: string[], sink?: (l: string) => void): string => {
    const [cmd, ...rest] = args;
    if (cmd === 'rm') {
      h.containers.delete(rest[rest.length - 1]!);
      return '';
    }
    if (cmd === 'run') {
      h.runs.push(args);
      const at = (flag: string) => args[args.indexOf(flag) + 1]!;
      const port = Number(at('-p').split(':')[0]);
      if (h.busyPorts.has(port)) {
        sink?.(`Bind for 0.0.0.0:${port} failed: port is already allocated`);
        throw new Error('`docker run` exited with code 125');
      }
      const fp = args.find((a) => a.startsWith('ninedeploy.dbpub.config-sha='))!.split('=')[1]!;
      h.containers.set(at('--name'), { running: !h.dieOnStart, fp, args });
      return 'id';
    }
    if (cmd === 'inspect') {
      const name = rest[0]!;
      if (h.databases.has(name)) return h.databases.get(name)!;
      const c = h.containers.get(name);
      if (!c) throw new Error('No such object');
      return `${c.running}|${c.fp}\n`;
    }
    if (cmd === 'logs') return 'traefik: bad config';
    throw new Error(`unexpected docker ${args.join(' ')}`);
  };
  return {
    capture: vi.fn(async (_tool: string, args: string[]) => docker(args)),
    run: vi.fn(async (_tool: string, args: string[], _opts: unknown, sink: (l: string) => void) => {
      docker(args, sink);
    }),
    sleep: vi.fn(async () => undefined),
  };
});
vi.mock('../../src/lib/dockerPull.js', () => ({ ensureDockerImage: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/agentClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/agentClient.js')>()),
  agentOp: vi.fn(async (_db: unknown, _id: number, op: string, params: Record<string, unknown>) => {
    h.agentCalls.push({ op, params });
    if (h.agentReply instanceof Error) throw h.agentReply;
    return h.agentReply;
  }),
  agentTransportSealed: vi.fn(async () => true),
}));
vi.mock('../../src/lib/agentCapabilities.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/agentCapabilities.js')>()),
  capabilityRefusal: vi.fn(async () => h.refusal),
  nodeLabel: vi.fn(async () => 'node #3'),
}));

const { publicAccessOps, publicDatabasesForbidden, nodeSidecarDir } = await import('../../src/agentOps/publicAccess.js');
const node = await import('../../src/lib/nodePublicDatabaseAccess.js');
const { HttpError } = await import('../../src/lib/errors.js');
const { sidecarFingerprint } = await import('../../src/lib/publicDatabaseAccess.js');

const home = mkdtempSync(path.join(tmpdir(), 'nd-agent-pub-'));
vi.spyOn(process, 'cwd').mockReturnValue(home);
afterAll(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

const MANAGED = 'database|7|shop';
const params = (over: Record<string, unknown> = {}) => ({
  databaseId: 7,
  slug: 'shop',
  container: 'nd-db-shop',
  enginePort: 5432,
  port: 15432,
  allowlist: ['203.0.113.7/24'],
  ...over,
});
async function op(name: string, p: Record<string, unknown>) {
  const lines: string[] = [];
  const code = await publicAccessOps.ops[name]!.run(p, (l) => lines.push(l), { sealed: true });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^ND-PUBLIC-DB /);
  return { code, reply: JSON.parse(lines[0]!.slice('ND-PUBLIC-DB '.length)) };
}

beforeEach(() => {
  h.containers.clear();
  h.databases.clear();
  h.runs.length = 0;
  h.busyPorts.clear();
  h.dieOnStart = false;
  h.agentCalls.length = 0;
  h.refusal = null;
  h.agentReply = { exitCode: 0, lines: [] };
  h.databases.set('nd-db-shop', `${MANAGED}\n`);
  delete process.env['NINEDEPLOY_AGENT_PUBLIC_DATABASES'];
  delete process.env['NINEDEPLOY_AGENT_DATABASES'];
  rmSync(path.join(home, 'dbproxy'), { recursive: true, force: true });
});

describe('agent: db.publicAccess.*', () => {
  it('starts the sidecar on the database’s own bridge, then only rewrites the allow-list', async () => {
    expect(publicAccessOps.ops['db.publicAccess.apply']!.sealedOnly).toBe(true);
    expect(await op('db.publicAccess.apply', params())).toEqual({ code: 0, reply: { mode: 'started' } });
    const args = h.runs[0]!;
    expect(args[args.indexOf('--network') + 1]).toBe('nd-dbnet-shop');
    expect(args[args.indexOf('-p') + 1]).toBe('15432:7000');
    expect(args[args.indexOf('-v') + 1]).toBe(`${path.join(home, 'dbproxy', 'shop')}:/etc/traefik:ro`);
    const routes = path.join(nodeSidecarDir('shop'), 'dynamic', 'routes.yml');
    expect(readFileSync(routes, 'utf8')).toContain('nd-db-shop:5432');
    expect(readFileSync(routes, 'utf8')).toContain('203.0.113.0/24');

    expect(await op('db.publicAccess.apply', params({ allowlist: ['198.51.100.1'] }))).toEqual({ code: 0, reply: { mode: 'hot' } });
    expect(h.runs).toHaveLength(1);
    expect(readFileSync(routes, 'utf8')).toContain('198.51.100.1/32');
    // Another port: the sidecar is replaced.
    expect((await op('db.publicAccess.apply', params({ port: 15433 }))).reply).toEqual({ mode: 'started' });
    expect(h.containers.get('nd-dbpub-shop')!.fp).toBe(sidecarFingerprint(15433));

    expect(await op('db.publicAccess.inspect', { slug: 'shop' })).toEqual({ code: 0, reply: { running: true, fingerprint: sidecarFingerprint(15433) } });
    expect(await op('db.publicAccess.remove', { slug: 'shop' })).toEqual({ code: 0, reply: { removed: true } });
    expect(existsSync(nodeSidecarDir('shop'))).toBe(false);
    expect(await op('db.publicAccess.inspect', { slug: 'shop' })).toEqual({ code: 0, reply: { running: false, fingerprint: null } });
  });

  it('proxies only to the confirmed managed database', async () => {
    h.databases.set('nd-db-shop', 'service|7|shop\n');
    expect(await op('db.publicAccess.apply', params())).toEqual({
      code: 1,
      reply: { error: { status: 409, code: 'database_identity_changed', message: expect.any(String) } },
    });
    h.databases.delete('nd-db-shop');
    expect((await op('db.publicAccess.apply', params())).reply.error.code).toBe('database_missing');
    expect(h.runs).toHaveLength(0);
  });

  it('reports a busy port and a sidecar that dies; the node owner can switch it off', async () => {
    h.busyPorts.add(15432);
    expect((await op('db.publicAccess.apply', params())).reply.error).toMatchObject({ status: 409 });
    h.busyPorts.clear();
    h.dieOnStart = true;
    expect((await op('db.publicAccess.apply', params())).reply.error).toMatchObject({ status: 502, code: 'public_access_failed' });
    h.dieOnStart = false;
    process.env['NINEDEPLOY_AGENT_PUBLIC_DATABASES'] = 'off';
    expect(publicDatabasesForbidden()).toBe(true);
    expect((await op('db.publicAccess.apply', params())).reply.error).toMatchObject({ status: 403, code: 'public_access_disabled' });
    expect(publicDatabasesForbidden({ NINEDEPLOY_AGENT_DATABASES: 'no' })).toBe(true);
    expect(publicDatabasesForbidden({})).toBe(false);
  });

  it('refuses bad operands before acting', async () => {
    const run = (p: Record<string, unknown>) => publicAccessOps.ops['db.publicAccess.apply']!.run(p, () => undefined, { sealed: true });
    for (const bad of [{ slug: '../x' }, { container: 'evil' }, { port: 80 }, { allowlist: [] }, { extra: 1 }]) {
      await expect(run(params(bad))).rejects.toThrow();
    }
    expect(() => nodeSidecarDir('../x')).toThrow();
  });
});

describe('panel: calls to the node', () => {
  const db = {} as DB;
  const reply = (body: unknown, exitCode = 0) => {
    h.agentReply = { exitCode, lines: ['noise', `ND-PUBLIC-DB ${JSON.stringify(body)}`] };
  };
  const input = { databaseId: 7, slug: 'shop', container: 'nd-db-shop', enginePort: 5432, port: 15432, allowlist: ['203.0.113.0/24'] };

  it('applies, removes and inspects through the agent', async () => {
    reply({ mode: 'started' });
    expect(await node.nodeApplySidecar(db, 3, input)).toEqual({ mode: 'started' });
    expect(h.agentCalls[0]).toEqual({ op: 'db.publicAccess.apply', params: input });
    reply({ removed: true });
    await node.nodeRemoveSidecar(db, 3, 'shop');
    reply({ running: true, fingerprint: 'x' });
    expect(await node.nodeSidecarRunning(db, 3, 'shop')).toBe(true);
  });

  it('passes the agent’s refusal on, and treats anything else as unconfirmed', async () => {
    reply({ error: { status: 409, code: 'database_identity_changed', message: 'not ours' } }, 1);
    await expect(node.nodeApplySidecar(db, 3, input)).rejects.toMatchObject({ statusCode: 409, code: 'database_identity_changed' });
    reply({ nonsense: true }, 1);
    await expect(node.nodeApplySidecar(db, 3, input)).rejects.toMatchObject({ statusCode: 502, code: 'node_public_access_unconfirmed' });
    reply({ mode: 'sideways' });
    await expect(node.nodeApplySidecar(db, 3, input)).rejects.toMatchObject({ code: 'node_public_access_unconfirmed' });
    h.agentReply = { exitCode: 0, lines: ['ND-PUBLIC-DB {not json'] };
    await expect(node.nodeApplySidecar(db, 3, input)).rejects.toMatchObject({ code: 'node_public_access_unconfirmed' });
    h.agentReply = { exitCode: 0, lines: [] };
    await expect(node.nodeRemoveSidecar(db, 3, 'shop')).rejects.toMatchObject({ code: 'node_public_access_unconfirmed' });
    h.agentReply = new Error('ECONNREFUSED');
    await expect(node.nodeApplySidecar(db, 3, input)).rejects.toMatchObject({ statusCode: 502, code: 'node_unreachable' });
    h.agentReply = new HttpError(409, 'agent_refused', 'sealed only');
    await expect(node.nodeApplySidecar(db, 3, input)).rejects.toMatchObject({ code: 'agent_refused' });
    // Status reads never throw: an unreachable node is "unknown".
    expect(await node.nodeSidecarRunning(db, 3, 'shop')).toBeNull();
  });

  it('refuses a node whose agent lacks the capability or a sealed transport', async () => {
    await expect(node.assertNodePublicAccessSupport(db, 3)).resolves.toBeUndefined();
    h.refusal = { status: 422, code: 'agent_outdated', message: 'Update the node agent to v0.18.11' };
    await expect(node.assertNodePublicAccessSupport(db, 3)).rejects.toMatchObject({ statusCode: 422, code: 'agent_outdated' });
  });
});
