import { skipToken, useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ServiceDetail } from '@ninedeploy/sdk';
import { useT } from '../../lib/i18n.js';
import { cn } from '../../components/ui.js';

/**
 * A3 compact layout: the Settings cards a service rarely needs, folded under
 * "More settings". A card whose feature is ON never folds: maintenance on, a
 * restart limit, a canary or a Swarm placement change what the service does,
 * and a person looking for why must not find it hidden.
 *
 * The cards that load their own state (maintenance, restart limit, inline
 * Dockerfile, registry hook) are mounted even while folded, so their queries
 * run exactly as in the classic layout; this hook only watches the same cache
 * entries (skipToken: it never fetches). Such a card moves out of the fold
 * when its data says it is on.
 *
 * Kept visible in every case: what a person changes often (service fields,
 * limits, scaling, sleep), alerts that render only when there is something
 * to act on (recovery, move), the deploy hook, forward auth (its state is
 * per domain), and the capability limits notice.
 */
export type FoldKey =
  | 'target' | 'buildPlacement' | 'orchestrator' | 'inlineDockerfile' | 'containerOptions' | 'canary'
  | 'statusBadge' | 'registryHook' | 'commitStatus' | 'restartLimit' | 'maintenance';

const watch = <T,>(key: unknown[]) => ({ queryKey: key, queryFn: skipToken as unknown as () => Promise<T> });

export function useFeaturesOn(svc: ServiceDetail): Set<FoldKey> {
  const maintenance = useQuery(watch<{ maintenance: unknown }>(['maintenance', svc.id])).data;
  const pages = useQuery(watch<{ pages: Record<string, unknown> }>(['error-pages', svc.id])).data;
  const restart = useQuery(watch<{ limit: unknown }>(['restart-limit', svc.id])).data;
  const dockerfile = useQuery(watch<{ content: string | null }>(['inline-dockerfile', svc.id])).data;
  const registry = useQuery(watch<{ enabled: boolean }>(['registry-hook', svc.id])).data;

  const on = new Set<FoldKey>();
  if (svc.serverId != null) on.add('target');
  const p = svc.placement;
  if (p && ((p.buildOn ?? 'target') !== 'target' || p.buildServerId != null || p.pushRegistrySourceId != null)) on.add('buildPlacement');
  if (svc.orchestrator === 'swarm' || p?.orchestrator === 'swarm') on.add('orchestrator');
  const o = svc.runtimeOptions;
  if (o && (o.gpus != null || o.shmSizeMb != null || o.init === true || o.ulimitNofile != null || (o.capAdd?.length ?? 0) > 0)) on.add('containerOptions');
  if (svc.canary != null) on.add('canary');
  if (maintenance?.maintenance != null || Object.keys(pages?.pages ?? {}).length > 0) on.add('maintenance');
  if (restart?.limit != null) on.add('restartLimit');
  if (dockerfile?.content) on.add('inlineDockerfile');
  if (registry?.enabled) on.add('registryHook');
  return on;
}

/** The fold itself. Its cards stay mounted while closed (see above). */
export function SettingsFold({ children }: { children: ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="service-more-settings"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-left text-sm font-medium text-slate-300 transition hover:bg-white/[0.04]"
      >
        <span>{t('More settings')}</span>
        <span className="text-xs font-normal text-slate-500">{t('Placement, container options, canary, hooks, maintenance and restart limit')}</span>
        <ChevronDown size={15} className={cn('ml-auto opacity-60 transition-transform', open && 'rotate-180')} />
      </button>
      <div id="service-more-settings" hidden={!open} className="mt-5 space-y-5">
        {children}
      </div>
    </section>
  );
}
