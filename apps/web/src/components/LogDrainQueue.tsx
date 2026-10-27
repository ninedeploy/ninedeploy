import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import { useToast } from './Toast.js';
import { Button } from './ui.js';

export function LogDrainQueue({ id, enabled }: { id: number; enabled: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = ['log-drain-queue', id];
  const queue = useQuery({ queryKey: key, queryFn: () => api.logDrains.queue(id), refetchInterval: 10000, retry: false });
  const retry = useMutation({
    mutationFn: () => api.logDrains.retryQueue(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); toast(t('Delivery will retry on the next cycle'), 'success'); },
    onError: () => toast(t('Could not schedule delivery retry'), 'error'),
  });
  const discard = useMutation({
    mutationFn: () => api.logDrains.discardQueue(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); toast(t('Queued log batches discarded'), 'success'); },
    onError: () => toast(t('Could not discard queued logs'), 'error'),
  });
  if (queue.isError) return <p className="border-t border-white/5 px-4 py-3 text-xs text-amber-300">{t('Delivery queue unavailable')}</p>;
  if (!queue.data) return null;
  const data = queue.data;
  return <div className="space-y-2 border-t border-white/5 px-4 py-3 text-xs text-slate-400">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span>{t('{lines} queued lines · {batches} batches · {size}', { lines: data.pendingEntries, batches: data.pendingBatches, size: formatBytes(data.payloadBytes) })}</span>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={!enabled || !data.pendingBatches || data.blockedBatches === data.pendingBatches || retry.isPending} onClick={() => retry.mutate()}>{t('Retry delivery')}</Button>
        <Button size="sm" variant="secondary" disabled={!data.pendingBatches || discard.isPending} onClick={() => {
          if (confirm(t('Permanently discard queued logs for this destination? These captured batches cannot be recovered.'))) discard.mutate();
        }}>{t('Discard queue')}</Button>
      </div>
    </div>
    {data.oldestAt && <p>{t('Oldest queued batch: {time}', { time: new Date(data.oldestAt).toLocaleString() })}</p>}
    {data.blockedBatches > 0 && <p className="text-amber-300">{t('{n} batches are bound to previous destination or credential settings. Restore those settings to deliver them, or discard the queue.', { n: data.blockedBatches })}</p>}
    {data.pausedSources > 0 && <p className="text-amber-300">{t('Capture paused for {n} sources because the queue is full or a log line exceeds the batch limit. Uncaptured logs remain subject to container log rotation.', { n: data.pausedSources })}</p>}
    {!enabled && data.pendingBatches > 0 && <p>{t('Delivery is paused while this destination is disabled. Its queue is retained.')}</p>}
  </div>;
}
