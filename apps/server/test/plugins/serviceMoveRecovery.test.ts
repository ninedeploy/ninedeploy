/**
 * N07: a move of a service with its data that a panel restart interrupted is marked failed at boot
 * (plugins/serviceMoveRecovery.ts, lib/serviceMoveRecovery.ts), on a migrated SQLite.
 */
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { services, settings, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const { recoverInterruptedMoves } = await import('../../src/lib/serviceMoveRecovery.js');
const plugin = (await import('../../src/plugins/serviceMoveRecovery.js')).default;
const { audit } = await import('../../src/lib/audit.js');
const { getSettingJson, setSettingJson } = await import('../../src/lib/settings.js');
const { closeMigratedDb, migratedDb } = await import('../lib/githubAppKit.js');

let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  vi.mocked(audit).mockClear();
});
afterEach(() => closeMigratedDb(db));

/** What POST /v1/services/:id/move writes when a move starts, at the step named. */
const running = (step: 'copying' | 'deploying') => ({
  state: 'running', from: null, to: 3, step, error: null, startedAt: '2026-11-27T12:00:00.000Z', finishedAt: null, deploymentId: null,
  volumes: ['nd-svc-web-data'], copied: step === 'deploying' ? 1 : 0,
});

describe('recoverInterruptedMoves', () => {
  it('marks a move the previous process was copying as failed, says what to do, and changes nothing else', async () => {
    await db.insert(services).values({ id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', status: 'stopped' } as never);
    await setSettingJson(db, 'service_move:5', running('copying'));
    expect(await recoverInterruptedMoves(db)).toEqual([{ serviceId: 5, step: 'copying' }]);
    const after = await getSettingJson<Record<string, unknown>>(db, 'service_move:5', null);
    expect(after).toMatchObject({
      state: 'failed', step: 'copying', from: null, to: 3, startedAt: '2026-11-27T12:00:00.000Z', deploymentId: null,
      volumes: ['nd-svc-web-data'], copied: 0, finishedAt: expect.any(String),
    });
    expect(after?.error).toBe(
      'Interrupted by a panel restart: the data copied to node #3 may be incomplete, and nothing was deployed. The source volume on the panel host is untouched. Move the service back to the panel host with a plain host change, then start the move again.',
    );
    expect(vi.mocked(audit).mock.calls[0]?.slice(0, 4)).toEqual([db, null, 'service.move_with_data_interrupted', '1 move(s) with data interrupted by a panel restart']);
    // The service row is not the recovery's to change: it is as it was.
    const service = await db.query.services.findFirst({ where: eq(services.id, 5) });
    expect(service).toMatchObject({ name: 'web', serverId: null, status: 'stopped' });
  });

  it('says the data was copied whole when the restart came while deploying, and names both hosts', async () => {
    await setSettingJson(db, 'service_move:6', { ...running('deploying'), from: 2, to: null });
    expect(await recoverInterruptedMoves(db)).toEqual([{ serviceId: 6, step: 'deploying' }]);
    const after = await getSettingJson<Record<string, unknown>>(db, 'service_move:6', null);
    expect(after).toMatchObject({ state: 'failed', step: 'deploying', copied: 1, finishedAt: expect.any(String) });
    expect(after?.error).toBe(
      "Interrupted by a panel restart while deploying on the panel host: the data was copied whole. The panel's own recovery decided how that deployment ended; look at the Deploys tab and deploy again if it did not finish.",
    );
  });

  it('leaves the moves that are not running, and the rows it cannot read, as they are', async () => {
    const done = { ...running('deploying'), state: 'done', step: null, deploymentId: 41 };
    const failed = { ...running('copying'), state: 'failed', error: 'an earlier reason' };
    await setSettingJson(db, 'service_move:7', done);
    await setSettingJson(db, 'service_move:8', failed);
    await setSettingJson(db, 'service_move:not-an-id', running('copying'));
    await setSettingJson(db, 'service_move:9', 'not a move');
    await setSettingJson(db, 'service_move:11', 42);
    // A row of another feature whose key only begins the same way.
    await setSettingJson(db, 'service_moves:5', running('copying'));
    expect(await recoverInterruptedMoves(db)).toEqual([]);
    expect(await getSettingJson(db, 'service_move:7', null)).toEqual(done);
    expect(await getSettingJson(db, 'service_move:8', null)).toEqual(failed);
    expect(await getSettingJson(db, 'service_move:not-an-id', null)).toEqual(running('copying'));
    // A value that is not JSON (getSettingJson cannot read one back: it parses twice), read from the row.
    const raw = async (key: string) => (await db.query.settings.findFirst({ where: eq(settings.key, key) }))?.value;
    expect(await raw('service_move:9')).toBe('not a move');
    expect(await raw('service_move:11')).toBe(42);
    expect(await getSettingJson(db, 'service_moves:5', null)).toEqual(running('copying'));
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('the plugin at boot', () => {
  type Line = { level: number; msg?: string; serviceId?: number; step?: string; err?: { message?: string } };
  function boot(withDb: unknown) {
    const lines: Line[] = [];
    const app = Fastify({ logger: { level: 'info', stream: { write: (line: string) => { lines.push(JSON.parse(line)); } } } });
    app.decorate('db', withDb as never);
    return { app, lines };
  }

  it('marks the moves of the previous process once, warns for each, and never looks again', async () => {
    await setSettingJson(db, 'service_move:5', running('copying'));
    await setSettingJson(db, 'service_move:6', running('deploying'));
    const { app, lines } = boot(db);
    await app.register(plugin);
    await app.ready();
    expect(await getSettingJson(db, 'service_move:5', null)).toMatchObject({ state: 'failed', step: 'copying' });
    expect(await getSettingJson(db, 'service_move:6', null)).toMatchObject({ state: 'failed', step: 'deploying' });
    const warnings = lines.filter((line) => line.msg === 'a move with data was interrupted by a panel restart and is marked failed');
    expect(warnings.map((line) => [line.level, line.serviceId, line.step])).toEqual([[40, 5, 'copying'], [40, 6, 'deploying']]);
    // A move that starts after boot belongs to this process: it is left alone.
    await setSettingJson(db, 'service_move:7', running('copying'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await getSettingJson(db, 'service_move:7', null)).toMatchObject({ state: 'running' });
    await app.close();
  });

  it('does not hold up boot when the rows cannot be read', async () => {
    const { app, lines } = boot({ select: () => { throw new Error('database is locked'); } });
    await app.register(plugin);
    await app.ready();
    expect(lines.filter((line) => line.msg === 'the moves interrupted by a panel restart could not be marked failed').map((line) => [line.level, line.err?.message])).toEqual([[40, 'database is locked']]);
    await app.close();
  });
});
