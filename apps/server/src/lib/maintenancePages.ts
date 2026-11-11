import type { ErrorPageStatus } from '@ninedeploy/schemas';

/**
 * G2.2: the HTML of the maintenance page and of the built-in error pages. The
 * panel serves them for services on the panel host (modules/maintenance.ts);
 * for a service on a node, the panel renders the same pages and the node's
 * page server (pageServer.ts) serves them as they are.
 */

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function page(title: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#f7f7f8;color:#1f2328}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}}main{max-width:32rem;padding:1.5rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;opacity:.75;white-space:pre-line}</style>
</head><body><main><h1>${escapeHtml(title)}</h1>${text ? `<p>${escapeHtml(text)}</p>` : ''}</main></body></html>`;
}

export const DEFAULT_ERROR: Record<ErrorPageStatus, [string, string]> = {
  '502': ['Bad gateway', 'The app did not answer properly. Try again in a moment.'],
  '503': ['Service unavailable', 'The app is not available right now. Try again in a moment.'],
  '504': ['Gateway timeout', 'The app took too long to answer. Try again in a moment.'],
};

/** The maintenance answer in both forms: HTML for a browser, one line of text for anything else. */
export function maintenanceAnswer(m: { title: string; message: string } | null): { html: string; text: string } {
  // Switched off a moment ago: the routes are on their way back to the app.
  const title = m?.title ?? 'Back in a moment';
  const message = m ? m.message : 'This page reloads shortly.';
  return { html: page(title, message), text: `${title}. ${message}\n` };
}

/** Whether `host` is `hostname`, or matches it as a one-label `*.` wildcard. Both lower case. */
export function hostMatches(hostname: string, host: string): boolean {
  return hostname === host || (hostname.startsWith('*.') && host.endsWith(hostname.slice(1)) && host.split('.').length === hostname.split('.').length);
}
