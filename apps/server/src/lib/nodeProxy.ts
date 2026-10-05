import type { DB } from '@ninedeploy/db';
import { agentOp } from './agentClient.js';
import { getAcmeEmail, getDnsConfig, renderDynamicConfig, renderStaticConfig } from '../engine/proxy.js';

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
 * Every function here is best-effort and never throws: a node whose proxy
 * could not be refreshed keeps serving its previous config, and the result
 * says so. r521: the CALLER decides what a failure means — a deploy to that
 * very node fails its PROXY_SWAP and keeps the previous runtime (the new
 * container is unrouted there), while a refresh of any other node is audited
 * and retried by the next routing write.
 */

/** Result of one sync attempt, for the caller's log line. */
export interface NodeProxySyncResult {
  ok: boolean;
  /** Populated when `ok` is false. */
  reason?: string;
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
  opts: { ensureContainer?: boolean } = {},
): Promise<NodeProxySyncResult> {
  let ensureStarted = false;
  try {
    const [acmeEmail, dns] = await Promise.all([getAcmeEmail(db), getDnsConfig(db)]);
    const staticConfig = renderStaticConfig(acmeEmail, dns);
    const dynamicConfig = await renderDynamicConfig(db, { serverId });

    const sink = (line: string) => log(`  node proxy: ${line}`);
    const wroteStatic = await agentOp(
      db, serverId, 'proxy.writeConfig', { kind: 'static', content: staticConfig }, sink,
    );
    await agentOp(db, serverId, 'proxy.writeConfig', { kind: 'dynamic', content: dynamicConfig }, sink);

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
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // r416: the failure honestly depends on WHERE it happened. `proxy.ensure`
    // recreates the proxy with rm+run — if THAT op failed, the node's only
    // proxy is down and every domain on the node is dark until the next
    // successful sync (the old "keeps serving its previous routing" message
    // was a lie in exactly this case).
    log(
      ensureStarted
        ? `⚠ node proxy sync failed: ${reason}. THE NODE'S PROXY IS DOWN — every domain on this node answers nothing until the next successful sync. Retry from Settings or re-run a deploy.`
        : `⚠ node proxy sync failed: ${reason}. The config write failed before the proxy was touched; the node keeps serving its previous routing.`,
    );
    return { ok: false, reason };
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
): Promise<Array<NodeProxySyncResult & { serverId: number }>> {
  const unique = [...new Set(serverIds.filter((id) => Number.isInteger(id) && id > 0))];
  // r521: per-node outcomes go back to the caller — writeDynamicConfig fails
  // a deploy whose OWN node could not be updated, and audits the rest.
  const results: Array<NodeProxySyncResult & { serverId: number }> = [];
  for (const id of unique) {
    // Sequential on purpose: a fleet refresh is not latency-critical and a
    // burst of parallel agent calls is a good way to trip an agent's rate
    // limit (120/min) during a mass domain change.
    results.push({ serverId: id, ...(await syncNodeProxy(db, id, log)) });
  }
  return results;
}
