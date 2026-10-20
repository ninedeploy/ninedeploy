import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ShieldCheck, X } from 'lucide-react';
import type { Deployment } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, Spinner } from '../../components/ui.js';

/**
 * 0.16.13: the service's deploy waiting for approval (a lane with "Require
 * approval" on holds every deploy that is not an admin's own). An admin of
 * the lane approves it, so it builds, or rejects it; anyone else sees who
 * may decide. The server enforces who may — `mayReview` only decides
 * which buttons to offer.
 */
export function ApprovalCard({ serviceId, waiting }: { serviceId: number; waiting: Deployment }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const approvals = useQuery({
    queryKey: ['approvals'],
    queryFn: () => api.deploys.approvals(),
    refetchInterval: 10_000,
  });
  const item = approvals.data?.items.find((i) => i.id === waiting.id);
  const settle = () => {
    qc.invalidateQueries({ queryKey: ['deploys', serviceId] });
    qc.invalidateQueries({ queryKey: ['approvals'] });
  };
  const decide = useMutation({
    mutationFn: async (decision: 'approve' | 'reject'): Promise<void> => {
      if (decision === 'approve') await api.deploys.approve(serviceId, waiting.id);
      else await api.deploys.reject(serviceId, waiting.id);
    },
    onSuccess: (_res, decision) => {
      settle();
      toast(decision === 'approve' ? `Deployment #${waiting.id} approved — it builds next` : `Deployment #${waiting.id} rejected`, 'info');
    },
    onError: (err: unknown) => toast(err instanceof Error ? err.message : 'Could not record the decision', 'error'),
  });

  return (
    <Card className="border-violet-500/20">
      <CardBody>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-violet-500/20 bg-violet-500/10 text-violet-300">
              <ShieldCheck size={15} />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-200">Deployment #{waiting.id} is waiting for approval</div>
              <div className="mt-0.5 truncate text-[11px] text-slate-500">
                {waiting.commitSha ? waiting.commitSha.slice(0, 7) : 'no commit'}
                {waiting.message ? ` · ${waiting.message.split('\n')[0]}` : ''}
                {` · ${waiting.trigger}`}
                {waiting.author ? ` · ${waiting.author}` : ''}
              </div>
            </div>
          </div>
          {item?.mayReview ? (
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" variant="secondary" disabled={decide.isPending} onClick={() => decide.mutate('reject')}>
                <X size={13} /> Reject
              </Button>
              <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
                {decide.isPending ? <Spinner className="h-3 w-3" /> : <Check size={13} />} Approve
              </Button>
            </div>
          ) : (
            <span className="text-[11px] text-slate-500">
              {approvals.isLoading ? 'Checking…' : 'A workspace admin approves deploys into this lane. You can withdraw it with ✕ on the row.'}
            </span>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
