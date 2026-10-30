import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDb, eq, nodeProxyWriteHeads, runMigrations, servers } from '@ninedeploy/db';
import { bindNodeProxyWrite, checkpointNodeProxyWrite, reserveNodeProxyWrite } from '../../src/lib/nodeProxyAuthority.js';

let c: ReturnType<typeof createDb>;
beforeEach(async () => {
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
});
afterEach(() => c.client?.close());

it('requires explicit protocol adoption and gives each render a strictly newer owner', async () => {
  expect(await reserveNodeProxyWrite(c.db, 4)).toBeNull();
  const first = (await reserveNodeProxyWrite(c.db, 4, { adopt: true }))!;
  const second = (await reserveNodeProxyWrite(c.db, 4))!;
  expect(first.revision).toBe(1); expect(second.revision).toBe(2); expect(first.requestId).not.toBe(second.requestId);
  await expect(checkpointNodeProxyWrite(c.db, first)).rejects.toThrow(/superseded/);
  await expect(bindNodeProxyWrite(c.db, first, 'stale config')).rejects.toThrow(/superseded/);
  await expect(bindNodeProxyWrite(c.db, second, 'new config')).resolves.toMatchObject({ revision: 2 });
});
it('binds a revision to one exact payload and preserves the sequence across node removal', async () => {
  const first = (await reserveNodeProxyWrite(c.db, 4, { adopt: true }))!;
  const bound = await bindNodeProxyWrite(c.db, first, 'config');
  expect(await bindNodeProxyWrite(c.db, first, 'config')).toEqual(bound);
  await expect(bindNodeProxyWrite(c.db, first, 'different')).rejects.toThrow(/conflict/);
  await c.db.delete(servers).where(eq(servers.id, 4));
  expect((await c.db.select().from(nodeProxyWriteHeads))[0]?.revision).toBe(1);
  await c.db.insert(servers).values({ id: 4, name: 'Reconnected', host: 'node.test', tokenEncrypted: 'fixture' });
  expect((await reserveNodeProxyWrite(c.db, 4))?.revision).toBe(2);
});
it('holds an invalid or exhausted high-water mark instead of reusing a revision', async () => {
  await reserveNodeProxyWrite(c.db, 4, { adopt: true });
  await c.db.update(nodeProxyWriteHeads).set({ revision: Number.MAX_SAFE_INTEGER }).where(eq(nodeProxyWriteHeads.serverId, 4));
  await expect(reserveNodeProxyWrite(c.db, 4)).rejects.toThrow(/exhausted/);
  await c.db.update(nodeProxyWriteHeads).set({ revision: 1, requestId: 'invalid' }).where(eq(nodeProxyWriteHeads.serverId, 4));
  await expect(reserveNodeProxyWrite(c.db, 4)).rejects.toThrow(/invalid/);
});
