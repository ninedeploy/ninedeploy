import fs from 'node:fs';const dir='.temp_files/audit_continuous_20261109/';
const a='apps/server/test/lib/autoscaler.test.ts';fs.copyFileSync(a,dir+'F1108_lib_before.ts');let s=fs.readFileSync(a,'utf8').replaceAll('\r\n','\n');s=s.replace('import { afterEach, beforeEach,','import { afterAll, afterEach, beforeEach,');s=s.replace('let db: DB;','let db: DB;\nlet nativeHandle: ReturnType<typeof createDb> | undefined;\nconst ownedClients: Array<NonNullable<ReturnType<typeof createDb>[\'client\']>> = [];');s=s.replace("  ({ db } = createDb({ url: ':memory:' }));", "  nativeHandle = createDb({ url: ':memory:' });\n  ({ db } = nativeHandle);\n  if (nativeHandle.client) ownedClients.push(nativeHandle.client);\n  await nativeHandle.ready;");const old='afterEach(() => vi.useRealTimers());';if(!s.includes(old))throw Error('library cleanup anchor');s=s.replace(old,`afterEach(async () => {
  vi.useRealTimers();
  try { await nativeHandle?.ready; }
  finally { nativeHandle?.client?.close(); nativeHandle = undefined; }
});
afterAll(() => expect(ownedClients.filter(client => !client.closed).length).toBe(0));`);fs.writeFileSync(a,s);
const b='apps/server/test/plugins/autoscaler.test.ts';fs.copyFileSync(b,dir+'F1108_plugin_before.ts');s=fs.readFileSync(b,'utf8').replaceAll('\r\n','\n');s=s.replace("import Fastify from 'fastify';", "import Fastify, { type FastifyInstance } from 'fastify';").replace('import { afterEach,','import { afterAll, afterEach,');const marker='afterEach(() => {\n  vi.useRealTimers();\n  resetAutoscaleState();\n});';if(!s.includes(marker))throw Error('plugin cleanup anchor');s=s.replace(marker,`const fixtureApps = new Set<FastifyInstance>();
const fixtureHandles = new Set<ReturnType<typeof createDb>>();
const ownedClients: Array<NonNullable<ReturnType<typeof createDb>['client']>> = [];
afterEach(async () => {
  const closed = await Promise.allSettled([...fixtureApps].map(app => app.close()));
  fixtureApps.clear();
  try {
    for (const handle of fixtureHandles) {
      try { await handle.ready; }
      finally { handle.client?.close(); }
    }
  } finally {
    fixtureHandles.clear(); vi.useRealTimers(); resetAutoscaleState();
  }
  const failed = closed.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
});
afterAll(() => expect(ownedClients.filter(client => !client.closed).length).toBe(0));`);
s=s.replace("  const { db } = createDb({ url: ':memory:' });", "  const handle = createDb({ url: ':memory:' });\n  fixtureHandles.add(handle);\n  if (handle.client) ownedClients.push(handle.client);\n  await handle.ready;\n  const { db } = handle;");s=s.replace('  const app = Fastify();\n  app.decorate(\'db\', db);', "  const app = Fastify();\n  fixtureApps.add(app);\n  app.decorate('db', db);");fs.writeFileSync(b,s);
