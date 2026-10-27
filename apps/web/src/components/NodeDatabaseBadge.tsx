import { Server } from 'lucide-react';
import type { ManagedDatabase } from '@ninedeploy/sdk';
import { useT } from '../lib/i18n.js';
import { Badge } from './ui.js';

/** The multi-node fields of a database response (absent before 0.15.3; null on the panel host). */
export type DatabasePlacement = Partial<Pick<ManagedDatabase, 'serverId' | 'serverName' | 'reachable'>>;

/** True for a database that runs on a node rather than the panel host. */
export function isNodeDatabase(db: DatabasePlacement): boolean {
  return db.serverId != null;
}

/**
 * The node a database runs on and the node's last reachability probe. Renders
 * nothing for a panel-host database or on a panel that predates node
 * databases.
 */
export function NodeDatabaseBadge({ db }: { db: DatabasePlacement }) {
  const t = useT();
  if (!isNodeDatabase(db)) return null;
  const name = db.serverName ?? t('node #{id}', { id: String(db.serverId) });
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone="sky">
        <Server size={10} className="mr-1" />
        {name}
      </Badge>
      {db.reachable === true ? (
        <Badge tone="emerald">{t('reachable')}</Badge>
      ) : db.reachable === false ? (
        <Badge tone="rose">{t('unreachable')}</Badge>
      ) : (
        <Badge>{t('not probed yet')}</Badge>
      )}
    </span>
  );
}

/**
 * Database detail, for a node database: a feature that needs a port on the
 * panel host (Web Studio, PgBouncer, the public-access sidecar) shown
 * disabled with the reason, instead of controls the server refuses
 * (`remote_database`).
 */
export function NodeUnavailableCard({ title, db }: { title: string; db: DatabasePlacement }) {
  const t = useT();
  return (
    <div
      aria-disabled="true"
      data-testid="node-unavailable"
      className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 opacity-80"
    >
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">{title}</h2>
      <p className="mt-2 text-xs leading-relaxed text-slate-500">
        {t(
          'Not available for a database on a node ({node}) yet: it needs a port on the node and a proxy path through the panel. Create the database on the panel host if you need it.',
          { node: db.serverName ?? t('node #{id}', { id: String(db.serverId) }) },
        )}
      </p>
    </div>
  );
}
