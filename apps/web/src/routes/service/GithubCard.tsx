import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { GitBranch } from 'lucide-react';
import type { Service, ServiceGithubLink } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, CardBody, ConfirmDialog, Select, Switch } from '../../components/ui.js';

/**
 * 0.13: the service's GitHub App link. Everyone who can see the service sees
 * the link; the feedback toggles need the service admin role (the server
 * decides), and token scope, migrate, finalize and revert are operator-only,
 * like attaching a source. Rendered only when a link exists, or when an
 * operator could migrate this repository service onto an App installation.
 */

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function GithubCard({ svc }: { svc: Service }) {
  const { user } = useAuth();
  const isOperator = user?.isOperator === true;
  // A PR preview follows its parent's link; image and pasted-stack services have no repository.
  const eligible = !!svc.repoUrl && !svc.isEphemeralPreview && svc.previewParentServiceId == null;
  const status = useQuery({ queryKey: ['service-github', svc.id], queryFn: () => api.services.github.get(svc.id), enabled: eligible });
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.sources.list(), enabled: eligible && isOperator });
  const appSources = (sources.data ?? []).filter((s) => s.type === 'github_app');
  const link = status.data?.link ?? null;

  if (!eligible || !status.isSuccess) return null;
  if (!link && !(isOperator && appSources.length > 0)) return null;
  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
          <GitBranch size={16} className="text-indigo-400" /> GitHub App
        </div>
        {link ? (
          <LinkedView svc={svc} link={link} isOperator={isOperator} />
        ) : (
          <MigrateView svc={svc} options={appSources.map((s) => ({ id: s.id, name: s.name }))} />
        )}
      </CardBody>
    </Card>
  );
}

function LinkedView({ svc, link, isOperator }: { svc: Service; link: ServiceGithubLink; isOperator: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [revertError, setRevertError] = useState<string | null>(null);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['service-github', svc.id] });
    qc.invalidateQueries({ queryKey: ['service', svc.id] });
  };
  const feedback = useMutation({
    mutationFn: (patch: { reportStatus?: boolean; prComment?: boolean }) => api.services.github.feedback(svc.id, patch),
    onSuccess: () => {
      refresh();
      toast('GitHub feedback updated', 'success');
    },
    onError: (err) => toast(`Could not change GitHub feedback: ${errorText(err)}`, 'error'),
  });
  const relink = useMutation({
    mutationFn: (patch: { tokenScope?: 'repository' | 'installation'; enabled?: boolean }) =>
      // sourceId names the installation; it is null only once the generated source was deleted.
      api.services.github.link(svc.id, { sourceId: link.sourceId as number, ...patch }),
    onSuccess: () => {
      refresh();
      toast('GitHub link updated', 'success');
    },
    onError: (err) => toast(`Could not update the GitHub link: ${errorText(err)}`, 'error'),
  });
  const finalize = useMutation({
    mutationFn: () => api.services.github.finalize(svc.id),
    onSuccess: (res) => {
      refresh();
      toast(`Migration finalized; ${res.webhooksDeactivated} webhook(s) switched off`, 'success');
    },
    onError: (err) => toast(`Could not finalize: ${errorText(err)}`, 'error'),
  });
  const revert = useMutation({
    mutationFn: () => api.services.github.unlink(svc.id),
    onMutate: () => setRevertError(null),
    onSuccess: (res) => {
      refresh();
      toast(`Unlinked from the GitHub App; ${res.webhooksReactivated} webhook(s) switched back on`, 'success');
    },
    // A 409 explains why (the service clones through the App source itself); keep it on screen.
    onError: (err) => setRevertError(errorText(err)),
  });
  const canRelink = isOperator && link.sourceId != null;

  return (
    <div className="space-y-4 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-slate-200">{link.repoFullName}</span>
        <Badge tone={link.active ? 'emerald' : 'amber'}>{link.active ? 'active' : 'inactive'}</Badge>
        <span className="text-slate-500">
          {link.active
            ? 'App webhooks deploy this service; its per-service webhook is skipped.'
            : link.enabled
              ? 'The installation is suspended or removed; the per-service webhook and source take over.'
              : 'The link is disabled; the per-service webhook and source are used.'}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
          <span>
            <span className="block text-slate-200">Commit statuses</span>
            <span className="text-[11px] text-slate-500">ninedeploy/{svc.slug} on every deployed commit</span>
          </span>
          <Switch
            label="Commit statuses"
            checked={link.reportStatus}
            disabled={feedback.isPending}
            onChange={(v) => feedback.mutate({ reportStatus: v })}
          />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
          <span>
            <span className="block text-slate-200">PR comments</span>
            <span className="text-[11px] text-slate-500">one comment per PR with the preview URL</span>
          </span>
          <Switch label="PR comments" checked={link.prComment} disabled={feedback.isPending} onChange={(v) => feedback.mutate({ prComment: v })} />
        </label>
      </div>
      <p className="text-[11px] text-slate-500">Feedback toggles need the admin role on this service.</p>

      {isOperator && (
        <div className="space-y-3 border-t border-white/5 pt-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-slate-400">Clone token scope</span>
            <Select
              aria-label="Clone token scope"
              value={link.tokenScope}
              disabled={!canRelink || relink.isPending}
              onChange={(e) => relink.mutate({ tokenScope: e.target.value as 'repository' | 'installation' })}
              className="w-auto"
            >
              <option value="repository">This repository only</option>
              <option value="installation">Whole installation (sibling-repo submodules)</option>
            </Select>
            <span className="text-slate-400">Link enabled</span>
            <Switch label="Link enabled" checked={link.enabled} disabled={!canRelink || relink.isPending} onChange={(v) => relink.mutate({ enabled: v })} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setConfirmFinalize(true)} disabled={finalize.isPending || !link.active}>
              Finalize migration
            </Button>
            <Button size="sm" variant="ghost" onClick={() => revert.mutate()} disabled={revert.isPending}>
              Revert to previous source
            </Button>
          </div>
          {revertError && (
            <p role="alert" className="text-[11px] leading-relaxed text-rose-300">
              {revertError}
            </p>
          )}
          <p className="text-[11px] leading-relaxed text-slate-500">
            Finalize makes the App source the service&apos;s source and switches its webhooks off. Revert restores the previous
            source, switches the webhooks back on and removes the link.
          </p>
        </div>
      )}
      <ConfirmDialog
        open={confirmFinalize}
        title="Finalize GitHub App migration"
        message="Detach the previous source and switch this service's webhooks off? Deploys then depend on the GitHub App installation."
        confirmLabel="Finalize"
        onConfirm={() => finalize.mutate()}
        onClose={() => setConfirmFinalize(false)}
      />
    </div>
  );
}

function MigrateView({ svc, options }: { svc: Service; options: Array<{ id: number; name: string }> }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [sourceId, setSourceId] = useState(String(options[0]!.id));
  const migrate = useMutation({
    mutationFn: () => api.services.github.migrate(svc.id, Number(sourceId)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service-github', svc.id] });
      toast('Service linked to the GitHub App; the previous source stays as a fallback', 'success');
    },
    onError: (err) => toast(`Could not migrate: ${errorText(err)}`, 'error'),
  });
  return (
    <div className="space-y-3 text-xs">
      <p className="leading-relaxed text-slate-400">
        Move this service onto a GitHub App installation: deploys use short-lived tokens and the App webhook, while the current
        source{svc.sourceName ? ` (${svc.sourceName})` : ''} and webhook stay as a fallback until you finalize.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="GitHub App installation" value={sourceId} onChange={(e) => setSourceId(e.target.value)} className="w-auto">
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
        <Button size="sm" onClick={() => migrate.mutate()} disabled={migrate.isPending}>
          {migrate.isPending ? 'Linking…' : 'Migrate to GitHub App'}
        </Button>
      </div>
    </div>
  );
}
