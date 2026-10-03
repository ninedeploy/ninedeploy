import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import {
  addFirewallRule,
  applyRecommendedVpsRules,
  deleteFirewallRule,
  getFirewallStatus,
  setFirewallActive,
} from '../lib/firewall.js';

const ruleSchema = z.object({
  port: z.union([z.number().int().min(1).max(65535), z.string().min(1).max(30)]),
  proto: z.enum(['tcp', 'udp', 'any']).optional().default('tcp'),
  action: z.enum(['allow', 'deny', 'limit']).optional().default('allow'),
  from: z.string().max(100).optional(),
  comment: z.string().max(100).optional(),
});

const toggleSchema = z.object({
  enabled: z.boolean(),
});

export const firewallRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireAdmin);

  // Status & active rules
  app.get('/', async () => {
    return await getFirewallStatus();
  });

  // Toggle firewall state
  app.post('/toggle', async (req) => {
    const { enabled } = toggleSchema.parse(req.body);
    await setFirewallActive(enabled);
    void audit(app.db, req.user!.id, 'firewall.toggle', enabled ? 'enabled' : 'disabled');
    return { ok: true, status: await getFirewallStatus() };
  });

  // Add rule
  app.post('/rules', async (req) => {
    const body = ruleSchema.parse(req.body);
    await addFirewallRule(body);
    void audit(app.db, req.user!.id, 'firewall.rule_add', `${body.action} ${body.port}/${body.proto}`);
    return { ok: true, status: await getFirewallStatus() };
  });

  // Delete rule
  app.delete('/rules/:id', async (req) => {
    const { id } = req.params as { id: string };
    await deleteFirewallRule(id);
    void audit(app.db, req.user!.id, 'firewall.rule_delete', `rule ${id}`);
    return { ok: true, status: await getFirewallStatus() };
  });

  // Apply recommended VPS rules (22, 80, 443 + enable)
  app.post('/recommended', async (req) => {
    await applyRecommendedVpsRules();
    void audit(app.db, req.user!.id, 'firewall.recommended_applied', '22/80/443 enabled');
    return { ok: true, status: await getFirewallStatus() };
  });
};
