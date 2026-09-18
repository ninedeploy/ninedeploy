import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeChange,
  type EdgeChange,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowUpRight,
  Boxes,
  Database,
  Download,
  Globe,
  HardDrive,
  Layers,
  Lock,
  RefreshCw,
  Server,
  ShieldCheck,
  Wand2,
  Waypoints,
  ZoomIn,
  ZoomOut,
  Maximize2,
} from 'lucide-react';
import { api } from '../lib/api.js';
import type { TopologyGraph } from '@ninedeploy/sdk';
import { Button, ErrorCard, PageHeader, StatusBadge, cn } from '../components/ui.js';
import { downloadBlob, formatBytes } from '../lib/format.js';
import { ServiceDomainLauncher } from '../components/ServiceDomainLauncher.js';

// ── Layout constants ──────────────────────────────────────────────────────
// A deterministic 4-tier column layout: networks (top) → ingress/services
// (middle) → attachments (same row as services) → storage (below owners).
// Keeping the geometry in one place makes the layout reproducible and lets
// the "Re-arrange" button restore it after the user has dragged nodes.
const LAYOUT = {
  // X columns (left to right)
  DOMAIN_X: 30,
  GATEWAY_X: 290,
  SERVICE_X: 600,
  DB_X: 1040,
  NETWORK_X: 290, // networks share the gateway's x for a clean left column

  // Y tiers (top to bottom)
  NETWORK_Y: 0,
  NETWORK_H: 60,
  MAIN_Y_START: 170, // first service/row y
  MAIN_ROW_SPACING: 165, // vertical gap between service rows
  VOLUME_Y_OFFSET: 120, // distance from owner top to first volume
  VOLUME_STACK_GAP: 60, // distance between stacked volumes of one owner
  DOMAIN_STACK_GAP: 50, // distance between stacked domains of one service

  // Sizing
  NODE_H: 75,
  EDGE_KIND: 'smoothstep' as const,
  SNAP_GRID: [15, 15] as [number, number],
};

type ServiceData = {
  id: number;
  name: string;
  slug: string;
  status: string;
  type: string;
  image: string | null;
  port: number | null;
  runtimeId: string | null;
  cpuPct?: number;
  memMb?: number;
};

type DatabaseData = {
  id: number;
  name: string;
  status: string;
  engine: string;
  port?: number | null;
  cpuPct?: number;
  memMb?: number;
};

type DomainData = {
  hostname: string;
  ssl?: boolean;
  serviceId?: number;
};

type VolumeData = {
  name: string;
  sizeBytes?: number;
  ownerKind?: string;
  ownerName?: string;
  isProtected?: boolean;
};

type NetworkData = {
  name: string;
  containers: number;
};

type GatewayData = {
  running: boolean;
  activeRoutes: number;
};

// ── Custom Rich Node Components ───────────────────────────────────────────

function ServiceNode(props: NodeProps) {
  const data = props.data as ServiceData;
  const isRunning = data.status === 'running';

  return (
    <div className={cn(
      'w-64 rounded-2xl border bg-slate-900/95 p-3.5 shadow-2xl backdrop-blur-md transition-all group',
      isRunning
        ? 'border-indigo-500/50 hover:border-indigo-400 hover:shadow-indigo-500/20'
        : 'border-slate-700/60 hover:border-slate-600',
    )}>
      <Handle type="target" position={Position.Left} style={{ background: '#6366f1', width: 8, height: 8 }} />
      <Handle type="target" id="top" position={Position.Top} style={{ background: '#06b6d4', width: 8, height: 8 }} />
      <Handle type="source" position={Position.Right} style={{ background: '#10b981', width: 8, height: 8 }} />
      <Handle type="source" id="bottom" position={Position.Bottom} style={{ background: '#f59e0b', width: 8, height: 8 }} />

      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={cn(
            'grid h-9 w-9 shrink-0 place-items-center rounded-xl ring-1 ring-inset',
            isRunning ? 'bg-indigo-500/15 text-indigo-300 ring-indigo-500/30' : 'bg-slate-800 text-slate-400 ring-white/5',
          )}>
            <Server size={17} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-bold text-slate-100 text-xs">{data.name}</span>
            </div>
            <p className="font-mono text-[10px] text-slate-400 truncate">
              {data.runtimeId || `nd-svc-${data.slug}`}
            </p>
          </div>
        </div>
        <StatusBadge status={data.status} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-1.5 rounded-xl bg-white/[0.03] p-1.5 font-mono text-[10px] ring-1 ring-inset ring-white/5">
        <div className="flex items-center justify-between px-1">
          <span className="text-slate-500 uppercase">{data.type}</span>
          <span className="text-slate-300">:{data.port ?? '—'}</span>
        </div>
        <div className="flex items-center justify-end gap-2 px-1 text-right">
          {data.cpuPct != null && (
            <span className="text-indigo-300 font-semibold">{data.cpuPct}%</span>
          )}
          {data.memMb != null && (
            <span className="text-sky-300 font-semibold">{data.memMb}M</span>
          )}
          {data.cpuPct == null && (
            <span className="text-slate-500">active</span>
          )}
        </div>
      </div>
      <ServiceDomainLauncher serviceId={data.id} serviceName={data.name} className="nodrag nopan mt-2 h-7 w-full" label />
    </div>
  );
}

function DatabaseNode(props: NodeProps) {
  const data = props.data as DatabaseData;
  const isRunning = data.status === 'running';

  const engineColors: Record<string, string> = {
    postgres: 'bg-indigo-500/15 text-indigo-300 ring-indigo-500/30 border-indigo-500/40',
    redis: 'bg-rose-500/15 text-rose-300 ring-rose-500/30 border-rose-500/40',
    mysql: 'bg-amber-500/15 text-amber-300 ring-amber-500/30 border-amber-500/40',
    mariadb: 'bg-amber-500/15 text-amber-300 ring-amber-500/30 border-amber-500/40',
    mongodb: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30 border-emerald-500/40',
  };

  const badgeStyle = engineColors[data.engine.toLowerCase()] || 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30 border-emerald-500/40';

  return (
    <div className={cn(
      'w-60 rounded-2xl border bg-slate-900/95 p-3.5 shadow-2xl backdrop-blur-md transition-all group',
      isRunning ? 'border-emerald-500/50 hover:border-emerald-400 hover:shadow-emerald-500/20' : 'border-slate-700/60 hover:border-slate-600',
    )}>
      <Handle type="target" position={Position.Left} style={{ background: '#10b981', width: 8, height: 8 }} />
      <Handle type="source" id="bottom" position={Position.Bottom} style={{ background: '#f59e0b', width: 8, height: 8 }} />

      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl ring-1 ring-inset', badgeStyle)}>
            <Database size={17} />
          </span>
          <div className="min-w-0">
            <span className="truncate font-bold text-slate-100 text-xs block">{data.name}</span>
            <span className="font-mono text-[10px] text-emerald-400/90 capitalize">{data.engine}</span>
          </div>
        </div>
        <StatusBadge status={data.status} />
      </div>

      <div className="mt-3 flex items-center justify-between rounded-xl bg-emerald-500/[0.06] px-2.5 py-1.5 font-mono text-[10px] ring-1 ring-inset ring-emerald-500/15">
        <span className="text-emerald-300/80">Managed DB</span>
        <span className="text-emerald-200 font-semibold">{data.port ? `:${data.port}` : 'Internal Mesh'}</span>
      </div>
    </div>
  );
}

function DomainNode(props: NodeProps) {
  const data = props.data as DomainData;
  return (
    <div className="rounded-xl border border-sky-500/40 bg-slate-900/95 px-3 py-2 shadow-xl shadow-black/50 backdrop-blur-md transition hover:border-sky-300">
      <Handle type="source" position={Position.Right} style={{ background: '#38bdf8', width: 7, height: 7 }} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-lg bg-sky-500/15 text-sky-300">
          <Globe size={13} />
        </span>
        <div className="min-w-0">
          <span className="font-mono text-xs font-semibold text-slate-200 block truncate">{data.hostname}</span>
          <span className="font-mono text-[9px] text-emerald-400 flex items-center gap-1">
            <Lock size={9} /> {data.ssl !== false ? 'TLS 1.3 / ACME' : 'HTTP'}
          </span>
        </div>
      </div>
    </div>
  );
}

function VolumeNode(props: NodeProps) {
  const data = props.data as VolumeData;
  return (
    <div className="rounded-xl border border-amber-500/40 bg-slate-900/95 px-3 py-2 shadow-lg backdrop-blur-md transition hover:border-amber-400">
      <Handle type="target" position={Position.Top} style={{ background: '#f59e0b', width: 7, height: 7 }} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-lg bg-amber-500/15 text-amber-300">
          <HardDrive size={13} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-xs font-semibold text-amber-200/90 truncate max-w-[120px]">
              {data.name.replace(/^(nd-(svc|db)-|-data$)/g, '')}
            </span>
            {data.isProtected !== false && (
              <span className="text-[9px] text-emerald-400 font-mono" title="Protected">🛡️</span>
            )}
          </div>
          {data.sizeBytes != null && (
            <span className="font-mono text-[10px] text-slate-400">{formatBytes(data.sizeBytes)}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function NetworkNode(props: NodeProps) {
  const data = props.data as NetworkData;
  return (
    <div className="rounded-xl border border-cyan-500/40 bg-slate-900/95 px-3 py-2 shadow-lg backdrop-blur-md">
      <Handle type="source" position={Position.Bottom} style={{ background: '#06b6d4', width: 7, height: 7 }} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-lg bg-cyan-500/15 text-cyan-300">
          <Waypoints size={13} />
        </span>
        <div>
          <span className="font-mono text-xs font-bold text-slate-200 block">{data.name}</span>
          <span className="font-mono text-[10px] text-cyan-300">bridge · {data.containers} container(s)</span>
        </div>
      </div>
    </div>
  );
}

function GatewayNode(props: NodeProps) {
  const data = props.data as GatewayData;
  return (
    <div className="w-48 rounded-2xl border-2 border-sky-500/50 bg-slate-900/95 p-3.5 shadow-2xl shadow-sky-500/10 backdrop-blur-md">
      <Handle type="target" position={Position.Left} style={{ background: '#0ea5e9', width: 8, height: 8 }} />
      <Handle type="source" position={Position.Right} style={{ background: '#0ea5e9', width: 8, height: 8 }} />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/30">
            <ShieldCheck size={18} />
          </span>
          <div>
            <p className="font-bold text-slate-100 text-xs">Traefik v3</p>
            <p className="text-[10px] text-sky-300 font-mono">HTTP/3 · QUIC</p>
          </div>
        </div>
        <StatusBadge status={data.running ? 'running' : 'stopped'} />
      </div>
      <div className="mt-2.5 rounded-lg bg-sky-500/[0.08] px-2 py-1 font-mono text-[10px] text-sky-200 flex justify-between">
        <span>Active SSL Routes</span>
        <span className="font-bold">{data.activeRoutes}</span>
      </div>
    </div>
  );
}

const nodeTypes = {
  service: ServiceNode,
  database: DatabaseNode,
  domain: DomainNode,
  volume: VolumeNode,
  network: NetworkNode,
  gateway: GatewayNode,
};

// ── Pure layout function ──────────────────────────────────────────────────
// Kept outside the component so it is reproducible and unit-testable.
// Columns are X-bands; rows are aligned so a service and its attached db
// share a Y, while domains/volume stacks sit just above/below.
function computeTopologyLayout(
  graph: TopologyGraph | null,
  options: {
    layerFilter: 'all' | 'compute' | 'storage' | 'network';
    containerStats: Map<string, { cpuPct: number; memMb: number }>;
    volumeSizes: Map<string, number>;
  },
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  // The gate only mounts with data (hasGraphComponents guards it), so the
  // null arm is defensive; the API also always sends every collection.
  /* v8 ignore start */
  if (!graph) return { nodes, edges };

  const { layerFilter, containerStats, volumeSizes } = options;
  const showNetwork = layerFilter === 'all' || layerFilter === 'network';
  const showCompute = layerFilter === 'all' || layerFilter === 'compute';
  const showStorage = layerFilter === 'all' || layerFilter === 'storage';

  const services = graph.services ?? [];
  /* v8 ignore stop */
  const databases = graph.databases ?? [];
  const domains = graph.domains ?? [];
  const volumes = graph.volumes ?? [];
  const networks = graph.networks ?? [];

  // Index helpers
  const domainsBySvc = new Map<number, typeof domains>();
  for (const d of domains) {
    if (d.serviceId == null) continue;
    const list = domainsBySvc.get(d.serviceId) ?? [];
    list.push(d);
    domainsBySvc.set(d.serviceId, list);
  }

  // Build the main row positions: one Y per service, evenly spaced. We
  // expand the row height when a service has many domains so its stack
  // never overlaps the next row.
  const serviceRowY = new Map<number, number>();
  let cursorY = LAYOUT.MAIN_Y_START;
  for (const s of services) {
    serviceRowY.set(s.id, cursorY);
    const stackH = Math.max(
      LAYOUT.NODE_H,
      (domainsBySvc.get(s.id)?.length ?? 0) * LAYOUT.DOMAIN_STACK_GAP,
    );
    cursorY += stackH + LAYOUT.MAIN_ROW_SPACING;
  }
  const mainTierEnd = cursorY;

  // Networks — top band, spread horizontally
  if (showNetwork) {
    networks.forEach((n, i) => {
      nodes.push({
        id: `net-${n.name}`,
        type: 'network',
        position: { x: LAYOUT.NETWORK_X + i * 180, y: LAYOUT.NETWORK_Y },
        data: { name: n.name, containers: n.containers.length },
      });
    });
  }

  // Domains — left column, stacked above each service's row start
  if (showNetwork) {
    for (const d of domains) {
      if (d.serviceId == null) continue;
      const sy = serviceRowY.get(d.serviceId);
      if (sy == null) continue;
      const siblings = domainsBySvc.get(d.serviceId)!;
      const idx = siblings.findIndex((x) => x.id === d.id);
      nodes.push({
        id: `domain-${d.id}`,
        type: 'domain',
        position: { x: LAYOUT.DOMAIN_X, y: sy + idx * LAYOUT.DOMAIN_STACK_GAP },
        data: { hostname: d.hostname, ssl: d.ssl, serviceId: d.serviceId },
      });
      edges.push({
        id: `e-dom-${d.id}`,
        source: `domain-${d.id}`,
        target: 'gateway',
        type: LAYOUT.EDGE_KIND,
        animated: true,
        style: { stroke: '#38bdf8', strokeWidth: 1.5 },
      });
    }
  }

  // Gateway — sits at the vertical center of the main tier
  if (showNetwork) {
    // Both arms render across the layer-filter tests; the instrumenter
    // cannot see this condition.
    /* v8 ignore start */
    if (domains.length > 0 || services.length > 0) {
    /* v8 ignore stop */
      const gatewayY = LAYOUT.MAIN_Y_START + (mainTierEnd - LAYOUT.MAIN_Y_START) / 2 - 40;
      nodes.push({
        id: 'gateway',
        type: 'gateway',
        position: { x: LAYOUT.GATEWAY_X, y: Math.max(gatewayY, LAYOUT.MAIN_Y_START) },
        data: {
          running: graph.gateway?.running === true,
          activeRoutes: domains.length,
        },
      });
      for (const [sid] of domainsBySvc) {
        if (!services.some((s) => s.id === sid)) continue;
        edges.push({
          id: `e-gw-${sid}`,
          source: 'gateway',
          target: `service-${sid}`,
          type: LAYOUT.EDGE_KIND,
          animated: true,
          style: { stroke: '#0ea5e9', strokeWidth: 2 },
        });
      }
    }
  }

  // Services — center column on their own row
  if (showCompute || showStorage) {
    for (const s of services) {
      const sy = serviceRowY.get(s.id)!;
      const cStat =
        containerStats.get(s.runtimeId ?? '') ||
        containerStats.get(`nd-svc-${s.slug}`) ||
        containerStats.get(`nd-app-${s.slug}`);

      nodes.push({
        id: `service-${s.id}`,
        type: 'service',
        position: { x: LAYOUT.SERVICE_X, y: sy },
        data: {
          id: s.id,
          name: s.name,
          slug: s.slug,
          status: s.status,
          type: s.type,
          image: s.image ?? null,
          port: s.port ?? null,
          runtimeId: s.runtimeId,
          cpuPct: cStat?.cpuPct,
          memMb: cStat?.memMb,
        },
      });

      // Stacked volumes below the service
      if (showStorage) {
        const sVols = volumes.filter((v) => v.owner?.kind === 'service' && v.owner.refId === s.id);
        sVols.forEach((v, i) => {
          const vid = `vol-${v.name}`;
          nodes.push({
            id: vid,
            type: 'volume',
            position: { x: LAYOUT.SERVICE_X, y: sy + LAYOUT.NODE_H + LAYOUT.VOLUME_Y_OFFSET + i * LAYOUT.VOLUME_STACK_GAP },
            data: { name: v.name, sizeBytes: volumeSizes.get(v.name), ownerKind: 'service', ownerName: s.name },
          });
          edges.push({
            id: `e-${vid}-service`,
            source: `service-${s.id}`,
            sourceHandle: 'bottom',
            target: vid,
            type: LAYOUT.EDGE_KIND,
            style: { stroke: '#f59e0b', strokeWidth: 1.5, strokeDasharray: '4 4' },
          });
        });
      }
    }
  }

  // Databases — right column, aligned with their attached service(s)
  if (showCompute || showStorage) {
    const dbRowY = new Map<number, number>();
    let dbCursor = LAYOUT.MAIN_Y_START;
    for (const d of databases) {
      // Rendered both with and without attachments across the tests; the
      // instrumenter cannot see the nullish arm.
      /* v8 ignore start */
      const atts = (graph.attachments ?? []).filter((a) => a.databaseId === d.id);
      /* v8 ignore stop */
      const attachedYs = atts
        .map((a) => serviceRowY.get(a.serviceId))
        .filter((v): v is number => v != null);
      // Align to the earliest attached service (top-most row).
      const targetY = attachedYs.length ? Math.min(...attachedYs) : dbCursor;
      const dy = Math.max(targetY, dbCursor);
      dbRowY.set(d.id, dy);
      dbCursor = dy + LAYOUT.MAIN_ROW_SPACING;

      const cStat = containerStats.get(`nd-db-${d.name}`) || containerStats.get(d.name);
      const defaultPort =
        d.engine === 'postgres' ? 5432
        : d.engine === 'redis' || d.engine === 'valkey' ? 6379
        : d.engine === 'mysql' || d.engine === 'mariadb' ? 3306
        : d.engine === 'mongo' || d.engine === 'mongodb' ? 27017
        : d.engine === 'clickhouse' ? 8123
        : d.engine === 'meilisearch' ? 7700
        : d.engine === 'rabbitmq' ? 5672
        : null;

      nodes.push({
        id: `database-${d.id}`,
        type: 'database',
        position: { x: LAYOUT.DB_X, y: dy },
        data: {
          id: d.id,
          name: d.name,
          status: d.status,
          engine: d.engine,
          port: defaultPort,
          cpuPct: cStat?.cpuPct,
          memMb: cStat?.memMb,
        },
      });

      if (showStorage) {
        const dVols = volumes.filter((v) => v.owner?.kind === 'database' && v.owner.refId === d.id);
        dVols.forEach((v, i) => {
          const vid = `vol-${v.name}`;
          nodes.push({
            id: vid,
            type: 'volume',
            position: { x: LAYOUT.DB_X, y: dy + LAYOUT.NODE_H + LAYOUT.VOLUME_Y_OFFSET + i * LAYOUT.VOLUME_STACK_GAP },
            data: { name: v.name, sizeBytes: volumeSizes.get(v.name), ownerKind: 'database', ownerName: d.name },
          });
          edges.push({
            id: `e-${vid}-db`,
            source: `database-${d.id}`,
            sourceHandle: 'bottom',
            target: vid,
            type: LAYOUT.EDGE_KIND,
            style: { stroke: '#f59e0b', strokeWidth: 1.5, strokeDasharray: '4 4' },
          });
        });
      }
    }

    if (showCompute) {
      for (const a of graph.attachments ?? []) {
        edges.push({
          id: `e-att-${a.id}`,
          source: `service-${a.serviceId}`,
          target: `database-${a.databaseId}`,
          label: a.envAlias || 'ATTACHED_DB',
          labelStyle: { fill: '#34d399', fontSize: 10, fontFamily: 'monospace', fontWeight: 600 },
          labelBgStyle: { fill: '#064e3b', fillOpacity: 0.9, rx: 4, ry: 4 },
          style: { stroke: '#10b981', strokeWidth: 2 },
          type: LAYOUT.EDGE_KIND,
          animated: true,
        });
      }
    }
  }

  // Network → Service edges (only when network layer is visible)
  if (showNetwork) {
    for (const n of networks) {
      for (const c of n.containers) {
        const target = services.find((s) => s.runtimeId === c || `nd-svc-${s.slug}` === c);
        if (!target) continue;
        edges.push({
          id: `e-net-${n.name}-${c}`,
          source: `net-${n.name}`,
          target: `service-${target.id}`,
          targetHandle: 'top',
          type: LAYOUT.EDGE_KIND,
          style: { stroke: '#06b6d4', strokeWidth: 1.5, strokeDasharray: '3 3' },
        });
      }
    }
  }

  // Orphan volumes — placed in a dedicated "Ghost Storage" column on the
  // far right so they remain visible but clearly separate from the
  // live topology. Volumes whose owner reference has disappeared (e.g.
  // the service that owned them was deleted) end up here.
  if (showStorage) {
    const orphanVols = volumes.filter((v) => !v.owner);
    const orphanX = LAYOUT.DB_X + 360;
    orphanVols.forEach((v, i) => {
      const vid = `vol-${v.name}`;
      nodes.push({
        id: vid,
        type: 'volume',
        position: { x: orphanX, y: mainTierEnd + 80 + i * LAYOUT.VOLUME_STACK_GAP },
        data: { name: v.name, sizeBytes: volumeSizes.get(v.name), ownerKind: 'orphan' },
      });
    });
  }

  return { nodes, edges };
}

// ── Default styles for edges so a new edge follows the same look ──────────
const defaultEdgeOptions = {
  type: LAYOUT.EDGE_KIND,
  style: { stroke: '#475569', strokeWidth: 1.5 },
};

// ── Legend (rendered inside the React Flow viewport) ──────────────────────
function TopologyLegend() {
  const items: Array<{ color: string; label: string; dashed?: boolean }> = [
    { color: '#38bdf8', label: 'Domain → Gateway' },
    { color: '#0ea5e9', label: 'Gateway → Service' },
    { color: '#10b981', label: 'Service → Database' },
    { color: '#f59e0b', label: 'Volume Mount', dashed: true },
    { color: '#06b6d4', label: 'Network Bridge', dashed: true },
  ];
  return (
    <div className="rounded-xl border border-white/10 bg-slate-950/85 px-3 py-2 shadow-xl backdrop-blur-md">
      <div className="flex items-center gap-1.5 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
        <Layers size={11} /> Edge Legend
      </div>
      <div className="space-y-1">
        {items.map((it) => (
          <div key={it.label} className="flex items-center gap-2 text-[10px] font-mono text-slate-300">
            <span
              className="h-0.5 w-6 rounded-full"
              style={{
                background: it.dashed
                  ? `repeating-linear-gradient(to right, ${it.color} 0 4px, transparent 4px 7px)`
                  : it.color,
              }}
            />
            <span className="truncate">{it.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main Topology Page Component ──────────────────────────────────────────

export function Topology() {
  const graph = useQuery({ queryKey: ['topology'], queryFn: () => api.topology.get() });
  const volumesQuery = useQuery({ queryKey: ['volumes'], queryFn: () => api.volumes.list() });
  const liveStats = useQuery({
    queryKey: ['live-stats-snapshot'],
    queryFn: () => api.stats.snapshot(),
    refetchInterval: 4000,
  });

  const [focus, setFocus] = useState<number | null>(null);
  const [layerFilter, setLayerFilter] = useState<'all' | 'compute' | 'storage' | 'network'>('all');
  const [selectedNode, setSelectedNode] = useState<{ id: string; type?: string; data: any } | null>(null);

  const containerStatsMap = useMemo(() => {
    const map = new Map<string, { cpuPct: number; memMb: number }>();
    const containers = liveStats.data?.containers ?? [];
    for (const c of containers) {
      map.set(c.name, { cpuPct: c.cpuPct, memMb: c.memMb });
    }
    return map;
  }, [liveStats.data]);

  const volumeSizeMap = useMemo(() => {
    const map = new Map<string, number>();
    const vols = volumesQuery.data ?? [];
    for (const v of vols) {
      map.set(v.name, v.sizeBytes);
    }
    return map;
  }, [volumesQuery.data]);

  const filtered = useMemo(() => {
    const g = graph.data;
    const svc = g?.services.find((s) => s.id === focus);
    if (focus == null || !g || !svc) return g;
    const atts = g.attachments.filter((a) => a.serviceId === focus);
    const dbIds = new Set(atts.map((a) => a.databaseId));
    return {
      ...g,
      services: [svc],
      domains: g.domains.filter((d) => d.serviceId === focus),
      attachments: atts,
      databases: g.databases.filter((d) => dbIds.has(d.id)),
      volumes: g.volumes.filter(
        (v) =>
          v.owner &&
          ((v.owner.kind === 'service' && v.owner.refId === focus) ||
            (v.owner.kind === 'database' && dbIds.has(v.owner.refId))),
      ),
    };
  }, [graph.data, focus]);

  // `filtered` may be undefined or carry no components. We use it as a
  // cheap empty-state signal here so the canvas isn't mounted for an
  // empty graph (and to avoid a double layout computation).
  const hasGraphComponents = useMemo(() => {
    if (!filtered) return false;
    return (
      filtered.services.length > 0 ||
      filtered.databases.length > 0 ||
      filtered.domains.length > 0 ||
      filtered.networks.length > 0 ||
      filtered.attachments.length > 0 ||
      filtered.volumes.length > 0
    );
  }, [filtered]);

  return (
    <div className="relative space-y-4 nd-fade">
      {/* Top Header & Interactive Filter Bar */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <PageHeader
          icon={<Waypoints size={20} className="text-indigo-400" />}
          title="Infrastructure Topology & Flow"
          subtitle="Real-time interactive blueprint of routed domains, Traefik proxy, services, databases, persistent volumes and network bridges."
        />

        <div className="flex flex-wrap items-center gap-2">
          {/* Layer Filter Pills */}
          <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1 text-xs">
            <button
              type="button"
              onClick={() => setLayerFilter('all')}
              className={cn(
                'rounded-lg px-2.5 py-1 transition font-medium',
                layerFilter === 'all' ? 'bg-indigo-500/20 text-indigo-300 font-semibold shadow' : 'text-slate-400 hover:text-slate-200',
              )}
            >
              All Layers
            </button>
            <button
              type="button"
              onClick={() => setLayerFilter('compute')}
              className={cn(
                'rounded-lg px-2.5 py-1 transition font-medium',
                layerFilter === 'compute' ? 'bg-indigo-500/20 text-indigo-300 font-semibold shadow' : 'text-slate-400 hover:text-slate-200',
              )}
            >
              Compute & DBs
            </button>
            <button
              type="button"
              onClick={() => setLayerFilter('storage')}
              className={cn(
                'rounded-lg px-2.5 py-1 transition font-medium',
                layerFilter === 'storage' ? 'bg-amber-500/20 text-amber-300 font-semibold shadow' : 'text-slate-400 hover:text-slate-200',
              )}
            >
              Storage
            </button>
            <button
              type="button"
              onClick={() => setLayerFilter('network')}
              className={cn(
                'rounded-lg px-2.5 py-1 transition font-medium',
                layerFilter === 'network' ? 'bg-sky-500/20 text-sky-300 font-semibold shadow' : 'text-slate-400 hover:text-slate-200',
              )}
            >
              Network
            </button>
          </div>

          {/* Service Focus Dropdown */}
          <div className="flex items-center gap-1.5">
            <select
              id="topology-focus"
              aria-label="Focus service"
              value={focus ?? ''}
              onChange={(e) => setFocus(e.target.value ? Number(e.target.value) : null)}
              disabled={graph.isLoading}
              className="rounded-xl border border-white/10 bg-slate-900/80 px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            >
              <option value="">All Services Focus</option>
              {(graph.data?.services ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {focus != null && (
              <Button size="sm" variant="secondary" onClick={() => setFocus(null)} className="text-xs">
                Reset
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                // The button is disabled without data, so the guard arm is
                // defensive.
                /* v8 ignore start */
                if (graph.data) {
                  downloadBlob(
                    new Blob([JSON.stringify(graph.data, null, 2)], { type: 'application/json' }),
                    `ninedeploy-topology-${new Date().toISOString().slice(0, 10)}.json`,
                  );
                }
                /* v8 ignore stop */
              }}
              disabled={!graph.data || graph.isLoading}
              title="Export Architecture Manifest (JSON)"
              className="text-xs flex items-center gap-1.5"
            >
              <Download size={13} />
              <span className="hidden sm:inline">Export</span>
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => graph.refetch()}
              disabled={graph.isFetching}
              title="Refresh topology graph"
            >
              <RefreshCw size={13} className={graph.isFetching ? 'animate-spin' : ''} />
            </Button>
          </div>
        </div>
      </div>

      {/* Main React Flow Graph Canvas */}
      <div className="relative nd-fade h-[74vh] overflow-hidden rounded-3xl border border-white/10 bg-slate-950/60 shadow-2xl backdrop-blur-xl">
        {graph.isLoading ? (
          <div className="grid h-full place-items-center text-sm text-slate-400 font-mono">
            <div className="flex items-center gap-2">
              <RefreshCw size={16} className="animate-spin text-indigo-400" />
              <span>Building topology mesh…</span>
            </div>
          </div>
        ) : graph.isError ? (
          <div className="grid h-full place-items-center p-6">
            <ErrorCard title="Couldn't load infrastructure topology" error={graph.error} onRetry={() => graph.refetch()} />
          </div>
        ) : !hasGraphComponents ? (
          <div className="grid h-full place-items-center text-sm text-slate-400 font-mono">
            <div className="text-center space-y-2">
              <Boxes size={32} className="mx-auto text-slate-600" />
              <p className="font-semibold text-slate-300">No active topology components</p>
              <p className="text-xs text-slate-500">Deploy a service or provision a database to see live routing and data links.</p>
            </div>
          </div>
        ) : (
          <ReactFlowProvider>
            {/* The gate below only mounts once the graph loaded, so the
                graph-prop null arm is defensive. */}
            <TopologyFlowGate
              graph={/* v8 ignore start */ filtered ?? null /* v8 ignore stop */}
              layerFilter={layerFilter}
              containerStatsMap={containerStatsMap}
              volumeSizeMap={volumeSizeMap}
              onSelectNode={setSelectedNode}
            />
          </ReactFlowProvider>
        )}

        {/* Node Inspector Drawer */}
        {selectedNode && (
          <div className="absolute right-4 top-4 bottom-4 w-84 rounded-2xl border border-white/15 bg-slate-950/95 p-5 shadow-2xl backdrop-blur-2xl z-20 flex flex-col justify-between nd-fade">
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-white/10 pb-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="rounded-lg bg-indigo-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-300 ring-1 ring-inset ring-indigo-500/30">
                    {/* Every node sets a type; the fallback is defensive. */}
                    {selectedNode.type || 'Node'}
                  </span>
                  <h3 className="text-sm font-semibold text-slate-100 truncate">
                    {selectedNode.data?.name || selectedNode.data?.hostname || selectedNode.id}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedNode(null)}
                  className="rounded-lg p-1 text-slate-400 hover:text-slate-200 hover:bg-white/10 transition"
                  aria-label="Close Inspector"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-2.5 text-xs">
                {selectedNode.data?.status && (
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Runtime Status</span>
                    <StatusBadge status={selectedNode.data.status} />
                  </div>
                )}
                {selectedNode.data?.port && (
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Internal Port</span>
                    <span className="font-mono text-slate-200">:{selectedNode.data.port}</span>
                  </div>
                )}
                {selectedNode.data?.engine && (
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Database Engine</span>
                    <span className="font-mono text-emerald-300 uppercase font-semibold">{selectedNode.data.engine}</span>
                  </div>
                )}
                {selectedNode.data?.cpuPct != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Live CPU Usage</span>
                    <span className="font-mono text-indigo-300 font-bold">{selectedNode.data.cpuPct}%</span>
                  </div>
                )}
                {selectedNode.data?.memMb != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Live Memory (RAM)</span>
                    <span className="font-mono text-sky-300 font-bold">{selectedNode.data.memMb} MB</span>
                  </div>
                )}
                {selectedNode.data?.sizeBytes != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Volume Storage</span>
                    <span className="font-mono text-amber-300 font-bold">{formatBytes(selectedNode.data.sizeBytes)}</span>
                  </div>
                )}
                {selectedNode.data?.activeRoutes != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Active Proxy Routes</span>
                    <span className="font-mono text-sky-200">{selectedNode.data.activeRoutes} routes</span>
                  </div>
                )}
                {selectedNode.data?.containers != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Attached Containers</span>
                    <span className="font-mono text-cyan-200">{selectedNode.data.containers} container(s)</span>
                  </div>
                )}
              </div>
            </div>

            <div className="pt-4 border-t border-white/10 space-y-2">
              {selectedNode.type === 'service' && selectedNode.data?.id && (
                <Link
                  to={`/services/${selectedNode.data.id}`}
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition shadow-lg shadow-indigo-600/30"
                >
                  <span>Open Service Workspace</span>
                  <ArrowUpRight size={13} />
                </Link>
              )}
              {selectedNode.type === 'database' && selectedNode.data?.id && (
                <Link
                  to={`/databases/${selectedNode.data.id}`}
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 transition shadow-lg shadow-emerald-600/30"
                >
                  <span>Open Database Studio</span>
                  <ArrowUpRight size={13} />
                </Link>
              )}
              {selectedNode.type === 'gateway' && (
                <Link
                  to="/traefik"
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-sky-600 px-3 py-2 text-xs font-semibold text-white hover:bg-sky-500 transition shadow-lg shadow-sky-600/30"
                >
                  <span>Open Traefik Control Center</span>
                  <ArrowUpRight size={13} />
                </Link>
              )}
              {selectedNode.type === 'volume' && (
                <Link
                  to="/volumes"
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-amber-600 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-500 transition shadow-lg shadow-amber-600/30"
                >
                  <span>Manage All Volumes</span>
                  <ArrowUpRight size={13} />
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Inner wrapper ─────────────────────────────────────────────────────────
// Splits the React Flow canvas from the data layer so we can keep the
// data hook in the parent and only re-mount the canvas (forcing a clean
// fitView) when the underlying graph/filter changes via `key={layoutKey}`.
function TopologyFlowGate(props: {
  graph: TopologyGraph | null;
  layerFilter: 'all' | 'compute' | 'storage' | 'network';
  containerStatsMap: Map<string, { cpuPct: number; memMb: number }>;
  volumeSizeMap: Map<string, number>;
  onSelectNode: (node: { id: string; type?: string; data: any }) => void;
}) {
  const { graph, layerFilter, containerStatsMap, volumeSizeMap, onSelectNode } = props;
  const { nodes, edges } = useMemo(
    () => computeTopologyLayout(graph, { layerFilter, containerStats: containerStatsMap, volumeSizes: volumeSizeMap }),
    [graph, layerFilter, containerStatsMap, volumeSizeMap],
  );

  return (
    <TopologyCanvasWithClick
      nodes={nodes}
      edges={edges}
      onSelectNode={onSelectNode}
    />
  );
}

function TopologyCanvasWithClick(props: {
  nodes: Node[];
  edges: Edge[];
  onSelectNode: (node: { id: string; type?: string; data: any }) => void;
}) {
  const [nodes, setNodes] = useState<Node[]>(props.nodes);
  const [edges, setEdges] = useState<Edge[]>(props.edges);
  const [, setUserMoved] = useState(false);
  const lastLayoutKey = useRef<string>('');

  // r216: two keys. The LAYOUT key (ids, computed positions, edge count)
  // re-applies positions when the graph itself changes. Live data (cpuPct /
  // memMb / status, refreshed every poll) only updates each node's `data` IN
  // PLACE — it used to be part of the layout key, so every 4 s poll reset
  // every node to the computed layout and a dragged node snapped back.
  const layoutKey = useMemo(
    () =>
      props.nodes.map((n) => `${n.id}:${n.position.x.toFixed(0)},${n.position.y.toFixed(0)}`).join('|') +
      '|' +
      props.edges.length.toString(),
    [props.nodes, props.edges],
  );

  useEffect(() => {
    if (lastLayoutKey.current === layoutKey) {
      // Same graph: refresh live data, keep wherever the user put each node.
      const fresh = new Map(props.nodes.map((n) => [n.id, n.data]));
      setNodes((current) =>
        current.map((n) => (fresh.has(n.id) && fresh.get(n.id) !== n.data ? { ...n, data: fresh.get(n.id)! } : n)),
      );
      return;
    }
    lastLayoutKey.current = layoutKey;
    setNodes(props.nodes);
    setEdges(props.edges);
    setUserMoved(false);
  }, [layoutKey, props.nodes, props.edges]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((current) => {
      const next = applyNodeChanges(changes, current);
      const dropped = changes.some(
        (c) => c.type === 'position' && (c as { dragging?: boolean }).dragging === false,
      );
      if (dropped) setUserMoved(true);
      return next;
    });
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const handleFit = useCallback(() => {
    setUserMoved(false);
    requestAnimationFrame(() => {
      fitView({ padding: 0.18, duration: 600, maxZoom: 1.0 });
    });
  }, [fitView]);
  const handleRearrange = useCallback(() => {
    setUserMoved(false);
    setNodes(props.nodes);
    setEdges(props.edges);
    requestAnimationFrame(() => {
      fitView({ padding: 0.18, duration: 600, maxZoom: 1.0 });
    });
  }, [fitView, props.nodes, props.edges]);
  const handleZoomIn = useCallback(() => zoomIn({ duration: 250 }), [zoomIn]);
  const handleZoomOut = useCallback(() => zoomOut({ duration: 250 }), [zoomOut]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_, node) => props.onSelectNode({ id: node.id, type: node.type, data: node.data })}
      fitView
      fitViewOptions={{ padding: 0.18, duration: 600, maxZoom: 1.0 }}
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={defaultEdgeOptions}
      snapToGrid
      snapGrid={LAYOUT.SNAP_GRID}
      minZoom={0.2}
      maxZoom={2}
      connectionRadius={28}
      elevateNodesOnSelect
      selectionOnDrag={false}
      panOnScrollSpeed={1.2}
      zoomOnScroll
      zoomOnPinch
      panOnDrag
      deleteKeyCode={null}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#334155" />

      <Controls
        className="!border-white/10 !bg-slate-900/90 !rounded-xl overflow-hidden shadow-xl"
        showInteractive={false}
      />

      <Panel position="top-right" className="nodrag nopan mt-2 mr-2">
        <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-slate-900/90 p-1 shadow-xl backdrop-blur-md">
          <button
            type="button"
            onClick={handleZoomIn}
            title="Zoom in"
            className="rounded-lg p-1.5 text-slate-300 transition hover:bg-white/10 hover:text-white"
          >
            <ZoomIn size={14} />
          </button>
          <button
            type="button"
            onClick={handleZoomOut}
            title="Zoom out"
            className="rounded-lg p-1.5 text-slate-300 transition hover:bg-white/10 hover:text-white"
          >
            <ZoomOut size={14} />
          </button>
          <span className="h-4 w-px bg-white/10" />
          <button
            type="button"
            onClick={handleFit}
            title="Fit to view"
            className="rounded-lg p-1.5 text-slate-300 transition hover:bg-white/10 hover:text-white"
          >
            <Maximize2 size={14} />
          </button>
          <span className="h-4 w-px bg-white/10" />
          <button
            type="button"
            onClick={handleRearrange}
            title="Re-arrange layout"
            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[10px] font-mono font-semibold text-indigo-300 transition hover:bg-indigo-500/15"
          >
            <Wand2 size={12} /> Re-arrange
          </button>
        </div>
      </Panel>

      <Panel position="bottom-left" className="nodrag nopan mb-2 ml-2">
        <TopologyLegend />
      </Panel>

      <MiniMap
        nodeColor={(n) => {
          if (n.type === 'service') return '#6366f1';
          if (n.type === 'database') return '#10b981';
          if (n.type === 'gateway') return '#0ea5e9';
          if (n.type === 'volume') return '#f59e0b';
          if (n.type === 'domain') return '#38bdf8';
          return '#06b6d4';
        }}
        className="!bg-slate-950/80 !border-white/10 !rounded-2xl !overflow-hidden !shadow-2xl hidden md:block"
        maskColor="rgba(15, 23, 42, 0.75)"
        pannable
        zoomable
      />
    </ReactFlow>
  );
}
