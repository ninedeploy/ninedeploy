import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { imageTransfers, servers, services, users, type DB } from '@ninedeploy/db';
import { shipImageByStream } from '../src/lib/imageTransfer.js';
import { closeMigratedDb, migratedDb } from './lib/githubAppKit.js';

const imageId = `sha256:${'a'.repeat(64)}`;
const checksum = 'b'.repeat(64);
const spec = { deploymentId: null, serviceId: 7, source: 1, target: 2, imageId, tag: 'ninedeploy/web:test' };
let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(users).values({ id: 1, email: 'operator@example.test', passwordHash: 'x' });
  await db.insert(servers).values([
    { id: 1, name: 'build', host: '10.0.0.1', port: 4600, tokenEncrypted: 'x' },
    { id: 2, name: 'target', host: '10.0.0.2', port: 4600, tokenEncrypted: 'x' },
  ]);
  await db.insert(services).values({ id: 7, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 1 } as never);
});
afterEach(() => closeMigratedDb(db));

function streams(options: { badChecksums?: number; wrongSource?: boolean; wrongTarget?: boolean; badBytes?: boolean } = {}) {
  const abort = vi.fn();
  let attempts = 0;
  const openStream = vi.fn(async (_db: unknown, _server: number, kind: string) => {
    if (kind === 'image.save') {
      attempts++;
      return { direction: 'agent-to-panel', readable: Readable.from([Buffer.from('image')]), abort,
        done: Promise.resolve({ bytes: 5, sha256: checksum, result: { imageId: options.wrongSource ? 'other-image' : imageId } }) };
    }
    return { direction: 'panel-to-agent', writable: new Writable({ write(_chunk, _encoding, callback) { callback(); } }), abort,
      done: Promise.resolve({ bytes: options.badBytes ? 6 : 5, sha256: attempts <= (options.badChecksums ?? 0) ? 'c'.repeat(64) : checksum,
        result: { imageId: options.wrongTarget ? 'other-image' : imageId } }) };
  });
  return { openStream, abort };
}

it('confirms source and target image identity and stream digest before recording success', async () => {
  const deps = streams();
  expect(await shipImageByStream(db, spec, () => undefined, deps as never)).toMatchObject({ method: 'stream', bytes: 5, sha256: checksum });
  expect(deps.openStream).toHaveBeenCalledTimes(2);
  expect(await db.select().from(imageTransfers)).toMatchObject([{ status: 'completed', bytes: 5, sha256: checksum }]);
});

it('retries a corrupt relay on fresh streams and records only the successful transfer', async () => {
  const deps = streams({ badChecksums: 1 });
  expect(await shipImageByStream(db, spec, () => undefined, deps as never)).toMatchObject({ sha256: checksum });
  expect(deps.openStream).toHaveBeenCalledTimes(4);
  expect(deps.abort).toHaveBeenCalledOnce();
  expect(await db.select().from(imageTransfers)).toMatchObject([{ status: 'completed' }]);
});

it('fails and records persistent digest mismatch without reporting a successful transfer', async () => {
  const deps = streams({ badChecksums: 2 });
  await expect(shipImageByStream(db, spec, () => undefined, deps as never)).rejects.toThrow('the relayed image changed in transit');
  expect(deps.openStream).toHaveBeenCalledTimes(4);
  expect(deps.abort).toHaveBeenCalledTimes(2);
  expect(await db.select().from(imageTransfers)).toMatchObject([{ status: 'failed', error: expect.stringContaining('changed in transit') }]);
});

it('rejects an image saved under a different identity on both attempts', async () => {
  const deps = streams({ wrongSource: true });
  await expect(shipImageByStream(db, spec, () => undefined, deps as never)).rejects.toThrow('saved image other-image');
  expect(deps.abort).toHaveBeenCalledTimes(2);
  expect(await db.select().from(imageTransfers)).toMatchObject([{ status: 'failed' }]);
});

it('rejects a target that reports a different loaded image', async () => {
  const deps = streams({ wrongTarget: true });
  await expect(shipImageByStream(db, spec, () => undefined, deps as never)).rejects.toThrow('loaded image other-image');
  expect(deps.abort).toHaveBeenCalledTimes(2);
  expect(await db.select().from(imageTransfers)).toMatchObject([{ status: 'failed' }]);
});

it('rejects a byte-count mismatch even when both digests match', async () => {
  const deps = streams({ badBytes: true });
  await expect(shipImageByStream(db, spec, () => undefined, deps as never)).rejects.toThrow('the relayed image changed in transit');
  expect(await db.select().from(imageTransfers)).toMatchObject([{ status: 'failed' }]);
});
