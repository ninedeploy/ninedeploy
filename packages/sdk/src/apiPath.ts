// Validated GET paths for `client.api.get` (0.15 T4).
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import { NineDeployError } from './errors.js';

// ── 0.15 T4 api ──
/** Query parameters for `client.api.get`. */
export type ApiQuery = Record<string, string | number | boolean | undefined>;

/** The paths `client.api.get` accepts: under `/v1/`, plain segments, no `..`. */
const API_PATH = /^\/v1\/[A-Za-z0-9/_.-]+$/;

/** Validate an `api.get` path and append its query string. Exported for tests. */
export function apiGetUrl(path: string, query?: ApiQuery): string {
  if (!API_PATH.test(path) || path.split('/').includes('..')) {
    throw new NineDeployError(0, 'invalid_path', `Not an API path: ${path}`);
  }
  const qs = Object.entries(query ?? {})
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `${path}?${qs}` : path;
}
