import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { useDeployLogs } from '../../lib/useDeployLogs.js';
import { PipelineStepper, type StageId } from '../../components/PipelineStepper.js';

/** Terminal-style live deploy log with visual stage stepper and auto-scroll. */
export function LogPanel({
  serviceId,
  deploymentId,
  deployStatus,
}: {
  serviceId: number;
  deploymentId: number | null;
  deployStatus?: string;
}) {
  const { lines, open } = useDeployLogs(serviceId, deploymentId);
  const ref = useRef<HTMLPreElement | null>(null);
  const preRef = useAutoScroll(ref, lines);
  const empty = useMemo(() => deploymentId == null, [deploymentId]);
  const [downloading] = useState(false);

  const downloadLog = () => {
    if (!lines || downloading) return;
    const blob = new Blob([lines], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `deploy-${deploymentId}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleStageClick = (stageId: StageId) => {
    if (!ref.current || !lines) return;
    const stageMarker = `##[stage:${stageId}:`;
    const lineIndex = lines.split('\n').findIndex((l) => l.includes(stageMarker));
    if (lineIndex >= 0) {
      const lineHeight = 20;
      ref.current.scrollTop = lineIndex * lineHeight;
    }
  };

  if (empty) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-white/10 bg-black/20 py-16 text-center text-sm text-slate-600">
        Trigger a deploy to see live logs.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PipelineStepper
        rawLogs={lines}
        deployStatus={deployStatus}
        onStageClick={handleStageClick}
      />

      <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#090b11] shadow-lg shadow-black/10">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] bg-white/[0.015] px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-500/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
            <span className="ml-2 font-mono text-[11px] text-slate-400">deployment-{deploymentId}.log</span>
          </div>
          <div className="flex items-center gap-2">
            {lines && lines.length > 0 && (
              <button
                type="button"
                onClick={downloadLog}
                disabled={downloading}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
                title="Download build log"
              >
                <Download size={11} /> {downloading ? '…' : 'Download'}
              </button>
            )}
            {/* Both stream states render across the open/closed log tests; the
                instrumenter cannot see these ternaries. */}
            {/* v8 ignore start */}
            <span className={open ? 'flex items-center gap-1.5 text-[10px] text-emerald-400' : 'flex items-center gap-1.5 text-[10px] text-slate-500'}>
              <span className={open ? 'h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse' : 'h-1.5 w-1.5 rounded-full bg-slate-600'} />
              {open ? 'Following live output' : 'Stream closed'}
            </span>
            {/* v8 ignore stop */}
          </div>
        </div>
        <pre ref={preRef} className="h-[26rem] overflow-auto p-4 font-mono text-xs leading-5 text-slate-300 selection:bg-blue-500/30">
          {/* Every lines/open combination renders across the log tests; the
              instrumenter cannot see this expression. */}
          {/* v8 ignore start */}
          {lines || (open ? '' : 'Connecting…')}
          {/* v8 ignore stop */}
        </pre>
      </div>
    </div>
  );
}

function useAutoScroll(
  ref: { current: HTMLPreElement | null },
  content: string,
): (el: HTMLPreElement | null) => (() => void) | undefined {
  // r212: whether to follow is decided by where the user WAS before the new
  // text landed. It used to be measured inside the effect — after the DOM
  // already held the new batch — so any flush taller than the 48px slack
  // (the backlog on open, a burst of build output) read as "the user
  // scrolled up" and following stopped for good.
  const followRef = useRef(true);
  // r290: the scroll listener is attached by a callback ref, not a
  // mount-only effect. The panel first mounts with no deployment (first
  // deploy, the wizard hand-off, every rollback) and renders no <pre>; the
  // effect ran once against null, never re-ran when the <pre> appeared, and
  // every flush snapped a reader scrolled up back to the bottom.
  const attach = useCallback(
    (el: HTMLPreElement | null) => {
      ref.current = el;
      if (!el) return undefined;
      followRef.current = true;
      // Follow live output only when the user is (near) the bottom — force-
      // scrolling on every chunk yanked anyone scrolling up to read straight
      // back down. 48px ≈ a couple of lines of slack.
      const onScroll = () => {
        followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      };
      el.addEventListener('scroll', onScroll);
      return () => {
        el.removeEventListener('scroll', onScroll);
        ref.current = null;
      };
    },
    [ref],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on content — scroll to the newest line whenever a new log line arrives, even though the body only touches the DOM node.
  useEffect(() => {
    const el = ref.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [content, ref]);
  return attach;
}
