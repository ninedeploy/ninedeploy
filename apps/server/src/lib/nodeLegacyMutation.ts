import { z } from 'zod';
import { assertLegacyNodeMutationAllowed, withNodeServiceJournal } from './nodeLifecycle.js';
import { spawnValidated } from './spawnValidated.js';
const identity = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().min(1).max(129).regex(/^\/?[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  managed: z.string().nullable(), serviceId: z.string().nullable(), deploymentId: z.string().nullable(), composeProject: z.string().nullable().optional() });
export type LegacyNodeTarget = z.infer<typeof identity>;
const FORMAT = '{"id":{{json .Id}},"name":{{json .Name}},"managed":{{json (index .Config.Labels "ninedeploy.managed")}},"serviceId":{{json (index .Config.Labels "ninedeploy.service")}},"deploymentId":{{json (index .Config.Labels "ninedeploy.deployment")}},"composeProject":{{json (index .Config.Labels "com.docker.compose.project")}}}';

/** Inspect by name once, then mutate only the captured ID under its service authority. */
export async function guardLegacyNodeTarget<T>(root: string, reference: string,
  operation: (target: LegacyNodeTarget | null, remaining: () => number, current: () => void) => Promise<T>, timeoutMs = 595_000): Promise<T> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(reference) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 595_000) throw new Error('Invalid legacy mutation operands');
  const deadline = performance.now() + timeoutMs;
  const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
  const current = () => { if (!remaining()) throw new Error('Legacy mutation deadline exceeded'); };
  const inspect = async (ref: string): Promise<LegacyNodeTarget | null> => {
    current(); const lines: string[] = []; let bytes = 0;
    const code = await spawnValidated('docker', ['inspect', '--type', 'container', '--format', FORMAT, ref], line => {
      bytes += Buffer.byteLength(line); if (bytes <= 16_384) lines.push(line);
    }, { timeoutMs: Math.min(10_000, remaining()) });
    current();
    if (bytes > 16_384) throw new Error('Legacy mutation identity unavailable');
    if (code !== 0) {
      if (lines.length && lines.every(line => /No such (object|container)/i.test(line))) return null;
      throw new Error('Legacy mutation identity unavailable');
    }
    if (lines.length !== 1) throw new Error('Legacy mutation identity unavailable');
    const row = identity.parse(JSON.parse(lines[0]!)); row.name = row.name.replace(/^\//, '');
    if (/^[a-f0-9]{64}$/.test(ref) ? row.id !== ref : row.name !== ref) throw new Error('Legacy mutation identity changed');
    return row;
  };
  const captured = await inspect(reference);
  if (!captured || captured.managed !== 'service' || typeof captured.composeProject === 'string' && /^ndcmp-[A-Za-z0-9_.-]+$/.test(captured.composeProject)) {
    const result = await operation(captured, remaining, current); current(); return result;
  }
  if (captured.serviceId === null || !/^[1-9]\d*$/.test(captured.serviceId) || !Number.isSafeInteger(Number(captured.serviceId))) throw new Error('Legacy service ownership is unconfirmed');
  return withNodeServiceJournal(root, Number(captured.serviceId), remaining(), journal => journal.write(async () => {
    assertLegacyNodeMutationAllowed(journal.database);
    const fresh = await inspect(captured.id);
    if (fresh && ['id', 'name', 'managed', 'serviceId', 'deploymentId', 'composeProject'].some(key => fresh[key as keyof LegacyNodeTarget] !== captured[key as keyof LegacyNodeTarget])) throw new Error('Legacy mutation identity changed');
    return operation(fresh, () => Math.min(remaining(), journal.remaining()), () => { current(); journal.current(); });
  }));
}
