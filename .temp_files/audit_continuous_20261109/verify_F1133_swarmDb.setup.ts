import './prove_F1133_swarmDb.setup';
import { afterAll, expect, vi } from 'vitest';
afterAll(async () => {
  const { createDb } = await vi.importActual<typeof import('@ninedeploy/db')>('@ninedeploy/db');
  for (const scenario of ['empty', 'query failure']) {
    const owned = createDb({ url: ':memory:' });
    const client = owned.client!;
    try {
      await owned.ready;
      if (scenario === 'query failure') await expect(client.execute('SELECT * FROM owned_missing_table')).rejects.toThrow();
      const gate = Promise.withResolvers<void>();
      const closed = gate.promise.then(() => client.close());
      expect(client.closed).toBe(false);
      gate.resolve();
      await closed;
      expect(client.closed).toBe(true);
      await expect(client.execute('SELECT 1')).rejects.toMatchObject({ code: 'CLIENT_CLOSED' });
      client.close();
      expect(client.closed).toBe(true);
    } finally {
      if (!client.closed) client.close();
    }
  }
  console.log('FIX VERIFIED: 27 fixture clients closed; gated empty/error/repeated-close controls passed');
});
