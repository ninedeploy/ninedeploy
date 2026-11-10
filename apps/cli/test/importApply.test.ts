import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyPlan, databaseVersion, envFileKeys, importApplyAction, renderApplyPreview, renderReceipt, validatePlan,
  type ApplyClient, type ImportReceipt,
} from '../src/commands/importApply.js';
import { planFromCaprover } from '../src/lib/importers/caprover.js';
import type { ImportPlan, SourceGet } from '../src/lib/importers/plan.js';
import { caproverLive, SENTINEL } from './fixtures/importSources.js';

const fromFixture = (map: Record<string, unknown>): SourceGet => async (p) => {
  if (!(p in map)) throw new Error(`unexpected source call ${p}`);
  return structuredClone(map[p]);
};
const PANEL = 'https://panel.example';

/** The plan of the live CapRover capture: blog (git, env), proxy (image), pg (postgres, never deployed). */
const livePlan = async (): Promise<ImportPlan> => planFromCaprover(fromFixture(caproverLive), 'http://127.0.0.1:13000');

/** A panel that hands out ids and remembers every call; `reuse` mimics reuseExisting on a name it has seen. */
function fakePanel() {
  const calls: Array<{ op: string; input: unknown }> = [];
  const attached: Array<{ id: number; serviceId: number; databaseId: number; envAlias: string }> = [];
  const byName = new Map<string, number>();
  let next = 100;
  const idFor = (name: string) => {
    if (!byName.has(name)) byName.set(name, next++);
    return byName.get(name)!;
  };
  const client: ApplyClient = {
    services: { create: vi.fn(async (input) => { calls.push({ op: 'service', input }); return { id: idFor(`s:${input.name}`) }; }) },
    databases: { create: vi.fn(async (input) => { calls.push({ op: 'database', input }); return { id: idFor(`d:${input.name}`) }; }) },
    env: { import: vi.fn(async (serviceId, content) => { calls.push({ op: 'env', input: { serviceId, content } }); return { imported: envFileKeys(content).length, skipped: 0, errors: [] }; }) },
    attachments: {
      list: vi.fn(async (serviceId) => attached.filter((a) => a.serviceId === serviceId)),
      create: vi.fn(async (serviceId, input) => {
        calls.push({ op: 'attach', input: { serviceId, ...input } });
        const a = { id: 500 + attached.length, serviceId, databaseId: input.databaseId, envAlias: input.envAlias ?? 'DATABASE_URL' };
        attached.push(a);
        return a;
      }),
    },
  };
  return { client, calls, attached };
}

/** A receipt store that keeps every saved snapshot, as the file would. */
function store(initial: ImportReceipt | null = null) {
  const snapshots: ImportReceipt[] = [];
  return { snapshots, save: (r: ImportReceipt) => { snapshots.push(structuredClone(r)); }, initial, last: () => structuredClone(snapshots.at(-1)!) };
}

describe('import apply: plan checks and helpers', () => {
  it('accepts only a complete planVersion 1 plan', async () => {
    const plan = await livePlan();
    expect(validatePlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(() => validatePlan(null)).toThrow(/planVersion 1/);
    expect(() => validatePlan({ ...plan, planVersion: 2 })).toThrow(/planVersion 1/);
    expect(() => validatePlan({ ...plan, services: undefined })).toThrow(/incomplete/);
    expect(() => validatePlan({ ...plan, source: { kind: 'caprover' } })).toThrow(/incomplete/);
    expect(() => validatePlan({ ...plan, services: [{ ref: 'a', name: 'a' }] })).toThrow(/A service in the plan is incomplete/);
    expect(() => validatePlan({ ...plan, databases: [{ ref: 'a' }] })).toThrow(/A database in the plan is incomplete/);
  });

  it('carries the source version only for the same image repository and a version tag', () => {
    expect(databaseVersion('postgres', 'postgres:14.5')).toBe('14.5');
    expect(databaseVersion('postgres', 'docker.io/library/postgres:16-alpine@sha256:abc')).toBe('16-alpine');
    expect(databaseVersion('mysql', 'library/mysql:8.0')).toBe('8.0');
    expect(databaseVersion('keydb', 'eqalpha/keydb:6.3.4')).toBe('6.3.4');
    expect(databaseVersion('postgres', 'postgres:latest')).toBeUndefined();
    expect(databaseVersion('postgres', 'bitnami/postgresql:16')).toBeUndefined();
    expect(databaseVersion('postgres', 'registry.local:5000/postgres')).toBeUndefined();
    expect(databaseVersion('postgres', 'postgres')).toBeUndefined();
    expect(databaseVersion('postgres', null)).toBeUndefined();
  });

  it('reads variable names from a .env file, never values', () => {
    expect(envFileKeys(`A=1\r\nexport B = two\n# C=3\n  D=\nnot a line\n1X=bad\n`)).toEqual(['A', 'B', 'D']);
  });
});

describe('import apply: creating', () => {
  it('creates services and databases with reuseExisting, never a domain or a deploy, and records each one', async () => {
    const plan = await livePlan();
    const { client, calls } = fakePanel();
    const s = store();
    const receipt = await applyPlan(plan, { project: 7 }, { client, panel: PANEL, receipt: null, save: s.save, now: () => new Date('2026-11-10T00:00:00Z') });

    expect(calls.map((x) => x.op)).toEqual(['service', 'service', 'database']);
    expect(calls[0]!.input).toEqual({ name: 'blog', type: 'docker', repoUrl: 'https://github.com/acme/blog.git', branch: 'main', build: { buildPack: 'auto' }, port: 2368, replicas: 2, volumeMount: '/var/lib/ghost/content', reuseExisting: true, tagProjectIds: [7] });
    expect(calls[1]!.input).toMatchObject({ name: 'proxy', image: 'traefik/whoami:v1.10.3', reuseExisting: true });
    // Never deployed in CapRover: no version to carry, so the panel picks its default.
    expect(calls[2]!.input).toEqual({ name: 'pg', engine: 'postgres', reuseExisting: true, projectId: 7 });
    // The client has no domain or deploy call at all; the receipt says where the domains went.
    expect(receipt.items['service:blog']).toMatchObject({ state: 'done', id: 100, at: '2026-11-10T00:00:00.000Z' });
    expect(receipt.items['service:blog']!.notes.join(' ')).toMatch(/The source's own host stays with it: blog\.captain\.localhost\./);
    expect(receipt.items['service:blog']!.notes.join(' ')).not.toMatch(/Domains wait for the cutover/);
    expect(receipt.items['service:blog']!.notes.join(' ')).toMatch(/To do: Repository credentials do not transfer/);
    expect(receipt.items['env:blog']).toMatchObject({ state: 'skipped', id: 100 });
    expect(receipt.items['env:blog']!.notes[0]).toMatch(/2 variable\(s\) need a value: DB_PASSWORD, url\. Pass --dotenv blog=<path>/);
    expect(receipt.items['service:proxy']).toMatchObject({ state: 'done', id: 101 });
    expect(receipt.items['env:proxy']).toBeUndefined();
    expect(receipt.items['database:pg']).toMatchObject({ state: 'done', id: 102 });
    expect(receipt.items['database:pg']!.notes).toEqual(expect.arrayContaining(['Created empty: the data moves in step 3.', "NineDeploy's default postgres version."]));
    expect(receipt).toMatchObject({ receiptVersion: 1, panel: PANEL, source: { kind: 'caprover', url: 'http://127.0.0.1:13000' } });
    // Pending is saved before each create call.
    expect(s.snapshots.map((r) => Object.values(r.items).at(-1)!.state).slice(0, 2)).toEqual(['pending', 'done']);
  });

  it('imports env values from the file passed, keeps no value in the receipt, and names what the file lacks', async () => {
    const plan = await livePlan();
    const { client, calls } = fakePanel();
    const s = store();
    const file = `DB_PASSWORD=${SENTINEL}\nEXTRA=1\n`;
    const receipt = await applyPlan(plan, { envFiles: { blog: file } }, { client, panel: PANEL, receipt: null, save: s.save });
    expect(calls.find((x) => x.op === 'env')!.input).toEqual({ serviceId: 100, content: file });
    expect(receipt.items['env:blog']).toMatchObject({ state: 'done', id: 100, notes: ['2 imported, 0 skipped.', 'In the plan but not in the file: url.'] });
    expect(JSON.stringify(s.snapshots)).not.toContain(SENTINEL);
    expect(renderReceipt(receipt)).not.toContain(SENTINEL);
  });

  it('marks refused env lines by number only, and a failed import, as failed', async () => {
    const plan = await livePlan();
    const { client } = fakePanel();
    client.env.import = vi.fn(async () => ({ imported: 1, skipped: 0, errors: [{ line: 2, message: `bad value ${SENTINEL}` }] }));
    const r1 = await applyPlan(plan, { envFiles: { blog: 'DB_PASSWORD=x\nurl=y\n' } }, { client, panel: PANEL, receipt: null, save: () => undefined });
    expect(r1.items['env:blog']).toMatchObject({ state: 'failed' });
    expect(r1.items['env:blog']!.notes).toContain('The panel refused line(s) 2 of the file.');
    expect(JSON.stringify(r1)).not.toContain(SENTINEL);
    client.env.import = vi.fn(async () => { throw new Error('HTTP 403'); });
    const r2 = await applyPlan(plan, { envFiles: { blog: 'DB_PASSWORD=x\n' } }, { client, panel: PANEL, receipt: r1, save: () => undefined });
    expect(r2.items['env:blog']).toMatchObject({ state: 'failed', notes: ['HTTP 403'] });
  });

  it('skips a service with nothing to create it from and a database without a managed engine', async () => {
    const plan = await livePlan();
    plan.services.push({ ref: 'up', name: 'uploaded', kind: 'image', create: { name: 'uploaded', type: 'docker' }, domains: [], env: [], volumes: [], issues: [{ level: 'unsupported', option: 'deployedImageName', detail: 'Its image lives in CapRover.' }] });
    plan.databases.push({ ref: 'lite', name: 'lite', engine: null, image: 'libsql', issues: [{ level: 'unsupported', option: 'type', detail: 'libSQL has no equivalent.' }] });
    const { client, calls } = fakePanel();
    const r = await applyPlan(plan, {}, { client, panel: PANEL, receipt: null, save: () => undefined });
    expect(calls.some((x) => (x.input as { name?: string }).name === 'uploaded' || (x.input as { name?: string }).name === 'lite')).toBe(false);
    expect(r.items['service:up']).toMatchObject({ state: 'skipped', notes: ['Nothing to create it from: the plan has no image and no repository for it.', 'Not carried: Its image lives in CapRover.'] });
    expect(r.items['database:lite']).toMatchObject({ state: 'skipped', notes: ['NineDeploy has no managed equivalent.', 'Not carried: libSQL has no equivalent.'] });
  });

  it('lists a custom domain for the cutover and leaves the source\'s own host behind', async () => {
    const plan = await livePlan();
    plan.services[0]!.domains.push({ host: 'blog.acme.example', https: true });
    const { client } = fakePanel();
    const r = await applyPlan(plan, {}, { client, panel: PANEL, receipt: null, save: () => undefined });
    expect(r.items['service:blog']!.notes).toEqual(expect.arrayContaining([
      'Domains wait for the cutover (step 3): blog.acme.example.',
      "The source's own host stays with it: blog.captain.localhost.",
    ]));
  });

  it('carries the source version into the database when the image matches', async () => {
    const plan = await livePlan();
    plan.databases[0]!.image = 'postgres:14.5';
    const { client, calls } = fakePanel();
    const r = await applyPlan(plan, {}, { client, panel: PANEL, receipt: null, save: () => undefined });
    expect(calls.at(-1)!.input).toEqual({ name: 'pg', engine: 'postgres', reuseExisting: true, version: '14.5' });
    expect(r.items['database:pg']!.notes).toContain('Version 14.5, as in the source.');
    plan.databases[0]!.image = 'bitnami/postgresql:16';
    const r2 = await applyPlan(plan, {}, { client, panel: PANEL, receipt: null, save: () => undefined });
    expect(r2.items['database:pg']!.notes.join(' ')).toMatch(/the source runs bitnami\/postgresql:16; check they are compatible before restoring/);
  });
});

describe('import apply: resuming', () => {
  it('a failed create stays failed, and the next run repeats only what is not done', async () => {
    const plan = await livePlan();
    const { client, calls } = fakePanel();
    const create = client.services.create;
    client.services.create = vi.fn(async (input) => {
      if (input.name === 'proxy') throw new Error('fetch failed');
      return create(input);
    });
    const s = store();
    const r1 = await applyPlan(plan, {}, { client, panel: PANEL, receipt: null, save: s.save });
    expect(r1.items['service:proxy']).toMatchObject({ state: 'failed', notes: ['fetch failed'] });
    expect(r1.items['database:pg']!.state).toBe('done');

    client.services.create = create;
    calls.length = 0;
    const r2 = await applyPlan(plan, {}, { client, panel: PANEL, receipt: s.last(), save: s.save });
    expect(calls.map((x) => `${x.op}:${(x.input as { name: string }).name}`)).toEqual(['service:proxy']);
    expect(r2.items['service:proxy']).toMatchObject({ state: 'done', id: 102 });
    expect(r2.items['service:blog']!.id).toBe(100);
  });

  it('a run that stopped after the create call but before the receipt said done repeats it with reuseExisting and gets the same id', async () => {
    const plan = await livePlan();
    const { client, calls } = fakePanel();
    const s = store();
    // The panel created blog, then the process died before "done" reached the file.
    const dying = (r: ImportReceipt) => {
      if (r.items['service:blog']?.state === 'done') throw new Error('killed');
      s.save(r);
    };
    await expect(applyPlan(plan, {}, { client, panel: PANEL, receipt: null, save: dying })).rejects.toThrow('killed');
    expect(calls).toHaveLength(1);
    expect(s.last().items['service:blog']!.state).toBe('pending');

    calls.length = 0;
    const r = await applyPlan(plan, {}, { client, panel: PANEL, receipt: s.last(), save: s.save });
    expect(calls[0]).toMatchObject({ op: 'service', input: { name: 'blog', reuseExisting: true } });
    expect(r.items['service:blog']).toMatchObject({ state: 'done', id: 100 });
  });

  it('refuses a receipt from another panel, another source or another format, and an --dotenv for no service', async () => {
    const plan = await livePlan();
    const { client } = fakePanel();
    const base: ImportReceipt = { receiptVersion: 1, panel: PANEL, source: { kind: 'caprover', url: 'http://127.0.0.1:13000' }, items: {} };
    const run = (receipt: ImportReceipt | null, envFiles?: Record<string, string>) => applyPlan(plan, { envFiles }, { client, panel: PANEL, receipt, save: () => undefined });
    await expect(run({ ...base, panel: 'https://other.example' })).rejects.toThrow(/receipt is for https:\/\/other\.example/);
    await expect(run({ ...base, source: { kind: 'coolify', url: 'https://c.example' } })).rejects.toThrow(/plan of coolify at https:\/\/c\.example/);
    await expect(run({ ...base, receiptVersion: 2 as 1 })).rejects.toThrow(/receiptVersion 1/);
    await expect(run(null, { nope: 'A=1' })).rejects.toThrow(/--dotenv names no service in the plan: nope/);
    expect(client.services.create).not.toHaveBeenCalled();
  });
});

describe('ninedeploy import apply', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const setup = async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nd-apply-'));
    dirs.push(dir);
    const planPath = path.join(dir, 'plan.json');
    writeFileSync(planPath, JSON.stringify(await livePlan()));
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    return { dir, planPath, logs };
  };

  it('without --yes, shows what it would create and calls nothing', async () => {
    const { planPath, logs } = await setup();
    const { client } = fakePanel();
    await importApplyAction(planPath, {}, { client, panel: `${PANEL}/` });
    const out = logs.join('\n');
    expect(out).toMatch(/Import into https:\/\/panel\.example(?!\/)/);
    expect(out).toMatch(/\+ blog: git https:\/\/github\.com\/acme\/blog\.git@main/);
    expect(out).toMatch(/env: 2 name\(s\), no values \(pass --dotenv blog=<path>\)/);
    expect(out).toMatch(/The source's own host stays with it: blog\.captain\.localhost/);
    expect(out).toMatch(/\+ proxy: image traefik\/whoami:v1\.10\.3/);
    expect(out).toMatch(/\+ pg: postgres \(default version\)/);
    expect(out).toMatch(/Repeat with --yes/);
    expect(client.services.create).not.toHaveBeenCalled();
    expect(existsSync(planPath.replace('.json', '.receipt.json'))).toBe(false);
  });

  it('with --yes, creates, writes the receipt next to the plan, and a second run creates nothing', async () => {
    const { dir, planPath, logs } = await setup();
    const envPath = path.join(dir, 'blog.env');
    writeFileSync(envPath, `DB_PASSWORD=${SENTINEL}\nurl=https://blog\n`);
    const { client, calls } = fakePanel();
    await importApplyAction(planPath, { yes: true, project: '3', dotenv: [`blog=${envPath}`] }, { client, panel: PANEL });
    const receiptPath = path.join(dir, 'plan.receipt.json');
    const saved = readFileSync(receiptPath, 'utf8');
    expect(JSON.parse(saved).items['env:blog'].state).toBe('done');
    expect(saved).not.toContain(SENTINEL);
    expect(existsSync(`${receiptPath}.tmp`)).toBe(false);
    expect(logs.join('\n')).toMatch(/Done\. Receipt: .*plan\.receipt\.json/);
    expect(logs.join('\n')).not.toContain(SENTINEL);
    expect(process.exitCode).toBeUndefined();

    calls.length = 0;
    logs.length = 0;
    await importApplyAction(planPath, {}, { client, panel: PANEL });
    expect(logs.join('\n')).toMatch(/✓ blog: already created \(#100\)/);
    expect(logs.join('\n')).toMatch(/✓ pg: already created \(#102\)/);
    await importApplyAction(planPath, { yes: true, dotenv: [`blog=${envPath}`] }, { client, panel: PANEL });
    expect(calls).toEqual([]);
  });

  it('reports failed items and bad arguments with a non-zero exit code', async () => {
    const { dir, planPath, logs } = await setup();
    const { client } = fakePanel();
    client.databases.create = vi.fn(async () => { throw new Error('A database with that name already exists'); });
    await importApplyAction(planPath, { yes: true, receipt: path.join(dir, 'r.json') }, { client, panel: PANEL });
    expect(process.exitCode).toBe(1);
    expect(logs.join('\n')).toMatch(/✗ database pg: failed\n\s+A database with that name already exists/);
    expect(logs.join('\n')).toMatch(/1 item\(s\) failed\. Fix the cause and run the same command again/);

    for (const [opts, re] of [
      [{ project: 'x' }, /--project takes a project id, got "x"/],
      [{ project: '0' }, /--project takes a project id/],
      [{ dotenv: ['blog'] }, /--dotenv takes <service>=<path>, got "blog"/],
      [{ dotenv: ['blog='] }, /--dotenv takes <service>=<path>/],
    ] as const) {
      process.exitCode = undefined;
      logs.length = 0;
      await importApplyAction(planPath, { yes: true, ...opts } as never, { client, panel: PANEL });
      expect(logs.join('\n')).toMatch(re);
      expect(process.exitCode).toBe(1);
    }
    process.exitCode = undefined;
    writeFileSync(path.join(dir, 'bad.json'), '{"planVersion":0}');
    await importApplyAction(path.join(dir, 'bad.json'), {}, { client, panel: PANEL });
    expect(process.exitCode).toBe(1);
  });

  it('renders every receipt state', () => {
    const r: ImportReceipt = {
      receiptVersion: 1, panel: PANEL, source: { kind: 'caprover', url: 'u' },
      items: {
        'service:a': { kind: 'service', ref: 'a', name: 'a', state: 'pending', at: 't', notes: [] },
        'env:a': { kind: 'env', ref: 'a', name: 'a', state: 'skipped', id: 4, at: 't', notes: ['n'] },
      },
    };
    expect(renderReceipt(r)).toBe('  … service a: pending\n  – env of a: skipped\n      n');
    expect(renderApplyPreview({ planVersion: 1, source: { kind: 'caprover', url: 'u', version: null, scope: '' }, generatedAt: '', services: [], databases: [{ ref: 'x', name: 'x', engine: null, image: null, issues: [] }], notes: [] }, null, {}))
      .toBe('Services (created, not deployed):\nDatabases (created empty):\n  – x: skipped, no managed equivalent');
  });
});

describe('import apply: connection strings that name the source', () => {
  const SECRET = 'SENTINEL-attach';
  const env = `DB_PASSWORD=${SECRET}\nurl=http://blog.example\nDATABASE_URL=postgres://ghost:${SECRET}@srv-captain--pg:5432/ghost\nDB_HOST=pg\n`;

  it('attaches the new database under the variable, says what needs a person, and never stores a value', async () => {
    const plan = await livePlan();
    const { client, calls } = fakePanel();
    const s = store();
    const receipt = await applyPlan(plan, { envFiles: { blog: env } }, { client, panel: PANEL, receipt: null, save: s.save });
    const pgId = receipt.items['database:pg']!.id!;
    const blogId = receipt.items['service:blog']!.id!;
    expect(calls.filter((c) => c.op === 'attach').map((c) => c.input)).toEqual([{ serviceId: blogId, databaseId: pgId, envAlias: 'DATABASE_URL', reuseExisting: true }]);
    expect(receipt.items['attach:blog:DATABASE_URL']).toMatchObject({ kind: 'attach', state: 'done', id: 500 });
    expect(receipt.items['attach:blog:DATABASE_URL']!.notes[0]).toMatch(/Attached pg as DATABASE_URL \(the copied value named srv-captain--pg\)\. The service's own DATABASE_URL still shows the old value/);
    expect(receipt.items['attach:blog:DB_HOST']).toMatchObject({ state: 'skipped', notes: [expect.stringMatching(/^DB_HOST names the source's database pg \(pg\): it holds the source database's host/)] });
    // pending before the call, done after it
    expect(s.snapshots.map((r) => r.items['attach:blog:DATABASE_URL']?.state).filter(Boolean)).toEqual(['pending', 'done', 'done']);
    expect(JSON.stringify(s.snapshots)).not.toContain(SECRET);
    expect(renderApplyPreview(plan, null, { blog: env })).toContain('  + DATABASE_URL of blog: attach pg under DATABASE_URL (the copied value names srv-captain--pg)');
    expect(renderApplyPreview(plan, null, { blog: env })).not.toContain(SECRET);

    // A rerun attaches nothing twice; an attachment made by hand counts.
    const again = await applyPlan(plan, { envFiles: { blog: env } }, { client, panel: PANEL, receipt: structuredClone(receipt), save: () => undefined });
    expect(calls.filter((c) => c.op === 'attach')).toHaveLength(1);
    const lost = structuredClone(again);
    delete lost.items['attach:blog:DATABASE_URL'];
    const healed = await applyPlan(plan, { envFiles: { blog: env } }, { client, panel: PANEL, receipt: lost, save: () => undefined });
    expect(calls.filter((c) => c.op === 'attach')).toHaveLength(1);
    expect(healed.items['attach:blog:DATABASE_URL']).toMatchObject({ state: 'done', id: 500 });
  });

  it('refuses a variable another database already sets, waits for a database not created, and records panel errors', async () => {
    const plan = await livePlan();
    let { client, attached } = fakePanel();
    const first = await applyPlan(plan, {}, { client, panel: PANEL, receipt: null, save: () => undefined });
    attached.push({ id: 9, serviceId: first.items['service:blog']!.id!, databaseId: 4242, envAlias: 'DATABASE_URL' });
    let r = await applyPlan(plan, { envFiles: { blog: env } }, { client, panel: PANEL, receipt: structuredClone(first), save: () => undefined });
    expect(r.items['attach:blog:DATABASE_URL']).toMatchObject({ state: 'failed', notes: [expect.stringMatching(/already set by another attached database \(#4242\)/)] });

    ({ client } = fakePanel());
    client.databases.create = vi.fn(async () => { throw new Error('no room'); });
    r = await applyPlan(plan, { envFiles: { blog: env } }, { client, panel: PANEL, receipt: null, save: () => undefined });
    expect(r.items['attach:blog:DATABASE_URL']).toMatchObject({ state: 'skipped', notes: [expect.stringMatching(/not created here yet/)] });

    ({ client } = fakePanel());
    client.attachments.list = vi.fn(async () => { throw new Error('list down'); });
    r = await applyPlan(plan, { envFiles: { blog: env } }, { client, panel: PANEL, receipt: null, save: () => undefined });
    expect(r.items['attach:blog:DATABASE_URL']).toMatchObject({ state: 'failed', notes: ['list down'] });

    ({ client } = fakePanel());
    client.attachments.create = vi.fn(async () => { throw new Error('attach down'); });
    r = await applyPlan(plan, { envFiles: { blog: env } }, { client, panel: PANEL, receipt: null, save: () => undefined });
    expect(r.items['attach:blog:DATABASE_URL']).toMatchObject({ state: 'failed', notes: ['attach down'] });
  });
});
