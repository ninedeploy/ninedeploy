import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
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
  Archive,
  Database,
  HardDrive,
  Network,
  Server,
} from 'lucide-react';
import type { DatabaseDetail as IDatabaseDetail } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { Card, CardBody, StatusBadge } from '../../components/ui.js';

type ConsumerNodeData = { id: number; name: string; slug: string; type?: string };
type MainDbNodeData = {
  name: string;
  slug: string;
  engine: string;
  port: number;
  host: string;
  status: string;
};
type VolumeNodeData = { name: string };
type BackupDestNodeData = { count: number };

function DbConsumerNode(props: NodeProps) {
  const data = props.data as ConsumerNodeData;
  return (
    <div className="min-w-[190px] rounded-xl border border-indigo-500/30 bg-slate-900/95 p-3 shadow-lg shadow-black/50 backdrop-blur-md transition hover:border-indigo-400">
      <Handle type="source" position={Position.Right} style={{ background: 'var(--nd-accent)' }} />
      <Link to={`/services/${data.id}`} className="flex items-center gap-2 truncate hover:underline">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-indigo-500/15 text-indigo-300">
          <Server size={14} />
        </span>
        <div className="min-w-0">
          <p className="truncate font-semibold text-slate-100 text-xs">{data.name}</p>
          <p className="font-mono text-[10px] text-slate-400">Attached Application</p>
        </div>
      </Link>
    </div>
  );
}

function DbCenterNode(props: NodeProps) {
  const data = props.data as MainDbNodeData;
  return (
    <div className="min-w-[240px] rounded-2xl border-2 border-emerald-500/50 bg-slate-900/95 p-4 shadow-xl shadow-black/60 backdrop-blur-md ring-4 ring-emerald-500/10">
      <Handle type="target" position={Position.Left} style={{ background: '#10b981' }} />
      <Handle type="source" position={Position.Right} style={{ background: '#38bdf8' }} />
      <Handle type="source" id="bottom" position={Position.Bottom} style={{ background: '#f59e0b' }} />

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-emerald-500/15 text-emerald-300">
            <Database size={16} />
          </span>
          <div className="min-w-0">
            <p className="truncate font-bold text-slate-100 text-sm">{data.name}</p>
            <p className="font-mono text-[10px] capitalize text-emerald-400">{data.engine} Engine</p>
          </div>
        </div>
        <StatusBadge status={data.status} />
      </div>

      <div className="mt-3 space-y-1 rounded-xl bg-white/[0.03] p-2.5 font-mono text-[11px] text-slate-300">
        <div className="flex items-center justify-between">
          <span className="text-slate-500">Internal Host</span>
          <span className="text-slate-200">{data.host}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-slate-500">Port</span>
          <span className="text-emerald-300">:{data.port}</span>
        </div>
      </div>
    </div>
  );
}

function DbVolumeNode(props: NodeProps) {
  const data = props.data as VolumeNodeData;
  return (
    <div className="rounded-xl border border-amber-500/30 bg-slate-900/95 px-3 py-2 shadow-lg backdrop-blur-md">
      <Handle type="target" position={Position.Top} style={{ background: '#f59e0b' }} />
      <div className="flex items-center gap-2">
        <HardDrive size={14} className="text-amber-400" />
        <div>
          <p className="text-[10px] font-semibold uppercase text-slate-400">Database Storage</p>
          <p className="font-mono text-xs text-amber-300">{data.name}</p>
        </div>
      </div>
    </div>
  );
}

function DbBackupDestNode(props: NodeProps) {
  const data = props.data as BackupDestNodeData;
  return (
    <div className="min-w-[190px] rounded-xl border border-sky-500/30 bg-slate-900/95 p-3 shadow-lg shadow-black/50 backdrop-blur-md">
      <Handle type="target" position={Position.Left} style={{ background: '#38bdf8' }} />
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-sky-500/15 text-sky-300">
          <Archive size={14} />
        </span>
        <div>
          <p className="font-semibold text-slate-100 text-xs">Backup Vault</p>
          <p className="text-[10px] text-slate-400">{data.count} snapshot(s) retained</p>
        </div>
      </div>
    </div>
  );
}

const nodeTypes = {
  dbConsumer: DbConsumerNode,
  dbCenter: DbCenterNode,
  dbVolume: DbVolumeNode,
  dbBackup: DbBackupDestNode,
};

export function DatabaseTopologyTab({ db }: { db: IDatabaseDetail }) {
  const backups = useQuery({ queryKey: ['backups'], queryFn: () => api.backups.list() });

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    const attached = db.attachedServices ?? [];
    const dbBackups = (backups.data ?? []).filter((b) => b.databaseId === db.id);

    const CONSUMER_X = 40;
    const CENTER_X = 360;
    const BACKUP_X = 680;
    const CENTER_Y = 140;

    // 1. Attached consuming applications on the Left
    if (attached.length > 0) {
      attached.forEach((svc, i) => {
        const id = `consumer-${svc.id}`;
        const y = CENTER_Y - (attached.length - 1) * 40 + i * 80;
        nodes.push({
          id,
          type: 'dbConsumer',
          position: { x: CONSUMER_X, y },
          data: { id: svc.id, name: svc.name, slug: svc.slug },
        });
        edges.push({
          id: `e-${id}-db`,
          source: id,
          target: 'main-db',
          animated: true,
          style: { stroke: 'var(--nd-accent)', strokeWidth: 2 },
        });
      });
    }

    // 2. Database Node in the Center
    nodes.push({
      id: 'main-db',
      type: 'dbCenter',
      position: { x: CENTER_X, y: CENTER_Y - 30 },
      data: {
        name: db.name,
        slug: db.slug,
        engine: db.engine,
        port: db.port,
        host: db.host,
        status: db.status,
      },
    });

    // 3. Backup Snapshots Node on the Right
    nodes.push({
      id: 'backup-dest',
      type: 'dbBackup',
      position: { x: BACKUP_X, y: CENTER_Y - 15 },
      data: { count: dbBackups.length },
    });
    edges.push({
      id: 'e-db-backup',
      source: 'main-db',
      target: 'backup-dest',
      style: { stroke: '#38bdf8', strokeWidth: 1.5, strokeDasharray: '4 4' },
    });

    // 4. Volume Mount at the Bottom
    nodes.push({
      id: 'db-vol',
      type: 'dbVolume',
      position: { x: CENTER_X + 15, y: CENTER_Y + 160 },
      data: { name: db.volumeName ?? `nd-db-${db.slug}-data` },
    });
    edges.push({
      id: 'e-db-vol',
      source: 'main-db',
      sourceHandle: 'bottom',
      target: 'db-vol',
      style: { stroke: '#f59e0b', strokeWidth: 1.5, strokeDasharray: '3 3' },
    });

    return { nodes, edges };
  }, [db, backups.data]);

  return (
    <Card>
      <CardBody className="p-0">
        <div className="border-b border-white/5 p-4 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-slate-100 flex items-center gap-2">
              <Network size={16} className="text-emerald-400" />
              Database Ecosystem & Mesh Topology
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Live layout of consuming client applications, engine container, storage volume, and backup snapshot retention.
            </p>
          </div>
          <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-mono text-emerald-300">
            Interactive Schema
          </span>
        </div>

        <div className="h-[480px] w-full bg-slate-950/60 overflow-hidden relative">
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.25 }}
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{ style: { stroke: '#475569' } }}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#334155" />
              <Controls className="!border-white/10 !bg-slate-900/90 !rounded-xl overflow-hidden shadow-xl" showInteractive={false} />
              <MiniMap
                nodeColor={(n) => {
                  if (n.type === 'dbCenter') return '#10b981';
                  if (n.type === 'dbConsumer') return '#6366f1';
                  if (n.type === 'dbVolume') return '#f59e0b';
                  if (n.type === 'dbBackup') return '#38bdf8';
                  return '#64748b';
                }}
                className="!bg-slate-950/80 !border-white/10 !rounded-2xl !overflow-hidden !shadow-2xl hidden md:block"
                maskColor="rgba(15, 23, 42, 0.75)"
              />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
      </CardBody>
    </Card>
  );
}
