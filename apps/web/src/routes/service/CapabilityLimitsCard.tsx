import { Info } from 'lucide-react';
import type { CapabilityStatus, ServiceCapabilityId } from '@ninedeploy/sdk';
import { Badge, Card, CardBody } from '../../components/ui.js';
import { useServiceCapabilities } from '../../lib/capabilities.js';
import { msg, useT } from '../../lib/i18n.js';

const LABEL: Record<ServiceCapabilityId, string> = {
  maintenance: msg('Maintenance mode'),
  errorPages: msg('Custom error pages'),
  forwardAuth: msg('Panel sign-in on a domain'),
  restartLimit: msg('Restart-loop limit'),
  inlineDockerfile: msg('Inline Dockerfile'),
  fileMounts: msg('File mounts'),
  autoscale: msg('Autoscaling'),
  scaleToZero: msg('Scale to zero'),
  canary: msg('Canary releases'),
};
const STATUS: Record<Exclude<CapabilityStatus, 'available'>, { label: string; tone: 'amber' | 'sky' | 'neutral' }> = {
  limited: { label: msg('Limited'), tone: 'amber' },
  in_progress: { label: msg('Coming'), tone: 'sky' },
  unavailable: { label: msg('Not here'), tone: 'neutral' },
};

/**
 * Service → Settings (C1): the features this service cannot fully use where it
 * runs, with the server's reason for each, so a hidden card or a refused save
 * is never a surprise. Folded by default; nothing renders when all is available.
 */
export function CapabilityLimitsCard({ serviceId }: { serviceId: number }) {
  const t = useT();
  const caps = useServiceCapabilities(serviceId);
  if (!caps.data) return null;
  const rows = (Object.entries(caps.data.capabilities) as Array<[ServiceCapabilityId, { status: CapabilityStatus; reason: string | null }]>).filter(
    ([, c]) => c.status !== 'available',
  );
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardBody>
        <details>
          <summary className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
            <Info size={14} className="text-slate-500" />
            {t('{n} features are limited or unavailable for this service', { n: rows.length })}
          </summary>
          <ul className="mt-3 space-y-2">
            {rows.map(([id, c]) => {
              const s = STATUS[c.status as Exclude<CapabilityStatus, 'available'>];
              return (
                <li key={id} className="text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-slate-200">{t(LABEL[id])}</span>
                    <Badge tone={s.tone}>{t(s.label)}</Badge>
                  </div>
                  {c.reason && <p className="mt-0.5 text-slate-500">{c.reason}</p>}
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-[11px] text-slate-500">{t('See docs/SUPPORT_MATRIX.md for every runtime.')}</p>
        </details>
      </CardBody>
    </Card>
  );
}
