/**
 * ROADMAP item 10: file mounts on Swarm (lib/swarmFileSecrets.ts and the
 * native ServiceSpec mapping in engine/swarmServiceSpec.ts) against a fake
 * Docker CLI. The real Swarm path is proven by scripts/smoke-multinode.mjs.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  secrets: new Map<string, { id: string; labels: string[]; data: string; inUse: boolean }>(),
  calls: [] as string[][],
  failCreate: false,
  listFails: false,
  network: 'abcdefghijklmnopqrstuvwxy',
}));
vi.mock('../../src/lib/exec.js', () => ({
  capture: vi.fn(async (_tool: string, args: string[], _opts: unknown, input?: Buffer) => {
    h.calls.push(args);
    const [group, cmd] = args;
    if (group === 'network') return `${h.network}\n`;
    if (group !== 'secret') throw new Error(`unexpected docker ${args.join(' ')}`);
    if (cmd === 'inspect') {
      const s = h.secrets.get(args[args.length - 1]!);
      if (!s) throw new Error('No such secret');
      return `${s.id}\n`;
    }
    if (cmd === 'create') {
      const name = args[args.length - 2]!;
      if (h.failCreate) {
        h.secrets.set(name, { id: 'z'.repeat(25), labels: [], data: '', inUse: false }); // a concurrent create won
        throw new Error('secret already exists');
      }
      const labels = args.flatMap((a, i) => (args[i - 1] === '--label' ? [a] : []));
      h.secrets.set(name, { id: createHash('sha1').update(name).digest('hex').slice(0, 25), labels, data: input!.toString('utf8'), inUse: false });
      return 'id\n';
    }
    if (cmd === 'ls') {
      if (h.listFails) throw new Error('daemon down');
      const label = args[args.indexOf('--filter') + 1]!.slice('label='.length);
      return [...h.secrets.entries()].filter(([, s]) => s.labels.includes(label)).map(([n]) => n).join('\n');
    }
    if (cmd === 'remove') {
      const s = h.secrets.get(args[2]!)!;
      if (s.inUse) throw new Error('in use by a service');
      h.secrets.delete(args[2]!);
      return '';
    }
    throw new Error(`unexpected docker ${args.join(' ')}`);
  }),
}));

const lib = await import('../../src/lib/swarmFileSecrets.js');
const { managedSwarmServiceSpec } = await import('../../src/engine/swarmServiceSpec.js');

const STACK = 'nd-web';
const files = [
  { id: 2, containerPath: '/etc/app/b.conf', content: 'b=1' },
  { id: 1, containerPath: '/etc/app/a.conf', content: 'a=1' },
];
const log = vi.fn();

beforeEach(() => {
  h.secrets.clear();
  h.calls.length = 0;
  h.failCreate = false;
  h.listFails = false;
  log.mockClear();
});

describe('file secrets', () => {
  it('creates one secret per file, named by its content, labelled with the stack and file; reuses an unchanged one', async () => {
    const first = await lib.ensureSwarmFileSecrets(STACK, files, log);
    expect(first.map((f) => f.target)).toEqual(['/etc/app/a.conf', '/etc/app/b.conf']);
    const name = lib.fileSecretName(STACK, files[1]!);
    expect(name).toMatch(/^nd-web-f1-[a-f0-9]{12}$/);
    expect(first[0]).toEqual({ secretId: expect.stringMatching(/^[a-f0-9]{25}$/), secretName: name, target: '/etc/app/a.conf' });
    expect(h.secrets.get(name)).toMatchObject({ data: 'a=1', labels: ['ninedeploy.swarm.stack=nd-web', 'ninedeploy.file=1'] });
    // The content never travels on the command line.
    expect(h.calls.flat().some((a) => a.includes('a=1'))).toBe(false);

    h.calls.length = 0;
    expect(await lib.ensureSwarmFileSecrets(STACK, files, log)).toEqual(first);
    expect(h.calls.some((c) => c[1] === 'create')).toBe(false);
    // An edited file is a new secret.
    const edited = await lib.ensureSwarmFileSecrets(STACK, [{ ...files[1]!, content: 'a=2' }], log);
    expect(edited[0]!.secretName).not.toBe(name);
    expect(await lib.ensureSwarmFileSecrets(STACK, [], log)).toEqual([]);
  });

  it('a create lost to a concurrent one reuses that secret; one that cannot be confirmed fails', async () => {
    h.failCreate = true;
    expect((await lib.ensureSwarmFileSecrets(STACK, [files[1]!], log))[0]!.secretId).toBe('z'.repeat(25));
    h.secrets.clear();
    const { capture } = await import('../../src/lib/exec.js');
    vi.mocked(capture).mockImplementationOnce(async () => {
      throw new Error('No such secret');
    });
    vi.mocked(capture).mockImplementationOnce(async () => 'created\n');
    vi.mocked(capture).mockImplementationOnce(async () => 'not-an-id\n');
    await expect(lib.ensureSwarmFileSecrets(STACK, [files[1]!], log)).rejects.toThrow(/could not be confirmed/);
    h.failCreate = false;
    vi.mocked(capture).mockImplementationOnce(async () => {
      throw new Error('No such secret');
    });
    vi.mocked(capture).mockImplementationOnce(async () => {
      throw new Error('raft unavailable');
    });
    vi.mocked(capture).mockImplementationOnce(async () => {
      throw new Error('No such secret');
    });
    await expect(lib.ensureSwarmFileSecrets(STACK, [files[1]!], log)).rejects.toThrow('raft unavailable');
  });

  it('prunes only this stack’s file secrets that are not kept; one in use stays', async () => {
    const made = await lib.ensureSwarmFileSecrets(STACK, files, log);
    const [a, b] = made.map((f) => f.secretName) as [string, string];
    await lib.ensureSwarmFileSecrets('nd-other', files, log);
    h.secrets.set('nd-web-unrelated', { id: 'q'.repeat(25), labels: ['ninedeploy.swarm.stack=nd-web'], data: '', inUse: false });
    h.secrets.get(b)!.inUse = true;
    expect(await lib.pruneSwarmFileSecrets(STACK, new Set(), log)).toEqual([a]);
    expect(h.secrets.has(b)).toBe(true);
    expect(h.secrets.has('nd-web-unrelated')).toBe(true);
    expect([...h.secrets.keys()].filter((n) => n.startsWith('nd-other-'))).toHaveLength(2);
    h.secrets.get(b)!.inUse = false;
    expect(await lib.pruneSwarmFileSecrets(STACK, new Set([b]), log)).toEqual([]);
    h.listFails = true;
    expect(await lib.pruneSwarmFileSecrets(STACK, new Set(), log)).toEqual([]);
  });

  it('after a deploy, keeps what the spec, the previous spec and this deploy mount; an unreadable service keeps everything', async () => {
    const made = await lib.ensureSwarmFileSecrets(STACK, [...files, { id: 3, containerPath: '/etc/app/c.conf', content: 'c=1' }], log);
    const [a, b, c] = made.map((f) => f.secretName) as [string, string, string];
    const spec = (name: string) => JSON.stringify({ TaskTemplate: { ContainerSpec: { Secrets: [{ SecretName: name }] } } });
    const { capture } = await import('../../src/lib/exec.js');
    vi.mocked(capture).mockImplementationOnce(async () => `${spec(a)}\n${spec(b)}\n`);
    expect(await lib.pruneUnusedFileSecrets(STACK, 'nd-web_web', [], log)).toEqual([c]);
    vi.mocked(capture).mockImplementationOnce(async () => `${spec(a)}\nnull\n`);
    expect(await lib.pruneUnusedFileSecrets(STACK, 'nd-web_web', [], log)).toEqual([b]);
    vi.mocked(capture).mockImplementationOnce(async () => '{not json\n');
    expect(await lib.pruneUnusedFileSecrets(STACK, 'nd-web_web', [], log)).toEqual([]);
    vi.mocked(capture).mockImplementationOnce(async () => {
      throw new Error('no such service');
    });
    expect(await lib.pruneUnusedFileSecrets(STACK, 'nd-web_web', [], log)).toEqual([]);
    expect(h.secrets.has(a)).toBe(true);
  });

  it('reads the secret names a native spec mounts', () => {
    expect(lib.specSecretNames({ TaskTemplate: { ContainerSpec: { Secrets: [{ SecretName: 'x' }, { SecretName: 3 }, null] } } })).toEqual(['x']);
    expect(lib.specSecretNames(null)).toEqual([]);
    expect(lib.specSecretNames({ TaskTemplate: {} })).toEqual([]);
  });
});

describe('the native ServiceSpec', () => {
  const stack = (fileSecrets?: Array<{ secretId: string; secretName: string; target: string }>) => ({
    name: 'nd-web',
    services: [{ name: 'web', image: 'nginx:1', replicas: 1, port: 80, env: {}, networks: ['nd-web-net'], secrets: [], configs: [], labels: {}, ...(fileSecrets ? { fileSecrets } : {}) }],
    networks: [],
    secrets: [],
    configs: [],
    volumes: [],
  });
  const ok = { secretId: 'a'.repeat(25), secretName: 'nd-web-f1-0123456789ab', target: '/etc/app/a.conf' };

  it('mounts each file secret read-only, owned by root, at its path', async () => {
    const spec = (await managedSwarmServiceSpec(stack([ok]))) as { TaskTemplate: { ContainerSpec: Record<string, unknown> } };
    expect(spec.TaskTemplate.ContainerSpec['Secrets']).toEqual([{ File: { Name: '/etc/app/a.conf', UID: '0', GID: '0', Mode: 0o444 }, SecretID: ok.secretId, SecretName: ok.secretName }]);
    const none = (await managedSwarmServiceSpec(stack())) as { TaskTemplate: { ContainerSpec: Record<string, unknown> } };
    expect(none.TaskTemplate.ContainerSpec['Secrets']).toBeUndefined();
  });

  it('refuses a malformed file secret', async () => {
    for (const bad of [{ secretId: 'X' }, { target: 'relative/path' }, { secretName: 'someone-elses' }]) {
      await expect(managedSwarmServiceSpec(stack([{ ...ok, ...bad }]))).rejects.toThrow('Unsupported managed Swarm file mount');
    }
  });
});
