import { afterAll, expect, vi } from 'vitest';
const owned = vi.hoisted(() => ({ clients: [] as Array<{ closed: boolean; close(): void }> }));
vi.mock('@ninedeploy/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ninedeploy/db')>();
  return { ...actual, createDb: (...args: Parameters<typeof actual.createDb>) => {
    const result = actual.createDb(...args);
    if (result.client) owned.clients.push(result.client);
    return result;
  } };
});
afterAll(async () => {
  const { createDb } = await vi.importActual<typeof import('@ninedeploy/db')>('@ninedeploy/db');
  const control = createDb({ url: ':memory:' });
  try {
    await control.ready;
    control.client!.close();
    expect(control.client!.closed).toBe(true);
    const open = owned.clients.filter((client) => !client.closed).length;
    console.log(`CONTROL: explicitly closed native client closed=${control.client!.closed}`);
    console.log(`EXPECTED: zero fixture clients open after suite; ACTUAL: open=${open}, created=${owned.clients.length}`);
    console.log(open ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED');
    expect(owned.clients.length).toBe(27);
    expect(open).toBe(0);
  } finally {
    if (!control.client!.closed) control.client!.close();
    for (const client of owned.clients) if (!client.closed) client.close();
  }
});
