import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { CalendarClock, Save } from 'lucide-react';
import type { BackupPolicy } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { describeCron, isValidCron } from '../../lib/cron.js';
import { formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, Field, Input, Select, Skeleton, Switch } from '../../components/ui.js';

/** Schedule presets (server local time); anything else is "custom". */
export const BACKUP_SCHEDULE_PRESETS = [
  { id: 'daily', label: 'Daily (03:00)', cron: '0 3 * * *' },
  { id: '6h', label: 'Every 6 hours', cron: '0 */6 * * *' },
  { id: 'weekly', label: 'Weekly (Sunday 03:00)', cron: '0 3 * * 0' },
] as const;

const RETAIN_MIN = 1;
const RETAIN_MAX = 365;

/** Destination select values: the active destination, local only, or `dest-<id>`. */
type DestinationChoice = 'active' | 'local' | `dest-${number}`;

interface FormState {
  enabled: boolean;
  preset: string;
  customCron: string;
  retainCount: string;
  retainRemoteCount: string;
  destination: DestinationChoice;
}

function formFrom(p: BackupPolicy): FormState {
  const cron = p.cron ?? BACKUP_SCHEDULE_PRESETS[0].cron;
  const preset = BACKUP_SCHEDULE_PRESETS.find((x) => x.cron === cron)?.id ?? 'custom';
  return {
    enabled: p.enabled,
    preset,
    customCron: preset === 'custom' ? cron : '',
    retainCount: String(p.retainCount),
    retainRemoteCount: p.retainRemoteCount == null ? '' : String(p.retainRemoteCount),
    destination: p.localOnly ? 'local' : p.destinationId != null ? `dest-${p.destinationId}` : 'active',
  };
}

const inRange = (v: string) => /^\d+$/.test(v) && Number(v) >= RETAIN_MIN && Number(v) <= RETAIN_MAX;

/**
 * "Backup schedule" card on the database Backups tab (0.12): cron preset or
 * custom expression, retention counts and the destination. A database with
 * no saved policy is on the built-in schedule (daily, 7 kept, active
 * destination) — the card says so until the first save.
 */
export function BackupScheduleCard({ dbId }: { dbId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const isOperator = user?.isOperator === true;

  const policy = useQuery({
    queryKey: ['backup-policy', dbId],
    queryFn: () => api.backups.getPolicy(dbId),
  });
  // Destinations are operator-managed (their list route is operator-only).
  const destinations = useQuery({
    queryKey: ['backup-destinations'],
    queryFn: () => api.backupDestinations.list(),
    enabled: isOperator,
  });

  const [form, setForm] = useState<FormState | null>(null);
  useEffect(() => {
    if (policy.data) setForm(formFrom(policy.data));
  }, [policy.data]);

  const save = useMutation({
    mutationFn: (f: FormState) => {
      const cron = f.preset === 'custom' ? f.customCron.trim() : (BACKUP_SCHEDULE_PRESETS.find((p) => p.id === f.preset)?.cron ?? '');
      const localOnly = f.destination === 'local';
      return api.backups.setPolicy(dbId, {
        enabled: f.enabled,
        cron,
        retainCount: Number(f.retainCount),
        retainRemoteCount: localOnly || f.retainRemoteCount.trim() === '' ? null : Number(f.retainRemoteCount),
        destinationId: f.destination.startsWith('dest-') ? Number(f.destination.slice(5)) : null,
        localOnly,
      });
    },
    onSuccess: (saved) => {
      qc.setQueryData(['backup-policy', dbId], saved);
      toast('Backup schedule saved', 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Could not save the backup schedule', 'error'),
  });

  if (policy.isLoading || (!form && !policy.isError)) {
    return (
      <Card>
        <CardBody>
          <Skeleton className="h-24" />
        </CardBody>
      </Card>
    );
  }
  if (policy.isError || !form || !policy.data) {
    return (
      <Card>
        <CardBody>
          <p className="text-sm text-rose-300">Could not load the backup schedule.</p>
        </CardBody>
      </Card>
    );
  }

  const current = policy.data;
  const set = (patch: Partial<FormState>) => setForm({ ...form, ...patch });
  const cronExpr = form.preset === 'custom' ? form.customCron.trim() : (BACKUP_SCHEDULE_PRESETS.find((p) => p.id === form.preset)?.cron ?? '');
  const cronError = form.preset === 'custom' && cronExpr !== '' && !isValidCron(cronExpr) ? 'Expected 5 fields: minute hour day month weekday' : null;
  const retainError = inRange(form.retainCount) ? null : `Between ${RETAIN_MIN} and ${RETAIN_MAX}`;
  const remoteError = form.retainRemoteCount.trim() === '' || inRange(form.retainRemoteCount) ? null : `Between ${RETAIN_MIN} and ${RETAIN_MAX}, or blank`;
  const invalid = cronExpr === '' || cronError != null || retainError != null || (form.destination !== 'local' && remoteError != null);
  const knownDestinations = destinations.data ?? [];
  const pinnedId = current.destinationId;
  const pinnedUnlisted = pinnedId != null && !knownDestinations.some((d) => d.id === pinnedId);

  return (
    <Card className="overflow-hidden">
      <div className="p-4 border-b border-white/[0.06] flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
          <CalendarClock size={14} /> Backup schedule
        </h2>
        <span className="text-xs text-slate-500" data-testid="backup-schedule-status">
          {!current.configured
            ? `Built-in: daily, ${current.retainCount} kept`
            : !current.enabled
              ? 'Scheduled backups off'
              : current.nextRunAt
                ? `Next run ${formatDateTime(current.nextRunAt)}`
                : 'Scheduled'}
        </span>
      </div>
      <CardBody className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-slate-200">Scheduled backups</p>
            <p className="text-xs text-slate-500">Manual “Backup now” snapshots are never pruned by the schedule.</p>
          </div>
          <Switch checked={form.enabled} onChange={(v) => set({ enabled: v })} label="Scheduled backups" />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Schedule" hint={cronExpr && !cronError ? (describeCron(cronExpr) ?? cronExpr) : undefined}>
            <Select value={form.preset} onChange={(e) => set({ preset: e.target.value })} disabled={!form.enabled}>
              {BACKUP_SCHEDULE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom cron…</option>
            </Select>
          </Field>
          {form.preset === 'custom' && (
            <Field label="Cron expression" hint="server local time" error={cronError}>
              <Input
                value={form.customCron}
                onChange={(e) => set({ customCron: e.target.value })}
                placeholder="30 2 * * 1-5"
                className="font-mono"
                disabled={!form.enabled}
              />
            </Field>
          )}
          <Field label="Keep (local)" hint={`${RETAIN_MIN}–${RETAIN_MAX} scheduled dumps`} error={retainError}>
            <Input
              type="number"
              min={RETAIN_MIN}
              max={RETAIN_MAX}
              value={form.retainCount}
              onChange={(e) => set({ retainCount: e.target.value })}
            />
          </Field>
          <Field label="Destination">
            <Select value={form.destination} onChange={(e) => set({ destination: e.target.value as DestinationChoice })}>
              <option value="active">Active destination</option>
              <option value="local">Local only (no off-site copy)</option>
              {knownDestinations.map((d) => (
                <option key={d.id} value={`dest-${d.id}`}>
                  {d.name} ({d.bucket})
                </option>
              ))}
              {pinnedUnlisted && <option value={`dest-${pinnedId}`}>Destination #{pinnedId} (chosen by an operator)</option>}
            </Select>
          </Field>
          {form.destination !== 'local' && (
            <Field label="Keep (remote)" hint="blank = same as local" error={remoteError}>
              <Input
                type="number"
                min={RETAIN_MIN}
                max={RETAIN_MAX}
                value={form.retainRemoteCount}
                onChange={(e) => set({ retainRemoteCount: e.target.value })}
                placeholder={form.retainCount}
              />
            </Field>
          )}
        </div>

        <div className="flex justify-end">
          <Button size="sm" onClick={() => save.mutate(form)} disabled={invalid || save.isPending}>
            <Save size={12} /> Save schedule
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
