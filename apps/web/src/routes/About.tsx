import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, GitBranch, Heart, Layers, Package, RefreshCw, Shield, Sparkles, Terminal } from 'lucide-react';
import { api } from '../lib/api.js';
import { usePanelUpdate } from '../lib/usePanelUpdate.js';
import { Button, ConfirmDialog, Card, CardBody, Skeleton } from '../components/ui.js';

export function About() {
  const about = useQuery({ queryKey: ['about'], queryFn: () => api.about.get(), staleTime: 60000 });
  const queryClient = useQueryClient();
  const update = useQuery({ queryKey: ['update-check'], queryFn: () => api.system.updateCheck(), staleTime: 60000 });
  const upd = usePanelUpdate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  // force=1 bypasses the server-side cache (a failure is only cached 10 min,
  // but the operator should not have to wait for that window either).
  const recheck = async () => {
    setRechecking(true);
    try {
      const fresh = await api.system.updateCheck(true);
      queryClient.setQueryData(['update-check'], fresh);
    } catch {
      /* keep the previous result on screen */
    } finally {
      setRechecking(false);
    }
  };

  if (about.isLoading) {
    return (
      <div className="max-w-3xl">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-4 h-32 w-full" />
      </div>
    );
  }

  const data = about.data;
  if (!data) return null;
  const latest = data.changelog[0];
  if (!latest) return null;

  return (
    <div className="max-w-3xl">
      {/* Hero */}
      <Card className="mb-5 overflow-hidden">
        <div className="relative px-6 py-8" style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--nd-accent) 8%, transparent), color-mix(in srgb, var(--nd-accent-bright) 4%, transparent))' }}>
          <div className="flex items-center gap-4">
            <div className="grid h-14 w-14 place-items-center rounded-2xl text-2xl font-bold text-white shadow-lg shadow-indigo-500/30"
              style={{ background: 'linear-gradient(135deg, var(--nd-accent), var(--nd-accent-strong))' }}>
              9
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">{data.name}</h1>
              <p className="text-sm text-slate-400">{data.description}</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Badge icon={<Package size={12} />} label={`v${data.version}`} tone="indigo" />
            <Badge icon={<Shield size={12} />} label={data.license} tone="emerald" />
            {update.data?.updateAvailable && update.data.latest && (
              <a
                href={update.data.notesUrl ?? update.data.latest}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-300 transition hover:bg-amber-500/25"
                title={`Upgrade to ${update.data.latest}`}
              >
                <Sparkles size={12} /> {update.data.latest} available
              </a>
            )}
            {data.stats && (
              <>
                <Badge icon={<GitBranch size={12} />} label={`${data.stats.services} services`} />
                <Badge icon={<Terminal size={12} />} label={`${data.stats.deployments} deploys`} />
                <Badge label={`${data.stats.databases} databases`} />
                <Badge label={`${data.stats.users} users`} />
                <Badge icon={<Layers size={12} />} label={`${(data.stats as any).plugins} plugins`} />
              </>
            )}
          </div>
        </div>
      </Card>

      {/* What's New */}
      <Card className="mb-5">
        <CardBody>
          <div className="mb-4 flex items-center gap-2">
            <Sparkles size={16} className="text-indigo-400" />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">What's New — v{latest.version}</h2>
            <span className="ml-auto text-xs text-slate-600">{latest.date}</span>
          </div>
          <p className="mb-3 text-sm font-medium text-slate-300">{latest.title}</p>
          <ul className="space-y-1.5">
            {latest.changes.map((change, i) => (
              <li key={`chg-${i}-${change.slice(0, 12)}`} className="flex items-start gap-2 text-sm text-slate-400">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-indigo-400" />
                {change}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      {/* Tech Stack */}
      <Card className="mb-5">
        <CardBody>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">Tech Stack</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {data.techStack.map((group) => (
              <div key={group.category} className="rounded-lg bg-white/[0.02] p-3">
                <div className="mb-1.5 text-xs font-medium text-indigo-300">{group.category}</div>
                {group.items.map((item) => (
                  <div key={item} className="text-xs text-slate-400">{item}</div>
                ))}
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      {/* Links */}
      <Card className="mb-5">
        <CardBody>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Links</h2>
          <div className="flex flex-wrap gap-2">
            <a href={data.repo} target="_blank" rel="noreferrer"
              className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-3 py-2 text-sm text-slate-300 transition hover:bg-white/[0.08]">
              <GitBranch size={15} /> GitHub
            </a>
            <a href={data.docs} target="_blank" rel="noreferrer"
              className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-3 py-2 text-sm text-slate-300 transition hover:bg-white/[0.08]">
              <ExternalLink size={15} /> Docs
            </a>
          </div>
        </CardBody>
      </Card>

      {/* Update info */}
      <Card>
        <CardBody>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Updates</h2>
          {update.isLoading ? (
            <Skeleton className="h-5 w-40" />
          ) : update.data ? (
            update.data.updateAvailable == null ? (
              <>
                <p className="mb-3 text-sm text-slate-400">
                  {update.data.reason === 'disabled'
                    ? 'Update checks are switched off on this instance (NINEDEPLOY_UPDATE_CHECK_URL=disabled).'
                    : `Update check unavailable (offline or disabled).${
                        update.data.detail ? ` Feed said: ${update.data.detail}` : ''
                      }`}
                </p>
                <Button size="sm" onClick={recheck} disabled={rechecking}>
                  <RefreshCw size={14} className={rechecking ? 'animate-spin' : undefined} /> Check again
                </Button>
              </>
            ) : (
              <p className="mb-3 text-sm text-slate-400">
                You're running <span className="font-mono font-medium text-indigo-300">v{update.data.current}</span>.{' '}
                {update.data.updateAvailable
                  ? <>A new release is out: <span className="font-mono font-medium text-amber-300">{update.data.latest}</span>.</>
                  : 'This is the latest release.'}
              </p>
            )
          ) : (
            <p className="mb-3 text-sm text-slate-400">
              You're running <span className="font-mono font-medium text-indigo-300">v{data.version}</span>.
            </p>
          )}
          {upd.ready && !upd.supported ? (
            upd.supportReason && <p className="mb-3 text-xs text-slate-500">{upd.supportReason}</p>
          ) : (
            <div className="mb-3 flex flex-wrap items-center gap-3">
              {update.data?.updateAvailable && update.data.latest && upd.available && (
                <Button size="sm" disabled={upd.starting || upd.phase === 'updating'} onClick={() => setConfirmOpen(true)}>
                  Update &amp; Restart
                </Button>
              )}
              <span className="text-xs text-slate-500">
                {upd.phase === 'updating'
                  ? 'Updating — the panel rebuilds and restarts itself; this page reconnects automatically.'
                  : upd.phase === 'done'
                    ? 'Update complete — every surface of the panel now runs the new release.'
                    : upd.phase === 'failed'
                      ? 'The last attempt failed mid-way; the previous release keeps running.'
                      : 'One click runs the installer for you: data snapshot, rebuild, migrations, restart.'}
              </span>
            </div>
          )}
          <p className="text-xs text-slate-500">To upgrade, re-run the installer (defaults to the latest release tag):</p>
          <pre className="mt-2 overflow-auto rounded-lg bg-black/30 p-3 font-mono text-xs text-slate-300 ring-1 ring-inset ring-white/5">
{`curl -fsSL https://raw.githubusercontent.com/NineDeploy/NineDeploy/main/install.sh | bash
# or, on an existing install:
./install.sh --version v0.7.2   # pin   |   --channel main   # edge`}
          </pre>
        </CardBody>
      </Card>

      {/* Footer */}
      <div className="mt-6 flex items-center justify-center gap-1.5 text-xs text-slate-600">
        Built with <Heart size={11} className="text-rose-500" /> using TypeScript, React, Fastify &amp; Docker
      </div>

      {/* Same confirmation as the layout banner's update button */}
      {upd.supported && (
        <ConfirmDialog
          open={confirmOpen}
          title={`Update NineDeploy to ${update.data?.latest ?? ''}`}
          confirmLabel="Update and Restart"
          onClose={() => setConfirmOpen(false)}
          onConfirm={() => {
            if (update.data?.latest) upd.startUpdating(update.data.latest);
          }}
          message={
            <div className="space-y-2">
              <p>
                This runs the official installer against this installation: snapshot the database, fetch{' '}
                <span className="font-mono font-medium">{update.data?.latest}</span>, clear build output, rebuild everything,
                run database migrations and restart the panel service.
              </p>
              <p className="text-slate-400">
                The panel goes down mid-way and comes back on the new release — plan for roughly 5–15 minutes of downtime,
                longer on slow mirrors. Deployed services keep running throughout.
              </p>
            </div>
          }
        />
      )}
    </div>
  );
}

function Badge({ icon, label, tone }: { icon?: React.ReactNode; label: string; tone?: 'indigo' | 'emerald' }) {
  const tones: Record<string, string> = {
    indigo: 'bg-indigo-500/15 text-indigo-300',
    emerald: 'bg-emerald-500/15 text-emerald-300',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${tone ? tones[tone] : 'bg-white/[0.06] text-slate-300'}`}>
      {icon} {label}
    </span>
  );
}
