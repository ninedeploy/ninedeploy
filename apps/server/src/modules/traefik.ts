import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { CORE_SCHEMA, load } from 'js-yaml';
import { config } from '../config.js';
import { capture, run } from '../lib/exec.js';
import { audit } from '../lib/audit.js';
import { pullDockerImage } from '../lib/dockerPull.js';
import {
  customConfigPath,
  ensureNetwork,
  ensureTraefik,
  generatedConfigPath,
  legacyDynamicPath,
  readCertificates,
  TRAEFIK_CONTAINER,
  TRAEFIK_IMAGE,
  traefikInputs,
} from '../engine/proxy.js';
import {
  buildCertificateInventory,
  expiringWithin,
} from '../lib/certificateInventory.js';
import type { FastifyPluginAsync } from 'fastify';

/** Traefik container durumu */
export interface TraefikStatus {
  running: boolean;
  version: string | null;
  versionLatest: string | null;
  outdated: boolean;
  uptime: string | null;
  ports: { http: number; https: number };
  configDir: string;
}

/** Sertifika bilgisi */
export interface TraefikCertificate {
  domain: string;
  expiresAt: string | null;
  daysUntilExpiry: number | null;
  issuer: string | null;
}

/** Router bilgisi */
export interface TraefikRouter {
  name: string;
  rule: string;
  service: string;
  entryPoints: string[];
  tls: boolean;
  middleware: string[];
}

/** Service bilgisi */
export interface TraefikService {
  name: string;
  url: string;
  loadBalancer: string;
}

/** Middleware bilgisi */
export interface TraefikMiddleware {
  name: string;
  type: string;
  config: Record<string, unknown>;
}

/** Traefik genel bilgi */
export interface TraefikInfo {
  status: TraefikStatus;
  certificates: TraefikCertificate[];
  routers: TraefikRouter[];
  services: TraefikService[];
  middlewares: TraefikMiddleware[];
}

/** Container uptime hesapla */
function parseUptime(startedAt: string): string {
  const started = new Date(startedAt).getTime();
  const diff = Date.now() - started;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/** En son Traefik v3 versiyonunu Docker Hub'dan al */
async function getLatestTraefikVersion(): Promise<string | null> {
  try {
    const out = await capture('docker', ['search', '--format', '{{.Tag}}', 'traefik:3']);
    const tags = out.split('\n').filter(Boolean);
    // v3 tag'leri arasından en yüksek semver'i bul
    const v3Tags = tags.filter((t) => t.startsWith('3.'));
    if (v3Tags.length === 0) return null;
    
    // Semver karşılaştırması
    const sorted = v3Tags.sort((a, b) => {
      const pA = a.split('.').map((n) => Number(n) || 0);
      const pB = b.split('.').map((n) => Number(n) || 0);
      return (pB[0]! - pA[0]!) || (pB[1]! - pA[1]!) || (pB[2]! - pA[2]!);
    });
    
    return sorted[0]!;
  } catch {
    return null;
  }
}

/** İki versiyonu karşılaştır (outdated mı?) */
function isOutdated(current: string | null, latest: string | null): boolean {
  if (!current || !latest) return false;
  const [cm = 0, cs = 0, cp = 0] = current.split('.').map(Number);
  const [lm = 0, ls = 0, lp = 0] = latest.split('.').map(Number);
  if (lm !== cm) return lm > cm;
  if (ls !== cs) return ls > cs;
  return lp > cp;
}

/** Traefik container bilgilerini al */
async function getTraefikContainerInfo(): Promise<TraefikStatus> {
  const dataDir = config.paths.dataDir;
  const latestVersion = await getLatestTraefikVersion();

  try {
    const inspect = await capture('docker', ['inspect', TRAEFIK_CONTAINER, '--format', '{{json .State}}']);
    const state = JSON.parse(inspect) as { Running: boolean; StartedAt: string };

    // Container liveness must never depend on version probing. The official
    // image exposes `traefik` through PATH, while NineDeploy's layer-free
    // recovery image intentionally contains only `/traefik` and CA roots.
    // Probe both locations, but preserve the inspected running state if neither
    // command is available or its output format changes.
    let currentVersion: string | null = null;
    if (state.Running) {
      for (const binary of ['/traefik', 'traefik']) {
        try {
          const versionOut = await capture('docker', ['exec', TRAEFIK_CONTAINER, binary, 'version']);
          const versionMatch = versionOut.match(/version(?::|\s)+\s*v?([\d.]+)/i);
          if (versionMatch?.[1]) {
            currentVersion = versionMatch[1];
            break;
          }
        } catch {
          // Try the alternate binary location; version is optional metadata.
        }
      }
    }

    return {
      running: state.Running,
      version: currentVersion,
      versionLatest: latestVersion,
      outdated: isOutdated(currentVersion, latestVersion),
      uptime: state.Running ? parseUptime(state.StartedAt) : null,
      ports: { http: 80, https: 443 },
      configDir: `${dataDir}/traefik`,
    };
  } catch {
    return {
      running: false,
      version: null,
      versionLatest: latestVersion,
      outdated: isOutdated(null, latestVersion),
      uptime: null,
      ports: { http: 80, https: 443 },
      configDir: `${dataDir}/traefik`,
    };
  }
}

/** Sertifika bilgilerini işle */
function processCertificates(): TraefikCertificate[] {
  const certs = readCertificates();
  return certs.map((cert) => {
    let daysUntilExpiry: number | null = null;
    if (cert.expiresAt) {
      const diff = cert.expiresAt.getTime() - Date.now();
      daysUntilExpiry = Math.ceil(diff / (1000 * 60 * 60 * 24));
    }
    return {
      domain: cert.domain,
      expiresAt: cert.expiresAt?.toISOString() ?? null,
      daysUntilExpiry,
      // D4: the parsed issuer when there is one; an ACME entry whose PEM did
      // not parse keeps 0.13's label.
      issuer: cert.issuer ?? (cert.source === 'custom' ? null : 'Let\'s Encrypt'),
    };
  });
}

/** Traefik loglarını al */
async function getTraefikLogs(lines: number = 100): Promise<string[]> {
  try {
    const output = await capture('docker', ['logs', '--tail', String(lines), '--timestamps', TRAEFIK_CONTAINER]);
    return output.split('\n').filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

/** The routing tables of one dynamic file. */
interface TraefikTables {
  routers: TraefikRouter[];
  services: TraefikService[];
  middlewares: TraefikMiddleware[];
}

/**
 * 0.14 (M11): the generated routes live in `dynamic/ninedeploy.yml`; until
 * the first 0.14 Traefik heal moved them they are still in `dynamic.yml`.
 * `custom` lists what the operator's `custom.yml` defines, separately.
 */
async function getTraefikConfig(): Promise<TraefikTables & { custom: TraefikTables }> {
  const generated = existsSync(generatedConfigPath()) ? generatedConfigPath() : legacyDynamicPath();
  return { ...(await parseGeneratedConfig(generated)), custom: parseCustomConfig(customConfigPath()) };
}

/** Routers, services and middlewares the operator's custom file defines (`http` and `tcp`). */
function parseCustomConfig(file: string): TraefikTables {
  const out: TraefikTables = { routers: [], services: [], middlewares: [] };
  try {
    if (!existsSync(file)) return out;
    const doc = load(readFileSync(file, 'utf8'), { schema: CORE_SCHEMA });
    const obj = (v: unknown): Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    for (const proto of ['http', 'tcp']) {
      const section = obj(obj(doc)[proto]);
      for (const [name, r] of Object.entries(obj(section['routers']))) {
        const ro = obj(r);
        out.routers.push({
          name,
          rule: typeof ro['rule'] === 'string' ? ro['rule'] : '',
          service: typeof ro['service'] === 'string' ? ro['service'] : '',
          entryPoints: strs(ro['entryPoints']),
          tls: ro['tls'] !== undefined,
          middleware: strs(ro['middlewares']),
        });
      }
      for (const [name, sv] of Object.entries(obj(section['services']))) {
        const servers = obj(obj(sv)['loadBalancer'])['servers'];
        const first = Array.isArray(servers) ? obj(servers[0]) : {};
        const url = first['url'] ?? first['address'];
        out.services.push({ name, url: typeof url === 'string' ? url : '', loadBalancer: 'roundRobin' });
      }
      for (const [name, mw] of Object.entries(obj(section['middlewares']))) {
        const [type = 'custom', cfg] = Object.entries(obj(mw))[0] ?? [];
        out.middlewares.push({ name, type, config: obj(cfg) });
      }
    }
    return out;
  } catch {
    return { routers: [], services: [], middlewares: [] };
  }
}

/** Hand-parse the generated route file (its layout is ours; see renderDynamicConfig). */
async function parseGeneratedConfig(dynamicPath: string): Promise<TraefikTables> {
  try {
    if (!existsSync(dynamicPath)) {
      return { routers: [], services: [], middlewares: [] };
    }
    const content = readFileSync(dynamicPath, 'utf8').replace(/\r\n/g, '\n');
    // Basit YAML parser - gerçek uygulamada yaml paketi kullanılabilir
    const routers: TraefikRouter[] = [];
    const services: TraefikService[] = [];
    const middlewares: TraefikMiddleware[] = [];
    
    const RESERVED_KEYS = new Set([
      'rule', 'service', 'entryPoints', 'middlewares', 'tls', 'servers',
      'loadBalancer', 'redirectRegex', 'headers', 'customResponseHeaders', 'compress',
    ]);

    const lines = content.split('\n');
    let section: 'routers' | 'services' | 'middlewares' | null = null;
    let currentRouter: Partial<TraefikRouter> | null = null;
    let currentService: Partial<TraefikService> | null = null;
    let currentMw: Partial<TraefikMiddleware> | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      if (trimmed === 'routers:' || trimmed === 'http.routers:') {
        section = 'routers';
        continue;
      }
      if (trimmed === 'services:' || trimmed === 'http.services:') {
        section = 'services';
        continue;
      }
      if (trimmed === 'middlewares:' && (line.startsWith('  middlewares:') || line.startsWith('middlewares:'))) {
        section = 'middlewares';
        continue;
      }
      if (line.startsWith('tls:') || (line.startsWith('  tls:') && !line.includes('{')) || (!line.startsWith(' ') && trimmed.endsWith(':'))) {
        section = null;
        continue;
      }

      if (section === 'routers') {
        const itemMatch = line.match(/^ {4}([a-zA-Z0-9_-]+):\s*$/);
        if (itemMatch && !RESERVED_KEYS.has(itemMatch[1]!)) {
          if (currentRouter?.name) {
            routers.push(currentRouter as TraefikRouter);
          }
          currentRouter = {
            name: itemMatch[1]!,
            rule: '',
            service: '',
            entryPoints: [],
            tls: false,
            middleware: [],
          };
        } else if (currentRouter) {
          if (trimmed.startsWith('rule:')) {
            // F169: renderDynamicConfig writes rules as double-quoted YAML
            // (yamlDoubleQuoted escapes `\` and `"`); decode those escapes so
            // the reported rule is the one Traefik loads.
            const rawRule = trimmed.slice(5).trim();
            currentRouter.rule =
              rawRule.length >= 2 && rawRule.startsWith('"') && rawRule.endsWith('"')
                ? rawRule.slice(1, -1).replace(/\\(["\\])/g, '$1')
                : rawRule.replace(/^["']|["']$/g, '');
          } else if (trimmed.startsWith('service:')) {
            currentRouter.service = trimmed.slice(8).trim();
          } else if (trimmed.startsWith('- web') || trimmed.startsWith('- http')) {
            currentRouter.entryPoints?.push(trimmed.replace(/^-\s*/, ''));
          } else if (trimmed.startsWith('tls:')) {
            currentRouter.tls = true;
          } else if (trimmed.startsWith('- mw_')) {
            currentRouter.middleware?.push(trimmed.replace(/^-\s*/, ''));
          }
        }
      } else if (section === 'services') {
        const itemMatch = line.match(/^ {4}([a-zA-Z0-9_-]+):\s*$/);
        if (itemMatch && !RESERVED_KEYS.has(itemMatch[1]!)) {
          if (currentService?.name) {
            services.push(currentService as TraefikService);
          }
          currentService = {
            name: itemMatch[1]!,
            url: '',
            loadBalancer: 'roundRobin',
          };
        } else if (currentService && trimmed.includes('url:')) {
          currentService.url = trimmed.replace(/^.*?url:\s*/, '').trim().replace(/^["']|["']$/g, '');
        }
      } else if (section === 'middlewares') {
        const itemMatch = line.match(/^ {4}([a-zA-Z0-9_-]+):\s*$/);
        if (itemMatch && !RESERVED_KEYS.has(itemMatch[1]!)) {
          if (currentMw?.name) {
            middlewares.push(currentMw as TraefikMiddleware);
          }
          currentMw = {
            name: itemMatch[1]!,
            type: 'custom',
            config: {},
          };
        }
      }
    }

    if (currentRouter?.name) routers.push(currentRouter as TraefikRouter);
    if (currentService?.name) services.push(currentService as TraefikService);
    if (currentMw?.name) middlewares.push(currentMw as TraefikMiddleware);
    
    return { routers, services, middlewares };
  } catch {
    return { routers: [], services: [], middlewares: [] };
  }
}

/** Traefik API routes */
export const traefikRoutes: FastifyPluginAsync = async (app) => {
  // Genel bilgi. The routing tables and certificate list map out every
  // tenant's hostnames on the instance (same inventory L-12 protects on
  // /traefik/config), so members only get the status banner — arrays stay
  // empty rather than 403 so the shared UI page degrades gracefully.
  app.get('/traefik', { preHandler: [app.authenticate] }, async (req) => {
    const status = await getTraefikContainerInfo();
    if (!req.user!.isOperator) {
      return {
        status,
        certificates: [],
        routers: [],
        services: [],
        middlewares: [],
      } satisfies TraefikInfo;
    }
    const config = await getTraefikConfig();
    return {
      status,
      certificates: processCertificates(),
      routers: config.routers,
      services: config.services,
      middlewares: config.middlewares,
    } satisfies TraefikInfo;
  });

  // Sadece status
  app.get('/traefik/status', { preHandler: [app.authenticate, app.requireAdmin] }, async () => {
    return getTraefikContainerInfo();
  });

  // Sertifikalar
  app.get('/traefik/certificates', { preHandler: [app.authenticate, app.requireAdmin] }, async () => {
    return processCertificates();
  });

  // Richer inventory view used by the Certificates page. r157: admin-only,
  // like /traefik/certificates — the list names every tenant's domain on the
  // instance (the L-12 rule the overview route already applies).
  app.get<{ Querystring: { threshold?: string } }>(
    '/traefik/certificates/inventory',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (req) => {
      const threshold = Number(req.query.threshold) > 0 ? Number(req.query.threshold) : 30;
      return buildCertificateInventory(threshold);
    },
  );

  // Focused "expiring within N days" filter. The query
  // string `?days=30` (default) is what the alert path
  // uses to page the operator before a cert falls over.
  app.get<{ Querystring: { days?: string } }>(
    '/traefik/certificates/expiring',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (req) => {
      const days = Number(req.query.days) > 0 ? Number(req.query.days) : 30;
      const report = await buildCertificateInventory(days);
      return {
        threshold: days,
        count: report.certificates.filter((c) => c.daysToExpiry !== null && c.daysToExpiry <= days).length,
        certificates: expiringWithin(report, days),
      };
    },
  );

  // Loglar
  app.get('/traefik/logs', { preHandler: [app.authenticate, app.requireAdmin] }, async (req) => {
    // F168: a negative count is truthy, so `|| 100` let `lines=-1` through as
    // `docker logs --tail -1` (= every line) and `.slice(1)`. Clamp to 1..500.
    const requested = Math.trunc(Number((req.query as { lines?: string })?.lines));
    const lines = requested > 0 ? Math.min(requested, 500) : 100;
    const logs = await getTraefikLogs(lines);
    return { logs };
  });

  // Konfigürasyon
  app.get('/traefik/config', { preHandler: [app.authenticate, app.requireAdmin] }, async () => {
    return getTraefikConfig();
  });

  // Traefik'i yeniden başlat (admin only)
  // F612: POST routes authenticate at onRequest (before the body is read and
  // parsed, the r098 rule); a preHandler ran only after parsing.
  app.post('/traefik/restart', { onRequest: [app.authenticate], preHandler: [app.requireAdmin] }, async (req) => {
    try {
      await capture('docker', ['restart', TRAEFIK_CONTAINER]);
      void audit(app.db, req.user!.id, 'traefik.restart');
      return { ok: true, message: 'Traefik restarted' };
    } catch (err) {
      throw new Error(`Failed to restart Traefik: ${err}`);
    }
  });

  // ACME dosyasını yedekle
  app.post('/traefik/backup-certs', { onRequest: [app.authenticate], preHandler: [app.requireAdmin] }, async (req) => {
    // Resolve through config (which anchors relative data dirs to the repo
    // root) — reading the env var directly followed the process cwd, so a
    // restart from a different directory silently backed up the WRONG
    // acme.json (or threw).
    const dataDir = config.paths.dataDir;
    const acmePath = `${dataDir}/traefik/acme.json`;
    const backupPath = `${dataDir}/traefik/acme-backup-${Date.now()}.json`;
    
    try {
      copyFileSync(acmePath, backupPath);
      void audit(app.db, req.user!.id, 'traefik.backup_certs', backupPath);
      return { ok: true, backupPath };
    } catch {
      throw new Error('Failed to backup certificates');
    }
  });

  // Traefik versiyonunu kontrol et
  app.get('/traefik/version', { preHandler: [app.authenticate, app.requireAdmin] }, async () => {
    const latest = await getLatestTraefikVersion();
    const current = await getTraefikContainerInfo();
    return {
      current: current.version,
      latest,
      outdated: isOutdated(current.version, latest),
      image: TRAEFIK_IMAGE,
    };
  });

  // Traefik'i güncelle (pull new image + restart)
  app.post('/traefik/update', { onRequest: [app.authenticate], preHandler: [app.requireAdmin] }, async (req) => {
    const log = (line: string) => app.log.info({ component: 'traefik-update' }, line);
    
    log('Starting Traefik update...');
    
    // 1. ACME dosyasını yedekle (config-anchored — see backup-certs above)
    const dataDir = config.paths.dataDir;
    const acmePath = `${dataDir}/traefik/acme.json`;
    const backupPath = `${dataDir}/traefik/acme-backup-${Date.now()}.json`;
    
    if (existsSync(acmePath)) {
      copyFileSync(acmePath, backupPath);
      log(`Certificate backup saved to ${backupPath}`);
    }
    
    // 2. Yeni image'ı çek
    log(`Pulling ${TRAEFIK_IMAGE}...`);
    await pullDockerImage(TRAEFIK_IMAGE, (l) => log(l));
    
    // 3. Eski container'ı sil
    log('Removing old container...');
    await run('docker', ['rm', '-f', TRAEFIK_CONTAINER], {}, (l) => log(l));
    
    // 4. Recreate through the canonical lifecycle so config fingerprints,
    // ACME mounts, DNS credentials, host gateway and liveness checks cannot
    // drift from startup/watchdog behavior.
    log('Starting new container...');
    await ensureNetwork(log);
    const t = await traefikInputs(app.db);
    await ensureTraefik(log, t.acmeEmail, t.dns, t);
    
    const newVersion = await getLatestTraefikVersion();
    log(`Traefik updated to ${newVersion}`);
    void audit(app.db, req.user!.id, 'traefik.update', newVersion ?? 'latest');
    
    return { ok: true, newVersion };
  });
};
