import path from 'node:path';
import { lstatSync, type Stats } from 'node:fs';

/**
 * Re-anchor a build-config path onto the checked-out repository.
 *
 * `baseDir` and `dockerfilePath` are user-supplied and the UI's convention is
 * that a leading slash means "from the repo root" — but `path.resolve()` reads
 * a leading slash as the FILESYSTEM root and discards everything before it:
 *
 *     path.resolve('/data/repos/42', '/etc', 'Dockerfile')  →  '/etc/Dockerfile'
 *
 * so `baseDir: "/etc"` turned the host's /etc into the docker build context.
 * Stripping the leading separators makes the resolve behave the way the field
 * is documented, and the containment check below catches anything else that
 * still escapes (symlink-free `..` was already rejected at the schema layer;
 * this is the sink defending itself).
 *
 * Lexical containment alone is not the whole story: a symlink INSIDE the
 * checkout can point anywhere on the host — `ln -s /etc evil` then
 * `baseDir: "evil"` hands the writer (or docker build) a path that resolves
 * outside the repo. On a bare-metal panel the server runs as root, so a write
 * through a dangling absolute symlink is root-owned file creation anywhere on
 * the filesystem. Every component from the repo root down is therefore
 * lstat-checked and a symlink — dangling ones included, since writing through
 * them is the escape — is refused.
 */
export function resolveInRepo(workDir: string, ...segments: Array<string | undefined>): string {
  const cleaned = segments
    .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    .map((s) => s.trim().replace(/^[/\\]+/, ''));
  const resolved = path.resolve(workDir, ...cleaned);
  const root = path.resolve(workDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to use a build path outside the repository: ${segments.join('/')}`);
  }
  const rel = path.relative(root, resolved);
  if (rel !== '') {
    let current = root;
    for (const part of rel.split(path.sep)) {
      current = path.join(current, part);
      let st: Stats;
      try {
        st = lstatSync(current);
      } catch (err) {
        // A missing component has nothing to follow — the later fs operation
        // (write, docker context) fails on it with its own clear error. Other
        // stat failures are rethrown rather than silently skipped.
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') break;
        throw err;
      }
      if (st.isSymbolicLink()) {
        throw new Error(`Refusing to use a build path through a symlink: ${segments.join('/')}`);
      }
    }
  }
  return resolved;
}

/**
 * The repo-relative form of a build path, for the places that must hand docker
 * a path RELATIVE to the work dir (the build context operand, `compose -f`).
 * Returns '.' for the repo root so it is always a usable operand.
 */
export function repoRelative(workDir: string, value: string | undefined): string {
  if (!value || value.trim() === '' || /^[/\\]+$/.test(value.trim())) return '.';
  const rel = path.relative(path.resolve(workDir), resolveInRepo(workDir, value));
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}
