import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { AlertTriangle, Boxes, Cpu, Database, Hammer, Network } from 'lucide-react';
import { BUILD_CONCURRENCY_MAX, BUILD_CONCURRENCY_MIN } from '@ninedeploy/schemas';
import type { ServerListEntry, SwarmJoinResult, SwarmLeaveResult } from '@ninedeploy/sdk';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/format.js';
import { errorCode, errorMessage, missingFeatures, NODE_FEATURES, swarmOptInLine } from '../lib/multiNode.js';
import { useToast } from './Toast.js';
import { Badge, Button, ConfirmDialog, Input, Switch } from './ui.js';
import { DeploymentSupport } from './DeploymentSupport.js';
import { OsUpdatesCard } from './OsUpdatesCard.js';
import { fill, useT } from '../lib/i18n.js';

/** True when the panel sent any multi-node field for this node (an older panel sends none). */
export function hasNodeDetails(s: ServerListEntry): boolean {
  return (
    s.agent !== undefined ||
    s.features !== undefined ||
    s.isBuildServer !== undefined ||
    s.databases !== undefined ||
    s.swarmNodeId !== undefined
  );
}

/** A node in the swarm: delete is refused (409 `server_swarm_member`) until it leaves. */
export function isSwarmMember(s: ServerListEntry): boolean {
  return s.swarmNodeId != null && s.swarmNodeId !== '';
}

/**
 * Servers page, per node (operator only, multi-node): the agent row
 * (version, capability chips, the "update the agent" hint), the build-server
 * role, the Swarm membership, and the managed databases it hosts. Each part
 * renders only when the panel sent its field.
 */
export function ServerNodePanel({
  server,
  managerAddr,
  swarmWarnings,
}: {
  server: ServerListEntry;
  /** `GET /v1/swarm` → `managerAddr` (null until Swarm is initialised; undefined when not loaded). */
  managerAddr?: string | null;
  /** That node's warnings from `GET /v1/swarm` (e.g. the agent switched the Docker socket off). */
  swarmWarnings?: readonly string[];
}) {
  return (
    <div className="grid min-w-0 w-[calc(100cqw-2.5rem)] max-w-full grid-cols-1 gap-3 break-words text-xs md:grid-cols-2" data-testid={`node-panel-${server.id}`}>
      <AgentRow server={server} />
      <DeploymentSupport node={server} />
      {server.isBuildServer !== undefined && <BuildServerRow server={server} />}
      {(server.swarmNodeId !== undefined || server.features?.swarm !== undefined) && (
        <SwarmRow server={server} managerAddr={managerAddr} warnings={swarmWarnings ?? []} />
      )}
      {(server.databases !== undefined || isSwarmMember(server)) && <HostedRow server={server} />}
      {/* G4.2: the node's OS updates, read on request through its agent. */}
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 md:col-span-2">
        <OsUpdatesCard serverId={server.id} />
      </div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

function AgentRow({ server }: { server: ServerListEntry }) {
  const t = useT();
  const agent = server.agent;
  const features = server.features;
  const missing = missingFeatures(features);
  const version = agent?.version ?? (agent === null ? t('not checked yet') : agent ? t('unknown (older agent)') : '—');
  return (
    <Section icon={<Cpu size={12} />} title={t('Agent')}>
      <div className="flex flex-wrap items-center gap-2 text-slate-300">
        <span>
          {t('Version')} <span className="font-mono text-slate-100">{version}</span>
        </span>
        {agent?.checkedAt && <span className="text-[10px] text-slate-500">{t('checked {when}', { when: formatRelative(agent.checkedAt) })}</span>}
      </div>
      {features && (
        <div className="mt-2 flex flex-wrap gap-1">
          {NODE_FEATURES.map(([key, label]) => (
            <Badge key={key} tone={features[key] ? 'emerald' : 'neutral'} className={features[key] ? '' : 'line-through opacity-70'}>
              {label}
            </Badge>
          ))}
        </div>
      )}
      {agent && agent.capabilities.length > 0 && (
        <details className="mt-2 text-[11px] text-slate-500">
          <summary className="cursor-pointer select-none">{t('{n} capabilities', { n: agent.capabilities.length })}</summary>
          <div className="mt-1 flex flex-wrap gap-1">
            {agent.capabilities.map((cap) => (
              <code key={cap} className="rounded bg-black/30 px-1 py-0.5 font-mono text-[10px] text-slate-300">
                {cap}
              </code>
            ))}
          </div>
        </details>
      )}
      {missing.length > 0 && (
        <p className="mt-2 text-[11px] text-amber-300">
          {t('Update the agent on this node to use: {features}.', { features: missing.join(', ') })}{features?.reason ? ` ${features.reason}` : ''}
        </p>
      )}
    </Section>
  );
}

function BuildServerRow({ server }: { server: ServerListEntry }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [concurrency, setConcurrency] = useState(String(server.buildConcurrency ?? BUILD_CONCURRENCY_MIN));
  const save = useMutation({
    mutationFn: (input: { isBuildServer?: boolean; buildConcurrency?: number }) => api.servers.update(server.id, input),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['servers'] });
      if (!res.isBuildServer && res.buildServiceIds.length > 0) {
        toast(
          t('{name} is no longer a build server; {n} service(s) still build there and their next deploy fails until you change their Build on.', { name: server.name, n: res.buildServiceIds.length }),
          'info',
        );
      } else {
        toast(res.isBuildServer ? t('{name} builds images (up to {n} at once)', { name: server.name, n: String(res.buildConcurrency) }) : t('{name} is no longer a build server', { name: server.name }), 'success');
      }
    },
    onError: (err) => toast(errorMessage(err, t('Could not change the build-server role')), 'error'),
  });
  const parsed = Number(concurrency);
  const valid = Number.isInteger(parsed) && parsed >= BUILD_CONCURRENCY_MIN && parsed <= BUILD_CONCURRENCY_MAX;
  const isBuildServer = server.isBuildServer === true;
  return (
    <Section icon={<Hammer size={12} />} title={t('Build server')}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-slate-300">{isBuildServer ? t('Builds images for other services') : t('Off: builds only its own services')}</span>
        <Switch
          label={t('Build server {name}', { name: server.name })}
          checked={isBuildServer}
          disabled={save.isPending}
          onChange={(on) => save.mutate({ isBuildServer: on })}
        />
      </div>
      {isBuildServer && (
        <form
          className="mt-2 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate({ buildConcurrency: parsed });
          }}
        >
          <label className="flex flex-col gap-1 text-[11px] text-slate-500">
            {t('Concurrent builds ({min}–{max})', { min: BUILD_CONCURRENCY_MIN, max: BUILD_CONCURRENCY_MAX })}
            <Input
              aria-label={t('Build concurrency for {name}', { name: server.name })}
              type="number"
              min={BUILD_CONCURRENCY_MIN}
              max={BUILD_CONCURRENCY_MAX}
              value={concurrency}
              onChange={(e) => setConcurrency(e.target.value)}
              className="h-8 w-24 font-mono text-xs"
            />
          </label>
          <Button type="submit" size="sm" variant="secondary" disabled={!valid || save.isPending || parsed === server.buildConcurrency}>
            {t('Save')}
          </Button>
        </form>
      )}
      {server.features?.imageTransfer === false && (
        <p className="mt-2 text-[11px] text-amber-300">{t('This agent cannot hand built images over yet: update it before services build here.')}</p>
      )}
    </Section>
  );
}

function SwarmRow({ server, managerAddr, warnings }: { server: ServerListEntry; managerAddr?: string | null; warnings: readonly string[] }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [refusal, setRefusal] = useState<{ code?: string; message: string } | null>(null);
  const [resultWarnings, setResultWarnings] = useState<string[]>([]);
  const member = isSwarmMember(server);

  const settle = (res: SwarmJoinResult | SwarmLeaveResult) => {
    setRefusal(null);
    setResultWarnings(res.warnings ?? []);
    void qc.invalidateQueries({ queryKey: ['servers'] });
    void qc.invalidateQueries({ queryKey: ['swarm'] });
  };
  const fail = (err: unknown, fallback: string) => setRefusal({ code: errorCode(err), message: errorMessage(err, fallback) });

  const join = useMutation({
    mutationFn: () => api.servers.swarmJoin(server.id),
    onSuccess: (res) => {
      settle(res);
      toast(t('{name} joined the swarm', { name: server.name }), 'success');
    },
    onError: (err) => fail(err, t('Could not join the swarm')),
  });
  const leave = useMutation({
    mutationFn: () => api.servers.swarmLeave(server.id),
    onSuccess: (res) => {
      settle(res);
      toast(res.drained ? t('{name} left the swarm', { name: server.name }) : t('{name} left the swarm before its tasks moved', { name: server.name }), res.drained ? 'success' : 'info');
    },
    onError: (err) => fail(err, t('Could not leave the swarm')),
  });
  const busy = join.isPending || leave.isPending;
  const allWarnings = [...warnings, ...resultWarnings];

  return (
    <Section icon={<Network size={12} />} title={t('Swarm')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-slate-300">
          {member ? (
            <>
              <Badge tone="indigo">{server.swarmRole ?? t('member')}</Badge>
              <span className="font-mono text-[10px] text-slate-500" title={server.swarmNodeId ?? ''}>
                {(server.swarmNodeId ?? '').slice(0, 12)}
              </span>
            </>
          ) : (
            <Badge>{t('not in the swarm')}</Badge>
          )}
        </div>
        {member ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirmLeave(true)}>
            {leave.isPending ? t('Leaving…') : t('Leave')}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" disabled={busy || server.features?.swarm === false} onClick={() => join.mutate()}>
            {join.isPending ? t('Joining…') : t('Join')}
          </Button>
        )}
      </div>
      {!member && (
        <p className="mt-2 text-[11px] text-slate-500">
          {fill(t("Joining is opt-in on the node: its owner sets {line} in the agent's environment and restarts the agent."), {
            line: <code className="font-mono text-slate-300">{swarmOptInLine(managerAddr)}</code>,
          })}
        </p>
      )}
      {server.features?.swarm === false && !member && (
        <p className="mt-1 text-[11px] text-amber-300">{t('The agent on this node predates Swarm: update it first.')}</p>
      )}
      {refusal && (
        <div role="alert" className="mt-2 rounded-md border border-rose-500/30 bg-rose-500/[0.06] p-2 text-[11px] text-rose-200">
          {refusal.message}
          {refusal.code === 'node_swarm_not_enabled' && (
            <div className="mt-1 text-rose-100">
              {t('On the node:')} <code className="font-mono">{swarmOptInLine(managerAddr)}</code>
            </div>
          )}
        </div>
      )}
      {allWarnings.map((w) => (
        <p key={w} className="mt-2 flex gap-1.5 text-[11px] text-amber-300">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>{w}</span>
        </p>
      ))}
      <ConfirmDialog
        open={confirmLeave}
        title={t('Leave the swarm')}
        message={t('Drain "{name}" and take it out of the swarm? Its Swarm tasks move to the other members first; this can take a few minutes.', { name: server.name })}
        confirmLabel={t('Leave')}
        onConfirm={() => leave.mutate()}
        onClose={() => setConfirmLeave(false)}
      />
    </Section>
  );
}

function HostedRow({ server }: { server: ServerListEntry }) {
  const t = useT();
  const count = server.databases ?? 0;
  return (
    <Section icon={<Database size={12} />} title={t('Hosted here')}>
      {server.databases !== undefined && (
        <p className="text-slate-300">
          {count === 0 ? t('No managed databases') : count === 1 ? t('{n} managed database', { n: count }) : t('{n} managed databases', { n: count })}
          {count > 0 && <span className="text-slate-500"> · {t('remove is refused until they are deleted or moved')}</span>}
        </p>
      )}
      {isSwarmMember(server) && (
        <p className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-300">
          <Boxes size={12} /> {t('In the swarm: make it leave before you remove it.')}
        </p>
      )}
    </Section>
  );
}
