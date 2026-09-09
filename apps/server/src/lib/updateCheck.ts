import { config } from '../config.js';
import { VERSION } from '../version.js';

export interface UpdateCheckResult {
  current: string;
  latest: string | null;
  updateAvailable: boolean | null; // null = unknown (offline / disabled)
  notesUrl: string | null;
  checkedAt: string;
  /** Present only when updateAvailable is null: why no verdict exists. */
  reason?: 'disabled' | 'unreachable';
  /** Short feed-side detail (status line / abort reason) for the UI. */
  detail?: string;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — same policy as the template registry
/** Failures are remembered far more briefly than successes: one boot-time
 *  blip (network not up yet, a single API rate-limit 403) must not pin
 *  "update check unavailable" on the dashboard for six hours. */
const FAILURE_CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

let cached: { result: UpdateCheckResult; at: number; isFailure: boolean } | null = null;

/** Compare two semver strings ("v" prefix optional). Returns true when a > b. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [aMaj = 0, aMin = 0, aPatch = 0] = parse(a);
  const [bMaj = 0, bMin = 0, bPatch = 0] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPatch > bPatch;
}

function unknownResult(
  reason: 'disabled' | 'unreachable',
  detail?: string,
  checkedAt = new Date().toISOString(),
): UpdateCheckResult {
  return {
    current: VERSION,
    latest: null,
    updateAvailable: null,
    notesUrl: null,
    checkedAt,
    reason,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * Fetch the latest release tag from the configured update feed (GitHub
 * Releases format) and compare it with the running version. Successes are
 * cached for 6 hours; failures are cached only for 10 minutes so a transient
 * blip (boot before the network is up, one API rate-limit 403) self-heals
 * instead of pinning "unavailable" on the dashboard. Network failures return
 * an "unknown" result — now with a `reason` — instead of throwing so the
 * dashboard never breaks on an air-gapped host.
 */
export async function checkForUpdate(force = false): Promise<UpdateCheckResult> {
  const ttl = cached?.isFailure ? FAILURE_CACHE_TTL_MS : CACHE_TTL_MS;
  if (!force && cached && Date.now() - cached.at < ttl) {
    return cached.result;
  }
  if (config.updateCheckUrl === 'disabled') {
    const result = unknownResult('disabled', 'NINEDEPLOY_UPDATE_CHECK_URL=disabled');
    cached = { result, at: Date.now(), isFailure: false };
    return result;
  }

  let result: UpdateCheckResult;
  try {
    const res = await fetch(config.updateCheckUrl, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`update feed ${res.status}`);
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    const latest = typeof body.tag_name === 'string' ? body.tag_name : null;
    if (!latest) throw new Error('update feed returned no tag_name');
    result = {
      current: VERSION,
      latest,
      updateAvailable: isNewer(latest, VERSION),
      notesUrl: typeof body.html_url === 'string' ? body.html_url : null,
      checkedAt: new Date().toISOString(),
    };
    cached = { result, at: Date.now(), isFailure: false };
  } catch (err) {
    result = unknownResult('unreachable', (err instanceof Error ? err.message : String(err)).slice(0, 200));
    cached = { result, at: Date.now(), isFailure: true };
  }
  return result;
}
