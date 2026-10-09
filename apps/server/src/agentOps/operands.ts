/**
 * Operand validators shared by the agent's op table (agent.ts) and the
 * multi-node op modules (agentOps/*.ts). Moved out of agent.ts unchanged, so
 * every op validates its operands with the same rules wherever it lives: a
 * request never carries a program or a raw argv, only operands these accept.
 */

export type Params = Record<string, unknown>;

export const RE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/; // container/volume/project names, slugs
export const RE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9@:/._-]*$/; // image refs incl. digests, registries
const RE_PATH_RAW = /^[A-Za-z0-9@._][A-Za-z0-9@._/-]*$|^\/[A-Za-z0-9@._/-]*$/; // relative or absolute
/** Path validator: rejects any `..` segment so operands can never traverse up. */
export const RE_PATH = (value: string): boolean => RE_PATH_RAW.test(value) && !value.split('/').includes('..');
export const RE_SHA = /^(HEAD|[0-9a-f]{6,64})$/;
export const RE_REF = /^[A-Za-z0-9@:/._][A-Za-z0-9@:/._-]*$/; // branches, tags, URLs — first char must not be `-` (git reads a dash-leading argv element as an option)
/**
 * Repository URL for a clone: RE_REF's charset AND a network scheme (r099).
 * RE_REF alone accepted `file:///etc` or a bare local path — the agent must not
 * rely on the panel's schema to keep a clone off the node's own filesystem.
 */
export const isRepoUrl = (value: string): boolean =>
  RE_REF.test(value) && /^(?:https?:\/\/|ssh:\/\/|git:\/\/|git@[A-Za-z0-9.-]+:)/.test(value);
/**
 * `-c` flags for every network git op on the node (r099): no HTTP redirects
 * (a public host bouncing to the node's metadata service / LAN), no `file://`
 * or `ext::` transports.
 */
export const GIT_EGRESS_FLAGS = ['-c', 'http.followRedirects=false', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never'];

export const str = (p: Params, k: string): string | undefined => (typeof p[k] === 'string' ? (p[k] as string) : undefined);

export function validated(value: string | undefined, check: RegExp | ((v: string) => boolean), what: string): string {
  if (value === undefined || !(typeof check === 'function' ? check(value) : check.test(value))) throw new Error(`Invalid ${what}`);
  return value;
}

// ── multi-node operands ─────────────────────────────────────────────────────

/** A switch the node's owner sets in the agent's environment: off/false/0/no/disabled turns a feature off. */
export const switchedOff = (value: string | undefined): boolean => /^(off|false|0|no|disabled)$/i.test((value ?? '').trim());

/** A managed volume (`nd-svc-*` / `nd-db-*`), the only kind a multi-node op touches (bind mounts never). */
export const RE_MANAGED_VOLUME = /^nd-(?:svc|db)-[a-z0-9][a-z0-9_.-]*$/;
export const isManagedVolume = (value: string): boolean => value.length <= 128 && RE_MANAGED_VOLUME.test(value);

/**
 * Stream transfer files (agentOps/stream.ts) live here, 0600. `.transfer`
 * can never be a service workspace: RE_NAME refuses a leading dot.
 */
export const TRANSFER_DIR = '.agent-work/.transfer';

/** An image id as Docker prints it. */
export const RE_IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/** A service image tag the panel builds and ships: `ninedeploy/<slug>:<tag>`. */
export const RE_SERVICE_IMAGE_TAG = /^ninedeploy\/[a-z0-9-]+:[A-Za-z0-9_.-]+$/;

/** The node proxy's image (agent.ts `proxy.ensure`). */
export const NODE_PROXY_IMAGE = 'traefik:v3.1';

/**
 * Repositories a multi-node op must never write a tag into: the node proxy,
 * the throwaway helper sidecars, the NineDeploy image the agent itself runs
 * (`ghcr.io/ninedeploy/*`), and the configured host-shell image. A tag
 * written there would replace what the node's infrastructure runs on its
 * next start — the reason `image.load` refuses archives that carry tags.
 */
const RESERVED_REPOSITORIES = ['traefik', 'alpine', 'ninedeploy/ninedeploy', 'ninedeploy/agent', 'ninedeploy/proxy'];

/** `repo` of `[host/]repo[:tag][@digest]`, with Docker Hub's implicit `docker.io/` and `library/` removed. */
export function imageRepository(ref: string): string {
  let r = ref.split('@')[0] as string;
  const slash = r.lastIndexOf('/');
  const colon = r.lastIndexOf(':');
  if (colon > slash) r = r.slice(0, colon);
  r = r.replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '');
  return r.replace(/^library\//, '');
}

/** True when `ref` names node infrastructure (see {@link RESERVED_REPOSITORIES}). */
export function isReservedImage(ref: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const repo = imageRepository(ref.toLowerCase());
  if (RESERVED_REPOSITORIES.includes(repo) || repo.startsWith('ghcr.io/ninedeploy/')) return true;
  const shell = (env['NINEDEPLOY_HOST_SHELL_IMAGE'] ?? '').trim().toLowerCase();
  return shell !== '' && imageRepository(shell) === repo;
}

/** A registry-qualified reference (`host[:port]/repo:tag`): the first component names a host. */
export function isRegistryQualified(ref: string): boolean {
  const first = ref.split('/')[0] as string;
  return ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
}

/** A positive safe integer within `[min, max]`, or a refusal naming `what`. */
export function intOperand(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${what}`);
  return value;
}
