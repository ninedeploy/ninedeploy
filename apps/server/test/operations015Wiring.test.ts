/**
 * 0.15 wiring guard (DESIGN §6 M1, M2, M5, M6, D6): the seven operations-and-API
 * route modules are mounted in `modules/api.ts` under their prefixes, the two
 * background plugins are registered in `app.ts` after the traefik plugin, the
 * route registry's `onRoute` hook comes before every plugin, the WebSocket
 * plugin gets the D6 options, housekeeping runs the two 0.15 retention steps,
 * and `assertStepUp` is imported from `lib/stepUp.ts`.
 *
 * A route that is written and tested but never registered is this repo's most
 * common defect, so this pins the registrations themselves: deleting or
 * commenting out any of them fails here. The routes each task adds are also
 * pinned by `authzMatrix.test.ts`, whose stale-entry check fails once a
 * classified route stops being registered.
 *
 * Source scan rather than `buildApp()`: booting the real app reaches Docker
 * and timers, and this guard must stay hermetic.
 */
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyPluginAsync } from 'fastify';
import { describe, expect, it } from 'vitest';
import { accessGrantRoutes, accessMeRoutes, projectAccessRoutes } from '../src/modules/accessGrants.js';
import { openapiRoutes } from '../src/modules/openapi.js';
import { terminalRoutes } from '../src/modules/terminals.js';
import { serviceTrafficRoutes, trafficRoutes } from '../src/modules/traffic.js';
import terminalsPlugin from '../src/plugins/terminals.js';
import trafficAnalyticsPlugin from '../src/plugins/trafficAnalytics.js';
import { pruneTerminalSessions } from '../src/lib/terminalSessions.js';
import { pruneTrafficRollups } from '../src/lib/trafficAnalytics.js';

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), 'utf8')
    // Comments must not satisfy the guard: drop block and line comments.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** `prefix: null` = registered with no options (the route sits directly under /v1). */
const MODULES: Array<{ binding: string; file: string; prefix: string | null; routes: FastifyPluginAsync }> = [
  { binding: 'terminalRoutes', file: './terminals.js', prefix: '/terminals', routes: terminalRoutes },
  { binding: 'trafficRoutes', file: './traffic.js', prefix: '/traffic', routes: trafficRoutes },
  { binding: 'serviceTrafficRoutes', file: './traffic.js', prefix: '/services', routes: serviceTrafficRoutes },
  { binding: 'openapiRoutes', file: './openapi.js', prefix: null, routes: openapiRoutes },
  { binding: 'accessGrantRoutes', file: './accessGrants.js', prefix: '/workspaces', routes: accessGrantRoutes },
  { binding: 'projectAccessRoutes', file: './accessGrants.js', prefix: '/projects', routes: projectAccessRoutes },
  { binding: 'accessMeRoutes', file: './accessGrants.js', prefix: '/access', routes: accessMeRoutes },
];

const PLUGINS: Array<{ binding: string; file: string; name: string; plugin: unknown }> = [
  { binding: 'terminalsPlugin', file: './plugins/terminals.js', name: 'ninedeploy-terminals', plugin: terminalsPlugin },
  {
    binding: 'trafficAnalyticsPlugin',
    file: './plugins/trafficAnalytics.js',
    name: 'ninedeploy-traffic-analytics',
    plugin: trafficAnalyticsPlugin,
  },
];

describe('0.15 route modules are mounted in modules/api.ts (M1)', () => {
  const api = read('../src/modules/api.ts');

  for (const m of MODULES) {
    it(`${m.binding} is imported and registered under ${m.prefix ?? '/v1 itself'}`, () => {
      expect(api).toMatch(new RegExp(`import \\{[^}]*\\b${m.binding}\\b[^}]*\\} from '${escapeRe(m.file)}';`));
      const call =
        m.prefix === null
          ? `await app\\.register\\(${m.binding}\\);`
          : `await app\\.register\\(${m.binding}, \\{ prefix: '${escapeRe(m.prefix)}' \\}\\);`;
      expect(api.match(new RegExp(call, 'g'))).toHaveLength(1);
    });
  }

  it('each module exports the plugin api.ts registers, and it mounts cleanly', async () => {
    for (const m of MODULES) {
      expect(typeof m.routes, m.binding).toBe('function');
      const app = Fastify();
      // The auth plugin's hooks, inert: modules reference them at route
      // registration, and the guard is about mounting, not authorization.
      const noop = async () => undefined;
      app.decorate('authenticate', noop);
      app.decorate('requireOperator', noop);
      app.decorate('requireAdmin', noop);
      app.decorate('requireInteractive', noop);
      app.decorate('requireScope', () => noop);
      await app.register(m.routes, { prefix: `/v1${m.prefix ?? ''}` });
      await expect(app.ready()).resolves.toBeDefined();
      await app.close();
    }
  });
});

describe('0.15 plugins and hooks in app.ts (M2, D6)', () => {
  const src = read('../src/app.ts');
  const traefikAt = src.indexOf('await app.register(traefikPlugin);');

  it('finds the traefik plugin registration (guards the ordering check)', () => {
    expect(traefikAt).toBeGreaterThan(0);
  });

  for (const p of PLUGINS) {
    it(`${p.binding} is imported and registered once, after traefikPlugin`, () => {
      expect(src).toMatch(new RegExp(`import ${p.binding} from '${escapeRe(p.file)}';`));
      const call = `await app.register(${p.binding});`;
      expect(src.split(call)).toHaveLength(2);
      expect(src.indexOf(call)).toBeGreaterThan(traefikAt);
    });
  }

  it('each plugin is a named fastify-plugin that registers on an isolated instance', async () => {
    for (const p of PLUGINS) {
      const app = Fastify();
      await app.register(p.plugin as never);
      await app.ready();
      expect(app.hasPlugin(p.name), p.name).toBe(true);
      await app.close();
    }
  });

  it('attaches the route registry before the first plugin registers', () => {
    expect(src).toMatch(/import \{ attachRouteRegistry \} from '\.\/lib\/routeRegistry\.js';/);
    const attach = src.indexOf('attachRouteRegistry(app);');
    expect(attach).toBeGreaterThan(0);
    expect(src.split('attachRouteRegistry(app);')).toHaveLength(2);
    expect(attach).toBeLessThan(src.indexOf('await app.register('));
  });

  it('registers @fastify/websocket once, with the D6 options', () => {
    expect(src).toMatch(/import \{ websocketServerOptions \} from '\.\/lib\/websocketOptions\.js';/);
    expect(src.match(/await app\.register\(websocket\b[^)]*\);/g)).toEqual([
      'await app.register(websocket, { options: websocketServerOptions });',
    ]);
  });

  it('takes the CORS allow-list from lib/allowedOrigins.ts', () => {
    expect(src).toMatch(/const allowedOrigins = panelAllowedOrigins\(\);/);
    expect(src).toMatch(/await app\.register\(cors, \{ origin: allowedOrigins,/);
  });
});

describe('0.15 housekeeping steps (M5)', () => {
  const src = read('../src/plugins/housekeeping.ts');

  it('runs a terminal-sessions and a traffic-rollups step with the feature-lib sweeps', () => {
    expect(src).toMatch(/import \{ pruneTerminalSessions \} from '\.\.\/lib\/terminalSessions\.js';/);
    expect(src).toMatch(/import \{ pruneTrafficRollups \} from '\.\.\/lib\/trafficAnalytics\.js';/);
    expect(src).toMatch(/await step\('terminal-sessions', \(\) => pruneTerminalSessions\(fastify\.db, now\)\);/);
    expect(src).toMatch(/await step\('traffic-rollups', \(\) => pruneTrafficRollups\(fastify\.db, now\)\);/);
  });

  it('the T1 retention stubs delete nothing yet', async () => {
    expect(await pruneTerminalSessions({} as never)).toBe(0);
    // T3 implemented the traffic sweep (test/lib/trafficAnalytics.test.ts runs it on a real database).
    expect(typeof pruneTrafficRollups).toBe('function');
  });
});

describe('assertStepUp lives in lib/stepUp.ts (M6)', () => {
  it('modules/auth.ts imports it instead of defining its own', () => {
    const auth = read('../src/modules/auth.ts');
    expect(auth).toMatch(/import \{ assertStepUp \} from '\.\.\/lib\/stepUp\.js';/);
    expect(auth).not.toMatch(/function assertStepUp\b/);
    // The four step-up call sites (2FA setup/enable, passkey options/verify) are still there.
    expect(auth.match(/await assertStepUp\(app\.db, req, user,/g)).toHaveLength(4);
  });

  it('lib/stepUp.ts exports it with the 10-minute freshness window', async () => {
    const mod = await import('../src/lib/stepUp.js');
    expect(typeof mod.assertStepUp).toBe('function');
    expect(mod.STEP_UP_FRESH_MS).toBe(10 * 60 * 1000);
  });
});
