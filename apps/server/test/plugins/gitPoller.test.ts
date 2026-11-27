/** X2: the Git polling tick (plugins/gitPoller.ts): every fifteen seconds, one tick at a time, errors kept to the log. */
import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ pollDueGitServices: vi.fn() }));
vi.mock('../../src/lib/gitPoll.js', () => seam);
const plugin = (await import('../../src/plugins/gitPoller.js')).default;

const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve));
type Line = { level: number; msg?: string; gitPoll?: unknown; err?: { message?: string } };
async function boot(listen = false) {
  const lines: Line[] = [];
  const app = listen
    ? Fastify({ logger: { level: 'info', stream: { write: (line: string) => { lines.push(JSON.parse(line)); } } } })
    : Fastify({ logger: false });
  app.decorate('db', { marker: 'db' } as never);
  await app.register(plugin);
  await app.ready();
  return { app, lines };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  seam.pollDueGitServices.mockReset().mockResolvedValue({ due: 0, queued: 0, unchanged: 0, failed: 0 });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('polls every fifteen seconds, with the database, and logs nothing while there is nothing to say', async () => {
  const { app, lines } = await boot(true);
  try {
    await vi.advanceTimersByTimeAsync(14_999);
    expect(seam.pollDueGitServices).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seam.pollDueGitServices).toHaveBeenCalledTimes(3);
    expect(seam.pollDueGitServices).toHaveBeenLastCalledWith(app.getDecorator('db'));
    expect(lines.filter((line) => line.msg?.startsWith('git polling'))).toEqual([]);
  } finally {
    await app.close();
  }
});

it('does not start a second tick while the first is still running', async () => {
  const { app } = await boot();
  let release!: () => void;
  seam.pollDueGitServices.mockImplementationOnce(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  try {
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(seam.pollDueGitServices).toHaveBeenCalledTimes(1);
    release();
    await checkpoint();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(seam.pollDueGitServices).toHaveBeenCalledTimes(2);
  } finally {
    await checkpoint();
    await app.close();
  }
});

it('keeps a failing tick to a warning, and the next tick runs', async () => {
  const { app, lines } = await boot(true);
  seam.pollDueGitServices.mockRejectedValueOnce(new Error('database is locked'));
  seam.pollDueGitServices.mockResolvedValueOnce({ due: 2, queued: 1, unchanged: 1, failed: 0 });
  try {
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(seam.pollDueGitServices).toHaveBeenCalledTimes(2);
    const warning = lines.find((line) => line.msg === 'git polling failed');
    expect(warning?.level).toBe(40);
    expect(warning?.err?.message).toBe('database is locked');
    const info = lines.find((line) => line.msg === 'git polling');
    expect(info?.gitPoll).toEqual({ due: 2, queued: 1, unchanged: 1, failed: 0 });
    expect(lines.filter((line) => line.msg?.startsWith('git polling'))).toHaveLength(2);
  } finally {
    await app.close();
  }
});

it('stops ticking when the panel closes', async () => {
  const { app } = await boot();
  await app.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(seam.pollDueGitServices).not.toHaveBeenCalled();
});
