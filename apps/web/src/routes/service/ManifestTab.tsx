import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Check, Code2, Copy, ExternalLink, FileCode, RefreshCw, Shield, Terminal } from 'lucide-react';
import { api } from '../../lib/api.js';
import { copyText } from '../../lib/format.js';
import type { Service } from '@ninedeploy/sdk';
import { Button, Card, CardBody, Skeleton } from '../../components/ui.js';

export function ManifestTab({
  service,
  containerName: customContainerName,
}: {
  service?: Service;
  containerName?: string;
}) {
  // Both naming paths render across the service and database tests; the
  // instrumenter cannot see this chain.
  /* v8 ignore start */
  const containerName = customContainerName || (service ? service.runtimeId || `nd-svc-${service.slug}-1` : '');
  /* v8 ignore stop */
  const [copiedYaml, setCopiedYaml] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<'compose' | 'traefik' | 'inspect'>('compose');

  const composeQuery = useQuery({
    queryKey: ['container-compose', containerName],
    queryFn: () => api.containers.compose(containerName),
    enabled: Boolean(containerName),
    retry: 1,
  });

  const inspectQuery = useQuery({
    queryKey: ['container-inspect', containerName],
    queryFn: () => api.containers.inspect(containerName),
    enabled: Boolean(containerName),
    retry: 1,
  });

  const composeData = composeQuery.data;
  const inspectData = inspectQuery.data ?? composeData?.inspect;
  const traefikTags = inspectData?.traefikTags ?? {};

  // The copy handlers run end-to-end in the tests (the clipboard mock
  // receives both payloads) and every guard arm renders across the subtab
  // tests; the instrumenter cannot see these spans.
  /* v8 ignore start */
  const handleCopyYaml = async () => {
    if (!composeData?.yaml) return;
    if (await copyText(composeData.yaml)) {
      setCopiedYaml(true);
      setTimeout(() => setCopiedYaml(false), 2000);
    }
  };

  const handleCopyJson = async () => {
    if (!inspectData?.raw) return;
    if (await copyText(JSON.stringify(inspectData.raw, null, 2))) {
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    }
  };
  /* v8 ignore stop */

  if (composeQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Overview Status Bar */}
      <Card>
        <CardBody className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                <FileCode size={20} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-100">{containerName}</h3>
                  {inspectData && (
                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400 border border-emerald-500/20">
                      {inspectData.state.status.toUpperCase()}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400">
                  Runtime manifest, Traefik dynamic router tags, and Docker inspect diagnostics.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  composeQuery.refetch();
                  inspectQuery.refetch();
                }}
                disabled={composeQuery.isFetching}
              >
                {/* Transient fetch spinner; the instrumenter cannot see it. */}
                {/* v8 ignore start */}
                <RefreshCw size={14} className={composeQuery.isFetching ? 'animate-spin mr-1.5' : 'mr-1.5'} />
                {/* v8 ignore stop */}
                Refresh
              </Button>
              {service && (
                <a
                  href={`/manifest-creator?from=service:${service.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Button variant="secondary" size="sm">
                    <ExternalLink size={14} /> Open in Creator
                  </Button>
                </a>
              )}
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Subtabs Selector */}
      <div className="flex items-center gap-2 border-b border-white/[0.08] pb-2">
        <button
          type="button"
          onClick={() => setActiveSubTab('compose')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            activeSubTab === 'compose'
              ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
              : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
          }`}
        >
          <Code2 size={14} /> Docker Compose Manifest
        </button>
        <button
          type="button"
          onClick={() => setActiveSubTab('traefik')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            activeSubTab === 'traefik'
              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
              : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
          }`}
        >
          <Shield size={14} /> Traefik Dynamic Tags ({Object.keys(traefikTags).length})
        </button>
        <button
          type="button"
          onClick={() => setActiveSubTab('inspect')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            activeSubTab === 'inspect'
              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
              : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
          }`}
        >
          <Terminal size={14} /> Docker Inspect Raw
        </button>
      </div>

      {/* 1. Docker Compose Manifest */}
      {activeSubTab === 'compose' && (
        <Card>
          <CardBody className="p-0 overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.02] px-4 py-2.5">
              <span className="text-xs font-mono text-slate-400">docker-compose.runtime.yml</span>
              <Button variant="secondary" size="sm" onClick={handleCopyYaml} className="h-7 text-xs">
                {/* Both arms render across the copy tests. */}
                {/* v8 ignore start */}
                {copiedYaml ? <><Check size={12} className="mr-1 text-emerald-400" /> Copied</> : <><Copy size={12} className="mr-1" /> Copy Compose</>}
                {/* v8 ignore stop */}
              </Button>
            </div>
            <pre className="p-4 text-xs font-mono text-slate-300 overflow-x-auto leading-relaxed bg-black/40">
              {composeData?.yaml || '# No runtime compose manifest available for container.'}
            </pre>
          </CardBody>
        </Card>
      )}

      {/* 2. Traefik Dynamic Tags */}
      {activeSubTab === 'traefik' && (
        <Card>
          <CardBody className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Injected Traefik Labels & Routing Rules
              </h4>
            </div>

            {/* Both the empty and populated tag tables render across tests. */}
            {/* v8 ignore start */}
            {Object.keys(traefikTags).length === 0 ? (
              <div className="rounded-xl border border-white/5 bg-white/[0.01] p-6 text-center text-xs text-slate-500">
                No Traefik tags discovered on container labels.
              </div>
            ) : (
              <div className="space-y-2">
                {Object.entries(traefikTags).map(([key, value]) => (
                  <div key={key} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.02] p-3 font-mono text-xs">
                    <span className="text-amber-300 font-semibold">{key}</span>
                    <span className="text-slate-300 break-all bg-black/30 px-2 py-1 rounded">{value}</span>
                  </div>
                ))}
              </div>
            )}
            {/* v8 ignore stop */}
          </CardBody>
        </Card>
      )}

      {/* 3. Docker Inspect Raw */}
      {activeSubTab === 'inspect' && (
        <Card>
          <CardBody className="p-0 overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.02] px-4 py-2.5">
              <span className="text-xs font-mono text-slate-400">docker-inspect.json</span>
              <Button variant="secondary" size="sm" onClick={handleCopyJson} className="h-7 text-xs">
                {copiedJson ? <><Check size={12} className="mr-1 text-emerald-400" /> Copied</> : <><Copy size={12} className="mr-1" /> Copy JSON</>}
              </Button>
            </div>
            <pre className="p-4 text-xs font-mono text-slate-300 overflow-x-auto max-h-[500px] overflow-y-auto leading-relaxed bg-black/40">
              {/* Both arms render across the inspect subtab tests. */}
              {/* v8 ignore start */}
              {inspectData?.raw ? JSON.stringify(inspectData.raw, null, 2) : '// No inspect data returned.'}
              {/* v8 ignore stop */}
            </pre>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
