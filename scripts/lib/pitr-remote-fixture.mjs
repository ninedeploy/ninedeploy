/** Isolated acceptance fixture only; not a production S3 server or operator tool. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';

const mode = process.argv[2];
if (mode === 'store') {
  const store = new Map();
  const modified = new Map();
  const etag = (data) => `"${createHash('sha256').update(data).digest('hex')}"`;
  createServer({ key: await readFile('/tmp/key.pem'), cert: await readFile('/tmp/cert.pem') }, async (req, res) => {
    if (req.url === '/health') { res.end('ok'); return; }
    if (!req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ')) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url, 'https://pitr-store:9443');
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix'), cursor = url.searchParams.get('continuation-token');
      assert.equal(url.searchParams.get('encoding-type'), 'url'); assert.equal(url.searchParams.get('max-keys'), '200');
      const keys = [...store.keys()].map(k => decodeURIComponent(k.slice('/archive/'.length))).filter(k => k.startsWith(prefix)).sort();
      const start = Number(cursor ?? 0), page = keys.slice(start, start + 200), more = start + 200 < keys.length;
      const objects = page.map(k => { const path = `/archive/${k.split('/').map(encodeURIComponent).join('/')}`; return `<Contents><Key>${encodeURIComponent(k)}</Key><LastModified>${modified.get(path)}</LastModified><Size>${store.get(path).length}</Size></Contents>`; }).join('');
      res.setHeader('Content-Type', 'application/xml');
      res.end(`<ListBucketResult><Name>archive</Name><Prefix>${encodeURIComponent(prefix)}</Prefix><EncodingType>url</EncodingType><MaxKeys>200</MaxKeys><KeyCount>${page.length}</KeyCount><IsTruncated>${more}</IsTruncated>${cursor ? `<ContinuationToken>${cursor}</ContinuationToken>` : ''}${more ? `<NextContinuationToken>${start + 200}</NextContinuationToken>` : ''}${objects}</ListBucketResult>`); return;
    }
    if (req.method === 'PUT') {
      const chunks = []; let bytes = 0;
      for await (const b of req) { bytes += b.length; if (bytes > 64 * 1024 * 1024) { res.writeHead(413); res.end(); return; } chunks.push(b); }
      const data = Buffer.concat(chunks);
      if (createHash('sha256').update(data).digest('hex') !== req.headers['x-amz-content-sha256']) { res.writeHead(400); res.end(); return; }
      const current = store.get(req.url);
      if (req.headers['if-none-match'] === '*' && current || req.headers['if-match'] && (!current || etag(current) !== req.headers['if-match'])) { res.writeHead(412); res.end(); return; }
      store.set(req.url, data); modified.set(req.url, new Date().toISOString()); await writeFile('/tmp/latest-object', data); res.setHeader('ETag', etag(data)); res.end(); return;
    }
    if (req.method === 'DELETE') { store.delete(req.url); res.writeHead(204); res.end(); return; }
    const data = store.get(req.url);
    if (!data) { res.writeHead(404); res.end(); return; }
    res.setHeader('ETag', etag(data)); res.setHeader('Content-Length', data.length);
    if (req.method === 'HEAD') { res.end(); return; }
    if (req.url.endsWith('/corrupt.ndpc')) { res.end(Buffer.from('corrupt')); return; }
    res.end(data);
  }).listen(9443, '0.0.0.0');
} else if (mode === 'produce' || mode === 'stream-produce') {
  const { migrate } = createRequire('/app/apps/server/package.json')('drizzle-orm/libsql/migrator');
  const { createDb, databases, users, backupDestinations } = await import('../../packages/db/dist/index.js');
  const { encrypt } = await import('../../apps/server/dist/lib/crypto.js');
  const { capture, run, sleep } = await import('../../apps/server/dist/lib/exec.js');
  const { ensurePitrArchive, pitrServerArgs } = await import('../../apps/server/dist/engine/pitrArchive.js');
  const { volumeExists } = await import('../../apps/server/dist/engine/database.js');
  const pitr = await import('../../apps/server/dist/engine/postgresPitr.js');
  const remote = await import('../../apps/server/dist/lib/pitrRemote.js');
  const log = (l) => console.log(l);
  const docker = (a) => capture('docker', a, { timeoutMs: 180_000 });
  const { db, client } = createDb({ url: 'file:/tmp/source-panel.db' });
  const started = Date.now();
  try {
    await migrate(db, { migrationsFolder: '/app/packages/db/src/migrations' });
    const actor = (await db.insert(users).values({ email: 'proof@example.test', passwordHash: 'x', isInstanceOperator: true }).returning())[0].id;
    const source = (await db.insert(databases).values({ name: 'source', slug: 'source', engine: 'postgres', status: 'running', pitrEnabled: true, version: '18', containerName: 'nd-db-source', volumeName: 'nd-db-source-data', username: 'nine', dbName: 'app', passwordEncrypted: encrypt('source-only-password'), ownerUserId: actor }).returning())[0];
    await ensurePitrArchive(source, 'postgres:18', log, volumeExists);
    await run('docker', ['run', '-d', '--name', source.containerName, '-e', 'POSTGRES_USER=nine', '-e', 'POSTGRES_PASSWORD=source-only-password', '-e', 'POSTGRES_DB=app', '-v', `${source.volumeName}:/var/lib/postgresql`, '-v', `${source.volumeName}-wal:/nd-wal-archive`, 'postgres:18', ...pitrServerArgs()], {}, log);
    for (let i = 0; ; i++) {
      try { await docker(['exec', '-u', 'postgres', '-e', 'PGPASSWORD=source-only-password', source.containerName, 'psql', '-h', '127.0.0.1', '-U', 'nine', '-d', 'app', '-X', '-Atqc', 'SELECT 1']); break; }
      catch { if (i >= 90) throw new Error('source did not start'); await sleep(500); }
    }
    const sql = (s) => docker(['exec', '-u', 'postgres', source.containerName, 'psql', '-U', 'nine', '-d', 'app', '-X', '-Atqc', s]);
    await sql("CREATE TABLE proof(v text); INSERT INTO proof VALUES ('one')");
    await pitr.takePitrBaseBackup(source, log);
    if (mode === 'stream-produce') {
      const { produceStream } = await import('./pitr-stream-produce.mjs');
      await produceStream({ db, source, actor, sql, docker, pitr, remote, log, started, sleep, backupDestinations, encrypt });
    } else {
    await sql("INSERT INTO proof VALUES ('two')"); await sleep(1200);
    const point = new Date((await sql('SELECT clock_timestamp()')).trim()).toISOString();
    await sleep(1200); await sql("INSERT INTO proof VALUES ('three'), ('four')"); await sql('SELECT pg_switch_wal()');
    let inv;
    for (let i = 0; ; i++) {
      inv = await pitr.readPitrInventory(source);
      if (inv.baseBackups.length && inv.segments.at(-1)?.archivedAt.getTime() > Date.parse(point)) break;
      if (i >= 90) throw new Error('WAL did not archive'); await sleep(500);
    }
    const dest = (await db.insert(backupDestinations).values({ name: 'Remote fixture', endpoint: 'https://pitr-store:9443', region: 'us-east-1', bucket: 'archive', prefix: 'proof', accessKeyId: 'fixture', secretKeyEncrypted: encrypt('fixture-secret') }).returning())[0];
    await remote.configureRemotePitr(db, source, { enabled: true, destinationId: dest.id, intervalMinutes: 15, passphrase: 'off-host-n04-recovery-passphrase' }, actor);
    const checkpointStarted = Date.now();
    const result = await remote.runRemotePitrCheckpoint(db, source, log);
    const receipt = { ...result, point, checkpointRows: (await sql("SELECT string_agg(v, ',' ORDER BY v) FROM proof")).trim(), checkpointMs: Date.now() - checkpointStarted, fixtureMs: Date.now() - started, status: await remote.remotePitrStatus(db, source.id) };
    assert.equal(receipt.status.state.status, 'completed');
    await docker(['exec', '-u', 'postgres', source.containerName, 'rm', `/nd-wal-archive/wal/${inv.baseBackups.at(-1).startSegment}.gz`]);
    await assert.rejects(remote.runRemotePitrCheckpoint(db, source, log), /archive|WAL|segment/i);
    assert.equal((await remote.remotePitrStatus(db, source.id)).state.lastSuccess.key, result.key);
    receipt.missingSourceWalRefused = true;
    await docker(['exec', '-u', '0', source.containerName, 'install', '-d', '-o', 'postgres', '-g', 'postgres', '/tmp/extra-space']);
    await sql("CREATE TABLESPACE remote_extra LOCATION '/tmp/extra-space'");
    await sql("CREATE TABLE extra_proof(v text) TABLESPACE remote_extra; INSERT INTO extra_proof VALUES ('must-not-be-omitted')");
    await pitr.takePitrBaseBackup(source, log);
    await assert.rejects(remote.runRemotePitrCheckpoint(db, source, log), /tablespace/i);
    assert.equal((await remote.remotePitrStatus(db, source.id)).state.lastSuccess.key, result.key);
    receipt.extraTablespaceRefused = true;
    receipt.postCheckpointFaultFixtureRows = 1;
    await writeFile('/tmp/receipt.json', JSON.stringify(receipt, null, 2));
    console.log('REMOTE_CHECKPOINT_VERIFIED');
    }
  } finally { client.close(); }
} else if (mode === 'verify') {
  const { capture, run } = await import('../../apps/server/dist/lib/exec.js');
  const cfg = JSON.parse(await readFile('/tmp/recovery.json', 'utf8'));
  const outcome = JSON.parse(await readFile('/tmp/recovery-result.json', 'utf8'));
  await run('docker', ['run', '-d', '--name', 'nd-db-proof-recovered', '--network', 'none', '-v', `${cfg.volumeName}:/var/lib/postgresql`, `postgres:${outcome.version}`], {}, console.log);
  for (let i = 0; ; i++) {
    try { await capture('docker', ['exec', 'nd-db-proof-recovered', 'pg_isready', '-U', outcome.username], { timeoutMs: 5000 }); break; }
    catch { if (i >= 90) throw new Error('restored DB did not start'); await new Promise(r => setTimeout(r, 500)); }
  }
  const rows = (await capture('docker', ['exec', '-e', `PGPASSWORD=${cfg.newPassword}`, 'nd-db-proof-recovered', 'psql', '-h', '127.0.0.1', '-U', outcome.username, '-d', outcome.dbName, '-Atqc', "SELECT string_agg(v, ',' ORDER BY v) FROM proof"], { timeoutMs: 10000 })).trim();
  assert.equal(rows, cfg.expectedRows ?? 'one,two');
  console.log(JSON.stringify({ rows, newPasswordAccepted: true, outcome }));
} else throw new Error('Unknown fixture mode');
