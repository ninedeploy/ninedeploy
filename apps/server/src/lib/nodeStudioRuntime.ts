import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { isIP } from 'node:net';
import { z } from 'zod';
import { DATABASE_STUDIO_ENGINES } from '@ninedeploy/schemas';
import { switchedOff } from '../agentOps/operands.js';
import { isRedisFamily } from './databaseCommands.js';
import { redisStudioConfig, studioImageForEngine } from './databaseStudioImages.js';
import { dockerTransport, isEngineTransport, engineCall, DockerEngineError, type EngineTransport, type EngineResponse } from './dockerTty.js';
import { ensureDockerImage } from './dockerPull.js';
import { HttpError } from './errors.js';
import { createKeyedOperationGuard } from './keyedOperationGuard.js';
import type { StudioHttpTarget } from './studioRelayHttp.js';
import { ensureNodeStudioNetwork, releaseNodeStudioNetwork } from './nodeStudioNetwork.js';

const fullId = z.string().regex(/^[a-f0-9]{64}$/);
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const engine = z.enum(DATABASE_STUDIO_ENGINES);
const resource = { databaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), slug: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9_.-]*$/), engine };
export const nodeStudioResource = z.object(resource).strict();
export const nodeStudioIdentity = z.object({
  ...resource, containerId: fullId, databaseContainerId: fullId, networkId: fullId,
  nonce: z.string().uuid(), imageId,
}).strict();
export type NodeStudioIdentity = z.infer<typeof nodeStudioIdentity>;
export const nodeStudioClearInput = z.object({ ...resource, previous: nodeStudioIdentity.optional() }).strict();
export const nodeStudioStartInput = z.object({
  ...resource, password: z.string().max(1024).refine(value => !value.includes('\0')).optional(),
  previous: nodeStudioIdentity.optional(),
}).strict();
export type NodeStudioStartInput = z.infer<typeof nodeStudioStartInput>;
export interface ConfirmedStudioHttpTarget extends StudioHttpTarget { verify(): Promise<void> }

const endpoint = z.object({ NetworkID: z.string(), IPAddress: z.string().optional(), GlobalIPv6Address: z.string().optional() });
const container = z.object({
  Id: fullId, Name: z.string(), Image: z.string().optional(),
  State: z.object({ Running: z.boolean() }), Config: z.object({ Labels: z.record(z.string(), z.string()).nullable().optional(), Env: z.array(z.string()).optional() }),
  HostConfig: z.object({
    NetworkMode: z.string().optional(), Privileged: z.boolean().optional(), Binds: z.array(z.string()).nullable().optional(),
    Mounts: z.array(z.unknown()).nullable().optional(),
    PortBindings: z.record(z.string(), z.unknown()).nullable().optional(), PublishAllPorts: z.boolean().optional(),
  }).optional(),
  NetworkSettings: z.object({ Networks: z.record(z.string(), endpoint) }).optional(),
});
type Container = z.infer<typeof container>;
type Caller = (method: string, path: string, body?: unknown, ok?: number[], timeoutMs?: number) => Promise<EngineResponse>;
const withStudio = createKeyedOperationGuard<number>();
const changed = () => new HttpError(409, 'node_studio_identity_changed', 'The database, Studio container or private network changed; reopen the Studio');
const failed = () => new HttpError(502, 'node_studio_unconfirmed', 'Node Web Studio state could not be confirmed');
const dbName = (slug: string) => `nd-db-${slug}`;
const networkName = (slug: string) => `nd-dbnet-${slug}`;
const helperName = (id: number) => `nd-node-studio-${id}`;
const enc = encodeURIComponent;

export function assertNodeStudioEnabled(): EngineTransport {
  if (switchedOff(process.env['NINEDEPLOY_AGENT_DATABASES']) || switchedOff(process.env['NINEDEPLOY_AGENT_DATABASE_STUDIOS'])) throw new HttpError(403, 'node_studio_disabled', 'Database Studios are disabled by the node owner');
  const transport = dockerTransport();
  if (!isEngineTransport(transport)) throw new HttpError(422, 'node_studio_transport', 'Node Web Studio needs the Docker Engine API');
  return transport;
}
const caller = (transport: EngineTransport): Caller => (method, path, body, ok, timeout = 5000) => engineCall(transport, method, path, body, ok, timeout);
async function inspect(call: Caller, name: string): Promise<Container | null> {
  const reply = await call('GET', `/containers/${enc(name)}/json`, undefined, [404]);
  return reply.status === 404 ? null : container.parse(JSON.parse(reply.body));
}
async function databaseTarget(call: Caller, input: Pick<NodeStudioIdentity, 'databaseId' | 'slug' | 'engine'>) {
  const database = await inspect(call, dbName(input.slug));
  if (!database || !database.State.Running) throw new HttpError(409, 'not_running', 'The database is not running on the node');
  const labels = database.Config.Labels ?? {};
  if (database.Name !== `/${dbName(input.slug)}` || labels['ninedeploy.managed'] !== 'database' || labels['ninedeploy.database.id'] !== String(input.databaseId) || labels['ninedeploy.database.slug'] !== input.slug
    || labels['ninedeploy.database.engine'] !== undefined && labels['ninedeploy.database.engine'] !== input.engine) throw changed();
  const expectedName = networkName(input.slug), attached = database.NetworkSettings?.Networks[expectedName];
  if (!attached || !fullId.safeParse(attached.NetworkID).success) throw changed();
  const raw = await call('GET', `/networks/${enc(expectedName)}`, undefined, [404]);
  if (raw.status === 404) throw changed();
  const network = z.object({ Id: fullId, Name: z.string(), Driver: z.literal('bridge'), Scope: z.literal('local') }).parse(JSON.parse(raw.body));
  if (network.Name !== expectedName || network.Id !== attached.NetworkID) throw changed();
  return { databaseContainerId: database.Id, networkId: network.Id };
}
function labelsFor(identity: Omit<NodeStudioIdentity, 'containerId'>): Record<string, string> {
  return {
    'ninedeploy.managed': 'database-studio', 'ninedeploy.database.id': String(identity.databaseId),
    'ninedeploy.database.slug': identity.slug, 'ninedeploy.database.engine': identity.engine,
    'ninedeploy.studio.database.container': identity.databaseContainerId, 'ninedeploy.studio.network': identity.networkId,
    'ninedeploy.studio.nonce': identity.nonce, 'ninedeploy.studio.image': identity.imageId,
  };
}
function owns(helper: Container, identity: NodeStudioIdentity): boolean {
  const labels = helper.Config.Labels ?? {};
  return helper.Id === identity.containerId && helper.Name === `/${helperName(identity.databaseId)}` && helper.Image === identity.imageId
    && Object.entries(labelsFor(identity)).every(([name, value]) => labels[name] === value);
}
function privateEndpoint(helper: Container, identity: NodeStudioIdentity): StudioHttpTarget {
  const host = helper.HostConfig, networks = helper.NetworkSettings?.Networks ?? {}, attached = networks[networkName(identity.slug)];
  if (!owns(helper, identity) || !helper.State.Running || !host || host.Privileged === true || host.PublishAllPorts === true
    || (host.Binds?.length ?? 0) > 0 || (host.Mounts?.length ?? 0) > 0 || Object.keys(host.PortBindings ?? {}).length > 0 || host.NetworkMode !== identity.networkId
    || Object.keys(networks).length !== 1 || attached?.NetworkID !== identity.networkId) throw changed();
  const address = attached.IPAddress || attached.GlobalIPv6Address || '';
  if (!isIP(address)) throw changed();
  return { address, port: studioImageForEngine(identity.engine).containerPort };
}

async function targetSnapshot(identity: NodeStudioIdentity, deadline = Date.now() + 15_000): Promise<StudioHttpTarget> {
  const transport = assertNodeStudioEnabled();
  const call: Caller = (method, path, body, ok, timeout = 5000) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new HttpError(504, 'node_studio_timeout', 'Node Web Studio verification timed out');
    return engineCall(transport, method, path, body, ok, Math.min(timeout, remaining));
  };
  const selected = await databaseTarget(call, identity);
  if (selected.databaseContainerId !== identity.databaseContainerId || selected.networkId !== identity.networkId) throw changed();
  const helper = await inspect(call, identity.containerId);
  if (!helper) throw changed();
  const target = privateEndpoint(helper, identity);
  await ensureNodeStudioNetwork(call, identity, async () => {
    const current = await inspect(call, identity.containerId);
    if (!current) throw changed();
    privateEndpoint(current, identity);
  });
  return target;
}
/** Re-resolve for each request and again after TCP connect, before any HTTP bytes. */
export async function resolveNodeStudioHttpTarget(input: NodeStudioIdentity, deadline?: number): Promise<ConfirmedStudioHttpTarget> {
  const identity = nodeStudioIdentity.parse(input), target = await targetSnapshot(identity, deadline);
  return { ...target, async verify() {
    const current = await targetSnapshot(identity, deadline);
    if (current.address !== target.address || current.port !== target.port) throw changed();
  } };
}

/** Fixed in-network readiness probe; never follows an HTTP redirect. */
export function probeNodeStudio(target: StudioHttpTarget, path: string): Promise<boolean> {
  return new Promise(resolve => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (ok: boolean) => { clearTimeout(timer); resolve(ok); };
    const req = request({ host: target.address, port: target.port, method: 'HEAD', path, agent: false }, response => {
      response.resume(); response.once('end', () => finish((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 400));
      response.once('error', () => finish(false));
    });
    timer = setTimeout(() => req.destroy(new Error('Studio readiness timeout')), 2000); timer.unref();
    req.once('error', () => finish(false)); req.end();
  });
}
async function removeOwned(call: Caller, identity: NodeStudioIdentity): Promise<void> {
  const helper = await inspect(call, identity.containerId);
  if (helper) {
    if (!owns(helper, identity)) throw changed();
    await call('DELETE', `/containers/${identity.containerId}?force=1&v=1`, undefined, [404], 10_000);
    if (await inspect(call, identity.containerId)) throw new HttpError(502, 'node_studio_cleanup_unconfirmed', 'Node Web Studio cleanup could not be confirmed');
  }
  await releaseNodeStudioNetwork(call, identity);
}

/** Stop exactly the recorded owned ID; a replacement at its name is untouched. */
export async function stopNodeStudio(input: NodeStudioIdentity): Promise<void> {
  const identity = nodeStudioIdentity.parse(input);
  return withStudio(identity.databaseId, async () => {
    try { await removeOwned(caller(assertNodeStudioEnabled()), identity); }
    catch (error) { if (error instanceof HttpError) throw error; throw failed(); }
  });
}
/** Recover an unpublished/lost start receipt. The resource queue waits for
 * an in-flight start before confirming absence, so a successful clear cannot
 * be followed by that start creating a late helper. */
export async function clearNodeStudio(input: z.infer<typeof nodeStudioClearInput>): Promise<string | null> {
  const resource = nodeStudioClearInput.parse(input), previous = resource.previous;
  if (previous && (previous.databaseId !== resource.databaseId || previous.slug !== resource.slug || previous.engine !== resource.engine)) throw changed();
  return withStudio(resource.databaseId, async () => {
    const call = caller(assertNodeStudioEnabled()), helper = await inspect(call, helperName(resource.databaseId));
    if (previous) {
      // A published receipt is authoritative. Recovery by managed name is
      // reserved for a preparation whose reply was never published.
      if (helper && !owns(helper, previous)) throw changed();
      await removeOwned(call, previous); return helper ? previous.containerId : null;
    }
    if (!helper) { await releaseNodeStudioNetwork(call, resource); return null; }
    const labels = helper.Config.Labels ?? {};
    const parsed = nodeStudioIdentity.safeParse({ ...resource, containerId: helper.Id, imageId: helper.Image,
      databaseContainerId: labels['ninedeploy.studio.database.container'], networkId: labels['ninedeploy.studio.network'], nonce: labels['ninedeploy.studio.nonce'] });
    if (!parsed.success || !owns(helper, parsed.data)) throw changed();
    await removeOwned(call, parsed.data); return parsed.data.containerId;
  });
}
export interface NodeStudioRuntimeDeps {
  /** Third-party image preparation and HTTP boundaries, injectable in tests. */
  ensureImage?: typeof ensureDockerImage;
  probe?: typeof probeNodeStudio;
}

export async function startNodeStudio(input: NodeStudioStartInput, deps: NodeStudioRuntimeDeps = {}): Promise<NodeStudioIdentity> {
  const spec = nodeStudioStartInput.parse(input);
  if (isRedisFamily(spec.engine) && !spec.password) throw new HttpError(422, 'node_studio_credentials', 'Stored credentials are required for the node database Studio');
  if (spec.previous && (spec.previous.databaseId !== spec.databaseId || spec.previous.slug !== spec.slug || spec.previous.engine !== spec.engine)) throw changed();
  return withStudio(spec.databaseId, async () => {
    const transport = assertNodeStudioEnabled(), deadline = Date.now() + 180_000;
    const call: Caller = (method, path, body, ok, timeout = 10_000) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new HttpError(504, 'node_studio_timeout', 'Node Web Studio preparation timed out; retry shortly');
      return engineCall(transport, method, path, body, ok, Math.min(timeout, remaining));
    };
    let created: NodeStudioIdentity | undefined, attempted = false, expected: Omit<NodeStudioIdentity, 'containerId'> | undefined;
    const name = helperName(spec.databaseId);
    try {
      const selected = await databaseTarget(call, spec), image = studioImageForEngine(spec.engine);
      let imageReady: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          (deps.ensureImage ?? ensureDockerImage)(image.image, () => undefined),
          new Promise<never>((_resolve, reject) => { imageReady = setTimeout(() => reject(new HttpError(504, 'node_studio_image_pending', 'Web Studio image is not ready yet; retry shortly')), Math.max(1, Math.min(120_000, deadline - Date.now()))); imageReady.unref(); }),
        ]);
      } finally { clearTimeout(imageReady); }
      const imageReply = await call('GET', `/images/${enc(image.image)}/json`);
      const pinnedImage = z.object({ Id: imageId }).parse(JSON.parse(imageReply.body)).Id;
      let existing = await inspect(call, name), identity: NodeStudioIdentity;
      if (existing && spec.previous && !owns(existing, spec.previous)) throw changed();
      if (existing && spec.previous && (spec.previous.databaseContainerId !== selected.databaseContainerId || spec.previous.networkId !== selected.networkId || spec.previous.imageId !== pinnedImage)) {
        await removeOwned(call, spec.previous); existing = null;
      }
      const redisConfig = isRedisFamily(spec.engine) ? `NODE_CONFIG=${redisStudioConfig(dbName(spec.slug), 6379, spec.password!, spec.slug)}` : undefined;
      if (existing && redisConfig && !existing.Config.Env?.includes(redisConfig)) {
        const old = nodeStudioIdentity.safeParse({ databaseId: spec.databaseId, slug: spec.slug, engine: spec.engine, ...selected,
          containerId: existing.Id, imageId: pinnedImage, nonce: existing.Config.Labels?.['ninedeploy.studio.nonce'] });
        if (!old.success || !owns(existing, old.data)) throw changed();
        await removeOwned(call, old.data); existing = null;
      }
      if (existing) {
        const labels = existing.Config.Labels ?? {};
        const parsed = nodeStudioIdentity.safeParse({ databaseId: spec.databaseId, slug: spec.slug, engine: spec.engine, ...selected,
          containerId: existing.Id, imageId: pinnedImage, nonce: labels['ninedeploy.studio.nonce'] });
        if (!parsed.success) throw changed();
        identity = parsed.data;
        if (!owns(existing, identity)) throw changed();
      } else {
        expected = { databaseId: spec.databaseId, slug: spec.slug, engine: spec.engine, ...selected, imageId: pinnedImage, nonce: randomUUID() };
        const env = isRedisFamily(spec.engine)
          ? [redisConfig!, `URL_PREFIX=/v1/databases/${spec.databaseId}/studio-proxy`]
          : [`ADMINER_DEFAULT_SERVER=${dbName(spec.slug)}`];
        attempted = true;
        let reply: EngineResponse;
        try {
          reply = await call('POST', `/containers/create?name=${enc(name)}`, {
            Image: pinnedImage, Env: env, Labels: labelsFor(expected),
            HostConfig: { NetworkMode: selected.networkId, RestartPolicy: { Name: 'unless-stopped' },
              CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], PidsLimit: 128, Memory: 256 * 1024 * 1024, NanoCpus: 500_000_000,
              PublishAllPorts: false, PortBindings: {} },
            NetworkingConfig: { EndpointsConfig: { [networkName(spec.slug)]: { NetworkID: selected.networkId } } },
          });
        } catch (error) { if (error instanceof DockerEngineError && error.status === 409) { attempted = false; throw changed(); } throw error; }
        const id = z.object({ Id: fullId }).parse(JSON.parse(reply.body)).Id;
        identity = { ...expected, containerId: id }; created = identity;
      }
      await call('POST', `/containers/${identity.containerId}/start`, undefined, [304]);
      const readyDeadline = Math.min(deadline, Date.now() + 30_000);
      while (Date.now() < readyDeadline) {
        const target = await resolveNodeStudioHttpTarget(identity, readyDeadline);
        const path = isRedisFamily(spec.engine) ? `/v1/databases/${spec.databaseId}/studio-proxy/` : '/';
        if (await (deps.probe ?? probeNodeStudio)(target, path)) { await target.verify(); return identity; }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new HttpError(504, 'node_studio_not_ready', 'Node Web Studio did not become ready');
    } catch (error) {
      if (attempted && expected) {
        try {
          const cleanupCall = caller(transport);
          if (!created) { const helper = await inspect(cleanupCall, name); if (helper) created = { ...expected, containerId: helper.Id }; }
          if (created) await removeOwned(cleanupCall, created);
        } catch { throw new HttpError(502, 'node_studio_cleanup_unconfirmed', 'Node Web Studio failed and cleanup could not be confirmed'); }
      }
      if (error instanceof HttpError) throw error;
      throw failed();
    }
  });
}
