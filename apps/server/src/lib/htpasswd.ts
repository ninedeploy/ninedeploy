import { createHash, randomBytes } from 'node:crypto';

/**
 * r636: Basic Auth credentials for a domain's Traefik `basicAuth` middleware.
 *
 * Traefik checks every `users` entry with go-http-auth's htpasswd comparator,
 * which only understands HASHED secrets (`$apr1$`, `$1$`, bcrypt `$2?$`,
 * `{SHA}`). The panel used to store and render whatever the user typed — the
 * placeholder even suggests `admin:password` — so a plaintext entry made the
 * domain refuse every login, and the plaintext password sat in the database
 * and in every `GET /services/:id/domains` response, viewers included.
 *
 * Entries are now hashed with APR1-MD5 (Apache's htpasswd default, which
 * every Traefik release accepts) on write, and legacy plaintext rows are
 * hashed at render time with a salt derived from the entry itself, so the
 * dynamic config stays byte-stable across re-renders.
 */

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Secret prefixes go-http-auth (Traefik's htpasswd checker) recognises. */
const HASH_PREFIXES = ['$apr1$', '$1$', '$2a$', '$2b$', '$2x$', '$2y$', '{SHA}'];

/** True when the secret half of a `user:secret` entry is already a hash Traefik accepts. */
export function isHtpasswdHash(secret: string): boolean {
  return HASH_PREFIXES.some((p) => secret.startsWith(p));
}

function to64(value: number, count: number): string {
  let out = '';
  let v = value;
  for (let i = 0; i < count; i++) {
    out += ITOA64[v & 0x3f];
    v >>>= 6;
  }
  return out;
}

/** APR1-MD5 crypt (`htpasswd -m`, `openssl passwd -apr1`). `salt` is at most 8 chars of ITOA64. */
export function apr1(password: string, salt: string): string {
  const magic = '$apr1$';
  const pw = Buffer.from(password, 'utf8');
  const s = Buffer.from(salt.slice(0, 8), 'utf8');
  const md5 = () => createHash('md5');

  const alt = md5().update(pw).update(s).update(pw).digest();
  const ctx = md5().update(pw).update(magic).update(s);
  for (let left = pw.length; left > 0; left -= 16) ctx.update(alt.subarray(0, Math.min(left, 16)));
  for (let i = pw.length; i > 0; i >>= 1) ctx.update(i & 1 ? Buffer.from([0]) : pw.subarray(0, 1));
  let final = ctx.digest();

  for (let i = 0; i < 1000; i++) {
    const round = md5();
    round.update(i & 1 ? pw : final);
    if (i % 3) round.update(s);
    if (i % 7) round.update(pw);
    round.update(i & 1 ? final : pw);
    final = round.digest();
  }

  const f = final;
  const encoded =
    to64((f[0]! << 16) | (f[6]! << 8) | f[12]!, 4) +
    to64((f[1]! << 16) | (f[7]! << 8) | f[13]!, 4) +
    to64((f[2]! << 16) | (f[8]! << 8) | f[14]!, 4) +
    to64((f[3]! << 16) | (f[9]! << 8) | f[15]!, 4) +
    to64((f[4]! << 16) | (f[10]! << 8) | f[5]!, 4) +
    to64(f[11]!, 2);
  return `${magic}${s.toString('utf8')}$${encoded}`;
}

function saltFrom(bytes: Buffer): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += ITOA64[bytes[i]! & 0x3f];
  return out;
}

/**
 * Hash the secret half of one `user:secret` entry unless it already is a hash.
 * `deterministic` derives the salt from the entry (render path: the same
 * stored row must render the same bytes every time); otherwise it is random.
 */
export function hashBasicAuthEntry(entry: string, deterministic = false): string {
  const idx = entry.indexOf(':');
  if (idx <= 0) return entry;
  const user = entry.slice(0, idx);
  const secret = entry.slice(idx + 1);
  if (isHtpasswdHash(secret)) return entry;
  const salt = saltFrom(
    deterministic ? createHash('sha256').update(`ninedeploy-htpasswd:${entry}`).digest() : randomBytes(8),
  );
  return `${user}:${apr1(secret, salt)}`;
}

/** Parse the domain `basicAuth` column into sanitized `user:secret` entries (secret may still be plaintext). */
export function parseBasicAuth(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let entries: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      entries = parsed.map(String);
    } else {
      entries = String(parsed).split(/[\n,]+/);
    }
  } catch {
    entries = raw.split(/[\n,]+/);
  }
  const out: string[] = [];
  for (const item of entries) {
    // Controls must go: go-yaml v3 refuses the whole dynamic config over a
    // raw control byte, quoted or not. \p{Cc} covers C0, C1 and DEL
    // (superset of the old \r\n\0 strip).
    const trimmed = item.trim().replace(/\p{Cc}/gu, '');
    if (trimmed.includes(':')) {
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * The value to STORE for a submitted basicAuth field: every entry hashed, as a
 * JSON array. Entries that already carry a hash (an htpasswd paste, or the
 * panel round-tripping what GET returned) are kept byte-for-byte. Null when
 * nothing usable remains — same as clearing the field.
 */
export function basicAuthForStorage(raw: string | null | undefined): string | null {
  const entries = parseBasicAuth(raw).map((e) => hashBasicAuthEntry(e));
  return entries.length > 0 ? JSON.stringify(entries) : null;
}

/**
 * The value to SHOW for a stored basicAuth field: never a plaintext secret.
 * Legacy plaintext rows are presented exactly as the proxy renders them, so a
 * client that saves the value back stores the same hash Traefik already uses.
 */
export function basicAuthForDisplay(raw: string | null | undefined): string | null {
  const entries = parseBasicAuth(raw);
  // Nothing renders from a value without a `user:` entry — and it may still
  // be a mistyped secret, so it is not echoed either.
  if (!raw || entries.length === 0) return null;
  if (entries.every((e) => isHtpasswdHash(e.slice(e.indexOf(':') + 1)))) return raw;
  return JSON.stringify(entries.map((e) => hashBasicAuthEntry(e, true)));
}
