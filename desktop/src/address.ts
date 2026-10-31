/** Address rules shared by the main process and the instance list page (no Node imports). */

export type NormalizedUrl = { ok: true; origin: string; insecure: boolean } | { ok: false; reason: string };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The panel serves its API and pages from the root of one origin, so an
 * instance is exactly an origin. A path, query or credentials in the address
 * are refused rather than dropped: silently opening something other than
 * what was typed would be worse than asking again.
 */
export function normalizeInstanceUrl(input: string): NormalizedUrl {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: 'Enter the address of the panel.' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: 'That is not a valid address.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'Only http and https addresses can be opened.' };
  }
  if (url.username || url.password) return { ok: false, reason: 'Leave the user name and password out of the address.' };
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    return { ok: false, reason: 'Enter the panel address without a path, for example https://panel.example.com' };
  }
  return { ok: true, origin: url.origin, insecure: url.protocol === 'http:' && !LOOPBACK.has(url.hostname) };
}
