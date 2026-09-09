import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { servers, type DB } from '@ninedeploy/db';
import { decrypt, randomToken } from './crypto.js';
import { open as openSealed, seal } from './agentSeal.js';
import { sha256 } from './crypto.js';
import { timingSafeEqual } from 'node:crypto';

/**
 * Agent protocol: the remote host runs the same server binary with
 * NINEDEPLOY_AGENT=1. It exposes POST /agent/exec { op, params } where `op`
 * names a TYPED operation from the agent's fixed table (the request never
 * carries a program or raw argv) — see src/agent.ts. Auth is a shared token
 * (encrypted at rest in the servers table).
 */

export interface AgentOpResult {
  exitCode: number;
  lines: string[];
}

/** Generate a fresh agent token (raw value stored encrypted, shown once). */
export function generateAgentToken(): string {
  return randomToken(32);
}

/** Constant-time sha256 token comparison (used by the agent endpoint). */
export function tokenMatches(rawToken: string, storedSha256: string): boolean {
  const a = Buffer.from(sha256(rawToken));
  const b = Buffer.from(storedSha256);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Per-process cache of "this agent DEFINITELY speaks the sealed transport".
 *
 * Only a `sealed: true` answer is ever cached, and the probe endpoint is
 * unauthenticated — an on-path attacker can answer it however they like. With
 * the cleartext fallback off (the default), a forged `sealed: false` can only
 * make the operation fail closed, never downgrade it; caching the forgery
 * would change nothing security-wise, but re-probing keeps a transiently
 * broken probe from poisoning every later decision. Exported for tests, which
 * need to reset it between cases.
 */
const sealedSupport = new Map<number, boolean>();
export const _resetSealedSupportCache = (): void => void sealedSupport.clear();

/**
 * Cleartext fallback to the legacy plaintext transport is OPT-IN.
 *
 * Whether the agent supports encryption was decided by an unauthenticated
 * `GET /agent/ping`, and the fallback fired by default — so one forged probe
 * answer silently sent the raw agent token (full remote-execution authority)
 * and the decrypted service secrets in `file.writeEnv` over plaintext HTTP.
 * The door is now closed unless the operator opens it explicitly with
 * `NINEDEPLOY_AGENT_ALLOW_CLEARTEXT=1`; `NINEDEPLOY_AGENT_REQUIRE_SEALED=1`
 * keeps working as the stricter alias and always wins.
 */
const cleartextFallbackAllowed = (): boolean =>
  process.env['NINEDEPLOY_AGENT_ALLOW_CLEARTEXT'] === '1' &&
  process.env['NINEDEPLOY_AGENT_REQUIRE_SEALED'] !== '1';

/** Ask an agent whether it speaks the sealed protocol (cached per server). */
async function supportsSealed(serverId: number, host: string, port: number): Promise<boolean> {
  const cached = sealedSupport.get(serverId);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(`http://${host}:${port}/agent/ping`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { sealed?: unknown };
    const supported = body.sealed === true;
    // Only the AFFIRMATIVE answer is cached. `sealed: false` (or a dropped
    // probe) must not pin this server to anything for the rest of the
    // process's life — with the fallback off by default, a forged `false`
    // just fails this one operation closed and the next call re-probes.
    if (supported) sealedSupport.set(serverId, true);
    return supported;
  } catch {
    // Unreachable right now just means "cannot confirm"; the operation itself
    // fails with a better message a moment later, and the next call re-probes.
    return false;
  }
}

/**
 * Run one typed operation on a remote agent. `sink` receives output lines;
 * non-zero exit codes throw (callers treat remote failures like local ones).
 *
 * The request is SEALED when the agent supports it (see lib/agentSeal.ts): the
 * token stops crossing the network, and so do the decrypted service secrets
 * that `file.writeEnv` carries. An agent that does not advertise sealing fails
 * the operation closed unless the operator opted into the plaintext fallback
 * with NINEDEPLOY_AGENT_ALLOW_CLEARTEXT=1 (a warning names the host).
 */
export async function agentOp(
  db: DB,
  serverId: number,
  op: string,
  params: Record<string, unknown>,
  sink: (line: string) => void,
): Promise<AgentOpResult> {
  const row = await db.query.servers.findFirst({ where: eq(servers.id, serverId) });
  if (!row) throw new Error('Unknown server');
  const token = decrypt(row.tokenEncrypted);
  // The agent is configured with the HASH of the token, never the raw value,
  // so the hash is the only secret both ends hold — and therefore the key
  // material for the envelope.
  const shared = sha256(token);

  const sealedOk = await supportsSealed(serverId, row.host, row.port);
  if (!sealedOk) {
    if (!cleartextFallbackAllowed()) {
      throw new Error(
        `agent ${row.host}:${row.port} does not support the encrypted transport. The cleartext ` +
          'fallback is disabled by default because the request carries the agent token and ' +
          'decrypted service secrets; upgrade the agent, or set NINEDEPLOY_AGENT_ALLOW_CLEARTEXT=1 ' +
          'to explicitly accept plaintext for a not-yet-upgraded fleet.',
      );
    }
    sink(
      `⚠ agent ${row.host}:${row.port} is running an older build: this request (and any secrets in it) ` +
        'travels unencrypted. Upgrade the agent, or unset NINEDEPLOY_AGENT_ALLOW_CLEARTEXT to stop.',
    );
  }

  // Request-response binding: a fresh nonce travels inside the sealed request
  // and must come back inside the sealed reply. Without it, any envelope
  // captured within the five-minute replay window could be replayed as a
  // "successful" answer to a different operation.
  const nonce = randomBytes(16).toString('hex');

  const res = await fetch(`http://${row.host}:${row.port}/agent/exec`, {
    method: 'POST',
    headers: sealedOk
      ? { 'content-type': 'application/json' }
      : { 'content-type': 'application/json', 'x-agent-token': token },
    body: JSON.stringify(sealedOk ? { sealed: seal(shared, { op, params, nonce }) } : { op, params }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`agent ${op} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const raw = (await res.json()) as { sealed?: unknown; lines?: unknown; exitCode?: unknown; nonce?: unknown };
  // Fail closed on a response that does not honour the transport the request
  // used: a sealed request MUST get a sealed, verifying reply. Accepting
  // whatever came back would let an on-path attacker fabricate success and
  // fake command output for a deployment the panel then reports as live.
  if (sealedOk && raw.sealed === undefined) {
    throw new Error(`agent ${op}: response to a sealed request was not sealed — possible tampering, refusing it`);
  }
  let body: { lines?: unknown; exitCode?: unknown; nonce?: unknown };
  if (raw.sealed !== undefined) {
    try {
      body = openSealed<{ lines?: unknown; exitCode?: unknown; nonce?: unknown }>(shared, raw.sealed);
    } catch {
      throw new Error(`agent ${op}: sealed response failed verification — refusing it`);
    }
    if (sealedOk && body.nonce !== nonce) {
      throw new Error(`agent ${op}: sealed response does not match this request (bad nonce) — refusing it`);
    }
  } else {
    body = raw;
  }
  const lines = Array.isArray(body.lines) ? body.lines.map(String) : [];
  for (const l of lines) sink(l);
  const exitCode = Number(body.exitCode) || 0;
  if (exitCode !== 0) throw new Error(`agent ${op} exited with ${exitCode}`);
  return { exitCode, lines };
}

/** Probe an agent's reachability + auth (used by the servers routes + UI). */
export async function agentPing(host: string, port: number, token: string): Promise<void> {
  const res = await fetch(`http://${host}:${port}/agent/ping`, {
    headers: { 'x-agent-token': token },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`agent unreachable (${res.status})`);
}
