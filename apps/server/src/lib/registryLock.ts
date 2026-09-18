/**
 * r230: one registry session at a time per (host, registry).
 *
 * `docker login` / `docker logout` write the ONE shared credential store of
 * the daemon's user (`~/.docker/config.json`), and deploys run concurrently
 * (`deployConcurrency`). Deploy A logged into ghcr.io as tenant a, deploy B
 * then logged in as tenant b over it — A pulled with B's credentials — and
 * A's `finally` logout removed B's session mid-pull. The login → pull/build →
 * logout window is therefore serialised per credential store and registry.
 *
 * In-process promise chain: the panel is a single process, and a node's
 * agent is only ever driven by the panel.
 */
const tails = new Map<string, Promise<void>>();

/** Wait for the registry, then hold it until the returned release runs. */
export async function acquireRegistryLock(key: string): Promise<() => void> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    if (tails.get(key) === tail) tails.delete(key);
  };
}

/** Registry key for a credential store: the panel host or one node. */
export function registryLockKey(serverId: number | null | undefined, registry: string | undefined): string {
  return `${serverId == null ? 'local' : `node:${serverId}`}|${registry || 'docker.io'}`;
}
