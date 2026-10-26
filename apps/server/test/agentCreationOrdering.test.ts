import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { runOp } from '../src/agent.js';

const io = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../src/lib/spawnValidated.js', () => ({ spawnValidated: io.spawn }));
type Row = { id: string; name: string; deploymentId: string; serviceId: string; managed: string; running: boolean; status: string };
const modes = ['multi-network spec', 'single-network spec', 'runEnv'] as const;
let root: string, rows: Row[], block: boolean, entered: () => void, release: () => void, started: Promise<void>, gate: Promise<void>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nd-creation-drain-')); rows = []; block = false;
  started = new Promise(resolve => { entered = resolve; }); gate = new Promise(resolve => { release = resolve; });
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  io.spawn.mockReset().mockImplementation(async (_bin, args: string[], sink: (line: string) => void) => {
    const find = (reference: string) => rows.find(row => row.id === reference || row.name === reference);
    if (args[0] === 'run' || args[0] === 'create') {
      const name = args[args.indexOf('--name') + 1]!;
      const label = (key: string) => args.find(value => value.startsWith(key + '='))!.slice(key.length + 1);
      const row: Row = { id: (rows.length + 11).toString(16).repeat(64), name, deploymentId: label('ninedeploy.deployment'),
        serviceId: label('ninedeploy.service'), managed: 'service', running: false, status: 'created' };
      rows.push(row);
      if (args[0] === 'run') {
        if (block && name === 'web-10') { entered(); await gate; }
        row.running = true; row.status = 'running';
      }
      sink(row.id); return 0;
    }
    if (args[0] === 'network') { if (block && args.at(-1) === 'web-10') { entered(); await gate; } return 0; }
    if (args[0] === 'inspect') {
      const row = find(args.at(-1)!);
      if (!row) { sink('Error: No such container'); return 1; }
      sink(JSON.stringify({ ...row, name: '/' + row.name })); return 0;
    }
    if (args[0] === 'start' || args[0] === 'stop') {
      for (const reference of args.slice(args[0] === 'start' ? 1 : 3)) {
        const row = find(reference)!; row.running = args[0] === 'start'; row.status = row.running ? 'running' : 'exited';
      }
      return 0;
    }
    throw Error('Unexpected Docker command ' + args[0]);
  });
});
afterEach(async () => {
  release(); vi.restoreAllMocks();
  if (dirname(root) !== tmpdir() || !basename(root).startsWith('nd-creation-drain-')) throw Error('Invalid creation fixture cleanup');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});
const create = (mode: typeof modes[number], deploymentId = 10, serviceId = 7, slug = 'web') => {
  const params = { name: slug + '-' + deploymentId, image: 'busybox:1.36', serviceId, deploymentId };
  return mode === 'runEnv'
    ? runOp('docker.runEnv', { ...params, envFile: '.agent-env/web.env' }, () => {}, { sealed: true })
    : runOp('docker.runSpec', { ...params, ...(mode === 'multi-network spec' ? { extraNetworks: ['nd-extra'] } : {}) }, () => {}, { sealed: true });
};
const stop = async () => {
  const candidate = rows.find(row => row.name === 'web-10')!;
  const target = { id: candidate.id, name: candidate.name, deploymentId: 10 };
  const lines: string[] = [];
  expect(await runOp('docker.lifecycle', { requestId: 'a'.repeat(32), serviceId: 7, deploymentId: 9, revision: 8,
    action: 'stop', targets: [target], timeoutMs: 5000 }, line => lines.push(line), { sealed: true })).toBe(0);
  expect(JSON.parse(lines[0]!.slice(13))).toMatchObject({ complete: true, items: [{ ...target, running: false }] });
};

it.each(modes)('drains an already-admitted %s before acknowledging Stop', async mode => {
  block = true; const creating = create(mode); await started;
  const stopping = stop();
  try {
    const premature = await Promise.race([stopping.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))]);
    expect(premature, 'Stop must not complete while a builder can still perform its raw Start').toBe(false);
  } finally { release(); await creating; await stopping; }
  expect(rows.find(row => row.name === 'web-10')!.running, 'No late resurrection after the Stop receipt').toBe(false);
});

it.each(modes)('preserves a legitimate newer deployment through %s after an earlier lifecycle command', async mode => {
  expect(await create(mode)).toBe(0); await stop();
  expect(await create(mode, 11)).toBe(0);
  expect(rows.find(row => row.name === 'web-10')!.running).toBe(false);
  expect(rows.find(row => row.name === 'web-11')!.running).toBe(true);
});

it('keeps another service independent of a paused managed creation', async () => {
  block = true; const creating = create('multi-network spec'); await started;
  try {
    expect(await Promise.race([create('single-network spec', 10, 8, 'other'), new Promise(resolve => setTimeout(() => resolve('blocked'), 250))])).toBe(0);
    expect(rows.find(row => row.name === 'other-10')!.running).toBe(true);
  } finally { release(); await creating; }
});
