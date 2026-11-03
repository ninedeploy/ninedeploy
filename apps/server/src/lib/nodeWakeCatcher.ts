import { createHash } from 'node:crypto';
import { z } from 'zod';
import { capture } from './exec.js';
import { HttpError } from './errors.js';
import { WAKE_DEMAND_PREFIX, WAKE_KEY_PATTERN } from '../wakeCatcher.js';
import { createKeyedOperationGuard } from './keyedOperationGuard.js';

/**
 * R2 node scale to zero (docs/NODE_SLEEP_WAKE.md), agent side: the legacy `ninedeploy-wake`
 * container and separately prepared generations. They run the agent's own immutable image
 * (no pull, nothing caller-chosen) on the
 * node proxy's network, read-only, unprivileged, without mounts or a published port. A
 * same-name container this agent did not label is never touched. Preparation never removes
 * an existing backend and does not grant permission to promote or retire it.
 */
export const WAKE_CATCHER_NAME = 'ninedeploy-wake';
export const WAKE_CATCHER_LABEL = 'wake';
const AGENT_CONTAINER = 'ninedeploy-agent';
const PROXY_NETWORK = 'ninedeploy';
const SCRIPT = '/app/apps/server/dist/wakeCatcher.js';
const IMAGE_VOLUME = '/data';
const DEMAND_TAIL = 2000;
const withCatcher = createKeyedOperationGuard<string>();

export const wakeDemandParams = z.object({ sinceMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
/** The panel's per-node wake key; the Traefik middleware sends it, the catcher checks it. */
export const wakeEnsureParams = z.object({ key: z.string().regex(WAKE_KEY_PATTERN) }).strict();
const keyLabel = (key: string) => createHash('sha256').update(`ninedeploy-wake:${key}`).digest('hex');

type Inspected = { id: string; image: string; running: boolean; managed: string; startedAt: string; keyHash: string };
async function inspect(name: string): Promise<Inspected | null> {
  const out = await capture('docker', ['inspect', name, '--format',
    '{{.Id}}|{{.Image}}|{{.State.Running}}|{{index .Config.Labels "ninedeploy.managed"}}|{{.State.StartedAt}}|{{index .Config.Labels "ninedeploy.wake.key"}}'], { timeoutMs: 15_000 }).catch(() => null);
  if (out === null) return null;
  const [id, image, running, managed, startedAt, keyHash] = out.trim().split('|');
  if (!/^[a-f0-9]{64}$/.test(id ?? '') || !/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw new HttpError(502, 'wake_catcher_unconfirmed', 'The container identity could not be read');
  return { id: id!, image: image!, running: running === 'true', managed: managed ?? '', startedAt: startedAt ?? '', keyHash: keyHash ?? '' };
}

/** The agent's own image: the catcher never runs anything else. */
async function agentImage(): Promise<string> {
  const self = await inspect(AGENT_CONTAINER);
  if (!self) throw new HttpError(409, 'wake_catcher_unsupported', 'The wake catcher needs the agent to run as the ninedeploy-agent container');
  return self.image;
}

function foreign(name = WAKE_CATCHER_NAME): never {
  throw new HttpError(409, 'wake_catcher_conflict', `A container named ${name} exists that this agent did not create; remove or rename it`);
}

export const wakeCatcherRunArgs = (image: string, key: string, name = WAKE_CATCHER_NAME): string[] => ['run', '-d', '--name', name,
  '--label', `ninedeploy.managed=${WAKE_CATCHER_LABEL}`, '--label', `ninedeploy.wake.key=${keyLabel(key)}`, '-e', `ND_WAKE_KEY=${key}`,
  // The image probes the panel/agent port; the catcher is proved separately on 8080.
  '--network', PROXY_NETWORK, '--restart', 'unless-stopped', '--no-healthcheck',
  '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534',
  '--memory', '64m', '--pids-limit', '64', '--log-driver', 'json-file', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2',
  // The image declares VOLUME /data; without this Docker would attach a writable anonymous volume.
  '--mount', `type=tmpfs,destination=${IMAGE_VOLUME},tmpfs-size=65536,tmpfs-mode=0555`,
  '--entrypoint', 'node', image, SCRIPT];

/** Create or keep the catcher; a stale image, a changed key or a stopped catcher is recreated. */
async function ensureWakeCatcherUnlocked(key: string): Promise<{ id: string; image: string; created: boolean }> {
  const image = await agentImage(), found = await inspect(WAKE_CATCHER_NAME);
  if (found && found.managed !== WAKE_CATCHER_LABEL) foreign();
  if (found?.running && found.image === image && found.keyHash === keyLabel(key)) return { id: found.id, image, created: false };
  if (found) await capture('docker', ['rm', '-fv', found.id], { timeoutMs: 30_000 });
  await capture('docker', wakeCatcherRunArgs(image, key), { timeoutMs: 60_000 });
  const created = await inspect(WAKE_CATCHER_NAME);
  if (!created?.running || created.image !== image || created.managed !== WAKE_CATCHER_LABEL || created.keyHash !== keyLabel(key)) {
    throw new HttpError(502, 'wake_catcher_unconfirmed', 'The wake catcher did not start');
  }
  return { id: created.id, image, created: true };
}

export async function ensureWakeCatcher(params: unknown): Promise<{ id: string; image: string; created: boolean }> {
  const { key } = wakeEnsureParams.parse(params);
  return withCatcher('wake', () => ensureWakeCatcherUnlocked(key));
}

/** Prepare a replacement without withdrawing the backend already used by Traefik. */
export async function prepareWakeCatcher(params: unknown) {
  const { key } = wakeEnsureParams.parse(params);
  return withCatcher('wake', async () => {
    const image = await agentImage();
    // Retry the same generation after lost replies. Neither its image nor its name is caller-chosen.
    const fingerprint = createHash('sha256').update(JSON.stringify([image, keyLabel(key)])).digest('hex').slice(0, 32);
    const name = `${WAKE_CATCHER_NAME}-g-${fingerprint}`, found = await inspect(name);
    if (found && found.managed !== WAKE_CATCHER_LABEL) foreign(name);
    if (found && (found.image !== image || found.keyHash !== keyLabel(key))) {
      throw new HttpError(409, 'wake_catcher_conflict', 'The prepared catcher generation has an unexpected image or credential');
    }
    if (found?.running) return { id: found.id, name, image, created: false };
    // A stopped candidate may already be referenced by a recovered route. Never remove it.
    if (found) await capture('docker', ['start', found.id], { timeoutMs: 30_000 });
    else await capture('docker', wakeCatcherRunArgs(image, key, name), { timeoutMs: 60_000 });
    const candidate = await inspect(name);
    if (!candidate?.running || candidate.image !== image || candidate.managed !== WAKE_CATCHER_LABEL || candidate.keyHash !== keyLabel(key) ||
      found && candidate.id !== found.id) throw new HttpError(502, 'wake_catcher_unconfirmed', 'The prepared wake catcher did not start');
    return { id: candidate.id, name, image, created: !found };
  });
}

async function removeWakeCatcherUnlocked(): Promise<{ removed: boolean }> {
  const found = await inspect(WAKE_CATCHER_NAME);
  if (!found) return { removed: false };
  if (found.managed !== WAKE_CATCHER_LABEL) foreign();
  await capture('docker', ['rm', '-fv', found.id], { timeoutMs: 30_000 });
  return { removed: true };
}
export async function removeWakeCatcher(): Promise<{ removed: boolean }> {
  return withCatcher('wake', removeWakeCatcherUnlocked);
}

/** Wake demand per token since `sinceMs`, from the running catcher's own log lines. */
export async function readWakeDemand(params: unknown) {
  const { sinceMs } = wakeDemandParams.parse(params);
  const found = await inspect(WAKE_CATCHER_NAME);
  if (!found || found.managed !== WAKE_CATCHER_LABEL || !found.running) throw new HttpError(409, 'wake_catcher_missing', 'The wake catcher is not running on the node');
  const startedMs = Date.parse(found.startedAt);
  if (!Number.isFinite(startedMs) || startedMs < 0) throw new HttpError(502, 'wake_catcher_unconfirmed', 'The wake catcher start time could not be read');
  const lowerBound = Math.max(Math.floor(sinceMs / 1000) * 1000, startedMs);
  // Docker's --since has second precision; re-reading a line is harmless because a wake is idempotent.
  const since = new Date(lowerBound).toISOString();
  const out = await capture('docker', ['logs', '--timestamps', '--since', since, '--tail', String(DEMAND_TAIL), found.id], { timeoutMs: 15_000 });
  const after = await inspect(WAKE_CATCHER_NAME);
  if (!after || after.id !== found.id || after.startedAt !== found.startedAt || !after.running || after.managed !== WAKE_CATCHER_LABEL) {
    throw new HttpError(409, 'wake_catcher_changed', 'The wake catcher process changed while demand was read');
  }
  const items = new Map<string, { token: string; count: number; lastAt: number }>();
  let cursorMs = Math.max(sinceMs, startedMs);
  const lines = out.split('\n').filter(line => line.trim());
  // A full tail may have dropped older lines: say so, so the panel never reads it as all the demand.
  const truncated = lines.length >= DEMAND_TAIL;
  for (const line of lines) {
    const match = /^(\S+) ND-WAKE (\{"token":"[a-f0-9]{32}"\})$/.exec(line.trim());
    if (!match || !line.includes(WAKE_DEMAND_PREFIX)) continue;
    const at = Date.parse(match[1]!);
    if (!Number.isFinite(at) || at < lowerBound) continue;
    const { token } = JSON.parse(match[2]!) as { token: string };
    const item = items.get(token) ?? { token, count: 0, lastAt: 0 };
    item.count += 1; item.lastAt = Math.max(item.lastAt, at); items.set(token, item);
    cursorMs = Math.max(cursorMs, at);
  }
  return { catcherId: found.id, startedAt: found.startedAt, items: [...items.values()], cursorMs, truncated };
}
