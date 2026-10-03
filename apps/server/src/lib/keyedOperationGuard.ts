/** Serialize operations sharing a key within this server process. Other keys
 * remain independent; completed queues release their map entries. */
export function createKeyedOperationGuard<Key>() {
  const tails = new Map<Key, Promise<void>>();
  return async function guard<Result>(key: Key, operation: () => Promise<Result>): Promise<Result> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
