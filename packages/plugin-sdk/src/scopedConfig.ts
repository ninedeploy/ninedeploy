import type { ScopedConfigAccessor } from './types.js';

export interface UnderlyingConfigCenter {
  get<T = unknown>(key: string, defaultValue?: T): Promise<T>;
  getSecret(key: string): Promise<string | null>;
  set(
    key: string,
    value: unknown,
    options?: { isSecret?: boolean; description?: string; tags?: string[] },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

export function sanitizeKey(pluginId: string, shortKey: string): string {
  if (!shortKey || typeof shortKey !== 'string') {
    throw new Error('Config key must be a non-empty string');
  }

  const trimmed = shortKey.trim();
  if (trimmed.includes('..') || trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    throw new Error(`Invalid key "${shortKey}": Path traversal is prohibited in plugin config`);
  }

  // If already prefixed with plugin:<pluginId>:, allow it
  const expectedPrefix = `plugin:${pluginId}:`;
  if (trimmed.startsWith(expectedPrefix)) {
    return trimmed;
  }

  // If attempting to access another plugin's namespace, deny
  if (trimmed.startsWith('plugin:')) {
    throw new Error(`Access Denied: Plugin "${pluginId}" cannot access namespace "${trimmed}"`);
  }

  return `${expectedPrefix}${trimmed}`;
}

export function createScopedConfig(pluginId: string, underlying: UnderlyingConfigCenter): ScopedConfigAccessor {
  if (!pluginId || typeof pluginId !== 'string') {
    throw new Error('Plugin ID is required to create a scoped config accessor');
  }

  return {
    async get<T = unknown>(key: string, defaultValue?: T): Promise<T> {
      const namespacedKey = sanitizeKey(pluginId, key);
      return underlying.get<T>(namespacedKey, defaultValue);
    },

    async getSecret(key: string): Promise<string | null> {
      const namespacedKey = sanitizeKey(pluginId, key);
      return underlying.getSecret(namespacedKey);
    },

    async set(
      key: string,
      value: unknown,
      options?: { isSecret?: boolean; description?: string; tags?: string[] },
    ): Promise<void> {
      const namespacedKey = sanitizeKey(pluginId, key);
      const tags = options?.tags ? [...options.tags, `plugin:${pluginId}`] : [`plugin:${pluginId}`];
      return underlying.set(namespacedKey, value, {
        isSecret: options?.isSecret,
        description: options?.description,
        tags,
      });
    },

    async delete(key: string): Promise<void> {
      const namespacedKey = sanitizeKey(pluginId, key);
      return underlying.delete(namespacedKey);
    },
  };
}
