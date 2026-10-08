import { config } from '../config.js';

/**
 * The browser origins the panel trusts: its public URL, the Vite / dev-server
 * origins outside production, and `NINEDEPLOY_CORS_ORIGINS` (comma
 * separated) in every environment.
 *
 * Restrict CORS to a known allowlist instead of reflecting any origin
 * (`origin: true`). The dashboard is same-origin in production; localhost
 * origins are available only during development, while explicitly configured
 * origins remain available in every environment.
 *
 * Moved out of `app.ts` unchanged in 0.15 so the terminal attach socket can
 * apply the same list to its `Origin` check (DESIGN §1.4) without a second,
 * drifting copy.
 */
export function panelAllowedOrigins(): string[] {
  const extraOrigins = (process.env['NINEDEPLOY_CORS_ORIGINS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [
    ...new Set([
      config.publicUrl,
      ...(config.isProd ? [] : ['http://localhost:5173', 'http://localhost:3000']),
      ...extraOrigins,
    ]),
  ];
}
