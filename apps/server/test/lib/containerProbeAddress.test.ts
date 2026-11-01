import { afterEach, expect, it, vi } from 'vitest';
const spawn = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 0));
vi.mock('../../src/lib/spawnValidated.js', () => ({ spawnValidated: spawn }));
const { probeContainer } = await import('../../src/lib/containerProbe.js');
afterEach(() => spawn.mockReset());

it.each(['http', 'tcp'])('probes the explicitly selected primary address for %s', async protocol => {
  spawn.mockImplementation(async (_cmd, args, sink) => {
    if ((args as string[])[0] === 'run' && protocol === 'http') (sink as (line: string) => void)('HTTP/1.1 200 OK');
    return 0;
  });
  const lines: string[] = [];
  await probeContainer({ name: 'app-7', port: 8080, protocol, path: '/' }, line => lines.push(line), { address: '172.22.0.2' });
  expect(spawn.mock.calls[0]![1]).toContain('172.22.0.2');
  expect(JSON.parse(lines[0]!.slice('ND-PROBE '.length)).ready).toBe(true);
});

it.each(['not-an-ip', '127.0.0.1', '0.0.0.0', '172.22.0.2; echo unsafe'])('refuses an invalid explicit probe address before Docker: %s', async address => {
  await expect(probeContainer({ name: 'app-7', port: 8080, protocol: 'tcp' }, () => {}, { address })).rejects.toThrow('Invalid probe address');
  expect(spawn).not.toHaveBeenCalled();
});
