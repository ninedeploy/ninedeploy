import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Activity,
  Check,
  Copy,
  Database,
  GitBranch,
  Globe,
  HardDrive,
  Info,
  Key,
  Layers,
  Network,
  Package,
  Radio,
  Server,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { Service } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { Button, Card, CardBody, StatusBadge } from '../../components/ui.js';
import { useCopy } from '../../lib/format.js';

type SourceNodeData = {
  repoUrl: string | null;
  branch: string;
  commitSha: string | null;
  image: string | null;
  buildPack: string;
};

type DomainNodeData = { hostname: string; ssl?: boolean; isDirect?: boolean; port?: number | null };
type GatewayNodeData = { running: boolean; domainsCount: number };
type HealthNodeData = { path: string; isLive: boolean };
type ServiceNodeData = {
  name: string;
  slug: string;
  status: string;
  type: string;
  image: string | null;
  port: number | null;
  publishedPort?: number | null;
  runtimeId: string | null;
  cpuShares: number | null;
  memLimitMb: number | null;
};
type DbNodeData = { name: string; engine: string; status: string; envAlias: string; id: number };
type StorageNodeData = { path: string; volumeName?: string };
type SecretsNodeData = { count: number; secretCount: number };

function SvcSourceNode(props: NodeProps) {
  const data = props.data as SourceNodeData;
  return (
    <div className="min-w-[200px] rounded-2xl border-2 border-slate-700/60 bg-slate-900/95 p-3.5 shadow-xl shadow-black/50 backdrop-blur-md transition hover:border-slate-500">
      <Handle type="source" position={Position.Right} style={{ background: '#94a3b8' }} />
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-slate-800 text-slate-300">
          {data.image ? <Package size={16} /> : <GitBranch size={16} />}
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-slate-100 text-xs truncate">
            {data.image ? 'Container Registry' : 'Git Repository'}
          </p>
          <p className="font-mono text-[10px] text-slate-400 truncate">
            {data.image ? data.image : data.branch}
          </p>
        </div>
      </div>
      {data.commitSha && (
        <div className="mt-2.5 rounded-lg bg-white/[0.04] px-2 py-1 font-mono text-[10px] text-slate-300 flex items-center justify-between">
          <span className="text-slate-500">Commit</span>
          <span>{data.commitSha.slice(0, 7)}</span>
        </div>
      )}
    </div>
  );
}

function SvcDomainNode(props: NodeProps) {
  const data = props.data as DomainNodeData;
  return (
    <div className="min-w-[190px] rounded-xl border border-sky-500/30 bg-slate-900/95 p-3 shadow-lg shadow-black/50 backdrop-blur-md transition hover:border-sky-400">
      <Handle type="source" position={Position.Right} style={{ background: '#38bdf8' }} />
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-sky-500/15 text-sky-400">
          {data.isDirect ? <Radio size={14} /> : <Globe size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs font-semibold text-slate-200">{data.hostname}</p>
          <p className="text-[10px] text-slate-400">
            {data.isDirect ? `Direct TCP :${data.port}` : data.ssl ? 'HTTPS / TLS 1.3' : 'HTTP / Dynamic Route'}
          </p>
        </div>
      </div>
    </div>
  );
}

function SvcGatewayNode(props: NodeProps) {
  const data = props.data as GatewayNodeData;
  return (
    <div className="min-w-[170px] rounded-2xl border-2 border-indigo-500/40 bg-slate-900/95 p-3.5 shadow-xl shadow-black/50 backdrop-blur-md">
      <Handle type="target" position={Position.Left} style={{ background: '#818cf8' }} />
      <Handle type="source" position={Position.Right} style={{ background: '#818cf8' }} />
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-indigo-500/15 text-indigo-300">
          <ShieldCheck size={16} />
        </span>
        <div>
          <p className="font-bold text-slate-100 text-xs">Traefik Ingress</p>
          <p className="text-[10px] text-slate-400">Reverse Proxy</p>
        </div>
      </div>
      <div className="mt-2.5 flex items-center justify-between border-t border-white/5 pt-1.5 text-[10px]">
        <span className="text-slate-400">{data.domainsCount} route(s)</span>
        <span className="inline-flex items-center gap-1 font-medium text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          Active
        </span>
      </div>
    </div>
  );
}

function SvcHealthNode(props: NodeProps) {
  const data = props.data as HealthNodeData;
  return (
    <div className="rounded-xl border border-emerald-500/30 bg-slate-900/95 px-3 py-2 shadow-lg backdrop-blur-md">
      <Handle type="source" position={Position.Bottom} style={{ background: '#10b981' }} />
      <div className="flex items-center gap-2">
        <Activity size={14} className="text-emerald-400" />
        <div>
          <p className="text-[10px] font-semibold uppercase text-slate-400">Health Probe</p>
          <p className="font-mono text-xs text-emerald-300">{data.path}</p>
        </div>
      </div>
    </div>
  );
}

function SvcMainNode(props: NodeProps) {
  const data = props.data as ServiceNodeData;
  return (
    <div className="min-w-[260px] rounded-2xl border-2 border-[var(--nd-accent)]/60 bg-slate-900/95 p-4 shadow-2xl shadow-black/70 backdrop-blur-md ring-4 ring-[var(--nd-accent)]/10">
      <Handle type="target" position={Position.Left} style={{ background: 'var(--nd-accent)' }} />
      <Handle type="target" id="top" position={Position.Top} style={{ background: '#10b981' }} />
      <Handle type="source" position={Position.Right} style={{ background: '#10b981' }} />
      <Handle type="source" id="bottom" position={Position.Bottom} style={{ background: '#f59e0b' }} />
      <Handle type="target" id="bottom-left" position={Position.Bottom} style={{ background: '#a855f7', left: '20%' }} />

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--nd-accent)]/15 text-[var(--nd-accent)]">
            <Server size={17} />
          </span>
          <div className="min-w-0">
            <p className="truncate font-bold text-slate-100 text-sm">{data.name}</p>
            <p className="font-mono text-[10px] uppercase text-slate-400">{data.type} container</p>
          </div>
        </div>
        <StatusBadge status={data.status} />
      </div>

      <div className="mt-3 space-y-1.5 rounded-xl bg-white/[0.03] p-2.5 font-mono text-[11px] text-slate-300">
        <div className="flex items-center justify-between">
          <span className="text-slate-500">Internal Port</span>
          <span className="text-slate-200">:{data.port ?? '—'}</span>
        </div>
        {data.publishedPort && (
          <div className="flex items-center justify-between text-amber-300">
            <span className="text-slate-500">Host Published</span>
            <span>:{data.publishedPort}</span>
          </div>
        )}
        {data.runtimeId && (
          <div className="flex items-center justify-between text-[10px] text-slate-400">
            <span className="text-slate-500">Runtime</span>
            <span className="truncate max-w-[130px]">{data.runtimeId}</span>
          </div>
        )}
        {(data.cpuShares || data.memLimitMb) && (
          <div className="flex items-center justify-between text-[10px] text-slate-500 border-t border-white/5 pt-1">
            <span>Limits</span>
            <span>
              {data.cpuShares ? `${data.cpuShares} cpu` : ''}
              {data.cpuShares && data.memLimitMb ? ' / ' : ''}
              {data.memLimitMb ? `${data.memLimitMb}MB` : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function SvcDbNode(props: NodeProps) {
  const data = props.data as DbNodeData;
  return (
    <div className="min-w-[210px] rounded-2xl border-2 border-emerald-500/40 bg-slate-900/95 p-3.5 shadow-xl shadow-black/50 backdrop-blur-md transition hover:border-emerald-400">
      <Handle type="target" position={Position.Left} style={{ background: '#10b981' }} />
      <div className="flex items-center justify-between gap-2">
        <Link to={`/databases/${data.id}`} className="flex items-center gap-2 truncate hover:underline">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-emerald-500/15 text-emerald-300">
            <Database size={15} />
          </span>
          <div className="min-w-0">
            <p className="truncate font-semibold text-slate-100 text-xs">{data.name}</p>
            <p className="font-mono text-[10px] capitalize text-slate-400">{data.engine}</p>
          </div>
        </Link>
        <StatusBadge status={data.status} />
      </div>
      <div className="mt-2.5 rounded-lg bg-emerald-500/[0.08] px-2 py-1 font-mono text-[10px] text-emerald-300">
        {data.envAlias}
      </div>
    </div>
  );
}

function SvcStorageNode(props: NodeProps) {
  const data = props.data as StorageNodeData;
  return (
    <div className="rounded-xl border border-amber-500/30 bg-slate-900/95 px-3.5 py-2.5 shadow-lg backdrop-blur-md">
      <Handle type="target" position={Position.Top} style={{ background: '#f59e0b' }} />
      <div className="flex items-center gap-2.5">
        <HardDrive size={15} className="text-amber-400" />
        <div>
          <p className="text-[10px] font-semibold uppercase text-slate-400">Volume Storage</p>
          <p className="font-mono text-xs text-amber-300">{data.path}</p>
        </div>
      </div>
    </div>
  );
}

function SvcSecretsNode(props: NodeProps) {
  const data = props.data as SecretsNodeData;
  return (
    <div className="rounded-xl border border-purple-500/30 bg-slate-900/95 px-3.5 py-2.5 shadow-lg backdrop-blur-md">
      <Handle type="source" position={Position.Top} style={{ background: '#a855f7' }} />
      <div className="flex items-center gap-2.5">
        <Key size={15} className="text-purple-400" />
        <div>
          <p className="text-[10px] font-semibold uppercase text-slate-400">Dual-Vault Store</p>
          <p className="text-xs text-purple-300">{data.count} keys ({data.secretCount} encrypted)</p>
        </div>
      </div>
    </div>
  );
}

const nodeTypes = {
  svcSource: SvcSourceNode,
  svcDomain: SvcDomainNode,
  svcGateway: SvcGatewayNode,
  svcHealth: SvcHealthNode,
  svcMain: SvcMainNode,
  svcDb: SvcDbNode,
  svcStorage: SvcStorageNode,
  svcSecrets: SvcSecretsNode,
};

export function ArchitectureTab({ service }: { service: Service }) {
  const { copied, copy } = useCopy();
  const [selectedNode, setSelectedNode] = useState<{ id: string; type?: string; data: any } | null>(null);

  const domains = useQuery({ queryKey: ['domains', service.id], queryFn: () => api.domains.list(service.id) });
  const attachments = useQuery({ queryKey: ['attachments', service.id], queryFn: () => api.attachments.list(service.id) });
  const env = useQuery({ queryKey: ['env', service.id], queryFn: () => api.env.list(service.id) });

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    const domainList = domains.data ?? [];
    const attList = attachments.data ?? [];
    const envList = env.data ?? [];

    const SOURCE_X = 20;
    const DOMAIN_X = 260;
    const GATEWAY_X = 500;
    const SERVICE_X = 760;
    const DB_X = 1100;
    const CENTER_Y = 180;

    // 1. Source Origin on Far Left
    nodes.push({
      id: 'source-origin',
      type: 'svcSource',
      position: { x: SOURCE_X, y: CENTER_Y - 40 },
      data: {
        repoUrl: service.repoUrl ?? null,
        branch: service.branch || 'main',
        commitSha: service.commitSha ?? null,
        image: service.image ?? null,
        buildPack: service.build?.buildPack || 'auto',
      },
    });

    // 2. Ingress & Domain nodes
    if (domainList.length > 0) {
      domainList.forEach((d, i) => {
        const id = `dom-${d.id}`;
        const y = CENTER_Y - (domainList.length - 1) * 35 + i * 70;
        nodes.push({
          id,
          type: 'svcDomain',
          position: { x: DOMAIN_X, y },
          data: { hostname: d.hostname, ssl: d.ssl },
        });
        edges.push({
          id: `e-${id}-gw`,
          source: id,
          target: 'gateway',
          animated: true,
          style: { stroke: '#38bdf8', strokeWidth: 1.5 },
        });
      });

      // Gateway
      nodes.push({
        id: 'gateway',
        type: 'svcGateway',
        position: { x: GATEWAY_X, y: CENTER_Y - 30 },
        data: { running: true, domainsCount: domainList.length },
      });

      edges.push({
        id: 'e-gw-service',
        source: 'gateway',
        target: 'main-service',
        animated: true,
        style: { stroke: 'var(--nd-accent)', strokeWidth: 2 },
      });
    }

    // Direct Port publishing node if configured
    if (service.publishedPort) {
      const portNodeId = 'direct-port';
      nodes.push({
        id: portNodeId,
        type: 'svcDomain',
        position: { x: DOMAIN_X, y: domainList.length > 0 ? CENTER_Y + 110 : CENTER_Y },
        data: { hostname: `0.0.0.0:${service.publishedPort}`, isDirect: true, port: service.publishedPort },
      });
      edges.push({
        id: `e-${portNodeId}-service`,
        source: portNodeId,
        target: 'main-service',
        animated: true,
        style: { stroke: '#f59e0b', strokeWidth: 2, strokeDasharray: '4 4' },
      });
    }

    // 3. Health Probe node on Top of Main Service
    if (service.healthPath) {
      nodes.push({
        id: 'health-node',
        type: 'svcHealth',
        position: { x: SERVICE_X + 45, y: CENTER_Y - 110 },
        data: { path: service.healthPath, isLive: service.status === 'running' },
      });
      edges.push({
        id: 'e-health-service',
        source: 'health-node',
        target: 'main-service',
        targetHandle: 'top',
        style: { stroke: '#10b981', strokeWidth: 1.5, strokeDasharray: '2 2' },
      });
    }

    // 4. Main Service in the Center
    nodes.push({
      id: 'main-service',
      type: 'svcMain',
      position: { x: SERVICE_X, y: CENTER_Y - 40 },
      data: {
        name: service.name,
        slug: service.slug,
        status: service.status,
        type: service.type,
        image: service.image ?? null,
        port: service.port ?? null,
        publishedPort: service.publishedPort ?? null,
        runtimeId: service.runtimeId ?? null,
        cpuShares: service.cpuShares ?? null,
        memLimitMb: service.memLimitMb ?? null,
      },
    });

    // 5. Connect Source Origin to Main Service if no domains exist or alongside
    edges.push({
      id: 'e-source-service',
      source: 'source-origin',
      target: domainList.length > 0 ? 'gateway' : 'main-service',
      style: { stroke: '#94a3b8', strokeWidth: 1.5, strokeDasharray: '3 3' },
    });

    // 6. Databases on the Right
    attList.forEach((a, i) => {
      const dbId = `db-${a.databaseId}`;
      const y = CENTER_Y - (attList.length - 1) * 45 + i * 90;
      nodes.push({
        id: dbId,
        type: 'svcDb',
        position: { x: DB_X, y },
        data: {
          id: a.databaseId,
          name: a.database?.name ?? `Database #${a.databaseId}`,
          engine: a.database?.engine ?? 'db',
          status: a.database?.status ?? 'running',
          envAlias: a.envAlias,
        },
      });
      edges.push({
        id: `e-service-${dbId}`,
        source: 'main-service',
        target: dbId,
        animated: true,
        label: a.envAlias,
        labelStyle: { fill: '#10b981', fontSize: 10, fontFamily: 'monospace', fontWeight: 600 },
        labelBgStyle: { fill: '#022c22', fillOpacity: 0.8 },
        style: { stroke: '#10b981', strokeWidth: 2 },
      });
    });

    // 7. Volume Mounts at the Bottom
    if (service.volumeMount) {
      nodes.push({
        id: 'storage-node',
        type: 'svcStorage',
        position: { x: SERVICE_X + 25, y: CENTER_Y + 180 },
        data: { path: service.volumeMount },
      });
      edges.push({
        id: 'e-service-storage',
        source: 'main-service',
        sourceHandle: 'bottom',
        target: 'storage-node',
        style: { stroke: '#f59e0b', strokeWidth: 1.5, strokeDasharray: '3 3' },
      });
    }

    // 8. Dual-Vault Env Variables at Bottom-Left
    const secretCount = envList.filter((e) => e.isSecret).length;
    nodes.push({
      id: 'secrets-node',
      type: 'svcSecrets',
      position: { x: SERVICE_X - 220, y: CENTER_Y + 180 },
      data: { count: envList.length, secretCount },
    });
    edges.push({
      id: 'e-secrets-service',
      source: 'secrets-node',
      target: 'main-service',
      targetHandle: 'bottom-left',
      style: { stroke: '#a855f7', strokeWidth: 1.5 },
    });

    return { nodes, edges };
  }, [domains.data, attachments.data, env.data, service]);

  return (
    <Card>
      <CardBody className="p-0">
        <div className="border-b border-white/5 p-4 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-slate-100 flex items-center gap-2">
              <Network size={16} className="text-[var(--nd-accent)]" />
              Full Application Architecture & System Topology
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Comprehensive mapping: Source Repository → Inbound Ingress / Direct Ports → Application Container → Attached Databases & Storage.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-full bg-white/[0.04] px-3 py-1 text-xs font-mono text-slate-300">
              <Layers size={13} className="text-[var(--nd-accent)]" />
              Interactive Canvas
            </span>
          </div>
        </div>

        <div className="h-[560px] w-full bg-slate-950/60 overflow-hidden relative">
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={(_event, node) => setSelectedNode({ id: node.id, type: node.type, data: node.data })}
              onPaneClick={() => setSelectedNode(null)}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{ style: { stroke: '#475569' } }}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#334155" />
              <Controls className="!border-white/10 !bg-slate-900/90 !rounded-xl overflow-hidden shadow-xl" showInteractive={false} />
              <MiniMap
                nodeColor={(n) => {
                  if (n.type === 'svcMain') return '#6366f1';
                  if (n.type === 'svcDb') return '#10b981';
                  if (n.type === 'svcGateway') return '#0ea5e9';
                  if (n.type === 'svcStorage') return '#f59e0b';
                  if (n.type === 'svcDomain') return '#38bdf8';
                  return '#64748b';
                }}
                className="!bg-slate-950/80 !border-white/10 !rounded-2xl !overflow-hidden !shadow-2xl hidden md:block"
                maskColor="rgba(15, 23, 42, 0.75)"
              />
            </ReactFlow>
          </ReactFlowProvider>
        </div>

        {selectedNode && (
          <div className="border-t border-white/10 bg-slate-900/90 p-4 backdrop-blur-md flex flex-wrap items-center justify-between gap-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
            <div className="flex items-center gap-3">
              <span className="grid h-8 w-8 place-items-center rounded-xl bg-white/[0.06] text-slate-300">
                <Info size={16} />
              </span>
              <div>
                <p className="text-xs font-semibold text-slate-100 flex items-center gap-2">
                  <span>Selected: {selectedNode.data?.name ?? selectedNode.data?.hostname ?? selectedNode.id}</span>
                  {selectedNode.data?.status && <StatusBadge status={selectedNode.data.status} />}
                </p>
                <p className="text-[11px] text-slate-400 font-mono mt-0.5">
                  Node Type: {selectedNode.type} {selectedNode.data?.envAlias ? `· Injected as ${selectedNode.data.envAlias}` : ''}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {selectedNode.type === 'svcDb' && selectedNode.data?.id && (
                <Link
                  to={`/databases/${selectedNode.data.id}`}
                  className="rounded-lg bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/25 transition"
                >
                  Go to Database &rarr;
                </Link>
              )}
              {selectedNode.type === 'svcDomain' && selectedNode.data?.hostname && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void copy(selectedNode.data.isDirect ? `http://0.0.0.0:${selectedNode.data.port}` : `http://${selectedNode.data.hostname}`)}
                  className="text-xs"
                >
                  {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                  {copied ? 'Copied' : 'Copy Endpoint'}
                </Button>
              )}
              <button
                type="button"
                onClick={() => setSelectedNode(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-slate-200 transition"
                title="Dismiss inspector"
              >
                <X size={15} />
              </button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
