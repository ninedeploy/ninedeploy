/**
 * A database row without a `version` runs the engine's DEFAULT image, and that
 * default moves with releases. The next recreate after a bump (a restart
 * after a crash, a limit change, a restore) would start the new server on the
 * old data directory: MySQL and MariaDB upgrade it in place with no way back,
 * Redis writes an RDB the old server cannot read, Meilisearch and PostgreSQL
 * refuse to start. New rows are created with their tag (`defaultVersionTag`);
 * this boot step gives every older row the tag its container actually runs.
 *
 * Rules, in order:
 *  - a row with a running upgrade is left to upgrade recovery (it carries the
 *    version it restores explicitly);
 *  - a panel-host row takes the tag that reproduces the image its container
 *    runs (`Config.Image`), matched by the round trip `ENGINES[e].image(tag)`.
 *    Not the volume's `ninedeploy.database.image` label: that names the image
 *    that INITIALIZED the data, which later recreates may already have
 *    upgraded, and pinning it would start an older server on newer data;
 *  - a stopped row (Stop removes the container) takes today's default only
 *    when its volume does not exist either, or when the volume was created by
 *    today's default image: a row without a version only ever ran defaults,
 *    and defaults only rose, so its data is not newer than that. A volume
 *    created by an older default may hold data a later default has already
 *    upgraded, or not: that row is left as it was, with a warning;
 *  - a node row takes today's default: node databases came after the last
 *    default change (2026-08-23);
 *  - anything else (Docker unreachable, an image no tag reproduces, KeyDB,
 *    whose default depends on the host's CPU) stays as it is and is retried
 *    on the next boot. Writing the default there could encode the very jump
 *    this step prevents.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { databases, databaseUpgrades, type DB } from '@ninedeploy/db';
import { defaultVersionTag, versionForImage } from '../engine/database.js';
import { confirmsMissingContainer } from './dockerContainerAbsence.js';
import { capture } from './exec.js';
import { createLogger } from './log.js';

const logger = createLogger('database-version-pin');

/** What `docker inspect` says about a database container. */
export type ContainerImage = { exists: false } | { exists: true; image: string };

/** What `docker volume inspect` says about a database volume: the image its `ninedeploy.database.image` label names, '' without one. */
export type VolumeImage = { exists: false } | { exists: true; image: string };

export interface VersionPinDeps {
  /** Rejects when Docker cannot answer; resolves `exists: false` only when Docker says the container is not there. */
  containerImage(name: string): Promise<ContainerImage>;
  /** Same contract for a volume. */
  volumeImage(name: string): Promise<VolumeImage>;
}

/** The command's stderr when it exited 1, else null. */
function exitedOneStderr(err: unknown): string | null {
  const message = (err as Error).message ?? '';
  const stderr = message.replace(/^`[^`]*` exited 1: /, '');
  return stderr === message ? null : stderr.trim();
}

export const versionPinDeps: VersionPinDeps = {
  containerImage: async (name) => {
    try {
      const out = await capture('docker', ['inspect', '--type', 'container', '--format', '{{.Config.Image}}', name], { timeoutMs: 30_000 });
      return { exists: true, image: out.trim() };
    } catch (err) {
      const stderr = exitedOneStderr(err);
      if (stderr !== null && confirmsMissingContainer(stderr.split('\n'), name)) return { exists: false };
      throw err;
    }
  },
  volumeImage: async (name) => {
    try {
      const out = await capture('docker', ['volume', 'inspect', '--format', '{{index .Labels "ninedeploy.database.image"}}', name], { timeoutMs: 30_000 });
      const image = out.trim();
      return { exists: true, image: image === '<no value>' ? '' : image };
    } catch (err) {
      if (exitedOneStderr(err) === `Error response from daemon: get ${name}: no such volume`) return { exists: false };
      throw err;
    }
  },
};

export interface VersionPinResult {
  pinned: number;
  left: number;
}

export async function pinUnversionedDatabases(db: DB, deps: VersionPinDeps = versionPinDeps): Promise<VersionPinResult> {
  const rows = await db.query.databases.findMany({ where: isNull(databases.version) });
  const result: VersionPinResult = { pinned: 0, left: 0 };
  for (const d of rows) {
    const leave = (why: string) => {
      result.left += 1;
      logger.warn(`database #${d.id} (${d.engine}) keeps no version: ${why}; retried at the next start`);
    };
    const upgrading = await db.query.databaseUpgrades.findFirst({
      where: and(eq(databaseUpgrades.databaseId, d.id), eq(databaseUpgrades.status, 'running')),
    });
    if (upgrading) {
      leave(`upgrade #${upgrading.id} is running`);
      continue;
    }
    let version: string | null;
    let source: string;
    if (d.serverId != null) {
      version = defaultVersionTag(d.engine);
      source = 'the default (node database)';
    } else if (d.containerName) {
      let found: ContainerImage;
      try {
        found = await deps.containerImage(d.containerName);
      } catch (err) {
        leave(`Docker did not answer for ${d.containerName} (${(err as Error).message.slice(0, 200)})`);
        continue;
      }
      if (found.exists) {
        version = versionForImage(d.engine, found.image);
        source = `container ${d.containerName} runs ${found.image}`;
        if (!version) {
          leave(`no ${d.engine} tag reproduces the image ${found.image}`);
          continue;
        }
      } else {
        version = defaultVersionTag(d.engine);
        source = `the default (container ${d.containerName} does not exist`;
        if (d.volumeName) {
          let volume: VolumeImage;
          try {
            volume = await deps.volumeImage(d.volumeName);
          } catch (err) {
            leave(`Docker did not answer for volume ${d.volumeName} (${(err as Error).message.slice(0, 200)})`);
            continue;
          }
          if (volume.exists && (version == null || versionForImage(d.engine, volume.image) !== version)) {
            leave(
              `it is stopped and its volume ${d.volumeName} was created by ${volume.image || 'an unrecorded image'}, not by today's default, ` +
                'so its data may be older or newer than the default; its next Start runs the default, as before',
            );
            continue;
          }
          source += volume.exists ? `; its volume was created by ${volume.image}` : '; nor does its volume';
        }
        source += ')';
      }
    } else {
      leave('it has neither a container nor a node');
      continue;
    }
    if (!version) {
      leave(`the ${d.engine} default depends on the host`);
      continue;
    }
    // Conditional: a row given a version meanwhile keeps it.
    const updated = await db
      .update(databases)
      .set({ version })
      .where(and(eq(databases.id, d.id), isNull(databases.version)))
      .returning({ id: databases.id });
    if (updated.length > 0) {
      result.pinned += 1;
      logger.info(`database #${d.id} (${d.engine}) pinned to version ${version}: ${source}`);
    }
  }
  return result;
}
