/**
 * Resolve a server path (`/v1/...`) against the configured API origin
 * (`VITE_API_URL`), exactly as the SDK client and `authedFetch` do. Raw links
 * the browser follows on its own — an `<a href>`, an iframe `src` — must use
 * this, or they silently hit the web origin when the API lives elsewhere.
 * Absolute URLs pass through untouched.
 */
export function apiUrl(path: string): string {
  const baseUrl = (import.meta.env['VITE_API_URL'] ?? '').replace(/\/$/, '');
  return path.startsWith('/') && !path.startsWith('//') ? `${baseUrl}${path}` : path;
}
