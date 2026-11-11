import { useCallback, useSyncExternalStore } from 'react';

/**
 * A3: the compact layout. Six service tabs with the rest under "More",
 * rarely used Settings cards folded, and a shorter sidebar (Hub inside New,
 * no Queue item, Networks inside Topology).
 *
 * It is opt-in for one release (Settings → Appearance), so an upgrade changes
 * nothing for anyone; the release after turns it on by default and removes
 * the classic layout. Kept in the browser like the theme and the Simple /
 * Advanced mode, and read through a store rather than a provider, so every
 * component that branches on it sees the same value without extra wiring.
 */
export type PanelLayout = 'classic' | 'compact';

export const LAYOUT_STORAGE_KEY = 'ninedeploy_layout';
const CHANGED = 'ninedeploy-layout-changed';

export function readLayout(): PanelLayout {
  try {
    return localStorage.getItem(LAYOUT_STORAGE_KEY) === 'compact' ? 'compact' : 'classic';
  } catch {
    return 'classic';
  }
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
  const layout = useSyncExternalStore(subscribe, snapshot, () => 'classic' as const);
  const setLayout = useCallback((next: PanelLayout) => writeLayout(next), []);
  return { layout, isCompact: layout === 'compact', setLayout };
}
