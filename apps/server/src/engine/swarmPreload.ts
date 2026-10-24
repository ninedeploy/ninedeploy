import { capture } from '../lib/exec.js';
import { swarmPreloadLabel } from '../lib/swarm.js';

// Fixed slots keep node metadata bounded. Never overwrite a slot referenced
// by any service's current or rollback spec: changing that label evicts tasks.
export const SWARM_PRELOAD_SLOTS = 3;
export const SWARM_PLACEMENT_FORMAT = '{"current":{{if .Spec.TaskTemplate.Placement}}{{json .Spec.TaskTemplate.Placement.Constraints}}{{else}}null{{end}},"previous":{{if .PreviousSpec}}{{if .PreviousSpec.TaskTemplate.Placement}}{{json .PreviousSpec.TaskTemplate.Placement.Constraints}}{{else}}null{{end}}{{else}}null{{end}}}';

export async function unusedSwarmPreloadLabel(slug: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw new Error('Invalid Swarm preload service');
  const slots = Array.from({ length: SWARM_PRELOAD_SLOTS }, (_, i) => `${swarmPreloadLabel(slug)}.g${i}`);
  const used = new Set<string>();
  const raw = await capture('docker', ['service', 'ls', '--quiet'], { timeoutMs: 30_000 });
  // service ls emits 12-character IDs; inspect rejects ambiguous prefixes.
  const ids = raw.trim() ? raw.trim().split(/\s+/) : [];
  if (ids.length > 4096 || ids.some(id => !/^(?:[a-z0-9]{12}|[a-z0-9]{25})$/.test(id))) throw new Error('Swarm placement inventory is unconfirmed; preload labels unchanged');
  // Bounded argv on Windows, and bounded metadata reads on large managers.
  for (let i = 0; i < ids.length; i += 64) {
    const batch = ids.slice(i, i + 64);
    const output = await capture('docker', ['service', 'inspect', '--format', SWARM_PLACEMENT_FORMAT, ...batch], { timeoutMs: 30_000 });
    const lines = output.trim().split('\n').filter(line => line.trim());
    if (lines.length !== batch.length) throw new Error('Swarm placement inventory changed; preload labels unchanged');
    for (const line of lines) {
      let value: { current: unknown; previous: unknown };
      try { value = JSON.parse(line); } catch { throw new Error('Swarm placement inventory is unreadable; preload labels unchanged'); }
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'current') || !Object.hasOwn(value, 'previous')) throw new Error('Swarm placement inventory is incomplete; preload labels unchanged');
      for (const refs of [value.current, value.previous]) {
        if (refs == null) continue;
        if (!Array.isArray(refs) || refs.some(ref => typeof ref !== 'string')) throw new Error('Swarm placement constraints are unreadable; preload labels unchanged');
        for (const ref of refs as string[]) {
          const key = /^\s*node\.labels\.([^\s!=]+)\s*(?:==|!=)/iu.exec(ref)?.[1];
          if (key && slots.includes(key)) used.add(key);
        }
      }
    }
  }
  const free = slots.find(slot => !used.has(slot));
  if (!free) throw new Error('All Swarm preload slots are referenced by current or rollback specs; keep existing tasks and review placement');
  return free;
}
