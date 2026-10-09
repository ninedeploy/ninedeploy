import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { isIPv6 } from 'node:net';
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

/**
 * r526: the operations that build or bring up a release. Every agent op used
 * to share one budget — 595 s on the node (lib/spawnValidated), 600 s on the
 * panel — while the same build on the panel host gets the 30-minute exec
 * timeout, so a remote build the panel host would have finished was killed
 * halfway. These ops get the local budget on both sides: the agent arms its
 * child with {@link AGENT_LONG_OP_TIMEOUT_MS}, the panel waits that long plus
 * a margin. An agent older than this release keeps its own 595 s cap and
 * ignores the panel's longer wait; the timeout error says which side gave up.
 *
 * `docker.pull` stays short on purpose (r417: a node pull fails fast).
 *
 * Multi-node (design §1.1): node builds with Nixpacks and Railpack and a
 * registry push take a build's time too. An agent that predates them never
 * advertises their capability, so the panel never sends them there.
 */
export const LONG_AGENT_OPS: ReadonlySet<string> = new Set([
  'docker.build',
  'docker.composeUp',
  'docker.composePull',
  'build.nixpacks',
  'build.railpack',
  'docker.push',
]);
/** Node-side child timeout for {@link LONG_AGENT_OPS} — the panel host's exec default. */
export const AGENT_LONG_OP_TIMEOUT_MS = 30 * 60 * 1000;
/** Panel-side request budget for every other op (just above the agent's 595 s child cap). */
const SHORT_OP_REQUEST_MS = 600_000;
/** Exit code the agent reports for a child it killed on its timeout (GNU `timeout`). */
const AGENT_TIMEOUT_EXIT = 124;

/** The agent-side child timeout for `op`, or undefined for the agent's default. */
export function agentChildTimeoutMs(op: string): number | undefined {
  return LONG_AGENT_OPS.has(op) ? AGENT_LONG_OP_TIMEOUT_MS : undefined;
}

/** How long the panel waits for `op`'s answer. */
export function agentRequestTimeoutMs(op: string): number {
  return LONG_AGENT_OPS.has(op) ? AGENT_LONG_OP_TIMEOUT_MS + 30_000 : SHORT_OP_REQUEST_MS;
}

/** Minimal response shape both transports below produce. */
interface ExecResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** Thrown when the panel gave up waiting for an agent's answer. */
class AgentRequestTimeout extends Error {}

/**
 * r526: POST for a long op. Node's built-in fetch cannot wait for one: its
 * dispatcher aborts any response whose HEADERS take longer than 300 s, and the
 * agent answers only once the op has finished — so every remote build longer
 * than five minutes died panel-side as a bare "fetch failed" while it kept
 * running on the node. node:http has no such cap; the hard timer below is the
 * budget. Redirects are never followed (a 3xx is simply not ok), matching the
 * `redirect: 'error'` the fetch path uses.
 */
function postWithoutHeadersTimeout(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<ExecResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => text,
            json: async () => JSON.parse(text) as unknown,
          });
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new AgentRequestTimeout()), timeoutMs);
    timer.unref?.();
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(body);
  });
}

/** True for every way a request can die of a timeout (fetch's signal, undici's header cap, ours). */
function isTimeoutError(err: unknown): boolean {
  if (err instanceof AgentRequestTimeout) return true;
  const e = err as { name?: string; cause?: { code?: string; name?: string } } | null;
  return (
    e?.name === 'TimeoutError' ||
    e?.cause?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
    e?.cause?.code === 'UND_ERR_BODY_TIMEOUT' ||
    e?.cause?.name === 'HeadersTimeoutError'
  );
}

/**
 * F892: the agent's base URL. A bare IPv6 literal (the SSH bootstrap accepts
 * one and stores it whole) must be bracketed, or `http://2001:db8::1:4600`
 * is not a URL at all.
 */
const agentBaseUrl = (host: string, port: number): string => `http://${isIPv6(host) ? `[${host}]` : host}:${port}`;

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
const sealedSupport = new Map<number, { host: string; port: number }>();
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
  if (cached?.host === host && cached.port === port) return true;
  try {
    const res = await fetch(`${agentBaseUrl(host, port)}/agent/ping`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { sealed?: unknown };
    const supported = body.sealed === true;
    // Only the AFFIRMATIVE answer is cached. `sealed: false` (or a dropped
    // probe) must not pin this server to anything for the rest of the
    // process's life — with the fallback off by default, a forged `false`
    // just fails this one operation closed and the next call re-probes.
    if (supported) sealedSupport.set(serverId, { host, port });
    return supported;
  } catch {
    // Unreachable right now just means "cannot confirm"; the operation itself
    // fails with a better message a moment later, and the next call re-probes.
    return false;
  }
}

/**
 * 0.16 T7 (security review L4): ops the panel sends only inside a sealed
 * envelope, refused in {@link agentOp} on any other transport — the agent
 * refuses them too, but the panel must not send the join token in clear in
 * the first place.
 */
export const SEALED_ONLY_AGENT_OPS: ReadonlySet<string> = new Set(['swarm.info', 'swarm.join', 'swarm.leave']);
export const isSealedOnlyAgentOp = (op: string): boolean => SEALED_ONLY_AGENT_OPS.has(op) || op.startsWith('swarm.');

/**
 * 0.13 (T5): whether operations to this node travel inside the sealed
 * envelope. A per-job Git credential is only ever offered to a node that
 * answers yes — and {@link agentOp} refuses to send one in clear regardless.
 * Unknown server or an unreachable probe reads as "not sealed".
 */
export async function agentTransportSealed(db: DB, serverId: number): Promise<boolean> {
  const row = await db.query.servers.findFirst({ where: eq(servers.id, serverId) });
  if (!row) return false;
  return supportsSealed(serverId, row.host, row.port);
}

/**
 * Run one typed operation on a remote agent. `sink` receives output lines;
 * non-zero exit codes throw (callers treat remote failures like local ones).
 * The exceptions are ops whose RESULT is the exit code — `docker.volumeInspect`
 * doubles as an existence probe — which pass `tolerateExit` and read
 * `res.exitCode` themselves.
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
  opts?: { tolerateExit?: boolean },
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
    // 0.13 (T5): a per-job Git credential never travels in clear — not even
    // when the operator opened the cleartext fallback for the rest.
    if (params['credential'] !== undefined) {
      throw new Error(
        `agent ${op} on ${row.host}:${row.port}: refusing to send a Git credential over the unencrypted transport — ` +
          'update the node agent to use GitHub App repositories on this node',
      );
    }
    // 0.16 T7 (security review L4): Swarm membership ops (the join token) never travel in clear,
    // whatever the agent or the cleartext fallback says.
    if (isSealedOnlyAgentOp(op)) {
      throw new Error(`agent ${op} on ${row.host}:${row.port}: refusing to send it over the unencrypted transport; it is sealed only`);
    }
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

  const url = `${agentBaseUrl(row.host, row.port)}/agent/exec`;
  const headers: Record<string, string> = sealedOk
    ? { 'content-type': 'application/json' }
    : { 'content-type': 'application/json', 'x-agent-token': token };
  const requestBody = JSON.stringify(sealedOk ? { sealed: seal(shared, { op, params, nonce }) } : { op, params });
  const budgetMs = agentRequestTimeoutMs(op);
  let res: ExecResponse;
  try {
    res = LONG_AGENT_OPS.has(op)
      ? await postWithoutHeadersTimeout(url, headers, requestBody, budgetMs)
      : await fetch(url, {
          method: 'POST',
          // r526: an agent endpoint never redirects; following one would
          // re-send a sealed op (or, on the opt-in cleartext path, the agent
          // token) to wherever the redirect points.
          redirect: 'error',
          headers,
          body: requestBody,
          signal: AbortSignal.timeout(budgetMs),
        });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(
        `agent ${op} on ${row.host}:${row.port}: no answer within the panel's timeout for this operation — the node may still be running it`,
      );
    }
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`agent ${op} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const raw = (await res.json()) as { sealed?: unknown; lines?: unknown; exitCode?: unknown; nonce?: unknown } | null;
  if (!raw || typeof raw !== 'object') throw new Error(`agent ${op}: invalid response`);
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
      if (!body || typeof body !== 'object') throw new Error('Invalid response');
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
  if (typeof body.exitCode !== 'number' || !Number.isInteger(body.exitCode)) {
    throw new Error(`agent ${op}: invalid exit code in response`);
  }
  const exitCode = body.exitCode;
  if (exitCode !== 0 && !opts?.tolerateExit) {
    // r526: the agent kills a child on its per-operation timeout and answers
    // 124 with a marker line — say that it was the NODE's limit, not the
    // command failing.
    if (exitCode === AGENT_TIMEOUT_EXIT && lines.some((l) => l.startsWith('Operation timed out after'))) {
      throw new Error(
        `agent ${op} was stopped by the node agent's per-operation timeout (exit 124). ` +
          `Agents older than 0.10.36 cap every operation at 595 s; upgrade the node agent to give builds ${AGENT_LONG_OP_TIMEOUT_MS / 60_000} minutes.`,
      );
    }
    throw new Error(`agent ${op} exited with ${exitCode}`);
  }
  return { exitCode, lines };
}

/** Probe an agent's reachability + auth (used by the servers routes + UI). */
export async function agentPing(host: string, port: number, token: string): Promise<void> {
  await agentPingLines(host, port, token);
}

/**
 * Multi-node (design §1.3): {@link agentPing}, resolving the sealed answer's
 * output lines — the `ND-AGENT {"version","caps"}` line — so the caller can
 * refresh the node's capability cache.
 */
export async function agentPingLines(host: string, port: number, token: string): Promise<{ lines: string[] }> {
  // The public capability endpoint cannot authenticate either party. Prove
  // possession of the shared key with a fresh, side-effect-free challenge.
  // Never fall back to transmitting the token, even for legacy agents.
  const shared = sha256(token);
  const nonce = randomBytes(16).toString('hex');
  const res = await fetch(`${agentBaseUrl(host, port)}/agent/exec`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sealed: seal(shared, { op: 'agent.ping', params: {}, nonce }) }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`agent unreachable (${res.status})`);
  const raw = (await res.json()) as { sealed?: unknown } | null;
  let result: { nonce?: unknown; exitCode?: unknown; lines?: unknown } | null;
  try {
    result = openSealed(shared, raw?.sealed);
  } catch {
    throw new Error('agent authentication failed: invalid sealed response; upgrade legacy agents');
  }
  if (!result || result.nonce !== nonce || result.exitCode !== 0) {
    throw new Error('agent authentication failed: response does not match this probe');
  }
  return { lines: Array.isArray(result.lines) ? result.lines.map(String) : [] };
}
