import { useEffect, useRef } from 'react';
import { ChevronRight, HelpCircle, Lightbulb, X } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { useHelp } from '../help/HelpContext.js';
import { HELP_TOPICS } from '../help/content.js';
import { helpKeyForLocation } from '../help/keys.js';
import type { HelpSection } from '../help/types.js';

/**
 * The header button that opens contextual help for the current page. Rendered
 * inside <HelpProvider> (see Layout).
 */
export function HelpButton() {
  const { openHelp } = useHelp();
  return (
    <button
      type="button"
      onClick={() => openHelp()}
      className="rounded-lg p-2 text-slate-500 transition hover:bg-white/[0.06] hover:text-slate-300"
      title="Help (?)"
      aria-label="Help"
    >
      <HelpCircle size={16} />
    </button>
  );
}

/**
 * Right-side help drawer. Always mounted inside the layout; renders nothing
 * while closed. Owns the global "?" / F1 hotkey, Escape-to-close, body scroll
 * lock and the per-page topic resolution.
 */
export function HelpDrawer() {
  const { open, topicId, openHelp, closeHelp } = useHelp();
  const location = useLocation();
  const closeRef = useRef<HTMLButtonElement>(null);

  // The explicitly requested topic wins; otherwise follow the current page.
  const resolvedId = topicId ?? helpKeyForLocation(location.pathname, location.search);
  const topic = HELP_TOPICS[resolvedId] ?? HELP_TOPICS['general']!;

  // "?" / F1 toggles the drawer from anywhere, except while typing.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== '?' && e.key !== 'F1') return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      e.preventDefault();
      if (open) closeHelp();
      else openHelp();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, openHelp, closeHelp]);

  // While open: lock body scroll, focus the close button, Escape closes.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeHelp();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, closeHelp]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close help panel"
        tabIndex={-1}
        aria-hidden="true"
        onClick={closeHelp}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Help"
        className="nd-fade relative flex h-full w-96 max-w-[92vw] flex-col border-l border-white/10 bg-slate-950 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <HelpCircle size={15} className="text-indigo-400" /> Help
          </h2>
          <button
            type="button"
            ref={closeRef}
            onClick={closeHelp}
            aria-label="Close help panel"
            className="rounded-lg p-1 text-slate-500 hover:bg-white/5 hover:text-slate-300"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          <h3 className="text-[15px] font-semibold text-slate-100">{topic.title}</h3>
          <p className="mt-1.5 text-[13px] leading-relaxed text-slate-400">{topic.summary}</p>

          <div className="mt-5 space-y-6">
            {topic.sections.map((section) => (
              <HelpSectionView key={section.heading} section={section} />
            ))}
          </div>

          {topic.related && topic.related.length > 0 && (
            <section className="mt-7">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Related</h4>
              <ul className="mt-2 space-y-1">
                {topic.related.map((link) => (
                  <li key={link.helpId}>
                    <button
                      type="button"
                      onClick={() => openHelp(link.helpId)}
                      className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[13px] text-indigo-300 transition hover:bg-white/[0.05] hover:text-indigo-200"
                    >
                      {link.label}
                      <ChevronRight size={13} className="shrink-0 text-slate-600" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="border-t border-white/5 p-3">
          <Link
            to="/about"
            onClick={closeHelp}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-white/[0.04] py-2 text-xs font-medium text-slate-300 transition hover:bg-white/[0.08] hover:text-white"
          >
            <span>Version, changelog & full docs</span>
          </Link>
        </div>
      </div>
    </div>
  );
}

function HelpSectionView({ section }: { section: HelpSection }) {
  return (
    <section>
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-indigo-300">{section.heading}</h4>
      {section.body?.map((paragraph) => (
        <p key={paragraph} className="mt-2 text-[13px] leading-relaxed text-slate-300">
          {paragraph}
        </p>
      ))}
      {section.steps && (
        <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-[13px] leading-relaxed text-slate-300">
          {section.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      {section.bullets && (
        <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[13px] leading-relaxed text-slate-300">
          {section.bullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      )}
      {section.tip && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.07] px-3 py-2">
          <Lightbulb size={13} className="mt-0.5 shrink-0 text-amber-300" />
          <p className="text-xs leading-relaxed text-amber-200/90">{section.tip}</p>
        </div>
      )}
    </section>
  );
}
