import yaml from 'js-yaml';
import { preflightCompose, scanMagicTokens, parseMagicToken, composeServiceKey } from '../engine/magicVars.js';
import type { Template } from './registry.js';

/**
 * Converter for the upstream community compose-template catalog
 * (`coollabsio/coolify` `templates/compose/*.yaml`) into NineDeploy's
 * compose-stack template format.
 *
 * Everything routes through the SAME machinery as hand-authored stacks:
 * header comments become Hub metadata, the file body becomes
 * `composeContent`, and magic `SERVICE_*` tokens stay untouched for
 * `resolveStackEnvironment` to generate at deploy time.
 *
 * Files the platform cannot run yet are skipped with a concrete reason
 * instead of being silently degraded: ignored upstream, no routed HTTP port,
 * host-port publishing, build contexts, env_file, inline content: mounts.
 */

export interface MirrorSkip {
  skip: true;
  reason: string;
}
export interface MirrorConverted {
  skip: false;
  template: Template;
  /** How the routed (main) service was chosen — surfaced in Hub notes. */
  mainServiceVia: 'url-token' | 'port-reference' | 'first-service';
}

const HEADER_LINE = /^#\s*([a-z]+):\s*(.*)$/;

/** Upstream header comments: documentation, slogan, category, tags, logo, port, ignore, minversion. */
export function parseHeader(raw: string): Record<string, string> {
  const header: Record<string, string> = {};
  // F318: CRLF checkouts — `.` in HEADER_LINE never matches the trailing '\r'.
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('#')) {
      if (line.trim() === '') continue;
      break; // headers end at the first non-comment, non-blank line
    }
    const m = line.match(HEADER_LINE);
    if (m?.[1] && m[2] !== undefined) header[m[1]] ??= m[2].trim();
  }
  return header;
}

interface ServiceEntry {
  image?: unknown;
  build?: unknown;
  ports?: unknown;
  healthcheck?: unknown;
  environment?: unknown;
  [key: string]: unknown;
}

/** Pulls a service's own definition back to text for content heuristics. */
function serviceText(entry: ServiceEntry): string {
  try {
    return yaml.dump(entry);
  } catch {
    return '';
  }
}

const CATEGORY_EMOJI: Record<string, string> = {
  analytics: '📊', automation: '🤖', ai: '🧠', database: '🗄️', monitoring: '📈',
  media: '🎬', git: '🔧', cms: '📝', backend: '🧱', communication: '💬',
  developer: '🛠️', productivity: '📋', games: '🎮', messaging: '📨', money: '💰',
  security: '🔐', hosting: '🌐', file: '📁', email: '📧', social: '👥',
};

function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

function titleCaseCategory(raw: string | undefined): string {
  if (!raw) return 'Tools';
  const c = raw.trim();
  return c.charAt(0).toUpperCase() + c.slice(1);
}

/** Non-magic ${VAR:-default} occurrences → wizard-visible env entries. */
export function extractConfigurableEnv(composeContent: string): Template['env'] {
  const found = new Map<string, string>();
  for (const m of composeContent.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}/g)) {
    const key = m[1];
    // F316: an interpolating default (`${A:-${B}}`, `$B`, `$$`) is not a literal
    // value — as an env row it is stored verbatim (and truncated at the first
    // `}`), so A becomes SET to unresolved text and compose's default never runs.
    if (key && !key.startsWith('SERVICE_') && !m[2]!.includes('$')) found.set(key, m[2]!);
  }
  return [...found.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 12)
    .map(([key, value]) => ({ key, value, secret: false }));
}

/** Well-known infrastructure service names — never the routed app. */
const INFRA_SERVICE = /^(db\w*|database\w*|postgres\w*|mysql\w*|mariadb\w*|redis\w*|valkey\w*|mongo\w*|clickhouse\w*|rabbitmq\w*|minio|mc|kafka|zookeeper|elasticsearch|opensearch|qdrant|chromadb|weaviate|milvus|memcached|mailhog|mailpit|smtp)$/;

/** Picks the routed service: explicit URL token match, port mention, then first non-infra. */
export function pickMainService(
  services: Record<string, ServiceEntry>,
  raw: string,
  headerPort: number,
): { name: string; via: MirrorConverted['mainServiceVia'] } | null {
  const names = Object.keys(services);
  if (names.length === 0) return null;

  for (const token of scanMagicTokens(raw)) {
    const spec = parseMagicToken(token);
    if (!spec?.target) continue;
    const hit = names.find((n) => composeServiceKey(n) === spec.target!.service);
    if (hit && (spec.target.port === headerPort || spec.target.port === null)) return { name: hit, via: 'url-token' };
  }
  for (const name of names) {
    const text = serviceText(services[name]!);
    if (text.includes(`127.0.0.1:${headerPort}`) || text.includes(`localhost:${headerPort}`)) {
      return { name, via: 'port-reference' };
    }
  }
  // Last resort: the first service that does not look like a backing store.
  const appCandidates = names.filter((n) => !INFRA_SERVICE.test(n.toLowerCase()));
  return { name: (appCandidates[0] ?? names[0])!, via: 'first-service' };
}

/** A volume source that is a plain name (not a path, not interpolated). */
const NAMED_VOLUME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function namedVolumeOf(entry: unknown): string | null {
  if (typeof entry === 'string') {
    // `name:/path[:mode]`; with no ':' the entry is an anonymous volume.
    const colon = entry.indexOf(':');
    if (colon < 0) return null;
    const source = entry.slice(0, colon);
    return NAMED_VOLUME.test(source) ? source : null;
  }
  if (entry && typeof entry === 'object') {
    const long = entry as { type?: unknown; source?: unknown };
    if (long.type === 'volume' && typeof long.source === 'string' && NAMED_VOLUME.test(long.source)) return long.source;
  }
  return null;
}

/** A top-level `volumes:` line that is empty or `{}`, optionally with a comment. */
const EMPTY_VOLUMES_LINE = /^volumes:[ \t]*(?:\{[ \t]*\}[ \t]*)?(#.*?)?(\r?)$/m;

/**
 * Coolify creates the named volumes of a stack itself, so an upstream file may
 * use `data:/x` with no top-level `volumes:` entry. Docker Compose rejects that
 * ("refers to undefined volume"), which made every such template fail at
 * deploy. Declares the missing names and keeps the file's own text (comments,
 * indentation, line endings) as it was.
 */
export function declareImplicitVolumes(raw: string): string {
  let doc: { services?: unknown; volumes?: unknown } | null;
  try {
    doc = yaml.load(raw) as typeof doc;
  } catch {
    return raw;
  }
  if (!doc || typeof doc !== 'object' || !doc.services || typeof doc.services !== 'object') return raw;
  const existing = doc.volumes && typeof doc.volumes === 'object' ? (doc.volumes as Record<string, unknown>) : {};
  const missing = new Set<string>();
  for (const entry of Object.values(doc.services as Record<string, unknown>)) {
    const volumes = (entry as { volumes?: unknown } | null)?.volumes;
    if (!Array.isArray(volumes)) continue;
    for (const volume of volumes) {
      const name = namedVolumeOf(volume);
      if (name && !(name in existing)) missing.add(name);
    }
  }
  if (missing.size === 0) return raw;

  const names = [...missing];
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const empty = Object.keys(existing).length === 0 ? EMPTY_VOLUMES_LINE.exec(raw) : null;
  if (empty) {
    const comment = empty[1] ? ` ${empty[1]}` : '';
    const lines = names.map((name) => `  ${name}:`).join(eol);
    return `${raw.slice(0, empty.index)}volumes:${comment}${empty[2]}${eol}${lines}${raw.slice(empty.index + empty[0].length)}`;
  }
  if (doc.volumes === undefined || doc.volumes === null) {
    return `${raw}${raw.endsWith('\n') ? '' : eol}${eol}volumes:${eol}${names.map((name) => `  ${name}:`).join(eol)}${eol}`;
  }
  // A populated block: add the names under its first line, indented like its
  // existing children.
  const header = /^volumes:[ \t]*(#.*?)?\r?$/m.exec(raw);
  const children = header ? /^([ \t]+)\S/m.exec(raw.slice(header.index + header[0].length)) : null;
  if (!header || !children) {
    // Flow style or another shape this does not recognise: re-serialise.
    const merged = { ...doc, volumes: { ...existing, ...Object.fromEntries(names.map((name) => [name, {}])) } };
    const head: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('#') && line.trim() !== '') break;
      head.push(line);
    }
    return `${head.join(eol)}${eol}${yaml.dump(merged)}`;
  }
  const insertAt = header.index + header[0].length;
  const lines = names.map((name) => `${children[1]}${name}:`).join(eol);
  return `${raw.slice(0, insertAt)}${eol}${lines}${raw.slice(insertAt)}`;
}

export function convertCoolifyComposeFile(fileName: string, raw: string): MirrorSkip | MirrorConverted {
  const base = fileName.replace(/\.ya?ml$/i, '');
  const header = parseHeader(raw);
  if (header.ignore === 'true') return { skip: true, reason: 'ignored upstream' };

  const port = Number(header.port);
  if (!header.port || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { skip: true, reason: 'no routed HTTP port (# port header)' };
  }

  let doc: { services?: Record<string, ServiceEntry> } | null;
  try {
    doc = yaml.load(raw) as typeof doc;
  } catch (err) {
    return { skip: true, reason: `unparsable YAML: ${err instanceof Error ? err.message.slice(0, 80) : 'error'}` };
  }
  const services = doc?.services ?? {};
  const names = Object.keys(services);
  if (names.length === 0) return { skip: true, reason: 'no services' };

  for (const [name, entry] of Object.entries(services)) {
    if (!entry || typeof entry !== 'object') return { skip: true, reason: `service '${name}' is not a mapping` };
    if (typeof entry.build !== 'undefined' && typeof entry.image === 'undefined') {
      return { skip: true, reason: `service '${name}' requires a build context` };
    }
    if (
      Array.isArray(entry.ports)
      && entry.ports.some(
        (p) =>
          // Short syntax: `host:container` mappings (and `$` interpolation,
          // which can smuggle a host port past a literal review).
          (typeof p === 'string' && (p.includes(':') || p.includes('$')))
          // Long syntax: a `published` port or an explicit `host_ip` is a
          // deterministic host binding — exactly what this guard refuses.
          || (typeof p === 'object' && p !== null && ('published' in p || 'host_ip' in p)),
      )
    ) {
      return { skip: true, reason: `service '${name}' publishes host ports` };
    }
    // F317: host networking binds EVERY container port on the host with no
    // `ports:` key at all (and `$` can smuggle it in via interpolation).
    if (typeof entry.network_mode === 'string' && (entry.network_mode.trim() === 'host' || entry.network_mode.includes('$'))) {
      return { skip: true, reason: `service '${name}' uses host networking` };
    }
  }

  const pre = preflightCompose(raw);
  if (!pre.ok) return { skip: true, reason: pre.reasons[0]! };

  const main = pickMainService(services, raw, port)!;

  const template: Template = {
    id: `coolify-${base.toLowerCase()}`,
    name: titleFromSlug(base),
    tagline: header.slogan || `${titleFromSlug(base)} compose stack`,
    description: header.slogan || titleFromSlug(base),
    category: titleCaseCategory(header.category),
    emoji: CATEGORY_EMOJI[(header.category ?? '').toLowerCase()] ?? '🧩',
    // Display/routing surface of the MAIN service only; the stack deploys
    // from composeContent regardless.
    image: typeof services[main.name]?.image === 'string' ? services[main.name]!.image as string : `docker.io/library/${main.name}`,
    port,
    composeContent: declareImplicitVolumes(raw),
    composeService: main.name,
    docs: header.documentation,
    requires: `Coolify mirror · routed service: ${main.name} (${main.via}) · not runtime-verified`,
  };
  const env = extractConfigurableEnv(raw);
  if (env && env.length > 0) template.env = env;

  return { skip: false, template, mainServiceVia: main.via };
}
