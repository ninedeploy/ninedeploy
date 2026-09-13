import type { Resources } from '@ninedeploy/schemas';
import { cn, Field, Input } from '../../../components/ui.js';

/** One-click memory caps — covers the sizes most small services use. */
const MEM_CHIPS = [256, 512, 1024, 2048] as const;
/** One-click CPU shares — 1024 ≈ 1 vCPU on Docker's weighted scheduler. */
const CPU_CHIPS = [256, 512, 1024, 2048] as const;

function ChipRow({
  label,
  options,
  current,
  nameFor,
  onPick,
}: {
  label: string;
  options: readonly number[];
  current: number | undefined;
  /** Accessible name per chip (the visible text is just the number). */
  nameFor: (n: number) => string;
  onPick: (n: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-slate-500">{label}</span>
      {options.map((n) => {
        const active = current === n;
        return (
          <button
            key={n}
            type="button"
            aria-label={nameFor(n)}
            aria-pressed={active}
            onClick={() => onPick(n)}
            className={cn(
              'rounded-md px-2 py-0.5 font-mono text-[11px] ring-1 ring-inset transition',
              active
                ? 'bg-indigo-500/15 text-indigo-200 ring-indigo-500/30'
                : 'bg-white/[0.03] text-slate-400 ring-white/[0.08] hover:bg-white/[0.06] hover:text-slate-200',
            )}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}

export function ResourcesSection({
  value,
  onChange,
}: {
  value: Resources | undefined;
  onChange: (next: Resources | undefined) => void;
}) {
  const patch = (next: Partial<Resources>) => {
    const merged = { ...(value ?? {}), ...next };
    // Both fields unset → drop the whole block so the YAML stays minimal.
    onChange(merged.cpuShares == null && merged.memMb == null ? undefined : merged);
  };
  return (
    <div className="space-y-4">
      <Field
        label="CPU shares"
        hint="0 = unlimited (default); 1024 ≈ 1 vCPU on Docker's weighted scheduler"
      >
        <div className="space-y-2">
          <Input
            type="number"
            min={0}
            max={262144}
            value={value?.cpuShares ?? ''}
            placeholder="1024"
            onChange={(e) => {
              const n = e.target.value ? Number.parseInt(e.target.value, 10) : undefined;
              patch({ cpuShares: Number.isFinite(n) ? n : undefined });
            }}
          />
          <ChipRow
            label="Quick pick:"
            options={CPU_CHIPS}
            current={value?.cpuShares}
            nameFor={(n) => `Set CPU shares to ${n}`}
            onPick={(cpuShares) => patch({ cpuShares })}
          />
        </div>
      </Field>
      <Field
        label="Memory (MiB)"
        hint="0 = unlimited; 512 MiB is a sensible default for a small Node service"
      >
        <div className="space-y-2">
          <Input
            type="number"
            min={0}
            max={1_048_576}
            value={value?.memMb ?? ''}
            placeholder="512"
            onChange={(e) => {
              const n = e.target.value ? Number.parseInt(e.target.value, 10) : undefined;
              patch({ memMb: Number.isFinite(n) ? n : undefined });
            }}
          />
          <ChipRow
            label="Quick pick:"
            options={MEM_CHIPS}
            current={value?.memMb}
            nameFor={(n) => `Set memory to ${n} MiB`}
            onPick={(memMb) => patch({ memMb })}
          />
        </div>
      </Field>
    </div>
  );
}
