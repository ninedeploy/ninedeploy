import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { EgressBlockedError, isPrivateAddress, privateEgressAllowed } from './egressGuard.js';

/**
 * SSRF gate for server-side repository checkouts. Deploys, PR previews and
 * pre-deploy inspections all fetch user-supplied remote URLs from the panel's
 * network position — next to every managed container and, on cloud VMs, the
 * instance metadata service. Gate each supported transport (https, ssh://,
 * scp-style `git@host:path`) through the shared egress policy before the
 * checkout module does any work. Self-hosted LAN remotes keep working via
 * `NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1`, exactly like notification webhooks.
 *
 * This module deliberately contains no child-process usage at all — it only
 * parses URLs and decides whether a checkout may start.
 */

/** Hostname → public-only, or EgressBlockedError. Same DNS stance as
 * `assertPublicHttpUrl`: EVERY resolved answer must be public, since which
 * one git ends up dialing is not ours to choose.
 *
 * Returns the vetted addresses (r355) so the caller can pin git to them, or
 * null when there was nothing to resolve (an IP literal or an empty host). */
async function rejectIfPrivateHost(host: string, target: string): Promise<string[] | null> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (!bare) return null; // nothing to judge — the schema layer rejects it upstream
  if (isIP(bare)) {
    if (isPrivateAddress(bare)) {
      throw new EgressBlockedError(target, `${bare} is a private or link-local address`);
    }
    return null;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(bare, { all: true });
  } catch {
    throw new EgressBlockedError(target, `the hostname ${bare} could not be resolved`);
  }
  if (addresses.length === 0) {
    throw new EgressBlockedError(target, `the hostname ${bare} resolved to no addresses`);
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new EgressBlockedError(target, `${bare} resolves to the private address ${address}`);
    }
  }
  return addresses.map(({ address }) => address);
}

/**
 * r355 (was r099b): the addresses the gate vetted for an http(s) remote, so
 * git dials exactly those instead of resolving the name a second time.
 *
 * Without the pin the gate's answer was thrown away: git (libcurl) resolved
 * the hostname again moments later, and a DNS server with a zero TTL could
 * answer the gate with a public address and git with 169.254.169.254 or a LAN
 * host (DNS rebinding) — the checkout then ran from the panel's network
 * position against an address the gate never saw.
 */
export interface CloneTargetPin {
  host: string;
  port: number;
  addresses: string[];
}

/**
 * The `http.curloptResolve` value (libcurl CURLOPT_RESOLVE, git ≥ 2.37) that
 * pins `host:port` to the vetted addresses. The URL keeps its hostname, so
 * TLS SNI, certificate verification and the Host header still use the name —
 * only the TCP connect target is fixed. IPv6 addresses are bracketed, as
 * CURLOPT_RESOLVE requires.
 */
export function curlResolveEntry(pin: CloneTargetPin): string {
  const addrs = pin.addresses.map((a) => (isIP(a) === 6 ? `[${a}]` : a)).join(',');
  return `${pin.host}:${pin.port}:${addrs}`;
}

/** Host part of an scp-style remote of the shape produced by `toSshUrl`
 * (`git@<host>:<path>`), or null when it does not match that shape. */
function scpStyleHost(remote: string): string | null {
  if (!remote.startsWith('git@')) return null;
  const at = remote.indexOf('@');
  const colon = remote.indexOf(':', at);
  if (at < 0 || colon <= at + 1) return null;
  return remote.slice(at + 1, colon) || null;
}

/**
 * Gate a remote and, for http(s) hostnames, return the vetted addresses git
 * must be pinned to (see `CloneTargetPin`). null means there is nothing to
 * pin: private egress is allowed, the host is an IP literal, or the transport
 * is not http(s).
 *
 * Residual gap (r355): ssh (`ssh://`, scp-style `git@host:path`) and `git://`
 * remotes are vetted here but NOT pinned — git hands the hostname to ssh or
 * to its own connect code, neither of which has a per-invocation resolve
 * override that keeps host-key / submodule semantics intact. A rebinding DNS
 * server can therefore still steer those two transports between this check
 * and git's connect. Remote-node builds (engine/builders/remote*.ts) run git
 * on the node through the agent, which resolves from its own network position;
 * the panel-side gate there is advisory and is not pinned either.
 */
export async function vetCloneTarget(repoUrl: string): Promise<CloneTargetPin | null> {
  if (privateEgressAllowed()) return null;
  if (/^https?:\/\//i.test(repoUrl)) {
    let url: URL;
    try {
      url = new URL(repoUrl);
    } catch {
      throw new EgressBlockedError(repoUrl, 'it is not a valid URL');
    }
    const addresses = await rejectIfPrivateHost(url.hostname, repoUrl);
    if (!addresses) return null;
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    return { host: url.hostname, port, addresses };
  }
  if (repoUrl.startsWith('git://')) {
    // Git protocol (port 9418) — simple-git supports it. Without this guard a
    // user-supplied git:// URL to a private host bypasses the DNS-resolution
    // check entirely, enabling SSRF: git://169.254.169.254/… reaches the cloud
    // metadata service, and git://<private-LAN>/… reaches internal Git servers.
    let url: URL;
    try {
      url = new URL(repoUrl);
    } catch {
      return null; // malformed URL is the schema's job, not a dial risk
    }
    await rejectIfPrivateHost(url.hostname, repoUrl);
    return null;
  }

  if (repoUrl.startsWith('ssh://')) {
    let url: URL;
    try {
      url = new URL(repoUrl);
    } catch {
      return null; // malformed non-http URL is the schema's job, not a dial risk
    }
    await rejectIfPrivateHost(url.hostname, repoUrl);
    return null;
  }
  const host = scpStyleHost(repoUrl);
  if (host) await rejectIfPrivateHost(host, repoUrl);
  return null;
}

/** Gate-only form for callers that do not run git themselves. */
export async function assertCloneTargetAllowed(repoUrl: string): Promise<void> {
  await vetCloneTarget(repoUrl);
}
