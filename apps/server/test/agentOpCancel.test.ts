import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The real spawnValidated runs; only the binary it starts is swapped for a
// process that never exits on its own, so the test sees what a dropped
// request does to a running `docker pull`.
const spawned = vi.hoisted(() => [] as ChildProcess[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (_cmd: string, _args: string[], opts: import('node:child_process').SpawnOptions) => {
      const child = actual.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], opts);
      spawned.push(child);
      return child;
    },
  };
});

const { agentRoutes, agentCapabilities } = await import('../src/agent.js');
const { buildTestApp } = await import('./helpers.js');

const TOKEN = 'agent-shared-token';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');

const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once('exit', () => resolve()));

afterEach(() => {
  for (const child of spawned.splice(0)) child.kill('SIGKILL');
});

describe('agent: a dropped request cancels its op', () => {
  it('advertises op.cancel', () => {
    expect(agentCapabilities({})).toContain('op.cancel');
  });

  it('kills a running docker.pull when the panel goes away', async () => {
    const app = await buildTestApp();
    await app.register(agentRoutes, { tokenHash: TOKEN_HASH });
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const { port } = app.server.address() as AddressInfo;
      const ac = new AbortController();
      const request = fetch(`http://127.0.0.1:${port}/agent/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-token': TOKEN },
        body: JSON.stringify({ op: 'docker.pull', params: { image: 'nginx' } }),
        signal: ac.signal,
      }).catch(() => undefined);
      await vi.waitFor(() => expect(spawned).toHaveLength(1), { timeout: 5000 });
      const child = spawned[0]!;
      expect(child.exitCode).toBeNull();
      ac.abort();
      await request;
      await expect(Promise.race([exited(child).then(() => 'exited'), new Promise((r) => setTimeout(() => r('alive'), 8000))]))
        .resolves.toBe('exited');
    } finally {
      await app.close();
    }
  }, 20_000);
});
