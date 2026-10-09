import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowRightLeft, Boxes, Hammer } from 'lucide-react';
import type { BuildOn, ImageTransfer, ServerListEntry, ServiceDetail, ServicePlacementInput } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { formatBytes, formatRelative } from '../../lib/format.js';
import { errorCode, errorMessage, formatMs, registeredNodes } from '../../lib/multiNode.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, CardBody, ErrorCard, Field, Input, Select, Skeleton, Switch, cn } from '../../components/ui.js';

/** Mirrors `pushRepository` in @ninedeploy/schemas: a repository path, no host and no tag. */
const REPOSITORY = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;

const BUILD_ON_LABEL: Record<BuildOn, string> = {
  target: 'Where the service runs',
  panel: 'This panel host',
  server: 'A build server',
};

interface Refusal {
  code?: string;
  message: string;
}

function RefusalNote({ refusal }: { refusal: Refusal }) {
  return (
    <div role="alert" className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/[0.06] p-3 text-xs text-rose-200">
      {refusal.message}
      {refusal.code === 'node_agent_outdated' && <div className="mt-1 text-rose-100">Update the agent on that node (Servers page), then retry.</div>}
      {refusal.code === 'swarm_disabled' && (
        <div className="mt-1">
          <Link to="/settings?section=swarm" className="text-indigo-300 hover:underline">
            Settings → Swarm
          </Link>
        </div>
      )}
    </div>
  );
}

/** "panel host" for null, the node's name when the operator listing has it. */
function hostName(id: number | null, servers: readonly ServerListEntry[] | undefined): string {
  if (id == null) return 'panel host';
  return servers?.find((s) => s.id === id)?.name ?? `node #${id}`;
}

/**
 * Service → Settings → Build placement (multi-node, design §6): where the
 * image is built ("Build on"), the optional push registry it travels through
 * (the default is a sealed stream relay through the panel), and the last 20
 * image transfers. Hidden on an older panel, whose service response carries
 * no `placement`. Changing it is operator-only, like the target node.
 */
export function BuildPlacementCard({ svc }: { svc: ServiceDetail }) {
  const placement = svc.placement;
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const isOperator = user?.isOperator === true;
  // The server refuses a build away from the service for anything but a
  // docker service (a compose stack or PM2 app builds where it runs).
  const eligible = svc.type === 'docker' && !svc.composeContent;

  const servers = useQuery({ queryKey: ['servers'], queryFn: () => api.servers.list(), enabled: isOperator && placement !== undefined });
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.sources.list(), enabled: isOperator && placement !== undefined && eligible });

  const [buildOn, setBuildOn] = useState<BuildOn>(placement?.buildOn ?? 'target');
  const [buildServerId, setBuildServerId] = useState(placement?.buildServerId == null ? '' : String(placement.buildServerId));
  const [registryId, setRegistryId] = useState(placement?.pushRegistrySourceId == null ? '' : String(placement.pushRegistrySourceId));
  const [repository, setRepository] = useState(placement?.pushRepository ?? '');
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const save = useMutation({
    mutationFn: (input: ServicePlacementInput) => api.services.placement.set(svc.id, input),
    onSuccess: () => {
      setRefusal(null);
      void qc.invalidateQueries({ queryKey: ['service', svc.id] });
      toast('Build placement saved — applied on the next deploy', 'success');
    },
    onError: (err) => setRefusal({ code: errorCode(err), message: errorMessage(err, 'Could not save the build placement') }),
  });

  if (!placement) return null;

  const buildServers = registeredNodes(servers.data).filter((s) => s.isBuildServer === true);
  const registries = (sources.data ?? []).filter((s) => s.type === 'registry');
  // The repository matters only with a registry; "None" sends both as null.
  const repoValid = registryId === '' || repository.trim() === '' || REPOSITORY.test(repository.trim());
  const registryIncomplete = registryId !== '' && repository.trim() === '';
  const canSave = !save.isPending && repoValid && !registryIncomplete && (buildOn !== 'server' || buildServerId !== '');

  const submit = () =>
    save.mutate({
      buildOn: buildOn === 'target' ? null : buildOn,
      buildServerId: buildOn === 'server' ? Number(buildServerId) : null,
      pushRegistrySourceId: registryId === '' ? null : Number(registryId),
      pushRepository: registryId === '' ? null : repository.trim(),
    });

  const current = placement.buildOn ?? 'target';
  const summary =
    current === 'server' ? `${BUILD_ON_LABEL.server}: ${hostName(placement.buildServerId, servers.data)}` : BUILD_ON_LABEL[current];

  return (
    <Card>
      <CardBody>
        <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-300">
          <Hammer size={15} className="text-slate-500" /> Build placement
        </div>

        {!eligible ? (
          <p className="text-xs text-slate-500">
            A {svc.composeContent ? 'compose stack' : `${svc.type} service`} builds where it runs. Build placement and image
            transfers apply to docker services.
          </p>
        ) : !isOperator ? (
          <p className="text-xs text-slate-500">
            Builds on <span className="text-slate-300">{summary}</span>
            {placement.pushRegistrySourceId != null && placement.pushRepository ? (
              <>
                {' '}and ships through the registry repository <code className="font-mono text-slate-300">{placement.pushRepository}</code>
              </>
            ) : null}
            . Only an instance operator can change it.
          </p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (canSave) submit();
            }}
            className="space-y-4"
          >
            <div className="flex flex-wrap items-end gap-4">
              <Field label="Build on">
                <Select aria-label="Build on" value={buildOn} onChange={(e) => setBuildOn(e.target.value as BuildOn)} className="h-9 w-56">
                  <option value="target">{BUILD_ON_LABEL.target}</option>
                  <option value="panel">{BUILD_ON_LABEL.panel}</option>
                  <option value="server">{BUILD_ON_LABEL.server}</option>
                </Select>
              </Field>
              {buildOn === 'server' && (
                <Field label="Build server">
                  <Select aria-label="Build server" value={buildServerId} onChange={(e) => setBuildServerId(e.target.value)} className="h-9 w-56" disabled={servers.isLoading}>
                    <option value="">Choose a build server…</option>
                    {buildServers.map((s) => (
                      <option key={s.id} value={String(s.id)}>
                        {s.name}
                        {s.status === 'online' ? '' : ` — ${s.status}`}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            {buildOn === 'server' && !servers.isLoading && buildServers.length === 0 && (
              <p className="text-xs text-amber-300">
                No node is a build server yet: turn the role on for one on the{' '}
                <Link to="/servers" className="text-indigo-300 hover:underline">
                  Servers page
                </Link>
                .
              </p>
            )}

            <div className="flex flex-wrap items-end gap-4">
              <Field label="Push registry">
                <Select aria-label="Push registry" value={registryId} onChange={(e) => setRegistryId(e.target.value)} className="h-9 w-56" disabled={sources.isLoading}>
                  <option value="">None: relay through the panel</option>
                  {registries.map((s) => (
                    <option key={s.id} value={String(s.id)}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {registryId !== '' && (
                <Field label="Repository" error={repoValid ? undefined : 'A repository path such as team/app (no host, no tag).'}>
                  <Input
                    aria-label="Repository"
                    value={repository}
                    onChange={(e) => setRepository(e.target.value)}
                    placeholder="team/app"
                    className="h-9 w-56 font-mono text-xs"
                  />
                </Field>
              )}
              <Button type="submit" size="sm" variant="secondary" disabled={!canSave}>
                {save.isPending ? 'Saving…' : 'Save placement'}
              </Button>
            </div>
            <p className="text-xs text-slate-500">
              A build away from where the service runs hands the image over by a sealed stream through the panel, verified by its
              digest. With a push registry it is pushed there and pulled on the target instead (a registry credential from Sources).
              Applied on the next deploy.
            </p>
          </form>
        )}

        {refusal && <RefusalNote refusal={refusal} />}

        {eligible && <TransferHistory serviceId={svc.id} servers={servers.data} />}
      </CardBody>
    </Card>
  );
}

function TransferHistory({ serviceId, servers }: { serviceId: number; servers: readonly ServerListEntry[] | undefined }) {
  const transfers = useQuery({
    queryKey: ['image-transfers', serviceId],
    queryFn: () => api.services.imageTransfers(serviceId, { limit: 20 }),
  });
  return (
    <div className="mt-5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300">
        <ArrowRightLeft size={14} className="text-slate-500" /> Image transfers
        <span className="text-xs font-normal text-slate-500">last 20</span>
      </div>
      {transfers.isLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : transfers.isError ? (
        <ErrorCard title="Could not load the image transfers" error={transfers.error} onRetry={() => void transfers.refetch()} />
      ) : (transfers.data ?? []).length === 0 ? (
        <p className="text-xs text-slate-500">No image has moved between hosts for this service yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-slate-500">
                <th className="py-1 pr-3 font-medium">When</th>
                <th className="py-1 pr-3 font-medium">Route</th>
                <th className="py-1 pr-3 font-medium">Method</th>
                <th className="py-1 pr-3 font-medium">Size</th>
                <th className="py-1 pr-3 font-medium">Duration</th>
                <th className="py-1 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {(transfers.data ?? []).map((t) => (
                <TransferRow key={t.id} transfer={t} servers={servers} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TransferRow({ transfer: t, servers }: { transfer: ImageTransfer; servers: readonly ServerListEntry[] | undefined }) {
  const tone = t.status === 'completed' ? 'emerald' : t.status === 'failed' ? 'rose' : 'amber';
  return (
    <tr className="border-t border-white/[0.04] align-top text-slate-300">
      <td className="py-1.5 pr-3 text-slate-400" title={t.startedAt}>
        {formatRelative(t.startedAt)}
      </td>
      <td className="py-1.5 pr-3">
        {hostName(t.sourceServerId, servers)} → {hostName(t.targetServerId, servers)}
      </td>
      <td className="py-1.5 pr-3 font-mono">{t.method}</td>
      <td className="py-1.5 pr-3 font-mono">{formatBytes(t.bytes)}</td>
      <td className="py-1.5 pr-3 font-mono">{formatMs(t.durationMs)}</td>
      <td className="py-1.5">
        <Badge tone={tone}>{t.status}</Badge>
        {t.error && <div className="mt-1 max-w-[18rem] break-words text-[11px] text-rose-300">{t.error}</div>}
      </td>
    </tr>
  );
}

/**
 * Service → Settings → Runtime: the "Orchestrator: Swarm" switch (operator)
 * and, while the service is on Swarm, its tasks. The server decides whether a
 * service can run on Swarm; its refusal reason is shown under the switch.
 * Hidden on an older panel (no `placement` in the service response).
 */
export function OrchestratorCard({ svc }: { svc: ServiceDetail }) {
  const placement = svc.placement;
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const isOperator = user?.isOperator === true;
  const onSwarm = placement?.orchestrator === 'swarm';
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  // Whether Swarm is enabled on this panel (operator-only route): a hint
  // before the switch is tried, not a gate — the server re-checks.
  const swarm = useQuery({ queryKey: ['swarm'], queryFn: () => api.swarm.get(), enabled: isOperator && placement !== undefined && !onSwarm });

  const save = useMutation({
    mutationFn: (on: boolean) => api.services.placement.set(svc.id, { orchestrator: on ? 'swarm' : null }),
    onSuccess: (_res, on) => {
      setRefusal(null);
      void qc.invalidateQueries({ queryKey: ['service', svc.id] });
      toast(on ? 'Runs on Swarm from the next deploy' : 'Runs as plain containers from the next deploy', 'success');
    },
    onError: (err) => setRefusal({ code: errorCode(err), message: errorMessage(err, 'Could not change the orchestrator') }),
  });

  if (!placement) return null;

  return (
    <Card>
      <CardBody>
        <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-300">
          <Boxes size={15} className="text-slate-500" /> Runtime orchestrator
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm text-slate-200">
              Orchestrator: Swarm
              {onSwarm ? <Badge tone="indigo">swarm</Badge> : <Badge>plain containers</Badge>}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Swarm spreads the replicas over the panel host and the nodes that joined the swarm, behind Traefik. It runs docker
              services from an image or a repository, with no node pin, volumes, published ports, Docker socket, databases or
              fan-out targets. Applied on the next deploy.
            </p>
          </div>
          {isOperator && (
            <Switch label="Orchestrator: Swarm" checked={onSwarm} disabled={save.isPending} onChange={(on) => save.mutate(on)} />
          )}
        </div>
        {!isOperator && <p className="mt-2 text-xs text-slate-500">Only an instance operator can change the orchestrator.</p>}
        {isOperator && !onSwarm && swarm.data && !swarm.data.enabled && (
          <p className="mt-2 text-xs text-amber-300">
            Swarm is not enabled on this panel yet:{' '}
            <Link to="/settings?section=swarm" className="text-indigo-300 hover:underline">
              Settings → Swarm
            </Link>
            .
          </p>
        )}
        {refusal && <RefusalNote refusal={refusal} />}
        {onSwarm && <SwarmTasks serviceId={svc.id} />}
      </CardBody>
    </Card>
  );
}

function SwarmTasks({ serviceId }: { serviceId: number }) {
  const status = useQuery({
    queryKey: ['service-swarm', serviceId],
    queryFn: () => api.services.swarm(serviceId),
    refetchInterval: 15_000,
  });
  const data = status.data;
  return (
    <div className="mt-5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4" data-testid="swarm-tasks">
      <div className="mb-2 flex items-center justify-between gap-2 text-sm font-medium text-slate-300">
        <span>Swarm tasks</span>
        {data?.stack && (
          <span className={cn('font-mono text-xs', data.running >= data.desired && data.desired > 0 ? 'text-emerald-300' : 'text-amber-300')}>
            {data.running}/{data.desired} running
          </span>
        )}
      </div>
      {status.isLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : status.isError ? (
        <ErrorCard title="Could not load the Swarm tasks" error={status.error} onRetry={() => void status.refetch()} />
      ) : !data?.stack ? (
        <p className="text-xs text-slate-500">Not on Swarm yet: the next deploy creates the stack.</p>
      ) : data.tasks.length === 0 ? (
        <p className="text-xs text-slate-500">
          Stack <code className="font-mono">{data.stack}</code> has no tasks.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {data.tasks.map((t, i) => (
            <li key={`${t.node}-${i}`} className="rounded-lg border border-white/[0.05] px-3 py-1.5 text-xs text-slate-300">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{t.node || 'unassigned'}</span>
                <span className="text-slate-400">{t.state}</span>
              </div>
              <div className="truncate font-mono text-[10px] text-slate-500">{t.image}</div>
              {t.error && <div className="text-[11px] text-rose-300">{t.error}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
