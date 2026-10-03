import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';

/**
 * r360: instance branding (`GET /v1/branding`, written by
 * `ninedeploy branding set`). The panel never read it, so setting it changed
 * nothing visible. The endpoint needs a session, so only the authenticated
 * shell applies it; the login screen keeps the stock mark.
 *
 * Applied: `logoUrl` (the rail's brand mark) and `supportEmail` (a mailto
 * link in the rail). Not applied: `primaryColor` — the accent is a per-user
 * Appearance choice, and silently overriding it would fight that setting;
 * `footerHtml` — operator-supplied raw HTML, which the panel will not inject
 * without a sanitiser.
 */
export interface PanelBranding {
  logoUrl: string | null;
  supportEmail: string | null;
}

/**
 * Only http(s) URLs and inline raster/vector images are allowed into an
 * `<img src>`: a `javascript:` or other scheme from the config store never
 * reaches the DOM.
 */
export function safeLogoUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** A plain address only — no header injection through `mailto:?cc=…`. */
export function safeSupportEmail(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  return value && /^[^\s@?&#/:]+@[^\s@?&#/:]+\.[^\s@?&#/:]+$/.test(value) ? value : null;
}

const NONE: PanelBranding = { logoUrl: null, supportEmail: null };

export function useBranding(): PanelBranding {
  const q = useQuery({
    queryKey: ['branding'],
    queryFn: async (): Promise<PanelBranding> => {
      try {
        const b = await api.branding.get();
        return { logoUrl: safeLogoUrl(b.logoUrl), supportEmail: safeSupportEmail(b.supportEmail) };
      } catch {
        // Branding is cosmetic: an older server or a failed read keeps the defaults.
        return NONE;
      }
    },
    staleTime: 5 * 60_000,
  });
  return q.data ?? NONE;
}
