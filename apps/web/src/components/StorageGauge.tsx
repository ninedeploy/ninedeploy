import { useQuery } from '@tanstack/react-query';
import { HardDrive } from 'lucide-react';
import { api } from '../lib/api.js';
import { Skeleton, cn } from './ui.js';

const CAP_MB = 512; // visual reference for the bar fill

function fmt(bytes: number): string {
  if (!bytes) return '0 MB';
  const mb = bytes / 1024 ** 2;
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

export function StorageGauge({ databaseId }: { databaseId: number }) {
  const q = useQuery({
    queryKey: ['storage', databaseId],
    queryFn: () => api.backups.storage(databaseId),
    refetchInterval: 15000,
  });
  const bytes = q.data?.sizeBytes ?? 0;
  const pct = Math.max(4, Math.min(100, (bytes / 1024 ** 2 / CAP_MB) * 100));

  return (
    <div>
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-500">
        <span className="flex items-center gap-1">
          <HardDrive size={11} /> Volume
        </span>
        <span className="font-medium text-slate-300">{q.isLoading ? '…' : fmt(bytes)}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/5">
        {q.isLoading ? (
          <Skeleton className="h-full w-1/3" />
        ) : (
          <div
            className={cn('h-full rounded-full transition-all', bytes > 256 * 1024 ** 2 ? 'bg-amber-500' : 'bg-emerald-500')}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}
