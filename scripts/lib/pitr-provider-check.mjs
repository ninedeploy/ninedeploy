/** Bootstrap the private RustFS acceptance bucket through the actual signed HTTPS client. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { listPitrObjects } from '../../apps/server/dist/lib/pitrOrphans.js';
import { s3Delete, s3Request } from '../../apps/server/dist/lib/s3.js';

const cfg = { endpoint: 'https://pitr-store:9443', region: 'us-east-1', bucket: 'archive', accessKeyId: 'fixture', secretAccessKey: 'fixture-secret' };
let created;
for (let attempt = 0; attempt < 40; attempt++) {
  created = await s3Request(cfg, 'PUT', '', undefined, undefined, undefined, AbortSignal.timeout(1000)).catch(() => null);
  if (created && created.status !== 503) break;
  await created?.body?.cancel();
  await setTimeout(500);
}
assert.ok(created, 'RustFS did not accept a TLS connection with the fixture CA');
assert.ok(created.ok, `RustFS bucket creation returned HTTP ${created.status}: ${(await created.text()).slice(0, 400)}`);
const rejected = await s3Request({ ...cfg, secretAccessKey: 'incorrect-fixture-secret' }, 'HEAD', '');
assert.equal(rejected.status, 403, 'RustFS must enforce request authentication');

// Use a separate prefix and a deliberately escaped key to exercise the production
// listing parser across a real provider's opaque continuation token.
const prefix = `provider-check/${randomUUID()}/`;
const keys = Array.from({ length: 201 }, (_, i) => `${prefix}${String(i).padStart(3, '0')} &+.txt`);
async function batch(fn) {
  for (let i = 0; i < keys.length; i += 16) {
    const settled = await Promise.allSettled(keys.slice(i, i + 16).map(fn));
    const failure = settled.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}
let first, second;
try {
  await batch(async key => {
    const result = await s3Request(cfg, 'PUT', key, 'provider pagination check');
    await result.body?.cancel();
    assert.ok(result.ok, `RustFS pagination seed returned HTTP ${result.status}`);
  });
  first = await listPitrObjects(cfg, prefix);
  assert.equal(first.objects.length, 200);
  assert.ok(first.cursor);
  second = await listPitrObjects(cfg, prefix, first.cursor);
  assert.equal(second.objects.length, 1);
  assert.equal(second.cursor, null);
  assert.deepEqual([...first.objects, ...second.objects].map(object => object.key), keys);
} finally {
  await batch(key => s3Delete(cfg, key));
}
assert.deepEqual(await listPitrObjects(cfg, prefix), { objects: [], cursor: null });
console.log(JSON.stringify({ createBucketStatus: created.status, badSignatureStatus: rejected.status, listPageSizes: [first.objects.length, second.objects.length], paginationPrefixEmpty: true }));
