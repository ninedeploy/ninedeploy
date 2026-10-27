import { useMutation } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { LogSearchResult } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { Button, Card, CardBody, Input, Select, Spinner } from '../../components/ui.js';

/** Search windows offered, in minutes; the server allows up to 7 days. */
const WINDOWS = [
  { minutes: 15, label: 'Last 15 minutes' },
  { minutes: 60, label: 'Last hour' },
  { minutes: 360, label: 'Last 6 hours' },
  { minutes: 1440, label: 'Last 24 hours' },
  { minutes: 10080, label: 'Last 7 days' },
] as const;

const errorStatus = (err: unknown): number | undefined => (err as { status?: number } | null)?.status;

/**
 * G1.5: search this service's logs in the Loki log drain (G-16), which keeps
 * them after the container is gone. The route (`POST /v1/log-drains/search`)
 * and `ninedeploy logs search` existed; this is the first web control.
 */
export function ShippedLogSearchCard({ serviceId }: { serviceId: number }) {
  const [query, setQuery] = useState('');
  const [minutes, setMinutes] = useState<number>(60);
  const search = useMutation<LogSearchResult, Error, { query: string; sinceMinutes: number }>({
    mutationFn: (input) => api.logDrains.search({ ...input, serviceId, limit: 500 }),
  });

  const submit = () => {
    const q = query.trim();
    if (q) search.mutate({ query: q, sinceMinutes: minutes });
  };

  const result = search.data;
  const noDrain = search.isError && errorStatus(search.error) === 404;

  return (
    <Card className="mt-6 overflow-hidden">
      <div className="p-4 border-b border-white/[0.06]">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
          <Search size={14} /> Search shipped logs
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Searches the lines this service sent to a Loki log drain, including those of containers that no longer exist.
        </p>
      </div>
      <CardBody className="space-y-3">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Text to find, e.g. ERROR or a request id"
            aria-label="Log search text"
            maxLength={500}
            className="min-w-48 flex-1 font-mono text-xs"
          />
          <Select value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))} aria-label="Search window" className="w-40 text-xs">
            {WINDOWS.map((w) => (
              <option key={w.minutes} value={w.minutes}>
                {w.label}
              </option>
            ))}
          </Select>
          <Button type="submit" size="sm" disabled={!query.trim() || search.isPending}>
            {search.isPending ? <Spinner /> : <Search size={12} />} Search
          </Button>
        </form>

        {noDrain && (
          <p className="text-xs text-amber-300">
            No Loki log drain is enabled for this service. An operator can add one under{' '}
            <Link to="/settings?section=log-drains" className="text-indigo-300 hover:underline">
              Settings → Log Drains
            </Link>
            .
          </p>
        )}
        {search.isError && !noDrain && <p className="text-xs text-rose-400">{search.error.message}</p>}

        {result && (
          <>
            <p className="text-[11px] text-slate-500">
              {result.lines.length} line{result.lines.length === 1 ? '' : 's'} from drain “{result.drain.name}”
              {result.lines.length >= 500 ? ' (showing the first 500; narrow the search for more)' : ''}
            </p>
            {result.lines.length > 0 ? (
              <pre className="max-h-96 overflow-auto rounded-lg bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-slate-300" data-testid="shipped-log-lines">
                {result.lines.map((l) => `${new Date(l.ts).toISOString()}  ${l.line}`).join('\n')}
              </pre>
            ) : (
              <p className="text-xs text-slate-500">No matching lines in this window.</p>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
