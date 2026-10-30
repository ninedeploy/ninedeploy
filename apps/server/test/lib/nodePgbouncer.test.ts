/**
 * ROADMAP item 10: PgBouncer for a node database. The agent side
 * (agentOps/pgbouncer.ts) against a fake Docker CLI, and the panel's agent
 * calls (lib/nodePgbouncer.ts, lib/nodeAgentReply.ts) against a fake agent.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@ninedeploy/db';

const h = vi.hoisted(() => ({
  containers: new Map<string, { running: boolean; args: string[]; files: Record<string, string> }>(),
  databases: new Map<string, string>(),
  runs: [] as string[][],
  dieOnStart: false,
  agentReply: { exitCode: 0, lines: [] as string[] } as { exitCode: number; lines: string[] } | Error,
  agentCalls: [] as Array<{ op: string; params: Record<string, unknown> }>,
  refusal: null as null | { status: number; code: string; message: string },
}));

vi.mock('../../src/lib/exec.js', () => {
  const docker = (args: string[]): string => {
    const [cmd, ...rest] = args;
    h.runs.push(args);
    if (cmd === 'pull') return '';
    if (cmd === 'rm') {
      h.containers.delete(rest[rest.length - 1]!);
      return '';
    }
    if (cmd === 'create') {
      h.containers.set(args[args.indexOf('--name') + 1]!, { running: false, args, files: {} });
      return 'id';
    }
    if (cmd === 'cp') {
      const [from, to] = rest as [string, string];
      const [name, target] = to.split(':') as [string, string];
      h.containers.get(name)!.files[target] = readFileSync(from, 'utf8');
      return '';
    }
    if (cmd === 'start') {
      h.containers.get(rest[0]!)!.running = !h.dieOnStart;
      return '';
    }
    if (cmd === 'exec') {
      const c = h.containers.get(rest[0]!);
      return c?.files['/etc/pgbouncer/pgbouncer.ini'] ?? '';
    }
    if (cmd === 'inspect') {
      const name = rest[rest.length - 1]!;
      if (rest[0] !== '--format' && h.databases.has(rest[0]!)) return h.databases.get(rest[0]!)!;
      const c = h.containers.get(name);
      if (!c) throw new Error('No such object');
      return `${c.running}\n`;
    }
    throw new Error(`unexpected docker ${args.join(' ')}`);
  };
  return {
    capture: vi.fn(async (_tool: string, args: string[]) => docker(args)),
    run: vi.fn(async (_tool: string, args: string[]) => {
      docker(args);
    }),
  };
});
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

const { pgbouncerOps, pgbouncerForbidden, nodePgbouncerName } = await import('../../src/agentOps/pgbouncer.js');
const node = await import('../../src/lib/nodePgbouncer.js');
const { HttpError } = await import('../../src/lib/errors.js');

const params = (over: Record<string, unknown> = {}) => ({
  databaseId: 7,
  slug: 'shop',
  container: 'nd-db-shop',
  postgresPort: 5432,
  listenPort: 6432,
  user: 'nine',
  dbName: 'app',
  password: 's3cret-Pw',
  ...over,
});
async function op(name: string, p: Record<string, unknown>) {
  const lines: string[] = [];
  const code = await pgbouncerOps.ops[name]!.run(p, (l) => lines.push(l), { sealed: true });
  expect(lines).toHaveLength(1);
  return { code, reply: JSON.parse(lines[0]!.replace(/^ND-PGBOUNCER /, '')) };
}

beforeEach(() => {
  h.containers.clear();
  h.databases.clear();
  h.runs.length = 0;
  h.dieOnStart = false;
  h.agentCalls.length = 0;
  h.refusal = null;
  h.agentReply = { exitCode: 0, lines: [] };
  h.databases.set('nd-db-shop', 'database|7|shop|true\n');
  delete process.env['NINEDEPLOY_AGENT_PGBOUNCER'];
  delete process.env['NINEDEPLOY_AGENT_DATABASES'];
});

describe('agent: db.pgbouncer.*', () => {
  it('starts the sidecar on the database’s own bridge with no published port; the config is copied in', async () => {
    expect(pgbouncerOps.ops['db.pgbouncer.enable']!.sealedOnly).toBe(true);
    expect(await op('db.pgbouncer.enable', params())).toEqual({ code: 0, reply: { containerName: 'nd-pgb-shop', running: true } });
    const c = h.containers.get('nd-pgb-shop')!;
    expect(c.args[c.args.indexOf('--network') + 1]).toBe('nd-dbnet-shop');
    expect(c.args).not.toContain('-p');
    expect(c.files['/etc/pgbouncer/pgbouncer.ini']).toContain('app = host=nd-db-shop port=5432');
    expect(c.files['/etc/pgbouncer/userlist.txt']).toBe('"nine" "s3cret-Pw"\n');
    expect(await op('db.pgbouncer.status', { slug: 'shop' })).toEqual({ code: 0, reply: { running: true, poolMode: 'transaction' } });
    expect(await op('db.pgbouncer.disable', { slug: 'shop' })).toEqual({ code: 0, reply: { removed: true } });
    expect(await op('db.pgbouncer.status', { slug: 'shop' })).toEqual({ code: 0, reply: { running: false, poolMode: null } });
  });

  it('only fronts the confirmed, running managed database', async () => {
    h.databases.set('nd-db-shop', 'service|7|shop|true\n');
    expect((await op('db.pgbouncer.enable', params())).reply.error.code).toBe('database_identity_changed');
    h.databases.set('nd-db-shop', 'database|7|shop|false\n');
    expect((await op('db.pgbouncer.enable', params())).reply.error).toMatchObject({ status: 409, code: 'not_running' });
    h.databases.delete('nd-db-shop');
    expect((await op('db.pgbouncer.enable', params())).reply.error.code).toBe('database_missing');
    expect(h.containers.size).toBe(0);
  });

  it('a sidecar that dies is removed and reported; the node owner can switch it off', async () => {
    h.dieOnStart = true;
    expect((await op('db.pgbouncer.enable', params())).reply.error).toMatchObject({ status: 502, code: 'pgbouncer_failed' });
    expect(h.containers.has('nd-pgb-shop')).toBe(false);
    h.dieOnStart = false;
    process.env['NINEDEPLOY_AGENT_PGBOUNCER'] = 'off';
    expect((await op('db.pgbouncer.enable', params())).reply.error).toMatchObject({ status: 403, code: 'pgbouncer_disabled' });
    expect(pgbouncerForbidden({ NINEDEPLOY_AGENT_DATABASES: 'false' })).toBe(true);
    expect(pgbouncerForbidden({})).toBe(false);
  });

  it('refuses operands that could break the config before acting', async () => {
    const run = (p: Record<string, unknown>) => pgbouncerOps.ops['db.pgbouncer.enable']!.run(p, () => undefined, { sealed: true });
    for (const bad of [{ user: 'a\nb' }, { dbName: 'x y' }, { password: 'a"b' }, { password: 'a\nauth_type = any' }, { slug: '../x' }, { container: 'other' }, { listenPort: 80 }, { extra: 1 }]) {
      await expect(run(params(bad))).rejects.toThrow();
    }
    expect(() => nodePgbouncerName('A')).toThrow();
    expect(h.runs).toHaveLength(0);
  });
});

describe('panel: calls to the node', () => {
  const db = {} as DB;
  const reply = (body: unknown, exitCode = 0) => {
    h.agentReply = { exitCode, lines: [`ND-PGBOUNCER ${JSON.stringify(body)}`] };
  };
  const input = params();

  it('enables, disables and reads the state through the agent', async () => {
    reply({ containerName: 'nd-pgb-shop', running: true });
    expect(await node.nodeEnablePgbouncer(db, 3, input)).toBe('nd-pgb-shop');
    expect(h.agentCalls[0]).toEqual({ op: 'db.pgbouncer.enable', params: input });
    reply({ removed: true });
    await node.nodeDisablePgbouncer(db, 3, 'shop');
    reply({ running: true, poolMode: 'transaction' });
    expect(await node.nodePgbouncerState(db, 3, 'shop')).toEqual({ running: true, poolMode: 'transaction' });
  });

  it('passes the agent’s refusal on; anything else is unconfirmed; an unreachable node is null for status', async () => {
    reply({ error: { status: 409, code: 'not_running', message: 'start it first' } }, 1);
    await expect(node.nodeEnablePgbouncer(db, 3, input)).rejects.toMatchObject({ statusCode: 409, code: 'not_running' });
    reply({ containerName: 'nd-pgb-shop', running: false });
    await expect(node.nodeEnablePgbouncer(db, 3, input)).rejects.toMatchObject({ code: 'node_pgbouncer_unconfirmed' });
    h.agentReply = new Error('ECONNREFUSED');
    await expect(node.nodeDisablePgbouncer(db, 3, 'shop')).rejects.toMatchObject({ code: 'node_unreachable' });
    expect(await node.nodePgbouncerState(db, 3, 'shop')).toBeNull();
  });

  it('refuses a node whose agent lacks the capability', async () => {
    await expect(node.assertNodePgbouncerSupport(db, 3)).resolves.toBeUndefined();
    h.refusal = { status: 422, code: 'node_agent_outdated', message: 'Update the node agent' };
    await expect(node.assertNodePgbouncerSupport(db, 3)).rejects.toBeInstanceOf(HttpError);
  });
});
