import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Database, HardDrive, Sparkles, Terminal, X, Zap } from 'lucide-react';
import { api } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';
import { useExperienceMode } from '../lib/mode.js';
import { Button, Input, cn } from './ui.js';
import { useToast } from './Toast.js';

const ENGINES = [
  { id: 'postgres', label: 'PostgreSQL', emoji: '🐘', hint: 'Relational · SQL · pgvector' },
  { id: 'mysql', label: 'MySQL', emoji: '🐬', hint: 'Relational · SQL' },
  { id: 'mariadb', label: 'MariaDB', emoji: '🦭', hint: 'Relational · SQL' },
  { id: 'redis', label: 'Redis', emoji: '⚡', hint: 'Key-value · Cache' },
  { id: 'valkey', label: 'Valkey', emoji: '🚀', hint: 'Fast KV · Redis fork' },
  { id: 'mongo', label: 'MongoDB', emoji: '🍃', hint: 'Document · NoSQL' },
  { id: 'clickhouse', label: 'ClickHouse', emoji: '📊', hint: 'Columnar · OLAP' },
  { id: 'meilisearch', label: 'Meilisearch', emoji: '🔍', hint: 'Full-text search' },
  { id: 'rabbitmq', label: 'RabbitMQ', emoji: '🐇', hint: 'Message broker · AMQP' },
] as const;

const STEPS = ['Engine', 'Details', 'Review'];

export function DatabaseWizard({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isAdvanced } = useExperienceMode();
  const [step, setStep] = useState(0);
  const [engine, setEngine] = useState<typeof ENGINES[number]['id'] | null>(null);
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [selectedVolume, setSelectedVolume] = useState<string>('');
  const [pgvector, setPgvector] = useState(false);

  const volumes = useQuery({
    queryKey: ['volumes'],
    queryFn: () => api.volumes.list(),
  });

  const retainedVolumes = (volumes.data || []).filter(
    (v) => v.owner === null && !v.inUse && v.name.startsWith('nd-db-'),
  );

  const create = useMutation({
    mutationFn: () =>
      api.databases.create({
        // Defensive 'app' fallback: a create can only be submitted after an
        // engine has been picked, so engine is never null here.
        /* v8 ignore start */
        name: name.trim() || `${engine || 'app'}-db`,
        /* v8 ignore stop */
        engine: engine!,
        version: version || undefined,
        existingVolume: selectedVolume || undefined,
        extensions: pgvector && engine === 'postgres' ? ['pgvector'] : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['databases'] });
      qc.invalidateQueries({ queryKey: ['volumes'] });
      onClose();
    },
    // r211: a taken slug or an operator-only volume re-attach was swallowed —
    // the button just went back to "Create database" with no feedback.
    onError: (err) => toast(err instanceof Error ? err.message : 'Could not create the database', 'error'),
  });

  const canNext = step === 0 ? !!engine : step === 1 ? !!name.trim() : true;

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (step < STEPS.length - 1) next();
    else create.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <button type="button" aria-label="Close dialog" tabIndex={-1} aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="nd-fade relative w-full max-w-lg overflow-hidden rounded-t-2xl border border-white/10 bg-slate-950 shadow-2xl sm:rounded-2xl">
        {/* Header + stepper */}
        <div className="border-b border-white/5 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Database size={18} className="text-emerald-400" />
              <span>New database</span>
              <span className={cn('ml-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border inline-flex items-center gap-1', isAdvanced ? 'bg-amber-500/10 border-amber-500/30 text-amber-300' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300')}>
                {isAdvanced ? <><Terminal size={10} /> DevOps Pro</> : <><Sparkles size={10} /> Quick Mode</>}
              </span>
            </h2>
            <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-300"><X size={16} /></button>
          </div>
          <div className="flex items-center gap-2">
            {STEPS.map((label, i) => (
              <div key={label} className="flex flex-1 items-center gap-2">
                <div className={cn('grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold transition', i < step ? 'bg-emerald-500 text-white' : i === step ? 'bg-indigo-500 text-white' : 'bg-white/10 text-slate-500')}>
                  {i < step ? <Check size={12} /> : i + 1}
                </div>
                <span className={cn('text-xs', i === step ? 'text-slate-200' : 'text-slate-500')}>{label}</span>
                {i < STEPS.length - 1 && <div className="h-px flex-1 bg-white/10" />}
              </div>
            ))}
          </div>
        </div>

        <form onSubmit={onSubmit} className="p-5">
          {step === 0 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {ENGINES.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => setEngine(e.id)}
                    className={cn(
                      'flex items-center gap-3 rounded-xl border p-3 text-left transition',
                      engine === e.id ? 'border-emerald-500/60 bg-emerald-500/[0.06]' : 'border-white/10 bg-white/[0.02] hover:border-white/20',
                    )}
                  >
                    <span className="text-2xl">{e.emoji}</span>
                    <span>
                      <span className="block text-sm font-medium text-slate-100">{e.label}</span>
                      <span className="block text-[10px] text-slate-500">{e.hint}</span>
                    </span>
                  </button>
                ))}
              </div>

              {!isAdvanced && engine && (
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold text-emerald-300 flex items-center gap-1">
                      <Zap size={13} className="text-emerald-400" />
                      1-Click Ready: <b>{name || `${engine}-db`}</b>
                    </div>
                    <div className="text-[10px] text-slate-400">
                      Standard persistent storage & credentials configured automatically.
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={create.isPending}
                    onClick={() => create.mutate()}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white"
                  >
                    {create.isPending ? 'Creating…' : 'Create Now'}
                  </Button>
                </div>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <div>
                <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">Name</span>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-database" autoFocus />
              </div>
              <div>
                <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">Version (optional)</span>
                <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="e.g. 16 (default if empty)" />
              </div>

              {engine === 'postgres' && (
                <label className="flex items-center gap-2.5 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] p-3 text-xs text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pgvector}
                    onChange={(e) => setPgvector(e.target.checked)}
                    className="accent-emerald-500 rounded"
                  />
                  <span>
                    <strong className="font-semibold text-emerald-300">Enable pgvector extension</strong>
                    <span className="block text-[11px] text-slate-400">Installs vector database support for AI embeddings, similarity search, and RAG workloads.</span>
                  </span>
                </label>
              )}

              {retainedVolumes.length > 0 && (
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5 space-y-2.5">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
                    <HardDrive size={14} className="text-indigo-400" />
                    <span>Persistent Volume</span>
                  </div>
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="radio"
                        name="volumeChoice"
                        checked={!selectedVolume}
                        onChange={() => setSelectedVolume('')}
                        className="accent-indigo-500"
                      />
                      <span>Create fresh volume (<code className="text-slate-400 font-mono text-[11px]">nd-db-{name.trim() || '…'}-data</code>)</span>
                    </label>
                    <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="radio"
                        name="volumeChoice"
                        checked={!!selectedVolume}
                        onChange={() => setSelectedVolume(retainedVolumes[0]!.name)}
                        className="accent-indigo-500"
                      />
                      <span>Re-attach retained volume ({retainedVolumes.length} available)</span>
                    </label>
                    {!!selectedVolume && (
                      <select
                        value={selectedVolume}
                        onChange={(e) => setSelectedVolume(e.target.value)}
                        className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
                      >
                        {retainedVolumes.map((v) => (
                          <option key={v.name} value={v.name}>
                            {v.name} ({formatBytes(v.sizeBytes)})
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              )}

              <p className="rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-slate-500">
                {selectedVolume
                  ? `Will re-attach to existing volume "${selectedVolume}" with its previous data.`
                  : 'A fresh persistent volume, auto-generated credentials and a connection string will be created.'}
              </p>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-2 text-sm">
              <Row label="Engine" value={`${ENGINES.find((e) => e.id === engine)!.emoji} ${ENGINES.find((e) => e.id === engine)!.label}`} />
              <Row label="Name" value={name} />
              <Row label="Version" value={version || 'default'} />
              <Row label="Volume" value={selectedVolume ? `Re-attach (${selectedVolume})` : `nd-db-${name}-data`} />
              <Row label="Credentials" value="auto-generated, encrypted" />
            </div>
          )}

          <div className="mt-6 flex items-center justify-between">
            <Button type="button" variant="ghost" size="sm" onClick={back} className={cn(step === 0 && 'invisible')}>
              <ArrowLeft size={14} /> Back
            </Button>
            <Button type="submit" disabled={!canNext || create.isPending}>
              {step === STEPS.length - 1 ? (create.isPending ? 'Creating…' : 'Create database') : <>Continue <ArrowRight size={14} /></>}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-2">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="font-medium text-slate-200">{value}</span>
    </div>
  );
}
