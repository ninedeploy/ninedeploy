import type { DB } from '@ninedeploy/db';
import { createHash } from 'node:crypto';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { capabilityRefusal } from './agentCapabilities.js';
import { getAcmeEmail, getDnsConfig, renderDynamicConfig, renderStaticConfig } from '../engine/proxy.js';
import { NODE_DYNAMIC_WARN_BYTES } from './customCertificates.js';
import { withRoutingAck } from './proxyRoutingAck.js';

/**
 * Keep a node's own reverse proxy in step with the panel's model of it.
 *
 * Each remote node terminates TLS for the services that run on it. That is the
 * model Coolify and Dokploy use, and it is the only one where production
 * traffic does NOT hairpin through the panel: the operator points the domain at
 * the NODE and the node answers, so the panel host is not a bandwidth
 * bottleneck or a single point of failure for every deployed app.
 *
 * The panel stays the source of truth for domains, middlewares and certificate
 * policy — it renders both Traefik configs with the SAME functions that
 * generate its own (`renderStaticConfig` / `renderDynamicConfig`) — and the
 * agent only writes the rendered text to a fixed location and runs the
 * container. Nothing about the destination path is caller-supplied.
 *
 * Scoping matters: `renderDynamicConfig` is asked for this node's services
 * only. A router's upstream is a CONTAINER NAME resolved over the local Docker
 * network, so a config that named another machine's containers would answer
 * 502 for every one of them.
 *
 * Functions return per-node results instead of throwing. A failed transport
 * response after a dynamic write does not prove which routing is loaded.
 * The caller preserves both generations in that case; a background refresh
 * is audited and retried by the next routing write.
 */

/** Result of one sync attempt, for the caller's log line. */
export interface NodeProxySyncResult {
  ok: boolean;
  /** Populated when `ok` is false. */
  reason?: string;
  /** The write may have landed even if its transport response was lost. */
  routingUnconfirmed?: boolean;
}

/**
 * Push the static + dynamic Traefik configuration to a node and make sure its
 * proxy container is running.
 *
 * `proxy.ensure` recreates the container, so it is only called when the STATIC
 * configuration changed (or on the first sync) — a dynamic-only change is
 * picked up by Traefik's file watcher without an ingress interruption.
 */
export async function syncNodeProxy(
  db: DB,
  serverId: number,
  log: (line: string) => void = () => undefined,
  opts: { ensureContainer?: boolean; confirmRouting?: boolean } = {},
): Promise<NodeProxySyncResult> {
  let ensureStarted = false;
  let routingMayHaveChanged = false;
  try {
    if (opts.confirmRouting) {
      const sealed = await agentTransportSealed(db, serverId);
      const refusal = await capabilityRefusal((op, params, sink) => agentOp(db, serverId, op, params, sink), `#${serverId}`, sealed,
        { cap: 'proxy.routingAck', feature: 'confirm loaded HTTP/TLS routing', sealedRequired: true });
      if (refusal) throw new Error(refusal.message);
    }
    const [acmeEmail, dns] = await Promise.all([getAcmeEmail(db), getDnsConfig(db)]);
    const staticConfig = renderStaticConfig(acmeEmail, dns);
    const dynamicConfig = await renderDynamicConfig(db, { serverId });
    const writtenDynamic = opts.confirmRouting ? withRoutingAck(dynamicConfig) : dynamicConfig;

    const sink = (line: string) => log(`  node proxy: ${line}`);
    // 0.14: uploaded certificates are inlined into the node's single dynamic
    // file, and the agent refuses one above 1 MiB. Say so well before that.
    const bytes = Buffer.byteLength(writtenDynamic, 'utf8');
    if (bytes > NODE_DYNAMIC_WARN_BYTES) {
      log(
        `⚠ node proxy: the dynamic config for node #${serverId} is ${Math.round(bytes / 1024)} KiB ` +
          '(uploaded certificates are inlined); the agent refuses anything above 1 MiB.',
      );
    }
    const wroteStatic = await agentOp(
      db, serverId, 'proxy.writeConfig', { kind: 'static', content: staticConfig }, sink,
    );
    routingMayHaveChanged = true;
    await agentOp(db, serverId, 'proxy.writeConfig', { kind: 'dynamic', content: writtenDynamic }, sink);

    // Traefik reads the DYNAMIC file through a watcher but the STATIC one only
    // at start-up, so the container has to be recreated when the static config
    // changed — and only then, because `proxy.ensure` is a `rm -f` + `run` and
    // doing that on every domain edit would turn each one into a brief ingress
    // outage on the node.
    // `unchanged` also ends in "changed" — compare the last WORD, not a suffix.
    const staticChanged = wroteStatic.lines.some(
      (l) => l.startsWith('proxy-config ') && l.trim().split(/\s+/).at(-1) === 'changed',
    );
    const running = await nodeProxyRunning(db, serverId);
    if (opts.ensureContainer === true || staticChanged || !running) {
      log(
        running
          ? '  node proxy: static configuration changed — recreating the proxy to apply it'
          : '  node proxy: not running on the node — starting it',
      );
      ensureStarted = true;
      await agentOp(db, serverId, 'proxy.ensure', {}, sink);
    }
    if (opts.confirmRouting) {
      const receipt = await agentOp(db, serverId, 'proxy.confirmRouting', { content: dynamicConfig }, () => undefined);
      const expected = `ND-PROXY-ROUTING ${createHash('sha256').update(dynamicConfig).digest('hex')}`;
      if (!receipt.lines.includes(expected)) throw new Error('The node did not confirm the requested routing generation');
    }
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // After a dynamic write or ensure, an error cannot establish which
    // generation is serving (or whether the proxy is running at all).
    log(
      ensureStarted
        ? `⚠ node proxy sync failed: ${reason}. THE NODE'S PROXY IS DOWN OR ITS ROUTING IS UNCONFIRMED — retry from Settings or re-run a deploy; keep both runtime generations running.`
        : routingMayHaveChanged
          ? `⚠ node proxy sync failed: ${reason}. Routing may already have changed; keep both runtime generations running until the loaded configuration is confirmed.`
          : `⚠ node proxy sync failed: ${reason}. The config write failed before the proxy was touched; the node keeps serving its previous routing.`,
    );
    return { ok: false, reason, ...(routingMayHaveChanged ? { routingUnconfirmed: true } : {}) };
  }
}

/**
 * Whether the node's proxy container is up right now.
 *
 * Treated as "not running" on any failure: starting a proxy that is already
 * healthy costs a second of ingress on that node, while never starting one
 * leaves every domain on it dark.
 */
async function nodeProxyRunning(db: DB, serverId: number): Promise<boolean> {
  try {
    const res = await agentOp(db, serverId, 'docker.inspect', { name: 'ninedeploy-proxy', format: 'state' }, () => undefined);
    return res.lines.some((l) => l.trim().startsWith('running'));
  } catch {
    return false;
  }
}

/**
 * Refresh the proxies of every node that has at least one service, plus
 * nothing else — the panel's own proxy is written by
 * `engine/proxy.writeDynamicConfig`, which the same callers already invoke.
 *
 * Used by the domain routes: a domain attached to a remote service changes
 * that NODE's routing, and writing only the panel's config would leave the
 * node serving a stale route table.
 */
export async function syncAllNodeProxies(
  db: DB,
  serverIds: number[],
  log: (line: string) => void = () => undefined,
  opts: { confirmNode?: number } = {},
): Promise<Array<NodeProxySyncResult & { serverId: number }>> {
  const unique = [...new Set(serverIds.filter((id) => Number.isInteger(id) && id > 0))];
  // r521: per-node outcomes go back to the caller — writeDynamicConfig fails
  // a deploy whose OWN node could not be updated, and audits the rest.
  const results: Array<NodeProxySyncResult & { serverId: number }> = [];
  for (const id of unique) {
    // Sequential on purpose: a fleet refresh is not latency-critical and a
    // burst of parallel agent calls is a good way to trip an agent's rate
    // limit (120/min) during a mass domain change.
    results.push({ serverId: id, ...(await syncNodeProxy(db, id, log, { confirmRouting: opts.confirmNode === id })) });
  }
  return results;
}
