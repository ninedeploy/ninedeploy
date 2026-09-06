import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { EgressBlockedError, assertPublicHttpUrl, isPrivateAddress, privateEgressAllowed } from './egressGuard.js';

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
 * one git ends up dialing is not ours to choose. */
async function rejectIfPrivateHost(host: string, target: string): Promise<void> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (!bare) return; // nothing to judge — the schema layer rejects it upstream
  if (isIP(bare)) {
    if (isPrivateAddress(bare)) {
      throw new EgressBlockedError(target, `${bare} is a private or link-local address`);
    }
    return;
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

export async function assertCloneTargetAllowed(repoUrl: string): Promise<void> {
  if (privateEgressAllowed()) return;
  if (/^https?:\/\//i.test(repoUrl)) {
    await assertPublicHttpUrl(repoUrl);
    return;
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
      return; // malformed URL is the schema's job, not a dial risk
    }
    await rejectIfPrivateHost(url.hostname, repoUrl);
    return;
  }

  if (repoUrl.startsWith('ssh://')) {
    let url: URL;
    try {
      url = new URL(repoUrl);
    } catch {
      return; // malformed non-http URL is the schema's job, not a dial risk
    }
    await rejectIfPrivateHost(url.hostname, repoUrl);
    return;
  }
  const host = scpStyleHost(repoUrl);
  if (host) await rejectIfPrivateHost(host, repoUrl);
}
