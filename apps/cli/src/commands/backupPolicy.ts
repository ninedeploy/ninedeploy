/**
 * `ninedeploy databases backup-policy get|set <dbId>` — 0.12 per-database
 * backup policy: cron schedule, retention and destination. A database with
 * no saved policy is on the built-in schedule (daily, 7 kept, active
 * destination).
 */
import type { BackupPolicy, BackupPolicyInput } from '@ninedeploy/sdk';
import type { NineDeployClient } from '../client.js';
import { c, error, header, info, spinner, success } from '../lib/format.js';

/** Canonical decimal ids only — the server's `parseId` rule (F537). */
const CANONICAL_ID = /^[1-9]\d*$/;
const num = (v: string, usage: string): number => {
  const n = CANONICAL_ID.test(v) ? Number(v) : Number.NaN;
  if (!Number.isSafeInteger(n)) {
    error(usage);
    throw new Error(usage);
  }
  return n;
};

/** The presets the web card offers. */
export const BACKUP_CRON_PRESETS: Record<string, string> = {
  daily: '0 3 * * *',
  '6h': '0 */6 * * *',
  weekly: '0 3 * * 0',
};

function printPolicy(p: BackupPolicy): void {
  header('Backup policy');
  if (!p.configured) {
    info(`Schedule:    built-in (daily, ${p.retainCount} kept, active destination)`);
    info(c.dim('No policy saved — `ninedeploy databases backup-policy set` creates one.'));
    return;
  }
  info(`Enabled:     ${p.enabled ? 'yes' : c.yellow('no — no scheduled backups')}`);
  info(`Cron:        ${p.cron}`);
  info(`Keep:        ${p.retainCount} local`);
  info(`Remote keep: ${p.localOnly ? '—' : (p.retainRemoteCount ?? `same as local (${p.retainCount})`)}`);
  info(`Destination: ${p.localOnly ? 'local only' : p.destinationId != null ? `#${p.destinationId}` : 'active destination'}`);
  if (p.nextRunAt) info(`Next run:    ${p.nextRunAt}`);
}

/** `ninedeploy databases backup-policy get <dbId>` */
export async function backupPolicyGet(client: NineDeployClient, idStr: string): Promise<void> {
  const id = num(idStr, 'Usage: ninedeploy databases backup-policy get <dbId>');
  try {
    printPolicy(await spinner('Reading backup policy', () => client.backups.getPolicy(id)));
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
  }
}

export interface BackupPolicySetOpts {
  cron?: string;
  preset?: string;
  keep?: string;
  keepRemote?: string;
  destination?: string;
  enable?: boolean;
  disable?: boolean;
}

const intOpt = (v: string | undefined, flag: string): number | undefined => {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new Error(`${flag} must be a whole number`);
  return Number(v);
};

/**
 * Build the PUT body: the current policy (or the built-in defaults) with the
 * given flags applied — PUT replaces, so unset flags keep today's values.
 */
export function mergePolicyInput(current: BackupPolicy, opts: BackupPolicySetOpts): BackupPolicyInput {
  if (opts.enable && opts.disable) throw new Error('Use either --enable or --disable, not both');
  if (opts.cron && opts.preset) throw new Error('Use either --cron or --preset, not both');
  let cron = opts.cron ?? current.cron ?? undefined;
  if (opts.preset) {
    cron = BACKUP_CRON_PRESETS[opts.preset];
    if (!cron) throw new Error(`--preset must be one of: ${Object.keys(BACKUP_CRON_PRESETS).join(', ')}`);
  }
  if (!cron) throw new Error('No schedule yet: pass --cron "<5-field expression>" or --preset daily|6h|weekly');
  let destinationId = current.destinationId;
  let localOnly = current.localOnly;
  if (opts.destination !== undefined) {
    const d = opts.destination.trim().toLowerCase();
    if (d === 'local') {
      localOnly = true;
      destinationId = null;
    } else if (d === 'active' || d === 'default') {
      localOnly = false;
      destinationId = null;
    } else if (CANONICAL_ID.test(d)) {
      localOnly = false;
      destinationId = Number(d);
    } else {
      throw new Error('--destination must be a destination id, "active" or "local"');
    }
  }
  const keepRemote = intOpt(opts.keepRemote, '--keep-remote');
  return {
    enabled: opts.disable ? false : opts.enable ? true : current.enabled,
    cron,
    retainCount: intOpt(opts.keep, '--keep') ?? current.retainCount,
    retainRemoteCount: localOnly ? null : (keepRemote ?? current.retainRemoteCount),
    destinationId,
    localOnly,
  };
}

/** `ninedeploy databases backup-policy set <dbId> [--cron|--preset] [--keep] [--keep-remote] [--destination] [--enable|--disable]` */
export async function backupPolicySet(client: NineDeployClient, idStr: string, opts: BackupPolicySetOpts): Promise<void> {
  const id = num(idStr, 'Usage: ninedeploy databases backup-policy set <dbId> [options]');
  try {
    const current = await client.backups.getPolicy(id);
    const input = mergePolicyInput(current, opts);
    const saved = await spinner('Saving backup policy', () => client.backups.setPolicy(id, input));
    success('Backup policy saved.');
    printPolicy(saved);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
  }
}
