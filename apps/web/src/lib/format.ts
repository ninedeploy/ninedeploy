import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The single source of truth for human-readable formatting in the web UI.
 * Replaces the four per-route formatters (ServiceDetail, Backups, Volumes,
 * Settings/Monitoring) that disagreed on KB vs KiB and locale.
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * Numeric form-field parsing: `Number('abc')` is NaN, and JSON.stringify
 * silently turns NaN into null — a garbage field must become undefined (or
 * the given fallback), never null/NaN shipped to the API.
 */
export function toInt(raw: string | undefined | null, fallback?: number): number | undefined {
  if (raw === undefined || raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Decimal (1000-based) byte formatting, 1 decimal for KB+, 0 for bytes. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let v = bytes;
  let unit = 0;
  while (v >= 1000 && unit < BYTE_UNITS.length - 1) {
    v /= 1000;
    unit++;
  }
  return unit === 0 ? `${Math.round(v)} B` : `${v.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/**
 * Fixed-locale timestamp for tables/detail pages. A pinned locale keeps the
 * UI deterministic across browsers instead of following the visitor's OS.
 */
export function formatDateTime(iso: string | number | Date): string {
  return new Date(iso).toLocaleString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Compact relative time ("just now", "5m ago", "3h ago", "2d ago"). */
export function formatRelative(iso: string | number | Date): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/** Duration in seconds → "1m 23s" / "45s" / "2h 04m". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Copy-to-clipboard with transient "copied" state; feedback via the caller's
 * toast or the hook state.
 *
 * `navigator.clipboard` exists only in secure contexts — the panel is
 * routinely reached over plain http://<server-ip>:<port> (see the Security
 * settings note), where every Copy button silently did nothing, including on
 * once-only secrets (webhook tokens, enrolment commands) whose reveal
 * disappears on dismiss. Fall back to the legacy execCommand path there.
 */
function copyViaExecCommand(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  // Keep it off-screen and unfocusable so the page never scrolls to it.
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-9999px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

/** One-shot copy usable outside React (Hub cards, wizards): the
 *  Clipboard API when present (secure contexts), with a legacy execCommand
 *  fallback for plain-http panels where `navigator.clipboard` is undefined
 *  or refuses to write. */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard) {
    const ok = await navigator.clipboard.writeText(text).then(() => true, () => false);
    if (ok) return true;
  }
  return copyViaExecCommand(text);
}

export function useCopy(timeoutMs = 1500): { copied: boolean; copy: (text: string) => Promise<boolean> } {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    if (resetTimer.current !== undefined) clearTimeout(resetTimer.current);
  }, []);
  const copy = useCallback(
    async (text: string) => {
      const ok = await copyText(text);
      if (ok) {
        if (resetTimer.current !== undefined) clearTimeout(resetTimer.current);
        setCopied(true);
        resetTimer.current = setTimeout(() => {
          setCopied(false);
          resetTimer.current = undefined;
        }, timeoutMs);
      }
      return ok;
    },
    [timeoutMs],
  );
  return { copied, copy };
}

/** Trigger a browser download for generated content (exports, backups manifest). */
export function downloadBlob(data: BlobPart, filename: string, type = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking synchronously can cancel the download in some browsers (Safari
  // commits asynchronously) — give the download a beat before freeing.
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
