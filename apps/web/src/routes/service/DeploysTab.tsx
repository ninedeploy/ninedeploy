import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowUpRight, Bot, GitCompare, RotateCcw, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AiFixProposal, Deployment } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Card, CardBody, Button, ConfirmDialog, Skeleton, Spinner, StatusBadge, cn } from '../../components/ui.js';
import { AiProposalCard } from './AiProposalCard.js';
import { ApprovalCard } from './ApprovalCard.js';
import { LogPanel } from './LogPanel.js';

export const IN_FLIGHT = ['queued', 'building', 'deploying', 'awaiting_ci'];

/** 0.16.13: a deploy into an approval-gated lane, waiting for an admin. Not in flight, not finished. */
export const WAITING = 'awaiting_approval';

/**
 * A deployment can be removed from history once it is finished AND is not the
 * one serving traffic. The server enforces both (and the `admin` role); this
 * only decides whether to offer the button.
 */
export const isRemovable = (status: string): boolean =>
  !IN_FLIGHT.includes(status) && status !== 'running' && status !== WAITING;

/** Deployment history + the live build log for the selected deployment. */
export function DeploysTab({
  serviceId,
  repoUrl,
  deploys,
  loading,
  activeId,
  onSelect,
}: {
  serviceId: number;
  /** Services sharing this repository are promotion targets. */
  repoUrl: string | null;
  deploys: Deployment[];
  loading: boolean;
  activeId: number | null;
  onSelect: (id: number | null) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const activeDeployRow = deploys.find((d) => d.id === activeId) ?? null;
  const inFlight = !!activeDeployRow && IN_FLIGHT.includes(activeDeployRow.status);
  // The worker keeps at most one waiting deploy per service.
  const waitingRow = deploys.find((d) => d.status === WAITING) ?? null;
  // Rollback swaps the LIVE release to an older one — the more disruptive
  // action on this page got the LESS protection (a hover-revealed icon, no
  // confirm), while a plain redeploy of a running service asks first.
  const [pendingRollback, setPendingRollback] = useState<number | null>(null);
  const restoreInfo = useQuery({
    queryKey: ['release-info', serviceId, pendingRollback],
    queryFn: () => api.deploys.releaseInfo(serviceId, pendingRollback!),
    enabled: pendingRollback != null,
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });

  // Per-row queue position so the per-service tab carries the same
  // affordance the global /deploys page exposes. Oldest queued id
  // becomes position #1, the next one #2, etc. The position is
  // computed from the local list because the server's per-service
  // list is already id-descending and bounded to 50 rows, which is
  // wider than the server-side 50-row cap so the two views agree.
  const positionById = useMemo(() => {
    // Reverse-iterate to claim positions in claim order (oldest queued
    // first). The list is id-desc so reverse-id-asc.
    const queued = deploys.filter((d) => d.status === 'queued');
    const sortedAsc = [...queued].sort((a, b) => a.id - b.id);
    const map = new Map<number, { position: number; total: number }>();
    for (let i = 0; i < sortedAsc.length; i++) {
      const d = sortedAsc[i]!;
      map.set(d.id, { position: i + 1, total: sortedAsc.length });
    }
    return map;
  }, [deploys]);

  const rollback = useMutation({
    mutationFn: (depId: number) => api.deploys.rollback(serviceId, depId),
    onSuccess: (res) => {
      onSelect(res.deploymentId);
      qc.invalidateQueries({ queryKey: ['deploys', serviceId] });
      qc.invalidateQueries({ queryKey: ['service', serviceId] });
      toast('Rollback started', 'info');
    },
    onError: (err: unknown) => toast(err instanceof Error ? err.message : 'Rollback failed', 'error'),
  });

  const cancelDeploy = useMutation({
    mutationFn: (depId: number) => api.deploys.cancel(serviceId, depId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deploys', serviceId] });
      toast('Deployment cancelled', 'info');
    },
    onError: () => toast('Cancel failed', 'error'),
  });

  const removeDeploy = useMutation({
    mutationFn: (depId: number) => api.deploys.remove(serviceId, depId),
    onSuccess: (_res, depId) => {
      // The removed row may be the one whose log is on screen; drop the
      // selection rather than leave the panel pointed at a deployment that no
      // longer exists.
      if (depId === activeId) onSelect(null);
      qc.invalidateQueries({ queryKey: ['deploys', serviceId] });
      toast('Deployment removed', 'info');
    },
    // The server refuses an in-flight deploy and the live one with a specific
    // reason; showing it beats a generic failure toast.
    onError: (err: unknown) => toast(err instanceof Error ? err.message : 'Remove failed', 'error'),
  });

  // Bulk: every failed or cancelled deploy of this service, in one call.
  const [confirmClear, setConfirmClear] = useState(false);
  const clearable = deploys.filter((d) => d.status === 'failed' || d.status === 'cancelled').length;
  const clearFailed = useMutation({
    mutationFn: () => api.deploys.removeMany(serviceId, { statuses: ['failed', 'cancelled'] }),
    onSuccess: (res) => {
      if (activeId != null && res.removed.includes(activeId)) onSelect(null);
      qc.invalidateQueries({ queryKey: ['deploys', serviceId] });
      const leftovers = res.removedContainers.length > 0 ? ` and ${res.removedContainers.length} leftover container(s)` : '';
      toast(`Removed ${res.removed.length} deployment(s)${leftovers}`, 'info');
    },
    onError: (err: unknown) => toast(err instanceof Error ? err.message : 'Remove failed', 'error'),
  });

  return (
    <div className="mt-5 space-y-5">
      <ConfirmDialog
        open={pendingRollback != null}
        title="Rollback to this deployment?"
        message={(() => {
          const row = deploys.find((d) => d.id === pendingRollback);
          const detail = restoreInfo.isError ? 'Release information could not be loaded.' : restoreInfo.data?.reason ?? 'Checking the release record…';
          return `The live release will be replaced by deployment #${pendingRollback}${row?.commitSha ? ` (${row.commitSha.slice(0, 7)})` : ''}. ${detail}`;
        })()}
        confirmLabel="Rollback"
        confirmDisabled={!restoreInfo.data?.available || restoreInfo.isError || restoreInfo.isFetching}
        onConfirm={() => {
          if (pendingRollback != null && restoreInfo.data?.available && !restoreInfo.isFetching) {
            rollback.mutate(pendingRollback);
            onSelect(null);
          }
        }}
        onClose={() => setPendingRollback(null)}
      />
      <ConfirmDialog
        open={confirmClear}
        title="Remove failed and cancelled deployments?"
        message={`Every failed or cancelled deployment of this service (${clearable} in the list) and its build log will be removed from history, with any container it left behind. Queued, running and live deployments are kept.`}
        confirmLabel="Remove"
        onConfirm={() => clearFailed.mutate()}
        onClose={() => setConfirmClear(false)}
      />
      {waitingRow && <ApprovalCard serviceId={serviceId} waiting={waitingRow} />}
      <DeploymentsCard
        deploys={deploys}
        activeId={activeId}
        onSelect={onSelect}
        onRollback={(depId) => setPendingRollback(depId)}
        onCancel={(depId) => cancelDeploy.mutate(depId)}
        onRemove={(depId) => removeDeploy.mutate(depId)}
        onClearFailed={clearable > 0 ? () => setConfirmClear(true) : undefined}
        clearable={clearable}
        loading={loading}
        positionById={positionById}
      />

      {activeDeployRow?.ciGate && (
        <Card><CardBody className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-slate-200">Required CI <StatusBadge status={activeDeployRow.ciGate.state === 'waiting' ? 'awaiting_ci' : activeDeployRow.ciGate.state === 'passed' ? 'success' : 'failed'} /></div>
          <p className="text-xs text-slate-400">{activeDeployRow.ciGate.reason}</p>
          <p className="break-all font-mono text-xs text-slate-400">{activeDeployRow.ciGate.headSha ?? 'Resolving commit…'}</p>
          <ul className="space-y-1 text-xs text-slate-400">{activeDeployRow.ciGate.checks.map((check) => (
            <li key={check.path}><span className="font-mono">{check.path}</span> · {check.state}{check.runId ? ` · run #${check.runId}, attempt ${check.attempt}` : ''}</li>
          ))}</ul>
        </CardBody></Card>
      )}
      {activeDeployRow?.artifact && <Card><CardBody className="space-y-1">
        <h3 className="text-sm font-medium">Immutable Docker artifact</h3>
        <p className="break-all font-mono text-xs text-slate-400">{activeDeployRow.artifact.imageId}</p>
        {activeDeployRow.artifact.originServerId != null && <p className="text-xs text-slate-400">Built on node #{activeDeployRow.artifact.originServerId} · Recoverable image copy retained on the panel.</p>}
        {activeDeployRow.artifact.registryRef && <p className="break-all font-mono text-xs text-slate-400">Registry archive: {activeDeployRow.artifact.registryRef}</p>}
        <p className="text-xs text-slate-400">Built by deployment #{activeDeployRow.artifact.originDeploymentId}{activeDeployRow.artifact.promotionSourceDeploymentId ? ` · Promoted from #${activeDeployRow.artifact.promotionSourceDeploymentId} without rebuilding` : ''} · Protected from NineDeploy image cleanup while this history is retained.</p>
      </CardBody></Card>}

      <PromoteCard serviceId={serviceId} repoUrl={repoUrl} deploys={deploys} />

      <Card>
        <CardBody className="flex h-full flex-col">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.07] bg-white/[0.03] text-slate-400">
                <Activity size={15} />
              </span>
              <div>
                <div className="text-sm font-medium text-slate-200">Deployment output</div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {activeDeployRow
                    ? `Deployment #${activeDeployRow.id} · ${activeDeployRow.commitSha?.slice(0, 7) ?? 'no commit'}`
                    : 'Select a deployment to inspect its output'}
                </div>
              </div>
            </div>
            {inFlight && (
              <span className="flex items-center gap-1.5 rounded-full border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-[11px] text-amber-300">
                <Spinner className="h-3 w-3" /> Live deployment
              </span>
            )}
          </div>
          <LogPanel
            serviceId={serviceId}
            deploymentId={activeId}
            deployStatus={activeDeployRow?.status}
          />
        </CardBody>
      </Card>

      {activeId && !inFlight && <ConfigDiffCard serviceId={serviceId} deploymentId={activeId} />}
      {activeId && !inFlight && <ReleaseRecordCard serviceId={serviceId} deploymentId={activeId} />}
      {activeId && activeDeployRow?.status === 'failed' && (
        <AiDiagnosisCard key={activeId} serviceId={serviceId} deploymentId={activeId} onDeployed={onSelect} />
      )}
    </div>
  );
}

// ── Config diff vs the previous deployment ────────────────────────────────
function ReleaseRecordCard({ serviceId, deploymentId }: { serviceId: number; deploymentId: number }) {
  const info = useQuery({ queryKey: ['release-info', serviceId, deploymentId], queryFn: () => api.deploys.releaseInfo(serviceId, deploymentId), retry: false });
  return <Card><CardBody>
    <h3 className="text-sm font-medium">Release recovery</h3>
    <p className="mt-1 text-sm text-neutral-400">
      {info.isError ? 'Release information could not be loaded.' : info.data?.reason ?? 'Checking the release record…'}
    </p>
    {info.data?.mode === 'recorded-compose' && <p className="mt-2 text-xs text-neutral-400">Encrypted release record · {info.data.imageCount} pinned images · Images are protected from NineDeploy cleanup while this history is retained. Compose replaces the stack in place with a brief interruption.</p>}
    {info.data?.mode === 'recorded-docker' && <p className="mt-2 text-xs text-neutral-400">Pinned Docker image · No rebuild or pull · Protected from NineDeploy cleanup while this history is retained.</p>}
  </CardBody></Card>;
}

function ConfigDiffCard({ serviceId, deploymentId }: { serviceId: number; deploymentId: number }) {
  const [open, setOpen] = useState(false);
  const diff = useQuery({
    queryKey: ['deploy-diff', serviceId, deploymentId],
    queryFn: () => api.deploys.configDiff(serviceId, deploymentId),
    enabled: open,
  });

  return (
    <Card>
      <CardBody>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between text-sm font-medium text-slate-300"
        >
          <span className="flex items-center gap-2">
            <GitCompare size={15} className="text-slate-500" /> Config diff vs previous deploy
          </span>
          <span className="text-xs text-slate-500">{open ? 'hide' : 'show'}</span>
        </button>
        {open && (
          <div className="mt-3">
            {diff.isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : !diff.data ? (
              <p className="text-xs text-slate-600">No snapshot.</p>
            ) : diff.data.previousDeploymentId === null ? (
              <p className="text-xs text-slate-600">First recorded deployment — nothing to compare against.</p>
            ) : !diff.data.changed ? (
              <p className="text-xs text-slate-500">
                No changes against #{diff.data.previousDeploymentId} — same build config and env keys.
              </p>
            ) : (
              <pre className="overflow-x-auto rounded-lg bg-black/40 p-3 font-mono text-[11px] leading-relaxed">
                {diff.data.diff.split('\n').map((line, i) => (
                  <span
                    // Line content repeats in real diffs (blank lines, `}`,
                    // shared context) — keying by content duplicates React keys.
                    key={`${i}-${line}`}
                    className={cn(
                      'block whitespace-pre',
                      line.startsWith('+ ') ? 'text-emerald-300' : line.startsWith('- ') ? 'text-rose-300' : 'text-slate-500',
                    )}
                  >
                    {line}
                  </span>
                ))}
              </pre>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ── Promote (staging → production lane hop) ───────────────────────────────
// Visible only when this service has a running deployment with a pinned
// commit AND at least one sibling service tracks the same repository — the
// server enforces the same invariants, this just decides whether to offer it.
function PromoteCard({
  serviceId,
  repoUrl,
  deploys,
}: {
  serviceId: number;
  repoUrl: string | null;
  deploys: Deployment[];
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [targetId, setTargetId] = useState('');
  const [mode, setMode] = useState<'artifact' | 'commit'>('artifact');
  const [confirmTarget, setConfirmTarget] = useState<{ target: number; sourceDeploymentId: number; imageId: string } | null>(null);
  const running = deploys.find((d) => d.status === 'running' && d.commitSha);
  const artifactMode = !!running?.artifact && mode === 'artifact';
  const candidatesQ = useQuery({
    queryKey: ['services'],
    queryFn: () => api.services.list(),
    // Only worth a services round-trip when promotion is actually possible.
    enabled: !!running && !!repoUrl,
  });
  const candidates = (candidatesQ.data ?? []).filter(
    (s) => s.id !== serviceId && !!s.repoUrl && s.repoUrl === repoUrl,
  );
  const swarmTarget = candidates.find(s => s.id === confirmTarget?.target)?.orchestrator === 'swarm';

  const promote = useMutation({
    mutationFn: ({ target, sourceDeploymentId }: { target: number; sourceDeploymentId?: number }) => sourceDeploymentId != null
      ? api.deploys.promote(serviceId, target, { mode: 'artifact', sourceDeploymentId })
      : api.deploys.promote(serviceId, target),
    onSuccess: (res, { target }) => {
      qc.invalidateQueries({ queryKey: ['deploys', target] });
      toast(
        `Promotion queued — deploying service #${target} @ ${res.commitSha.slice(0, 7)}`,
        'info',
      );
      setTargetId('');
      setConfirmTarget(null);
    },
    onError: (err: unknown) => toast(err instanceof Error ? err.message : 'Promotion failed', 'error'),
  });

  if (!running || !repoUrl || candidates.length === 0) return null;

  return (
    <><ConfirmDialog open={confirmTarget != null} title="Promote recorded artifact?"
      message={<div className="space-y-3">
        <p>Run the recorded image on {candidates.find(s => s.id === confirmTarget?.target)?.name ?? 'the target'}.</p>
        <p className="break-all font-mono text-xs text-slate-400">{confirmTarget?.imageId}</p>
        <p>{swarmTarget ? 'Target runtime environment, replica count, port and Swarm healthcheck apply.' : 'Target runtime environment, volumes, ports and health checks apply.'} Build-time values remain baked into the image.</p>
        <p>Required CI and lane approval still apply. No source checkout or build will run. The image is transferred to a node or restored from its pinned registry digest when needed.</p>
        {swarmTarget ? <p>Swarm rolls the same image across its replicas. Command or image healthchecks gate the native update; HTTP/TCP readiness is not available for Swarm.</p> : <p>Configured additional nodes receive the same image. Each target must pass its health and routing checks; a failed target keeps its previous release and is reported separately.</p>}
      </div>}
      confirmLabel="Promote artifact" confirmDisabled={promote.isPending} onClose={() => setConfirmTarget(null)} onConfirm={() => confirmTarget != null && promote.mutate(confirmTarget)} />
    <Card>
      <CardBody className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.07] bg-white/[0.03] text-slate-400">
            <ArrowUpRight size={15} />
          </span>
          <div>
            <div className="text-sm font-medium text-slate-200">{artifactMode ? 'Promote this artifact' : 'Promote this commit'}</div>
            <div className="mt-0.5 text-[11px] text-slate-500">
              {artifactMode ? 'Run the same image without rebuilding on the primary, configured additional nodes or Swarm replicas. Host hooks are not supported.' : <>Re-deploy another service at <span className="font-mono">{running.commitSha?.slice(0, 7)}</span> — the staging → production hop.</>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {running.artifact && <select aria-label="Promotion mode" value={mode} onChange={e => setMode(e.target.value as 'artifact' | 'commit')} className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-slate-300">
            <option value="artifact">Same artifact · no rebuild</option><option value="commit">Same commit · rebuild</option>
          </select>}
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            aria-label="Promotion target service"
            className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-slate-300 outline-none focus:border-indigo-500/40"
          >
            <option value="">Select service…</option>
            {candidates.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!targetId || promote.isPending}
            onClick={() => artifactMode ? setConfirmTarget({ target: Number(targetId), sourceDeploymentId: running.id, imageId: running.artifact!.imageId }) : promote.mutate({ target: Number(targetId) })}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-500/15 px-3 py-1.5 text-xs font-medium text-indigo-200 ring-1 ring-inset ring-indigo-500/30 transition hover:bg-indigo-500/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {promote.isPending && <Spinner className="h-3 w-3" />}
            Promote
          </button>
        </div>
      </CardBody>
    </Card></>
  );
}

// ── AI diagnosis (BYO-key) ────────────────────────────────────────────────
// Offered only for failed deployments AND only when the operator configured
// a provider (the server enforces both; this decides whether to offer it).
// Keyed by deployment id so switching rows resets the shown diagnosis.
function AiDiagnosisCard({
  serviceId,
  deploymentId,
  onDeployed,
}: {
  serviceId: number;
  deploymentId: number;
  onDeployed: (deploymentId: number) => void;
}) {
  const { toast } = useToast();
  const [diagnosis, setDiagnosis] = useState<string | null>(null);
  // 0.16.16: what the model proposes to change, when it proposed anything.
  const [proposal, setProposal] = useState<AiFixProposal | null>(null);
  const configQ = useQuery({
    queryKey: ['ai-config'],
    queryFn: () => api.ai.getConfig(),
    // Only worth the round-trip when a failed deploy is on screen.
    staleTime: 60_000,
  });
  const diagnose = useMutation({
    mutationFn: () => api.ai.diagnose(serviceId, deploymentId),
    onSuccess: (res) => {
      setDiagnosis(res.diagnosis);
      setProposal(res.proposal ?? null);
      toast(`Diagnosis ready (${res.model})`, 'info');
    },
    onError: (err: unknown) => toast(err instanceof Error ? err.message : 'Diagnosis failed', 'error'),
  });

  if (!configQ.data?.configured) return null;

  return (
    <Card>
      <CardBody>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Bot size={15} className={diagnosis ? 'text-emerald-300' : 'text-slate-500'} /> AI diagnosis
          </span>
          {diagnose.isPending ? (
            <span className="flex items-center gap-1.5 text-xs text-slate-500">
              <Spinner className="h-3 w-3" /> Analyzing build log…
            </span>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => diagnose.mutate()}>
              {diagnosis ? 'Re-analyze' : 'Diagnose failure'}
            </Button>
          )}
        </div>
        {diagnosis && (
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-lg bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-slate-300 ring-1 ring-inset ring-white/5">
            {diagnosis}
          </pre>
        )}
        {proposal && <AiProposalCard serviceId={serviceId} proposal={proposal} onDeployed={onDeployed} />}
      </CardBody>
    </Card>
  );
}

// ── Deployments ───────────────────────────────────────────────────────────
function DeploymentsCard({
  deploys,
  activeId,
  onSelect,
  onRollback,
  onCancel,
  onRemove,
  onClearFailed,
  clearable = 0,
  loading,
  positionById,
}: {
  deploys: Deployment[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onRollback?: (deploymentId: number) => void;
  onCancel?: (deploymentId: number) => void;
  onRemove?: (deploymentId: number) => void;
  /** Remove every failed/cancelled deploy (absent when there is none). */
  onClearFailed?: () => void;
  clearable?: number;
  loading: boolean;
  /**
   * Map from queued deployment id to its position + total in the
   * per-service queue. Computed by `DeploysTab` once and threaded
   * down so the row component stays pure.
   */
  positionById: Map<number, { position: number; total: number }>;
}) {
  return (
    <Card>
      <CardBody>
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-slate-300">Deployments</div>
            <p className="mt-0.5 text-[11px] text-slate-600">Select a release to inspect its pipeline and output.</p>
          </div>
          <div className="flex items-center gap-3">
            {onClearFailed && (
              <button type="button"
                onClick={onClearFailed}
                className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-slate-500 transition hover:bg-white/5 hover:text-rose-300"
                title="Remove every failed and cancelled deployment from history"
              >
                <Trash2 size={12} />
                Remove failed &amp; cancelled ({clearable})
              </button>
            )}
            {deploys.length > 0 && <span className="text-[11px] text-slate-600">{deploys.length} total</span>}
          </div>
        </div>
        {loading ? (
          <Skeleton className="h-8 w-full" />
        ) : deploys.length === 0 ? (
          <p className="py-2 text-xs text-slate-600">No deployments yet.</p>
        ) : (
          <ul className="flex gap-2 overflow-x-auto pb-1">
            {deploys.map((d, i) => {
              const duration =
                d.startedAt && d.finishedAt
                  ? Math.max(1, Math.round((new Date(d.finishedAt).getTime() - new Date(d.startedAt).getTime()) / 1000))
                  : null;
              return (
                <li key={d.id} className="group flex min-w-[15rem] items-center gap-1">
                  <button type="button"
                    onClick={() => onSelect(d.id)}
                    className={cn(
                      'flex flex-1 items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition',
                      d.id === activeId
                        ? 'border-blue-500/30 bg-blue-500/[0.08]'
                        : 'border-white/[0.06] bg-white/[0.015] hover:bg-white/[0.04]',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-xs text-slate-500">#{d.id}</span>
                        <span className="font-mono text-xs text-slate-300">{d.commitSha?.slice(0, 7) ?? '—'}</span>
                        <StatusBadge status={d.status} />
                        {d.status === 'queued' && positionById.get(d.id) && (
                          <span
                            className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-amber-300 ring-1 ring-inset ring-amber-500/20"
                            title={`Position ${positionById.get(d.id)!.position} of ${positionById.get(d.id)!.total} queued for this service`}
                          >
                            #{positionById.get(d.id)!.position} of {positionById.get(d.id)!.total}
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                        {d.message ? d.message : <span className="italic">no commit message</span>}
                        {' · '}
                        {d.trigger}
                        {d.author ? ` · ${d.author}` : ''}
                        {duration != null ? ` · ${duration}s` : ''}
                      </span>
                    </span>
                  </button>
                  {onCancel && (IN_FLIGHT.includes(d.status) || d.status === WAITING) && (
                    <button type="button"
                      onClick={() => onCancel(d.id)}
                      className="shrink-0 rounded p-1.5 text-slate-500 opacity-0 transition hover:bg-white/5 hover:text-amber-300 group-hover:opacity-100 focus-visible:opacity-100"
                      title={`Cancel deployment #${d.id}`}
                      aria-label={`Cancel deployment #${d.id}`}
                    >
                      <X size={12} />
                    </button>
                  )}
                  {onRollback &&
                    i > 0 &&
                    !IN_FLIGHT.includes(d.status) &&
                    d.status !== WAITING &&
                    d.status !== 'failed' &&
                    d.status !== 'cancelled' && (
                    <button type="button"
                      onClick={() => onRollback(d.id)}
                      className="shrink-0 rounded p-1.5 text-slate-600 opacity-0 transition hover:bg-white/5 hover:text-indigo-300 group-hover:opacity-100 focus-visible:opacity-100"
                      title={`Rollback to #${d.id}`}
                      aria-label={`Rollback to deployment #${d.id}`}
                    >
                      <RotateCcw size={12} />
                    </button>
                  )}
                  {onRemove && isRemovable(d.status) && (
                    <button type="button"
                      onClick={() => onRemove(d.id)}
                      className="shrink-0 rounded p-1.5 text-slate-600 opacity-0 transition hover:bg-white/5 hover:text-rose-300 group-hover:opacity-100 focus-visible:opacity-100"
                      title={`Remove deployment #${d.id} from history`}
                      aria-label={`Remove deployment #${d.id}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

