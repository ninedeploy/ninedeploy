import { describe, expect, it, vi } from 'vitest';
import { applyPlan, renderApplyPreview, type ApplyClient } from '../src/commands/importApply.js';
import { dumpCommand, renderDataPreview } from '../src/commands/importData.js';
import { buildImportPlan, renderImportPlan } from '../src/commands/importPlan.js';
import { findConnections, sourceHosts } from '../src/lib/importers/connections.js';
import { parseProcfile, planFromHeroku } from '../src/lib/importers/heroku.js';
import { sourceTarget } from '../src/lib/importers/shell.js';

const REPO = 'https://github.com/acme/shop.git';
const APP_JSON = JSON.stringify({
  name: 'Shop App',
  env: { SECRET_KEY_BASE: { generator: 'secret' }, WEB_CONCURRENCY: { value: '2' }, DATABASE_URL: { required: true } },
  addons: ['heroku-postgresql:essential-0', { plan: 'heroku-redis:mini' }, 'papertrail', 'heroku-postgresql:standard-0'],
  formation: { web: { quantity: 2, size: 'standard-1x' }, worker: { quantity: 0 }, clock: { quantity: 30 } },
  buildpacks: [{ url: 'heroku/ruby' }],
  scripts: { postdeploy: 'bin/rails db:seed' },
});
const PROCFILE = 'web: bundle exec puma -p $PORT\nrelease: bin/rails db:migrate\nworker: bundle exec sidekiq\n# a comment\nclock: bundle exec clockwork clock.rb\nweb: duplicate ignored\n';
const files = { appJson: APP_JSON, procfile: PROCFILE };
const opts = { repoUrl: REPO, branch: 'main', app: 'acme-shop', dirName: 'shop' };

describe('Procfile and app.json', () => {
  it('reads process types in order, once each', () => {
    expect(parseProcfile(PROCFILE).map((p) => p.type)).toEqual(['web', 'release', 'worker', 'clock']);
    expect(parseProcfile('web:   node index.js  \r\n')).toEqual([{ type: 'web', command: 'node index.js' }]);
  });

  it('maps each process to a Nixpacks service with its start command; release is left to a person', () => {
    const plan = planFromHeroku(files, opts);
    expect(plan.source).toMatchObject({ kind: 'heroku', url: REPO });
    expect(plan.services.map((s) => [s.ref, s.name])).toEqual([['web', 'shop-app'], ['worker', 'shop-app-worker'], ['clock', 'shop-app-clock']]);
    const [web, worker, clock] = plan.services;
    expect(web!.create).toEqual({
      name: 'shop-app', type: 'docker', repoUrl: REPO, branch: 'main', port: 5000, replicas: 2,
      build: { buildPack: 'nixpacks', startCmd: 'bundle exec puma -p $PORT' },
    });
    expect(web!.settings).toBeUndefined();
    expect(worker!.create.build).toEqual({ buildPack: 'nixpacks', startCmd: 'bundle exec sidekiq' });
    expect(worker!.create.port).toBeUndefined();
    expect(worker!.settings).toEqual({ healthCheck: 'running' });
    expect(clock!.create.replicas).toBe(10);
    expect(clock!.issues.map((i) => i.option)).toContain('formation');
    expect(worker!.issues.find((i) => i.option === 'formation')!.detail).toMatch(/Scaled to 0/);
    expect(web!.issues.map((i) => i.option)).toEqual(expect.arrayContaining(['PORT', 'release', 'size', 'buildpacks', 'postdeploy', 'addon', 'env']));
    expect(web!.domains).toEqual([]);
    expect(web!.issues.find((i) => i.option === 'release')).toMatchObject({ level: 'manual', detail: expect.stringMatching(/Nixpacks runs the Procfile's release line \("bin\/rails db:migrate"\) as a build step of every service/) });
    expect(planFromHeroku({ procfile: 'web: echo "port: $PORT"' }, opts).services[0]!.issues.find((i) => i.option === 'Procfile')!.detail).toMatch(/reads the Procfile as YAML/);
  });

  it('turns the Postgres and Redis add-ons into attached databases, once each, and lists the rest', () => {
    const plan = planFromHeroku(files, opts);
    expect(plan.databases.map((d) => [d.ref, d.engine, d.runtime])).toEqual([
      ['shop-app-postgres', 'postgres', { kind: 'heroku-app', name: 'acme-shop' }],
      ['shop-app-redis', 'redis', { kind: 'heroku-app', name: 'acme-shop' }],
    ]);
    for (const s of plan.services) expect(s.attachments).toEqual([{ database: 'shop-app-postgres', envAlias: 'DATABASE_URL' }, { database: 'shop-app-redis', envAlias: 'REDIS_URL' }]);
    expect(plan.services[0]!.env.map((e) => e.key)).toEqual(['SECRET_KEY_BASE', 'WEB_CONCURRENCY']);
    expect(plan.services[0]!.issues.find((i) => i.option === 'addon')!.detail).toMatch(/papertrail has no NineDeploy equivalent/);
    expect(plan.databases[0]!.issues.map((i) => i.option)).toEqual(['data', 'ssl']);
  });

  it('works with only a Procfile, or only app.json, and refuses neither', () => {
    const bare = planFromHeroku({ procfile: 'web: node index.js' }, { ...opts, app: undefined });
    expect(bare.services.map((s) => s.name)).toEqual(['shop']);
    expect(bare.databases).toEqual([]);
    const onlyJson = planFromHeroku({ appJson: JSON.stringify({ addons: ['heroku-postgresql'] }) }, { ...opts, app: 'bad name;rm' });
    expect(onlyJson.services[0]!.create.build).toEqual({ buildPack: 'nixpacks' });
    expect(onlyJson.services[0]!.issues.map((i) => i.option)).toEqual(expect.arrayContaining(['app', 'Procfile']));
    expect(onlyJson.databases[0]!.runtime).toBeUndefined();
    expect(planFromHeroku({ procfile: 'web: x', herokuYml: true }, opts).services[0]!.issues.map((i) => i.option)).toContain('heroku.yml');
    expect(() => planFromHeroku({}, opts)).toThrow(/Neither app.json nor a Procfile/);
    expect(() => planFromHeroku({ appJson: '{' }, opts)).toThrow(/not valid JSON/);
  });

  it('is reached through import plan heroku without any credential, reading the checkout', async () => {
    const read = vi.fn((f: string) => (f.endsWith('app.json') ? APP_JSON : f.endsWith('Procfile') ? PROCFILE : undefined));
    const plan = await buildImportPlan('heroku', ` ${REPO} `, { env: {}, ask: async () => { throw new Error('no prompt'); }, readFile: read, heroku: { dir: '/src/shop', branch: 'prod', app: 'acme-shop' } });
    expect(plan.services[0]!.create).toMatchObject({ repoUrl: REPO, branch: 'prod' });
    expect(read).toHaveBeenCalledTimes(3);
    await expect(buildImportPlan('heroku', REPO, { readFile: () => undefined })).rejects.toThrow(/Neither app.json nor a Procfile/);
    const text = renderImportPlan(plan);
    expect(text).toContain('      start: bundle exec puma -p $PORT');
    expect(text).toContain('      health check: running');
    expect(text).toContain('      attaches: shop-app-postgres as DATABASE_URL, shop-app-redis as REDIS_URL');
  });
});

describe('Heroku in apply and data', () => {
  it('sets the worker health check right after create, and attaches the add-ons to every service', async () => {
    const plan = planFromHeroku(files, opts);
    let next = 10;
    const attached: Array<{ id: number; serviceId: number; databaseId: number; envAlias: string }> = [];
    const client: ApplyClient = {
      services: { create: vi.fn(async () => ({ id: next++ })), update: vi.fn(async () => ({})) },
      databases: { create: vi.fn(async () => ({ id: next++ })) },
      env: { import: vi.fn(async () => ({ imported: 0, skipped: 0, errors: [] })) },
      attachments: {
        list: vi.fn(async (sid: number) => attached.filter((a) => a.serviceId === sid)),
        create: vi.fn(async (sid: number, i) => { const a = { id: 900 + attached.length, serviceId: sid, databaseId: i.databaseId, envAlias: i.envAlias! }; attached.push(a); return a; }),
      },
    };
    // The .env from `heroku config --shell` names Heroku's own hosts: nothing to add, and no "old platform" warning for github.com.
    const env = `DATABASE_URL='postgres://u:p@ec2-1-2-3-4.compute-1.amazonaws.com:5432/d'\nGITHUB=github.com\n`;
    const r = await applyPlan(plan, { envFiles: { 'shop-app': env } }, { client, panel: 'https://p', receipt: null, save: () => undefined });
    expect(client.services.update).toHaveBeenCalledTimes(2);
    expect(client.services.update).toHaveBeenCalledWith(r.items['service:worker']!.id, { healthCheck: 'running' });
    expect(r.items['service:worker']!.notes).toContain('Health check: running (the process answers no HTTP).');
    expect(attached.map((a) => a.envAlias).sort()).toEqual(['DATABASE_URL', 'DATABASE_URL', 'DATABASE_URL', 'REDIS_URL', 'REDIS_URL', 'REDIS_URL']);
    expect(r.items['attach:web:DATABASE_URL']).toMatchObject({ state: 'done', notes: ['Attached shop-app-postgres as DATABASE_URL, as Heroku sets it for the add-on. It is set at every deploy.'] });
    expect(Object.keys(r.items).filter((k) => k.startsWith('attach:web:'))).toEqual(['attach:web:DATABASE_URL', 'attach:web:REDIS_URL']);
    const preview = renderApplyPreview(plan, null, { 'shop-app': env });
    expect(preview).toContain('Attachments (add-ons):\n  + DATABASE_URL of shop-app: attach shop-app-postgres');
    expect(preview).not.toContain('Connection strings that name the source');
  });

  it('a failed health-check update fails the service, and a rerun sets it again', async () => {
    const plan = planFromHeroku({ procfile: 'web: a\nworker: b' }, opts);
    const update = vi.fn().mockRejectedValueOnce(new Error('nope')).mockResolvedValue({});
    const client = {
      services: { create: vi.fn(async () => ({ id: 5 })), update }, databases: { create: vi.fn() }, env: { import: vi.fn() }, attachments: { list: vi.fn(), create: vi.fn() },
    } as unknown as ApplyClient;
    const r = await applyPlan(plan, {}, { client, panel: 'https://p', receipt: null, save: () => undefined });
    expect(r.items['service:worker']).toMatchObject({ state: 'failed', notes: ['nope'] });
    const again = await applyPlan(plan, {}, { client, panel: 'https://p', receipt: r, save: () => undefined });
    expect(again.items['service:worker']!.state).toBe('done');
  });

  it('prints the pg:backups command for Heroku Postgres, and says what to do otherwise', () => {
    const plan = planFromHeroku(files, opts);
    expect(dumpCommand(plan.databases[0]!)).toEqual({
      command: 'heroku pg:backups:capture -a acme-shop && curl -sSfo shop-app-postgres.dump "$(heroku pg:backups:url -a acme-shop)"',
      file: 'shop-app-postgres.dump', notes: [],
    });
    expect(dumpCommand({ ...plan.databases[0]!, runtime: { kind: 'heroku-app', name: 'a b' } })!.command).toContain('-a <app>');
    expect(dumpCommand(plan.databases[1]!)).toBeNull();
    const receipt = { receiptVersion: 1 as const, panel: 'p', source: { kind: 'heroku', url: REPO }, items: Object.fromEntries(plan.databases.map((d, i) => [`database:${d.ref}`, { kind: 'database' as const, ref: d.ref, name: d.name, state: 'done' as const, id: i + 1, at: 't', notes: [] }])) };
    let text = renderDataPreview(plan, receipt);
    expect(text).toContain('heroku pg:backups:capture -a acme-shop');
    expect(text).toContain('  – shop-app-redis: Heroku has no export command for it; move its keys by hand');
    expect(text).toContain('The Heroku commands follow the Heroku CLI documentation and have not been run against Heroku.');
    const noApp = planFromHeroku(files, { ...opts, app: undefined });
    text = renderDataPreview(noApp, receipt);
    expect(text).toContain('  – shop-app-postgres: pass --app <heroku app> to import plan for the pg:backups command, or download a backup from Heroku');
    expect(text).not.toContain('docker exec');
  });

  it('never treats the Heroku app name as a host, or as a container', () => {
    const plan = planFromHeroku(files, opts);
    expect(sourceHosts('heroku', plan.databases[0]!)).toEqual([]);
    expect(findConnections(plan, 'X=acme-shop\nY=postgres://u:p@acme-shop:5432/d')).toEqual([]);
    expect(sourceTarget({ kind: 'heroku-app', name: 'acme-shop' }, 'the db')).toEqual({ target: '<container>', note: expect.stringMatching(/Heroku runs it/) });
  });
});
