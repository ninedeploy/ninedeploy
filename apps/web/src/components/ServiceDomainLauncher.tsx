import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Globe, Lock, Route } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api.js';
import { Modal, cn } from './ui.js';

type LaunchableDomain = {
  id: number;
  serviceId: number;
  hostname: string;
  path?: string;
  ssl: boolean;
};

function domainUrl(domain: LaunchableDomain): string {
  const path = domain.path && domain.path !== '/' ? (domain.path.startsWith('/') ? domain.path : `/${domain.path}`) : '';
  return `${domain.ssl ? 'https' : 'http'}://${domain.hostname}${path}`;
}

/**
 * Consistent public-domain launcher for every service surface. Every mounted
 * instance shares the same React Query cache entry, so a service grid does not
 * create an API request per card.
 */
export function ServiceDomainLauncher({
  serviceId,
  serviceName,
  className,
  label = false,
}: {
  serviceId: number;
  serviceName: string;
  className?: string;
  label?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const allDomains = useQuery({
    queryKey: ['domains-all'],
    queryFn: () => api.domains.all(),
    staleTime: 15_000,
  });
  const domains = (allDomains.data ?? []).filter((domain) => domain.serviceId === serviceId);

  if (domains.length === 0) return null;

  return (
    <>
      <button
        type="button"
        aria-label={`Open ${serviceName} domain${domains.length === 1 ? '' : 's'}`}
        title={`${domains.length} domain${domains.length === 1 ? '' : 's'} — open site`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        className={cn(
          'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2.5 text-xs font-medium text-cyan-300 shadow-sm transition hover:border-cyan-400/40 hover:bg-cyan-500/20 hover:text-cyan-200',
          className,
        )}
      >
        <ExternalLink size={14} />
        {label && <span>Open site</span>}
        {domains.length > 1 && <span className="rounded-full bg-cyan-300/15 px-1.5 font-mono text-[10px]">{domains.length}</span>}
      </button>

      {open && (
        <Modal title={`Open ${serviceName}`} onClose={() => setOpen(false)}>
          <div className="mb-4 flex items-start gap-3 rounded-xl border border-cyan-500/15 bg-cyan-500/[0.06] p-3.5">
            <Globe size={17} className="mt-0.5 shrink-0 text-cyan-400" />
            <div>
              <p className="text-sm font-medium text-slate-200">
                {domains.length === 1 ? 'This page will open in a new tab.' : 'Choose the page to open in a new tab.'}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                The protocol and route path come from this service&apos;s current NineDeploy domain configuration.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            {domains.map((domain) => {
              const url = domainUrl(domain);
              const wildcard = domain.hostname.startsWith('*.');
              return (
                <div key={domain.id} className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-slate-400 ring-1 ring-inset ring-white/10">
                    {domain.ssl ? <Lock size={15} className="text-emerald-400" /> : <Route size={15} className="text-amber-400" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs text-slate-200">{url}</p>
                    <p className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">{domain.ssl ? 'HTTPS' : 'HTTP'} route</p>
                  </div>
                  {wildcard ? (
                    <span className="shrink-0 text-[10px] text-slate-500" title="Use a concrete hostname covered by this wildcard">Wildcard</span>
                  ) : (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${url} in a new tab`}
                      onClick={() => setOpen(false)}
                      className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-indigo-500 px-3 text-xs font-medium text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-400"
                    >
                      Open <ExternalLink size={13} />
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </Modal>
      )}
    </>
  );
}
