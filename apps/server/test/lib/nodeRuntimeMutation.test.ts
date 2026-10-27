import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createNodeRuntimeMutation } from '../../src/lib/nodeRuntimeMutation.js';
import { createNodeLifecycle } from '../../src/lib/nodeLifecycle.js';
import { runOp } from '../../src/agent.js';
const io = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../../src/lib/spawnValidated.js', () => ({ spawnValidated: io.spawn }));
type Row = { id: string; name: string; managed: string | null; serviceId: string | null; deploymentId: string | null; composeProject?: string | null; nonce: string | null; specHash: string | null; running: boolean; status: string; networks: Record<string, object> };
let root: string, rows: Row[], sequence: number, failNetwork: boolean;
const image = 'sha256:' + 'f'.repeat(64), nonce = (n: number) => n.toString(16).padStart(32, '0');
const spec = (deploymentId = 10, name = 'web-' + deploymentId) => ({ name, image, serviceId: 7, deploymentId });
const prepare = (revision = 5, deploymentId = 10, specs: Array<Record<string, unknown>> = [spec(deploymentId)]) => ({ requestId: nonce(revision), serviceId: 7, deploymentId, revision, timeoutMs: 5000, specs });
const fence = (revision = 8) => ({ requestId: nonce(revision), serviceId: 7, revision, timeoutMs: 5000 });
const runtime = () => createNodeRuntimeMutation(join(root, '.agent-work', '.lifecycle'));
const effects = () => io.spawn.mock.calls.map(call => call[1] as string[]).filter(args => args[0] !== 'inspect');
const journalFile = () => join(root, '.agent-work', '.lifecycle', 'service-7.sqlite');
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nd-runtime-admission-')); rows = []; sequence = 0; failNetwork = false;
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  io.spawn.mockReset().mockImplementation(async (_bin, args: string[], sink: (line: string) => void) => {
    const find = (reference: string) => rows.find(row => row.id === reference || row.name === reference);
    if (args[0] === 'ps') { for (const row of rows.filter(row => row.managed === 'service' && row.serviceId === '7')) sink(row.id); return 0; }
    if (args[0] === 'inspect') { const row = find(args.at(-1)!); if (!row) { sink('Error: No such container'); return 1; } sink(args.includes('{{.Name}}') ? '/' + row.name : JSON.stringify({ ...row, name: '/' + row.name })); return 0; }
    if (args[0] === 'create' || args[0] === 'run') {
      const label = (key: string) => args.find(value => value.startsWith(key + '='))?.slice(key.length + 1) ?? null;
      const row: Row = { id: (++sequence).toString(16).padStart(64, '0'), name: args[args.indexOf('--name') + 1]!, managed: label('ninedeploy.managed')!,
        serviceId: label('ninedeploy.service')!, deploymentId: label('ninedeploy.deployment')!, nonce: label('ninedeploy.mutation'), specHash: label('ninedeploy.spec'),
        running: args[0] === 'run', status: args[0] === 'run' ? 'running' : 'created', networks: { ninedeploy: {} } };
      rows.push(row); sink(row.id); return 0;
    }
    if (args[0] === 'network') { if (failNetwork) return 1; const row = find(args.at(-1)!)!; if (args[1] === 'disconnect') delete row.networks[args[2]!]; else row.networks[args[2]!] = {}; return 0; }
    if (args[0] === 'start' || args[0] === 'stop') { for (const id of args.slice(args[0] === 'start' ? 1 : 3)) { const row = find(id)!; row.running = args[0] === 'start'; row.status = row.running ? 'running' : 'exited'; } return 0; }
    if (args[0] === 'rm') { rows = rows.filter(row => !args.slice(2).some(reference => reference === row.id || reference === row.name)); return 0; }
    throw Error('Unexpected Docker command ' + args[0]);
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (dirname(root) !== tmpdir() || !basename(root).startsWith('nd-runtime-admission-')) throw Error('Invalid admission fixture cleanup');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});
describe('persistent runtime request admission', () => {
  it('rejects a delayed lower-revision preparation after Stop fencing and permits a genuinely newer deployment', async () => {
    const delayed = prepare(); await runtime().fence(fence());
    await expect(runtime().prepare(delayed)).rejects.toThrow(/stale/); expect(effects()).toEqual([]);
    const fresh = await runtime().prepare(prepare(13, 11));
    expect(fresh).toMatchObject({ complete: true, deploymentId: 11, items: [{ name: 'web-11', running: true }] });
  });
  it.each(['docker.runSpec', 'docker.runEnv'])('refuses an old unversioned %s envelope arriving after protocol adoption', async op => {
    if (op === 'docker.runEnv') { mkdirSync(join(root, '.agent-env')); writeFileSync(join(root, '.agent-env/old.env'), 'VALUE=old'); }
    const delayed = { ...spec(), ...(op === 'docker.runEnv' ? { envFile: '.agent-env/old.env' } : {}) };
    await runtime().fence(fence());
    await expect(runOp(op, delayed, () => {}, { sealed: true })).rejects.toThrow(/fenced|update the panel/i);
    expect(effects()).toEqual([]);
  });
  it('creates the complete batch from one pinned image and starts only immutable IDs', async () => {
    const result = await runtime().prepare(prepare(5, 10, [spec(), { ...spec(10, 'web-10-r2'), extraNetworks: ['nd-extra'] }]));
    expect(result.items).toHaveLength(2); expect(new Set(result.items.map(item => item.id)).size).toBe(2);
    expect(effects().filter(args => args[0] === 'start')).toEqual(result.items.map(item => ['start', item.id]));
    expect(effects()).toContainEqual(['network', 'connect', 'nd-extra', result.items[1]!.id]);
    expect(rows.every(row => row.nonce === nonce(5) && /^[a-f0-9]{64}$/.test(row.specHash!))).toBe(true);
  });
  it('replays a completed creation receipt across a fresh journal instance without creating or starting a replacement', async () => {
    const first = await runtime().prepare(prepare()); const count = io.spawn.mock.calls.length; rows = [];
    expect(await runtime().prepare(prepare())).toEqual(first); expect(io.spawn.mock.calls).toHaveLength(count);
  });
  it('replays a completed preparation receipt after its secret environment file is removed', async () => {
    mkdirSync(join(root, '.agent-env')); const file = join(root, '.agent-env/web.env');
    writeFileSync(file, 'OWNER_SECRET=temporary-fixture');
    const input = prepare(5, 10, [{ ...spec(), envFile: '.agent-env/web.env' }]);
    const first = await runtime().prepare(input); unlinkSync(file); io.spawn.mockClear();
    expect(await runtime().prepare(input)).toEqual(first);
    expect(effects()).toEqual([]);
    expect(readFileSync(journalFile()).includes(Buffer.from('temporary-fixture'))).toBe(false);
  });
  it('refuses a changed request shape after the environment file is removed', async () => {
    mkdirSync(join(root, '.agent-env')); const file = join(root, '.agent-env/web.env'); writeFileSync(file, 'KEY=first');
    const input = prepare(5, 10, [{ ...spec(), envFile: '.agent-env/web.env' }]);
    await runtime().prepare(input); unlinkSync(file); io.spawn.mockClear();
    await expect(runtime().prepare({ ...input, specs: [{ ...input.specs[0], cmd: ['different'] }] })).rejects.toThrow(/shape changed/);
    expect(effects()).toEqual([]);
  });
  it('does not create a runtime when an initial environment file is missing', async () => {
    const input = prepare(5, 10, [{ ...spec(), envFile: '.agent-env/missing.env' }]);
    await expect(runtime().prepare(input)).rejects.toThrow(/receipt unavailable/);
    expect(effects()).toEqual([]);
    const db = new DatabaseSync(journalFile());
    try { expect(db.prepare('SELECT * FROM lifecycle_head').get()).toBeUndefined(); }
    finally { db.close(); }
  });
  it('does not replay an incomplete preparation after its environment disappears', async () => {
    mkdirSync(join(root, '.agent-env')); const file = join(root, '.agent-env/web.env'); writeFileSync(file, 'KEY=first');
    const input = prepare(5, 10, [{ ...spec(), envFile: '.agent-env/web.env', extraNetworks: ['nd-extra'] }]);
    failNetwork = true; await expect(runtime().prepare(input)).rejects.toThrow(/network attachment/);
    unlinkSync(file); io.spawn.mockClear();
    await expect(runtime().prepare(input)).rejects.toThrow(/receipt unavailable/); expect(effects()).toEqual([]);
  });
  it('refuses a changed remaining environment in a partly cleaned replica set', async () => {
    mkdirSync(join(root, '.agent-env')); const first = join(root, '.agent-env/first.env'), second = join(root, '.agent-env/second.env');
    writeFileSync(first, 'KEY=first'); writeFileSync(second, 'KEY=second');
    const input = prepare(5, 10, [{ ...spec(), envFile: '.agent-env/first.env' }, { ...spec(10, 'web-10-r2'), envFile: '.agent-env/second.env' }]);
    await runtime().prepare(input); unlinkSync(first); writeFileSync(second, 'KEY=changed'); io.spawn.mockClear();
    await expect(runtime().prepare(input)).rejects.toThrow(/intent changed/); expect(effects()).toEqual([]);
  });
  it('does not accept a receipt after a newer service fence', async () => {
    mkdirSync(join(root, '.agent-env')); const file = join(root, '.agent-env/web.env'); writeFileSync(file, 'KEY=first');
    const input = prepare(5, 10, [{ ...spec(), envFile: '.agent-env/web.env' }]); await runtime().prepare(input);
    unlinkSync(file); await runtime().fence(fence(8)); io.spawn.mockClear();
    await expect(runtime().prepare(input)).rejects.toThrow(/stale/); expect(effects()).toEqual([]);
  });
  it('backfills shape evidence for an old receipt only while its environment remains available', async () => {
    mkdirSync(join(root, '.agent-env')); const file = join(root, '.agent-env/web.env'); writeFileSync(file, 'KEY=first');
    const input = prepare(5, 10, [{ ...spec(), envFile: '.agent-env/web.env' }]), first = await runtime().prepare(input);
    let db = new DatabaseSync(journalFile()); try { db.exec('DROP TABLE runtime_prepare_shape'); } finally { db.close(); }
    expect(await runtime().prepare(input)).toEqual(first);
    db = new DatabaseSync(journalFile()); try { expect(db.prepare('SELECT * FROM runtime_prepare_shape').get()).toBeDefined(); db.exec('DROP TABLE runtime_prepare_shape'); } finally { db.close(); }
    unlinkSync(file); io.spawn.mockClear();
    await expect(runtime().prepare(input)).rejects.toThrow(/receipt unavailable/); expect(effects()).toEqual([]);
  });
  it('rolls back authority and performs no Docker effect if shape persistence fails', async () => {
    const missing = prepare(5, 10, [{ ...spec(), envFile: '.agent-env/missing.env' }]);
    await expect(runtime().prepare(missing)).rejects.toThrow(/receipt unavailable/);
    const db = new DatabaseSync(journalFile());
    try {
      db.exec("CREATE TABLE runtime_prepare_shape (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, request_hash TEXT NOT NULL, shape_hash TEXT NOT NULL); CREATE TRIGGER reject_shape BEFORE INSERT ON runtime_prepare_shape BEGIN SELECT RAISE(ABORT,'proof shape rejected'); END");
    } finally { db.close(); }
    mkdirSync(join(root, '.agent-env')); writeFileSync(join(root, '.agent-env/web.env'), 'KEY=first'); io.spawn.mockClear();
    await expect(runtime().prepare(prepare(5, 10, [{ ...spec(), envFile: '.agent-env/web.env' }]))).rejects.toThrow(/proof shape rejected/);
    expect(effects()).toEqual([]);
    const after = new DatabaseSync(journalFile()); try {
      expect(after.prepare('SELECT * FROM lifecycle_head').get()).toBeUndefined();
      expect(after.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_protocol'").get()).toBeUndefined();
    } finally { after.close(); }
  });
  it('refuses a receipt if protocol adoption evidence is missing', async () => {
    mkdirSync(join(root, '.agent-env')); const file = join(root, '.agent-env/web.env'); writeFileSync(file, 'KEY=first');
    const input = prepare(5, 10, [{ ...spec(), envFile: '.agent-env/web.env' }]); await runtime().prepare(input); unlinkSync(file);
    const db = new DatabaseSync(journalFile()); try { db.exec('DELETE FROM runtime_protocol'); } finally { db.close(); }
    io.spawn.mockClear(); await expect(runtime().prepare(input)).rejects.toThrow(/receipt unavailable/); expect(effects()).toEqual([]);
  });
  it('refuses replay from an unsupported journal protocol after environment cleanup', async () => {
    mkdirSync(join(root, '.agent-env')); const file = join(root, '.agent-env/web.env'); writeFileSync(file, 'KEY=first');
    const input = prepare(5, 10, [{ ...spec(), envFile: '.agent-env/web.env' }]); await runtime().prepare(input); unlinkSync(file);
    const db = new DatabaseSync(journalFile()); try { db.exec('UPDATE runtime_protocol SET version=2'); } finally { db.close(); }
    io.spawn.mockClear(); await expect(runtime().prepare(input)).rejects.toThrow(/Unsupported runtime journal protocol/); expect(effects()).toEqual([]);
  });
  it('refuses altered shape evidence even while the environment file is present', async () => {
    mkdirSync(join(root, '.agent-env')); writeFileSync(join(root, '.agent-env/web.env'), 'KEY=first');
    const input = prepare(5, 10, [{ ...spec(), envFile: '.agent-env/web.env' }]); await runtime().prepare(input);
    const db = new DatabaseSync(journalFile()); try { db.prepare('UPDATE runtime_prepare_shape SET shape_hash=?').run('f'.repeat(64)); } finally { db.close(); }
    io.spawn.mockClear(); await expect(runtime().prepare(input)).rejects.toThrow(/shape conflicts/); expect(effects()).toEqual([]);
  });
  it('refuses a forged stored receipt after environment cleanup', async () => {
    mkdirSync(join(root, '.agent-env')); const file = join(root, '.agent-env/web.env'); writeFileSync(file, 'KEY=first');
    const input = prepare(5, 10, [{ ...spec(), envFile: '.agent-env/web.env' }]); await runtime().prepare(input); unlinkSync(file);
    const db = new DatabaseSync(journalFile()); try { const row = db.prepare('SELECT receipt FROM lifecycle_head').get()!; const receipt = JSON.parse(String(row.receipt)); receipt.items[0].name = 'other-10'; db.prepare('UPDATE lifecycle_head SET receipt=?').run(JSON.stringify(receipt)); } finally { db.close(); }
    io.spawn.mockClear(); await expect(runtime().prepare(input)).rejects.toThrow(/receipt identity changed/); expect(effects()).toEqual([]);
  });
  it.each([{ requestId: nonce(6) }, { specs: [{ ...spec(), cmd: ['changed'] }] }])('refuses a same-revision fork before Docker: %j', patch => {
    return (async () => { await runtime().prepare(prepare()); io.spawn.mockClear(); await expect(runtime().prepare({ ...prepare(), ...patch })).rejects.toThrow(/conflict/); expect(effects()).toEqual([]); })();
  });
  it('refuses a foreign occupied name before any creation in the batch', async () => {
    rows.push({ id: 'a'.repeat(64), name: 'web-10-r2', managed: 'service', serviceId: '8', deploymentId: '10', nonce: null, specHash: null, running: true, status: 'running', networks: { ninedeploy: {} } });
    await expect(runtime().prepare(prepare(5, 10, [spec(), spec(10, 'web-10-r2')]))).rejects.toThrow(/ownership/); expect(effects()).toEqual([]); expect(rows[0]!.running).toBe(true);
  });
  it('recovers an interrupted network attachment from its nonce-bound created ID without duplicating creation', async () => {
    const input = prepare(5, 10, [{ ...spec(), extraNetworks: ['nd-extra'] }]); failNetwork = true;
    await expect(runtime().prepare(input)).rejects.toThrow(/network attachment/); const retained = rows[0]!.id; expect(rows[0]!.running).toBe(false);
    failNetwork = false; const result = await runtime().prepare(input);
    expect(result.items[0]!.id).toBe(retained); expect(effects().filter(args => args[0] === 'create')).toHaveLength(1);
  });
  it('keeps environment and command secrets out of the journal and detects changed environment replay', async () => {
    mkdirSync(join(root, '.agent-env')); const file = join(root, '.agent-env/web.env'); writeFileSync(file, 'OWNER_SECRET=never-journal-this');
    const input = prepare(5, 10, [{ ...spec(), envFile: '.agent-env/web.env', cmd: ['private-command-argument'] }]);
    await runtime().prepare(input);
    const contents = readFileSync(journalFile()); expect(contents.includes(Buffer.from('never-journal-this'))).toBe(false); expect(contents.includes(Buffer.from('private-command-argument'))).toBe(false);
    writeFileSync(file, 'OWNER_SECRET=changed'); io.spawn.mockClear(); await expect(runtime().prepare(input)).rejects.toThrow(/conflict/); expect(effects()).toEqual([]);
  });
  it('retires exact generations under a newer revision and replays after those IDs disappear', async () => {
    const prepared = await runtime().prepare(prepare()); const targets = prepared.items.map(({ running: _running, ...target }) => target);
    const request = { ...fence(7), targets, graceSeconds: 5 }; const retired = await runtime().retire(request);
    expect(retired.items).toEqual(targets.map(target => ({ ...target, removed: true }))); expect(rows).toEqual([]);
    expect(effects()).toContainEqual(['rm', '-f', targets[0]!.id]); io.spawn.mockClear(); expect(await runtime().retire(request)).toEqual(retired); expect(effects()).toEqual([]);
    await expect(runtime().prepare(prepare())).rejects.toThrow(/stale/);
  });
  it('validates every retirement identity before stopping a foreign member', async () => {
    const prepared = await runtime().prepare(prepare()); const own = prepared.items[0]!;
    rows.push({ ...rows[0]!, id: 'd'.repeat(64), name: 'other-10', serviceId: '8' }); io.spawn.mockClear();
    await expect(runtime().retire({ ...fence(7), graceSeconds: 5, targets: [{ id: own.id, name: own.name, deploymentId: 10 }, { id: 'd'.repeat(64), name: 'other-10', deploymentId: 10 }] })).rejects.toThrow(/ownership/);
    expect(effects()).toEqual([]); expect(rows.every(row => row.running)).toBe(true);
  });
  it('adopts an already-issued legacy fence without changing its replay identity or receipt', async () => {
    const request = { ...fence(), deploymentId: 9, action: 'stop', targets: [] };
    const old = await createNodeLifecycle(join(root, '.agent-work', '.lifecycle')).apply(request);
    expect(await runtime().fence(fence())).toMatchObject({ complete: true, revision: 8 });
    expect(await createNodeLifecycle(join(root, '.agent-work', '.lifecycle')).apply(request)).toEqual(old); expect(effects()).toEqual([]);
  });
  it('refuses an invalid mode version without replacing the prior owner', async () => {
    await runtime().fence(fence()); const db = new DatabaseSync(journalFile());
    try { db.exec('UPDATE runtime_protocol SET version=2'); } finally { db.close(); }
    await expect(runtime().fence(fence(12))).rejects.toThrow(/Unsupported/); expect(effects()).toEqual([]);
  });
  it.each(['ninedeploy.mutation', 'ninedeploy.spec'])('rejects a forged private identity label %s before journal or Docker access', async label => {
    await expect(runtime().prepare(prepare(5, 10, [{ ...spec(), labels: { [label]: 'forged' } }]))).rejects.toThrow(/Invalid label/);
    expect(existsSync(journalFile())).toBe(false); expect(io.spawn).not.toHaveBeenCalled();
  });
  it('keeps protocol adoption sticky after a legacy fence receipt remains replayable', async () => {
    await createNodeLifecycle(join(root, '.agent-work', '.lifecycle')).apply({ ...fence(), deploymentId: 9, action: 'stop', targets: [] });
    await runtime().fence(fence());
    rows.push({ id: 'e'.repeat(64), name: 'web-8', managed: 'service', serviceId: '7', deploymentId: '8', nonce: null, specHash: null, running: true, status: 'running', networks: { ninedeploy: {} } });
    await expect(runOp('docker.stop', { name: 'web-8' }, () => {}, { sealed: true })).rejects.toThrow(/fenced/);
    expect(effects()).toEqual([]); expect(rows[0]!.running).toBe(true);
  });
  it('refuses a mutated environment before the creation effect', async () => {
    mkdirSync(join(root, '.agent-env')); const file = join(root, '.agent-env/web.env'); writeFileSync(file, 'KEY=first');
    const original = io.spawn.getMockImplementation()!; let changed = false;
    io.spawn.mockImplementation(async (...args: Parameters<typeof original>) => { const result = await original(...args); if (!changed && args[1][0] === 'inspect') { changed = true; writeFileSync(file, 'KEY=second'); } return result; });
    await expect(runtime().prepare(prepare(5, 10, [{ ...spec(), envFile: '.agent-env/web.env' }]))).rejects.toThrow(/environment changed/);
    expect(effects()).toEqual([]);
  });
  it('holds an ambiguous creation receipt and recovers its own attested resource without creating a duplicate', async () => {
    const original = io.spawn.getMockImplementation()!;
    io.spawn.mockImplementation(async (...args: Parameters<typeof original>) => { const result = await original(...args); if (args[1][0] === 'create') args[2]('d'.repeat(64)); return result; });
    await expect(runtime().prepare(prepare())).rejects.toThrow(/receipt unavailable/); expect(rows).toHaveLength(1); expect(rows[0]!.running).toBe(false);
    const retained = rows[0]!.id; io.spawn.mockImplementation(original); const result = await runtime().prepare(prepare());
    expect(result.items[0]!.id).toBe(retained); expect(effects().filter(args => args[0] === 'create')).toHaveLength(1);
  });

  it.each(['docker.rm', 'docker.retire', 'docker.networkConnect', 'docker.networkDisconnect'])('refuses delayed unversioned %s against an ID now selected by a newer lifecycle owner', async op => {
    const prepared = await runtime().prepare(prepare()), target = prepared.items[0]!;
    await createNodeLifecycle(join(root, '.agent-work', '.lifecycle')).apply({ ...fence(9), deploymentId: 10, action: 'start', targets: [{ id: target.id, name: target.name }] });
    io.spawn.mockClear();
    const params = op === 'docker.retire' ? { id: target.id, name: target.name } : op.startsWith('docker.network')
      ? { container: target.name, network: op === 'docker.networkConnect' ? 'nd-extra' : 'ninedeploy' } : { name: target.name };
    await expect(runOp(op, params, () => {}, { sealed: true })).rejects.toThrow(/fenced/);
    expect(effects()).toEqual([]); expect(rows[0]!.running).toBe(true); expect(Object.keys(rows[0]!.networks)).toEqual(['ninedeploy']);
  });
  it.each(['database', null])('preserves legacy removal for an unmanaged %s container', async managed => {
    await runtime().fence(fence());
    rows.push({ id: 'a'.repeat(64), name: 'legacy', managed, serviceId: null, deploymentId: null, nonce: null, specHash: null, running: false, status: 'exited', networks: {} });
    expect(await runOp('docker.rm', { name: 'legacy' }, () => {}, { sealed: true })).toBe(0); expect(rows).toEqual([]);
  });

  it('replays the same canonical spec after locale-dependent label ordering changes', async () => {
    const input = prepare(5, 10, [{ ...spec(), labels: { 'ninedeploy.alpha': 'a', 'ninedeploy.beta': 'b' } }]);
    const locale = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (this: string, other: string) { return String(this) < other ? 1 : String(this) > other ? -1 : 0; });
    const first = await runtime().prepare(input); locale.mockRestore(); io.spawn.mockClear();
    expect(await runtime().prepare(input)).toEqual(first); expect(io.spawn).not.toHaveBeenCalled();
  });

  it.each(['docker.rm', 'docker.networkConnect', 'docker.networkDisconnect'])('does not let legacy %s follow a same-name replacement while waiting for service authority', async op => {
    const originalId = 'a'.repeat(64), replacementId = 'b'.repeat(64);
    const originalRow: Row = { id: originalId, name: 'legacy', managed: 'service', serviceId: '7', deploymentId: '10', nonce: null, specHash: null, running: true, status: 'running', networks: { ninedeploy: {} } };
    rows.push(originalRow); const implementation = io.spawn.getMockImplementation()!; let replaced = false;
    io.spawn.mockImplementation(async (...args: Parameters<typeof implementation>) => { const result = await implementation(...args);
      if (!replaced && args[1][0] === 'inspect') { replaced = true; rows = [{ ...originalRow, id: replacementId }]; } return result;
    });
    const params = op === 'docker.rm' ? { name: 'legacy' } : { container: 'legacy', network: op === 'docker.networkConnect' ? 'nd-extra' : 'ninedeploy' };
    expect(await runOp(op, params, () => {}, { sealed: true })).toBe(1); expect(effects()).toEqual([]);
    expect(rows[0]!.id).toBe(replacementId); expect(rows[0]!.running).toBe(true); expect(Object.keys(rows[0]!.networks)).toEqual(['ninedeploy']);
  });

  it('prepares stopped capacity without starting or probing it as a serving replica', async () => {
    const input = { ...prepare(5, 10, [spec(), spec(10, 'web-10-r2')]), startNames: ['web-10'] };
    const reply = await runtime().prepare(input);
    expect(reply.items.map(item => item.running)).toEqual([true, false]); expect(rows[1]!.status).toBe('created');
    expect(effects().filter(args => args[0] === 'start')).toEqual([['start', reply.items[0]!.id]]);
    io.spawn.mockClear(); await expect(runtime().prepare({ ...input, startNames: ['web-10', 'web-10-r2'] })).rejects.toThrow(/conflict/); expect(effects()).toEqual([]);
  });
  it('prepares a completely stopped spare batch and joins its network without starting it', async () => {
    const prepared = await runtime().prepare({ ...prepare(), startNames: [] }); expect(prepared.items[0]!.running).toBe(false);
    const { running: _running, ...target } = prepared.items[0]!;
    const request = { ...fence(6), action: 'connect', networks: ['nd-dbnet-pg'], targets: [target] };
    const receipt = await runtime().networks(request); expect(receipt.items[0]!.connected).toBe(true); expect(rows[0]!.running).toBe(false);
    expect(effects().filter(args => args[0] === 'start')).toEqual([]); expect(effects()).toContainEqual(['network', 'connect', 'nd-dbnet-pg', target.id]);
    io.spawn.mockClear(); expect(await runtime().networks(request)).toEqual(receipt); expect(io.spawn).not.toHaveBeenCalled();
    await runtime().networks({ ...request, revision: 7, action: 'disconnect' }); expect(Object.hasOwn(rows[0]!.networks, 'nd-dbnet-pg')).toBe(false); expect(rows[0]!.running).toBe(false);
  });
  it('recovers partial network attachment and verifies all identities before applying a changed network set', async () => {
    const prepared = await runtime().prepare(prepare()); const { running: _running, ...target } = prepared.items[0]!;
    const request = { ...fence(6), action: 'connect', networks: ['nd-dbnet-pg'], targets: [target] }; failNetwork = true;
    await expect(runtime().networks(request)).rejects.toThrow(/membership unconfirmed/); failNetwork = false;
    expect((await runtime().networks(request)).items[0]!.connected).toBe(true);
    io.spawn.mockClear(); await expect(runtime().networks({ ...request, revision: 7, targets: [{ ...target, deploymentId: 11 }] })).rejects.toThrow(/ownership/); expect(effects()).toEqual([]);
  });
  it('refuses a cached receipt from another owner without issuing a Docker effect', async () => {
    await runtime().prepare(prepare()); const db = new DatabaseSync(journalFile());
    try { const row = db.prepare('SELECT receipt FROM lifecycle_head WHERE id=1').get()!; const receipt = JSON.parse(String(row.receipt)); receipt.requestId = nonce(99); db.prepare('UPDATE lifecycle_head SET receipt=? WHERE id=1').run(JSON.stringify(receipt)); } finally { db.close(); }
    io.spawn.mockClear(); await expect(runtime().prepare(prepare())).rejects.toThrow(/receipt ownership/); expect(io.spawn).not.toHaveBeenCalled();
  });

});

describe('fenced generation-independent inventory and Stop', () => {
  it('requires explicit protocol adoption before inventory under a replayable legacy fence', async () => {
    const legacy = { ...fence(), deploymentId: 10, action: 'stop', targets: [] };
    await createNodeLifecycle(join(root, '.agent-work', '.lifecycle')).apply(legacy);
    io.spawn.mockClear();
    await expect(runtime().inventory(fence())).rejects.toThrow(/protocol is unconfirmed/);
    expect(io.spawn).not.toHaveBeenCalled();
    await runtime().fence(fence());
    expect((await runtime().inventory(fence())).items).toEqual([]);
  });
  it('does not follow a reused name when a captured Stop target has disappeared', async () => {
    const prepared = await runtime().prepare(prepare());
    const input = { ...fence(), graceSeconds: 1, targets: prepared.items.map(({ running: _running, ...target }) => target) };
    rows = [{ ...rows[0]!, id: 'e'.repeat(64), deploymentId: '11' }]; io.spawn.mockClear();
    expect((await runtime().stop(input)).items).toEqual(input.targets.map(target => ({ ...target, running: false })));
    expect(rows[0]!.running).toBe(true); expect(effects()).toEqual([]);
  });
  it.each(['unavailable', 'malformed', 'duplicate', 'overflow', 'too-many'])('holds incomplete Docker inventory without issuing effects: %s', async failure => {
    await runtime().fence(fence());
    const original = io.spawn.getMockImplementation()!;
    io.spawn.mockImplementation(async (...args: Parameters<typeof original>) => {
      if (args[1][0] !== 'ps') return original(...args);
      const sink = args[2];
      if (failure === 'unavailable') return 1;
      if (failure === 'malformed') sink('not-an-immutable-id');
      if (failure === 'duplicate') { sink('a'.repeat(64)); sink('a'.repeat(64)); }
      if (failure === 'overflow') sink('a'.repeat(65_537));
      if (failure === 'too-many') for (let n = 1; n <= 31; n++) sink(n.toString(16).padStart(64, '0'));
      return 0;
    });
    await expect(runtime().inventory(fence())).rejects.toThrow(/incomplete/);
    expect(effects().filter(args => args[0] !== 'ps')).toEqual([]);
  });
  it.each(['missing-mode', 'unknown-mode', 'corrupt-intent'])('retains an unconfirmed inventory journal without Docker effects: %s', async failure => {
    await runtime().fence(fence()); const db = new DatabaseSync(journalFile());
    try {
      if (failure === 'missing-mode') db.exec('DELETE FROM runtime_protocol');
      if (failure === 'unknown-mode') db.exec('UPDATE runtime_protocol SET version=2');
      if (failure === 'corrupt-intent') db.prepare('UPDATE lifecycle_head SET request_hash=?').run('0'.repeat(64));
    } finally { db.close(); }
    io.spawn.mockClear();
    await expect(runtime().inventory(fence())).rejects.toThrow(/unconfirmed/);
    expect(io.spawn).not.toHaveBeenCalled();
  });
  it('retains a running managed container whose generation label is invalid', async () => {
    await runtime().prepare(prepare()); rows[0]!.deploymentId = 'unknown';
    await runtime().fence(fence()); io.spawn.mockClear();
    await expect(runtime().inventory(fence())).rejects.toThrow(/generation is unconfirmed/);
    expect(rows[0]!.running).toBe(true); expect(effects().filter(args => args[0] !== 'ps')).toEqual([]);
  });
  it.each(['failed-command', 'still-running'])('does not complete an unconfirmed physical Stop and retries its captured identity: %s', async failure => {
    const prepared = await runtime().prepare(prepare());
    const input = { ...fence(), graceSeconds: 1, targets: prepared.items.map(({ running: _running, ...target }) => target) };
    const original = io.spawn.getMockImplementation()!;
    io.spawn.mockImplementation(async (...args: Parameters<typeof original>) => args[1][0] === 'stop' ? failure === 'failed-command' ? 1 : 0 : original(...args));
    await expect(runtime().stop(input)).rejects.toThrow(/Stop.*unconfirmed/); expect(rows[0]!.running).toBe(true);
    io.spawn.mockImplementation(original);
    expect((await runtime().stop(input)).items).toEqual(input.targets.map(target => ({ ...target, running: false })));
    expect(rows[0]!.running).toBe(false);
  });
  it('discovers actual IDs across generations and stops without deleting or following replacements', async () => {
    const first = await runtime().prepare(prepare(5, 10));
    const second = await runtime().prepare(prepare(9, 11));
    await runtime().fence(fence(12));
    const inventory = await runtime().inventory({ ...fence(12), expectedNames: ['web-10', 'web-11', 'never-created'] });
    expect(inventory.items.map(item => item.id)).toEqual([first.items[0]!.id, second.items[0]!.id]);
    const input = { ...fence(13), graceSeconds: 5, targets: inventory.items.map(({ running: _running, ...target }) => target) };
    const stopped = await runtime().stop(input);
    expect(stopped.items.every(item => item.running === false)).toBe(true); expect(rows.every(row => !row.running)).toBe(true);
    expect(effects().some(args => args[0] === 'rm')).toBe(false);
    io.spawn.mockClear(); expect(await runtime().stop(input)).toEqual(stopped); expect(io.spawn).not.toHaveBeenCalled();
    await expect(runtime().inventory(fence(12))).rejects.toThrow(/stale/);
  });
  it('does not invent identities for an empty fenced node', async () => {
    await runtime().fence(fence());
    expect((await runtime().inventory(fence())).items).toEqual([]);
    expect((await runtime().stop({ ...fence(9), graceSeconds: 5, targets: [] })).items).toEqual([]);
    expect(effects().filter(args => args[0] !== 'ps')).toEqual([]);
  });
  it('refuses inventory before its fence or with another owner nonce', async () => {
    await expect(runtime().inventory(fence())).rejects.toThrow(/fence/);
    await runtime().fence(fence()); io.spawn.mockClear();
    await expect(runtime().inventory({ ...fence(), requestId: nonce(99) })).rejects.toThrow(/fence/);
    expect(io.spawn).not.toHaveBeenCalled();
  });
  it('holds a foreign container occupying an expected pending name', async () => {
    rows.push({ id: 'f'.repeat(64), name: 'web-10', managed: 'service', serviceId: '8', deploymentId: '10', nonce: null, specHash: null, status: 'running', running: true, networks: {} });
    await runtime().fence(fence());
    await expect(runtime().inventory({ ...fence(), expectedNames: ['web-10'] })).rejects.toThrow(/ownership/);
    expect(rows[0]!.running).toBe(true); expect(effects().filter(args => args[0] !== 'ps')).toEqual([]);
  });
  it('validates every Stop identity before affecting any owned member', async () => {
    const own = await runtime().prepare(prepare());
    rows.push({ ...rows[0]!, id: 'f'.repeat(64), name: 'foreign', serviceId: '8' }); io.spawn.mockClear();
    await expect(runtime().stop({ ...fence(), graceSeconds: 5, targets: [{ id: own.items[0]!.id, name: own.items[0]!.name, deploymentId: 10 }, { id: 'f'.repeat(64), name: 'foreign', deploymentId: 10 }] })).rejects.toThrow(/ownership/);
    expect(effects()).toEqual([]); expect(rows.every(row => row.running)).toBe(true);
  });
});
