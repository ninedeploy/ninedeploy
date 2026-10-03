import { describe, expect, it, vi } from 'vitest';

const { execute } = vi.hoisted(() => ({
  execute: vi.fn().mockRejectedValue(new Error('pragma failed')),
}));

vi.mock('@libsql/client', () => ({
  createClient: () => ({ execute }),
}));

import { createDb } from '../src/client.js';

describe('createDb initialization', () => {
  it('exposes a failing PRAGMA so startup cannot race ahead unconfigured', async () => {
    const { client, ready } = createDb({ url: ':memory:' });
    expect(execute).toHaveBeenCalledWith('PRAGMA foreign_keys = ON;');
    expect(client).toBeDefined();
    await expect(ready).rejects.toThrow('pragma failed');
  });
});
