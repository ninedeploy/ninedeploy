/**
 * `ninedeploy databases upgrade …` — O2 major-version upgrades (PostgreSQL,
 * MySQL and MariaDB on the panel host).
 *
 *   status <dbId>                              current release, targets, and the upgrade history
 *   start <dbId> --to <release> [--yes] [--no-wait]
 *                                              stop, move into a new volume (PostgreSQL: dump and
 *                                              restore; MySQL/MariaDB: copy and upgrade in place),
 *                                              compare, switch
 *   rollback <dbId> <upgradeId> [--yes]        point the database back at the previous volume
 *   finalize <dbId> <upgradeId> [--yes]        delete the volume the database no longer uses
 */
import type { NineDeployClient } from '../client.js';
import { prompt } from '../prompts.js';
import { c, error, header, info, kv, spinner, success, table } from '../lib/format.js';

type Upgrade = Awaited<ReturnType<NineDeployClient['databases']['upgrades']['start']>>;

const LABELS: Record<string, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' };
const label = (engine: string) => LABELS[engine] ?? engine;
/** `fromSeries`/`toSeries` arrive from 0.18.28; older panels send only the majors. */
const fromOf = (u: Upgrade) => u.fromSeries ?? String(u.fromMajor);
const toOf = (u: Upgrade) => u.toSeries ?? String(u.toMajor);

const num = (v: string | undefined, usage: string): number | null => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    error(usage);
    process.exitCode = 1;
    return null;
  }
  return n;
};
const fail = (err: unknown): void => {
  error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
};
const confirm = async (word: string, question: string): Promise<boolean> => {
  const answer = await prompt(`${question} Type "${word}" to continue`, '');
  if (answer.trim() !== word) {
    info('Aborted.');
    return false;
  }
  return true;
};

function describeOutcome(u: Upgrade, dbId: number): void {
  if (u.status === 'completed') {
    success(`Upgraded to ${label(u.engine)} ${toOf(u)}.`);
    if (u.verification) {
      const extra = u.verification.users != null ? `, ${u.verification.users} account(s)` : `, ${u.verification.sequences} sequence(s)`;
      info(`Compared before the switch: ${u.verification.tables} table(s), ${u.verification.rows} row(s)${extra}.`);
    }
    info(`The previous volume ${u.previousVolume} is kept. Check your services, then: ninedeploy databases upgrade finalize ${dbId} ${u.id}`);
    info(`To go back to ${label(u.engine)} ${fromOf(u)}: ninedeploy databases upgrade rollback ${dbId} ${u.id}`);
  } else {
    error(`The upgrade ${u.status === 'failed' ? 'failed' : `ended ${u.status}`}: ${u.error ?? 'no reason recorded'}`);
    process.exitCode = 1;
  }
}

export async function upgradeStatus(client: NineDeployClient, dbIdStr: string): Promise<void> {
  const id = num(dbIdStr, 'Usage: ninedeploy databases upgrade status <dbId>');
  if (id === null) return;
  let options: Awaited<ReturnType<NineDeployClient['databases']['upgrades']['options']>>;
  let history: Upgrade[];
  try {
    [options, history] = await spinner('Reading the cluster', () => Promise.all([client.databases.upgrades.options(id), client.databases.upgrades.list(id)]));
  } catch (err) { fail(err); return; }
  header('Major upgrade');
  const name = label(options.engine ?? 'postgres');
  const current = options.currentSeries ?? (options.currentMajor != null ? String(options.currentMajor) : null);
  kv('Running', current != null ? `${name} ${current}` : c.dim('unknown'));
  if (options.refusal) info(options.refusal.message);
  else kv('Can move to', (options.versions ?? options.targets.map(String)).map((v) => `${name} ${v}`).join(', '));
  if (history.length) {
    table(history.map((u) => ({
      id: u.id,
      upgrade: `${fromOf(u)} → ${toOf(u)}`,
      status: u.status === 'running' ? `running (${u.phase ?? '…'})` : u.status,
      started: u.createdAt,
      kept: u.status === 'completed' ? u.previousVolume : u.status === 'rolled_back' ? u.targetVolume : '',
      error: u.error ?? '',
    })));
  }
}

export async function upgradeStart(
  client: NineDeployClient,
  dbIdStr: string,
  opts: { to?: string; yes?: boolean; wait?: boolean; pollMs?: number } = {},
): Promise<void> {
  const usage = 'Usage: ninedeploy databases upgrade start <dbId> --to <release> [--yes] [--no-wait]';
  const id = num(dbIdStr, usage);
  if (id === null) return;
  const to = (opts.to ?? '').trim();
  if (!/^[0-9]{1,2}([.][0-9]{1,2})?$/.test(to)) {
    error(`--to must be a release, e.g. --to 18 (PostgreSQL), --to 8.4 (MySQL) or --to 11.8 (MariaDB). ${usage}`);
    process.exitCode = 1;
    return;
  }
  if (!opts.yes && !(await confirm('upgrade', `The database stops for the whole upgrade (a safety dump, the move to ${to} in a new volume, a comparison). Attached services lose their connection until it is back.`))) return;
  // A whole number goes as toMajor, which panels from before MySQL/MariaDB upgrades also accept.
  const input = /^[0-9]+$/.test(to) ? { toMajor: Number(to) } : { toVersion: to };
  let admitted: Upgrade;
  try { admitted = await spinner('Checking the database', () => client.databases.upgrades.start(id, input)); } catch (err) { fail(err); return; }
  const target = `${label(admitted.engine)} ${toOf(admitted)}`;
  if (opts.wait === false) {
    success(`Upgrade #${admitted.id} to ${target} is running. Follow it with: ninedeploy databases upgrade status ${id}`);
    return;
  }
  let done: Upgrade;
  try {
    done = await spinner(`Upgrading to ${target}`, () => client.databases.upgrades.wait(id, admitted.id, opts.pollMs ? { intervalMs: opts.pollMs } : {}));
  } catch (err) { fail(err); return; }
  describeOutcome(done, id);
}

export async function upgradeRollback(client: NineDeployClient, dbIdStr: string, upgradeIdStr: string, opts: { yes?: boolean } = {}): Promise<void> {
  const usage = 'Usage: ninedeploy databases upgrade rollback <dbId> <upgradeId> [--yes]';
  const id = num(dbIdStr, usage);
  if (id === null) return;
  const upgradeId = num(upgradeIdStr, usage);
  if (upgradeId === null) return;
  if (!opts.yes && !(await confirm('rollback', 'The database restarts on its previous volume. Writes made since the upgrade stay on the upgraded volume and are NOT carried back.'))) return;
  try {
    const u = await spinner('Rolling back', () => client.databases.upgrades.rollback(id, upgradeId));
    success(`The database runs on ${label(u.engine)} ${fromOf(u)} again (${u.previousVolume}).`);
    info(`The upgraded volume ${u.targetVolume} is kept. Delete it with: ninedeploy databases upgrade finalize ${id} ${u.id}`);
  } catch (err) { fail(err); }
}

export async function upgradeFinalize(client: NineDeployClient, dbIdStr: string, upgradeIdStr: string, opts: { yes?: boolean } = {}): Promise<void> {
  const usage = 'Usage: ninedeploy databases upgrade finalize <dbId> <upgradeId> [--yes]';
  const id = num(dbIdStr, usage);
  if (id === null) return;
  const upgradeId = num(upgradeIdStr, usage);
  if (upgradeId === null) return;
  if (!opts.yes && !(await confirm('finalize', 'The volume the database no longer uses is DELETED; after this there is no rollback.'))) return;
  try {
    const u = await spinner('Finalizing', () => client.databases.upgrades.finalize(id, upgradeId));
    success(`Deleted ${u.removedVolume}.`);
  } catch (err) { fail(err); }
}
