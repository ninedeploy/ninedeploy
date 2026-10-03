import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Loader2, Rocket } from 'lucide-react';
import { api } from '../lib/api.js';

/**
 * Top-bar badge that mirrors the in-flight deploy count.
 *
 * Reads the same `GET /v1/services/queue` endpoint the /deploys page uses
 * (3-second poll) so the two stay in lockstep — when the user clicks the
 * badge to drill in, the table is already populated. Hidden entirely when
 * the queue is empty so a quiet instance does not carry a stray "0" in the
 * top bar.
 */
export function DeployQueueBadge() {
  const queue = useQuery({
    queryKey: ['deploys-queue-badge'],
    queryFn: () => api.deploys.queue(),
    refetchInterval: 3_000,
  });

  const data = queue.data;
  if (!data || data.count === 0) return null;

  const { building, deploying, queued } = data.byStatus;
  const live = building + deploying;
  const label =
    live > 0
      ? `${live} live${queued > 0 ? ` · ${queued} queued` : ''}`
      : `${queued} queued`;

  // The tone follows the most-urgent state in the queue: a live build
  // is the loudest signal, a queued line is the next one to watch.
  const tone =
    live > 0
      ? 'bg-amber-500/15 text-amber-300 ring-amber-500/20 hover:bg-amber-500/25'
      : 'bg-white/[0.06] text-slate-300 ring-white/10 hover:bg-white/[0.12]';

  return (
    <Link
      to="/deploys"
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ring-1 ring-inset transition ${tone}`}
      title={`${building} building · ${deploying} deploying · ${queued} queued`}
    >
      {live > 0 ? <Loader2 size={12} className="animate-spin" /> : <Rocket size={12} />}
      <span>{label}</span>
    </Link>
  );
}
