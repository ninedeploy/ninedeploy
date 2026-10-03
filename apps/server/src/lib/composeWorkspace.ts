import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Where an inline compose stack's file lives, and how it gets there.
 *
 * Kept in `lib/` rather than next to the install route because BOTH layers
 * need it: the routes write the file when a stack is created, cloned or
 * edited, and the deploy pipeline (`engine/`) rewrites it before every run.
 * `services.composeContent` is the record; this file is its cache on disk.
 */

/** The one file name an inline stack is ever deployed from. */
export const INLINE_COMPOSE_FILE = 'docker-compose.yml';

/** Resolved per call, not at import time: this module is pulled in by the
 * compose builder, and a module-level read would run before (or without) the
 * config a caller has set up. */
const stackRoot = (): string => path.resolve(config.paths.reposDir);

/** Workspace path for a service id, hard-locked to the repos root. */
export function stackWorkspace(serviceId: number): string {
  const STACK_ROOT = stackRoot();
  // Single join: path.resolve alone is sufficient — path.join(STACK_ROOT, id)
  // was a redundant wrapper that coincidentally produces the same result only
  // when STACK_ROOT has no trailing separator; it has no role in this function.
  const target = path.resolve(STACK_ROOT, String(Number(serviceId)));
  if (!Number.isInteger(serviceId) || !target.startsWith(STACK_ROOT + path.sep)) {
    throw new Error('invalid workspace id');
  }
  return target;
}

/**
 * Write a stack's YAML into its workspace, creating the workspace if needed.
 * Called at install time AND before every deploy, so a wiped workspace, a
 * rollback or a restored host repairs itself instead of leaving a service
 * whose stack can never be brought up again.
 */
export function materialiseComposeFile(serviceId: number, content: string): string {
  const workDir = stackWorkspace(serviceId);
  mkdirSync(workDir, { recursive: true });
  const file = path.join(workDir, INLINE_COMPOSE_FILE);
  // 0600: a compose file routinely carries credentials inline.
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}
