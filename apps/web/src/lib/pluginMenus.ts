import { useQuery } from '@tanstack/react-query';
import type { MenuItem } from '@ninedeploy/sdk';
import { api } from './api.js';

/**
 * r566: a plugin menu entry as the panel renders it — the wire `MenuItem`
 * plus the optional display fields the plugin SDK's `MenuItemDefinition`
 * allows (PluginSlot shows them).
 */
export type PluginMenuItem = MenuItem & {
  description?: string;
  badge?: string | { text: string };
};

export const MENUS_QUERY_KEY = ['menus'] as const;

/**
 * r566: ONE cached query for every menu consumer — the sidebar, the command
 * palette and each PluginSlot. PluginSlot used to cache per slot
 * (`['menus', slot]`), so a page with three slots fetched the full list three
 * times, and the plugin settings' `['menus']` invalidation reached it only
 * by prefix. Menus are decorative: a failed load renders no extensions.
 */
export function usePluginMenus() {
  return useQuery({
    queryKey: MENUS_QUERY_KEY,
    queryFn: async (): Promise<PluginMenuItem[]> => {
      try {
        const res: unknown = await api.menus.list();
        // Tolerates a bare array (pre-kernel servers answered with one).
        if (Array.isArray(res)) return res as PluginMenuItem[];
        return (res as { items?: PluginMenuItem[] } | null)?.items ?? [];
      } catch {
        return [];
      }
    },
    staleTime: 30_000,
  });
}

export type MenuTarget = { kind: 'external'; href: string } | { kind: 'internal'; to: string };

/**
 * r566: where a plugin-supplied `route` may point. Plugins are third-party
 * code and their routes land in hrefs; only absolute http(s) URLs and
 * same-origin absolute paths are allowed — not `javascript:`/`data:` (React
 * blocks only `javascript:`, and only at render), not protocol-relative
 * `//host`, and not backslashes or control characters, which browsers
 * normalise into `//host` when the link is opened in a new tab.
 */
export function menuTarget(route: unknown): MenuTarget | null {
  if (typeof route !== 'string') return null;
  const r = route.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
  if (r.length === 0 || /[\\\u0000-\u001f\u007f]/.test(r)) return null;
  if (/^https?:\/\//i.test(r)) {
    try {
      return { kind: 'external', href: new URL(r).href };
    } catch {
      return null;
    }
  }
  if (r.startsWith('/') && !r.startsWith('//')) return { kind: 'internal', to: r };
  return null;
}
