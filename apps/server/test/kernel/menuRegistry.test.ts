import { describe, expect, it } from 'vitest';
import { MenuRegistry } from '../../src/kernel/menuRegistry.js';

describe('MenuRegistry', () => {
  it('registers, filters, orders, and unregisters menu items', () => {
    const registry = new MenuRegistry();

    const unsub = registry.registerMenuItem({
      id: 'sidebar-projects',
      slot: 'sidebar:main',
      label: 'Projects',
      route: '/projects',
      order: 10,
    });

    registry.registerMenuItem({
      id: 'sidebar-servers',
      slot: 'sidebar:main',
      label: 'Servers',
      route: '/servers',
      order: 20,
    });

    registry.registerMenuItem({
      id: 'sidebar-default-order',
      slot: 'sidebar:main',
      label: 'Default Order',
      route: '/default',
      // order omitted to test default 100
    });

    registry.registerMenuItem({
      id: 'sidebar-admin-only',
      slot: 'sidebar:main',
      label: 'Admin Panel',
      route: '/admin',
      permission: 'admin',
      order: 5,
    });

    registry.registerMenuItem({
      id: 'service-custom-tab',
      slot: 'service:tabs',
      label: 'Custom Tab',
      route: 'custom',
    });

    // 1. Filter for admin
    const adminItems = registry.getItemsForSlot('sidebar:main', true);
    expect(adminItems).toHaveLength(4);
    expect(adminItems[0]?.id).toBe('sidebar-admin-only'); // order 5
    expect(adminItems[1]?.id).toBe('sidebar-projects'); // order 10
    expect(adminItems[2]?.id).toBe('sidebar-servers'); // order 20
    expect(adminItems[3]?.id).toBe('sidebar-default-order'); // order 100

    // 2. Filter for member (admin-only item excluded)
    const memberItems = registry.getItemsForSlot('sidebar:main', false);
    expect(memberItems).toHaveLength(3);
    expect(memberItems[0]?.id).toBe('sidebar-projects');

    // 3. Filter without the operator flag: fail-closed, so an item gated on
    //    `permission: 'admin'` is hidden rather than shown to everyone.
    const noRoleItems = registry.getItemsForSlot('sidebar:main');
    expect(noRoleItems).toHaveLength(3);
    expect(noRoleItems.map((i) => i.id)).not.toContain('sidebar-admin-only');

    // 4. GetAllItems
    expect(registry.getAllItems()).toHaveLength(5);

    // 5. Unregister via callback
    unsub();
    expect(registry.getItemsForSlot('sidebar:main', true)).toHaveLength(3);

    // 6. Unregister via ID
    expect(registry.unregisterMenuItem('sidebar-servers')).toBe(true);
    expect(registry.unregisterMenuItem('nonexistent')).toBe(false);
  });

  it('purges all menu items contributed by a specific plugin', () => {
    const registry = new MenuRegistry();

    registry.registerMenuItem({
      id: 'core-item',
      slot: 'sidebar:main',
      label: 'Core',
      route: '/core',
    });

    registry.registerMenuItem({
      id: 'p1-item1',
      pluginId: 'plugin-one',
      slot: 'sidebar:main',
      label: 'Plugin 1 Item 1',
      route: '/p1/1',
    });

    registry.registerMenuItem({
      id: 'p1-item2',
      pluginId: 'plugin-one',
      slot: 'service:tabs',
      label: 'Plugin 1 Tab',
      route: 'p1',
    });

    expect(registry.purgePluginMenus('plugin-one')).toBe(2);
    expect(registry.getAllItems()).toHaveLength(1);
    expect(registry.getAllItems()[0]?.id).toBe('core-item');
  });
});
