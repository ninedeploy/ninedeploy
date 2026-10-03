import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, Sparkles, X } from 'lucide-react';
import { Button, ConfirmDialog } from './ui.js';
import { usePanelUpdate } from '../lib/usePanelUpdate.js';

/**
 * The one-click upgrade surface: an availability strip above every page plus
 * progress / result states that survive the panel restart an upgrade performs
 * (state lives server-side + localStorage, so a reload lands back here).
 * Rendered only for operators; see lib/usePanelUpdate.ts for the flow rules.
 */
export function UpdateBanner() {
  const upd = usePanelUpdate();
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!upd.ready || !upd.supported) {
    // Non-operators and installations without a self-update path (container
    // mode) never see the machinery — their upgrade story stays manual.
    return null;
  }

  const latest = upd.latestVersion;
  const target = upd.targetVersion;

  switch (upd.phase) {
    case 'updating':
      return (
        <div className={cnStrip('border-indigo-500/25 bg-indigo-500/[0.07] text-indigo-100')}>
          <Loader2 size={15} className="animate-spin shrink-0 text-indigo-300" />
          <span>
            NineDeploy is updating{target ? <> to <b className="font-semibold">{target}</b></> : null} — backing up data,
            rebuilding, migrating and restarting itself. Expect a few minutes of downtime; leaving this page is safe.
          </span>
        </div>
      );

    case 'done':
      return (
        <div className={cnStrip('border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-100')}>
          <CheckCircle2 size={15} className="shrink-0 text-emerald-300" />
          <span>NineDeploy was updated{target ? <> to <b className="font-semibold">{target}</b></> : null} and is healthy again.</span>
        </div>
      );

    case 'failed':
      return (
        <div className={cnStrip('border-rose-500/30 bg-rose-500/[0.08] text-rose-100')}>
          <AlertTriangle size={15} className="shrink-0 text-rose-300" />
          <span>The update{target ? <> to <b className="font-semibold">{target}</b></> : ''} did not complete — the previous release keeps running.</span>
          {upd.errorTail && (
            <details className="w-full">
              <summary className="cursor-pointer text-xs font-medium text-rose-300">Installer output tail</summary>
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-slate-300 ring-1 ring-inset ring-white/5">{upd.errorTail}</pre>
            </details>
          )}
          <p className="w-full text-xs text-rose-200/80">
            Re-run the installer over SSH to recover or retry manually:{' '}
            <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[11px]">cd ~ && ./install.sh</code>
          </p>
          <Button variant="ghost" size="sm" onClick={upd.clearFailure}>
            Dismiss
          </Button>
        </div>
      );

    case 'available':
      if (!latest || upd.dismissedByUser) return null;
      return (
        <>
          <div className={cnStrip('border-amber-500/30 bg-amber-500/[0.06] text-amber-100')}>
            <Sparkles size={15} className="shrink-0 text-amber-300" />
            <span>
              New release <b className="font-semibold">{latest}</b> is available
              {upd.currentVersion ? <> (running {upd.currentVersion})</> : null}.
            </span>
            {upd.notesUrl && (
              <a href={upd.notesUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-amber-300 underline-offset-2 hover:underline">
                Release notes <ExternalLink size={11} />
              </a>
            )}
            <Button size="sm" className="ml-auto" disabled={upd.starting} onClick={() => setConfirmOpen(true)}>
              Update &amp; Restart
            </Button>
            <button type="button"
              onClick={upd.dismissAvailable}
              className="rounded p-1 text-amber-300/70 transition hover:bg-white/5 hover:text-amber-200"
              title="Hide until a new release is published"
            >
              <X size={15} />
            </button>
          </div>

          <ConfirmDialog
            open={confirmOpen}
            title={`Update NineDeploy to ${latest}`}
            confirmLabel="Update and Restart"
            onClose={() => setConfirmOpen(false)}
            onConfirm={() => {
              if (latest) upd.startUpdating(latest);
            }}
            message={
              <div className="space-y-2">
                <p>
                  This runs the official installer against this installation: snapshot the database, fetch{' '}
                  <span className="font-mono font-medium">{latest}</span>, clear build output, rebuild everything, run database
                  migrations and restart the panel service.
                </p>
                <p className="text-slate-400">
                  The panel goes down mid-way and comes back on the new release — plan for roughly 5–15 minutes of downtime,
                  longer on slow mirrors. Deployed services keep running throughout.
                </p>
              </div>
            }
          />
        </>
      );

    default:
      return null;
  }
}

function cnStrip(extra: string): string {
  // Kept tiny for readability at each call site.
  return `nd-fade flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-5 py-2.5 text-sm ${extra}`;
}
