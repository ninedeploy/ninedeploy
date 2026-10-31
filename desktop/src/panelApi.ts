/** The few panel API calls the desktop shell makes itself, all on the instance's existing public API. */

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;

export type ProbeResult = { ok: true; version: string } | { ok: false; reason: string };

/**
 * Confirm an address is a NineDeploy panel before it goes in the list.
 * Redirects are not followed: a panel that answers from somewhere else is
 * that other address, and the user should add that one knowingly.
 */
export async function probeInstance(origin: string, fetchImpl: Fetch): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${origin}/health`, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, reason: `Could not reach ${origin}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    return { ok: false, reason: location ? `${origin} redirects to ${location}. Add that address instead.` : `${origin} answers with a redirect.` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const health = body as { status?: unknown; version?: unknown } | null;
  if (!health || typeof health.version !== 'string' || (health.status !== 'ok' && health.status !== 'degraded')) {
    return { ok: false, reason: `${origin} does not answer like a NineDeploy panel.` };
  }
  return { ok: true, version: health.version };
}

/**
 * End this device's panel session only. The panel's own logout ends every
 * session of the user, which removing one desktop entry should not do, so
 * this finds the current session from a fresh access token and revokes it.
 * Best effort: an unreachable panel leaves the session to expire, and the
 * local copy is deleted either way.
 */
export async function revokeDesktopSession(origin: string, refreshToken: string, fetchImpl: Fetch): Promise<boolean> {
  try {
    const refreshed = await fetchImpl(`${origin}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!refreshed.ok) return false;
    const accessToken = ((await refreshed.json()) as { tokens?: { accessToken?: unknown } }).tokens?.accessToken;
    if (typeof accessToken !== 'string') return false;
    const auth = { authorization: `Bearer ${accessToken}` };
    const list = await fetchImpl(`${origin}/v1/auth/sessions`, { headers: auth, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!list.ok) return false;
    const rows = (await list.json()) as unknown;
    const current = Array.isArray(rows) ? (rows as Array<{ id?: unknown; current?: unknown }>).find((r) => r.current === true) : undefined;
    if (typeof current?.id !== 'number') return false;
    const revoked = await fetchImpl(`${origin}/v1/auth/sessions/${current.id}`, {
      method: 'DELETE',
      headers: auth,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return revoked.ok;
  } catch {
    return false;
  }
}
