import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { GitBranch } from 'lucide-react';
import type { Service, ServiceGithubLink } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useT } from '../../lib/i18n.js';
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
  const t = useT();
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
          <GitBranch size={16} className="text-indigo-400" /> {t('GitHub App')}
        </div>
        {link ? (
          <LinkedView key={link.id} svc={svc} link={link} isOperator={isOperator} />
        ) : (
          <MigrateView svc={svc} options={appSources.map((s) => ({ id: s.id, name: s.name }))} />
        )}
      </CardBody>
    </Card>
  );
}

function LinkedView({ svc, link, isOperator }: { svc: Service; link: ServiceGithubLink; isOperator: boolean }) {
  const t = useT();
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
      toast(t('GitHub feedback updated'), 'success');
    },
    onError: (err) => toast(t('Could not change GitHub feedback: {error}', { error: errorText(err) }), 'error'),
  });
  const relink = useMutation({
    mutationFn: (patch: { tokenScope?: 'repository' | 'installation'; enabled?: boolean }) =>
      // sourceId names the installation; it is null only once the generated source was deleted.
      api.services.github.link(svc.id, { sourceId: link.sourceId as number, ...patch }),
    onSuccess: () => {
      refresh();
      toast(t('GitHub link updated'), 'success');
    },
    onError: (err) => toast(t('Could not update the GitHub link: {error}', { error: errorText(err) }), 'error'),
  });
  const finalize = useMutation({
    mutationFn: () => api.services.github.finalize(svc.id),
    onSuccess: (res) => {
      refresh();
      toast(t('Migration finalized; {n} webhook(s) switched off', { n: res.webhooksDeactivated }), 'success');
    },
    onError: (err) => toast(t('Could not finalize: {error}', { error: errorText(err) }), 'error'),
  });
  const revert = useMutation({
    mutationFn: () => api.services.github.unlink(svc.id),
    onMutate: () => setRevertError(null),
    onSuccess: (res) => {
      refresh();
      toast(t('Unlinked from the GitHub App; {n} webhook(s) switched back on', { n: res.webhooksReactivated }), 'success');
    },
    // A 409 explains why (the service clones through the App source itself); keep it on screen.
    onError: (err) => setRevertError(errorText(err)),
  });
  const canRelink = isOperator && link.sourceId != null;

  return (
    <div className="space-y-4 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-slate-200">{link.repoFullName}</span>
        <Badge tone={link.active ? 'emerald' : 'amber'}>{link.active ? t('active') : t('inactive')}</Badge>
        <span className="text-slate-500">
          {link.active
            ? t('App webhooks deploy this service; its per-service webhook is skipped.')
            : link.enabled
              ? t('The installation is suspended or removed; the per-service webhook and source take over.')
              : t('The link is disabled; the per-service webhook and source are used.')}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
          <span>
            <span className="block text-slate-200">{t('Commit statuses')}</span>
            <span className="text-[11px] text-slate-500">{t('{context} on every deployed commit', { context: `ninedeploy/${svc.slug}` })}</span>
          </span>
          <Switch
            label={t('Commit statuses')}
            checked={link.reportStatus}
            disabled={feedback.isPending}
            onChange={(v) => feedback.mutate({ reportStatus: v })}
          />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
          <span>
            <span className="block text-slate-200">{t('PR comments')}</span>
            <span className="text-[11px] text-slate-500">{t('one comment per PR with the preview URL')}</span>
          </span>
          <Switch label={t('PR comments')} checked={link.prComment} disabled={feedback.isPending} onChange={(v) => feedback.mutate({ prComment: v })} />
        </label>
      </div>
      <p className="text-[11px] text-slate-500">{t('Feedback toggles need the admin role on this service.')}</p>
      <CiPolicy key={JSON.stringify(link.requiredWorkflows ?? [])} serviceId={svc.id} workflows={link.requiredWorkflows ?? []} onSaved={refresh} />

      {isOperator && (
        <div className="space-y-3 border-t border-white/5 pt-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-slate-400">{t('Clone token scope')}</span>
            <Select
              aria-label={t('Clone token scope')}
              value={link.tokenScope}
              disabled={!canRelink || relink.isPending}
              onChange={(e) => relink.mutate({ tokenScope: e.target.value as 'repository' | 'installation' })}
              className="w-auto"
            >
              <option value="repository">{t('This repository only')}</option>
              <option value="installation">{t('Whole installation (sibling-repo submodules)')}</option>
            </Select>
            <span className="text-slate-400">{t('Link enabled')}</span>
            <Switch label={t('Link enabled')} checked={link.enabled} disabled={!canRelink || relink.isPending} onChange={(v) => relink.mutate({ enabled: v })} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setConfirmFinalize(true)} disabled={finalize.isPending || !link.active}>
              {t('Finalize migration')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => revert.mutate()} disabled={revert.isPending}>
              {t('Revert to previous source')}
            </Button>
          </div>
          {revertError && (
            <p role="alert" className="text-[11px] leading-relaxed text-rose-300">
              {revertError}
            </p>
          )}
          <p className="text-[11px] leading-relaxed text-slate-500">
            {t("Finalize makes the App source the service's source and switches its webhooks off. Revert restores the previous source, switches the webhooks back on and removes the link.")}
          </p>
        </div>
      )}
      <ConfirmDialog
        open={confirmFinalize}
        title={t('Finalize GitHub App migration')}
        message={t("Detach the previous source and switch this service's webhooks off? Deploys then depend on the GitHub App installation.")}
        confirmLabel={t('Finalize')}
        onConfirm={() => finalize.mutate()}
        onClose={() => setConfirmFinalize(false)}
      />
    </div>
  );
}

function CiPolicy({ serviceId, workflows, onSaved }: { serviceId: number; workflows: string[]; onSaved: () => void }) {
  const t = useT();
  const [value, setValue] = useState(workflows.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const save = useMutation({
    mutationFn: () => api.services.github.feedback(serviceId, { requiredWorkflows: value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) }),
    onSuccess: () => { setError(null); onSaved(); toast(t('Required CI workflows updated'), 'success'); },
    onError: (err) => setError(errorText(err)),
  });
  return (
    <div className="space-y-2 border-t border-white/5 pt-3">
      <label htmlFor={`ci-workflows-${serviceId}`} className="block text-slate-200">{t('Required CI workflows')}</label>
      <p className="text-[11px] leading-relaxed text-slate-500">
        {t("Deploy only after every listed GitHub Actions workflow succeeds for the exact commit. One file path per line; leave empty to disable. Requires the App's Actions read permission. CI runs before lane approval; missing checks wait up to two hours. Changes apply to new candidates; cancel an existing waiting deploy to change its captured policy.")}
      </p>
      <textarea id={`ci-workflows-${serviceId}`} rows={3} value={value} onChange={(e) => setValue(e.target.value)}
        placeholder=".github/workflows/ci.yml" spellCheck={false}
        className="w-full rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 font-mono text-xs text-slate-200 focus:border-indigo-400 focus:outline-none" />
      <div className="flex items-center gap-3">
        <Button size="sm" variant="secondary" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? t('Saving…') : t('Save CI requirements')}
        </Button>
        <span className="text-[11px] text-slate-500">{t('Service admin required')}</span>
      </div>
      {error && <p role="alert" className="text-rose-300">{error}</p>}
    </div>
  );
}

function MigrateView({ svc, options }: { svc: Service; options: Array<{ id: number; name: string }> }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [sourceId, setSourceId] = useState(String(options[0]!.id));
  const migrate = useMutation({
    mutationFn: () => api.services.github.migrate(svc.id, Number(sourceId)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service-github', svc.id] });
      toast(t('Service linked to the GitHub App; the previous source stays as a fallback'), 'success');
    },
    onError: (err) => toast(t('Could not migrate: {error}', { error: errorText(err) }), 'error'),
  });
  return (
    <div className="space-y-3 text-xs">
      <p className="leading-relaxed text-slate-400">
        {svc.sourceName
          ? t('Move this service onto a GitHub App installation: deploys use short-lived tokens and the App webhook, while the current source ({source}) and webhook stay as a fallback until you finalize.', { source: svc.sourceName })
          : t('Move this service onto a GitHub App installation: deploys use short-lived tokens and the App webhook, while the current source and webhook stay as a fallback until you finalize.')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label={t('GitHub App installation')} value={sourceId} onChange={(e) => setSourceId(e.target.value)} className="w-auto">
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
        <Button size="sm" onClick={() => migrate.mutate()} disabled={migrate.isPending}>
          {migrate.isPending ? t('Linking…') : t('Migrate to GitHub App')}
        </Button>
      </div>
    </div>
  );
}
