import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ScanSearch } from 'lucide-react';
import type { ImageScanGate, ImageScanPolicyPatch } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { useT } from '../../lib/i18n.js';
import { Button, Card, CardBody, ErrorCard, Field, Input, Select, Skeleton, Switch } from '../../components/ui.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Settings → Image scanning (G5.1, operator only): Trivy scans each docker
 * deploy's image on the panel host before it gets traffic, and rescans what
 * runs on a schedule. Off by default.
 */
export function ImageScanSection() {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['image-scanning'], queryFn: () => api.imageScans.policy() });
  const [hours, setHours] = useState('');
  useEffect(() => {
    if (q.data) setHours(String(q.data.policy.rescanHours));
  }, [q.data]);

  const save = useMutation({
    mutationFn: (patch: ImageScanPolicyPatch) => api.imageScans.setPolicy(patch),
    onSuccess: (view) => {
      qc.setQueryData(['image-scanning'], view);
      toast(t('Image scanning saved'), 'success');
    },
    onError: (err) => toast(t('Could not save: {error}', { error: errorText(err) }), 'error'),
  });

  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.isError || !q.data) return <ErrorCard title={t('Could not load image scanning')} error={q.error} onRetry={() => void q.refetch()} />;
  const { policy, trivyImage } = q.data;
  const hoursValid = /^\d+$/.test(hours) && Number(hours) <= 720;

  return (
    <Card>
      <CardBody className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold text-slate-200">
            <ScanSearch size={15} className="text-sky-300" /> {t('Image scanning')}
          </div>
          <Switch checked={policy.enabled} onChange={(enabled) => save.mutate({ enabled })} disabled={save.isPending} label={t('Scan images')} />
        </div>
        <p className="text-xs text-slate-400">
          {t(
            'Trivy scans the image of every docker deploy on the panel host before it gets traffic, and rescans running images on a schedule. It reads the image from docker save; it never gets the Docker socket. Services on nodes, Swarm and Compose are not scanned yet.',
          )}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Deploy gate')} hint={t('A gated deploy fails before it gets traffic; the previous release keeps serving.')}>
            <Select value={policy.gate} onChange={(e) => save.mutate({ gate: e.target.value as ImageScanGate })} disabled={save.isPending}>
              <option value="off">{t('Report only')}</option>
              <option value="critical">{t('Block critical findings')}</option>
              <option value="high">{t('Block critical and high findings')}</option>
            </Select>
          </Field>
          <Field label={t('Rescan running images every (hours)')} hint={t('0 turns the schedule off.')}>
            <div className="flex gap-2">
              <Input inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} />
              <Button
                variant="secondary"
                disabled={!hoursValid || Number(hours) === policy.rescanHours || save.isPending}
                onClick={() => save.mutate({ rescanHours: Number(hours) })}
              >
                {t('Save')}
              </Button>
            </div>
          </Field>
        </div>
        <label className="flex items-center gap-3 text-xs text-slate-300">
          <Switch
            checked={policy.gateFixableOnly}
            onChange={(gateFixableOnly) => save.mutate({ gateFixableOnly })}
            disabled={save.isPending}
            label={t('Gate counts only fixable findings')}
          />
          {t('The gate counts only findings with a fixed version available. Off, an unfixable CVE in the base image blocks every deploy.')}
        </label>
        <p className="break-all text-xs text-slate-500">{t('Scanner image: {image}', { image: trivyImage })}</p>
        <p className="text-xs text-slate-500">
          {t('A scan that cannot run (for example, no network to update the vulnerability database) never blocks a deploy; the deploy log says so.')}
        </p>
      </CardBody>
    </Card>
  );
}
