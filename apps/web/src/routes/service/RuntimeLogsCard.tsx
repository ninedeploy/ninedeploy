import { useMutation, useQuery } from '@tanstack/react-query';
import { Bot, Download, Pause, Play, Search, Terminal, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { downloadBlob } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, Input, Select, Spinner } from '../../components/ui.js';

/** Line counts offered; the server caps a read at 5000 (RUNTIME_LOG_TAIL_MAX). */
const TAILS = [300, 1000, 5000] as const;

/**
 * Runtime logs of the running container: live (refreshed every 3 s, pausable),
 * searchable (case-insensitive, matching lines only, matches highlighted), and
 * downloadable as the lines loaded. Coolify and Dokploy offer the same.
 * 0.16.15: and, when the operator configured an AI provider, analyzed —
 * the newest lines go (sanitized) to the provider, which answers with the
 * service's health, the problems it sees and what to do.
 */
export function RuntimeLogsCard({ serviceId, slug }: { serviceId: number; slug: string }) {
  const [tail, setTail] = useState<number>(300);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState('');
  const logs = useQuery({
    queryKey: ['runtime-logs', serviceId, tail],
    queryFn: () => api.services.logs(serviceId, tail === 300 ? undefined : { tail }),
    refetchInterval: paused ? false : 3000,
  });

  const text = logs.data?.lines ?? '';
  const all = useMemo(() => (text ? text.split('\n') : []), [text]);
  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => (needle ? all.filter((l) => l.toLowerCase().includes(needle)) : all), [all, needle]);

  // Follow new output while the reader is at the bottom (48 px of slack).
  const pre = useRef<HTMLPreElement | null>(null);
  const follow = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the shown lines — scroll whenever they change.
  useEffect(() => {
    const el = pre.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const download = () => downloadBlob(text, `${slug}-runtime.log`, 'text/plain');

  const { toast } = useToast();
  const aiConfig = useQuery({ queryKey: ['ai-config'], queryFn: () => api.ai.getConfig(), staleTime: 60_000 });
  const [analysis, setAnalysis] = useState<{ text: string; model: string; lines: number } | null>(null);
  const analyze = useMutation({
    mutationFn: () => api.ai.analyzeLogs(serviceId, { tail }),
    onSuccess: (res) => setAnalysis({ text: res.analysis, model: res.model, lines: res.lines }),
    onError: (err: unknown) => toast(err instanceof Error ? err.message : 'Analysis failed', 'error'),
  });

  return (
    <Card className="mt-5">
      <CardBody>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Terminal size={15} className="text-slate-500" /> Runtime logs
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Search logs"
                className="h-8 w-48 pl-7 text-xs"
              />
            </div>
            <Select value={String(tail)} onChange={(e) => setTail(Number(e.target.value))} aria-label="Lines" className="h-8 text-xs">
              {TAILS.map((n) => (
                <option key={n} value={n}>
                  Last {n} lines
                </option>
              ))}
            </Select>
            <Button size="sm" variant="ghost" onClick={() => setPaused((p) => !p)} aria-label={paused ? 'Resume live logs' : 'Pause live logs'}>
              {paused ? <Play size={13} /> : <Pause size={13} />} {paused ? 'Resume' : 'Pause'}
            </Button>
            <Button size="sm" variant="secondary" onClick={download} disabled={!text} aria-label="Download logs">
              <Download size={13} /> Download
            </Button>
            {aiConfig.data?.configured && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => analyze.mutate()}
                disabled={!text || analyze.isPending}
                aria-label="Analyze logs with AI"
              >
                {analyze.isPending ? <Spinner className="h-3 w-3" /> : <Bot size={13} />} Analyze
              </Button>
            )}
          </div>
        </div>
        {analysis && (
          <div className="mb-3 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.06] p-3">
            <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-slate-400">
              <span className="flex items-center gap-1.5">
                <Bot size={13} className="text-indigo-300" /> AI analysis of the last {analysis.lines} lines · {analysis.model}
              </span>
              <button
                type="button"
                onClick={() => setAnalysis(null)}
                className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-slate-200"
                aria-label="Close the analysis"
              >
                <X size={12} />
              </button>
            </div>
            <div className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-slate-200">{analysis.text}</div>
          </div>
        )}
        <pre
          ref={pre}
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
          className="h-72 overflow-auto rounded-lg bg-black/40 p-3 font-mono text-xs leading-relaxed text-slate-300 ring-1 ring-inset ring-white/5"
        >
          {all.length === 0 ? 'No logs yet.' : shown.length === 0 ? 'No line matches.' : shown.map((line, i) => <LogLine key={i} line={line} needle={needle} eol={i < shown.length - 1} />)}
        </pre>
        <div className="mt-2 text-[11px] text-slate-600">
          {needle ? `${shown.length} of ${all.length} lines match` : `${all.length} lines`} · {paused ? 'paused' : 'live · refreshed every 3 s'}
        </div>
      </CardBody>
    </Card>
  );
}

/** One line, with every case-insensitive occurrence of `needle` marked; `eol` ends it with a newline. */
function LogLine({ line, needle, eol }: { line: string; needle: string; eol: boolean }) {
  const end = eol ? '\n' : '';
  if (!needle) return <>{line + end}</>;
  const parts: React.ReactNode[] = [];
  const lower = line.toLowerCase();
  let at = 0;
  for (let hit = lower.indexOf(needle); hit !== -1; hit = lower.indexOf(needle, at)) {
    parts.push(line.slice(at, hit));
    parts.push(
      <mark key={hit} className="rounded-sm bg-amber-400/30 text-amber-100">
        {line.slice(hit, hit + needle.length)}
      </mark>,
    );
    at = hit + needle.length;
  }
  parts.push(line.slice(at) + end);
  return <>{parts}</>;
}
