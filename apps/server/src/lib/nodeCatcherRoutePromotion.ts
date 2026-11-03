declare const brand: unique symbol;
/** Process-local permission for one ready catcher, never accepted from an API request. */
export type NodeCatcherRoutePromotion = { readonly [brand]: true };
export type CatcherRouteTarget = { id: string; image: string; name: string; services: ReadonlyArray<{ serviceId: number; binding: string; catcherId: string }> };
type Permission = { nodeId: number; target: CatcherRouteTarget; verify: () => Promise<void>; settle: () => Promise<number>; wall: number; monotonic: number; consumed: boolean };
const permissions = new WeakMap<NodeCatcherRoutePromotion, Permission>();

export function registerNodeCatcherRoutePromotion(nodeId: number, target: CatcherRouteTarget, verify: () => Promise<void>, settle: () => Promise<number>): NodeCatcherRoutePromotion {
  const token = Object.freeze({}) as NodeCatcherRoutePromotion;
  const captured = Object.freeze({ ...target, services: Object.freeze(target.services.map(item => Object.freeze({ ...item }))) });
  permissions.set(token, { nodeId, target: captured, verify, settle, wall: Date.now(), monotonic: performance.now(), consumed: false });
  return token;
}

export async function checkNodeCatcherRoutePromotion(token: NodeCatcherRoutePromotion, nodeId: number): Promise<CatcherRouteTarget> {
  const permission = permissions.get(token);
  const fresh = () => permission && !permission.consumed && permission.nodeId === nodeId && Date.now() >= permission.wall && Date.now() - permission.wall < 30_000 &&
    performance.now() >= permission.monotonic && performance.now() - permission.monotonic < 30_000;
  if (!fresh()) throw new Error('Node catcher route promotion expired or changed');
  await permission!.verify();
  if (!fresh()) throw new Error('Node catcher route promotion expired or changed');
  return permission!.target;
}

/** Invoked inside the serialized routing writer, after exact acknowledgement and before the next render. */
export async function settleNodeCatcherRoutePromotion(token: NodeCatcherRoutePromotion, nodeId: number): Promise<number> {
  const permission = await confirmNodeCatcherRoutePromotion(token, nodeId);
  permission.consumed = true;
  return permission.settle();
}

/**
 * After the target node acknowledged under a fresh permission, settlement needs
 * the live check only, not the 30 s clock, which the rest of the fleet's sync can
 * use up (see confirmNodeWakeRoutePromotion).
 */
export async function confirmNodeCatcherRoutePromotion(token: NodeCatcherRoutePromotion, nodeId: number): Promise<Permission> {
  const permission = permissions.get(token);
  if (!permission || permission.consumed || permission.nodeId !== nodeId) throw new Error('Node catcher route promotion expired or changed');
  await permission.verify();
  if (permission.consumed) throw new Error('Node catcher route promotion expired or changed');
  return permission;
}
