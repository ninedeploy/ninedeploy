import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ capture: vi.fn(), run: vi.fn() }));
vi.mock('../../src/lib/exec.js', async original => ({ ...await original<typeof import('../../src/lib/exec.js')>(), capture: h.capture, run: h.run }));
const { containerToolOps } = await import('../../src/agentOps/containerTools.js');
const op = containerToolOps.ops['docker.containerTool']!;
const CID = 'a'.repeat(64);
const raw = [{ Id: CID, Name: '/same-name', Config: { Image: 'fixture:1', Env: ['SECRET=fixture-only'] }, State: { Status: 'running' } }];
beforeEach(() => {
  h.capture.mockReset().mockImplementation(async (_exe, args: string[]) => args.includes('--type') ? CID : args[0] === 'inspect' ? JSON.stringify(raw) : '');
  h.run.mockReset().mockResolvedValue(undefined);
});
async function execute(action: string, extra: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const exitCode = await op.run({ container: 'same-name', action, ...extra }, line => lines.push(line), { sealed: true });
  expect(lines).toHaveLength(1);
  return { exitCode, reply: JSON.parse(lines[0]!) };
}
describe('sealed node container tools', () => {
  it('advertises its own capability and requires sealed transport', () => {
    expect(containerToolOps.caps).toEqual(['docker.containerTools']); expect(op.sealedOnly).toBe(true);
  });
  it.each(['inspect', 'compose'])('resolves the name once and reads %s only by immutable container ID', async action => {
    const { exitCode, reply } = await execute(action);
    expect(exitCode).toBe(0); expect(reply.ok).toBe(true);
    expect(h.capture.mock.calls[0]?.[1]).toEqual(['inspect', '--type', 'container', '--format', '{{.Id}}', 'same-name']);
    expect(h.capture.mock.calls[1]?.[1]).toEqual(['inspect', CID]);
    expect(h.capture.mock.calls[0]?.[2]).toEqual({ timeoutMs: 10000, maxOutputBytes: 128 });
    expect(h.capture.mock.calls.slice(1).every(call => call[2]?.timeoutMs === 30000 && call[2]?.maxOutputBytes === 2 * 1024 * 1024)).toBe(true);
    expect(action === 'inspect' ? reply.result.id : reply.result.inspect.id).toBe(CID);
  });
  it('writes exact content over stdin and never embeds it in argv or response', async () => {
    const contentBase64 = Buffer.from('secret-fixture\nü').toString('base64');
    const { reply } = await execute('write', { path: "/tmp/quote'file", contentBase64 });
    expect(reply).toEqual({ ok: true, result: { ok: true } });
    expect(h.run.mock.calls[0]?.[1]).toContain(CID);
    expect(JSON.stringify(h.run.mock.calls[0]?.[1])).not.toContain(contentBase64);
    expect(h.run.mock.calls[0]?.[4]).toEqual(Buffer.from(contentBase64));
    expect(h.run.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 30000 });
  });
  it.each(['mkdir', 'delete'])('applies %s to the pinned container without a name fallback', async action => {
    const { exitCode } = await execute(action, { path: '/tmp/owned' }); expect(exitCode).toBe(0);
    const calls = action === 'mkdir' ? h.capture.mock.calls.slice(1) : h.run.mock.calls;
    expect(calls[0]?.[1]).toContain(CID); expect(calls[0]?.[1]).not.toContain('same-name');
  });
  it('returns the bounded file read as base64', async () => {
    h.capture.mockImplementation(async (_exe, args) => args.includes('--type') ? CID : 'Zml4dHVyZQ==');
    expect((await execute('read', { path: '/tmp/file' })).reply).toEqual({ ok: true, result: { content: 'Zml4dHVyZQ==', encoding: 'base64' } });
  });
  it('preserves the oversized read refusal without returning truncated editable data', async () => {
    h.capture.mockImplementation(async (_exe, args) => args.includes('--type') ? CID : Buffer.alloc(1024 * 1024 + 1).toString('base64'));
    const result = await execute('read', { path: '/tmp/file' });
    expect(result.exitCode).toBe(1); expect(result.reply.error.status).toBe(413); expect(result.reply.result).toBeUndefined();
  });
  it.each([{ container: '--help' }, { action: 'exec' }, { command: 'host-command' }, { action: 'read', path: '/' }, { action: 'delete', path: '/tmp/..' }, { action: 'inspect', path: '/tmp' }, { action: 'read', contentBase64: '' }, { action: 'write', path: '/tmp/file', contentBase64: 'invalid!' }])('rejects invalid operands before Docker reads: %j', async patch => {
    await expect(execute('inspect', patch)).rejects.toThrow(); expect(h.capture).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled();
  });
  it('does not fall back to the name when immutable identity is missing', async () => {
    h.capture.mockResolvedValue('not-an-id'); const result = await execute('inspect');
    expect(result.exitCode).toBe(1); expect(h.capture).toHaveBeenCalledTimes(1); expect(result.reply.result).toBeUndefined();
  });
  it('redacts raw Docker errors from the response', async () => {
    h.capture.mockRejectedValue(Error('fixture-secret-from-daemon'));
    const result = await execute('inspect'); expect(result.exitCode).toBe(1); expect(JSON.stringify(result.reply)).not.toContain('fixture-secret');
  });
});
