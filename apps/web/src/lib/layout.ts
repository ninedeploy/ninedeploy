import { useCallback, useSyncExternalStore } from 'react';

/**
 * A3: the compact layout. Six service tabs with the rest under "More",
 * rarely used Settings cards folded, and a shorter sidebar (Hub inside New,
 * no Queue item, Networks inside Topology).
 *
 * N10 (docs/COMPACT_LAYOUT.md): compact is the layout a browser gets until it
 * chooses one. It was opt-in while the two layouts were compared on the same
 * tasks; that comparison is done. A stored choice is kept either way, so
 * someone who picked Classic keeps it. The choice is kept in the browser like
 * the theme and the Simple / Advanced mode, and read through a store rather
 * than a provider, so every component that branches on it sees the same value
 * without extra wiring.
 */
export type PanelLayout = 'classic' | 'compact';

/**
 * The layout for a browser that never chose: a first visit, a new browser
 * profile, a private window, or a browser that refuses storage (where a
 * choice then lasts for the page only).
 */
export const DEFAULT_LAYOUT: PanelLayout = 'compact';

export const LAYOUT_STORAGE_KEY = 'ninedeploy_layout';
const CHANGED = 'ninedeploy-layout-changed';

/** The stored choice, or the default. An explicit Classic counts exactly as much as an explicit Compact. */
export function readLayout(): PanelLayout {
  try {
    const stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (stored === 'classic' || stored === 'compact') return stored;
  } catch {
    // Storage blocked: the default.
  }
  return DEFAULT_LAYOUT;
}

export function writeLayout(layout: PanelLayout): void {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, layout);
    memory = null;
  } catch {
    // Storage blocked (private window): the choice lasts for this page only.
    memory = layout;
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** Used only when storage refuses the write. */
let memory: PanelLayout | null = null;

function subscribe(onChange: () => void): () => void {
  // `storage` covers other tabs; CHANGED covers this one.
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

const snapshot = (): PanelLayout => memory ?? readLayout();

export function usePanelLayout(): { layout: PanelLayout; isCompact: boolean; setLayout: (layout: PanelLayout) => void } {
  const layout = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_LAYOUT);
  const setLayout = useCallback((next: PanelLayout) => writeLayout(next), []);
  return { layout, isCompact: layout === 'compact', setLayout };
}
