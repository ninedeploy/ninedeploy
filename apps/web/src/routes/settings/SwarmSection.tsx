import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, Network } from 'lucide-react';
import type { SwarmStatus } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { errorCode, errorMessage, SWARM_FIREWALL_PORTS, swarmOptInLine } from '../../lib/multiNode.js';
import { useToast } from '../../components/Toast.js';
import { StepUpModal } from '../../components/StepUpModal.js';
import { Badge, Button, Card, CardBody, ErrorCard, Field, Input, Skeleton, Switch } from '../../components/ui.js';

/** A loose IPv4 / IPv6 check; the server validates the address exactly. */
const ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]*:[0-9a-fA-F:.]*)$/;

/**
 * Settings → Swarm (operator only, multi-node design §7): initialise Swarm on
 * the panel host (advertise address + password re-check), enable or disable
 * Swarm deploys (enabling re-checks the password), the cluster's nodes, the
 * firewall the cluster needs, and the server's warnings. Swarm stays opt-in
 * per service (Service → Settings → Runtime orchestrator).
 */
export function SwarmSection() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const status = useQuery({ queryKey: ['swarm'], queryFn: () => api.swarm.get() });
  const [initOpen, setInitOpen] = useState(false);
  const [enableOpen, setEnableOpen] = useState(false);
  const [advertiseAddr, setAdvertiseAddr] = useState('');
  const [promptError, setPromptError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [initWarnings, setInitWarnings] = useState<string[]>([]);

  const store = (view: SwarmStatus) => qc.setQueryData(['swarm'], view);

  const init = useMutation({
    mutationFn: (password: string | undefined) => api.swarm.init({ advertiseAddr: advertiseAddr.trim(), ...(password ? { password } : {}) }),
    onSuccess: (view) => {
      store(view);
      setInitWarnings(view.warnings ?? []);
      setInitOpen(false);
      setPromptError(null);
      setNotice(null);
      toast('Swarm initialised on the panel host', 'success');
    },
    onError: (err) => {
      if (errorCode(err) === 'swarm_overlay_unavailable') {
        // The swarm exists now, but cannot run NineDeploy services: say why and refresh.
        setInitOpen(false);
        setNotice(errorMessage(err, 'Encrypted overlay networks are not available on this host.'));
        void qc.invalidateQueries({ queryKey: ['swarm'] });
        return;
      }
      setPromptError(errorMessage(err, 'Could not initialise Swarm'));
    },
  });

  const settings = useMutation({
    mutationFn: ({ enabled, password }: { enabled: boolean; password?: string }) =>
      api.swarm.settings(enabled && password ? { enabled, password } : { enabled }),
    onSuccess: (view, { enabled }) => {
      store(view);
      setEnableOpen(false);
      setPromptError(null);
      toast(enabled ? 'Swarm deploys enabled' : 'Swarm deploys disabled', 'success');
    },
    onError: (err, { enabled }) => {
      if (enabled) setPromptError(errorMessage(err, 'Could not enable Swarm deploys'));
      else toast(errorMessage(err, 'Could not disable Swarm deploys'), 'error');
    },
  });

  const view = status.data;
  const active = view?.localState === 'active';
  const warnings = [...(view?.warnings ?? []), ...initWarnings.filter((w) => !(view?.warnings ?? []).includes(w))];

  return (
    <Card>
      <CardBody className="space-y-5">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
          <Network size={15} className="text-slate-500" /> Docker Swarm
        </div>
        <p className="text-xs text-slate-500">
          Swarm runs a service's replicas across the panel host and the nodes that joined, behind Traefik. The panel host is the
          only manager; nodes join as workers from the{' '}
          <Link to="/servers" className="text-indigo-300 hover:underline">
            Servers page
          </Link>
          . Each service opts in under Service → Settings → Runtime orchestrator.
        </p>

        {status.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : status.isError || !view ? (
          <ErrorCard title="Couldn't load the Swarm status" error={status.error} onRetry={() => void status.refetch()} />
        ) : (
          <>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-xs">
              <div className="flex flex-wrap items-center gap-2 text-slate-300">
                Panel host: <Badge tone={active ? 'emerald' : view.localState === 'error' || view.localState === 'locked' ? 'rose' : 'neutral'}>{view.localState}</Badge>
                {active && (view.controlAvailable ? <Badge tone="indigo">manager</Badge> : <Badge tone="amber">not a manager</Badge>)}
                {view.managerAddr && (
                  <span className="font-mono text-slate-400" title="Manager address">
                    {view.managerAddr}
                  </span>
                )}
              </div>
              {view.localState === 'inactive' && (
                <div className="mt-3">
                  <Button
                    size="sm"
                    onClick={() => {
                      setPromptError(null);
                      setInitOpen(true);
                    }}
                  >
                    Initialise Swarm
                  </Button>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <div>
                <div className="flex items-center gap-2 text-sm text-slate-200">
                  Swarm deploys {view.enabled ? <Badge tone="amber">enabled</Badge> : <Badge>off</Badge>}
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {view.enabled
                    ? 'Services that opted in deploy as Swarm stacks. Turning this off makes their next deploy refuse until they switch back to plain containers.'
                    : active && view.controlAvailable
                      ? 'Enabling asks for your password again.'
                      : 'Initialise Swarm on the panel host first.'}
                </p>
              </div>
              <Switch
                label="Swarm deploys"
                checked={view.enabled}
                disabled={settings.isPending || (!view.enabled && !(active && view.controlAvailable))}
                onChange={(on) => {
                  if (on) {
                    setPromptError(null);
                    setEnableOpen(true);
                  } else settings.mutate({ enabled: false });
                }}
              />
            </div>

            {notice && (
              <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/[0.06] p-3 text-xs text-rose-200">
                {notice}
              </div>
            )}
            {warnings.map((w) => (
              <p key={w} className="flex gap-2 text-xs text-amber-300">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{w}</span>
              </p>
            ))}

            {view.nodes.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wide text-slate-500">
                      <th className="py-1 pr-3 font-medium">Node</th>
                      <th className="py-1 pr-3 font-medium">Role</th>
                      <th className="py-1 pr-3 font-medium">Availability</th>
                      <th className="py-1 font-medium">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.nodes.map((n) => (
                      <tr key={n.id} className="border-t border-white/[0.04] align-top text-slate-300">
                        <td className="py-1.5 pr-3">
                          {n.hostname || n.id.slice(0, 12)}
                          {n.serverId == null && <span className="ml-1 text-[10px] text-slate-500">(panel host or foreign)</span>}
                          {n.warnings?.map((w) => (
                            <div key={w} className="mt-1 text-[11px] text-amber-300">
                              {w}
                            </div>
                          ))}
                        </td>
                        <td className="py-1.5 pr-3">{n.role}</td>
                        <td className="py-1.5 pr-3">{n.availability}</td>
                        <td className="py-1.5">{n.state}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-xs text-slate-400">
              <div className="mb-1 font-medium text-slate-300">Firewall between the swarm's hosts</div>
              <ul className="list-disc space-y-0.5 pl-5">
                {SWARM_FIREWALL_PORTS.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <p className="mt-2">
                Open these only to the cluster's own hosts, never to the internet. Swarm services route over encrypted overlay networks,
                which Docker does not support on Windows hosts.
              </p>
              <p className="mt-2">
                A node joins only after its owner sets <code className="font-mono text-slate-300">{swarmOptInLine(view.managerAddr)}</code>{' '}
                in the agent's environment.
              </p>
            </div>
          </>
        )}
      </CardBody>

      {initOpen && (
        <StepUpModal
          title="Initialise Swarm?"
          confirmLabel="Initialise Swarm"
          pending={init.isPending}
          error={promptError}
          onConfirm={(password) => {
            if (!ADDRESS.test(advertiseAddr.trim())) {
              setPromptError('Enter the IPv4 or IPv6 address the nodes reach the panel host on.');
              return;
            }
            init.mutate(password);
          }}
          onClose={() => setInitOpen(false)}
          warning={
            <p>
              Runs <code className="font-mono">docker swarm init</code> on the panel host's Docker daemon. The swarm's management port
              2377/tcp then accepts joins: firewall it to the cluster's own hosts.
            </p>
          }
        >
          <Field label="Advertise address" hint="The address nodes reach the panel host on (a private address is best).">
            <Input aria-label="Advertise address" value={advertiseAddr} onChange={(e) => setAdvertiseAddr(e.target.value)} placeholder="10.0.0.2" className="font-mono" />
          </Field>
        </StepUpModal>
      )}
      {enableOpen && (
        <StepUpModal
          title="Enable Swarm deploys?"
          confirmLabel="Enable Swarm deploys"
          pending={settings.isPending}
          error={promptError}
          onConfirm={(password) => settings.mutate({ enabled: true, password })}
          onClose={() => setEnableOpen(false)}
          warning={
            <p>
              Services that opt in will deploy as Swarm stacks, scheduled on the panel host and the nodes in the swarm. A compromised
              node in the swarm can run those services' tasks.
            </p>
          }
        />
      )}
    </Card>
  );
}
