import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import type { McpHttpPolicyPatch } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { useT } from '../../lib/i18n.js';
import { Card, CardBody, ErrorCard, Skeleton, Switch } from '../../components/ui.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Settings → Security → Remote MCP (R4, operator only): the MCP tools over
 * Streamable HTTP at /v1/mcp, for clients that present an API token. Off by
 * default; read-only narrows every caller to the read-only tool allowlist.
 */
export function McpRemoteCard() {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['mcp-remote'], queryFn: () => api.mcpRemote.policy() });
  const save = useMutation({
    mutationFn: (patch: McpHttpPolicyPatch) => api.mcpRemote.setPolicy(patch),
    onSuccess: (view) => {
      qc.setQueryData(['mcp-remote'], view);
      toast(t('Remote MCP saved'), 'success');
    },
    onError: (err) => toast(t('Could not save: {error}', { error: errorText(err) }), 'error'),
  });

  if (q.isLoading) return <Skeleton className="mb-5 h-32" />;
  if (q.isError || !q.data) return <ErrorCard title={t('Could not load remote MCP')} error={q.error} onRetry={() => void q.refetch()} />;
  const { policy, path } = q.data;
  const url = `${window.location.origin}${path}`;

  return (
    <Card className="mb-5">
      <CardBody className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold text-slate-200">
            <Bot size={15} className="text-sky-300" /> {t('Remote MCP')}
          </div>
          <Switch checked={policy.enabled} onChange={(enabled) => save.mutate({ enabled })} disabled={save.isPending} label={t('Serve MCP over HTTP')} />
        </div>
        <p className="text-xs text-slate-400">
          {t('AI clients connect to the MCP tools over HTTP with an API token, instead of running the local MCP server. Each tool call runs as that token: its scopes and its owner\'s roles apply, and a revoked token stops working at once.')}
        </p>
        {policy.enabled && (
          <>
            <code className="block break-all rounded bg-slate-900/60 px-2 py-1.5 font-mono text-xs text-slate-200">{url}</code>
            <p className="text-xs text-slate-500">
              {t('Send the token as an Authorization: Bearer header, for example:')}{' '}
              <code className="break-all font-mono">{`claude mcp add --transport http ninedeploy ${url} --header "Authorization: Bearer <token>"`}</code>
            </p>
          </>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/5 pt-3">
          <span className="text-xs text-slate-400">{t('Read-only tools only, for every caller')}</span>
          <Switch checked={policy.readOnly} onChange={(readOnly) => save.mutate({ readOnly })} disabled={save.isPending} label={t('Read-only tools only, for every caller')} />
        </div>
      </CardBody>
    </Card>
  );
}
