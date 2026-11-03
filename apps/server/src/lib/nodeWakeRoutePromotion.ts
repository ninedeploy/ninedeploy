declare const promotionBrand: unique symbol;
/** Process-local permission to publish one wake generation; never an API input. */
export type NodeWakeRoutePromotion = { readonly [promotionBrand]: true };
type Permission = { nodeId: number; serviceId: number; verify: () => Promise<void>; wall: number; monotonic: number };
const permissions = new WeakMap<NodeWakeRoutePromotion, Permission>();

/** Authority supplies a live journal/owner check; phase alone is not a reusable credential. */
export function registerNodeWakeRoutePromotion(nodeId: number, serviceId: number, verify: () => Promise<void>): NodeWakeRoutePromotion {
  const token = Object.freeze({}) as NodeWakeRoutePromotion;
  permissions.set(token, { nodeId, serviceId, verify, wall: Date.now(), monotonic: performance.now() });
  return token;
}
export async function checkNodeWakeRoutePromotion(token: NodeWakeRoutePromotion, nodeId: number): Promise<number> {
  const permission = permissions.get(token);
  const fresh = () => permission && permission.nodeId === nodeId && Date.now() >= permission.wall && Date.now() - permission.wall < 30_000 &&
    performance.now() >= permission.monotonic && performance.now() - permission.monotonic < 30_000;
  if (!fresh()) throw new Error('Node wake route promotion expired or changed');
  await permission!.verify();
  if (!fresh()) throw new Error('Node wake route promotion expired or changed');
  return permission!.serviceId;
}

/**
 * Settlement after the target node acknowledged the app route under a fresh
 * permission (nodeProxy checks it around that node's agent calls). Only the
 * live journal/owner check applies here, not the 30 s clock: the rest of the
 * fleet is synced in between, and two unreachable nodes (15 s each) expired the
 * permission, so an acknowledged wake was never settled and every retry failed.
 */
export async function confirmNodeWakeRoutePromotion(token: NodeWakeRoutePromotion, nodeId: number): Promise<number> {
  const permission = permissions.get(token);
  if (!permission || permission.nodeId !== nodeId) throw new Error('Node wake route promotion expired or changed');
  await permission.verify();
  return permission.serviceId;
}
