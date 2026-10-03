/**
 * Build health-probe URLs structurally instead of by string concatenation.
 *
 * `http://${host}:${port}${path}` is unsafe when `path` is user-supplied:
 * concatenation happens before URL parsing, so a leading `@` re-reads the
 * host:port as userinfo and the rest as the authority —
 * `http://127.0.0.1:3000` + `@evil.example.com/` resolves to evil.example.com.
 * Assigning `pathname`/`search` on a constructed URL cannot move the target.
 *
 * The schema layer already constrains `healthPath` (see `httpPath` in
 * @ninedeploy/schemas), but rows written before that validation existed are
 * still in the database, so the sink defends itself too.
 */
export function buildProbeUrl(host: string, port: number | string, path: string): string {
  const url = new URL('http://placeholder.invalid');
  url.hostname = host;
  url.port = String(port);
  const raw = path && path.startsWith('/') ? path : `/${path ?? ''}`;
  const [pathname, search] = splitQuery(raw);
  url.pathname = pathname;
  if (search) url.search = search;
  return url.toString();
}

function splitQuery(raw: string): [string, string | null] {
  const q = raw.indexOf('?');
  if (q < 0) return [raw, null];
  return [raw.slice(0, q), raw.slice(q)];
}

/**
 * Normalise a stored health path for use as a *path argument* (wget/curl
 * inside a container), where the host is supplied separately. Strips anything
 * that could terminate the path and start a new token.
 */
export function safeProbePath(path: string | null | undefined): string {
  const raw = (path ?? '/').trim();
  if (!raw.startsWith('/')) return '/';
  if (/[\s@\\]/.test(raw)) return '/';
  return raw;
}
