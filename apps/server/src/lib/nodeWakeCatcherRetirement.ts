import { createHash } from 'node:crypto';
import { z } from 'zod';
import { load } from 'js-yaml';
import { capture } from './exec.js';
import { spawnValidated } from './spawnValidated.js';
import { confirmsMissingContainer } from './dockerContainerAbsence.js';
import { validNodeCatcherName } from './nodeCatcherIdentity.js';
import { nodeProxyJournalDirectory } from './nodeProxyFiles.js';
import { retireNodeProxyBackend } from './nodeProxyJournal.js';
import { assertNoWakeBackendReference } from './nodeWakeRetirementFence.js';
import { confirmProxyRouting, routingProbeArgs, withRoutingAck } from './proxyRoutingAck.js';

const id = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const name = z.string().max(50).refine(validNodeCatcherName);
export const wakeRetireParams = z.object({ requestId: z.string().length(32).regex(/^[a-f0-9]{32}$/), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  timeoutMs: z.number().int().min(1).max(30_000), content: z.string().refine(value => !value.includes('\0') && Buffer.byteLength(value) <= 1_048_576),
  target: z.object({ id, name }).strict() }).strict();
const identity = z.object({ id, name: z.string(), managed: z.string().nullable() }).strict();
const INSPECT = '{"id":{{json .Id}},"name":{{json .Name}},"managed":{{json (index .Config.Labels "ninedeploy.managed")}}}';

/** Only a loaded, ordered generation with no live reference may retire a managed immutable ID. */
export async function retireWakeCatcher(params: unknown) {
  const input = wakeRetireParams.parse(params);
  let encoded: string;
  try {
    const config = load(input.content) as { http?: unknown } | null;
    if (!config || typeof config !== 'object' || !config.http || typeof config.http !== 'object' || Array.isArray(config.http)) throw new Error();
    encoded = withRoutingAck(input.content);
  } catch { throw new Error('Wake retirement configuration is invalid'); }
  const inspect = async (reference: string, remaining: () => number, current: () => void) => {
    current(); const lines: string[] = []; let bytes = 0;
    const code = await spawnValidated('docker', ['inspect', '--type', 'container', '--format', INSPECT, reference], line => {
      bytes += Buffer.byteLength(line); if (bytes <= 8192) lines.push(line);
    }, { timeoutMs: Math.max(1, Math.min(5000, remaining())) });
    current();
    if (bytes > 8192) throw new Error('Wake retirement identity is unconfirmed');
    if (code !== 0) {
      if (confirmsMissingContainer(lines, reference)) return null;
      throw new Error('Wake retirement identity is unavailable');
    }
    if (lines.length !== 1) throw new Error('Wake retirement identity is unconfirmed');
    let value: z.infer<typeof identity>;
    try { value = identity.parse(JSON.parse(lines[0]!)); }
    catch { throw new Error('Wake retirement identity is unconfirmed'); }
    value.name = value.name.replace(/^\//, '');
    if (!validNodeCatcherName(value.name) || (reference.length === 64 ? value.id !== reference : value.name !== reference)) throw new Error('Wake retirement identity changed');
    return value;
  };
  const verifyIdentity = async (remaining: () => number, current: () => void) => {
    const found = await inspect(input.target.id, remaining, current);
    if (found && (found.name !== input.target.name || found.managed !== 'wake')) throw new Error('Wake retirement target is foreign or renamed');
    const named = await inspect(input.target.name, remaining, current);
    if (named && (named.id !== input.target.id || named.managed !== 'wake')) throw new Error('Wake retirement name is occupied by another container');
    return found;
  };
  const removed = await retireNodeProxyBackend(nodeProxyJournalDirectory(), input, input.target, async (remaining, current) => {
    await verifyIdentity(remaining, current);
    const confirm = async () => {
      current();
      await confirmProxyRouting(input.content, { signal: AbortSignal.timeout(Math.max(1, remaining())), read: async (budget, tls) => {
        current();
        const raw = await capture('docker', routingProbeArgs('ninedeploy-proxy', tls),
          { timeoutMs: Math.max(1, Math.min(3000, budget, remaining())), maxOutputBytes: 4 * 1024 * 1024 });
        current();
        let observed: unknown;
        try { observed = JSON.parse(raw.slice(raw.indexOf('{'))); }
        catch { throw new Error('Wake retirement proxy observation is unavailable'); }
        // Detect extra loaded definitions too, not only the requested generation's subset.
        assertNoWakeBackendReference(observed, new Set([input.target.name]));
        return raw;
      } });
      current();
    };
    await confirm();
    await new Promise(resolve => setTimeout(resolve, Math.min(2000, remaining())));
    current(); await confirm();
  }, async (remaining, current) => {
    const found = await verifyIdentity(remaining, current);
    if (!found) return false;
    const code = await spawnValidated('docker', ['rm', '-fv', found.id], () => undefined,
      { timeoutMs: Math.max(1, Math.min(10_000, remaining())) });
    current();
    if (code !== 0 || await inspect(found.id, remaining, current)) throw new Error('Wake catcher removal is unconfirmed');
    return true;
  });
  // Never include the config or an observation body in a reply.
  return { ...input.target, removed, fenced: true as const, revision: input.revision, requestId: input.requestId,
    contentHash: createHash('sha256').update(encoded).digest('hex') };
}
