import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { CheckCircle2, FileCode2, Save, Trash2 } from 'lucide-react';
import type { TraefikCustomConfigIssue } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, CardBody, ConfirmDialog, ErrorCard, Skeleton, Textarea } from '../../components/ui.js';

const EXAMPLE = `http:
  routers:
    custom-legacy:
      rule: "Host(\`legacy.example.com\`)"
      entryPoints: [websecure]
      service: custom-legacy
      tls:
        certResolver: letsencrypt
  services:
    custom-legacy:
      loadBalancer:
        servers:
          - url: "http://10.0.0.5:8080"
`;

/** What the last Validate or Save reported. */
interface Findings {
  kind: 'valid' | 'invalid' | 'saved' | 'refused';
  message?: string;
  errors: TraefikCustomConfigIssue[];
  warnings: TraefikCustomConfigIssue[];
}

const STATUS_TONE = { none: 'neutral', applied: 'emerald', rejected: 'rose' } as const;

/** The findings a NineDeployError carries in `details` (the SDK lifts them off the refusal body). */
function refusal(err: unknown): Findings {
  const details = (err as { details?: { errors?: TraefikCustomConfigIssue[]; warnings?: TraefikCustomConfigIssue[] } }).details;
  return {
    kind: 'refused',
    message: err instanceof Error ? err.message : 'The config was not saved',
    errors: details?.errors ?? [],
    warnings: details?.warnings ?? [],
  };
}

/**
 * Traefik → Custom config (0.14, operator only): the operator's own dynamic
 * config, kept in `dynamic/custom.yml` next to the generated routes. Saves
 * pass the server's rules, a throwaway-Traefik preflight and a post-write log
 * scan; a config the live proxy rejects is reverted to the last good version.
 */
export function CustomConfigCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const state = useQuery({ queryKey: ['traefik-custom-config'], queryFn: () => api.traefik.customConfig.get() });
  const [content, setContent] = useState<string | null>(null);
  const [findings, setFindings] = useState<Findings | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (state.data && content === null) setContent(state.data.content ?? '');
  }, [state.data, content]);

  const validate = useMutation({
    mutationFn: (text: string) => api.traefik.customConfig.validate(text),
    onSuccess: (res) => setFindings({ kind: res.ok ? 'valid' : 'invalid', errors: res.errors, warnings: res.warnings }),
    onError: (err) => toast(err instanceof Error ? err.message : 'Validation failed', 'error'),
  });

  const save = useMutation({
    mutationFn: (text: string) => api.traefik.customConfig.set(text),
    onSuccess: (res) => {
      setFindings({ kind: 'saved', errors: [], warnings: res.warnings });
      toast('Custom config applied', 'success');
      void qc.invalidateQueries({ queryKey: ['traefik-custom-config'] });
      void qc.invalidateQueries({ queryKey: ['traefik'] });
    },
    onError: (err) => {
      setFindings(refusal(err));
      toast(err instanceof Error ? err.message : 'The config was not saved', 'error');
      // A rejected save changes the stored status (and maybe restores the last good version).
      void qc.invalidateQueries({ queryKey: ['traefik-custom-config'] });
    },
  });

  const clear = useMutation({
    mutationFn: () => api.traefik.customConfig.clear(),
    onSuccess: (res) => {
      setContent('');
      setFindings(null);
      toast(res.cleared ? 'Custom config removed' : 'There was no custom config', 'success');
      void qc.invalidateQueries({ queryKey: ['traefik-custom-config'] });
      void qc.invalidateQueries({ queryKey: ['traefik'] });
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Could not remove the custom config', 'error'),
  });

  if (state.isLoading) {
    return (
      <Card>
        <CardBody>
          <Skeleton className="h-40" />
        </CardBody>
      </Card>
    );
  }
  if (state.isError || !state.data) {
    return <ErrorCard title="Couldn't load the custom config" error={state.error} onRetry={() => void state.refetch()} />;
  }

  const current = state.data;
  const text = content ?? '';
  const empty = text.trim() === '';
  const busy = validate.isPending || save.isPending || clear.isPending;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
          <FileCode2 size={14} /> Custom dynamic config
        </h2>
        <div className="flex items-center gap-2 text-xs text-slate-500" data-testid="custom-config-status">
          <Badge tone={STATUS_TONE[current.status]}>{current.status}</Badge>
          {current.updatedAt && <span>saved {formatDateTime(current.updatedAt)}</span>}
          {current.sha256 && <span className="font-mono">{current.sha256.slice(0, 12)}</span>}
        </div>
      </div>
      <CardBody className="space-y-4">
        <div className="space-y-1 text-xs text-slate-500">
          <p>
            Extra Traefik routers, services and middlewares, kept in <code className="font-mono">custom.yml</code> beside the
            generated routes. Allowed: <code className="font-mono">http</code> (routers, middlewares, services,
            serversTransports), <code className="font-mono">tcp</code> (routers, services, middlewares) and{' '}
            <code className="font-mono">tls.options</code>.
          </p>
          <p>
            Every name you define must start with <code className="font-mono">custom-</code> or{' '}
            <code className="font-mono">custom_</code>. Routers use the <code className="font-mono">web</code> /{' '}
            <code className="font-mono">websecure</code> entry points (TCP: <code className="font-mono">websecure</code>), stay
            below the panel router's priority, and may only use the <code className="font-mono">letsencrypt</code> resolver.
            Refused: <code className="font-mono">udp</code>, <code className="font-mono">tls.certificates</code> /{' '}
            <code className="font-mono">tls.stores</code> (upload certificates instead), plugins, file paths (certFile, keyFile,
            CA files), YAML aliases and merge keys. Node proxies do not receive it.
          </p>
        </div>

        {current.status === 'rejected' && current.lastError && (
          <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300" data-testid="custom-config-last-error">
            Last save rejected: {current.lastError}
          </p>
        )}

        <Textarea
          aria-label="Custom config YAML"
          value={text}
          onChange={(e) => setContent(e.target.value)}
          rows={16}
          placeholder={EXAMPLE}
          className="font-mono text-xs"
        />

        {findings && <FindingsList findings={findings} />}

        <div className="flex flex-wrap justify-end gap-2">
          {current.content !== null && (
            <Button size="sm" variant="ghost" onClick={() => setConfirmClear(true)} disabled={busy}>
              <Trash2 size={12} /> Clear
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => validate.mutate(text)} disabled={busy || empty}>
            <CheckCircle2 size={12} /> {validate.isPending ? 'Validating…' : 'Validate'}
          </Button>
          <Button size="sm" onClick={() => save.mutate(text)} disabled={busy || empty}>
            <Save size={12} /> {save.isPending ? 'Applying…' : 'Save & apply'}
          </Button>
        </div>
      </CardBody>
      <ConfirmDialog
        open={confirmClear}
        title="Remove the custom config?"
        message="Traefik drops every custom router, service and middleware. Generated routes are not affected."
        confirmLabel="Remove"
        onConfirm={() => clear.mutate()}
        onClose={() => setConfirmClear(false)}
      />
    </Card>
  );
}

function IssueList({ label, issues, tone }: { label: string; issues: TraefikCustomConfigIssue[]; tone: string }) {
  if (issues.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <ul className={`space-y-0.5 text-xs ${tone}`}>
        {issues.map((issue, i) => (
          <li key={`${issue.path}-${i}`}>
            {issue.path && <code className="mr-1 font-mono">{issue.path}</code>}
            {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FindingsList({ findings }: { findings: Findings }) {
  const headline =
    findings.kind === 'valid'
      ? 'The config passes the panel rules (Traefik checks it again on save).'
      : findings.kind === 'saved'
        ? 'Applied.'
        : findings.kind === 'invalid'
          ? 'The config breaks the panel rules.'
          : findings.message;
  const tone = findings.kind === 'valid' || findings.kind === 'saved' ? 'text-emerald-300' : 'text-rose-300';
  return (
    <div className="space-y-2 rounded-lg border border-white/[0.06] p-3" data-testid="custom-config-findings">
      <p className={`text-xs ${tone}`}>{headline}</p>
      <IssueList label="Errors" issues={findings.errors} tone="text-rose-300" />
      <IssueList label="Warnings" issues={findings.warnings} tone="text-amber-300" />
    </div>
  );
}
