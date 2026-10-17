import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CornerDownRight, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { redirectRegexProblem } from '@ninedeploy/schemas';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Button, Input } from '../../components/ui.js';

export interface RedirectRow {
  regex: string;
  replacement: string;
  permanent: boolean;
}

/** Traefik's first-capture placeholder, spelled so it is not read as a template string. */
const CAPTURE_1 = '\u0024{1}';
const MAX_RULES = 10;

const escapeHost = (host: string) => host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Why a row cannot be saved, or null (the server checks the same). */
export function redirectRowProblem(r: RedirectRow): string | null {
  if (!r.regex.trim()) return 'The pattern is empty.';
  if (!r.replacement.trim()) return 'The target is empty.';
  return redirectRegexProblem(r.regex);
}

/**
 * 0.16.1 redirect rules of one domain (Dokploy's "Redirects"): regex over the
 * full URL → target, temporary or permanent, applied before the domain's
 * other middlewares. Rendered only on a panel that reports `redirects`.
 */
export function DomainRedirects({
  serviceId,
  domain,
}: {
  serviceId: number;
  domain: { id: number; hostname: string; ssl: boolean; redirects: RedirectRow[] };
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [rows, setRows] = useState<RedirectRow[]>(domain.redirects.map((r) => ({ ...r, permanent: r.permanent === true })));
  const scheme = domain.ssl ? 'https' : 'http';
  const host = domain.hostname.replace(/^\*\./, '');
  const problems = rows.map(redirectRowProblem);

  const save = useMutation({
    mutationFn: () => api.domains.update(serviceId, domain.id, { redirects: rows }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['domains', serviceId] });
      toast(rows.length > 0 ? `${rows.length} redirect rule${rows.length === 1 ? '' : 's'} saved` : 'Redirect rules removed', 'success');
    },
    onError: (err: Error) => toast(err.message || 'Could not save the redirect rules', 'error'),
  });

  const update = (i: number, patch: Partial<RedirectRow>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium text-slate-400">
          <CornerDownRight size={12} /> Redirects
        </span>
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={rows.length >= MAX_RULES}
            onClick={() =>
              setRows((prev) => [
                ...prev,
                { regex: `^https?://${escapeHost(host)}/old/(.*)`, replacement: `${scheme}://${host}/new/${CAPTURE_1}`, permanent: true },
              ])
            }
          >
            <Plus size={12} /> Moved path
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={rows.length >= MAX_RULES}
            onClick={() => setRows((prev) => [...prev, { regex: '', replacement: '', permanent: false }])}
          >
            <Plus size={12} /> Rule
          </Button>
        </div>
      </div>
      <p className="text-[11px] text-slate-600">
        The pattern is a regular expression over the full URL (Go RE2: no lookahead or backreferences); {CAPTURE_1} in the
        target inserts the first group. Rules run in order, before auth and headers. Make sure a target does not match its own
        pattern, or browsers loop.
      </p>
      {rows.length === 0 ? (
        <p className="text-[11px] text-slate-500">No redirect rules.</p>
      ) : (
        rows.map((r, i) => (
          <div key={i} className="space-y-1">
            <div className="flex items-center gap-1.5">
              <Input
                value={r.regex}
                onChange={(e) => update(i, { regex: e.target.value })}
                placeholder={`^https?://${host}/old/(.*)`}
                aria-label={`Redirect ${i + 1} pattern`}
                className="h-8 min-w-0 flex-1 font-mono text-[11px]"
              />
              <span className="text-slate-600">→</span>
              <Input
                value={r.replacement}
                onChange={(e) => update(i, { replacement: e.target.value })}
                placeholder={`${scheme}://${host}/new/${CAPTURE_1}`}
                aria-label={`Redirect ${i + 1} target`}
                className="h-8 min-w-0 flex-1 font-mono text-[11px]"
              />
              <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-slate-400" title="301/308 instead of 302/307">
                <input
                  type="checkbox"
                  checked={r.permanent}
                  onChange={(e) => update(i, { permanent: e.target.checked })}
                  className="accent-indigo-500"
                  aria-label={`Redirect ${i + 1} permanent`}
                />
                permanent
              </label>
              <button
                type="button"
                onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                className="shrink-0 text-slate-600 transition hover:text-rose-400"
                aria-label={`Remove redirect ${i + 1}`}
              >
                <Trash2 size={13} />
              </button>
            </div>
            {problems[i] && <p className="text-[11px] text-rose-300/90">{problems[i]}</p>}
          </div>
        ))
      )}
      <div className="flex justify-end">
        <Button size="sm" variant="secondary" onClick={() => save.mutate()} disabled={save.isPending || problems.some(Boolean)}>
          Save redirects
        </Button>
      </div>
    </div>
  );
}
