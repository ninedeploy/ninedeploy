import { describe, expect, it } from 'vitest';
import {
  alert,
  alertWhen,
  build,
  database,
  env,
  hooks,
  network,
  NINEDEPLOY_MANIFEST_FILENAMES,
  NINEDEPLOY_MANIFEST_MAX_BYTES,
  ninedeployManifest,
  notifications,
  phases,
  previews,
  rateLimit,
  resources,
  restartPolicy,
  run,
  route,
  runtime,
  runtimeType,
  staticConfig,
  volume,
  volumeBackups,
  watch,
} from '../src/ninedeployManifest.js';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => {
  const result = schema.safeParse(value);
  expect(result.success, `expected ${JSON.stringify(value)} to parse`).toBe(true);
  return result.success ? result.data : null;
};
const bad = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => {
  const result = schema.safeParse(value);
  expect(result.success, `expected ${JSON.stringify(value)} to be rejected`).toBe(false);
};

describe('ninedeployManifest', () => {
  describe('module constants', () => {
    it('exposes filename list in priority order', () => {
      expect(NINEDEPLOY_MANIFEST_FILENAMES).toEqual([
        '.ninedeploy',
        '.ninedeploy.yml',
        '.ninedeploy.yaml',
        'ninedeploy.yml',
        'ninedeploy.yaml',
      ]);
    });
    it('caps manifest size at 16 KB', () => {
      expect(NINEDEPLOY_MANIFEST_MAX_BYTES).toBe(16 * 1024);
    });
  });

  describe('runtime', () => {
    it('defaults type to auto', () => {
      const r = ok(runtime, {}) as { type: string };
      expect(r.type).toBe('auto');
    });
    it('accepts all known runtime types', () => {
      for (const t of ['auto', 'node', 'python', 'go', 'ruby', 'php', 'java', 'rust', 'static']) {
        ok(runtimeType, t);
      }
    });
    it('rejects unknown runtime types', () => {
      bad(runtimeType, 'elixir');
    });
    it('accepts a pinned major-only version', () => {
      ok(runtime, { type: 'node', version: '20' });
    });
    it('accepts a pinned major.minor version', () => {
      ok(runtime, { type: 'python', version: '3.12' });
    });
    it('accepts a pinned major.minor.patch version', () => {
      ok(runtime, { type: 'go', version: '1.22.5' });
    });
    it('rejects non-numeric versions', () => {
      bad(runtime, { type: 'node', version: 'twenty' });
      bad(runtime, { type: 'node', version: '20.x' });
    });
    it('rejects an empty version string', () => {
      bad(runtime, { type: 'node', version: '' });
    });
    it('rejects extra fields (strict)', () => {
      bad(runtime, { type: 'node', bogus: true });
    });
  });

  describe('build', () => {
    it('accepts install/build/start/baseDir', () => {
      ok(build, { install: 'npm ci', build: 'npm run build', start: 'node server.js' });
      ok(build, { baseDir: 'apps/web' });
    });
    it('accepts a dockerfile override', () => {
      ok(build, { dockerfile: 'docker/Dockerfile.prod' });
    });
    it('rejects empty commands', () => {
      bad(build, { install: '' });
      bad(build, { build: '' });
      bad(build, { start: '' });
    });
    it('rejects extra fields (strict)', () => {
      bad(build, { install: 'npm ci', unknown: 1 });
    });
  });

  describe('run', () => {
    it('accepts a valid port and healthcheck', () => {
      ok(run, { port: 3000, healthcheck: '/healthz' });
    });
    it('rejects out-of-range port', () => {
      bad(run, { port: 0 });
      bad(run, { port: 65536 });
      bad(run, { port: 1.5 });
    });
    it('rejects absolute-URL healthcheck', () => {
      bad(run, { healthcheck: 'http://evil.com/healthz' });
    });
    it('accepts all named restart policies', () => {
      ok(restartPolicy, 'no');
      ok(restartPolicy, 'always');
      ok(restartPolicy, 'unless-stopped');
    });
    it('accepts on-failure with retry count', () => {
      ok(restartPolicy, 'on-failure');
      ok(restartPolicy, 'on-failure:5');
    });
    it('rejects on-failure with non-numeric or oversized retry count', () => {
      bad(restartPolicy, 'on-failure:abc');
      bad(restartPolicy, 'on-failure:1234');
      bad(restartPolicy, 'on-failure:0');
    });
    it('rejects unknown restart policy', () => {
      bad(restartPolicy, 'sometimes');
    });
    it('rejects extra fields (strict)', () => {
      bad(run, { port: 3000, bogus: 1 });
    });
  });

  describe('static', () => {
    it('defaults spa to false', () => {
      const s = ok(staticConfig, {}) as { spa: boolean };
      expect(s.spa).toBe(false);
    });
    it('accepts a relative root path', () => {
      ok(staticConfig, { spa: true, root: 'dist' });
      ok(staticConfig, { spa: true, root: 'apps/web/dist' });
    });
    it('rejects path traversal in root', () => {
      bad(staticConfig, { root: '../etc' });
      bad(staticConfig, { root: '/abs' });
    });
    it('rejects extra fields (strict)', () => {
      bad(staticConfig, { spa: true, bogus: 1 });
    });
  });

  describe('env', () => {
    it('defaults required to empty array', () => {
      const e = ok(env, {}) as { required: string[] };
      expect(e.required).toEqual([]);
    });
    it('accepts valid env-var names', () => {
      ok(env, { required: ['DATABASE_URL', 'STRIPE_SECRET_KEY'] });
    });
    it('rejects invalid env-var names', () => {
      bad(env, { required: ['1NOPE'] });
      bad(env, { required: ['HAS SPACE'] });
      bad(env, { required: ['HAS-DASH'] });
    });
    it('accepts aliases whose keys and values are env-var names', () => {
      ok(env, { aliases: { DATABASE_URL: 'POSTGRES_URL' } });
    });
    it('rejects aliases with non-env-var values', () => {
      bad(env, { aliases: { DATABASE_URL: 'no-dash' } });
    });
    it('rejects aliases with non-env-var keys', () => {
      // The key side feeds the same generated-env plumbing as the value side
      // ('MY VAR' / '' can never be referenced by an attachment), and keys
      // with YAML-special characters corrupt the emitted .ninedeploy file.
      bad(env, { aliases: { 'MY VAR': 'DB_URL' } });
      bad(env, { aliases: { '': 'DB_URL' } });
      bad(env, { aliases: { 'a: b': 'DB_URL' } });
    });
    it('rejects more than 100 required keys', () => {
      const many = Array.from({ length: 101 }, (_, i) => `KEY_${i}`);
      bad(env, { required: many });
    });
    it('rejects extra fields (strict)', () => {
      bad(env, { required: [], bogus: 1 });
    });
  });

  describe('phases', () => {
    it('accepts setup pkgs and build cmds', () => {
      ok(phases, { setup: { pkgs: ['python310', 'imagemagick'] }, build: { cmds: ['npm run a', 'npm run b'] } });
    });
    it('defaults arrays to empty', () => {
      const p = ok(phases, { setup: {}, build: {} }) as {
        setup: { pkgs: string[] };
        build: { cmds: string[] };
      };
      expect(p.setup.pkgs).toEqual([]);
      expect(p.build.cmds).toEqual([]);
    });
    it('rejects an empty pkg name', () => {
      bad(phases, { setup: { pkgs: [''] } });
    });
    it('rejects an empty build cmd', () => {
      bad(phases, { build: { cmds: [''] } });
    });
    it('rejects extra fields (strict)', () => {
      bad(phases, { setup: { pkgs: [], bogus: 1 } });
    });
  });

  describe('resources', () => {
    it('accepts cpuShares and memMb', () => {
      ok(resources, { cpuShares: 1024, memMb: 512 });
    });
    it('rejects out-of-range cpuShares', () => {
      bad(resources, { cpuShares: -1 });
      bad(resources, { cpuShares: 262145 });
    });
    it('rejects out-of-range memMb', () => {
      bad(resources, { memMb: -1 });
      bad(resources, { memMb: 1_048_577 });
    });
    it('rejects extra fields (strict)', () => {
      bad(resources, { cpuShares: 1, bogus: 1 });
    });
  });

  describe('hooks', () => {
    it('accepts preBuild/postBuild/preStop', () => {
      ok(hooks, { preBuild: './scripts/a.sh', postBuild: './scripts/b.sh', preStop: './scripts/c.sh' });
    });
    it('rejects empty hook commands', () => {
      bad(hooks, { preBuild: '' });
    });
    it('rejects extra fields (strict)', () => {
      bad(hooks, { preBuild: './x.sh', bogus: 1 });
    });
  });

  describe('watch', () => {
    it('defaults paths to empty', () => {
      const w = ok(watch, {}) as { paths: string[] };
      expect(w.paths).toEqual([]);
    });
    it('accepts glob-like paths', () => {
      ok(watch, { paths: ['apps/web/**', 'packages/shared/**'] });
    });
    it('rejects empty path entries', () => {
      bad(watch, { paths: [''] });
    });
    it('rejects extra fields (strict)', () => {
      bad(watch, { paths: [], bogus: 1 });
    });
  });

  describe('route', () => {
    const baseRoute = { host: 'app.example.com' };
    it('defaults path to / and ssl to true', () => {
      const r = ok(route, baseRoute) as { path: string; ssl: boolean };
      expect(r.path).toBe('/');
      expect(r.ssl).toBe(true);
    });
    it('accepts optional headers/ipAllowlist/rateLimit', () => {
      ok(route, {
        ...baseRoute,
        path: '/api',
        redirectWww: true,
        ssl: false,
        headers: { 'X-Frame-Options': 'DENY' },
        ipAllowlist: ['1.2.3.4/32', '10.0.0.0/8'],
        rateLimit: { average: 50, burst: 100 },
      });
    });
    it('rejects an invalid host', () => {
      bad(route, { host: '-bad-.com' });
      bad(route, { host: 'no_underscore.com' });
      bad(route, { host: 'a'.repeat(254) });
    });
    it('rejects a path that does not start with /', () => {
      bad(route, { host: 'app.example.com', path: 'api' });
    });
    it('rejects non-CIDR entries in ipAllowlist', () => {
      bad(route, { host: 'app.example.com', ipAllowlist: ['evil'] });
    });
    it('rejects out-of-range rateLimit', () => {
      bad(rateLimit, { average: -1, burst: 10 });
      bad(rateLimit, { average: 10, burst: 100_001 });
    });
    it('rejects extra fields (strict)', () => {
      bad(route, { host: 'app.example.com', bogus: 1 });
    });
  });

  describe('previews', () => {
    it('defaults sensible preview values', () => {
      const p = ok(previews, {}) as {
        enabled: boolean;
        maxActive: number;
        autoDestroyOnClose: boolean;
        pattern?: string;
      };
      expect(p.enabled).toBe(false);
      expect(p.maxActive).toBe(5);
      expect(p.autoDestroyOnClose).toBe(true);
    });
    it('accepts a pattern that contains {n}', () => {
      ok(previews, { enabled: true, pattern: 'pr-{n}.previews.example.com' });
    });
    it('rejects enabled:true without a {n} pattern', () => {
      bad(previews, { enabled: true, pattern: 'pr.example.com' });
    });
    it('rejects patterns with unsafe characters', () => {
      bad(previews, { enabled: true, pattern: 'pr-{n}.bad host' });
    });
    it('rejects extra fields (strict)', () => {
      bad(previews, { enabled: false, bogus: 1 });
    });
  });

  describe('volume', () => {
    it('accepts mount and backups', () => {
      ok(volume, { mount: '/data', backups: { schedule: '0 3 * * *', retention: 7 } });
    });
    it('rejects path traversal in mount', () => {
      bad(volume, { mount: '../etc' });
    });
    it('rejects invalid cron schedules', () => {
      bad(volumeBackups, { schedule: '!!@@##' });
    });
    it('accepts valid cron schedule characters', () => {
      ok(volumeBackups, { schedule: '*/5 * * * *' });
    });
    it('rejects out-of-range retention', () => {
      bad(volumeBackups, { schedule: '0 3 * * *', retention: 0 });
      bad(volumeBackups, { schedule: '0 3 * * *', retention: 366 });
    });
    it('rejects extra fields (strict)', () => {
      bad(volume, { mount: '/data', bogus: 1 });
    });
  });

  describe('database', () => {
    it('accepts ref+env pair', () => {
      ok(database, { ref: 'app-db', env: 'DATABASE_URL' });
    });
    it('rejects non-slug ref', () => {
      bad(database, { ref: 'App_DB', env: 'DATABASE_URL' });
    });
    it('rejects non-env-var env key', () => {
      bad(database, { ref: 'app-db', env: 'no-dash' });
    });
    it('rejects extra fields (strict)', () => {
      bad(database, { ref: 'app-db', env: 'DATABASE_URL', bogus: 1 });
    });
  });

  describe('network', () => {
    it('defaults aliases to empty', () => {
      const n = ok(network, {}) as { aliases: string[] };
      expect(n.aliases).toEqual([]);
    });
    it('accepts publishPort and aliases', () => {
      ok(network, { publishPort: 8080, aliases: ['internal-mesh'] });
    });
    it('rejects out-of-range publishPort', () => {
      bad(network, { publishPort: 0 });
      bad(network, { publishPort: 65536 });
    });
    it('rejects empty alias entries', () => {
      bad(network, { aliases: [''] });
    });
    it('rejects extra fields (strict)', () => {
      bad(network, { aliases: [], bogus: 1 });
    });
  });

  describe('notifications', () => {
    it('defaults all lists to empty', () => {
      const n = ok(notifications, {}) as {
        onDeploy: string[];
        onFailure: string[];
        onAlert: string[];
      };
      expect(n.onDeploy).toEqual([]);
      expect(n.onFailure).toEqual([]);
      expect(n.onAlert).toEqual([]);
    });
    it('accepts channel name references', () => {
      ok(notifications, { onDeploy: ['ops'], onFailure: ['oncall'], onAlert: ['oncall'] });
    });
    it('rejects empty channel names', () => {
      bad(notifications, { onDeploy: [''] });
    });
    it('rejects extra fields (strict)', () => {
      bad(notifications, { onDeploy: ['ops'], bogus: 1 });
    });
  });

  describe('alert', () => {
    it('accepts a minimal alert', () => {
      ok(alert, { when: 'deployFailed', channel: 'oncall' });
    });
    it('accepts all when values', () => {
      for (const w of ['deployFailed', 'restartLoop', 'highMemory', 'highCpu', 'certExpiry']) {
        ok(alertWhen, w);
        if (w === 'highMemory' || w === 'highCpu') {
          ok(alert, { when: w, channel: 'oncall', thresholdPct: 90 });
        } else {
          ok(alert, { when: w, channel: 'oncall' });
        }
      }
    });
    it('requires thresholdPct for highMemory/highCpu', () => {
      bad(alert, { when: 'highMemory', channel: 'oncall' });
      bad(alert, { when: 'highCpu', channel: 'oncall' });
    });
    it('rejects out-of-range thresholdPct', () => {
      bad(alert, { when: 'highMemory', channel: 'oncall', thresholdPct: 0 });
      bad(alert, { when: 'highMemory', channel: 'oncall', thresholdPct: 101 });
    });
    it('rejects extra fields (strict)', () => {
      bad(alert, { when: 'deployFailed', channel: 'oncall', bogus: 1 });
    });
  });

  describe('top-level manifest', () => {
    it('accepts a fully-populated manifest', () => {
      const full = {
        version: '1' as const,
        runtime: { type: 'node' as const, version: '20' },
        build: { install: 'npm ci', build: 'npm run build', start: 'node server.js', baseDir: 'apps/web' },
        run: { port: 3000, healthcheck: '/healthz', restart: 'unless-stopped' as const },
        static: { spa: true, root: 'dist' },
        env: { required: ['DATABASE_URL'], aliases: { DATABASE_URL: 'POSTGRES_URL' } },
        phases: { setup: { pkgs: ['python310'] }, build: { cmds: ['npm run x'] } },
        resources: { cpuShares: 1024, memMb: 512 },
        hooks: { preBuild: './a.sh' },
        watch: { paths: ['apps/**'] },
        routes: [
          {
            host: 'app.example.com',
            path: '/',
            ssl: true,
            headers: { 'X-Frame-Options': 'DENY' },
            ipAllowlist: ['1.2.3.4/32'],
            rateLimit: { average: 50, burst: 100 },
          },
        ],
        previews: { enabled: true, pattern: 'pr-{n}.example.com', maxActive: 3, autoDestroyOnClose: true },
        volume: { mount: '/data', backups: { schedule: '0 3 * * *', retention: 7 } },
        database: { ref: 'app-db', env: 'DATABASE_URL' },
        network: { publishPort: 8080, aliases: ['internal-mesh'] },
        notifications: { onDeploy: ['ops'], onFailure: ['oncall'], onAlert: ['oncall'] },
        alerts: [
          { when: 'deployFailed' as const, channel: 'oncall' },
          { when: 'highMemory' as const, channel: 'oncall', thresholdPct: 90 },
        ],
      };
      ok(ninedeployManifest, full);
    });

    it('accepts a minimal manifest (only version)', () => {
      ok(ninedeployManifest, { version: '1' });
    });

    it('rejects an empty document', () => {
      bad(ninedeployManifest, {});
    });

    it('rejects an unknown version', () => {
      bad(ninedeployManifest, { version: '2' });
    });

    it('rejects an unknown top-level field', () => {
      bad(ninedeployManifest, { version: '1', unknown: 1 });
    });

    it('rejects more than 50 routes', () => {
      const routes = Array.from({ length: 51 }, (_, i) => ({
        host: `host${i}.example.com`,
      }));
      bad(ninedeployManifest, { version: '1', routes });
    });

    it('rejects more than 20 alerts', () => {
      const alerts = Array.from({ length: 21 }, () => ({
        when: 'deployFailed' as const,
        channel: 'oncall',
      }));
      bad(ninedeployManifest, { version: '1', alerts });
    });
  });
});
