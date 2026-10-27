import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { useState } from 'react';
import type { EmailTemplateEntry, EmailTemplateName, EmailTemplateRender } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { fill, msg, useT } from '../../lib/i18n.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, CardBody, ErrorCard, Input, Skeleton, Textarea } from '../../components/ui.js';

/** Human names for the built-in template ids (lib/emailTemplates.ts on the server). */
const LABELS: Record<EmailTemplateName, string> = {
  'password-reset': msg('Password reset'),
  'workspace-invitation': msg('Workspace invitation'),
  'domain-transfer': msg('Domain transfer'),
  'backup-drill-failed': msg('Backup check failed'),
};

/**
 * Workspaces, G1.5 (workspace admin): override the subject and text of the
 * emails this workspace sends (G-30). The routes and the CLI existed; this is
 * the first web control. A template about the account itself (`instance`
 * scope, e.g. the password reset) is always sent with the built-in text.
 */
export function EmailTemplatesCard({ workspaceId }: { workspaceId: number }) {
  const t = useT();
  const list = useQuery({
    queryKey: ['email-templates', workspaceId],
    queryFn: () => api.emailTemplates.list(workspaceId),
  });
  const [editing, setEditing] = useState<EmailTemplateName | null>(null);

  if (list.isLoading) {
    return (
      <Card className="mt-6">
        <CardBody>
          <Skeleton className="h-24" />
        </CardBody>
      </Card>
    );
  }
  if (list.isError || !list.data) return <ErrorCard title={t('Could not load the email templates')} error={list.error} onRetry={() => void list.refetch()} />;

  return (
    <Card className="mt-6 overflow-hidden">
      <div className="p-4 border-b border-white/[0.06]">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
          <Mail size={14} /> {t('Email templates')}
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          {fill(
            t(
              'Replace the subject and text of the emails this workspace sends. Variables such as {workspaceName} are filled in when the email is sent, and an email with a link must keep its {acceptUrl}. Use Preview to check the result.',
            ),
            { workspaceName: <code>{'{{workspaceName}}'}</code>, acceptUrl: <code>{'{{acceptUrl}}'}</code> },
          )}
        </p>
      </div>
      <ul className="divide-y divide-white/5">
        {list.data.templates.map((tpl) => (
          <li key={tpl.name} className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-slate-200">{LABELS[tpl.name] ? t(LABELS[tpl.name]) : tpl.name}</span>
              <code className="text-[11px] text-slate-500">{tpl.name}</code>
              {tpl.overridden && <Badge tone="indigo">{t('customised')}</Badge>}
              {tpl.sent === false && <Badge tone="neutral">{t('not sent yet')}</Badge>}
              {tpl.scope === 'instance' ? (
                <span className="ml-auto text-[11px] text-slate-500">{t('About the account: always sent with the built-in text')}</span>
              ) : (
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setEditing(editing === tpl.name ? null : tpl.name)}>
                  {editing === tpl.name ? t('Close') : t('Edit')}
                </Button>
              )}
            </div>
            {editing === tpl.name && tpl.scope !== 'instance' && (
              <TemplateEditor workspaceId={workspaceId} entry={tpl} onDone={() => setEditing(null)} />
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TemplateEditor({ workspaceId, entry, onDone }: { workspaceId: number; entry: EmailTemplateEntry; onDone: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [subject, setSubject] = useState(entry.subject ?? '');
  const [text, setText] = useState(entry.text ?? '');
  const [preview, setPreview] = useState<EmailTemplateRender | null>(null);

  const refresh = (message: string) => {
    void qc.invalidateQueries({ queryKey: ['email-templates', workspaceId] });
    toast(message, 'success');
    onDone();
  };
  const fail = (fallback: string) => (err: Error) => toast(err.message || fallback, 'error');
  const save = useMutation({
    mutationFn: () => api.emailTemplates.set(workspaceId, entry.name, subject, text),
    onSuccess: () => refresh(t('Template saved')),
    onError: fail(t('Could not save the template')),
  });
  const reset = useMutation({
    mutationFn: () => api.emailTemplates.reset(workspaceId, entry.name),
    onSuccess: () => refresh(t('Template reset to the built-in text')),
    onError: fail(t('Could not reset the template')),
  });
  const render = useMutation({
    mutationFn: () => api.emailTemplates.preview(workspaceId, entry.name),
    onSuccess: setPreview,
    onError: fail(t('Could not render a preview')),
  });

  return (
    <div className="mt-3 space-y-3">
      {!entry.overridden && (
        <p className="text-[11px] text-slate-500">{t('This email uses the built-in text. Fill in both fields to replace it; Preview shows what is sent today.')}</p>
      )}
      <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t('Subject')} aria-label={t('Subject')} className="text-xs" />
      <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Text')} aria-label={t('Text')} rows={6} className="font-mono text-xs" />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => save.mutate()} disabled={!subject.trim() || !text.trim() || save.isPending}>
          {t('Save')}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => render.mutate()} disabled={render.isPending}>
          {t('Preview')}
        </Button>
        {entry.overridden && (
          <Button size="sm" variant="ghost" onClick={() => reset.mutate()} disabled={reset.isPending}>
            {t('Reset to built-in')}
          </Button>
        )}
      </div>
      {preview && (
        <div className="rounded-lg bg-black/30 p-3 text-xs" data-testid="email-preview">
          <div className="font-medium text-slate-200">{preview.subject}</div>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-slate-400">{preview.text}</pre>
          <div className="mt-2 text-[11px] text-slate-600">
            {preview.overridden
              ? t('Rendered from the saved override; unsaved edits are not included.')
              : t('Rendered from the built-in text; unsaved edits are not included.')}
          </div>
        </div>
      )}
    </div>
  );
}
