/** Real PostgreSQL stream/rollover/retention fixture for smoke-pitr-remote --continuous. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pitrStreamStorage } from '../../apps/server/dist/lib/pitrStreamIO.js';
import { safeStreamRoot } from '../../apps/server/dist/lib/pitrStreamCatalog.js';
import { s3Request } from '../../apps/server/dist/lib/s3.js';

export async function produceStream({ db, source, actor, sql, pitr, remote, log, started, sleep, backupDestinations, encrypt }) {
  await mkdir('/tmp/catalog-check', { mode: 0o700 });
  const dest = (await db.insert(backupDestinations).values({ name: 'Remote stream fixture', endpoint: 'https://pitr-store:9443', region: 'us-east-1', bucket: 'archive', prefix: 'proof', accessKeyId: 'fixture', secretKeyEncrypted: encrypt('fixture-secret') }).returning())[0];
  const settings = { enabled: true, destinationId: dest.id, intervalMinutes: 15, mode: 'continuous', remoteRetentionDays: 1 };
  const passphrase = 'off-host-n04-recovery-passphrase';
  await remote.configureRemotePitr(db, source, { ...settings, passphrase }, actor);
  const archiveId = (await remote.remotePitrStatus(db, source.id)).settings.archiveId;
  const cfg = { endpoint: dest.endpoint, region: dest.region, bucket: dest.bucket, accessKeyId: 'fixture', secretAccessKey: 'fixture-secret' };
  const root = safeStreamRoot('proof', archiveId), storage = pitrStreamStorage(cfg, root, archiveId, passphrase, '/tmp/catalog-check');
  const read = async () => (await storage.load()).catalog;
  const sync = (clock) => remote.runRemotePitrCheckpoint(db, source, log, undefined, undefined, clock ? () => clock : undefined);
  const closed = async () => {
    const before = (await pitr.readPitrInventory(source)).segments.at(-1)?.name;
    await sql('SELECT pg_switch_wal()');
    for (let i = 0; ; i++) {
      const inv = await pitr.readPitrInventory(source);
      if (inv.segments.at(-1)?.name !== before) return;
      if (i >= 90) throw new Error('WAL did not close and archive');
      await sleep(500);
    }
  };
  await sql("INSERT INTO proof VALUES ('two')"); await closed(); await sync();
  const anchor = (await read()).generations[0].anchor.key;
  await sql("INSERT INTO proof VALUES ('three')"); await closed(); await sync();
  let catalog = await read();
  assert.equal(catalog.generations[0].anchor.key, anchor);
  assert.ok(catalog.generations[0].wal.length > 0, 'new closed WAL shipped without replacing the anchor');
  await pitr.takePitrBaseBackup(source, log);
  await sql("INSERT INTO proof VALUES ('four')"); await sleep(2200);
  const point = new Date((await sql('SELECT clock_timestamp()')).trim()).toISOString();
  await sleep(1200); await sql("INSERT INTO proof VALUES ('five')"); await closed(); await sync();
  catalog = await read(); assert.equal(catalog.generations.length, 2);
  await pitr.takePitrBaseBackup(source, log);
  await sql("INSERT INTO proof VALUES ('six')"); await closed(); await sync();
  catalog = await read(); assert.equal(catalog.generations.length, 3);
  await sql("INSERT INTO proof VALUES ('seven')"); await closed(); await sync();
  catalog = await read(); assert.ok(catalog.generations.at(-1).wal.length > 0);
  const expiredAnchorKey = catalog.generations[0].anchor.key;
  const cutoff = new Date(Date.parse(catalog.generations[1].manifest.base.finishedAt) + 86_400_000 + 1500);
  await sync(cutoff);
  assert.equal((await read()).generations.length, 2);
  assert.equal((await s3Request(cfg, 'HEAD', expiredAnchorKey)).status, 200, 'retirement grace protects concurrent readers');
  await remote.configureRemotePitr(db, source, { ...settings, remoteRetentionDays: 2 }, actor);
  let result = await sync(new Date(cutoff.getTime() + 2 * 60 * 60_000));
  catalog = await read(); assert.equal(catalog.generations.length, 2);
  assert.equal((await s3Request(cfg, 'HEAD', expiredAnchorKey)).status, 404);
  for (const g of catalog.generations) await storage.verifyReference(g.anchor);
  const head = await s3Request(cfg, 'HEAD', result.key), tag = head.headers.get('etag');
  const stale = await s3Request(cfg, 'PUT', result.key, 'must-never-publish', undefined, undefined, undefined, { ifMatch: '"stale-writer"' });
  assert.equal(stale.status, 412); assert.equal((await s3Request(cfg, 'HEAD', result.key)).headers.get('etag'), tag);
  const orphan = `${root}g/${randomUUID()}/anchor-${randomUUID()}.ndpc`, foreign = `${root}notes.txt`;
  await s3Request(cfg, 'PUT', orphan, 'abandoned upload'); await s3Request(cfg, 'PUT', foreign, 'retain foreign layout');
  await remote.configureRemotePitr(db, source, { ...settings, remoteRetentionDays: 2, collectOrphans: true }, actor);
  const orphanClock = new Date(cutoff.getTime() + 2 * 60 * 60_000);
  await sync(orphanClock);
  assert.ok((await read()).garbage.some(g => g.key === orphan));
  assert.equal((await s3Request(cfg, 'HEAD', orphan)).status, 200, 'newly committed orphan intent must wait for grace');
  result = await sync(new Date(orphanClock.getTime() + 60 * 60_000 + 1));
  assert.equal((await s3Request(cfg, 'HEAD', orphan)).status, 404);
  assert.equal((await s3Request(cfg, 'HEAD', foreign)).status, 200);
  catalog = await read(); assert.equal(catalog.garbage.some(g => g.key === orphan), false);
  for (const g of catalog.generations) await storage.verifyReference(g.anchor);
  const receipt = { ...result, point, selectedRows: 'four,one,three,two', checkpointRows: (await sql("SELECT string_agg(v, ',' ORDER BY v) FROM proof")).trim(), fixtureMs: Date.now() - started,
    archiveId, incremental: true, rollover: true, retention: true, staleWriterRefused: true, orphanCollection: true, expiredAnchorKey,
    latestWalKey: catalog.generations.at(-1).wal.at(-1).object.key, status: await remote.remotePitrStatus(db, source.id) };
  assert.equal(receipt.status.stream.status, 'completed');
  await writeFile('/tmp/receipt.json', JSON.stringify(receipt, null, 2));
  console.log('REMOTE_CONTINUOUS_VERIFIED');
}
