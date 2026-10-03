import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { HardDrive, Sparkles } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, ErrorCard, Input, cn } from '../../components/ui.js';
import type { AutoPruneConfigUpdateInput } from '@ninedeploy/sdk';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

interface StorageFormState {
  enabled: boolean;
  thresholdPercent: number;
  pruneImages: boolean;
  pruneBuildCache: boolean;
  pruneContainers: boolean;
  pruneVolumes: boolean;
  maxAgeHours: number;
}

const DEFAULT_CONFIG: StorageFormState = {
  enabled: true,
  thresholdPercent: 85,
  pruneImages: true,
  pruneBuildCache: true,
  pruneContainers: true,
  pruneVolumes: false,
  maxAgeHours: 168,
};

export function StorageSection() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const pruneStatus = useQuery({
    queryKey: ['auto-prune-status'],
    queryFn: () => api.housekeeping.getAutoPrune(),
  });

  const [form, setForm] = useState<StorageFormState>(DEFAULT_CONFIG);

  useEffect(() => {
    if (pruneStatus.data) {
      setForm({
        enabled: pruneStatus.data.enabled,
        thresholdPercent: pruneStatus.data.thresholdPercent,
        pruneImages: pruneStatus.data.pruneImages,
        pruneBuildCache: pruneStatus.data.pruneBuildCache,
        pruneContainers: pruneStatus.data.pruneContainers,
        pruneVolumes: pruneStatus.data.pruneVolumes,
        maxAgeHours: pruneStatus.data.maxAgeHours,
      });
    }
  }, [pruneStatus.data]);

  const updateConfig = useMutation({
    mutationFn: (data: AutoPruneConfigUpdateInput) => api.housekeeping.updateAutoPrune(data),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ['auto-prune-status'] });
      toast(`Auto-prune settings saved (trigger at ${updated.thresholdPercent}% disk usage)`, 'success');
    },
    onError: () => toast('Failed to update auto-prune settings', 'error'),
  });

  const runPrune = useMutation({
    mutationFn: () => api.housekeeping.runPrune(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['auto-prune-status'] });
      const freed = formatBytes(res.freedBytes);
      toast(`Disk clean completed! Reclaimed ${freed}`, 'success');
    },
    onError: () => toast('Failed to execute disk cleanup', 'error'),
  });

  const data = pruneStatus.data;
  const usedPercent = data ? data.diskUsedPercent : 0;
  const totalGb = data ? (data.diskTotalBytes / 1024 / 1024 / 1024).toFixed(1) : '0';
  const freeGb = data ? (data.diskFreeBytes / 1024 / 1024 / 1024).toFixed(1) : '0';

  const gaugeColor =
    usedPercent > 85 ? 'bg-rose-500' : usedPercent > 70 ? 'bg-amber-500' : 'bg-emerald-500';

  const header = (
    <div>
      <h2 className="text-lg font-medium text-slate-100">Storage &amp; Auto-Pruning</h2>
      <p className="text-xs text-slate-400">
        Monitor host disk utilization and configure automated background cleanup of dangling Docker images, builder layers, containers, and volumes.
      </p>
    </div>
  );

  // r562: the form starts from DEFAULT_CONFIG and only takes the server's
  // values once they load. On a failed load it showed a 0 GB gauge and a
  // working Save that wrote those defaults over the real configuration.
  if (pruneStatus.isError && !data) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorCard title="Could not load the storage settings" error={pruneStatus.error} onRetry={() => void pruneStatus.refetch()} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      {/* Disk Usage Overview */}
      <Card>
        <CardBody className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                <HardDrive size={20} />
              </div>
              <div>
                <span className="text-xs font-medium uppercase tracking-wider text-slate-400">Host Storage Gauge</span>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-slate-100">{usedPercent}%</span>
                  <span className="text-xs text-slate-400">used of {totalGb} GB ({freeGb} GB free)</span>
                </div>
              </div>
            </div>

            <Button
              size="sm"
              variant="secondary"
              disabled={runPrune.isPending}
              onClick={() => runPrune.mutate()}
              className="gap-1.5"
            >
              <Sparkles size={14} />
              Run Cleanup Now
            </Button>
          </div>

          <div className="h-3 w-full overflow-hidden rounded-full bg-black/40 border border-white/10 p-0.5">
            <div
              className={cn('h-full rounded-full transition-all duration-500', gaugeColor)}
              style={{ width: `${Math.min(usedPercent, 100)}%` }}
            />
          </div>

          {data && data.lastPrunedAt && (
            <div className="flex items-center justify-between border-t border-white/[0.06] pt-3 text-xs text-slate-400">
              <span>Last pruned: {new Date(data.lastPrunedAt).toLocaleString()}</span>
              {data.lastFreedBytes != null && (
                <span>Reclaimed: <strong className="text-slate-200">{formatBytes(data.lastFreedBytes)}</strong></span>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Auto-Prune Configuration */}
      <Card>
        <CardBody className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-slate-200">Automated Background Prune Engine</h3>
              <p className="text-xs text-slate-400">Hourly background check executes cleanup when host disk exceeds the threshold.</p>
            </div>
            <button
              type="button"
              onClick={() => setForm((prev) => ({ ...prev, enabled: !prev.enabled }))}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-semibold border transition',
                form.enabled
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                  : 'bg-slate-800 text-slate-400 border-slate-700',
              )}
            >
              {form.enabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>

          <div className="space-y-4 pt-2 border-t border-white/[0.06]">
            <div>
              <div className="flex justify-between text-xs font-medium text-slate-300 mb-1.5">
                <span>Threshold Trigger (% Disk Utilization)</span>
                <span className="text-indigo-400 font-bold">{form.thresholdPercent}%</span>
              </div>
              <input
                type="range"
                min={50}
                max={95}
                step={5}
                value={form.thresholdPercent}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  setForm((prev) => ({ ...prev, thresholdPercent: val }));
                }}
                className="w-full h-2 rounded-lg bg-black/40 accent-indigo-500 cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-slate-500 mt-1">
                <span>50% (Aggressive)</span>
                <span>85% (Recommended)</span>
                <span>95% (Conservative)</span>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-300">Artifact Retention Max Age (Hours)</label>
              <Input
                type="number"
                min={1}
                max={720}
                value={form.maxAgeHours}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10) || 168;
                  setForm((prev) => ({ ...prev, maxAgeHours: val }));
                }}
              />
              <p className="text-[11px] text-slate-500 mt-1">Only images and build layers older than this age will be pruned (168h = 7 days).</p>
            </div>

            <div className="space-y-2 pt-2">
              <span className="block text-xs font-medium text-slate-300">Cleanup Targets</span>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex items-center gap-2 rounded-lg bg-black/20 p-2.5 border border-white/[0.06] cursor-pointer hover:bg-black/30">
                  <input
                    type="checkbox"
                    checked={form.pruneImages}
                    onChange={(e) => setForm((prev) => ({ ...prev, pruneImages: e.target.checked }))}
                    className="rounded accent-indigo-500"
                  />
                  <span className="text-xs text-slate-200">Unused Docker Images</span>
                </label>

                <label className="flex items-center gap-2 rounded-lg bg-black/20 p-2.5 border border-white/[0.06] cursor-pointer hover:bg-black/30">
                  <input
                    type="checkbox"
                    checked={form.pruneBuildCache}
                    onChange={(e) => setForm((prev) => ({ ...prev, pruneBuildCache: e.target.checked }))}
                    className="rounded accent-indigo-500"
                  />
                  <span className="text-xs text-slate-200">BuildKit Cache Layers</span>
                </label>

                <label className="flex items-center gap-2 rounded-lg bg-black/20 p-2.5 border border-white/[0.06] cursor-pointer hover:bg-black/30">
                  <input
                    type="checkbox"
                    checked={form.pruneContainers}
                    onChange={(e) => setForm((prev) => ({ ...prev, pruneContainers: e.target.checked }))}
                    className="rounded accent-indigo-500"
                  />
                  <span className="text-xs text-slate-200">Stopped Containers</span>
                </label>

                <label className="flex items-center gap-2 rounded-lg bg-black/20 p-2.5 border border-white/[0.06] cursor-pointer hover:bg-black/30">
                  <input
                    type="checkbox"
                    checked={form.pruneVolumes}
                    onChange={(e) => setForm((prev) => ({ ...prev, pruneVolumes: e.target.checked }))}
                    className="rounded accent-indigo-500"
                  />
                  <span className="text-xs text-slate-200">Anonymous Volumes</span>
                </label>
              </div>
            </div>

            <div className="flex justify-end pt-3">
              <Button
                // r562: never before the real config has loaded (see above).
                disabled={updateConfig.isPending || !data}
                onClick={() => updateConfig.mutate(form)}
              >
                Save Auto-Prune Settings
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
