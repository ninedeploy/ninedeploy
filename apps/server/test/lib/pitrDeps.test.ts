/**
 * R3: lib/pitr.ts `pitrDeps` — the production wiring delegates each step to
 * the engine function it names (wrappers, so module mocks apply).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@ninedeploy/db';

const { engine, record } = vi.hoisted(() => {
  const engine = { calls: [] as string[] };
  const record = (name: string, value: unknown = undefined) => vi.fn(async (...args: unknown[]) => {
    engine.calls.push(`${name}(${args.filter((a) => typeof a !== 'function').map((a) => (typeof a === 'object' && a && 'slug' in a ? (a as { slug: string }).slug : String(a))).join(',')})`);
    return value;
  });
  return { engine, record };
});

vi.mock('../../src/engine/database.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/engine/database.js')>('../../src/engine/database.js');
  return {
    ...actual,
    startDatabase: record('startDatabase'),
    stopDatabase: record('stopDatabase'),
    probeDatabaseCredentials: record('probeDatabaseCredentials', true),
    volumeExists: record('volumeExists', true),
    removeVolume: record('removeVolume'),
  };
});
vi.mock('../../src/engine/postgresPitr.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/engine/postgresPitr.js')>('../../src/engine/postgresPitr.js');
  return {
    ...actual,
    pitrPreflight: record('pitrPreflight', null),
    removePitrArchive: record('removePitrArchive'),
    takePitrBaseBackup: record('takePitrBaseBackup', 'nd-x'),
    prunePitrArchive: record('prunePitrArchive', { removedBases: [] }),
    readPitrInventory: record('readPitrInventory', { segments: [] }),
    pitrArchiverStats: record('pitrArchiverStats', null),
    recoverPostgresToPoint: record('recoverPostgresToPoint', { baseBackup: 'b', recoveredTo: 't', restoreMs: 1 }),
  };
});

import { pitrDeps } from '../../src/lib/pitr.js';

describe('pitrDeps', () => {
  it('calls the engine functions', async () => {
    const d = { slug: 'main', volumeName: 'nd-db-main-data' } as Database;
    const t = { slug: 'copy' } as Database;
    const log = () => undefined;
    await pitrDeps.start(d, log);
    await pitrDeps.stop(d, log);
    expect(await pitrDeps.probe(d)).toBe(true);
    expect(await pitrDeps.preflight(d)).toBeNull();
    expect(await pitrDeps.archiveExists(d)).toBe(true);
    expect(await pitrDeps.archiveExists({ slug: 'x', volumeName: null } as Database)).toBe(false);
    await pitrDeps.removeArchive(d, log);
    expect(await pitrDeps.volumeExists('v')).toBe(true);
    await pitrDeps.removeVolume('v', log);
    expect(await pitrDeps.baseBackup(d, log)).toBe('nd-x');
    await pitrDeps.prune(d, 7, log);
    await pitrDeps.inventory(d);
    await pitrDeps.archiver(d);
    await pitrDeps.recover(d, t, null, log);
    expect(engine.calls).toEqual([
      'startDatabase(main)', 'stopDatabase(main)', 'probeDatabaseCredentials(main,45,2000)', 'pitrPreflight(main)',
      'volumeExists(nd-db-main-data-wal)', 'removePitrArchive(main)', 'volumeExists(v)', 'removeVolume(v)',
      'takePitrBaseBackup(main)', 'prunePitrArchive(main,7)', 'readPitrInventory(main)', 'pitrArchiverStats(main)',
      'recoverPostgresToPoint(main,copy,null)',
    ]);
  });
});
