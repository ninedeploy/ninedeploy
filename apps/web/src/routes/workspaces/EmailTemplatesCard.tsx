import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { useState } from 'react';
import type { EmailTemplateEntry, EmailTemplateName, EmailTemplateRender } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, CardBody, ErrorCard, Input, Skeleton, Textarea } from '../../components/ui.js';

/** Human names for the built-in template ids (lib/emailTemplates.ts on the server). */
const LABELS: Record<EmailTemplateName, string> = {
  'password-reset': 'Password reset',
  'workspace-invitation': 'Workspace invitation',
  'domain-transfer': 'Domain transfer',
  'backup-drill-failed': 'Backup check failed',
};

/**
 * Workspaces, G1.5 (workspace admin): override the subject and text of the
 * emails this workspace sends (G-30). The routes and the CLI existed; this is
 * the first web control. A template about the account itself (`instance`
 * scope, e.g. the password reset) is always sent with the built-in text.
 */
export function EmailTemplatesCard({ workspaceId }: { workspaceId: number }) {
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
  if (list.isError || !list.data) return <ErrorCard title="Could not load the email templates" error={list.error} onRetry={() => void list.refetch()} />;

  return (
    <Card className="mt-6 overflow-hidden">
      <div className="p-4 border-b border-white/[0.06]">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
          <Mail size={14} /> Email templates
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Replace the subject and text of the emails this workspace sends. Variables such as <code>{'{{workspaceName}}'}</code> are filled in
          when the email is sent, and an email with a link must keep its <code>{'{{acceptUrl}}'}</code>. Use Preview to check the result.
        </p>
      </div>
      <ul className="divide-y divide-white/5">
        {list.data.templates.map((t) => (
          <li key={t.name} className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-slate-200">{LABELS[t.name] ?? t.name}</span>
              <code className="text-[11px] text-slate-500">{t.name}</code>
              {t.overridden && <Badge tone="indigo">customised</Badge>}
              {t.sent === false && <Badge tone="neutral">not sent yet</Badge>}
              {t.scope === 'instance' ? (
                <span className="ml-auto text-[11px] text-slate-500">About the account: always sent with the built-in text</span>
              ) : (
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setEditing(editing === t.name ? null : t.name)}>
                  {editing === t.name ? 'Close' : 'Edit'}
                </Button>
              )}
            </div>
            {editing === t.name && t.scope !== 'instance' && (
              <TemplateEditor workspaceId={workspaceId} entry={t} onDone={() => setEditing(null)} />
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TemplateEditor({ workspaceId, entry, onDone }: { workspaceId: number; entry: EmailTemplateEntry; onDone: () => void }) {
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
    onSuccess: () => refresh('Template saved'),
    onError: fail('Could not save the template'),
  });
  const reset = useMutation({
    mutationFn: () => api.emailTemplates.reset(workspaceId, entry.name),
    onSuccess: () => refresh('Template reset to the built-in text'),
    onError: fail('Could not reset the template'),
  });
  const render = useMutation({
    mutationFn: () => api.emailTemplates.preview(workspaceId, entry.name),
    onSuccess: setPreview,
    onError: fail('Could not render a preview'),
  });

  return (
    <div className="mt-3 space-y-3">
      {!entry.overridden && (
        <p className="text-[11px] text-slate-500">This email uses the built-in text. Fill in both fields to replace it; Preview shows what is sent today.</p>
      )}
      <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" className="text-xs" />
      <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Text" aria-label="Text" rows={6} className="font-mono text-xs" />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => save.mutate()} disabled={!subject.trim() || !text.trim() || save.isPending}>
          Save
        </Button>
        <Button size="sm" variant="secondary" onClick={() => render.mutate()} disabled={render.isPending}>
          Preview
        </Button>
        {entry.overridden && (
          <Button size="sm" variant="ghost" onClick={() => reset.mutate()} disabled={reset.isPending}>
            Reset to built-in
          </Button>
        )}
      </div>
      {preview && (
        <div className="rounded-lg bg-black/30 p-3 text-xs" data-testid="email-preview">
          <div className="font-medium text-slate-200">{preview.subject}</div>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-slate-400">{preview.text}</pre>
          <div className="mt-2 text-[11px] text-slate-600">
            Rendered from the {preview.overridden ? 'saved override' : 'built-in text'}; unsaved edits are not included.
          </div>
        </div>
      )}
    </div>
  );
}
