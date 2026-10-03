import type { IMenuRegistry, MenuItemDefinition, MenuSlot } from './types.js';

export class MenuRegistry implements IMenuRegistry {
  private readonly items = new Map<string, MenuItemDefinition>();

  registerMenuItem(item: MenuItemDefinition): () => void {
    this.items.set(item.id, item);

    return () => {
      this.unregisterMenuItem(item.id);
    };
  }

  unregisterMenuItem(id: string): boolean {
    return this.items.delete(id);
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
