import { eq } from 'drizzle-orm';
import { domains, services, settings, type DB } from '@ninedeploy/db';
import { writeDynamicConfig } from '../engine/proxy.js';
import { HttpError } from './errors.js';
import { proxySettingJournal } from './proxySettingState.js';
import { setSettingJson } from './settings.js';
import { settingRowsWithPrefixes } from './settingRows.js';
import { clearNodePagesOutcome, nodePagesFailure } from './nodePagesSync.js';

export type ProxySetting = { owner: 'domain'; id: number; feature: 'forward_auth' } | { owner: 'service'; id: number; feature: 'maintenance' | 'error_pages' };
const keyOf = (s: ProxySetting) => `${s.feature}:${s.id}`;
const journalOf = (s: ProxySetting) => `proxy_apply_${s.owner}:${s.id}:${s.feature}`;
const tails = new WeakMap<DB, Promise<unknown>>();

/** Serialize reads and writes too: a second request cannot adopt or undo an in-flight setting. */
function exclusive<T>(db: DB, run: () => Promise<T>): Promise<T> {
  const next = (tails.get(db) ?? Promise.resolve()).then(run);
  const tail = next.catch(() => undefined);
  tails.set(db, tail);
  void tail.then(() => { if (tails.get(db) === tail) tails.delete(db); });
  return next;
}

const unconfirmed = () => new HttpError(503, 'proxy_setting_unconfirmed', 'The previous routing could not be confirmed. This setting is not shown as applied. Retry the change after the proxy is available; the panel also retries restoration after a restart and during its proxy checks.');
function parseJournal(value: unknown) {
  try { return proxySettingJournal.parse(typeof value === 'string' ? JSON.parse(value) : value); }
  catch { throw unconfirmed(); }
}

async function rollback(db: DB, s: ProxySetting): Promise<void> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, journalOf(s)) });
  if (!row) return;
  const saved = parseJournal(row.value);
  const owner = s.owner === 'domain'
    ? await db.query.domains.findFirst({ where: eq(domains.id, s.id) })
    : await db.query.services.findFirst({ where: eq(services.id, s.id) });
  // A deleted owner must not be resurrected by a delayed rollback.
  if (owner && saved.previous.present) await setSettingJson(db, keyOf(s), saved.previous.value);
  else await db.delete(settings).where(eq(settings.key, keyOf(s)));
  if (saved.serverId != null) clearNodePagesOutcome(saved.serverId);
  await writeDynamicConfig(db, saved.serverId == null ? { confirmLocalRouting: true } : { requireNode: saved.serverId, confirmNodeRouting: true });
  if (saved.serverId != null && s.owner === 'service' && await nodePagesFailure(db, saved.serverId, s.id) !== null) throw unconfirmed();
  await db.delete(settings).where(eq(settings.key, journalOf(s)));
}

export function readAppliedProxySetting<T>(db: DB, s: ProxySetting, read: () => Promise<T>): Promise<T> {
  return exclusive(db, async () => {
    if (await db.query.settings.findFirst({ where: eq(settings.key, journalOf(s)) })) throw unconfirmed();
    return read();
  });
}

/** Safe abort: success requires acknowledgement; all other outcomes restore the previous value. */
export function applyProxySetting<T>(
  db: DB, s: ProxySetting, serverId: number | null,
  save: () => Promise<void>, read: () => Promise<T>, log: (err: unknown) => void,
  afterApply?: () => Promise<void>,
): Promise<T> {
  return exclusive(db, async () => {
    try { await rollback(db, s); } catch (err) { log(err); throw unconfirmed(); }
    const previous = await db.query.settings.findFirst({ where: eq(settings.key, keyOf(s)) });
    await setSettingJson(db, journalOf(s), { serverId, previous: { present: !!previous, value: previous?.value ?? null } });
    try {
      await save();
      await writeDynamicConfig(db, serverId == null ? { confirmLocalRouting: true } : { requireNode: serverId, confirmNodeRouting: true });
      await afterApply?.();
      const result = await read();
      await db.delete(settings).where(eq(settings.key, journalOf(s)));
      return result;
    } catch (err) {
      log(err);
      try { await rollback(db, s); }
      catch (rollbackError) { log(rollbackError); throw unconfirmed(); }
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, 'proxy_setting_unapplied', 'The change was not applied: the proxy did not confirm it. The previous setting and routing were restored. Retry when the proxy is available.');
    }
  });
}

/** Boot/watchdog: abort unfinished writes, including a crash after a successful write but before its acknowledgement. */
export function recoverProxySettings(db: DB): Promise<void> {
  return exclusive(db, async () => {
    const rows = await settingRowsWithPrefixes(db, ['proxy_apply_domain:', 'proxy_apply_service:']);
    for (const row of rows) {
      const m = /^proxy_apply_(domain|service):([1-9]\d*):(forward_auth|maintenance|error_pages)$/.exec(row.key);
      if (!m) throw unconfirmed();
      const id = Number(m[2]);
      if (!Number.isSafeInteger(id)) throw unconfirmed();
      if (m[1] === 'domain' && m[3] === 'forward_auth') await rollback(db, { owner: 'domain', id, feature: 'forward_auth' });
      else if (m[1] === 'service' && (m[3] === 'maintenance' || m[3] === 'error_pages')) await rollback(db, { owner: 'service', id, feature: m[3] });
      else throw unconfirmed();
    }
  });
}
