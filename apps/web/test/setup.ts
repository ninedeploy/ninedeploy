import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest runs without globals, so React Testing Library's automatic cleanup
// never registers — unmount explicitly between tests or renders leak across
// tests and collide on shared texts.
afterEach(() => {
  cleanup();
});

// On Node ≥ 25 the jsdom storage globals arrive through vitest's environment
// population as an EMPTY object — `localStorage.getItem is not a function`
// from the first component render that touches one (they work on Node 24 and
// in plain jsdom, which is why it only shows up here). Detect a non-functional
// storage and back both names with a working in-memory instance.
class MemoryStorage implements Storage {
  readonly #map = new Map<string, string>();

  get length(): number {
    return this.#map.size;
  }

  clear(): void {
    this.#map.clear();
  }

  getItem(key: string): string | null {
    return this.#map.has(key) ? (this.#map.get(key) ?? null) : null;
  }

  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#map.set(key, String(value));
  }
}

function functionalStorage(): Storage {
  const Ctor = (window as unknown as { Storage?: new () => Storage }).Storage;
  if (typeof Ctor === 'function') {
    try {
      const probe = new Ctor();
      probe.setItem('__nd_probe__', '1');
      if (probe.getItem('__nd_probe__') === '1') return probe;
    } catch {
      /* fall through to the in-memory implementation */
    }
  }
  return new MemoryStorage();
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  const current = (globalThis as Record<string, unknown>)[name] as Partial<Storage> | undefined;
  if (current && typeof current.getItem === 'function' && typeof current.setItem === 'function') continue;
  const storage = functionalStorage();
  Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true });
  Object.defineProperty(window, name, { value: storage, configurable: true, writable: true });
}
