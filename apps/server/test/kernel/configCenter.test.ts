import { describe, expect, it, vi } from 'vitest';
import { ConfigCenter } from '../../src/kernel/configCenter.js';
import { createFakeDb } from '../helpers.js';

describe('ConfigCenter', () => {
  it('registers and lists configuration definitions', () => {
    const db = createFakeDb();
    const configCenter = new ConfigCenter(db);

    configCenter.registerDefinition({
      key: 'system.port',
      type: 'number',
      isSecret: false,
      label: 'System Port',
      category: 'system',
      defaultValue: 3000,
    });

    configCenter.registerDefinition({
      key: 'plugin:cf:token',
      pluginId: 'cf',
      type: 'string',
      isSecret: true,
      label: 'Token',
      category: 'plugin:cf',
    });

    expect(configCenter.getDefinition('system.port')?.defaultValue).toBe(3000);
    expect(configCenter.listDefinitions('system')).toHaveLength(1);
    expect(configCenter.listDefinitions(undefined, 'cf')).toHaveLength(1);
    expect(configCenter.listDefinitions('system', 'cf')).toHaveLength(0);
    expect(configCenter.listDefinitions('other')).toHaveLength(0);
    expect(configCenter.listDefinitions()).toHaveLength(2);
  });

  it('reads public and secret values from DB and returns defaults on miss', async () => {
    const store = new Map<string, any>();
    const findEntry = (args: any) => {
      const chunks = args?.where?.queryChunks;
      if (Array.isArray(chunks)) {
        for (const chunk of chunks) {
          if (chunk && typeof chunk === 'object' && 'value' in chunk && typeof chunk.value === 'string') {
            if (store.has(chunk.value)) return store.get(chunk.value);
          }
        }
      }
      for (const [k, v] of store.entries()) {
        if (args?.where?.value === k || args?.where?.right?.value === k) return v;
      }
      try {
        const str = JSON.stringify(args);
        for (const [k, v] of store.entries()) {
          if (str.includes(k)) return v;
        }
      } catch {}
      return undefined;
    };

    const fakeDb = createFakeDb({
      findFirst: {
        configEntries: ((args: any) => findEntry(args)) as any,
      },
      insert: {
        config_entries: ((val: any) => {
          store.set(val.key, val);
          return [val];
        }) as any,
        configEntries: ((val: any) => {
          store.set(val.key, val);
          return [val];
        }) as any,
      },
      delete: {
        config_entries: () => [],
        configEntries: () => [],
      },
    });

    const configCenter = new ConfigCenter(fakeDb);
    configCenter.registerDefinition({
      key: 'site.title',
      type: 'string',
      isSecret: false,
      label: 'Site Title',
      defaultValue: 'NineDeploy Default',
    });

    // 1. Returns definition default if not in DB
    expect(await configCenter.get('site.title')).toBe('NineDeploy Default');
    expect(await configCenter.get('unregistered.key', 'fallback')).toBe('fallback');
    expect(await configCenter.getSecret('missing.secret')).toBeNull();

    // 2. Set and get public string value
    const watcher = vi.fn();
    const unsub = configCenter.watch('site.title', watcher);

    await configCenter.set('site.title', 'Custom Title');
    expect(watcher).toHaveBeenCalledWith('Custom Title');
    expect(await configCenter.get('site.title')).toBe('Custom Title');

    // 3. Set and get JSON object value
    await configCenter.set('app.features', { beta: true, maxUsers: 10 });
    expect(await configCenter.get('app.features')).toEqual({ beta: true, maxUsers: 10 });

    // 4. Set and get Secret value
    await configCenter.set('smtp.password', 'super-secret', { isSecret: true });
    expect(await configCenter.getSecret('smtp.password')).toBe('super-secret');
    expect(await configCenter.get('smtp.password')).toBe('super-secret');

    // 5. Test non-cached public string (catch block of JSON.parse)
    store.set('raw.text', {
      key: 'raw.text',
      value: 'just-plain-string-not-json',
      isSecret: false,
    });
    expect(await configCenter.get('raw.text')).toBe('just-plain-string-not-json');

    // 6. Test non-cached public JSON
    store.set('raw.json', {
      key: 'raw.json',
      value: JSON.stringify({ count: 42 }),
      isSecret: false,
    });
    expect(await configCenter.get('raw.json')).toEqual({ count: 42 });

    // 7. Test getSecret on a public row (returns plain value)
    store.set('public.setting', {
      key: 'public.setting',
      value: 'public-val',
      isSecret: false,
    });
    expect(await configCenter.getSecret('public.setting')).toBe('public-val');

    // 8. Delete
    expect(await configCenter.delete('site.title')).toBe(true);

    unsub();
  });

  // r033 regression: set() stored non-secret strings RAW while get() re-parses
  // rows on a cache miss, so JSON-ambiguous strings ('true', '123', 'null')
  // came back type-flipped from a cold cache (process restart) while the warm
  // cache returned the exact string — the store's answer depended on cache
  // warmth, and the route's metadata-only update (re-read via get() → re-set)
  // laundered the corrupted type permanently. set() now encodes exactly the
  // strings that would parse as JSON; plain strings stay raw. The reader
  // below is a SECOND ConfigCenter over the same store: for it the cache is
  // cold, which models a restart (DB persists, cache does not).
  it('returns the exact stored string on a cold cache (r033 regression)', async () => {
    const store = new Map<string, any>();
    const findEntry = (args: any) => {
      const chunks = args?.where?.queryChunks;
      if (Array.isArray(chunks)) {
        for (const chunk of chunks) {
          if (chunk && typeof chunk === 'object' && 'value' in chunk && typeof chunk.value === 'string') {
            if (store.has(chunk.value)) return store.get(chunk.value);
          }
        }
      }
      return undefined;
    };
    const fakeDb = createFakeDb({
      findFirst: {
        configEntries: ((args: any) => findEntry(args)) as any,
      },
      insert: {
        config_entries: ((val: any) => {
          store.set(val.key, val);
          return [val];
        }) as any,
        configEntries: ((val: any) => {
          store.set(val.key, val);
          return [val];
        }) as any,
      },
      delete: {
        config_entries: () => [],
        configEntries: () => [],
      },
    });

    const writer = new ConfigCenter(fakeDb);
    const reader = new ConfigCenter(fakeDb); // cold cache = restart model

    for (const value of ['true', '123', 'null', '{}']) {
      await writer.set(`cold.${value}`, value);
      expect(await writer.get(`cold.${value}`)).toBe(value); // warm path
      expect(await reader.get(`cold.${value}`)).toBe(value); // cold path
    }
    // The stored 'null' string must not shadow the caller's defaultValue.
    expect(await reader.get('cold.null', 'fallback')).toBe('null');

    // Non-strings and plain strings keep their existing round-trip.
    await writer.set('cold.obj', { beta: true, maxUsers: 10 });
    expect(await reader.get('cold.obj')).toEqual({ beta: true, maxUsers: 10 });
    await writer.set('cold.plain', 'just-plain-string-not-json');
    expect(await reader.get('cold.plain')).toBe('just-plain-string-not-json');
  });

  it('handles watcher errors without crashing set()', async () => {
    const fakeDb = createFakeDb();
    const configCenter = new ConfigCenter(fakeDb);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const unsub = configCenter.watch('key1', () => {
      throw new Error('Watcher boom');
    });

    await expect(configCenter.set('key1', 'val1')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    unsub();
  });

  it('handles secret decryption failures gracefully', async () => {
    const fakeDb = createFakeDb({
      findFirst: {
        configEntries: {
          key: 'corrupt.secret',
          value: 'not-a-valid-envelope',
          isSecret: true,
        },
      },
    });

    const configCenter = new ConfigCenter(fakeDb);
    expect(await configCenter.getSecret('corrupt.secret')).toBeNull();
    expect(await configCenter.get('corrupt.secret', 'fallback')).toBe('fallback');
  });

  it('creates scoped plugin config instances with prefix isolation', async () => {
    const store = new Map<string, any>();
    const findEntry = (args: any) => {
      const chunks = args?.where?.queryChunks;
      if (Array.isArray(chunks)) {
        for (const chunk of chunks) {
          if (chunk && typeof chunk === 'object' && 'value' in chunk && typeof chunk.value === 'string') {
            if (store.has(chunk.value)) return store.get(chunk.value);
          }
        }
      }
      for (const [k, v] of store.entries()) {
        if (args?.where?.value === k || args?.where?.right?.value === k) return v;
      }
      try {
        const str = JSON.stringify(args);
        for (const [k, v] of store.entries()) {
          if (str.includes(k)) return v;
        }
      } catch {}
      return undefined;
    };

    const fakeDb = createFakeDb({
      findFirst: {
        configEntries: ((args: any) => findEntry(args)) as any,
      },
      insert: {
        config_entries: ((val: any) => {
          store.set(val.key, val);
          return [val];
        }) as any,
        configEntries: ((val: any) => {
          store.set(val.key, val);
          return [val];
        }) as any,
      },
      delete: {
        config_entries: () => [],
        configEntries: () => [],
      },
    });

    const configCenter = new ConfigCenter(fakeDb);
    const pluginConfig = configCenter.createScopedConfig('my-plugin');

    const watcher = vi.fn();
    const unsub = pluginConfig.watch('account_id', watcher);

    await pluginConfig.set('account_id', 'acc-123', { tags: ['auth'] });
    expect(watcher).toHaveBeenCalledWith('acc-123');
    expect(await pluginConfig.get('account_id')).toBe('acc-123');

    await pluginConfig.set('api_key', 'sec-456', { isSecret: true });
    expect(await pluginConfig.getSecret('api_key')).toBe('sec-456');

    // Test multiple watchers on same key
    const w1 = vi.fn();
    const w2 = vi.fn();
    const u1 = configCenter.watch('multi.key', w1);
    const u2 = configCenter.watch('multi.key', w2);

    await configCenter.set('multi.key', 'val-multi');
    expect(w1).toHaveBeenCalledWith('val-multi');
    expect(w2).toHaveBeenCalledWith('val-multi');

    // Unsub w1 while w2 is still active
    u1();
    // Unsub w1 again (no crash)
    u1();

    await configCenter.set('multi.key', 'val-multi-2');
    expect(w1).toHaveBeenCalledTimes(1);
    expect(w2).toHaveBeenCalledTimes(2);

    // Unsub w2 to clear the key
    u2();
    // Unsub w2 again when current is undefined
    u2();

    // Set public config in cache and test purge
    await configCenter.set('plugin:my-plugin:cached_item', 'cache-val');
    expect(await configCenter.purgePluginConfigs('my-plugin')).toBe(0);

    unsub();
  });
});
