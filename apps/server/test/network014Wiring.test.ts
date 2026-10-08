/**
 * 0.14 wiring guard (DESIGN §6 M1, M2): the four network-and-data-access route
 * modules are mounted in `modules/api.ts` under their prefixes, and the two
 * background plugins are registered in `app.ts` after the traefik plugin.
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
import { databaseImportRoutes } from '../src/modules/databaseImports.js';
import { databasePublicAccessRoutes } from '../src/modules/databasePublicAccess.js';
import { secretProviderRoutes } from '../src/modules/secretProviders.js';
import { traefikCustomRoutes } from '../src/modules/traefikCustom.js';
import databaseImportsPlugin from '../src/plugins/databaseImports.js';
import publicDatabaseAccessPlugin from '../src/plugins/publicDatabaseAccess.js';

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), 'utf8')
    // Comments must not satisfy the guard: drop block and line comments.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const MODULES: Array<{ binding: string; file: string; prefix: string; routes: FastifyPluginAsync }> = [
  { binding: 'databasePublicAccessRoutes', file: './databasePublicAccess.js', prefix: '/databases', routes: databasePublicAccessRoutes },
  { binding: 'databaseImportRoutes', file: './databaseImports.js', prefix: '/databases', routes: databaseImportRoutes },
  { binding: 'traefikCustomRoutes', file: './traefikCustom.js', prefix: '/traefik', routes: traefikCustomRoutes },
  {
    binding: 'secretProviderRoutes',
    file: './secretProviders.js',
    prefix: '/settings/secret-providers',
    routes: secretProviderRoutes,
  },
];

const PLUGINS: Array<{ binding: string; file: string; name: string; plugin: unknown }> = [
  {
    binding: 'publicDatabaseAccessPlugin',
    file: './plugins/publicDatabaseAccess.js',
    name: 'ninedeploy-public-db-access',
    plugin: publicDatabaseAccessPlugin,
  },
  {
    binding: 'databaseImportsPlugin',
    file: './plugins/databaseImports.js',
    name: 'ninedeploy-database-imports',
    plugin: databaseImportsPlugin,
  },
];

describe('0.14 route modules are mounted in modules/api.ts (M1)', () => {
  const api = read('../src/modules/api.ts');

  for (const m of MODULES) {
    it(`${m.binding} is imported and registered under ${m.prefix}`, () => {
      expect(api).toMatch(new RegExp(`import \\{[^}]*\\b${m.binding}\\b[^}]*\\} from '${escapeRe(m.file)}';`));
      const registrations = api.match(
        new RegExp(`await app\\.register\\(${m.binding}, \\{ prefix: '${escapeRe(m.prefix)}' \\}\\);`, 'g'),
      );
      expect(registrations).toHaveLength(1);
    });
  }

  it('each module exports the plugin api.ts registers', async () => {
    for (const m of MODULES) {
      expect(typeof m.routes, m.binding).toBe('function');
      // It mounts cleanly under its prefix in an isolated instance.
      const app = Fastify();
      // The auth plugin's hooks, inert: modules reference them at route
      // registration, and the guard is about mounting, not authorization.
      const noop = async () => undefined;
      app.decorate('authenticate', noop);
      app.decorate('requireOperator', noop);
      app.decorate('requireAdmin', noop);
      app.decorate('requireInteractive', noop);
      app.decorate('requireScope', () => noop);
      await app.register(m.routes, { prefix: `/v1${m.prefix}` });
      await expect(app.ready()).resolves.toBeDefined();
      await app.close();
    }
  });
});

describe('0.14 plugins are registered in app.ts after the traefik plugin (M2)', () => {
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
});
