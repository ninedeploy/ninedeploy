import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catcherReply, demandLogger, startWakeCatcher, wakeKeyMatches, wakePage } from '../../src/wakeCatcher.js';

const docker = vi.hoisted(() => ({ calls: [] as string[][], containers: new Map<string, string>(), logs: '', before: undefined as ((args: string[]) => Promise<void>) | undefined }));
vi.mock('../../src/lib/exec.js', () => ({ capture: vi.fn(async (_cmd: string, args: string[]) => {
  docker.calls.push(args);
  await docker.before?.(args);
  if (args[0] === 'inspect') {
    const found = docker.containers.get(args[1]!);
    if (found === undefined) throw new Error('No such object');
    return found;
  }
  if (args[0] === 'logs') return docker.logs;
  if (args[0] === 'run') {
    const keyHash = args.find(arg => arg.startsWith('ninedeploy.wake.key='))!.split('=')[1];
    docker.containers.set('ninedeploy-wake', `${'c'.repeat(64)}|${AGENT_IMAGE}|true|wake|2026-11-02T10:00:00Z|${keyHash}`);
    return 'c'.repeat(64);
  }
  if (args[0] === 'rm') { for (const [name, row] of docker.containers) if (row.startsWith(args[2]!)) docker.containers.delete(name); return ''; }
  throw new Error(`unexpected docker ${args.join(' ')}`);
}) }));
const AGENT_IMAGE = `sha256:${'a'.repeat(64)}`;
const { ensureWakeCatcher, readWakeDemand, removeWakeCatcher, wakeCatcherRunArgs } = await import('../../src/lib/nodeWakeCatcher.js');
const TOKEN = '0123456789abcdef'.repeat(2), KEY = 'b'.repeat(64), OTHER_KEY = 'd'.repeat(64);
const catcherRow = (fields: { id?: string; image?: string; running?: boolean; managed?: string; key?: string } = {}) => {
  const run = wakeCatcherRunArgs(fields.image ?? AGENT_IMAGE, fields.key ?? KEY);
  const keyHash = run.find(arg => arg.startsWith('ninedeploy.wake.key='))!.split('=')[1];
  return `${fields.id ?? 'c'.repeat(64)}|${fields.image ?? AGENT_IMAGE}|${fields.running ?? true}|${fields.managed ?? 'wake'}|2026-11-02T10:00:00Z|${keyHash}`;
};
beforeEach(() => {
  docker.calls = []; docker.logs = ''; docker.before = undefined;
  docker.containers = new Map([['ninedeploy-agent', `${'f'.repeat(64)}|${AGENT_IMAGE}|true||2026-11-02T09:00:00Z|`]]);
});

describe('wake catcher replies', () => {
  it('answers a keyed, tokened request with a self-reloading 503 and names the token', () => {
    const reply = catcherReply('GET', `/_nd/wake/${TOKEN}/dashboard?x=1`);
    expect(reply).toMatchObject({ status: 503, token: TOKEN, headers: { 'retry-after': '5', 'cache-control': 'no-store' } });
    expect(reply.body).toContain('http-equiv="refresh"');
    expect(catcherReply('HEAD', `/_nd/wake/${TOKEN}`)).toMatchObject({ status: 503, token: TOKEN, body: '' });
    expect(catcherReply('HEAD', `/_nd/wake/${TOKEN}`).headers['content-length']).toBe(String(Buffer.byteLength(wakePage())));
  });
  it.each(['/', '/_nd/wake/', `/_nd/wake/${TOKEN.toUpperCase()}`, `/_nd/wake/${TOKEN}x`, `/x/_nd/wake/${TOKEN}`, undefined])('wakes nothing for %s', url => {
    expect(catcherReply('GET', url)).toMatchObject({ status: 404, token: null });
  });
  it('wakes nothing without the node wake key, whatever the path', () => {
    expect(catcherReply('GET', `/_nd/wake/${TOKEN}`, false)).toMatchObject({ status: 404, token: null });
    expect(wakeKeyMatches(KEY, KEY)).toBe(true);
    for (const given of [undefined, '', OTHER_KEY, [KEY], KEY.slice(1)]) expect(wakeKeyMatches(given, KEY)).toBe(false);
    expect(wakeKeyMatches('x', 'x')).toBe(false);
    expect(() => startWakeCatcher('')).toThrow(/key/);
  });
  it('logs one demand line per token per second and at most 20 a second in all', () => {
    let now = 0; const lines: string[] = [];
    const log = demandLogger(line => lines.push(line), () => now);
    log(TOKEN); log(TOKEN); now = 999; log(TOKEN); now = 1000; log(TOKEN);
    expect(lines).toEqual([`ND-WAKE {"token":"${TOKEN}"}`, `ND-WAKE {"token":"${TOKEN}"}`]);
    for (let i = 0; i < 100; i++) log(i.toString(16).padStart(32, '0'));
    expect(lines.length).toBe(21);
    now = 2000;
    for (let i = 100; i < 1300; i++) { if (i % 20 === 0) now += 1000; log(i.toString(16).padStart(32, '0')); }
    expect(lines.length).toBe(21 + 1200);
  });
  it('serves the page over real HTTP and logs only keyed demand', async () => {
    const server = startWakeCatcher(KEY, 0);
    await new Promise(resolve => server.once('listening', resolve));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const port = (server.address() as { port: number }).port;
      const unkeyed = await fetch(`http://127.0.0.1:${port}/_nd/wake/${TOKEN}/`);
      expect(unkeyed.status).toBe(404);
      expect(write).not.toHaveBeenCalled();
      const response = await fetch(`http://127.0.0.1:${port}/_nd/wake/${TOKEN}/`, { headers: { 'x-nd-wake-key': KEY } });
      expect(response.status).toBe(503);
      expect(await response.text()).toContain('Waking up');
      expect(write).toHaveBeenCalledWith(`ND-WAKE {"token":"${TOKEN}"}\n`);
    } finally { write.mockRestore(); await new Promise(resolve => server.close(resolve)); }
  });
});

describe('agent-managed wake catcher', () => {
  it('serializes concurrent ensures of the one shared catcher', async () => {
    let enter!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { enter = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    docker.before = async args => { if (args[0] === 'inspect' && args[1] === 'ninedeploy-agent') { enter(); await barrier; } };
    const first = ensureWakeCatcher({ key: KEY }); await started;
    const second = ensureWakeCatcher({ key: KEY });
    try {
      await Promise.resolve(); await Promise.resolve();
      expect(docker.calls.filter(args => args[0] === 'inspect' && args[1] === 'ninedeploy-agent')).toHaveLength(1);
    } finally { release(); await Promise.allSettled([first, second]); docker.before = undefined; }
    expect(docker.calls.filter(args => args[0] === 'run')).toHaveLength(1);
  });
  it('runs the agent image unprivileged, read-only and without mounts or ports', async () => {
    expect(await ensureWakeCatcher({ key: KEY })).toEqual({ id: 'c'.repeat(64), image: AGENT_IMAGE, created: true });
    const run = docker.calls.find(args => args[0] === 'run')!;
    expect(run).toEqual(wakeCatcherRunArgs(AGENT_IMAGE, KEY));
    expect(run).toEqual(expect.arrayContaining(['--read-only', '--cap-drop', 'ALL', '--user', '65534:65534', '--network', 'ninedeploy', `ND_WAKE_KEY=${KEY}`]));
    expect(run.join(' ')).not.toMatch(/ -v | -p |--publish|--volume|docker\.sock|--privileged/);
    // The image's VOLUME /data is shadowed by an empty, unwritable, size-capped tmpfs instead of an anonymous volume.
    expect(run.filter(arg => arg.startsWith('type='))).toEqual(['type=tmpfs,destination=/data,tmpfs-size=65536,tmpfs-mode=0555']);
    // The label holds a hash of the key, never the key.
    expect(run.find(arg => arg.startsWith('ninedeploy.wake.key='))).not.toContain(KEY);
    expect(run.at(-2)).toBe(AGENT_IMAGE);
  });
  it('refuses a missing or malformed key before touching Docker', async () => {
    for (const params of [{}, { key: 'short' }, { key: KEY.toUpperCase() }, { key: KEY, extra: 1 }]) await expect(ensureWakeCatcher(params)).rejects.toThrow();
    expect(docker.calls).toEqual([]);
  });
  it('keeps a running catcher of the same image and key; recreates a stale, rekeyed or stopped one', async () => {
    docker.containers.set('ninedeploy-wake', catcherRow());
    expect((await ensureWakeCatcher({ key: KEY })).created).toBe(false);
    expect(docker.calls.some(args => args[0] === 'run' || args[0] === 'rm')).toBe(false);
    for (const stale of [catcherRow({ id: 'd'.repeat(64), image: `sha256:${'b'.repeat(64)}` }), catcherRow({ id: 'd'.repeat(64), key: OTHER_KEY }), catcherRow({ id: 'd'.repeat(64), running: false })]) {
      docker.calls = []; docker.containers.set('ninedeploy-wake', stale);
      expect((await ensureWakeCatcher({ key: KEY })).created).toBe(true);
      expect(docker.calls).toContainEqual(['rm', '-fv', 'd'.repeat(64)]);
    }
  });
  it('never touches a same-name container it did not create', async () => {
    docker.containers.set('ninedeploy-wake', catcherRow({ id: 'e'.repeat(64), managed: '' }));
    await expect(ensureWakeCatcher({ key: KEY })).rejects.toThrow(/did not create/);
    await expect(removeWakeCatcher()).rejects.toThrow(/did not create/);
    expect(docker.calls.some(args => args[0] === 'rm' || args[0] === 'run')).toBe(false);
  });
  it('refuses without the containerized agent, and removes only its own catcher', async () => {
    docker.containers.delete('ninedeploy-agent');
    await expect(ensureWakeCatcher({ key: KEY })).rejects.toThrow(/ninedeploy-agent container/);
    expect(await removeWakeCatcher()).toEqual({ removed: false });
    docker.containers.set('ninedeploy-wake', catcherRow({ running: false }));
    expect(await removeWakeCatcher()).toEqual({ removed: true });
  });
  it('aggregates demand per token from the catcher log since the cursor', async () => {
    docker.containers.set('ninedeploy-wake', catcherRow());
    const other = 'f'.repeat(32);
    docker.logs = [
      `2026-11-02T10:00:04.000000000Z ND-WAKE {"token":"${TOKEN}"}`,
      `2026-11-02T10:00:06.500000000Z ND-WAKE {"token":"${TOKEN}"}`,
      `2026-11-02T10:00:07.000000000Z ND-WAKE {"token":"${other}"}`,
      `2026-11-02T10:00:01.000000000Z ND-WAKE {"token":"${other}"}`,
      `2026-11-02T10:00:08.000000000Z ND-WAKE {"token":"${TOKEN}","extra":1}`,
      `2026-11-02T10:00:08.000000000Z something else`, '',
    ].join('\n');
    const sinceMs = Date.parse('2026-11-02T10:00:03.400Z');
    const demand = await readWakeDemand({ sinceMs });
    expect(docker.calls).toContainEqual(['logs', '--timestamps', '--since', '2026-11-02T10:00:03.000Z', '--tail', '2000', 'c'.repeat(64)]);
    expect(demand).toEqual({ catcherId: 'c'.repeat(64), startedAt: '2026-11-02T10:00:00Z', cursorMs: Date.parse('2026-11-02T10:00:07Z'), truncated: false, items: [
      { token: TOKEN, count: 2, lastAt: Date.parse('2026-11-02T10:00:06.500Z') },
      { token: other, count: 1, lastAt: Date.parse('2026-11-02T10:00:07Z') },
    ] });
  });
  it('marks a full tail as truncated instead of presenting it as all the demand', async () => {
    docker.containers.set('ninedeploy-wake', catcherRow());
    docker.logs = Array.from({ length: 2000 }, (_, i) => `2026-11-02T10:00:${String(10 + (i % 40)).padStart(2, '0')}.000000000Z ND-WAKE {"token":"${TOKEN}"}`).join('\n');
    expect(await readWakeDemand({ sinceMs: Date.parse('2026-11-02T10:00:00Z') })).toMatchObject({ truncated: true });
  });
  it('does not replay demand from before the same catcher container restarted', async () => {
    docker.containers.set('ninedeploy-wake', catcherRow().replace('10:00:00Z', '10:00:05Z'));
    docker.logs = [`2026-11-02T10:00:04.000Z ND-WAKE {"token":"${TOKEN}"}`, `2026-11-02T10:00:06.000Z ND-WAKE {"token":"${TOKEN}"}`].join('\n');
    expect((await readWakeDemand({ sinceMs: 0 })).items).toEqual([{ token: TOKEN, count: 1, lastAt: Date.parse('2026-11-02T10:00:06Z') }]);
  });
  it('refuses a catcher process change while its demand log is being read', async () => {
    docker.containers.set('ninedeploy-wake', catcherRow());
    docker.before = async args => { if (args[0] === 'logs') docker.containers.set('ninedeploy-wake', catcherRow().replace('10:00:00Z', '10:00:05Z')); };
    await expect(readWakeDemand({ sinceMs: 0 })).rejects.toThrow(/changed/);
  });
  it('refuses demand from a missing, stopped or foreign catcher instead of reporting none', async () => {
    await expect(readWakeDemand({ sinceMs: 0 })).rejects.toThrow(/not running/);
    docker.containers.set('ninedeploy-wake', catcherRow({ running: false }));
    await expect(readWakeDemand({ sinceMs: 0 })).rejects.toThrow(/not running/);
    docker.containers.set('ninedeploy-wake', catcherRow({ managed: '' }));
    await expect(readWakeDemand({ sinceMs: 0 })).rejects.toThrow(/not running/);
    await expect(readWakeDemand({ sinceMs: -1 })).rejects.toThrow();
    await expect(readWakeDemand({ sinceMs: 0, extra: 1 })).rejects.toThrow();
  });
});
