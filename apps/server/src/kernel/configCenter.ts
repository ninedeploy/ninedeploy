import { eq, like, or } from 'drizzle-orm';
import type { DB } from '@ninedeploy/db';
import { configEntries } from '@ninedeploy/db';
import { decrypt, encrypt } from '../lib/crypto.js';
import type { ConfigDefinition, IConfigCenter, IScopedConfig } from './types.js';

type Watcher = (newVal: unknown) => void;

export class ConfigCenter implements IConfigCenter {
  private readonly db: DB;
  private readonly definitions = new Map<string, ConfigDefinition>();
  private readonly inMemoryCache = new Map<string, { value: unknown; isSecret: boolean }>();
  private readonly watchers = new Map<string, Set<Watcher>>();

  constructor(db: DB) {
    this.db = db;
  }

  registerDefinition(def: ConfigDefinition): void {
    this.definitions.set(def.key, def);
  }

  getDefinition(key: string): ConfigDefinition | undefined {
    return this.definitions.get(key);
  }

  listDefinitions(category?: string, pluginId?: string): ConfigDefinition[] {
    const list = Array.from(this.definitions.values());
    return list.filter((d) => {
      if (category && d.category !== category) return false;
      if (pluginId !== undefined && d.pluginId !== pluginId) return false;
      return true;
    });
  }

  async get<T = unknown>(key: string, defaultValue?: T): Promise<T> {
    const cached = this.inMemoryCache.get(key);
    if (cached !== undefined && !cached.isSecret) {
      return cached.value as T;
    }

    const row = await this.db.query.configEntries.findFirst({
      where: eq(configEntries.key, key),
    });

    if (!row) {
      const def = this.definitions.get(key);
      if (def?.defaultValue !== undefined) {
        return def.defaultValue as T;
      }
      return defaultValue as T;
    }

    if (row.isSecret) {
      try {
        const plain = decrypt(row.value);
        return plain as unknown as T;
      } catch {
        return defaultValue as T;
      }
    }

    try {
      const parsed = JSON.parse(row.value) as T;
      this.inMemoryCache.set(key, { value: parsed, isSecret: false });
      return parsed;
    } catch {
      this.inMemoryCache.set(key, { value: row.value, isSecret: false });
      return row.value as unknown as T;
    }
  }

  async getSecret(key: string): Promise<string | null> {
    const row = await this.db.query.configEntries.findFirst({
      where: eq(configEntries.key, key),
    });

    if (!row) return null;
    if (!row.isSecret) return row.value;

    try {
      return decrypt(row.value);
    } catch {
      return null;
    }
  }

  async set<T = unknown>(
    key: string,
    value: T,
    opts?: { isSecret?: boolean; category?: string; pluginId?: string; description?: string; tags?: string[]; userId?: number },
  ): Promise<void> {
    const isSecret = opts?.isSecret ?? this.definitions.get(key)?.isSecret ?? false;
    const category = opts?.category ?? this.definitions.get(key)?.category ?? 'general';
    const pluginId = opts?.pluginId ?? this.definitions.get(key)?.pluginId ?? null;
    const description = opts?.description ?? this.definitions.get(key)?.description ?? null;
    const tags = opts?.tags ?? this.definitions.get(key)?.tags ?? [];

    let storedValue: string;
    if (isSecret) {
      storedValue = encrypt(String(value));
    } else if (typeof value === 'string') {
      // get() re-parses stored rows on a cache miss, so a RAW copy of a
      // JSON-ambiguous string ('true', '123', 'null', '{}') came back
      // type-flipped from a cold cache (restart) while the warm cache
      // returned the string — the store's answer depended on cache warmth
      // (r033). Encode exactly the strings that would parse; plain strings
      // stay raw for readability and keep hitting the parse-failure path.
      let parsesAsJson = false;
      try {
        JSON.parse(value);
        parsesAsJson = true;
      } catch {
        /* plain text — store verbatim */
      }
      storedValue = parsesAsJson ? JSON.stringify(value) : value;
    } else {
      storedValue = JSON.stringify(value);
    }

    await this.db
      .insert(configEntries)
      .values({
        key,
        pluginId,
        value: storedValue,
        isSecret,
        category,
        tags,
        description,
        updatedAt: new Date(),
        updatedBy: opts?.userId ?? null,
      })
      .onConflictDoUpdate({
        target: configEntries.key,
        set: {
          pluginId,
          value: storedValue,
          isSecret,
          category,
          tags,
          description,
          updatedAt: new Date(),
          updatedBy: opts?.userId ?? null,
        },
      });

    if (!isSecret) {
      this.inMemoryCache.set(key, { value, isSecret: false });
    } else {
      this.inMemoryCache.delete(key);
    }

    // Trigger live reactivity watchers
    const watcherSet = this.watchers.get(key);
    if (watcherSet) {
      for (const cb of Array.from(watcherSet)) {
        try {
          cb(value);
        } catch (err) {
          console.error(`[ConfigCenter] Error in watcher for key "${key}":`, err);
        }
      }
    }
  }

  async delete(key: string): Promise<boolean> {
    this.inMemoryCache.delete(key);
    await this.db.delete(configEntries).where(eq(configEntries.key, key));
    return true;
  }

  watch(key: string, callback: (newVal: unknown) => void): () => void {
    let set = this.watchers.get(key);
    if (!set) {
      set = new Set();
      this.watchers.set(key, set);
    }
    set.add(callback);

    return () => {
      const current = this.watchers.get(key);
      if (current) {
        current.delete(callback);
        if (current.size === 0) {
          this.watchers.delete(key);
        }
      }
    };
  }

  async purgePluginConfigs(pluginId: string): Promise<number> {
    const prefix = `plugin:${pluginId}:`;
    for (const key of Array.from(this.inMemoryCache.keys())) {
      if (key.startsWith(prefix)) {
        this.inMemoryCache.delete(key);
      }
    }

    const res = await this.db
      .delete(configEntries)
      .where(or(eq(configEntries.pluginId, pluginId), like(configEntries.key, `${prefix}%`)));

    return (res as unknown as { rowsAffected?: number })?.rowsAffected ?? 0;
  }

  createScopedConfig(pluginId: string): IScopedConfig {
    const prefix = `plugin:${pluginId}:`;
    const self = this;

    return {
      async get<T = unknown>(key: string, defaultValue?: T): Promise<T> {
        const fullKey = `${prefix}${key}`;
        return self.get<T>(fullKey, defaultValue);
      },
      async getSecret(key: string): Promise<string | null> {
        const fullKey = `${prefix}${key}`;
        return self.getSecret(fullKey);
      },
      async set<T = unknown>(
        key: string,
        value: T,
        opts?: { isSecret?: boolean; description?: string; tags?: string[] },
      ): Promise<void> {
        const fullKey = `${prefix}${key}`;
        return self.set(fullKey, value, {
          ...opts,
          pluginId,
          category: `plugin:${pluginId}`,
        });
      },
      watch(key: string, callback: (newVal: unknown) => void): () => void {
        const fullKey = `${prefix}${key}`;
        return self.watch(fullKey, callback);
      },
    };
  }
}
