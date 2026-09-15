import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, CardBody, Field, Input, Select } from '../../components/ui.js';

/**
 * SCIM 2.0 provisioning tokens (RFC 7644). Each token lets an identity
 * provider (Okta, Entra ID, …) push users into ONE workspace and — just as
 * importantly — deprovision them: disabling or deleting a user at the IdP
 * revokes their sessions, API tokens and memberships here within one sync
 * cycle. The plaintext token is shown exactly once at creation.
 */
export function ScimTokensCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [minted, setMinted] = useState<string | null>(null);

  const { data: tokens = [] } = useQuery({ queryKey: ['scim-tokens'], queryFn: () => api.scim.listTokens() });
  const { data: workspaces } = useQuery({ queryKey: ['workspaces'], queryFn: () => api.workspaces.list() });

  const create = useMutation({
    mutationFn: () => api.scim.createToken({ name: name.trim() || 'IdP integration', workspaceId: Number(workspaceId) }),
    onSuccess: (res) => {
      setMinted(res.token);
      setName('');
      qc.invalidateQueries({ queryKey: ['scim-tokens'] });
    },
    onError: () => toast('Could not create the SCIM token', 'error'),
  });

  const revoke = useMutation({
    mutationFn: (id: number) => api.scim.revokeToken(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scim-tokens'] }),
    onError: () => toast('Could not revoke the token', 'error'),
  });

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
          <KeyRound size={15} className="text-slate-500" /> SCIM provisioning
        </div>
        <p className="text-xs text-slate-500">
          Point your identity provider at <code className="font-mono text-slate-400">{'{panel}'}/scim/v2</code> with a bearer
          token below. Provisioned users join the token's workspace as members; deactivating or deleting them at the IdP
          revokes their access here automatically.
        </p>

        <div className="space-y-2">
          {tokens.map((t) => (
            <div key={t.id} className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs text-slate-200">
                  {t.name}
                  {t.revoked && <Badge>revoked</Badge>}
                </div>
                <div className="text-[11px] text-slate-500">
                  workspace #{t.workspaceId}
                  {t.lastUsedAt ? ` · last used ${new Date(t.lastUsedAt).toLocaleString()}` : ' · never used'}
                </div>
              </div>
              {!t.revoked && (
                <Button variant="ghost" size="sm" onClick={() => revoke.mutate(t.id)} disabled={revoke.isPending} aria-label={`Revoke ${t.name}`}>
                  <Trash2 size={13} />
                </Button>
              )}
            </div>
          ))}
          {tokens.length === 0 && <p className="text-xs text-slate-600">No provisioning tokens yet.</p>}
        </div>

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (workspaceId) create.mutate();
          }}
        >
          <Field label="Token name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Okta" className="h-9 w-40 text-xs" />
          </Field>
          <Field label="Workspace">
            <Select
              aria-label="SCIM workspace"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              className="h-9 w-44 text-xs"
            >
              <option value="">Choose…</option>
              {(workspaces ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" size="sm" variant="secondary" disabled={!workspaceId || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create token'}
          </Button>
        </form>

        {minted && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs" role="alert">
            <div className="mb-1 font-semibold uppercase tracking-wide text-emerald-300">Copy this token now</div>
            <code className="break-all font-mono text-emerald-200">{minted}</code>
            <p className="mt-1 text-[11px] text-slate-500">It is stored hashed — this is the only time it is shown.</p>
            <Button variant="ghost" size="sm" className="mt-1" onClick={() => setMinted(null)}>
              Dismiss
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
