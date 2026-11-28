/**
 * N12: a database that has no version and that the version pin
 * (lib/databaseVersionPin.ts) could not pin. Rows without a version come from
 * installs before 0.18.28. The pin gives a running container the tag of the
 * image it runs, and a stopped row today's default when its volume was created
 * by today's default. It leaves a stopped row whose volume was created by
 * another image: it cannot tell which release that data runs, and writing
 * today's default there could be the very jump the pin prevents. Such a row's
 * next Start runs the default, as before — for MySQL, MariaDB and MongoDB an
 * in-place upgrade with no way back.
 *
 * This module shows that state and lets an operator name the release the data
 * runs BEFORE the first start, from a short list: the engine's known
 * releases, the image that created the volume and today's default. Nothing
 * touches the data here: a version is written to the row, and only to a row
 * that has none, or whose name has not run yet.
 *
 * A name is provisional until the server has run on it (`version_named_at`).
 * Nobody can tell whether the choice was right, so the first Start on it is a
 * trial (`settleNamedVersion`): a container the server does not stay up in is
 * removed, the start is refused with the reason, and the name stays open to
 * be changed. One that stays up makes the name the row's version, like any
 * other.
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { databases, type Database, type DB } from '@ninedeploy/db';
import { ENGINES, defaultVersionTag, versionForImage } from '../engine/database.js';
import { audit } from './audit.js';
import { type ContainerImage, type VersionPinDeps, type VolumeImage, versionPinDeps } from './databaseVersionPin.js';
import { conflict, HttpError, unprocessable } from './errors.js';
import { capture } from './exec.js';

/** The releases each engine is offered in, oldest first (what an upgrade and the engine's image factory know). */
export const KNOWN_RELEASES: Readonly<Record<string, readonly string[]>> = {
  postgres: ['14', '15', '16', '17', '18'],
  mysql: ['8.0', '8.4', '9.7'],
  mariadb: ['10.6', '10.11', '11.4', '11.8', '12.3'],
  mongo: ['6.0', '7.0', '8.0'],
};

/**
 * The releases such a row may be given: the engine's known ones, then the
 * tag of the image that created the volume and today's default when they are
 * not among them. An engine without a known list offers those two only.
 */
export function versionChoices(engine: string, creationTag: string | null): string[] {
  const known = KNOWN_RELEASES[engine] ?? [];
  const extra = [creationTag, defaultVersionTag(engine)].filter((tag): tag is string => tag !== null && !known.includes(tag));
  return [...new Set([...known, ...extra])];
}

export interface LegacyVersionStatus {
  /** The row's version; `null` for the rows this is about. */
  version: string | null;
  /** When the version was named here and the server has not run on it yet; null otherwise. */
  namedAt: string | null;
  /** The release may be named now: nothing read from a container stands in the way, and there is a list to choose from. */
  canSet: boolean;
  /** Why not, when it may not. */
  why: string | null;
  /** The image that initialized the volume (its `ninedeploy.database.image` label); null when the volume is gone or says nothing. */
  creationImage: string | null;
  /** What a Start would run today: the engine's default image. */
  defaultImage: string;
  defaultTag: string | null;
  /** The image of the database's container, when there is one (the pin reads it at the panel's next boot). */
  containerImage: string | null;
  /** Nothing runs, and the volume was not created by today's default: a Start may upgrade the data in place, with no way back. */
  ambiguous: boolean;
  /** The releases the version may be set to. */
  choices: string[];
}

/** Whether a Start may upgrade data in place: nothing runs, and the volume was created by another image than today's default. */
export function isAmbiguousVersion(creationImage: string | null, defaultTag: string | null, engine: string): boolean {
  return creationImage !== null && versionForImage(engine, creationImage) !== defaultTag;
}

export async function legacyVersionStatus(d: Database, deps: VersionPinDeps = versionPinDeps): Promise<LegacyVersionStatus> {
  const defaultImage = ENGINES[d.engine]?.image(undefined) ?? '';
  const defaultTag = defaultVersionTag(d.engine);
  const status: LegacyVersionStatus = {
    version: d.version,
    namedAt: d.versionNamedAt ? d.versionNamedAt.toISOString() : null,
    canSet: false,
    why: null,
    creationImage: null,
    defaultImage,
    defaultTag,
    containerImage: null,
    ambiguous: false,
    choices: [],
  };
  const settled = (why: string): LegacyVersionStatus => ({ ...status, canSet: false, why });
  // A name the server has run on is the row's version.
  if (d.version != null && d.versionNamedAt == null) return settled('This database already has a version.');
  if (d.serverId != null) return settled('A database on a node takes the default release; the panel pins it at its next start.');
  if (!d.containerName) return settled('This database has no container on the panel host.');
  if (d.version != null) {
    // A provisional name: it may be changed until the server has run on it. A container, if there is one,
    // was made from that name and says nothing new. While the trial runs, the name is not touched.
    if (d.status === 'creating') return settled('The database is still being created.');
    if (d.status === 'running') return settled('The database is starting on the named release; wait until it is up, or has failed.');
    const creationImage = await imageThatCreated(d, deps);
    return { ...status, creationImage, choices: versionChoices(d.engine, creationImage ? versionForImage(d.engine, creationImage) : null), canSet: true };
  }
  let container: ContainerImage;
  try {
    container = await deps.containerImage(d.containerName);
  } catch {
    return settled(`Docker did not answer for ${d.containerName}.`);
  }
  // The container says what it runs: the pin reads it at the panel's next boot.
  if (container.exists) return { ...status, containerImage: container.image, why: 'Its container exists: the panel pins the release it runs at its next boot.' };
  let creationImage: string | null = null;
  if (d.volumeName) {
    let volume: VolumeImage;
    try {
      volume = await deps.volumeImage(d.volumeName);
    } catch {
      return settled(`Docker did not answer for volume ${d.volumeName}.`);
    }
    creationImage = volume.exists && volume.image ? volume.image : null;
  }
  const choices = versionChoices(d.engine, creationImage ? versionForImage(d.engine, creationImage) : null);
  if (d.status === 'creating') return { ...status, creationImage, choices, why: 'The database is still being created.' };
  if (choices.length === 0) return { ...status, creationImage, why: `The ${d.engine} default depends on the host, and nothing says which release created the volume.` };
  return { ...status, creationImage, choices, ambiguous: isAmbiguousVersion(creationImage, defaultTag, d.engine), canSet: true };
}

/** The image that created the row's volume; null without a volume, when it is gone, says nothing, or Docker does not answer. */
async function imageThatCreated(d: Pick<Database, 'volumeName'>, deps: VersionPinDeps): Promise<string | null> {
  if (!d.volumeName) return null;
  try {
    const volume = await deps.volumeImage(d.volumeName);
    return volume.exists && volume.image ? volume.image : null;
  } catch {
    return null;
  }
}

/**
 * Name, or re-name, the release such a row runs, before the server has run
 * on the name. Only a row without a version or with a provisional one, only
 * from its list, only while nothing starts and no upgrade does; the write is
 * conditional, so a version given meanwhile is kept.
 */
export async function setLegacyVersion(db: DB, row: Database, version: string, actor: number | null, deps: VersionPinDeps = versionPinDeps): Promise<LegacyVersionStatus> {
  const d = await db.query.databases.findFirst({ where: eq(databases.id, row.id) });
  if (!d) throw conflict('The database is gone.');
  const status = await legacyVersionStatus(d, deps);
  if (!status.canSet) {
    if (d.version != null && d.versionNamedAt == null) throw new HttpError(409, 'database_version_set', 'This database already has a version.');
    throw new HttpError(409, 'database_version_set', status.why ?? 'The release cannot be named now.');
  }
  if (!status.choices.includes(version)) {
    throw unprocessable(`"${version}" is not a release this database may be given. Choose one of: ${status.choices.join(', ')}.`, 'database_version_choice');
  }
  const updated = await db
    .update(databases)
    .set({ version, versionNamedAt: new Date() })
    .where(and(eq(databases.id, d.id), d.version == null ? isNull(databases.version) : isNotNull(databases.versionNamedAt)))
    .returning({ id: databases.id });
  if (updated.length === 0) {
    throw new HttpError(409, 'database_version_set', d.version == null ? 'The database was given a version meanwhile; reload the page.' : 'The database ran on its named release meanwhile; it is its version now.');
  }
  void audit(db, actor, 'database.version_set', d.name, { databaseId: d.id, version, ...(d.version != null ? { replaced: d.version } : {}) });
  const after = await db.query.databases.findFirst({ where: eq(databases.id, d.id) });
  return legacyVersionStatus(after!, deps);
}

// ── the trial of a named release ───────────────────────────────────────────

/** How long a container started on a named release is watched: a server that cannot read the data exits well within this. */
export const NAMED_VERSION_SETTLE_MS = 12_000;

export interface ContainerState {
  /** `docker inspect`'s `State.Status`: `running`, `restarting`, `exited`, … */
  state: string;
  /** How many times the restart policy has restarted it. */
  restarts: number;
}

export interface NamedVersionDeps {
  /** The container's state; null when Docker does not answer or the container is gone. */
  containerState(name: string): Promise<ContainerState | null>;
  sleep(ms: number): Promise<void>;
}

export const namedVersionDeps: NamedVersionDeps = {
  containerState: async (name) => {
    try {
      const out = await capture('docker', ['inspect', name, '--format', '{{.State.Status}} {{.RestartCount}}'], { timeoutMs: 30_000 });
      const [state, restarts] = out.trim().split(/\s+/);
      return { state: state ?? '', restarts: Number(restarts ?? 0) };
    } catch {
      return null;
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * The first Start on a named release is a trial. A container the server does
 * not stay up in is removed (its volume stays), with the name still open, and
 * the start is refused with the reason; the row's status is not touched, as
 * for any other failed Start (a row in error would go through the
 * retained-volume gate, which is for brand-new rows). One that stays up for
 * `NAMED_VERSION_SETTLE_MS` without a restart makes the name the row's
 * version.
 */
export async function settleNamedVersion(
  db: DB,
  d: Pick<Database, 'id' | 'engine' | 'version' | 'containerName'>,
  stop: (log: (line: string) => void) => Promise<void>,
  log: (line: string) => void,
  deps: NamedVersionDeps = namedVersionDeps,
): Promise<void> {
  const image = ENGINES[d.engine]?.image(d.version ?? undefined) ?? d.version ?? '';
  log(`Trying the named release ${image}: watching ${d.containerName} for ${NAMED_VERSION_SETTLE_MS / 1000} seconds`);
  const deadline = Date.now() + NAMED_VERSION_SETTLE_MS;
  for (;;) {
    const state = d.containerName ? await deps.containerState(d.containerName) : null;
    if (!state || state.state !== 'running' || state.restarts > 0) {
      await stop(log);
      throw new HttpError(
        409,
        'database_version_named',
        `The server did not stay up on ${image}: this data does not run on that release. Name another release for the database, then start it again.`,
      );
    }
    if (Date.now() >= deadline) break;
    await deps.sleep(Math.min(1000, deadline - Date.now()));
  }
  // Conditional: the name that was tried is the one that ran.
  const confirmed = await db
    .update(databases)
    .set({ versionNamedAt: null })
    .where(and(eq(databases.id, d.id), eq(databases.version, d.version ?? '')))
    .returning({ id: databases.id });
  log(confirmed.length > 0 ? `${image} stayed up: the named release is the database's version` : `${image} stayed up`);
}
