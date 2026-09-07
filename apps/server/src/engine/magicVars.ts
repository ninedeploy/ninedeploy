import { randomBytes } from 'node:crypto';

/**
 * Magic-variable scanner + resolver for compose-based template stacks.
 *
 * Semantics mirror the ecosystem convention these templates were authored for
 * (upstream `generateEnvValue()`): every uppercase `SERVICE_*` token found in
 * a compose file is replaced at deploy time by a server-generated value that
 * is then persisted, so redeploys keep the same credentials and URLs.
 */

export interface ComposePreflight {
  ok: boolean;
  /** Blocking reasons — the stack is refused until these are rewritten. */
  reasons: string[];
  /** Non-blocking notes shown to the operator. */
  warnings: string[];
}

/**
 * Cheap textual preflight before anything touches Docker. Zero-dependency on
 * purpose: the checks target line shapes, not YAML structure.
 */
export function preflightCompose(content: string): ComposePreflight {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (/^\s*env_file:/m.test(content)) {
    reasons.push('env_file is not supported — inline the values or list them as template env entries');
  }
  if (/^\s+content:\s*\S/m.test(content)) {
    reasons.push(
      "bind-mount entries with inline 'content:' are not supported yet — bake the file into the image instead",
    );
  }
  if (/external:\s*true/m.test(content)) warnings.push('declares external resources — they must exist before first deploy');
  if (/network_mode:\s*(host|service:|container:)/m.test(content)) {
    warnings.push('host/service networked containers are deployed as-is; no sandbox bridge is attached');
  }
  return { ok: reasons.length === 0, reasons, warnings };
}

export type MagicKind =
  | 'user'
  | 'lowercaseUser'
  | 'password'
  /** BASE64_<N>_ family: NOT base64 despite the name — N plain random chars. */
  | 'randomLength'
  /** REALBASE64_<BYTES>: true base64 of that many random bytes. */
  | 'realBase64'
  | 'hex'
  | 'url'
  | 'fqdn';

export interface ParsedMagicToken {
  raw: string;
  kind: MagicKind;
  /** Service/port split for URL_/FQDN_; undefined otherwise. */
  target?: { service: string; port: number | null };
  /** Entropy spec for password/randomLength/realBase64/hex families. */
  size?: number;
}

const TOKEN_RE = /^SERVICE_([A-Z0-9_]+)$/;

/** Single source of truth for token classification. Returns null for tokens
 *  outside the known families (they must pass through untouched). */
export function parseMagicToken(raw: string): ParsedMagicToken | null {
  const matched = raw.match(TOKEN_RE);
  if (!matched || !matched[1]) return null;
  const rest = matched[1];

  const routeTarget = (kind: MagicKind, remainder: string): ParsedMagicToken => {
    const pm = remainder.match(/^(.+)_(\d{1,5})$/);
    return pm
      ? { raw, kind, target: { service: pm[1]!, port: Number(pm[2]) } }
      : { raw, kind, target: { service: remainder, port: null } };
  };

  if (rest.startsWith('LOWERCASEUSER_')) return { raw, kind: 'lowercaseUser' };
  if (rest.startsWith('USER_')) return { raw, kind: 'user' };
  if (rest.startsWith('PASSWORDWITHSYMBOLS_')) return { raw, kind: 'password', size: 32 };

  if (rest.startsWith('PASSWORD_')) {
    const tail = rest.slice('PASSWORD_'.length);
    // Historical alias: PASSWORD_BASE64_X generates plain chars, not base64.
    if (/^BASE64/.test(tail)) return { raw, kind: 'password', size: 64 };
    if (/^HEX_\d+$/.test(tail)) return { raw, kind: 'hex', size: Number(tail.slice(4)) };
    const sized = tail.match(/^(\d+)(?:_|$)/);
    return sized ? { raw, kind: 'password', size: Number(sized[1]) } : { raw, kind: 'password', size: 32 };
  }

  const baseSized = rest.match(/^BASE64_(32|64|128)(_|$)/);
  if (baseSized) return { raw, kind: 'randomLength', size: Number(baseSized[1]) };
  if (rest.startsWith('BASE64_')) return { raw, kind: 'randomLength', size: 64 };

  const realSized = rest.match(/^REALBASE64_(32|64|128)(_|$)/);
  if (realSized) return { raw, kind: 'realBase64', size: Number(realSized[1]) };
  if (rest.startsWith('REALBASE64_')) return { raw, kind: 'realBase64', size: 32 };

  const hexSized = rest.match(/^HEX_(32|64|128)(_|$)/);
  if (hexSized) return { raw, kind: 'hex', size: Number(hexSized[1]) };
  if (rest.startsWith('HEX_')) return { raw, kind: 'hex', size: 32 };

  if (rest.startsWith('URL_')) return routeTarget('url', rest.slice(4));
  if (rest.startsWith('FQDN_')) return routeTarget('fqdn', rest.slice(5));

  return null;
}

const TOKEN_SCAN = /\bSERVICE_[A-Z0-9_]+\b/g;

/** Every distinct SERVICE_* token referenced anywhere in the file. */
export function scanMagicTokens(composeContent: string): string[] {
  const seen = new Set<string>();
  for (const hit of composeContent.matchAll(TOKEN_SCAN)) seen.add(hit[0]);
  return [...seen].sort();
}

// Braced-without-default (${NAME}) plus bare ($NAME) interpolation refs.
// Lookbehind skips docker-compose's own `$$` literal escape; requiring the
// closing brace right after the name keeps ${NAME:-default} out of the list.
const PLACEHOLDER_SCAN = /(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)\}|(?<!\$)\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** User-facing placeholder references WITHOUT defaults, excluding magic tokens. */
export function scanRequiredPlaceholders(composeContent: string): string[] {
  const seen = new Set<string>();
  for (const m of composeContent.matchAll(PLACEHOLDER_SCAN)) {
    const name = m[1] ?? m[2];
    if (name && !name.startsWith('SERVICE_')) seen.add(name);
  }
  return [...seen].sort();
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomString(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += ALNUM[b % ALNUM.length]!;
  return out;
}

export function generateValue(spec: ParsedMagicToken): string {
  switch (spec.kind) {
    case 'user':
      return randomString(16);
    case 'lowercaseUser':
      return randomString(16).toLowerCase();
    case 'password':
      return randomString(spec.size ?? 32);
    case 'randomLength':
      return randomString(spec.size ?? 64);
    case 'realBase64':
      return randomBytes(spec.size ?? 32).toString('base64');
    case 'hex': {
      // `size` is the HEX-CHAR count, not bytes (the even sizes prove it: 32 →
      // 16 bytes → 32 chars). node truncates a fractional randomBytes size, so
      // a bare size/2 silently shortened odd secrets (25 → 24 chars) and made
      // HEX_1 an empty secret — generate ceil(n/2) bytes and take n chars.
      const chars = spec.size ?? 32;
      return randomBytes(Math.ceil(chars / 2)).toString('hex').slice(0, chars);
    }
    default:
      throw new Error(`magic token ${spec.raw} needs a public URL, not a generated value`);
  }
}

export interface ResolveOptions {
  /** Scheme+host used for URL_/FQDN_ tokens, e.g. https://umami-a1f3.example.com */
  publicUrl: string;
  /** Test seam overriding secret generation. */
  generate?: (spec: ParsedMagicToken) => string;
}

export interface ResolvedStackEnv {
  /** key → value, ready for .env + subprocess export of `docker compose`. */
  values: Record<string, string>;
  /** Token classification report (logging/tests). */
  parsed: Record<string, ParsedMagicToken>;
  /** ${VAR} placeholders with no default and no magic meaning. */
  openPlaceholders: string[];
}

/**
 * Produce the complete deploy-time environment: each distinct magic token is
 * resolved exactly once (same token ⇒ same value across every service in the
 * stack), and defaultless user placeholders get an empty default so docker
 * compose never fails validation nor silently bakes a wrong config — callers
 * may override them through ordinary env rows.
 */
export function resolveStackEnvironment(composeContent: string, options: ResolveOptions): ResolvedStackEnv {
  const values: Record<string, string> = {};
  const parsed: Record<string, ParsedMagicToken> = {};
  const host = new URL(options.publicUrl).host;

  for (const token of scanMagicTokens(composeContent)) {
    const spec = parseMagicToken(token);
    if (!spec) continue;
    parsed[token] = spec;
    switch (spec.kind) {
      case 'url':
        values[token] = options.publicUrl;
        break;
      case 'fqdn':
        values[token] = host;
        break;
      default:
        values[token] = options.generate ? options.generate(spec) : generateValue(spec);
        break;
    }
  }

  const openPlaceholders = scanRequiredPlaceholders(composeContent);
  for (const name of openPlaceholders) values[name] ??= '';

  return { values, parsed, openPlaceholders };
}

/** Router-name normalization matching the deployed catalog: hyphens are
 *  dropped (supabase-kong → SUPABASEKONG), dots become underscores. */
export function composeServiceKey(serviceName: string): string {
  return serviceName.replace(/-/g, '').replace(/\./g, '_').toUpperCase();
}
