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
    <div className="grid gap-3 text-xs md:grid-cols-2" data-testid={`node-panel-${server.id}`}>
      <AgentRow server={server} />
      {server.isBuildServer !== undefined && <BuildServerRow server={server} />}
      {(server.swarmNodeId !== undefined || server.features?.swarm !== undefined) && (
        <SwarmRow server={server} managerAddr={managerAddr} warnings={swarmWarnings ?? []} />
      )}
      {(server.databases !== undefined || isSwarmMember(server)) && <HostedRow server={server} />}
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
  const agent = server.agent;
  const features = server.features;
  const missing = missingFeatures(features);
  const version = agent?.version ?? (agent === null ? 'not checked yet' : agent ? 'unknown (older agent)' : '—');
  return (
    <Section icon={<Cpu size={12} />} title="Agent">
      <div className="flex flex-wrap items-center gap-2 text-slate-300">
        <span>
          Version <span className="font-mono text-slate-100">{version}</span>
        </span>
        {agent?.checkedAt && <span className="text-[10px] text-slate-500">checked {formatRelative(agent.checkedAt)}</span>}
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
          <summary className="cursor-pointer select-none">{agent.capabilities.length} capabilities</summary>
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
          Update the agent on this node to use: {missing.join(', ')}.{features?.reason ? ` ${features.reason}` : ''}
        </p>
      )}
    </Section>
  );
}

function BuildServerRow({ server }: { server: ServerListEntry }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [concurrency, setConcurrency] = useState(String(server.buildConcurrency ?? BUILD_CONCURRENCY_MIN));
  const save = useMutation({
    mutationFn: (input: { isBuildServer?: boolean; buildConcurrency?: number }) => api.servers.update(server.id, input),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['servers'] });
      if (!res.isBuildServer && res.buildServiceIds.length > 0) {
        toast(
          `${server.name} is no longer a build server; ${res.buildServiceIds.length} service(s) still build there and their next deploy fails until you change their Build on.`,
          'info',
        );
      } else {
        toast(res.isBuildServer ? `${server.name} builds images (up to ${res.buildConcurrency} at once)` : `${server.name} is no longer a build server`, 'success');
      }
    },
    onError: (err) => toast(errorMessage(err, 'Could not change the build-server role'), 'error'),
  });
  const parsed = Number(concurrency);
  const valid = Number.isInteger(parsed) && parsed >= BUILD_CONCURRENCY_MIN && parsed <= BUILD_CONCURRENCY_MAX;
  const isBuildServer = server.isBuildServer === true;
  return (
    <Section icon={<Hammer size={12} />} title="Build server">
      <div className="flex items-center justify-between gap-3">
        <span className="text-slate-300">{isBuildServer ? 'Builds images for other services' : 'Off: builds only its own services'}</span>
        <Switch
          label={`Build server ${server.name}`}
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
            Concurrent builds ({BUILD_CONCURRENCY_MIN}–{BUILD_CONCURRENCY_MAX})
            <Input
              aria-label={`Build concurrency for ${server.name}`}
              type="number"
              min={BUILD_CONCURRENCY_MIN}
              max={BUILD_CONCURRENCY_MAX}
              value={concurrency}
              onChange={(e) => setConcurrency(e.target.value)}
              className="h-8 w-24 font-mono text-xs"
            />
          </label>
          <Button type="submit" size="sm" variant="secondary" disabled={!valid || save.isPending || parsed === server.buildConcurrency}>
            Save
          </Button>
        </form>
      )}
      {server.features?.imageTransfer === false && (
        <p className="mt-2 text-[11px] text-amber-300">This agent cannot hand built images over yet: update it before services build here.</p>
      )}
    </Section>
  );
}

function SwarmRow({ server, managerAddr, warnings }: { server: ServerListEntry; managerAddr?: string | null; warnings: readonly string[] }) {
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
      toast(`${server.name} joined the swarm`, 'success');
    },
    onError: (err) => fail(err, 'Could not join the swarm'),
  });
  const leave = useMutation({
    mutationFn: () => api.servers.swarmLeave(server.id),
    onSuccess: (res) => {
      settle(res);
      toast(res.drained ? `${server.name} left the swarm` : `${server.name} left the swarm before its tasks moved`, res.drained ? 'success' : 'info');
    },
    onError: (err) => fail(err, 'Could not leave the swarm'),
  });
  const busy = join.isPending || leave.isPending;
  const allWarnings = [...warnings, ...resultWarnings];

  return (
    <Section icon={<Network size={12} />} title="Swarm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-slate-300">
          {member ? (
            <>
              <Badge tone="indigo">{server.swarmRole ?? 'member'}</Badge>
              <span className="font-mono text-[10px] text-slate-500" title={server.swarmNodeId ?? ''}>
                {(server.swarmNodeId ?? '').slice(0, 12)}
              </span>
            </>
          ) : (
            <Badge>not in the swarm</Badge>
          )}
        </div>
        {member ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirmLeave(true)}>
            {leave.isPending ? 'Leaving…' : 'Leave'}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" disabled={busy || server.features?.swarm === false} onClick={() => join.mutate()}>
            {join.isPending ? 'Joining…' : 'Join'}
          </Button>
        )}
      </div>
      {!member && (
        <p className="mt-2 text-[11px] text-slate-500">
          Joining is opt-in on the node: its owner sets <code className="font-mono text-slate-300">{swarmOptInLine(managerAddr)}</code> in the
          agent's environment and restarts the agent.
        </p>
      )}
      {server.features?.swarm === false && !member && (
        <p className="mt-1 text-[11px] text-amber-300">The agent on this node predates Swarm: update it first.</p>
      )}
      {refusal && (
        <div role="alert" className="mt-2 rounded-md border border-rose-500/30 bg-rose-500/[0.06] p-2 text-[11px] text-rose-200">
          {refusal.message}
          {refusal.code === 'node_swarm_not_enabled' && (
            <div className="mt-1 text-rose-100">
              On the node: <code className="font-mono">{swarmOptInLine(managerAddr)}</code>
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
        title="Leave the swarm"
        message={`Drain "${server.name}" and take it out of the swarm? Its Swarm tasks move to the other members first; this can take a few minutes.`}
        confirmLabel="Leave"
        onConfirm={() => leave.mutate()}
        onClose={() => setConfirmLeave(false)}
      />
    </Section>
  );
}

function HostedRow({ server }: { server: ServerListEntry }) {
  const count = server.databases ?? 0;
  return (
    <Section icon={<Database size={12} />} title="Hosted here">
      {server.databases !== undefined && (
        <p className="text-slate-300">
          {count === 0 ? 'No managed databases' : `${count} managed database${count === 1 ? '' : 's'}`}
          {count > 0 && <span className="text-slate-500"> · remove is refused until they are deleted or moved</span>}
        </p>
      )}
      {isSwarmMember(server) && (
        <p className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-300">
          <Boxes size={12} /> In the swarm: make it leave before you remove it.
        </p>
      )}
    </Section>
  );
}
