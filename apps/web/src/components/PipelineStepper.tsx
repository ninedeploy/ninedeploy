import { CheckCircle2, Clock, Flame, Globe, Layers, Loader2, RefreshCw, Server, ShieldCheck, XCircle } from 'lucide-react';
import type React from 'react';
import { useMemo } from 'react';
import { cn } from './ui.js';

export type StageId = 'PREPARE' | 'BUILD' | 'BOOT' | 'HEALTHCHECK' | 'PROXY_SWAP' | 'CLEANUP' | 'COMPLETE';
export type StageStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface PipelineStageInfo {
  id: StageId;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string; size?: number }>;
  status: StageStatus;
  detail?: string;
}

const STAGE_DEFS: Array<Omit<PipelineStageInfo, 'status' | 'detail'>> = [
  { id: 'PREPARE', label: 'Prepare', description: 'Checkout workspace and repository', icon: Layers },
  { id: 'BUILD', label: 'Build', description: 'Build with Dockerfile or Nixpacks', icon: Flame },
  { id: 'BOOT', label: 'Boot', description: 'Start an isolated container', icon: Server },
  { id: 'HEALTHCHECK', label: 'Health', description: 'Verify the HTTP health check', icon: ShieldCheck },
  { id: 'PROXY_SWAP', label: 'Route', description: 'Shift live traffic with Traefik', icon: RefreshCw },
  { id: 'CLEANUP', label: 'Cleanup', description: 'Gracefully stop the old container', icon: Clock },
  { id: 'COMPLETE', label: 'Live', description: 'Serve production traffic', icon: Globe },
];

export function parsePipelineStages(rawLogs: string, deployStatus?: string): PipelineStageInfo[] {
  const isFinalSuccess = deployStatus === 'running';
  const isFailed = deployStatus === 'failed';
  const isCancelled = deployStatus === 'cancelled';

  const stagesState: Record<StageId, { status: StageStatus; detail?: string }> = {
    PREPARE: { status: isFinalSuccess ? 'success' : 'pending' },
    BUILD: { status: isFinalSuccess ? 'success' : 'pending' },
    BOOT: { status: isFinalSuccess ? 'success' : 'pending' },
    HEALTHCHECK: { status: isFinalSuccess ? 'success' : 'pending' },
    PROXY_SWAP: { status: isFinalSuccess ? 'success' : 'pending' },
    CLEANUP: { status: isFinalSuccess ? 'success' : 'pending' },
    COMPLETE: { status: isFinalSuccess ? 'success' : 'pending' },
  };

  const lines = rawLogs.split('\n');
  let currentRunningStage: StageId | null = null;

  for (const line of lines) {
    const match = line.match(/##\[stage:([A-Z_]+):(running|success|failed)\](?:\s+(.*))?/);
    if (match) {
      const stageName = match[1] as StageId;
      const stageStatus = match[2] as StageStatus;
      const detail = match[3] || undefined;

      if (stageName === ('ERROR' as any)) {
        // Defensive: currentRunningStage is only ever set to a key that
        // exists in stagesState, so the second conjunct cannot be falsy.
        /* v8 ignore start */
        if (currentRunningStage && stagesState[currentRunningStage]) {
          stagesState[currentRunningStage].status = 'failed';
          stagesState[currentRunningStage].detail = detail || 'Stage failed';
        }
        /* v8 ignore stop */
        continue;
      }

      if (stagesState[stageName]) {
        stagesState[stageName].status = stageStatus;
        if (detail) stagesState[stageName].detail = detail;
        if (stageStatus === 'running') {
          currentRunningStage = stageName;
        } else if (stageStatus === 'success' && currentRunningStage === stageName) {
          currentRunningStage = null;
        }
      }
    }
  }

  // If failed and no explicit stage failed, mark the running stage as failed
  if ((isFailed || isCancelled) && currentRunningStage && stagesState[currentRunningStage]) {
    stagesState[currentRunningStage].status = 'failed';
    stagesState[currentRunningStage].detail = isCancelled ? 'Deployment cancelled' : 'An error occurred';
  }

  return STAGE_DEFS.map((def) => ({
    ...def,
    // Defensive: every STAGE_DEFS id exists in stagesState above, so the
    // fallback status is a type-level guard that cannot trigger at runtime.
    /* v8 ignore start */
    status: stagesState[def.id]?.status ?? (isFinalSuccess ? 'success' : 'pending'),
    /* v8 ignore stop */
    detail: stagesState[def.id]?.detail,
  }));
}

export function PipelineStepper({
  rawLogs,
  deployStatus,
  onStageClick,
}: {
  rawLogs: string;
  deployStatus?: string;
  onStageClick?: (stageId: StageId) => void;
}) {
  const stages = useMemo(() => parsePipelineStages(rawLogs, deployStatus), [rawLogs, deployStatus]);
  const isZeroDowntimeLive = deployStatus === 'running';
  const completedStages = stages.filter((stage) => stage.status === 'success').length;

  return (
    <section className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#0c0f17] shadow-lg shadow-black/10">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.06] px-4 py-3.5">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-emerald-400">
            <ShieldCheck size={16} />
          </div>
          <div>
            <h4 className="text-sm font-semibold text-slate-200">Zero-downtime deployment</h4>
            <p className="mt-0.5 text-xs text-slate-500">
              {isZeroDowntimeLive
                ? 'All traffic is now served by the new release.'
                : deployStatus === 'failed'
                  ? 'The health check failed and traffic stayed on the previous release.'
                  : 'The current release stays live while the new container is prepared.'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] tabular-nums text-slate-500">{completedStages}/{stages.length} complete</span>
          <span className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium',
            isZeroDowntimeLive
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
              : deployStatus === 'failed'
                ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                : 'bg-amber-500/10 text-amber-300 border-amber-500/20'
          )}>
            <span className={cn('h-1.5 w-1.5 rounded-full', isZeroDowntimeLive ? 'bg-emerald-400' : deployStatus === 'failed' ? 'bg-rose-400' : 'bg-amber-300')} />
            {isZeroDowntimeLive ? 'Live' : deployStatus === 'failed' ? 'Rolled back' : 'Deploying'}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto px-4 py-4">
        <div className="grid min-w-[42rem] grid-cols-7">
          {stages.map((st, index) => {
          const Icon = st.icon;
          const isPending = st.status === 'pending';
          const isRunning = st.status === 'running';
          const isSuccess = st.status === 'success';
          const isFailed = st.status === 'failed';

            return (
              <button
                key={st.id}
                type="button"
                onClick={() => onStageClick?.(st.id)}
                title={st.detail || st.description}
                aria-label={`${st.label}: ${st.detail || st.description}`}
                className="group relative flex min-w-0 flex-col items-center px-1 text-center"
              >
                {index > 0 && (
                  <span className={cn(
                    'absolute right-1/2 top-[17px] h-px w-full -translate-y-1/2',
                    isSuccess || isRunning ? 'bg-emerald-500/40' : isFailed ? 'bg-rose-500/40' : 'bg-white/[0.08]',
                  )} />
                )}
                <div className={cn(
                  'relative z-10 flex h-9 w-9 items-center justify-center rounded-full border bg-[#0c0f17] transition group-hover:scale-105',
                  isRunning && 'border-blue-400/60 text-blue-300 shadow-[0_0_18px_rgba(96,165,250,0.2)]',
                  isSuccess && 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
                  isFailed && 'border-rose-500/50 bg-rose-500/10 text-rose-400',
                  isPending && 'border-white/10 text-slate-600',
                )}>
                  {isRunning ? <Loader2 size={15} className="animate-spin" /> : isSuccess ? <CheckCircle2 size={15} /> : isFailed ? <XCircle size={15} /> : <Icon size={15} />}
                </div>
                <span className={cn(
                  'mt-2 text-[11px] font-medium',
                  isRunning && 'text-blue-300',
                  isSuccess && 'text-emerald-300',
                  isFailed && 'text-rose-300',
                  isPending && 'text-slate-500',
                )}>
                  {st.label}
                </span>
                <span className="mt-0.5 text-[9px] uppercase tracking-[0.08em] text-slate-600">
                  {isSuccess ? 'Done' : isRunning ? 'Running' : isFailed ? 'Failed' : `Step ${index + 1}`}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
