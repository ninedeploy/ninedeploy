/**
 * `ninedeploy databases upgrade …` — O2 major-version upgrades (PostgreSQL on
 * the panel host).
 *
 *   status <dbId>                              current major, targets, and the upgrade history
 *   start <dbId> --to <major> [--yes] [--no-wait]
 *                                              stop, dump, restore into a new volume, compare, switch
 *   rollback <dbId> <upgradeId> [--yes]        point the database back at the previous volume
 *   finalize <dbId> <upgradeId> [--yes]        delete the volume the database no longer uses
 */
import type { NineDeployClient } from '../client.js';
import { prompt } from '../prompts.js';
import { c, error, header, info, kv, spinner, success, table } from '../lib/format.js';

type Upgrade = Awaited<ReturnType<NineDeployClient['databases']['upgrades']['start']>>;

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
    success(`Upgraded to PostgreSQL ${u.toMajor}.`);
    if (u.verification) info(`Compared before the switch: ${u.verification.tables} table(s), ${u.verification.rows} row(s), ${u.verification.sequences} sequence(s).`);
    info(`The previous volume ${u.previousVolume} is kept. Check your services, then: ninedeploy databases upgrade finalize ${dbId} ${u.id}`);
    info(`To go back to PostgreSQL ${u.fromMajor}: ninedeploy databases upgrade rollback ${dbId} ${u.id}`);
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
  kv('Running', options.currentMajor != null ? `PostgreSQL ${options.currentMajor}` : c.dim('unknown'));
  if (options.refusal) info(options.refusal.message);
  else kv('Can move to', options.targets.map((m) => `PostgreSQL ${m}`).join(', '));
  if (history.length) {
    table(history.map((u) => ({
      id: u.id,
      upgrade: `${u.fromMajor} → ${u.toMajor}`,
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
  const usage = 'Usage: ninedeploy databases upgrade start <dbId> --to <major> [--yes] [--no-wait]';
  const id = num(dbIdStr, usage);
  if (id === null) return;
  const toMajor = num(opts.to, `--to must be a PostgreSQL major, e.g. --to 18. ${usage}`);
  if (toMajor === null) return;
  if (!opts.yes && !(await confirm('upgrade', `The database stops for the whole upgrade (dump, restore into PostgreSQL ${toMajor}, compare). Attached services lose their connection until it is back.`))) return;
  let admitted: Upgrade;
  try { admitted = await spinner('Checking the cluster', () => client.databases.upgrades.start(id, { toMajor })); } catch (err) { fail(err); return; }
  if (opts.wait === false) {
    success(`Upgrade #${admitted.id} to PostgreSQL ${toMajor} is running. Follow it with: ninedeploy databases upgrade status ${id}`);
    return;
  }
  let done: Upgrade;
  try {
    done = await spinner(`Upgrading to PostgreSQL ${toMajor}`, () => client.databases.upgrades.wait(id, admitted.id, opts.pollMs ? { intervalMs: opts.pollMs } : {}));
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
    success(`The database runs on PostgreSQL ${u.fromMajor} again (${u.previousVolume}).`);
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
