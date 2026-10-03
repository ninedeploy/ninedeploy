import { describe, expect, it } from 'vitest';
import { menuRoutes } from '../src/modules/menus.js';
import { asUser, buildTestApp, createFakeDb } from './helpers.js';

describe('Menus HTTP API', () => {
  it('lists menu items with slot filtering and permission checks', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(menuRoutes);

    app.kernel.menuRegistry.registerMenuItem({
      id: 'sidebar-projects',
      slot: 'sidebar:main',
      label: 'Projects',
      route: '/projects',
      order: 10,
    });

    app.kernel.menuRegistry.registerMenuItem({
      id: 'sidebar-admin-settings',
      slot: 'sidebar:main',
      label: 'Admin Settings',
      route: '/admin/settings',
      permission: 'admin',
      order: 5,
    });

    app.kernel.menuRegistry.registerMenuItem({
      id: 'sidebar-default-order',
      slot: 'sidebar:main',
      label: 'Default Order',
      route: '/default',
      // order omitted to test default 100 branch
    });

    app.kernel.menuRegistry.registerMenuItem({
      id: 'service-terminal-tab',
      slot: 'service:tabs',
      label: 'Terminal',
      route: 'terminal',
    });

    // 1. Get all grouped slots as admin
    const adminRes = await app.inject({
      method: 'GET',
      url: '/',
      headers: asUser({ isOperator: true }),
    });
    expect(adminRes.statusCode).toBe(200);
    const adminData = adminRes.json();
    expect(adminData.slots['sidebar:main']).toHaveLength(3);
    expect(adminData.slots['sidebar:main'][0].id).toBe('sidebar-admin-settings');
    expect(adminData.slots['sidebar:main'][1].id).toBe('sidebar-projects');
    expect(adminData.slots['sidebar:main'][2].id).toBe('sidebar-default-order');
    expect(adminData.slots['service:tabs']).toHaveLength(1);

    // 2. Get all grouped slots as member (admin items excluded)
    const memberRes = await app.inject({
      method: 'GET',
      url: '/',
      headers: asUser({ isOperator: false }),
    });
    expect(memberRes.statusCode).toBe(200);
    const memberData = memberRes.json();
    expect(memberData.slots['sidebar:main']).toHaveLength(2);
    expect(memberData.slots['sidebar:main'][0].id).toBe('sidebar-projects');
    expect(memberData.slots['sidebar:main'][1].id).toBe('sidebar-default-order');

    // 3. Filter by slot
    const slotRes = await app.inject({
      method: 'GET',
      url: '/?slot=sidebar:main',
      headers: asUser({ isOperator: true }),
    });
    expect(slotRes.statusCode).toBe(200);
    expect(slotRes.json().items).toHaveLength(3);

    await app.close();
  });
});
