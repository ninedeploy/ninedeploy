import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { settings, type DB } from '@ninedeploy/db';
import { INLINE_DOCKERFILE_MAX_BYTES } from '@ninedeploy/schemas';
import { repoRelative, resolveInRepo } from './repoPath.js';
import { getSettingString, setSettingString } from './settings.js';

/**
 * G1.1 inline Dockerfile: a Dockerfile pasted in the panel instead of kept in
 * the repository. No migration: the text is the settings row
 * `inline_dockerfile:<serviceId>`.
 *
 * At deploy time it is written into the build context (the base directory) as
 * `.ninedeploy.Dockerfile` and the build runs with the `dockerfile` pack and
 * that path, for one deployment. The file is written into the PANEL's
 * checkout: a build on a node or a build server clones again and would not
 * have it, so the pipeline refuses one (INLINE_DOCKERFILE_PANEL_BUILD). A
 * docker service with neither a repository nor an image ("Dockerfile only")
 * builds it from an empty context.
 */

const key = (serviceId: number) => `inline_dockerfile:${serviceId}`;
export const INLINE_DOCKERFILE_NAME = '.ninedeploy.Dockerfile';

export const INLINE_DOCKERFILE_PANEL_BUILD =
  'An inline Dockerfile is written into the checkout on the panel host; a build on a node or a build server clones the repository again and would not have it. Build on the panel (Service → Settings → Build on: panel) or remove the inline Dockerfile.';

export async function getInlineDockerfile(db: DB, serviceId: number): Promise<string | null> {
  const text = await getSettingString(db, key(serviceId), null);
  return text && text.trim() ? text : null;
}

export async function setInlineDockerfile(db: DB, serviceId: number, content: string | null): Promise<void> {
  if (content === null || !content.trim()) {
    await db.delete(settings).where(eq(settings.key, key(serviceId)));
    return;
  }
  if (Buffer.byteLength(content, 'utf8') > INLINE_DOCKERFILE_MAX_BYTES) throw new Error(`An inline Dockerfile is at most ${INLINE_DOCKERFILE_MAX_BYTES} bytes`);
  await setSettingString(db, key(serviceId), content);
}

/** The deployment's "commit" for a Dockerfile-only service: the content's hash, so the same text builds the same tag. */
export function inlineDockerfileSha(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

/** A fresh, empty build context for a service with no source of its own. */
export function prepareEmptyContext(workDir: string): void {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
}

/**
 * Write the Dockerfile into the base directory and say the repository-root
 * relative path to build it with. The base directory goes through the same
 * containment check as every other user path (lib/repoPath.ts).
 */
export function writeInlineDockerfile(workDir: string, baseDir: string | null | undefined, content: string): string {
  const file = resolveInRepo(workDir, baseDir ?? undefined, INLINE_DOCKERFILE_NAME);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, { mode: 0o644 });
  return repoRelative(workDir, path.relative(workDir, file).split(path.sep).join('/'));
}
