import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ScanSearch } from 'lucide-react';
import type { ImageScanFinding, ImageScanResult } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { msg, useT } from '../../lib/i18n.js';
import { Badge, Button, Card, CardBody } from '../../components/ui.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const TONE = { CRITICAL: 'rose', HIGH: 'amber', MEDIUM: 'sky', LOW: 'neutral', UNKNOWN: 'neutral' } as const;
const TRIGGER: Record<ImageScanResult['trigger'], string> = {
  deploy: msg('deploy'),
  schedule: msg('scheduled rescan'),
  manual: msg('manual scan'),
};
/** Findings shown before "Show all". */
const FIRST = 20;

/**
 * Service → Deploys: the latest vulnerability scan of the service's image
 * (G5.1). Shown once the service has a scan; an operator turns scanning on
 * under Settings → Image scanning.
 */
export function ImageScanCard({ serviceId }: { serviceId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [all, setAll] = useState(false);
  const scan = useQuery({
    queryKey: ['image-scan', serviceId],
    queryFn: () => api.imageScans.get(serviceId),
    refetchInterval: (q) => (q.state.data?.scanning ? 5000 : false),
  });
  const rescan = useMutation({
    mutationFn: () => api.imageScans.scan(serviceId),
    onSuccess: () => {
      toast(t('Scan started'), 'success');
      void qc.invalidateQueries({ queryKey: ['image-scan', serviceId] });
    },
    onError: (err) => toast(t('Could not start a scan: {error}', { error: errorText(err) }), 'error'),
  });

  const data = scan.data;
  if (!data || (!data.result && !data.scanning)) return null;
  const r = data.result;
  const findings: ImageScanFinding[] = r ? (all ? r.findings : r.findings.slice(0, FIRST)) : [];

  return (
    <Card>
      <CardBody className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold text-slate-200">
            <ScanSearch size={15} className="text-sky-300" /> {t('Image vulnerabilities')}
          </div>
          <Button size="sm" variant="secondary" onClick={() => rescan.mutate()} disabled={data.scanning || rescan.isPending}>
            {data.scanning ? t('Scanning…') : t('Scan now')}
          </Button>
        </div>
        {r && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              {r.os && <span>{r.os}</span>}
              <span className="text-slate-500">
                {t('{when} · {trigger}', { when: formatDateTime(r.scannedAt), trigger: t(TRIGGER[r.trigger]) })}
              </span>
              {r.blocked && <Badge tone="rose">{t('Deploy blocked by the gate')}</Badge>}
            </div>
            {r.status === 'error' ? (
              <p className="text-xs text-rose-300">{t('The scan could not run: {error}', { error: r.error ?? '' })}</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <Badge tone="rose">{t('{n} critical ({f} fixable)', { n: r.counts.critical, f: r.fixable.critical })}</Badge>
                  <Badge tone="amber">{t('{n} high ({f} fixable)', { n: r.counts.high, f: r.fixable.high })}</Badge>
                  <Badge tone="sky">{t('{n} medium', { n: r.counts.medium })}</Badge>
                  <Badge>{t('{n} low', { n: r.counts.low })}</Badge>
                </div>
                {findings.length === 0 ? (
                  <p className="text-xs text-emerald-300">{t('No known vulnerabilities.')}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="text-slate-500">
                        <tr>
                          <th className="py-1 pr-3 font-medium">{t('Severity')}</th>
                          <th className="py-1 pr-3 font-medium">{t('Vulnerability')}</th>
                          <th className="py-1 pr-3 font-medium">{t('Package')}</th>
                          <th className="py-1 pr-3 font-medium">{t('Installed')}</th>
                          <th className="py-1 font-medium">{t('Fixed in')}</th>
                        </tr>
                      </thead>
                      <tbody className="text-slate-300">
                        {findings.map((f) => (
                          <tr key={`${f.id}|${f.pkg}|${f.installed}|${f.target}`} className="border-t border-white/[0.05] align-top">
                            <td className="py-1 pr-3">
                              <Badge tone={TONE[f.severity]}>{f.severity}</Badge>
                            </td>
                            <td className="py-1 pr-3">
                              {f.url ? (
                                <a href={f.url} target="_blank" rel="noreferrer noopener" className="text-sky-300 hover:underline" title={f.title ?? undefined}>
                                  {f.id}
                                </a>
                              ) : (
                                <span title={f.title ?? undefined}>{f.id}</span>
                              )}
                            </td>
                            <td className="break-all py-1 pr-3 font-mono">{f.pkg}</td>
                            <td className="break-all py-1 pr-3 font-mono">{f.installed}</td>
                            <td className="break-all py-1 font-mono">{f.fixed ?? <span className="text-slate-500">{t('no fix')}</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {!all && r.findings.length > FIRST && (
                  <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
                    {t('Show all {n}', { n: r.findings.length })}
                  </Button>
                )}
                {r.findingsTruncated && (
                  <p className="text-xs text-slate-500">{t('Only the {n} most severe findings are kept.', { n: r.findings.length })}</p>
                )}
              </>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
