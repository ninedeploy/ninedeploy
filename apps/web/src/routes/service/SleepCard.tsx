import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Moon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { SLEEP_AFTER_MAX, SLEEP_AFTER_MIN } from '@ninedeploy/schemas';
import type { ServiceDetail } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, Field, Input, Switch } from '../../components/ui.js';
import { fill, useT } from '../../lib/i18n.js';

/** The idle window the form starts from when nothing is stored. */
export const SLEEP_DEFAULT_MINUTES = 15;

/** The minutes typed, or null when they are not a whole number in range. */
export function parseSleepMinutes(value: string): number | null {
  const v = value.trim();
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= SLEEP_AFTER_MIN && n <= SLEEP_AFTER_MAX ? n : null;
}

/**
 * 0.16.11 scale to zero: a docker service on the panel host stops its
 * containers after a number of minutes without a request, and its next
 * request wakes it. Docker services only, on a panel that reports the
 * field. Members may change it, like the other deploy settings.
 */
export function SleepCard({ svc }: { svc: ServiceDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const shown = svc.type === 'docker' && 'sleepAfterMinutes' in svc;
  // Initialised once from the service row, like the other settings cards.
  const [enabled, setEnabled] = useState(svc.sleepAfterMinutes != null);
  const [minutes, setMinutes] = useState(String(svc.sleepAfterMinutes ?? SLEEP_DEFAULT_MINUTES));
  // The Network & Domains tab's own query: the same cache entry.
  const domains = useQuery({ queryKey: ['domains', svc.id], queryFn: () => api.domains.list(svc.id), enabled: shown });

  const parsed = parseSleepMinutes(minutes);
  const save = useMutation({
    mutationFn: (sleepAfterMinutes: number | null) => api.services.update(svc.id, { sleepAfterMinutes }),
    onSuccess: (_res, sleepAfterMinutes) => {
      qc.invalidateQueries({ queryKey: ['service', svc.id] });
      toast(
        sleepAfterMinutes != null ? t('Sleep when idle saved — it sleeps after {n} minutes without a request', { n: sleepAfterMinutes }) : t('Sleep when idle turned off'),
        'success',
      );
    },
    onError: (err) => toast(err instanceof Error && err.message ? err.message : t('Could not save the sleep setting'), 'error'),
  });

  if (!shown) return null;
  const noDomain = domains.data != null && !domains.data.some((d) => d.status === 'active');
  const problem = parsed == null ? t('A whole number of minutes, {min}–{max}', { min: SLEEP_AFTER_MIN, max: SLEEP_AFTER_MAX }) : undefined;

  return (
    <Card>
      <CardBody>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Moon size={15} className="text-slate-500" /> {t('Sleep when idle')}
          </div>
          <Switch checked={enabled} onChange={setEnabled} label={t('Sleep when idle')} />
        </div>
        <p className="text-xs leading-relaxed text-slate-500">
          {t('Once its domains have had no request for the set minutes, the service sleeps: its containers stop, and nothing is removed. It stays running in the panel. The next request through one of its domains wakes it; the visitor waits a few seconds for that first page.')}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
          {fill(t("It needs traffic analytics (an operator turns it on in {link}) and at least one domain; without them nothing sleeps. Host ports and the service's internal network do not count as requests and do not wake it, so a service reached only that way should not sleep."), {
            link: <Link to="/traefik" className="text-indigo-200 underline-offset-2 hover:underline">{t('Traefik → Traffic')}</Link>,
          })}
        </p>
        {svc.serverId != null ? (
          <p className="mt-1.5 text-xs text-amber-300">{t('This service runs on a node, so it does not sleep for now: scale to zero runs on the panel host only.')}</p>
        ) : svc.placement?.orchestrator === 'swarm' ? (
          <p className="mt-1.5 text-xs text-amber-300">{t('This service runs on Swarm; scale to zero does not apply to it.')}</p>
        ) : null}
        {noDomain && (
          <p className="mt-1.5 text-xs text-amber-300">
            {t('This service has no active domain, so no request could wake it: it does not sleep until one routes to it. Add one under Network & Domains.')}
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!enabled) save.mutate(null);
            else if (parsed != null) save.mutate(parsed);
          }}
          className="mt-4 space-y-4"
        >
          {enabled && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t('Sleep after (minutes)')} hint={t('Minutes without a request, {min}–{max}.', { min: SLEEP_AFTER_MIN, max: SLEEP_AFTER_MAX })} error={problem}>
                <Input
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                  inputMode="numeric"
                  placeholder={String(SLEEP_DEFAULT_MINUTES)}
                  aria-invalid={problem != null}
                  className="h-9 font-mono text-xs"
                />
              </Field>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={save.isPending || (enabled ? parsed == null : svc.sleepAfterMinutes == null)}>
              {save.isPending ? t('Saving…') : t('Save sleep setting')}
            </Button>
            <span className="text-xs text-slate-500">{t('Checked every minute; the idle window starts again after a deploy or a panel restart.')}</span>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
