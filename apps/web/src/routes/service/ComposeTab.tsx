import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { RotateCw, Save } from 'lucide-react';
import type { Service } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, Textarea } from '../../components/ui.js';

/**
 * Edit an inline compose stack's YAML.
 *
 * Only rendered for a service that stores one (`composeContent`): a git-repo
 * compose service keeps its file in the repository, where the next checkout
 * would overwrite anything typed here. Saving validates the file server-side
 * (the same preflight the create route runs) and rewrites the workspace copy;
 * the running containers only change on the next deploy, which is why "Save &
 * redeploy" exists next to plain Save.
 */
export function ComposeTab({ service }: { service: Service }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const stored = service.composeContent ?? '';
  const [draft, setDraft] = useState(stored);

  // Follow the server copy when it changes underneath (another session saved,
  // or the detail query refetched mid-deploy) — but never clobber an
  // in-progress edit. "Untouched" means the draft still equals the revision
  // this editor was last showing, which is why the PREVIOUS stored value is
  // the one to compare against, not the new one.
  const lastStored = useRef(stored);
  useEffect(() => {
    if (lastStored.current === stored) return;
    setDraft((current) => (current === lastStored.current ? stored : current));
    lastStored.current = stored;
  }, [stored]);

  const dirty = draft !== stored;

  const save = useMutation({
    mutationFn: async (opts: { redeploy: boolean }) => {
      await api.services.update(service.id, { composeContent: draft });
      if (!opts.redeploy) return null;
      return api.deploys.trigger(service.id);
    },
    onSuccess: (deployment) => {
      qc.invalidateQueries({ queryKey: ['service', service.id] });
      qc.invalidateQueries({ queryKey: ['services'] });
      // r211: the redeploy just queued must reach the Deploys tab it lands on.
      qc.invalidateQueries({ queryKey: ['deploys', service.id] });
      if (deployment) {
        toast('Compose file saved — redeploying…', 'info');
        navigate(`/services/${service.id}?tab=deploys`);
      } else {
        toast('Compose file saved — redeploy to apply', 'success');
      }
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Could not save the compose file', 'error'),
  });

  return (
    <div className="mt-5 max-w-4xl">
      <Card>
        <CardBody className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-slate-200">Compose file</div>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                Deployed as project <span className="font-mono text-slate-400">ndcmp-{service.slug}</span>
                {service.composeService && (
                  <>
                    {' '}· routed service <span className="font-mono text-slate-400">{service.composeService}</span>
                  </>
                )}
                . Stored on the service, rewritten into the workspace before every deploy.
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!dirty || save.isPending}
                onClick={() => save.mutate({ redeploy: false })}
              >
                <Save size={13} className="mr-1" /> Save
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!dirty || save.isPending}
                onClick={() => save.mutate({ redeploy: true })}
              >
                <RotateCw size={13} className="mr-1" /> Save &amp; redeploy
              </Button>
            </div>
          </div>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={24}
            aria-label="Compose file editor"
            className="font-mono text-xs leading-relaxed"
          />
        </CardBody>
      </Card>
    </div>
  );
}
