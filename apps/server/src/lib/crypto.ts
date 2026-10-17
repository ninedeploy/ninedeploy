import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual, type CipherGCM, type DecipherGCM } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { config } from '../config.js';
import { createLogger } from './log.js';

/** Argon2id password hashing (recommended defaults from @node-rs/argon2). */
export async function hashPassword(password: string): Promise<string> {
  return argonHash(password);
}

/**
 * A real argon2 hash of a random secret nobody knows, computed once per
 * process. r504: verifying against it costs exactly what a real verify costs,
 * so a login for an unknown account (or one whose stored value is not an
 * argon2 hash at all — SCIM's unusable random secret) takes as long as a
 * wrong password for a real one, and the response time stops answering
 * "does this email have an account here?".
 */
let dummyHash: Promise<string> | null = null;
function dummyPasswordHash(): Promise<string> {
  if (!dummyHash) {
    dummyHash = argonHash(randomBytes(32).toString('base64url'));
    // A failed hash must not poison every later login with a rejected promise.
    dummyHash.catch(() => {
      dummyHash = null;
    });
  }
  return dummyHash;
}

/**
 * Verify a plaintext password against an argon2 hash. Never throws on mismatch.
 *
 * r504: anything that is not an argon2 hash — including the empty string the
 * login route passes for an unknown email — is checked against the dummy hash
 * instead and always answers false, so every miss pays one full argon2 verify.
 */
export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  const real = hashed.startsWith('$argon2');
  try {
    const ok = await argonVerify(real ? hashed : await dummyPasswordHash(), password);
    return real && ok;
  } catch {
    return false;
  }
}

/** SHA-256 hex digest — used to hash API tokens before storing/comparing. */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** URL-safe random token (base64url). Used for opaque API tokens and refresh ids. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Constant-time equality for two secrets held in plaintext.
 *
 * Both sides are hashed first so the comparison is over fixed-length buffers:
 * `timingSafeEqual` throws on a length mismatch, and short-circuiting on length
 * would itself leak how long the stored secret is.
 */
export function secretEquals(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

// ── Symmetric encryption (secrets at rest) ────────────────────────────────
// AES-256-GCM with a per-instance master key, wrapped in a versioned envelope
// so the master key can be ROTATED without invalidating existing secrets:
//   • new ciphertext: "v<version>:iv:tag:ciphertext"
//   • legacy ciphertext (pre-rotation): "iv:tag:ciphertext" (no prefix)
// decrypt accepts both. To rotate: add the new key under a higher version in
// NINEDEPLOY_MASTER_KEYS, then re-encrypt secrets (see `reencrypt`).

interface KeyRing {
  /** version → 32-byte key */
  keys: Map<number, Buffer>;
  activeVersion: number;
  activeKey: Buffer;
}

let keyRing: KeyRing | null = null;

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

const keyLog = createLogger('crypto');

function decodeMasterKeyHex(value: string, source: string): Buffer {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  // 0.16 upgrade compatibility: before the strict check the key was decoded
  // with a bare Buffer.from(value, 'hex'), which reads the leading hex pairs
  // and ignores the rest — so a key followed by a stray character, a second
  // line or one extra digit worked. Refusing that now would leave an upgraded
  // server unable to decrypt its own secrets. Accept exactly what decoded to
  // 32 bytes before, and say how to fix it.
  const legacy = Buffer.from(value, 'hex');
  if (legacy.length === 32) {
    keyLog.warn(`${source} has characters after its 64 hexadecimal digits; only the first 64 are used. Rewrite it to exactly 64 hexadecimal characters.`);
    return legacy;
  }
  throw new Error(`${source} must decode to 32 bytes (exactly 64 hexadecimal characters)`);
}

/**
 * A symlinked master.key (e.g. to a Docker secret) loaded before 0.16 and
 * must keep loading: read it through the link, but only when it resolves to a
 * regular file. Creation never writes through a link (the exclusive `wx`
 * create in loadSingleKey fails on any existing path, links included).
 */
function readSymlinkedMasterKey(file: string): Buffer {
  const target = statSync(file);
  if (!target.isFile()) throw new Error(`Master key path "${file}" is a symbolic link to something that is not a regular file`);
  keyLog.warn(`Master key path "${file}" is a symbolic link; reading the file it points to.`);
  return decodeMasterKeyHex(readFileSync(file, 'utf8'), `Master key file "${file}"`);
}

function readMasterKeyFile(file: string): Buffer {
  const before = lstatSync(file);
  if (before.isSymbolicLink()) return readSymlinkedMasterKey(file);
  if (!before.isFile()) throw new Error(`Master key path "${file}" is not a regular file`);

  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  const fd = openSync(file, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`Master key path "${file}" is not a regular file`);
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error(`Master key file "${file}" changed while being opened`);
    }
    return decodeMasterKeyHex(readFileSync(fd, 'utf8'), `Master key file "${file}"`);
  } finally {
    closeSync(fd);
  }
}

/** Load the single legacy master key from env or the master.key file (auto-creating it). */
function loadSingleKey(): Buffer {
  const envKey = process.env['NINEDEPLOY_MASTER_KEY'];
  if (envKey) return decodeMasterKeyHex(envKey, 'NINEDEPLOY_MASTER_KEY');

  const file = config.paths.masterKeyFile;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch (cause) {
    throw new Error(`Could not prepare master key directory for "${file}"`, { cause });
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const generated = randomBytes(32);
    try {
      writeFileSync(file, generated.toString('hex'), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
        flush: true,
      });
      return generated;
    } catch (cause) {
      if (!hasErrorCode(cause, 'EEXIST')) {
        throw new Error(`Could not create master key file "${file}"`, { cause });
      }
      try {
        return readMasterKeyFile(file);
      } catch (readError) {
        if (attempt === 0 && hasErrorCode(readError, 'ENOENT')) continue;
        if (attempt === 1 && hasErrorCode(readError, 'ENOENT')) break;
        throw readError;
      }
    }
  }

  throw new Error(`Master key file "${file}" disappeared during initialization`);
}

function getKeyRing(): KeyRing {
  if (keyRing) return keyRing;
  const multi = process.env['NINEDEPLOY_MASTER_KEYS']; // "0:hex,1:hex,..."
  if (multi) {
    const keys = new Map<number, Buffer>();
    for (const pair of multi.split(',')) {
      const sep = pair.indexOf(':');
      if (sep < 0) continue;
      const id = Number(pair.slice(0, sep));
      const key = Buffer.from(pair.slice(sep + 1).trim(), 'hex');
      if (key.length !== 32) throw new Error(`NINEDEPLOY_MASTER_KEYS version ${id} must decode to 32 bytes`);
      keys.set(id, key);
    }
    if (keys.size === 0) throw new Error('NINEDEPLOY_MASTER_KEYS contained no valid keys');
    const activeVersion = Math.max(...keys.keys());
    keyRing = { keys, activeVersion, activeKey: keys.get(activeVersion)! };
    return keyRing;
  }
  // Legacy single-key path: the configured/generated master key is version 0.
  const key = loadSingleKey();
  if (key.length !== 32) throw new Error('NINEDEPLOY_MASTER_KEY must decode to 32 bytes');
  keyRing = { keys: new Map([[0, key]]), activeVersion: 0, activeKey: key };
  return keyRing;
}

/** The key version new ciphertext is sealed under right now. */
export function activeKeyVersion(): number {
  return getKeyRing().activeVersion;
}

/** Every key version this process can still DECRYPT with, ascending. */
export function knownKeyVersions(): number[] {
  return [...getKeyRing().keys.keys()].sort((a, b) => a - b);
}

/** Match a leading `v<digits>:` version prefix on an envelope. */
const VERSION_RE = /^v(\d+):/;
const BACKUP_HEADER_RE = /^NDBK1:v(\d+):([A-Za-z0-9+/=]+)\n$/;

/** Encrypt plaintext → "v<version>:iv:tag:ciphertext" (all base64). */
export function encrypt(plaintext: string): string {
  const ring = getKeyRing();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ring.activeKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const body = [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join(':');
  return `v${ring.activeVersion}:${body}`;
}

/** Decrypt a value produced by `encrypt()` (versioned or legacy envelope). */
export function decrypt(payload: string): string {
  const ring = getKeyRing();
  const m = VERSION_RE.exec(payload);
  const body = m ? payload.slice(m[0].length) : payload;
  // Versioned → look up the key by version. Legacy (un-prefixed, pre-rotation)
  // ciphertext was sealed under the original key = version 0 (NOT necessarily
  // the current active key after a rotation), so resolve it to key 0.
  // A version that is not in the ring is a corrupt/mismatched envelope —
  // fail loudly instead of silently decrypting with the wrong key (which
  // would either throw a confusing GCM auth error or, worse, succeed with
  // garbage if the tag happened to validate).
  const key = m
    ? (ring.keys.get(Number(m[1])) ?? (() => {
        throw new Error(`Unknown master key version ${m![1]} — is NINEDEPLOY_MASTER_KEYS missing this version?`);
      })())
    : (ring.keys.get(0) ?? ring.activeKey);
  const [ivB, tagB, encB] = body.split(':') as [string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]).toString('utf8');
}

/** Create a streaming AES-GCM backup cipher and its small versioned header. */
export function createBackupCipher(): { cipher: CipherGCM; header: Buffer } {
  const ring = getKeyRing();
  const iv = randomBytes(12);
  return {
    cipher: createCipheriv('aes-256-gcm', ring.activeKey, iv),
    header: Buffer.from(`NDBK1:v${ring.activeVersion}:${iv.toString('base64')}\n`),
  };
}

/** Create the matching streaming decipher after the trailing GCM tag is read. */
export function createBackupDecipher(header: string, authTag: Buffer): DecipherGCM {
  const match = BACKUP_HEADER_RE.exec(header);
  if (!match) throw new Error('Invalid NineDeploy backup header');
  const ring = getKeyRing();
  const version = Number(match[1]);
  const key = ring.keys.get(version);
  if (!key) throw new Error(`Unknown master key version ${version} — is NINEDEPLOY_MASTER_KEYS missing this version?`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(match[2]!, 'base64'));
  decipher.setAuthTag(authTag);
  return decipher;
}

/**
 * Re-encrypt an existing ciphertext with the ACTIVE key version. Used during key
 * rotation: after adding a new key version, run every stored secret through this
 * so it moves off the old key (which can then be retired). A no-op if already on
 * the active version.
 */
export function reencrypt(payload: string): string {
  const ring = getKeyRing();
  const m = VERSION_RE.exec(payload);
  if (m && Number(m[1]) === ring.activeVersion) return payload;
  return encrypt(decrypt(payload));
}
