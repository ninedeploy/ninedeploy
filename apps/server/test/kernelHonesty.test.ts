/**
 * Regression guard: the microkernel is wired, and the plugin surface tells the
 * truth about what it can do.
 *
 * Two separate defects lived here.
 *
 * 1. **The kernel event bus was inert.** NineDeploy carries two unrelated
 *    buses: `lib/events.ts` (real — `audit()` publishes to it, `/v1/events`
 *    serves it) and `kernel/eventBus.ts` (typed, what plugins subscribe to).
 *    Nothing ever emitted into the second one. The three built-in plugins that
 *    ship ENABLED listened for `deployment.status_changed`,
 *    `service.health_changed` and `backup.completed` — names no code emitted —
 *    so they ran on every install and did nothing at all.
 *
 * 2. **The plugin marketplace pretended to install things.** Nothing in
 *    `pluginLoader.ts` ever `import()`s code. An npm/git/local "install" became
 *    a DB row plus a shell whose `init` emits one event; the panel then showed
 *    it as active. Worse, several of the 16 catalog entries shadow features
 *    that already exist under another name — an operator who installed
 *    "Amazon S3 & Cloudflare R2 Sync", entered a bucket and secret key and saw
 *    it active would reasonably believe their backups were being copied
 *    off-site. They were not, and they would find out at restore time.
 *
 * 3. **Plugins declared settings nothing read.** A `configSchema` entry is
 *    rendered as a real field in Settings -> Plugins and its value is
 *    persisted (encrypted, for `isSecret` ones). Five keys across four
 *    built-in plugins were saved and never consulted: the Cloudflare Tunnels
 *    account id + tunnel TOKEN, the notification dispatcher's per-minute alert
 *    cap and its deploy-success switch, the telemetry streamer's metrics
 *    retention, and the template-bundle override counter. The guard at the
 *    bottom of this file keeps the schema and the code that reads it in step.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/kernel/eventBus.js';
import { bridgeAuditEvents, mapAuditToDomainEvent } from '../src/kernel/auditBridge.js';
import {
  MARKETPLACE_CATALOG,
  UnimplementedPluginError,
  UnsupportedPluginSourceError,
  installPlugin,
  isLoadableSource,
} from '../src/kernel/pluginLoader.js';
import type { AppEvent } from '../src/lib/events.js';

const evt = (action: string, entity: string | null = null): AppEvent => ({
  id: 1,
  action,
  entity,
  ts: '2026-01-01T00:00:00.000Z',
  actorUserId: 1,
});

describe('mapAuditToDomainEvent', () => {
  it('maps every deploy.* action onto deployment.status_changed', () => {
    expect(mapAuditToDomainEvent(evt('deploy.success', 'web #12'))).toEqual({
      name: 'deployment.status_changed',
      payload: { status: 'success', serviceName: 'web', deploymentId: 12 },
    });
  });

  it('copes with an entity that carries no id', () => {
    expect(mapAuditToDomainEvent(evt('deploy.start', 'web'))).toEqual({
      name: 'deployment.status_changed',
      payload: { status: 'start', serviceName: 'web' },
    });
  });

  it('r242: maps a service the reconcile could not revive onto a dead health change', () => {
    expect(mapAuditToDomainEvent(evt('alert.service_down', 'api #4'))).toEqual({
      name: 'service.health_changed',
      payload: { status: 'dead', serviceId: 4 },
    });
  });

  it('maps service lifecycle actions onto service.health_changed', () => {
    expect(mapAuditToDomainEvent(evt('service.stop', 'api #4'))).toEqual({
      name: 'service.health_changed',
      payload: { status: 'stop', serviceId: 4 },
    });
  });

  it('maps a completed backup', () => {
    expect(mapAuditToDomainEvent(evt('backup.create', 'app-db'))?.name).toBe('backup.completed');
  });

  it('maps alert transitions with the right severity', () => {
    const fired = mapAuditToDomainEvent(evt('alert.fired', 'cpu > 90'));
    expect(fired).toMatchObject({ name: 'alert.triggered', payload: { level: 'error' } });
    const cleared = mapAuditToDomainEvent(evt('alert.recovered', 'cpu > 90'));
    expect(cleared).toMatchObject({ name: 'alert.triggered', payload: { level: 'info' } });
  });

  it('returns null for an action with no unambiguous mapping', () => {
    // Those still reach plugins as `audit.recorded` — the bridge does not have
    // to know about every action for the bus to be useful.
    expect(mapAuditToDomainEvent(evt('auth.login', 'a@b.test'))).toBeNull();
  });
});

describe('bridgeAuditEvents', () => {
  /** A stand-in for the process-wide `lib/events` singleton. */
  function fakeSource() {
    const listeners = new Set<(e: AppEvent) => void>();
    return {
      subscribe: (cb: (e: AppEvent) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      publish: (e: AppEvent) => {
        for (const l of listeners) l(e);
      },
      size: () => listeners.size,
    };
  }

  it('republishes every audit entry as the raw firehose', () => {
    const src = fakeSource();
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.on('audit.recorded', (p) => void seen.push(p));
    bridgeAuditEvents(src.subscribe, bus);

    src.publish(evt('auth.login', 'a@b.test'));

    expect(seen).toEqual([
      { action: 'auth.login', entity: 'a@b.test', actorUserId: 1, ts: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('also emits the typed event the built-in plugins listen for', () => {
    const src = fakeSource();
    const bus = new EventBus();
    const deploys: unknown[] = [];
    bus.on('deployment.status_changed', (p) => void deploys.push(p));
    bridgeAuditEvents(src.subscribe, bus);

    src.publish(evt('deploy.failed', 'web #7'));

    expect(deploys).toEqual([{ status: 'failed', serviceName: 'web', deploymentId: 7 }]);
  });

  it('emits only the firehose for an unmapped action', () => {
    const src = fakeSource();
    const bus = new EventBus();
    const deploys: unknown[] = [];
    const raw: unknown[] = [];
    bus.on('deployment.status_changed', (p) => void deploys.push(p));
    bus.on('audit.recorded', (p) => void raw.push(p));
    bridgeAuditEvents(src.subscribe, bus);

    src.publish(evt('workspace.create', 'Acme'));

    expect(deploys).toHaveLength(0);
    expect(raw).toHaveLength(1);
  });

  it('detaches cleanly so a restarted kernel does not double-subscribe', () => {
    const src = fakeSource();
    const bus = new EventBus();
    const detach = bridgeAuditEvents(src.subscribe, bus);
    expect(src.size()).toBe(1);
    detach();
    expect(src.size()).toBe(0);
  });

  it('survives a plugin listener that throws', () => {
    // The audit path rides on this subscription; a badly-behaved plugin must
    // not be able to break it.
    const src = fakeSource();
    const bus = new EventBus();
    bus.on('audit.recorded', () => {
      throw new Error('bad plugin');
    });
    bridgeAuditEvents(src.subscribe, bus);
    expect(() => src.publish(evt('auth.login'))).not.toThrow();
  });
});

describe('the plugin marketplace refuses to pretend', () => {
  const kernel = { getPlugin: () => undefined, registerPlugin: vi.fn(), events: { emit: vi.fn() } };
  const db = { query: { installedPlugins: { findFirst: vi.fn(async () => undefined) } } };

  it('only treats the official catalog as loadable', () => {
    expect(isLoadableSource('marketplace')).toBe(true);
    for (const source of ['npm', 'git', 'local']) expect(isLoadableSource(source)).toBe(false);
  });

  it('refuses an npm or git install instead of creating an inert row', async () => {
    for (const source of ['npm', 'git'] as const) {
      await expect(
        installPlugin(db as never, kernel as never, { source, target: 'some-plugin' } as never),
      ).rejects.toBeInstanceOf(UnsupportedPluginSourceError);
    }
    expect(kernel.registerPlugin).not.toHaveBeenCalled();
  });

  it('refuses a catalog entry that has no behaviour behind it', async () => {
    await expect(
      installPlugin(db as never, kernel as never, { source: 'marketplace', target: 's3-backups' } as never),
    ).rejects.toBeInstanceOf(UnimplementedPluginError);
  });

  it('points at the shipped feature an entry shadows', async () => {
    // This is the whole point: the capability exists, just not as a "plugin".
    await expect(
      installPlugin(db as never, kernel as never, { source: 'marketplace', target: 's3-backups' } as never),
    ).rejects.toThrow(/Backups → Storage destinations/);
  });

  it('every catalog entry declares whether it is implemented', () => {
    // A new entry must opt IN to being installable, so the next person adding
    // one cannot accidentally recreate the trap.
    for (const entry of MARKETPLACE_CATALOG) {
      expect(entry, entry.id).toHaveProperty('implemented');
    }
  });

  it('names a built-in alternative for every entry that shadows one', () => {
    const shadowing = ['s3-backups', 'slack-alerts', 'discord-alerts', 'telegram-bot', 'cloudflare-dns', 'vault-secrets'];
    for (const id of shadowing) {
      const entry = MARKETPLACE_CATALOG.find((m) => m.id === id);
      expect(entry?.builtIn, id).toBeDefined();
    }
  });
});

/**
 * The catalog is a roadmap index whose whole value is pointing the operator at
 * the feature that DOES exist. A pointer that lands on the wrong page is a
 * smaller version of the install button that lied.
 */
describe('MARKETPLACE_CATALOG builtIn pointers', () => {
  /** Panel routes, from `apps/web/src/App.tsx`. */
  const PANEL_ROUTES = new Set([
    '/', '/workspaces', '/projects', '/labels', '/services', '/hub', '/manifest-creator',
    '/databases', '/domains', '/tunnels', '/users', '/volumes', '/networks', '/docker',
    '/topology', '/backups', '/sources', '/servers', '/settings', '/about', '/monitoring',
    '/activity', '/traefik',
  ]);
  /** Settings section ids, from `apps/web/src/routes/settings/index.tsx`. */
  const SETTINGS_SECTIONS = new Set([
    'account', 'appearance', 'security', 'sso', 'integrations', 'notifications',
    'log-drains', 'firewall', 'storage', 'config', 'plugins', 'system', 'migration',
  ]);

  it('every pointer names a real panel route', () => {
    for (const entry of MARKETPLACE_CATALOG) {
      if (!entry.builtIn) continue;
      const [path, query] = entry.builtIn.path.split('?');
      expect(PANEL_ROUTES.has(path!), `${entry.id} → ${path}`).toBe(true);
      if (query) {
        // Settings selects its page with `?section=`, not `?tab=`.
        const params = new URLSearchParams(query);
        expect([...params.keys()], `${entry.id} query keys`).toEqual(['section']);
        expect(SETTINGS_SECTIONS.has(params.get('section')!), `${entry.id} → ${query}`).toBe(true);
      }
    }
  });

  it('nothing in the catalog claims to be implemented yet', () => {
    // The day one becomes real, this flips — and `installPlugin` stops refusing
    // it. Until then a `true` here would put back the install button that lied.
    expect(MARKETPLACE_CATALOG.filter((e) => e.implemented === true)).toEqual([]);
  });
});

/**
 * Every key a built-in plugin declares must be read by something.
 *
 * A `configSchema` entry is not documentation: the panel renders it as an
 * editable field and persists whatever the operator types, encrypting it when
 * `isSecret`. A key nothing reads is therefore a control that silently does
 * nothing — the worst kind, because the panel confirms the save. This has now
 * happened five times across four plugins, so it gets a guard rather than
 * another round of review.
 *
 * The check is a source scan: for each declared `<category>:<key>`, some file
 * under `src/` other than the declaring plugin itself must mention the full
 * dotted key. That is exactly how every real consumer reads one
 * (`configCenter.get('plugin:x:y', …)`), and it is cheap enough to run on
 * every commit.
 */
describe('no plugin declares a setting nothing reads', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const srcDir = path.join(here, '..', 'src');
  const pluginsDir = path.join(srcDir, 'kernel', 'plugins');

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return full.endsWith('.ts') ? [full] : [];
    });
  }

  const sourceFiles = walk(srcDir);

  it('every configSchema key is consulted somewhere in src/', async () => {
    const orphans: string[] = [];

    for (const file of readdirSync(pluginsDir).filter((f) => f.endsWith('.ts'))) {
      const mod = (await import(path.join(pluginsDir, file))) as Record<string, unknown>;
      for (const exported of Object.values(mod)) {
        if (typeof exported !== 'function') continue;
        let instance: { configSchema?: Array<{ key: string; category?: string }> };
        try {
          instance = new (exported as new () => never)() as never;
        } catch {
          continue; // constructor needs arguments — not a zero-arg built-in plugin
        }
        for (const entry of instance.configSchema ?? []) {
          if (!entry?.category) continue;
          const fullKey = `${entry.category}:${entry.key}`;
          // The declaring file counts: a plugin reading its own key with
          // `configCenter.get('plugin:x:y', …)` is a real consumer. The schema
          // entry itself never spells the dotted key out (it is `category` +
          // `key` as two fields), so scanning for the joined string finds
          // reads only — never the declaration that produced it.
          // Some readers build the key by interpolation, e.g. config-presets'
          // `${await namespace()}:preset.list`. Those still spell out the
          // `:<key>` suffix in a file that also names the plugin's namespace,
          // so accept that shape too rather than forcing a literal.
          const readSomewhere = sourceFiles.some((f) => {
            const text = readFileSync(f, 'utf8');
            if (text.includes(fullKey)) return true;
            return text.includes(`:${entry.key}\``) && text.includes(entry.category!);
          });
          if (!readSomewhere) orphans.push(`${fullKey} (declared in kernel/plugins/${file})`);
        }
      }
    }

    expect(orphans).toEqual([]);
  });
});
