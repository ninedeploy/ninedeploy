/**
 * Detects `ENOENT` (no such file or directory) on a thrown value. Returns
 * `true` for both the bare `Error.code === 'ENOENT'` form and the
 * `NodeJS.ErrnoException` shape; anything else returns false.
 *
 * Centralised here so callers (loader, secret scanner, future helpers)
 * can test file-missing without each one re-implementing the check, and
 * so a future migration to `fs.isENOENT` only touches one place.
 */
export function isENOENT(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ENOENT';
}
