import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Write short-lived secret material (docker `--env-file` payloads) to a private
 * temporary directory.
 *
 * Why not a plain `${tmpdir()}/name-${pid}-${Date.now()}` path: mode 0600
 * protects the CONTENTS once the file exists, but `writeFileSync` follows
 * symlinks. On a shared host, a local unprivileged user who pre-creates a
 * symlink at a predictable name — the pid is world-readable and the timestamp
 * is a narrow guess window, while deploys are triggerable through the API —
 * has the target file overwritten with this content by whatever user runs the
 * panel (root, under the systemd install).
 *
 * `mkdtempSync` closes that: it fails outright if the path already exists, and
 * creates the directory with 0700, so nothing inside can be pre-placed or read
 * by another user.
 */
export interface SecretFile {
  /** Absolute path to hand to `docker --env-file`. */
  path: string;
  /** Remove the file and its private directory. Safe to call twice. */
  cleanup: () => void;
}

/**
 * Create `<tmp>/<prefix>-XXXXXX/<name>` containing `contents` (mode 0600).
 * The caller MUST call `cleanup()` — a `finally` block — once the consuming
 * process has read the file.
 *
 * `mode` exists for files that are `docker cp`'d into a container whose
 * process is not root: `docker cp` keeps the mode but makes root the owner,
 * so a 0600 file is unreadable there. The private 0700 directory is what keeps
 * such a file away from other host users.
 */
export function writeSecretFile(prefix: string, name: string, contents: string, mode = 0o600): SecretFile {
  const dir = mkdtempSync(path.join(tmpdir(), `${prefix}-`));
  const file = path.join(dir, name);
  writeFileSync(file, contents, { mode });
  return {
    path: file,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    },
  };
}
