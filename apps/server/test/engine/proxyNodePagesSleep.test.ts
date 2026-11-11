import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { services } from '@ninedeploy/db';
import { servingReceiptFixture } from '../fixtures/servingTrafficReceipt.js';
import { nodeSleepEvidence } from '../fixtures/nodeSleepEvidence.js';
import { admitNodeSleep, advanceNodeSleep, bindNodeSleepCatcher } from '../../src/lib/nodeSleepAuthority.js';
import { nodeWakeKey } from '../../src/lib/nodeWakeKey.js';
import { renderDynamicConfig } from '../../src/engine/proxy.js';
import { setMaintenance } from '../../src/lib/maintenance.js';

vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: vi.fn(), agentTransportSealed: vi.fn(async () => true) }));

/**
 * P2 with R2: a node service that is asleep AND in maintenance. Maintenance
 * wins: the domain answers the node's maintenance page, nothing wakes the
 * service, and the node's wake key never travels to the page server. A
 * bypass address still reaches the service through its catcher (so it wakes).
 */
let f: Awaited<ReturnType<typeof servingReceiptFixture>>;
beforeEach(async () => {
  f = await servingReceiptFixture('file::memory:');
  await f.c.db.update(services).set({ sleepAfterMinutes: 5 });
});
afterEach(() => { vi.restoreAllMocks(); f.c.client?.close(); });

const routerBlock = (output: string, name: string) => output.split(`    ${name}:\n`)[1]?.split(/\n {4}\S/)[0] ?? '';

async function sleepingOnNode() {
  const service = (await f.c.db.query.services.findFirst())!;
  const proof = await nodeSleepEvidence(f.c.db);
  const admission = (await admitNodeSleep(f.c.db, service, proof.token))!;
  await nodeWakeKey(f.c.db, 4, true);
  await advanceNodeSleep(f.c.db, admission, 'accepted', 'fencing');
  await bindNodeSleepCatcher(f.c.db, admission, { id: 'c'.repeat(64), image: `sha256:${'d'.repeat(64)}` });
  await advanceNodeSleep(f.c.db, admission, 'fencing', 'prepared');
  await advanceNodeSleep(f.c.db, admission, 'prepared', 'routing');
  return service;
}

it('maintenance wins over a sleeping node service, and the wake key stays off the page server route', async () => {
  const service = await sleepingOnNode();
  const asleep = await renderDynamicConfig(f.c.db, { serverId: 4, pages: true });
  expect(routerBlock(asleep, 'web_1')).toContain('service: svc_ninedeploy_node_wake');

  await setMaintenance(f.c.db, service.id, { title: 'Down', message: '', retryAfterSeconds: 60, bypass: ['203.0.113.7'] });
  const output = await renderDynamicConfig(f.c.db, { serverId: 4, pages: true });
  const main = routerBlock(output, 'web_1');
  expect(main).toContain('service: svc_ninedeploy_pages');
  expect(main).toContain(`- mw_ninedeploy_maint_${service.id}`);
  expect(main).not.toContain('node_wake');
  // The bypass twin keeps the wake path, so an allowed visitor still wakes the service.
  const bypass = routerBlock(output, 'web_1_bypass');
  expect(bypass).toContain('service: svc_ninedeploy_node_wake');
  expect(bypass).toContain('- mw_web_1_node_wake');
  expect(bypass).toContain('- mw_ninedeploy_node_wake_key');

  // Without a confirmed page server the node keeps its sleep routing.
  expect(routerBlock(await renderDynamicConfig(f.c.db, { serverId: 4 }), 'web_1')).toContain('service: svc_ninedeploy_node_wake');
});
