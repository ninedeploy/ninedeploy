/**
 * `ninedeploy system panel-backup {status,set,now,list,decrypt}` — the panel's
 * own scheduled, passphrase-sealed backup (0.12). `decrypt` works offline: it
 * is the restore path on a new server (decrypt, then `ninedeploy system import`).
 */
import type { PanelBackupSettingsPatch, PanelBackupStatus } from '@ninedeploy/sdk';
import type { NineDeployClient } from '../client.js';
import { error, fmtBytes, fmtTime, header, info, kv, success, table } from '../lib/format.js';
import { decryptPanelBackup } from '../lib/panelBackupFile.js';
import { promptHidden } from '../prompts.js';

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function printStatus(s: PanelBackupStatus): void {
  kv('Enabled', s.settings.enabled ? 'yes' : 'no');
  kv('Schedule', s.settings.cron);
  kv('Destination', s.settings.destinationId ?? '—');
  kv('Keep', s.settings.retain);
  kv('Passphrase', s.settings.hasPassphrase ? 'set' : 'NOT SET');
  kv('Next run', s.nextRunAt ? fmtTime(s.nextRunAt) : '—');
  kv('Running', s.running ? 'yes' : 'no');
  if (s.lastRun) {
    kv('Last run', `${s.lastRun.status} (${s.lastRun.trigger}) ${fmtTime(s.lastRun.finishedAt ?? s.lastRun.startedAt)}`);
    if (s.lastRun.error) kv('Last error', s.lastRun.error);
    if (s.lastRun.warning) kv('Warning', s.lastRun.warning);
  }
  kv('Last success', s.lastSuccessAt ? fmtTime(s.lastSuccessAt) : 'never');
  if (s.masterKeyFromEnv) {
    info('The master key comes from NINEDEPLOY_MASTER_KEY(S): backups do NOT contain it — keep it with the recovery passphrase.');
  }
}

export async function panelBackupStatusAction(client: NineDeployClient): Promise<void> {
  header('Panel backup');
  try {
    printStatus(await client.system.panelBackup.get());
  } catch (err) {
    error(message(err));
  }
}

export interface PanelBackupSetOptions {
  enable?: boolean;
  disable?: boolean;
  cron?: string;
  destination?: string;
  retain?: string;
  passphrase?: boolean;
}

/** Build the PUT body from flags; returns an error string for bad input. */
export async function panelBackupSetBody(
  opts: PanelBackupSetOptions,
  ask: (msg: string) => Promise<string> = promptHidden,
): Promise<PanelBackupSettingsPatch | string> {
  if (opts.enable && opts.disable) return 'Pass --enable or --disable, not both';
  const body: PanelBackupSettingsPatch = {};
  if (opts.enable) body.enabled = true;
  if (opts.disable) body.enabled = false;
  if (opts.cron !== undefined) body.cron = opts.cron;
  if (opts.destination !== undefined) {
    const id = Number(opts.destination);
    if (!Number.isInteger(id) || id <= 0) return '--destination must be a backup destination id';
    body.destinationId = id;
  }
  if (opts.retain !== undefined) {
    const n = Number(opts.retain);
    if (!Number.isInteger(n) || n < 1) return '--retain must be a whole number of at least 1';
    body.retain = n;
  }
  if (opts.passphrase) {
    const first = await ask('Recovery passphrase (keep it OFF this server)');
    const again = await ask('Repeat the passphrase');
    if (!first) return 'Empty passphrase';
    if (first !== again) return 'The passphrases do not match';
    body.passphrase = first;
  }
  if (Object.keys(body).length === 0) return 'Nothing to change — see `ninedeploy system panel-backup set --help`';
  return body;
}

export async function panelBackupSetAction(client: NineDeployClient, opts: PanelBackupSetOptions): Promise<void> {
  const body = await panelBackupSetBody(opts);
  if (typeof body === 'string') return error(body);
  try {
    const status = await client.system.panelBackup.update(body);
    success('Panel backup settings saved');
    printStatus(status);
  } catch (err) {
    error(message(err));
  }
}

export async function panelBackupNowAction(
  client: NineDeployClient,
  opts: { wait?: boolean },
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  try {
    await client.system.panelBackup.run();
  } catch (err) {
    return error(message(err));
  }
  if (!opts.wait) {
    success('Panel backup started — check `ninedeploy system panel-backup status`');
    return;
  }
  info('Panel backup started — waiting for it to finish…');
  // A backup of a large panel database can take a while; poll, bounded.
  for (let i = 0; i < 720; i++) {
    await sleep(2500);
    let s: PanelBackupStatus;
    try {
      s = await client.system.panelBackup.get();
    } catch (err) {
      return error(message(err));
    }
    if (s.running) continue;
    if (s.lastRun?.status === 'completed') {
      success(`Uploaded ${s.lastRun.key} (${fmtBytes(s.lastRun.sizeBytes ?? 0)})`);
      if (s.lastRun.warning) info(s.lastRun.warning);
      return;
    }
    return error(`Panel backup failed: ${s.lastRun?.error ?? 'unknown error'}`);
  }
  error('Stopped waiting after 30 minutes — the backup may still be running.');
}

export async function panelBackupListAction(client: NineDeployClient, opts: { destination?: string }): Promise<void> {
  header('Panel backups');
  const id = opts.destination === undefined ? undefined : Number(opts.destination);
  if (id !== undefined && (!Number.isInteger(id) || id <= 0)) return error('--destination must be a backup destination id');
  try {
    const { items } = await client.system.panelBackup.list(id);
    if (items.length === 0) {
      info('No panel backups in this destination.');
      return;
    }
    table(
      items.map((o) => ({ name: o.name, size: fmtBytes(o.sizeBytes), date: fmtTime(o.lastModified), key: o.key })),
      ['name', 'size', 'date', 'key'],
    );
  } catch (err) {
    error(message(err));
  }
}

/** Offline: open a downloaded `.ndpb` into the `.tar.gz` that `system import` takes. */
export async function panelBackupDecryptAction(
  file: string,
  out: string | undefined,
  ask: (msg: string) => Promise<string> = promptHidden,
): Promise<void> {
  if (!file) return error('Usage: ninedeploy system panel-backup decrypt <file.ndpb> [out.tar.gz]');
  const target = out ?? `${file.replace(/\.ndpb$/i, '')}.tar.gz`;
  const passphrase = await ask('Recovery passphrase');
  if (!passphrase) return error('Empty passphrase');
  try {
    await decryptPanelBackup(file, target, passphrase);
  } catch (err) {
    return error(message(err));
  }
  success(`Decrypted to ${target}`);
  info(`Restore it with: ninedeploy system import ${target}  (then restart NineDeploy)`);
}
