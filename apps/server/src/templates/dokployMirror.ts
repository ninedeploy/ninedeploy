import path from 'node:path';
import yaml from 'js-yaml';
import { preflightCompose } from '../engine/magicVars.js';
import {
  CATEGORY_EMOJI,
  composeServiceRefusal,
  declareImplicitVolumes,
  displayImage,
  extractConfigurableEnv,
  titleCaseCategory,
  titleFromSlug,
  type MirrorSkip,
  type ServiceEntry,
} from './mirror.js';
import { composeServiceKey } from '../engine/magicVars.js';
import type { Template } from './registry.js';

/**
 * G4.7: converter for Dokploy blueprints (`Dokploy/templates`,
 * `blueprints/<id>/{template.toml, docker-compose.yml, meta.json}`, MIT) into
 * NineDeploy compose-stack templates, next to the Coolify mirror.
 *
 * A blueprint keeps its settings outside the compose file: `[variables]` with
 * generators (`${password:32}`, `${domain}`, …), `[config.env]` written to the
 * stack's `.env`, `[[config.domains]]` for routing and `[[config.mounts]]` for
 * files. The converter folds the env into the compose text, turning each
 * generator into the `SERVICE_*` magic token that produces the same kind of
 * value at deploy time and is kept across redeploys:
 *
 *   ${domain}              → ${SERVICE_FQDN_<routed service>}
 *   ${password[:N]}        → ${SERVICE_PASSWORD_<N>_<VAR>}       (N alphanumerics, 16 by default)
 *   ${base64[:32|64|128]}  → ${SERVICE_REALBASE64_<N>_<VAR>}     (base64 of N random bytes)
 *   ${hash:32|64|128}      → ${SERVICE_HEX_<N>_<VAR>}            (N hex characters)
 *   ${username}            → ${SERVICE_LOWERCASEUSER_<VAR>}
 *   ${email}               → ${SERVICE_LOWERCASEUSER_<VAR>}@example.com
 *
 * Anything without a faithful equivalent skips the blueprint with the reason,
 * never a degraded copy: file mounts, more than one routed service or port,
 * `${uuid}`, `${jwt}`, timestamps, `${randomPort}`, other generator sizes, and
 * every compose shape the Coolify mirror refuses (`composeServiceRefusal`,
 * `preflightCompose`).
 */

/** Host files a stack may read: the clock settings, read-only. */
const READ_ONLY_HOST_BINDS = new Set(['/etc/localtime', '/etc/timezone']);

/**
 * A Hub template must not reach the host: a bind source that is absolute or
 * in a home directory (`/root:/data`), that climbs out of the stack's
 * directory anywhere in its path (`../files/x`, `./a/../../x`), or that is
 * interpolated refuses the blueprint; so does a top-level volume that binds
 * through its driver (`driver_opts`, another driver, `external`), and a
 * service that is privileged, shares the host's pid or ipc namespace, or
 * maps host devices. Named volumes, `./` paths inside the stack and the
 * read-only clock files stay. Checked on the blueprint and again on the
 * converted file, so folding values in cannot bring one back.
 */
/**
 * The service keys a Hub stack may use. Anything else (cap_add, security_opt,
 * userns_mode, cgroup*, sysctls, devices, privileged, pid/ipc, volumes_from,
 * runtime, …) can loosen the container's isolation, so it refuses the
 * blueprint instead of being reviewed key by key.
 */
const SAFE_SERVICE_KEYS = new Set([
  'image', 'command', 'entrypoint', 'environment', 'volumes', 'depends_on', 'restart', 'healthcheck', 'labels',
  'expose', 'ports', 'networks', 'working_dir', 'user', 'hostname', 'logging', 'deploy', 'ulimits', 'shm_size',
  'tmpfs', 'stop_grace_period', 'stop_signal', 'init', 'tty', 'stdin_open', 'read_only', 'mem_limit',
  'mem_reservation', 'cpus', 'platform', 'extra_hosts', 'dns', 'links', 'container_name', 'domainname',
  'pull_policy', 'scale', 'network_mode', 'profiles',
]);

export function hostBindRefusal(doc: { services?: unknown; volumes?: unknown; networks?: unknown; secrets?: unknown; configs?: unknown } | null | undefined): string | null {
  const services = (doc?.services && typeof doc.services === 'object' ? doc.services : {}) as Record<string, ServiceEntry>;
  for (const [key] of Object.entries(doc ?? {})) {
    if (key === 'secrets' || key === 'configs') return `declares top-level ${key} (they can read host files)`;
  }
  for (const [name, entry] of Object.entries(services)) {
    // Fail closed: the loop below reads every entry's keys, so a null or scalar service must not slip past.
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `service '${name}' is not a mapping`;
    for (const key of Object.keys(entry)) {
      if (!SAFE_SERVICE_KEYS.has(key) && !key.startsWith('x-')) return `service '${name}' uses ${key}`;
    }
    // A build reads files from the host; Hub stacks run published images only.
    const pp = (entry as { pull_policy?: unknown }).pull_policy;
    if (typeof pp === 'string' && pp.trim() === 'build') return `service '${name}' uses pull_policy build`;
    const nm = (entry as { network_mode?: unknown }).network_mode;
    if (typeof nm === 'string' && nm.trim() !== '' && !['bridge', 'none'].includes(nm.trim())) return `service '${name}' joins network mode ${nm}`;
  }
  for (const [name, entry] of Object.entries(services)) {
    const e = entry as { volumes?: unknown; privileged?: unknown; pid?: unknown; ipc?: unknown; devices?: unknown };
    if (e.privileged === true || e.privileged === 'true') return `service '${name}' runs privileged`;
    if (typeof e.pid === 'string' && e.pid.trim() === 'host') return `service '${name}' shares the host's pid namespace`;
    if (typeof e.ipc === 'string' && e.ipc.trim() === 'host') return `service '${name}' shares the host's ipc namespace`;
    if (Array.isArray(e.devices) && e.devices.length > 0) return `service '${name}' maps host devices`;
    if (!Array.isArray(e.volumes)) continue;
    for (const v of e.volumes) {
      let source: string | null = null;
      let readOnly = false;
      if (typeof v === 'string') {
        const parts = v.split(':');
        if (parts.length < 2) continue; // an anonymous volume
        source = parts[0] ?? '';
        readOnly = parts.slice(2).some((o) => o.split(',').includes('ro'));
      } else if (v && typeof v === 'object') {
        const t = (v as { type?: unknown }).type;
        if (t !== undefined && t !== 'volume' && t !== 'bind' && t !== 'tmpfs') return `service '${name}' uses a ${String(t)} mount`;
        if (t === 'bind') {
          source = String((v as { source?: unknown }).source ?? '');
          readOnly = (v as { read_only?: unknown }).read_only === true;
        }
      }
      if (source === null) continue;
      if (source.includes('$')) return `service '${name}' interpolates a bind mount source`;
      if (source.startsWith('~')) return `service '${name}' mounts a path outside the stack (${source})`;
      // Any `..` segment, before or after normalising (`./a/../../x`, `a\..\x`).
      const segments = source.split(/[\\/]+/);
      const normalised = path.posix.normalize(source.replace(/\\/g, '/'));
      if (segments.includes('..') || normalised === '..' || normalised.startsWith('../')) return `service '${name}' mounts a path outside the stack (${source})`;
      const looksAbsolute = source.startsWith('/') || source.startsWith('\\') || /^[A-Za-z]:/.test(source);
      if (looksAbsolute && !(READ_ONLY_HOST_BINDS.has(normalised) && readOnly)) return `service '${name}' mounts the host path ${source}`;
      // A source that is neither ./relative, absolute nor a plain volume name is not something we can reason about.
      if (!looksAbsolute && !source.startsWith('.') && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source)) return `service '${name}' mounts an unusual source (${source})`;
    }
  }
  const topNetworks = (doc as { networks?: unknown } | null | undefined)?.networks;
  if (topNetworks && typeof topNetworks === 'object') {
    for (const [net, spec] of Object.entries(topNetworks as Record<string, unknown>)) {
      if (!spec || typeof spec !== 'object') continue;
      const s = spec as { driver?: unknown; driver_opts?: unknown; external?: unknown; name?: unknown };
      // A fixed name or an external network joins another stack's (or the host's) network.
      if (s.name !== undefined) return `network '${net}' sets a fixed name`;
      if (s.external !== undefined && s.external !== false) return `network '${net}' is external`;
      if (s.driver_opts !== undefined) return `network '${net}' sets driver options`;
      if (s.driver !== undefined && s.driver !== 'bridge') return `network '${net}' uses the ${String(s.driver)} driver`;
    }
  }
  const topVolumes = doc?.volumes;
  if (topVolumes && typeof topVolumes === 'object') {
    for (const [vol, spec] of Object.entries(topVolumes as Record<string, unknown>)) {
      if (!spec || typeof spec !== 'object') continue;
      const s = spec as { driver?: unknown; driver_opts?: unknown; external?: unknown; name?: unknown };
      // A fixed name escapes the stack's project scope and can share another stack's volume.
      if (s.name !== undefined) return `volume '${vol}' sets a fixed name`;
      if (s.driver_opts !== undefined) return `volume '${vol}' sets driver options (it can bind a host path)`;
      if (s.driver !== undefined && s.driver !== 'local') return `volume '${vol}' uses the ${String(s.driver)} driver`;
      if (s.external !== undefined && s.external !== false) return `volume '${vol}' is external`;
    }
  }
  return null;
}

export interface DokployBlueprint {
  /** The blueprint directory name. */
  id: string;
  /** Parsed `meta.json` (name, description, tags, links). */
  meta: Record<string, unknown>;
  /** Parsed `template.toml`. */
  config: unknown;
  /** `docker-compose.yml` as text. */
  compose: string;
}

export interface DokployConverted {
  skip: false;
  template: Template;
}

type Segment = { lit: string } | { token: string };
type Expr = Segment[];

class Refusal extends Error {}

/** A compose-safe rendering: literal `$` doubled, tokens interpolated. */
function render(expr: Expr): string {
  return expr.map((s) => ('lit' in s ? s.lit.replace(/\$/g, () => '$$') : `\${${s.token}}`)).join('');
}

const tokenKey = (name: string): string => name.toUpperCase().replace(/[^A-Z0-9]/g, '_').replace(/^_+/, '') || 'VALUE';

const NO_EQUIVALENT = new Set(['uuid', 'jwt', 'timestamp', 'timestamps', 'timestampms', 'randomPort']);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined);

/** The blueprint's env as KEY → raw value, from a table or a `["K=V", …]` / `[{K = V}]` array. */
function envEntries(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const add = (k: string, v: unknown) => {
    const value = str(v);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && value !== undefined) out.set(k, value);
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') {
        const eq = item.indexOf('=');
        if (eq > 0) add(item.slice(0, eq).trim(), item.slice(eq + 1));
      } else if (item && typeof item === 'object') {
        for (const [k, v] of Object.entries(item)) add(k, v);
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) add(k, v);
  }
  return out;
}

/** Same object keys, array lengths and value kinds; strings may differ. */
function sameShape(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' || typeof b === 'string') return typeof a === typeof b || (a === null) === (b === null);
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameShape(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameShape((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return typeof a === typeof b;
}

export function convertDokployBlueprint(bp: DokployBlueprint): MirrorSkip | DokployConverted {
  try {
    return { skip: false, template: convert(bp) };
  } catch (err) {
    if (err instanceof Refusal) return { skip: true, reason: err.message };
    throw err;
  }
}

function convert(bp: DokployBlueprint): Template {
  const cfg = (bp.config && typeof bp.config === 'object' ? bp.config : {}) as {
    variables?: Record<string, unknown>;
    config?: { domains?: unknown; env?: unknown; mounts?: unknown };
  };
  const mounts = cfg.config?.mounts;
  if (Array.isArray(mounts) && mounts.length > 0) throw new Refusal('writes files into the stack (config.mounts)');

  // ── routing ──────────────────────────────────────────────────────────────
  const domains = (Array.isArray(cfg.config?.domains) ? cfg.config.domains : []) as Array<Record<string, unknown>>;
  const routed = domains.filter((d) => typeof d['serviceName'] === 'string' && d['serviceName']);
  if (routed.length === 0) throw new Refusal('no routed HTTP service (config.domains)');
  const targets = new Set(routed.map((d) => `${String(d['serviceName'])}:${String(d['port'])}`));
  if (targets.size > 1) throw new Refusal('routes more than one service or port');
  const main = routed[0]!;
  const mainService = String(main['serviceName']);
  const port = Number(main['port']);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Refusal('no valid routed port');
  if (routed.some((d) => typeof d['path'] === 'string' && d['path'] !== '' && d['path'] !== '/')) throw new Refusal('routes a sub-path');
  const fqdnToken = `SERVICE_FQDN_${composeServiceKey(mainService)}`;
  /** Variables that name the routed host (`host = "${main_domain}"`). */
  const hostVars = new Set(routed.map((d) => /^\$\{([^}]+)\}$/.exec(String(d['host'] ?? ''))?.[1]).filter((v): v is string => !!v));

  // ── variables and generators ─────────────────────────────────────────────
  const variables = new Map<string, string>();
  for (const [k, v] of Object.entries(cfg.variables ?? {})) {
    const value = str(v);
    if (value !== undefined) variables.set(k, value);
  }
  const resolved = new Map<string, Expr>();
  const resolving = new Set<string>();
  let inline = 0;

  const generator = (inner: string, owner: string): Expr | null => {
    const [name, arg] = inner.split(/:(.*)/s) as [string, string | undefined];
    const n = arg === undefined || arg === '' ? null : Number(arg);
    const key = tokenKey(owner);
    switch (name) {
      case 'domain':
        if (arg !== undefined) return null;
        if (!hostVars.has(owner) && variables.has(owner)) throw new Refusal(`has a second public hostname (${owner})`);
        return [{ token: fqdnToken }];
      case 'password': {
        const size = n ?? 16;
        if (!Number.isInteger(size) || size < 8 || size > 256) throw new Refusal(`uses \${password:${arg}}`);
        return [{ token: `SERVICE_PASSWORD_${size}_${key}` }];
      }
      case 'base64': {
        const size = n ?? 32;
        if (![32, 64, 128].includes(size)) throw new Refusal(`uses \${base64:${arg}} (only 32, 64 or 128 bytes have an equivalent)`);
        return [{ token: `SERVICE_REALBASE64_${size}_${key}` }];
      }
      case 'hash': {
        const size = n ?? 8;
        if (![32, 64, 128].includes(size)) throw new Refusal(`uses \${hash${arg === undefined ? '' : `:${arg}`}} (only 32, 64 or 128 characters have an equivalent)`);
        return [{ token: `SERVICE_HEX_${size}_${key}` }];
      }
      case 'username':
        return arg === undefined ? [{ token: `SERVICE_LOWERCASEUSER_${key}` }] : null;
      case 'email':
        return arg === undefined ? [{ token: `SERVICE_LOWERCASEUSER_${key}` }, { lit: '@example.com' }] : null;
      default:
        if (NO_EQUIVALENT.has(name)) throw new Refusal(`uses \${${name}}, which has no equivalent here`);
        return null;
    }
  };

  const rawEnv = envEntries(cfg.config?.env);
  const env = new Map<string, Expr>();
  const GENERATORS = new Set(['domain', 'password', 'base64', 'hash', 'username', 'email', ...NO_EQUIVALENT]);

  /**
   * A value with its `${…}` references expanded, in Dokploy's order: a
   * generator name first, then a blueprint variable. An env value may also
   * name another env key, with or without a default — compose interpolates
   * the stack's .env that way. `owner` names the variable or env key.
   */
  const expand = (value: string, owner: string): Expr => {
    const out: Expr = [];
    let last = 0;
    for (const m of value.matchAll(/\$\{([^}]*)\}/g)) {
      if (m.index! > last) out.push({ lit: value.slice(last, m.index) });
      last = m.index! + m[0].length;
      const inner = m[1]!;
      const head = inner.split(':')[0]!;
      if (GENERATORS.has(head)) {
        // An inline generator (`KEY = "${password:16}"`) gets its own token.
        const own = variables.has(owner) ? owner : `${owner}${inline++ === 0 ? '' : `_${inline}`}`;
        const gen = generator(inner, own);
        if (!gen) throw new Refusal(`uses \${${inner}}, which has no equivalent here`);
        out.push(...gen);
        continue;
      }
      if (variables.has(inner)) {
        out.push(...resolveVar(inner));
        continue;
      }
      const withDefault = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)(.*))?$/s.exec(inner);
      // `PUID = "${PUID:-1000}"` reads the shell's own PUID, unset here: the default (or empty).
      if (withDefault && withDefault[1] === owner && !variables.has(owner)) {
        out.push({ lit: withDefault[2] !== undefined ? (withDefault[3] ?? '') : '' });
        continue;
      }
      if (withDefault && (rawEnv.has(withDefault[1]!) || withDefault[2] !== undefined)) {
        const ref = rawEnv.has(withDefault[1]!) ? resolveEnv(withDefault[1]!) : null;
        const empty = !ref || ref.every((s) => 'lit' in s && s.lit === '');
        if (ref && !(empty && withDefault[2] === ':-')) out.push(...ref);
        else if (withDefault[2] !== undefined && (!ref || withDefault[2] === ':-')) out.push({ lit: withDefault[3] ?? '' });
        continue;
      }
      throw new Refusal(`references \${${inner}}, which the blueprint does not define`);
    }
    if (last < value.length) out.push({ lit: value.slice(last) });
    return out;
  };

  const resolveVar = (name: string): Expr => {
    const done = resolved.get(name);
    if (done) return done;
    if (resolving.has(name)) throw new Refusal(`variable ${name} refers to itself`);
    resolving.add(name);
    const expr = expand(variables.get(name)!, name);
    resolving.delete(name);
    resolved.set(name, expr);
    return expr;
  };

  const envResolving = new Set<string>();
  const resolveEnv = (key: string): Expr => {
    const done = env.get(key);
    if (done) return done;
    if (envResolving.has(key)) throw new Refusal(`env ${key} refers to itself`);
    envResolving.add(key);
    const saved = inline;
    inline = 0;
    const expr = expand(rawEnv.get(key)!, key);
    inline = saved;
    envResolving.delete(key);
    env.set(key, expr);
    return expr;
  };
  for (const key of rawEnv.keys()) resolveEnv(key);

  // ── the compose file ─────────────────────────────────────────────────────
  let original: { services?: Record<string, ServiceEntry> } | null;
  try {
    original = yaml.load(bp.compose) as typeof original;
  } catch (err) {
    throw new Refusal(`unparsable YAML: ${err instanceof Error ? err.message.slice(0, 80) : 'error'}`);
  }
  const services = original?.services ?? {};
  if (Object.keys(services).length === 0) throw new Refusal('no services');
  if (!(mainService in services)) throw new Refusal(`routed service '${mainService}' is not in the compose file`);
  const refusal = composeServiceRefusal(services) ?? hostBindRefusal(original as Parameters<typeof hostBindRefusal>[0]);
  if (refusal) throw new Refusal(refusal);
  const dokployVar = /\bDOKPLOY_[A-Z0-9_]+\b/.exec(bp.compose);
  if (dokployVar) throw new Refusal(`uses ${dokployVar[0]}, a variable only Dokploy provides`);

  // Fold the stack's .env into the file. Compose interpolates inside string
  // values after parsing the YAML, so the substitution walks the parsed
  // document (keys are never interpolated) and the file is written again: a
  // value with `: ` or `#` can never change the structure. A
  // `${KEY:-default}` whose value is empty keeps its default, as compose
  // would with the .env.
  const fold = (s: string): string =>
    s.replace(
      /(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}|(?<!\$)\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (whole, braced: string | undefined, op: string | undefined, rest: string | undefined, bare: string | undefined) => {
        const expr = env.get(braced ?? bare!);
        if (!expr) return whole;
        const text = render(expr);
        return text === '' && op === ':-' ? (rest ?? '') : text;
      },
    );
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return fold(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    return node;
  };
  const folded = walk(original);
  if (!sameShape(original, folded)) throw new Refusal('an env value changes the compose structure');
  const rewritten = yaml.dump(folded, { lineWidth: -1, noRefs: true, quotingType: '"' });

  const pre = preflightCompose(rewritten);
  if (!pre.ok) throw new Refusal(pre.reasons[0]!);
  const finalRefusal = hostBindRefusal(yaml.load(rewritten) as Parameters<typeof hostBindRefusal>[0]);
  if (finalRefusal) throw new Refusal(finalRefusal);

  // ── metadata ─────────────────────────────────────────────────────────────
  const meta = bp.meta;
  const name = str(meta['name']) || titleFromSlug(bp.id);
  const description = (str(meta['description']) || `${name} compose stack`).replace(/\s+/g, ' ').trim();
  const firstSentence = /^(.{20,140}?[.!?])(\s|$)/.exec(description)?.[1] ?? description.slice(0, 140);
  const tags = Array.isArray(meta['tags']) ? (meta['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : [];
  const links = (meta['links'] && typeof meta['links'] === 'object' ? meta['links'] : {}) as Record<string, unknown>;
  const mainImage = services[mainService]?.image;

  const template: Template = {
    id: `dokploy-${bp.id.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
    name,
    tagline: firstSentence,
    description,
    category: titleCaseCategory(tags[0]),
    emoji: CATEGORY_EMOJI[(tags[0] ?? '').toLowerCase()] ?? '🧩',
    image: typeof mainImage === 'string' ? displayImage(mainImage) : `docker.io/library/${mainService}`,
    port,
    composeContent: declareImplicitVolumes(rewritten),
    composeService: mainService,
    requires: `Dokploy mirror (MIT) · routed service: ${mainService} · not runtime-verified`,
  };
  const website = str(links['website']);
  const docs = str(links['docs']) ?? str(links['github']);
  if (website) template.website = website;
  if (docs) template.docs = docs;
  const configurable = extractConfigurableEnv(rewritten);
  if (configurable && configurable.length > 0) template.env = configurable;
  return template;
}
