import type { FastifyPluginAsync } from 'fastify';
import type { MenuItemDefinition, MenuSlot } from '../kernel/types.js';

export const menuRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (req) => {
    const isOperator = req.user!.isOperator;
    const query = req.query as { slot?: MenuSlot };

    if (query.slot) {
      const items = req.kernel.menuRegistry.getItemsForSlot(query.slot, isOperator);
      return { slot: query.slot, items };
    }

    const allItems = req.kernel.menuRegistry.getAllItems();
    const slots: Record<string, MenuItemDefinition[]> = {};

    for (const item of allItems) {
      if (!slots[item.slot]) {
        slots[item.slot] = req.kernel.menuRegistry.getItemsForSlot(item.slot, isOperator);
      }
    }

    return { slots, items: Object.values(slots).flat() };
  });
};
