/**
 * `ninedeploy databases version …` — N12: the release of a database that has
 * no version, or whose version was named by hand and has not run yet. A row
 * without a version comes from an install before 0.18.28: the version pin
 * left it alone because its volume was not created by the default image, so
 * nobody can tell which release its data runs, and its next Start would run
 * the default — for MySQL, MariaDB and MongoDB an in-place upgrade with no
 * way back.
 *
 *   show <dbId>                       what is known about the release, and the releases that may be named
 *   set <dbId> <release> [--yes]      name the release the data runs, before the first start (database admin)
 *
 * A name is provisional until the server has run on it: the first Start
 * watches the container for a few seconds, one the server does not stay up
 * in is undone, and the release can be named again.
 */
import type { NineDeployClient } from '../client.js';
import { prompt } from '../prompts.js';
import { c, error, header, info, kv, spinner, success } from '../lib/format.js';

type Status = Awaited<ReturnType<NineDeployClient['databases']['version']['get']>>;

const fail = (err: unknown): void => {
  error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
};
const num = (v: string | undefined, usage: string): number | null => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    error(usage);
    process.exitCode = 1;
    return null;
  }
  return n;
};

export async function versionShow(client: NineDeployClient, dbIdStr: string): Promise<void> {
  const id = num(dbIdStr, 'Usage: ninedeploy databases version show <dbId>');
  if (id === null) return;
  let s: Status;
  try { s = await spinner('Reading the database', () => client.databases.version.get(id)); } catch (err) { fail(err); return; }
  header('Database version');
  if (s.version != null && s.namedAt == null) {
    kv('Version', s.version);
    return;
  }
  kv('Version', s.version ?? c.dim('none'));
  if (s.namedAt) info(`Named by hand on ${s.namedAt}; the server has not run on it yet.`);
  kv('Data created by', s.creationImage ?? c.dim('unknown'));
  kv('A start would run', s.defaultImage);
  if (s.containerImage) kv('Its container runs', s.containerImage);
  if (s.ambiguous) {
    info('Nobody can tell which release this data runs: the volume was not created by the image that is the default today.');
    info('For MySQL, MariaDB and MongoDB a Start on another release upgrades the data in place, with no way back.');
  }
  if (s.canSet) {
    kv('May be named', s.choices.join(', '));
    info(`Name the release the data runs before the first start: ninedeploy databases version set ${id} <release>`);
  } else {
    info(s.why ?? 'The release cannot be named now.');
  }
}

export async function versionSet(client: NineDeployClient, dbIdStr: string, release: string, opts: { yes?: boolean } = {}): Promise<void> {
  const usage = 'Usage: ninedeploy databases version set <dbId> <release> [--yes]';
  const id = num(dbIdStr, usage);
  if (id === null) return;
  const tag = (release ?? '').trim();
  if (!/^[0-9][a-z0-9._-]*$/.test(tag)) {
    error(`<release> must be a release tag, such as 18, 8.4 or 11.8. ${usage}`);
    process.exitCode = 1;
    return;
  }
  let before: Status;
  try { before = await spinner('Reading the database', () => client.databases.version.get(id)); } catch (err) { fail(err); return; }
  if (!before.canSet) {
    error(before.why ?? 'The release cannot be named now.');
    process.exitCode = 1;
    return;
  }
  if (!before.choices.includes(tag)) {
    error(`"${tag}" is not a release this database may be given. Choose one of: ${before.choices.join(', ')}.`);
    process.exitCode = 1;
    return;
  }
  if (before.version === tag) {
    info(`The database is already named ${tag}. Start it: the first start tries that release.`);
    return;
  }
  const cost = 'For MySQL, MariaDB and MongoDB, a Start on a release the data does not run yet upgrades the data in place, with no way back.';
  if (!opts.yes) {
    const answer = await prompt(
      `The database's version is set to ${tag}; its next Start runs that release on the data it has. ${cost} Take a backup first when in doubt. Type "version" to continue`,
      '',
    );
    if (answer.trim() !== 'version') {
      info('Aborted.');
      return;
    }
  }
  try {
    await spinner('Naming the release', () => client.databases.version.set(id, { version: tag }));
  } catch (err) { fail(err); return; }
  success(`Version set to ${tag}.`);
  info('It is provisional until the server has run on it: the first Start watches the container for a few seconds, and one the server does not stay up in is undone, so the release can be named again.');
  info(`Start it from the database's page in the panel, then read the result with: ninedeploy databases version show ${id}`);
}
