import { Check, Copy } from 'lucide-react';
import { useCopy } from '../../lib/format.js';

/** One-time secret row (webhook payload URL / secret) with a copy button. */
export function SecretRow({ label, value }: { label: string; value: string }) {
  const { copied, copy } = useCopy();
  return (
    <div>
      <div className="mb-0.5 text-[10px] uppercase tracking-wide text-amber-200/60">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-black/40 px-2 py-1 font-mono text-[11px] text-amber-100">
          {value}
        </code>
        <button type="button" onClick={() => void copy(value)} className="shrink-0 text-amber-200/80 hover:text-amber-100">
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  );
}
