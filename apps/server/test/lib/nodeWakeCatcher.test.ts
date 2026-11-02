import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catcherReply, demandLogger, startWakeCatcher, wakePage } from '../../src/wakeCatcher.js';

const docker = vi.hoisted(() => ({ calls: [] as string[][], containers: new Map<string, string>(), logs: '' }));
vi.mock('../../src/lib/exec.js', () => ({ capture: vi.fn(async (_cmd: string, args: string[]) => {
  docker.calls.push(args);
  if (args[0] === 'inspect') {
    const found = docker.containers.get(args[1]!);
    if (found === undefined) throw new Error('No such object');
    return found;
  }
  if (args[0] === 'logs') return docker.logs;
  if (args[0] === 'run') { docker.containers.set('ninedeploy-wake', `${'c'.repeat(64)}|${AGENT_IMAGE}|true|wake|2026-11-02T10:00:00Z`); return 'c'.repeat(64); }
  if (args[0] === 'rm') { for (const [name, row] of docker.containers) if (row.startsWith(args[2]!)) docker.containers.delete(name); return ''; }
  throw new Error(`unexpected docker ${args.join(' ')}`);
}) }));
const AGENT_IMAGE = `sha256:${'a'.repeat(64)}`;
const { ensureWakeCatcher, readWakeDemand, removeWakeCatcher, wakeCatcherRunArgs } = await import('../../src/lib/nodeWakeCatcher.js');
const TOKEN = '0123456789abcdef'.repeat(2);
beforeEach(() => {
  docker.calls = []; docker.logs = '';
  docker.containers = new Map([['ninedeploy-agent', `${'f'.repeat(64)}|${AGENT_IMAGE}|true||2026-11-02T09:00:00Z`]]);
});

describe('wake catcher replies', () => {
  it('answers a tokened request with a self-reloading 503 and names the token', () => {
    const reply = catcherReply('GET', `/_nd/wake/${TOKEN}/dashboard?x=1`);
    expect(reply).toMatchObject({ status: 503, token: TOKEN, headers: { 'retry-after': '5', 'cache-control': 'no-store' } });
    expect(reply.body).toContain('http-equiv="refresh"');
    expect(catcherReply('HEAD', `/_nd/wake/${TOKEN}`)).toMatchObject({ status: 503, token: TOKEN, body: '' });
    expect(catcherReply('HEAD', `/_nd/wake/${TOKEN}`).headers['content-length']).toBe(String(Buffer.byteLength(wakePage())));
  });
  it.each(['/', '/_nd/wake/', `/_nd/wake/${TOKEN.toUpperCase()}`, `/_nd/wake/${TOKEN}x`, `/x/_nd/wake/${TOKEN}`, undefined])('wakes nothing for %s', url => {
    expect(catcherReply('GET', url)).toMatchObject({ status: 404, token: null });
  });
  it('logs one demand line per token per second within a bounded table', () => {
    let now = 0; const lines: string[] = [];
    const log = demandLogger(line => lines.push(line), () => now);
    log(TOKEN); log(TOKEN); now = 999; log(TOKEN); now = 1000; log(TOKEN);
    expect(lines).toEqual([`ND-WAKE {"token":"${TOKEN}"}`, `ND-WAKE {"token":"${TOKEN}"}`]);
    for (let i = 0; i < 1100; i++) log(i.toString(16).padStart(32, '0'));
    expect(lines.length).toBe(1102);
  });
  it('serves the page over real HTTP', async () => {
    const server = startWakeCatcher(0);
    await new Promise(resolve => server.once('listening', resolve));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const port = (server.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/_nd/wake/${TOKEN}/`);
      expect(response.status).toBe(503);
      expect(await response.text()).toContain('Waking up');
      expect(write).toHaveBeenCalledWith(`ND-WAKE {"token":"${TOKEN}"}\n`);
    } finally { write.mockRestore(); await new Promise(resolve => server.close(resolve)); }
  });
});

describe('agent-managed wake catcher', () => {
  it('runs the agent image unprivileged, read-only and without mounts or ports', async () => {
    expect(await ensureWakeCatcher()).toEqual({ id: 'c'.repeat(64), image: AGENT_IMAGE, created: true });
    const run = docker.calls.find(args => args[0] === 'run')!;
    expect(run).toEqual(wakeCatcherRunArgs(AGENT_IMAGE));
    expect(run).toEqual(expect.arrayContaining(['--read-only', '--cap-drop', 'ALL', '--user', '65534:65534', '--network', 'ninedeploy']));
    expect(run.join(' ')).not.toMatch(/ -v | -p |--publish|--volume|docker\.sock|--privileged/);
    expect(run.at(-2)).toBe(AGENT_IMAGE);
  });
  it('keeps a running catcher of the same image and recreates a stale or stopped one', async () => {
    docker.containers.set('ninedeploy-wake', `${'c'.repeat(64)}|${AGENT_IMAGE}|true|wake|t`);
    expect((await ensureWakeCatcher()).created).toBe(false);
    expect(docker.calls.some(args => args[0] === 'run' || args[0] === 'rm')).toBe(false);
    docker.containers.set('ninedeploy-wake', `${'d'.repeat(64)}|sha256:${'b'.repeat(64)}|true|wake|t`);
    expect((await ensureWakeCatcher()).created).toBe(true);
    expect(docker.calls).toContainEqual(['rm', '-f', 'd'.repeat(64)]);
  });
  it('never touches a same-name container it did not create', async () => {
    docker.containers.set('ninedeploy-wake', `${'e'.repeat(64)}|${AGENT_IMAGE}|true||t`);
    await expect(ensureWakeCatcher()).rejects.toThrow(/did not create/);
    await expect(removeWakeCatcher()).rejects.toThrow(/did not create/);
    expect(docker.calls.some(args => args[0] === 'rm' || args[0] === 'run')).toBe(false);
  });
  it('refuses without the containerized agent, and removes only its own catcher', async () => {
    docker.containers.delete('ninedeploy-agent');
    await expect(ensureWakeCatcher()).rejects.toThrow(/ninedeploy-agent container/);
    expect(await removeWakeCatcher()).toEqual({ removed: false });
    docker.containers.set('ninedeploy-wake', `${'c'.repeat(64)}|${AGENT_IMAGE}|false|wake|t`);
    expect(await removeWakeCatcher()).toEqual({ removed: true });
  });
  it('aggregates demand per token from the catcher log since the cursor', async () => {
    docker.containers.set('ninedeploy-wake', `${'c'.repeat(64)}|${AGENT_IMAGE}|true|wake|2026-11-02T10:00:00Z`);
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
    expect(demand).toEqual({ catcherId: 'c'.repeat(64), startedAt: '2026-11-02T10:00:00Z', cursorMs: Date.parse('2026-11-02T10:00:07Z'), items: [
      { token: TOKEN, count: 2, lastAt: Date.parse('2026-11-02T10:00:06.500Z') },
      { token: other, count: 1, lastAt: Date.parse('2026-11-02T10:00:07Z') },
    ] });
  });
  it('refuses demand from a missing, stopped or foreign catcher instead of reporting none', async () => {
    await expect(readWakeDemand({ sinceMs: 0 })).rejects.toThrow(/not running/);
    docker.containers.set('ninedeploy-wake', `${'c'.repeat(64)}|${AGENT_IMAGE}|false|wake|t`);
    await expect(readWakeDemand({ sinceMs: 0 })).rejects.toThrow(/not running/);
    docker.containers.set('ninedeploy-wake', `${'c'.repeat(64)}|${AGENT_IMAGE}|true||t`);
    await expect(readWakeDemand({ sinceMs: 0 })).rejects.toThrow(/not running/);
    await expect(readWakeDemand({ sinceMs: -1 })).rejects.toThrow();
    await expect(readWakeDemand({ sinceMs: 0, extra: 1 })).rejects.toThrow();
  });
});
