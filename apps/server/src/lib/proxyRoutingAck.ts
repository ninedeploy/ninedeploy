import { createHash } from 'node:crypto';
import { load, dump } from 'js-yaml';
import { capture, sleep } from './exec.js';
import { TRAEFIK_CONTAINER } from '../engine/dockerNames.js';

export const ROUTING_ACK_HOST = 'ninedeploy-routing.invalid';
export const ROUTING_ACK_TIMEOUT_MS = 15_000;

/** A write may already be serving: neither generation may be stopped blindly. */
export class ProxyRoutingUnconfirmed extends Error {
  constructor(message = 'Traefik did not confirm the requested routing configuration; keep both runtime generations running') {
    super(message);
    this.name = 'ProxyRoutingUnconfirmed';
  }
}

type Dict = Record<string, unknown>;
const dict = (value: unknown): value is Dict => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The marker and managed routes travel in one atomic file generation. */
export function routingAckConfig(routes: string): string {
  const generation = createHash('sha256').update(routes).digest('hex');
  return dump({ http: {
    routers: { nd_routing_ack: {
      rule: `Host(\`${ROUTING_ACK_HOST}\`) && Path(\`/api/rawdata\`)`,
      entryPoints: ['web'], service: 'api@internal', priority: 1_000_001,
      middlewares: ['nd_routing_local', 'nd_routing_generation'],
    }, nd_routing_ack_tls: {
      rule: `Host(\`${ROUTING_ACK_HOST}\`) && Path(\`/api/rawdata\`)`,
      entryPoints: ['websecure'], service: 'api@internal', tls: {}, priority: 1_000_001,
      middlewares: ['nd_routing_local', 'nd_routing_generation'],
    } },
    middlewares: {
      nd_routing_local: { ipAllowList: { sourceRange: ['127.0.0.1/32', '::1/128'] } },
      nd_routing_generation: { headers: { customResponseHeaders: { 'X-NineDeploy-Generation': generation } } },
    },
  } }, { lineWidth: -1 });
}

export function withRoutingAck(routes: string): string {
  const parsed = load(routes);
  const generated: Dict = dict(parsed) ? parsed : {};
  const receipt = load(routingAckConfig(routes)) as { http: Dict };
  const http = dict(generated.http) ? generated.http : {};
  const merged = { ...http };
  for (const kind of ['routers', 'middlewares']) {
    merged[kind] = { ...(dict(http[kind]) ? http[kind] : {}), ...(receipt.http[kind] as Dict) };
  }
  return dump({ ...generated, http: merged }, { lineWidth: -1 });
}

function subset(expected: unknown, actual: unknown, field = ''): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => subset(v, actual[i], field));
  if (dict(expected)) return dict(actual) && Object.entries(expected).every(([k, v]) => Object.hasOwn(actual, k) ? subset(v, actual[k], k) : v === false);
  if (typeof expected === 'string') expected = expected.replaceAll('{{`{{`}}', '{{');
  // Traefik qualifies middleware and weighted-service references at runtime.
  if (typeof expected === 'string' && ['middlewares', 'service', 'name'].includes(field) && /^[A-Za-z0-9_-]+$/.test(expected)
    && actual === `${expected}@file`) return true;
  return expected === actual;
}

/** Check the requested generation AND every generated HTTP definition, not a ping. */
export function routingIsApplied(routes: string, observed: unknown): boolean {
  if (!dict(observed)) return false;
  const generated = load(routes) as { http?: Dict };
  const receipt = load(routingAckConfig(routes)) as { http: Dict };
  for (const kind of ['routers', 'services', 'middlewares']) {
    const expected = { ...(dict(generated?.http?.[kind]) ? generated.http[kind] : {}),
      ...(dict(receipt.http[kind]) ? receipt.http[kind] : {}) };
    const actual = observed[kind];
    if (!dict(actual)) return false;
    for (const [name, config] of Object.entries(expected)) {
      const entry = actual[`${name}@file`];
      if (!dict(entry) || entry.status !== 'enabled' || !subset(config, entry)) return false;
    }
  }
  return true;
}

/** Only Docker exec can reach this API route: no published management port. */
export function routingProbeArgs(container: string, tls: boolean): string[] {
  return ['exec', container, 'sh', '-c', `wget -qSO- -T 2 ${tls ? '--no-check-certificate ' : ''}--header 'Host: ${ROUTING_ACK_HOST}' ${tls ? 'https' : 'http'}://127.0.0.1/api/rawdata 2>&1`];
}

/** Validate one private API response without returning or logging its body. */
export function routingReplyIsApplied(routes: string, raw: string): boolean {
  try {
    const header = /^\s*X-NineDeploy-Generation:\s*([a-f0-9]{64})\s*$/im.exec(raw)?.[1];
    return header === createHash('sha256').update(routes).digest('hex') && routingIsApplied(routes, JSON.parse(raw.slice(raw.indexOf('{'))));
  } catch { return false; }
}

export async function confirmProxyRouting(routes: string, opts: {
  read?: (remainingMs: number, tls: boolean) => Promise<string>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
} = {}): Promise<void> {
  const now = opts.now ?? Date.now;
  const wait = opts.wait ?? sleep;
  const deadline = now() + ROUTING_ACK_TIMEOUT_MS;
  const read = opts.read ?? ((remainingMs: number, tls: boolean) => capture('docker', routingProbeArgs(TRAEFIK_CONTAINER, tls),
  { timeoutMs: Math.min(3000, remainingMs), maxOutputBytes: 4 * 1024 * 1024 }));
  while (now() < deadline && !opts.signal?.aborted) {
    try {
      let confirmed = true;
      // Entry-point handlers are swapped separately: observe both HTTP and TLS.
      for (const tls of [false, true]) {
        if (now() >= deadline || opts.signal?.aborted) { confirmed = false; break; }
        const raw = await read(Math.max(1, deadline - now()), tls);
        if (!routingReplyIsApplied(routes, raw)) { confirmed = false; break; }
      }
      if (confirmed && !opts.signal?.aborted) return;
    } catch { /* Never log API bodies or private configuration. Retry boundedly. */ }
    if (now() < deadline && !opts.signal?.aborted) await wait(Math.min(250, deadline - now()));
  }
  throw new ProxyRoutingUnconfirmed();
}
