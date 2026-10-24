import { hostname } from 'node:os';
import { z } from 'zod';
import type { EngineResponse } from './dockerTty.js';
import { HttpError } from './errors.js';
import { createKeyedOperationGuard } from './keyedOperationGuard.js';

type Caller = (method: string, path: string, body?: unknown, ok?: number[], timeoutMs?: number) => Promise<EngineResponse>;
interface Resource { databaseId: number; slug: string; networkId?: string }
const fullId = z.string().regex(/^[a-f0-9]{64}$/);
const endpoint = z.object({ NetworkID: fullId, Aliases: z.array(z.string()).nullable().optional(), GwPriority: z.number().int().optional() });
const selfSchema = z.object({
  Id: fullId, State: z.object({ Running: z.boolean() }),
  Config: z.object({ Hostname: z.string(), Env: z.array(z.string()) }),
  HostConfig: z.object({ NetworkMode: z.string() }),
  NetworkSettings: z.object({ Networks: z.record(z.string(), endpoint) }),
});
type Self = z.infer<typeof selfSchema>;
const withNetwork = createKeyedOperationGuard<string>();
const marker = (id: number) => `nd-studio-agent-db-${id}`;
const unconfirmed = () => new HttpError(502, 'node_studio_network_unconfirmed', 'The node agent private Studio connection could not be confirmed');

/** Docker's default hostname identifies this process's own container. Never
 * infer ownership from the agent's conventional (user-reusable) container name. */
async function ownContainer(call: Caller): Promise<Self | null> {
  if (!['1', 'true'].includes(process.env['NINEDEPLOY_AGENT'] ?? '')) return null;
  const name = hostname();
  if (!/^[a-f0-9]{12,64}$/.test(name)) return null;
  const reply = await call('GET', `/containers/${name}/json`, undefined, [404]);
  if (reply.status === 404) return null;
  const parsed = selfSchema.safeParse(JSON.parse(reply.body));
  if (!parsed.success || !parsed.data.Id.startsWith(name) || parsed.data.Config.Hostname !== name
    || !parsed.data.Config.Env.some(value => value === 'NINEDEPLOY_AGENT=1' || value === 'NINEDEPLOY_AGENT=true')
    || !parsed.data.State.Running || parsed.data.HostConfig.NetworkMode === 'host') return null;
  return parsed.data;
}
async function inspectSelf(call: Caller, id: string): Promise<Self> {
  const raw = await call('GET', `/containers/${id}/json`);
  const self = selfSchema.parse(JSON.parse(raw.body));
  if (self.Id !== id || !self.State.Running) throw unconfirmed();
  return self;
}
const attached = (self: Self, id: string) => Object.values(self.NetworkSettings.Networks).find(value => value.NetworkID === id);

/** Join the trusted agent to the database bridge, never expose the helper on
 * the default bridge or publish its port. A lower gateway priority preserves
 * the agent's current outbound route, including custom negative priorities. */
export async function ensureNodeStudioNetwork(call: Caller, resource: Resource & { networkId: string }, verifyHelper: () => Promise<void>): Promise<void> {
  await withNetwork(String(resource.databaseId), async () => {
    await verifyHelper();
    const self = await ownContainer(call);
    if (!self || attached(self, resource.networkId)) return;
    const version = JSON.parse((await call('GET', '/version')).body) as { ApiVersion?: unknown };
    const match = typeof version.ApiVersion === 'string' ? /^(\d+)\.(\d+)$/.exec(version.ApiVersion) : null;
    if (!match || Number(match[1]) < 1 || Number(match[1]) === 1 && Number(match[2]) < 48) {
      throw new HttpError(422, 'node_studio_network_api', 'Containerized node Studios need Docker Engine API 1.48 or newer to preserve the agent default gateway');
    }
    const priority = Math.min(0, ...Object.values(self.NetworkSettings.Networks).map(value => value.GwPriority ?? 0)) - 1;
    if (priority < -2147483648) throw unconfirmed();
    try {
      await call('POST', `/networks/${resource.networkId}/connect`, {
        Container: self.Id, EndpointConfig: { Aliases: [marker(resource.databaseId)], GwPriority: priority },
      });
    } catch { /* Confirm the endpoint below, including after a lost reply. */ }
    // Also recovers a successful connect whose HTTP reply was lost. A bare
    // 2xx is insufficient: confirm immutable ID, ownership and route priority.
    const current = attached(await inspectSelf(call, self.Id), resource.networkId);
    if (!current?.Aliases?.includes(marker(resource.databaseId)) || current.GwPriority !== priority) throw unconfirmed();
  });
}

/** Detach only endpoints created by this feature, after the helper is gone.
 * Existing/manual connections and other containers are always preserved. */
export async function releaseNodeStudioNetwork(call: Caller, resource: Resource): Promise<void> {
  const networkName = `nd-dbnet-${resource.slug}`;
  await withNetwork(String(resource.databaseId), async () => {
    const self = await ownContainer(call);
    if (!self) return;
    let id = resource.networkId;
    if (!id) {
      const raw = await call('GET', `/networks/${encodeURIComponent(networkName)}`, undefined, [404]);
      if (raw.status === 404) return;
      const network = z.object({ Id: fullId, Name: z.literal(networkName), Driver: z.literal('bridge'), Scope: z.literal('local') }).parse(JSON.parse(raw.body));
      id = network.Id;
    }
    if (!attached(self, id)?.Aliases?.includes(marker(resource.databaseId))) return;
    try { await call('POST', `/networks/${id}/disconnect`, { Container: self.Id, Force: false }, [404]); }
    catch { /* A lost reply is accepted only after confirmed absence. */ }
    if (attached(await inspectSelf(call, self.Id), id)) throw unconfirmed();
  });
}
