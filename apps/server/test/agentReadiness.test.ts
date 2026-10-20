import { afterEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 0));
vi.mock('../src/lib/spawnValidated.js', () => ({ spawnValidated: spawn }));
const { runRegisteredOp } = await import('../src/agentOps/index.js');

afterEach(() => spawn.mockReset());

describe('node readiness protocol', () => {
  it('checks TCP inside the workload network namespace without publishing a port', async () => {
    spawn.mockResolvedValue(0);
    const lines: string[] = [];
    expect(await runRegisteredOp('docker.probe', { name: 'web-7', port: 3000, protocol: 'tcp' }, (s) => lines.push(s), { sealed: true })).toBe(0);
    expect(lines).toContain('ND-PROBE {"ready":true,"protocol":"tcp"}');
    const args = spawn.mock.calls[0]![1] as string[];
    expect(args).toContain('container:web-7');
    expect(args).not.toContain('-p');
    expect(args).toContain('--read-only');
  });

  it('requires a successful HTTP response instead of accepting an open port', async () => {
    spawn.mockImplementation(async (_exe, _args, line) => { (line as (s: string) => void)('HTTP/1.1 503 Unavailable'); return 0; });
    const lines: string[] = [];
    expect(await runRegisteredOp('docker.probe', { name: 'web-7', port: 3000, protocol: 'http', path: '/ready' }, (s) => lines.push(s), { sealed: true })).toBe(0);
    expect(lines).toContain('ND-PROBE {"ready":false,"protocol":"http","status":503}');
  });

  it.each([{ name: '-bad', port: 80 }, { name: 'web', port: 0 }, { name: 'web', port: 80, path: '/\r\nHost: bad' }])('rejects invalid probe operands before spawning: %j', async (params) => {
    await expect(runRegisteredOp('docker.probe', { protocol: 'http', ...params }, () => undefined, { sealed: true })).rejects.toThrow(/Invalid/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses plaintext', async () => {
    await expect(runRegisteredOp('docker.probe', { name: 'web', port: 80, protocol: 'tcp' }, () => undefined, { sealed: false })).rejects.toThrow(/sealed/);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('node log transport', () => {
  it('bounds log output and hands the cursor to Docker as a literal operand', async () => {
    spawn.mockImplementation(async (_exe, _args, line) => {
      for (let i = 0; i < 1500; i++) (line as (s: string) => void)(`2026-10-20T12:00:00.000Z ${'x'.repeat(1000)}`);
      return 0;
    });
    const lines: string[] = [];
    const cursor = '2026-10-20T12:00:00.000000001Z';
    expect(await runRegisteredOp('docker.logsSince', { name: 'web-7', since: cursor }, (s) => lines.push(s), { sealed: true })).toBe(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(1000);
    expect(Buffer.byteLength(lines.join(''))).toBeLessThanOrEqual(256 * 1024);
    expect(spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--since', cursor, 'web-7']));
  });

  it('refuses a malformed cursor before executing Docker', async () => {
    await expect(runRegisteredOp('docker.logsSince', { name: 'web', since: 'yesterday; echo injected' }, () => undefined, { sealed: true })).rejects.toThrow(/Invalid log cursor/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('never returns runtime logs over plaintext transport', async () => {
    await expect(runRegisteredOp('docker.logsSince', { name: 'web', since: '2026-10-20T12:00:00Z' }, () => undefined, { sealed: false })).rejects.toThrow(/sealed/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
