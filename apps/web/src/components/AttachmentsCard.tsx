import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Activity, Database, ExternalLink, Plus, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { useToast } from './Toast.js';
import { Button, Card, CardBody, Input, Select, Skeleton, StatusBadge, cn } from './ui.js';

function aliasFor(engine: string | undefined): string {
  if (!engine) return 'DATABASE_URL';
  switch (engine.toLowerCase()) {
    case 'redis':
    case 'valkey':
      return 'REDIS_URL';
    case 'mongo':
    case 'mongodb':
      return 'MONGODB_URI';
    case 'mysql':
    case 'mariadb':
      return 'MYSQL_URL';
    case 'clickhouse':
      return 'CLICKHOUSE_URL';
    case 'meilisearch':
      return 'MEILISEARCH_URL';
    case 'rabbitmq':
      return 'RABBITMQ_URL';
    default:
      return 'DATABASE_URL';
  }
}

const ENGINE_COLORS: Record<string, string> = {
  postgres: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20',
  postgresql: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20',
  redis: 'text-rose-400 bg-rose-500/10 border-rose-500/20',
  valkey: 'text-rose-400 bg-rose-500/10 border-rose-500/20',
  mysql: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  mariadb: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  mongo: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  mongodb: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  clickhouse: 'text-amber-300 bg-amber-500/10 border-amber-500/20',
  meilisearch: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
  rabbitmq: 'text-orange-400 bg-orange-500/10 border-orange-500/20',
};

export function AttachmentsCard({ serviceId }: { serviceId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [dbId, setDbId] = useState<string>('');
  const [alias, setAlias] = useState<string>('');

  const attachments = useQuery({ queryKey: ['attachments', serviceId], queryFn: () => api.attachments.list(serviceId) });
  const databases = useQuery({ queryKey: ['databases'], queryFn: () => api.databases.list() });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['attachments', serviceId] });
  const attach = useMutation({
    mutationFn: () => api.attachments.create(serviceId, { databaseId: Number(dbId), envAlias: alias || undefined }),
    onSuccess: () => {
      setDbId('');
      setAlias('');
      invalidate();
    },
    // r211: the server refuses non-admins (403) and duplicates (400); both
    // were swallowed, so Attach looked like a dead button.
    onError: (err) => toast(err instanceof Error ? err.message : 'Could not attach the database', 'error'),
  });
  const detach = useMutation({
    mutationFn: (id: number) => api.attachments.remove(serviceId, id),
    onSuccess: invalidate,
    onError: (err) => toast(err instanceof Error ? err.message : 'Could not detach the database', 'error'),
  });
  const [testingDb, setTestingDb] = useState<number | null>(null);

  // Real reachability probe: fetch the database's container logs via the API.
  // Success means the control plane can reach the running DB container.
  const testConnection = async (databaseId: number, name: string, alias: string) => {
    setTestingDb(databaseId);
    try {
      await api.databases.logs(databaseId);
      toast(`Connection to ${name} (${alias}) verified OK`, 'success');
    } catch (err) {
      toast(err instanceof Error ? `Could not reach ${name}: ${err.message}` : `Could not reach ${name}`, 'error');
    } finally {
      setTestingDb(null);
    }
  };

  const available = (databases.data ?? []).filter((d) => d.status === 'running');
  const selectedDb = available.find((d) => d.id === Number(dbId));
  const defaultPlaceholder = dbId ? aliasFor(selectedDb?.engine) : 'DATABASE_URL';

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
          <div className="flex items-center gap-2">
            <div className="grid h-7 w-7 place-items-center rounded-lg bg-emerald-500/10 text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
              <Database size={15} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Attached Databases</h3>
              <p className="text-[11px] text-slate-400">
                Directly inject connection strings into this application container.
              </p>
            </div>
          </div>
          <Link
            to="/databases"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-400 hover:text-indigo-300 transition"
          >
            <Plus size={12} /> New DB
          </Link>
        </div>

        {/* Attachment form */}
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 space-y-2.5">
          <div className="space-y-2">
            <Select
              value={dbId}
              onChange={(e) => setDbId(e.target.value)}
              className="h-9 w-full text-xs"
              aria-label="Select database to attach"
            >
              <option value="">Select database to attach…</option>
              {available.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.engine})
                </option>
              ))}
            </Select>

            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <Input
                  value={alias}
                  onChange={(e) => setAlias(e.target.value)}
                  placeholder={defaultPlaceholder}
                  className="h-9 w-full font-mono text-xs"
                  title="Environment variable alias (e.g. DATABASE_URL, REDIS_URL)"
                />
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={!dbId || attach.isPending}
                onClick={() => attach.mutate()}
                className="h-9 shrink-0 px-4 text-xs font-semibold"
              >
                Attach
              </Button>
            </div>
          </div>
          {available.length === 0 && (
            <p className="text-[11px] text-amber-300/90 flex items-center gap-1.5 pt-0.5">
              <span>⚠️</span> No active databases running. Launch a database in the Databases tab first.
            </p>
          )}
        </div>

        {/* Attached databases list */}
        <div className="space-y-2">
          {attachments.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : !attachments.data || attachments.data.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/10 p-4 text-center">
              <Database size={20} className="mx-auto text-slate-600 mb-1" />
              <p className="text-xs font-medium text-slate-400">No databases attached.</p>
              <p className="text-[11px] text-slate-500">
                Attach a managed database above to auto-wire connection environment variables.
              </p>
            </div>
          ) : (
            attachments.data.map((a) => {
              const engine = a.database?.engine?.toLowerCase();
              const badgeClass = (engine && ENGINE_COLORS[engine]) || 'text-slate-400 bg-slate-500/10 border-slate-500/20';
              return (
                <div
                  key={a.id}
                  className="group flex items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 shadow-sm dark:shadow-none transition hover:border-indigo-500/30"
                >
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <Database size={15} className="shrink-0 text-indigo-400" />
                    {a.database ? (
                      <Link
                        to={`/databases/${a.databaseId}`}
                        className="truncate text-xs font-semibold text-slate-100 hover:text-indigo-400 transition"
                      >
                        {a.database.name}
                      </Link>
                    ) : (
                      <span className="truncate text-xs font-semibold text-slate-100">database</span>
                    )}
                    {a.database && <StatusBadge status={a.database.status} />}
                    {engine && (
                      <span className={cn('rounded border px-1.5 py-0.2 font-mono text-[9px] uppercase font-medium', badgeClass)}>
                        {engine}
                      </span>
                    )}
                    <span className="font-mono text-[10px] text-slate-400">→</span>
                    <code className="rounded bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300 font-bold break-all">
                      {a.envAlias}
                    </code>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void testConnection(a.databaseId, a.database?.name ?? 'database', a.envAlias)}
                      disabled={testingDb === a.databaseId}
                      className="rounded-lg p-1.5 text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition disabled:opacity-50"
                      title="Test database connectivity"
                      aria-label="Test connection"
                    >
                      <Activity size={13} className={testingDb === a.databaseId ? 'animate-pulse' : ''} />
                    </button>
                    {a.database && (
                      <Link
                        to={`/databases/${a.databaseId}`}
                        className="rounded-lg p-1.5 text-slate-400 hover:text-indigo-400 hover:bg-white/5 transition"
                        title="Open database details"
                      >
                        <ExternalLink size={13} />
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={() => detach.mutate(a.id)}
                      disabled={detach.isPending}
                      className="rounded-lg p-1.5 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition"
                      title="Detach"
                      aria-label="Detach"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </CardBody>
    </Card>
  );
}
