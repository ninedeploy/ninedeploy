import type { IMenuRegistry, MenuItemDefinition, MenuSlot } from './types.js';

// F896: an item is owned by (pluginId, id). Keyed by the bare id, a second
// plugin reusing an id (plugins do not namespace their item ids) replaced the
// first plugin's entry, and the first plugin's disposer deleted the second's.
const itemKey = (item: MenuItemDefinition): string => JSON.stringify([item.pluginId ?? null, item.id]);

export class MenuRegistry implements IMenuRegistry {
  private readonly items = new Map<string, MenuItemDefinition>();

  registerMenuItem(item: MenuItemDefinition): () => void {
    const key = itemKey(item);
    this.items.set(key, item);

    return () => {
      this.items.delete(key);
    };
  }

  unregisterMenuItem(id: string): boolean {
    let removed = false;
    for (const [key, item] of Array.from(this.items.entries())) {
      if (item.id === id) {
        this.items.delete(key);
        removed = true;
      }
    }
    return removed;
  }

  getItemsForSlot(slot: MenuSlot, isOperator?: boolean): MenuItemDefinition[] {
    const list: MenuItemDefinition[] = [];

    for (const item of this.items.values()) {
      if (item.slot !== slot) continue;
      // `permission: 'admin'` on a menu item is the old "global admin only"
      // gate; after the team overhaul it means "operator" (owner/admin in some
      // workspace). When the caller is not an operator the item is hidden.
      if (item.permission === 'admin' && isOperator !== true) continue;
      list.push(item);
    }

    return list.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }

  getAllItems(): MenuItemDefinition[] {
    return Array.from(this.items.values());
  }

  getPluginMenus(pluginId: string): MenuItemDefinition[] {
    return Array.from(this.items.values()).filter((item) => item.pluginId === pluginId);
  }

  purgePluginMenus(pluginId: string): number {
    let count = 0;
    for (const [id, item] of Array.from(this.items.entries())) {
      if (item.pluginId === pluginId) {
        this.items.delete(id);
        count++;
      }
    }
    return count;
  }
}
