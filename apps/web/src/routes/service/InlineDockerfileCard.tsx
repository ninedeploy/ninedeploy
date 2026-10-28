import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { FileCode } from 'lucide-react';
import type { InlineDockerfileView, ServiceDetail } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { useT } from '../../lib/i18n.js';
import { Button, Card, CardBody, Textarea } from '../../components/ui.js';

/**
 * Service → Settings (G1.1): a Dockerfile pasted here instead of kept in the
 * repository. Docker services that build from source; applied on the next
 * deploy.
 */
export function InlineDockerfileCard({ svc }: { svc: ServiceDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const fromSource = svc.type === 'docker' && !svc.image && !svc.composeContent;
  const q = useQuery({ queryKey: ['inline-dockerfile', svc.id], queryFn: () => api.services.inlineDockerfile.get(svc.id), retry: false, enabled: fromSource });
  const [text, setText] = useState('');
  useEffect(() => {
    if (q.data) setText(q.data.content ?? '');
  }, [q.data]);
  const save = useMutation({
    mutationFn: (content: string | null) => api.services.inlineDockerfile.set(svc.id, content),
    onSuccess: (view: InlineDockerfileView) => {
      qc.setQueryData(['inline-dockerfile', svc.id], view);
      toast(view.content ? t('Inline Dockerfile saved; it builds on the next deploy') : t('Inline Dockerfile removed; the next deploy builds from the repository'), 'success');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });
  if (!fromSource || !q.data) return null;
  const stored = q.data.content;

  return (
    <Card>
      <CardBody className="space-y-3 text-sm">
        <div className="flex items-center gap-2 font-medium text-slate-300">
          <FileCode size={15} className="text-slate-500" /> {t('Inline Dockerfile')}
        </div>
        <p className="text-xs text-slate-500">
          {svc.repoUrl
            ? t('Builds with this Dockerfile instead of the one in the repository, from the base directory. Leave it empty to build from the repository again.')
            : t('This service has no repository: the Dockerfile builds from an uploaded source if there is one, otherwise from an empty context.')}
        </p>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          className="font-mono text-xs"
          placeholder={'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node", "index.js"]'}
          aria-label={t('Inline Dockerfile')}
        />
        <div className="flex gap-2">
          <Button size="sm" onClick={() => save.mutate(text.trim() ? text : null)} disabled={save.isPending || text === (stored ?? '')}>
            {t('Save')}
          </Button>
          {stored && (
            <Button size="sm" variant="ghost" onClick={() => save.mutate(null)} disabled={save.isPending}>
              {t('Remove')}
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
