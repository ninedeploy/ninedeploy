/**
 * Database dump import (0.14, DESIGN §3): everything between "the bytes are on
 * disk" and "the engine's restore tool ran" — format detection by magic bytes,
 * the per-engine refusals, the non-operator rules (envelopes, mysql system
 * schemas, psql shell escapes, the mysql sandbox flag), the async job with
 * its pre-import safety backup and post-import credential probe, and the
 * boot recovery / expiry / retention sweeps the plugin runs.
 *
 * The engine side (argv, locks, `docker cp`) is `importDatabase` in
 * `engine/database.ts`; the HTTP side is `modules/databaseImports.ts`.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, open, readdir, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { constants as zlibConstants, createGunzip, gunzipSync } from 'node:zlib';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { backups, databaseImports, type Database, type DatabaseImport as ImportRow, type DB } from '@ninedeploy/db';
import {
  DATABASE_IMPORT_ENGINE_OPTIONS,
  type DatabaseImportEngine,
  type DatabaseImportFormat,
  type DatabaseImportOptions,
} from '@ninedeploy/schemas';
import { config } from '../config.js';
import {
  type DatabaseImportPlan,
  ENGINES,
  importDatabase,
  probeDatabaseCredentials,
  stageForRestore,
} from '../engine/database.js';
import { audit } from './audit.js';
import { validateDumpFile } from './backupDrill.js';
import { forbidden, HttpError, unprocessable } from './errors.js';
import type { S3Config } from './s3.js';
import { s3GetToFile } from './s3.js';

// ── constants ──────────────────────────────────────────────────────────────

/** Staging lives here, under the backups directory: `<id>.part`. */
export const IMPORT_STAGING_SUBDIR = 'imports';
/** Free disk the staging directory needs on top of twice the dump size. */
export const FREE_SPACE_MARGIN_BYTES = 512 * 1024 * 1024;
/** A database initialised this recently may skip the safety backup (nothing to lose yet). */
export const SAFETY_SKIP_WINDOW_MS = 10 * 60 * 1000;
/** `uploading` / `pending` imports idle this long are expired, and lose their staging. */
export const STALE_IMPORT_MS = 24 * 60 * 60 * 1000;
/** Finished import rows are kept this long (the audit log's window), then deleted. */
export const FINISHED_IMPORT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** What boot recovery records on a `running` row the previous process left behind. */
export const INTERRUPTED_IMPORT_ERROR = 'interrupted by panel restart';
/** The status message when NineDeploy can no longer sign in after an import. */
export const CREDENTIALS_CHANGED_WARNING =
  'the import changed credentials NineDeploy holds — restore the pre-import backup';
/** Appended to a mysql/mariadb import error that names a definer. */
export const DEFINER_HINT = 'Hint: re-dump with --skip-definer (mysqldump 8.0.21+) or ask an operator to import.';
export const ENVELOPE_REFUSAL =
  'This file is an encrypted NineDeploy backup. Only an instance operator may import one; download the backup (it is served decrypted) and import that instead.';

/** Statuses that mean the import is over; only these are ever deleted by retention. */
export const FINISHED_IMPORT_STATUSES = ['completed', 'completed_with_warnings', 'failed', 'cancelled', 'expired'] as const;

const SNIFF_BYTES = 64 * 1024;
const MONGO_ARCHIVE_MAGIC = Buffer.from([0x6d, 0xe2, 0x99, 0x81]);
const ERROR_MAX_CHARS = 2000;

export const importStagingDir = (): string => path.join(config.paths.backupsDir, IMPORT_STAGING_SUBDIR);

// ── engines and options ────────────────────────────────────────────────────

export function isImportEngine(engine: string): engine is DatabaseImportEngine {
  return Object.hasOwn(DATABASE_IMPORT_ENGINE_OPTIONS, engine);
}

/** 422 for clickhouse, meilisearch, rabbitmq and anything else without an import. */
export function assertImportEngine(engine: string): asserts engine is DatabaseImportEngine {
  if (!isImportEngine(engine)) throw unprocessable(`Dump import is not supported for ${engine} databases`, 'import_unsupported_engine');
}

/**
 * Refuse option keys that do not apply to the engine (422), require
 * `confirmReplace` for an RDB, and apply the postgres default
 * `singleTransaction: true` (the zod schema has no default on purpose).
 */
export function resolveImportOptions(engine: string, options: DatabaseImportOptions): DatabaseImportOptions {
  assertImportEngine(engine);
  const allowed = new Set<string>(DATABASE_IMPORT_ENGINE_OPTIONS[engine]);
  const stray = Object.entries(options)
    .filter(([key, value]) => value !== undefined && !allowed.has(key))
    .map(([key]) => key);
  if (stray.length > 0) {
    throw unprocessable(`Option(s) ${stray.join(', ')} do not apply to ${engine}; allowed: ${[...allowed].join(', ')}`, 'import_option');
  }
  const out: DatabaseImportOptions = { ...options };
  if (engine === 'postgres' && out.singleTransaction === undefined) out.singleTransaction = true;
  if ((engine === 'redis' || engine === 'valkey') && out.confirmReplace !== true) {
    throw unprocessable('An RDB import replaces the whole dataset: set options.confirmReplace to true', 'import_confirm_replace');
  }
  return out;
}

/** Skipping the safety backup: an operator, or a database initialised in the last 10 minutes. */
export function canSkipSafetyBackup(d: Pick<Database, 'initializedAt'>, isOperator: boolean, now = Date.now()): boolean {
  if (isOperator) return true;
  if (!d.initializedAt) return false;
  const age = now - d.initializedAt.getTime();
  return age >= 0 && age < SAFETY_SKIP_WINDOW_MS;
}

export function assertMaySkipSafetyBackup(
  d: Pick<Database, 'initializedAt'>,
  options: DatabaseImportOptions,
  isOperator: boolean,
  now = Date.now(),
): void {
  if (options.skipSafetyBackup && !canSkipSafetyBackup(d, isOperator, now)) {
    throw forbidden('Skipping the pre-import safety backup is limited to instance operators, or to a database created in the last 10 minutes');
  }
}

// ── disk and S3 keys ───────────────────────────────────────────────────────

type StatFs = (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

/** Free bytes on the filesystem holding `dir`. */
export async function freeBytes(dir: string, statfsImpl: StatFs = statfs): Promise<number> {
  const s = await statfsImpl(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/** 507 unless `dir` has `2 × size + 512 MiB` free (staging plus a decompressed copy). */
export async function assertFreeSpace(dir: string, sizeBytes: number, statfsImpl: StatFs = statfs): Promise<void> {
  const free = await freeBytes(dir, statfsImpl);
  const need = 2 * sizeBytes + FREE_SPACE_MARGIN_BYTES;
  if (free < need) {
    throw new HttpError(
      507,
      'insufficient_storage',
      `Not enough free disk for this import: ${Math.ceil(need / 1048576)} MiB needed (twice the dump plus 512 MiB), ${Math.floor(free / 1048576)} MiB free`,
    );
  }
}

/** 413 above `NINEDEPLOY_IMPORT_MAX_BYTES`. */
export function assertImportSize(sizeBytes: number, maxBytes: number): void {
  if (sizeBytes > maxBytes) {
    throw new HttpError(413, 'payload_too_large', `The dump is ${sizeBytes} bytes; this panel accepts at most ${maxBytes} (NINEDEPLOY_IMPORT_MAX_BYTES)`);
  }
}

/**
 * An S3 key an import may read: inside the destination's prefix, and with no
 * `.` / `..` segment — `new URL()` collapses those, so `ninedeploy/../x`
 * would pass a prefix test and still fetch `x`. Backslashes and control
 * characters are refused for the same reason.
 */
export function keyWithinPrefix(prefix: string, key: string): boolean {
  if (key.startsWith('/') || [...key].some((ch) => ch.charCodeAt(0) < 0x20 || ch === '\u007f' || ch === '\\')) return false;
  if (key.split('/').some((seg) => seg === '.' || seg === '..')) return false;
  const p = prefix.replace(/^\/+|\/+$/g, '');
  return p === '' || key.startsWith(`${p}/`);
}

/** Create the staging file `<dir>/<id>.part`, mode 0600, refusing to reuse a path. */
export async function createStagingFile(dir: string, id: number): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${id}.part`);
  const fh = await open(file, 'wx', 0o600);
  await fh.close();
  await chmod(file, 0o600);
  return file;
}

/** Delete a staging file and its decompressed sibling; never throws. */
export async function removeStaging(file: string | null | undefined): Promise<void> {
  if (!file) return;
  await rm(file, { force: true }).catch(() => undefined);
  await rm(`${file}.raw`, { force: true }).catch(() => undefined);
}

// ── format detection ───────────────────────────────────────────────────────

export type DumpKind = 'empty' | 'envelope' | 'pg_custom' | 'tar' | 'mongo_archive' | 'rdb' | 'text' | 'binary';
export interface DumpSniff {
  /** The file is gzip; `kind` describes the decompressed head. */
  gzip: boolean;
  kind: DumpKind;
}

function classify(buf: Buffer): DumpKind {
  if (buf.length === 0) return 'empty';
  const ascii = buf.subarray(0, 32).toString('latin1');
  if (ascii.startsWith('NDBK1:') || /^v\d+:/.test(ascii)) return 'envelope';
  if (ascii.startsWith('PGDMP')) return 'pg_custom';
  if (buf.length >= 262 && buf.toString('latin1', 257, 262) === 'ustar') return 'tar';
  if (buf.subarray(0, 4).equals(MONGO_ARCHIVE_MAGIC)) return 'mongo_archive';
  if (ascii.startsWith('REDIS') || ascii.startsWith('VALKEY')) return 'rdb';
  if (buf.subarray(0, 8192).includes(0)) return 'binary';
  return 'text';
}

/** Classify a dump by the magic bytes of its head, looking inside one layer of gzip. */
export function sniffBytes(head: Buffer): DumpSniff {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    let inner: Buffer;
    try {
      // A truncated head is expected: flush what decompresses, do not demand the trailer.
      inner = gunzipSync(head, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
    } catch {
      return { gzip: true, kind: 'binary' };
    }
    return { gzip: true, kind: classify(inner.subarray(0, SNIFF_BYTES)) };
  }
  return { gzip: false, kind: classify(head) };
}

export async function sniffFile(file: string): Promise<DumpSniff> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    return sniffBytes(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/** The import format for `engine`, or a 422 naming what the engine accepts. */
export function formatFor(engine: string, sniff: DumpSniff): DatabaseImportFormat {
  assertImportEngine(engine);
  const refuse = (what: string) => unprocessable(`This file is not ${what} (detected: ${sniff.gzip ? 'gzip of ' : ''}${sniff.kind})`, 'import_format');
  switch (engine) {
    case 'postgres':
      if (sniff.kind === 'pg_custom') return 'pg_custom';
      if (sniff.kind === 'text') return 'pg_plain';
      if (sniff.kind === 'tar') {
        throw unprocessable('pg_dump tar and directory formats are not supported: use the custom format (pg_dump -Fc) or plain SQL', 'import_format');
      }
      throw refuse('a pg_dump custom-format archive or plain SQL');
    case 'mysql':
    case 'mariadb':
      if (sniff.kind === 'text') return 'mysql_sql';
      throw refuse('a plain SQL dump (optionally gzipped)');
    case 'mongo':
      if (sniff.kind === 'mongo_archive') return 'mongo_archive';
      throw refuse('a mongodump --archive file (optionally gzipped)');
    default:
      if (sniff.kind === 'rdb') return 'rdb';
      throw refuse('an RDB snapshot');
  }
}

// ── streaming checks ───────────────────────────────────────────────────────

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Decompress `src` into `dest` (mode 0600), refusing to write more than
 * `limitBytes` — a gzip bomb must not fill the disk the panel's own database
 * lives on.
 */
export async function gunzipTo(src: string, dest: string, limitBytes: number): Promise<void> {
  let written = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      written += chunk.length;
      if (written > limitBytes) {
        done(new Error(`the decompressed dump exceeds the ${Math.floor(limitBytes / 1048576)} MiB of free disk available`));
        return;
      }
      done(null, chunk);
    },
  });
  try {
    await pipeline(createReadStream(src), createGunzip(), cap, createWriteStream(dest, { mode: 0o600 }));
  } catch (err) {
    await rm(dest, { force: true }).catch(() => undefined);
    throw new Error(`could not decompress the dump: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Feed `file` as UTF-8 text, chunk by chunk (bounded memory whatever the line lengths). */
async function* textChunks(file: string): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) {
    const text = decoder.write(chunk as Buffer);
    if (text) yield text;
  }
  const tail = decoder.end();
  if (tail) yield tail;
}

const MYSQL_SYSTEM = '(?:mysql|sys|performance_schema|information_schema)';
/** Checked against the dump's CODE only: string literals blanked, comments dropped. */
const MYSQL_CODE_RES = [
  // Any system-schema qualifier, whatever keyword precedes it (`mysql`.`user`, sys . x).
  new RegExp(`\`?\\b${MYSQL_SYSTEM}\`?\\s*\\.`, 'i'),
  new RegExp(`\\bUSE\\s+\`?${MYSQL_SYSTEM}\`?(?![\\w$])`, 'i'),
  new RegExp(`\\bCREATE\\s+(?:DATABASE|SCHEMA)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?\`?${MYSQL_SYSTEM}\`?(?![\\w$])`, 'i'),
];
/**
 * Checked against the RAW text: sql_mode values that change how the server
 * lexes quotes and backslashes, so the code view below would no longer be
 * the server's. A dump that sets them is refused rather than guessed at.
 */
const MYSQL_LEXER_MODE_RE = /NO_BACKSLASH_ESCAPES|ANSI_QUOTES|sql_mode[^;\n]{0,200}\bANSI\b/i;
/** mysql client commands at the start of a line (the backslash forms are refused anywhere). */
const MYSQL_CLIENT_COMMAND_RE = /^(?:use|connect|source|system|tee|pager|edit)(?:\s|;|$)/i;
/** What mariadb-dump (10.5.25+ / 11.x) writes first: turns the client's sandbox mode on. */
const MARIADB_SANDBOX_LINE = String.raw`/*M!999999\- enable the sandbox mode */`;
/** The one `USE` a dump may carry: the target database itself. */
const MYSQL_USE_APP_RE = /^USE\s+(?:`app`|app)\s*;?\s*$/i;

/**
 * Non-operators: the first thing in a mysql/mariadb dump that reaches a
 * system schema (`mysql`, `sys`, `performance_schema`, `information_schema`)
 * or a client command, or null.
 *
 * The dump is lexed the way the server reads it — '…' and "…" literals
 * (backslash escapes, doubled quotes), `…` identifiers, `-- `, `#` and
 * slash-star comments, while versioned comments (`/*!40101 …`, `/*M!…`) are
 * code — and the patterns run on what is left:
 *  - any system-schema qualifier (`mysql`.`user`, `sys . x`), `USE` or
 *    `CREATE DATABASE` of one;
 *  - a backslash outside a literal (every `\u`, `\r`, `\.`, `\!` client
 *    command), and the named commands `use`, `connect`, `source`, `system`,
 *    `tee`, `pager`, `edit` at the start of a line — except `USE app;`;
 *  - sql_mode values that change the lexing itself (refused, not guessed).
 *
 * What this and the sandbox flag are for: blocking client-side shell escapes
 * and accidental damage to the system schemas. They are not the privilege
 * boundary. The import runs as root — the only account a managed
 * mysql/mariadb has — and the boundary is the route's `admin` floor, which
 * already receives that same root password from `GET /databases/:id/credentials`.
 * (A limited per-database account is an open follow-up, not 0.14.)
 */
export async function scanMysqlDump(file: string): Promise<string | null> {
  type Mode = 'normal' | 'squote' | 'dquote' | 'btick' | 'block' | 'line';
  let mode: Mode = 'normal';
  let versioned = false;
  /** Sanitized code, scanned and trimmed as it grows. */
  let code = '';
  /** The start of the current line, while the line began outside any literal or comment. */
  let head = '';
  let headOpen = true;
  let raw = '';
  let carry = '';

  const codeHit = (): string | null => {
    for (const re of MYSQL_CODE_RES) {
      const m = re.exec(code);
      if (m) return m[0].replace(/\s+/g, ' ').slice(0, 120);
    }
    return null;
  };
  const endLine = (): string | null => {
    if (headOpen) {
      const line = head.replace(/\r$/, '').trimStart();
      if (MYSQL_CLIENT_COMMAND_RE.test(line) && !MYSQL_USE_APP_RE.test(line)) return line.slice(0, 120);
    }
    head = '';
    headOpen = mode === 'normal';
    return null;
  };

  const feed = (text: string, final: boolean): string | null => {
    raw = (raw + text).slice(-(text.length + 512));
    const modeHit = MYSQL_LEXER_MODE_RE.exec(raw);
    if (modeHit) return modeHit[0].slice(0, 120);
    // Keep the last characters back: every token decided here fits in 64.
    const n = final ? text.length : Math.max(0, text.length - 64);
    let i = 0;
    while (i < n) {
      const c = text[i]!;
      if (c === '\n') {
        if (mode === 'line') mode = 'normal';
        const hit = endLine();
        if (hit) return hit;
        if (mode === 'normal') code += ' ';
        i++;
        continue;
      }
      if (headOpen && head.length < 256) head += c;
      if (mode === 'normal') {
        if (c === '\\') return `${(head || c).trim().slice(0, 120)} (a client command outside a literal)`;
        if (c === "'" || c === '"') {
          mode = c === "'" ? 'squote' : 'dquote';
          code += "''";
          i++;
          continue;
        }
        if (c === '`') {
          mode = 'btick';
          code += c;
          i++;
          continue;
        }
        if (c === '#' || (c === '-' && text[i + 1] === '-' && /[\s]/.test(text[i + 2] ?? '\n'))) {
          mode = 'line';
          code += ' ';
          i++;
          continue;
        }
        if (c === '/' && text[i + 1] === '*') {
          // mariadb-dump's first line SWITCHES ON the client sandbox: a comment to us.
          if (text.startsWith(MARIADB_SANDBOX_LINE, i)) {
            code += ' ';
            i += MARIADB_SANDBOX_LINE.length;
            continue;
          }
          const opener = text[i + 2] === '!' ? 3 : text[i + 2] === 'M' && text[i + 3] === '!' ? 4 : 0;
          if (opener) {
            // A versioned comment is code; its version number is not.
            versioned = true;
            code += ' ';
            i += opener;
            while (i < n && /\d/.test(text[i]!)) i++;
            continue;
          }
          mode = 'block';
          code += ' ';
          i += 2;
          continue;
        }
        if (versioned && c === '*' && text[i + 1] === '/') {
          versioned = false;
          code += ' ';
          i += 2;
          continue;
        }
        code += c;
        i++;
        continue;
      }
      if (mode === 'squote' || mode === 'dquote') {
        const q = mode === 'squote' ? "'" : '"';
        if (c === '\\') i += 2;
        else if (c === q && text[i + 1] === q) i += 2;
        else {
          if (c === q) mode = 'normal';
          i++;
        }
        continue;
      }
      if (mode === 'btick') {
        code += c;
        if (c === '`' && text[i + 1] === '`') {
          code += '`';
          i += 2;
        } else {
          if (c === '`') mode = 'normal';
          i++;
        }
        continue;
      }
      if (mode === 'block') {
        if (c === '*' && text[i + 1] === '/') {
          mode = 'normal';
          i += 2;
        } else i++;
        continue;
      }
      i++; // line comment
    }
    carry = text.slice(i);
    if (code.length > 65536 || final) {
      const hit = codeHit();
      if (hit) return hit;
      code = code.slice(-512);
    }
    if (final) return endLine();
    return null;
  };

  for await (const text of textChunks(file)) {
    const hit = feed(carry + text, false);
    if (hit) return hit;
  }
  return feed(carry, true);
}

/**
 * psql meta-commands a plain SQL dump may contain: the ones pg_dump itself
 * writes, nothing else (an allowlist, matched against the whole line).
 *
 * - `\connect <db>` (and the `\c` alias): pg_dump `-C` and pg_dumpall emit it
 *   through `appendPsqlMetaConnect` — a bare name made of `[A-Za-z0-9_.]`,
 *   or `fmtId()`'s double-quoted form, or `-reuse-previous=on "dbname=…"`
 *   for names that need a connection string.
 * - `\restrict <key>` / `\unrestrict <key>`: pg_dump 17.6 / 16.10 / 15.14 /
 *   14.19 / 13.22 and later; the key is alphanumeric (generated, or checked
 *   by `--restrict-key`).
 * - `\.`: the end of COPY data (harmless when it appears outside one).
 * - `\set ON_ERROR_STOP on` (or `1` / `true`): turning the stop ON only.
 *   `off` is refused — the whole COPY argument below relies on the stop.
 *
 * No backtick (psql runs backquoted text through the shell), no `|`, no
 * backslash and no colon variable are possible in an allowed line.
 */
const PSQL_ALLOWED_META = [
  /^\\\.$/,
  /^\\(?:connect|c)[ \t]+(?:-reuse-previous=on[ \t]+)?(?:[A-Za-z0-9_.]+|"(?:[^"`|\\:]|"")+")$/,
  /^\\(?:restrict|unrestrict)[ \t]+[A-Za-z0-9]+$/,
  /^\\set[ \t]+ON_ERROR_STOP[ \t]+(?:on|1|true)$/i,
];
/** A COPY … FROM stdin header, one complete statement on one line. Comment
 *  openers are excluded so `COPY t -- x FROM stdin;` (not a statement) never
 *  looks like one; quotes and dollars too, so the lexer's view is the only one. */
const COPY_FROM_STDIN_LINE_RE = /^COPY[ \t](?:(?!--|\/\*)[^;'$\\`])*[ \t]FROM[ \t]+stdin[ \t]*;[ \t]*$/i;
/** Lines outside COPY data are lexed whole; a longer one is refused, not guessed at. */
const PSQL_MAX_LINE = 4 * 1024 * 1024;

type LexMode = 'normal' | 'squote' | 'estring' | 'dquote' | 'dollar' | 'block' | 'copy';
const identChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$\u0080-\uffff]/.test(c);
const DOLLAR_TAG_RE = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]{0,62})?\$/;

/** Lines of `file` (without the newline), each capped at `cap` characters; `truncated` says it was longer. */
async function* cappedLines(file: string, cap: number): AsyncGenerator<{ line: string; truncated: boolean }> {
  let parts: string[] = [];
  let length = 0;
  let truncated = false;
  for await (const text of textChunks(file)) {
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      const piece = nl === -1 ? text.slice(start) : text.slice(start, nl);
      if (!truncated) {
        if (length + piece.length > cap) {
          parts.push(piece.slice(0, cap - length));
          truncated = true;
        } else {
          parts.push(piece);
          length += piece.length;
        }
      }
      if (nl === -1) break;
      yield { line: parts.join(''), truncated };
      parts = [];
      length = 0;
      truncated = false;
      start = nl + 1;
    }
  }
  if (length > 0 || truncated) yield { line: parts.join(''), truncated };
}

/**
 * One pass of psql's lexer over a dump, line by line, under ONE reading of
 * backslashes inside '…' (`standard_conforming_strings` off: they escape; on:
 * they are literal). E'…' always escapes. Returns the offending line, or null.
 */
function psqlLexer(backslashEscapesInStrings: boolean) {
  let mode: LexMode = 'normal';
  let depth = 0;
  let tag = '';
  /** Non-blank SQL since the last `;` (outside quotes and comments). */
  let pending = false;
  const offending = (line: string) => line.trim().slice(0, 120);

  return {
    /** Where the lexer stands at a line start: in a literal, a comment, COPY data, or not. */
    state: () => `${mode}:${depth}:${tag}`,
    line(line: string, truncated: boolean): string | null {
      if (mode === 'copy') {
        if (line === '\\.') mode = 'normal';
        return null;
      }
      if (truncated) return `a line longer than ${PSQL_MAX_LINE / 1048576} MiB outside COPY data`;
      const statementStart = mode === 'normal' && !pending;
      const n = line.length;
      let i = 0;
      let meta = false;
      while (i < n) {
        const c = line[i]!;
        if (mode === 'normal') {
          if (c === '\\') {
            // A meta-command: only at the very start of the line, and allowlisted.
            if (line.slice(0, i).trim() !== '') return offending(line);
            if (!PSQL_ALLOWED_META.some((re) => re.test(line.trim()))) return offending(line);
            meta = true;
            break;
          }
          if (c === '-' && line[i + 1] === '-') break; // comment to end of line
          if (c === '/' && line[i + 1] === '*') {
            mode = 'block';
            depth = 1;
            i += 2;
            continue;
          }
          if (c === "'") {
            const prefix = line[i - 1];
            const eString = (prefix === 'e' || prefix === 'E') && !identChar(line[i - 2]);
            mode = eString || backslashEscapesInStrings ? 'estring' : 'squote';
            pending = true;
            i++;
            continue;
          }
          if (c === '"') {
            mode = 'dquote';
            pending = true;
            i++;
            continue;
          }
          if (c === '$' && !identChar(line[i - 1])) {
            const m = DOLLAR_TAG_RE.exec(line.slice(i, i + 66));
            if (m) {
              mode = 'dollar';
              tag = m[0];
              pending = true;
              i += tag.length;
              continue;
            }
          }
          if (c === ';') pending = false;
          else if (!/\s/.test(c)) pending = true;
          i++;
          continue;
        }
        if (mode === 'squote' || mode === 'dquote') {
          const q = mode === 'squote' ? "'" : '"';
          const j = line.indexOf(q, i);
          if (j === -1) i = n;
          else if (line[j + 1] === q) i = j + 2;
          else {
            mode = 'normal';
            i = j + 1;
          }
          continue;
        }
        if (mode === 'estring') {
          if (c === '\\') i += 2;
          else if (c === "'" && line[i + 1] === "'") i += 2;
          else {
            if (c === "'") mode = 'normal';
            i++;
          }
          continue;
        }
        if (mode === 'dollar') {
          const j = line.indexOf(tag, i);
          if (j === -1) i = n;
          else {
            mode = 'normal';
            i = j + tag.length;
            tag = '';
          }
          continue;
        }
        // block comment (psql and the server both nest them)
        if (c === '/' && line[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (c === '*' && line[i + 1] === '/') {
          depth--;
          i += 2;
          if (depth === 0) mode = 'normal';
        } else i++;
      }
      if (!meta && statementStart && mode === 'normal' && !pending && COPY_FROM_STDIN_LINE_RE.test(line)) mode = 'copy';
      return null;
    },
  };
}

/**
 * Check a plain SQL dump for psql meta-commands before `psql -f` runs it, and
 * return the first offending line (or null when the dump is acceptable).
 *
 * psql executes a backslash command wherever its lexer is outside a quote or
 * comment — mid-line too — so the dump is lexed the way psql lexes it: '…'
 * literals (`''` doubled), E'…' (backslash escapes), "…" identifiers,
 * $$…$$ / $tag$…$tag$ bodies, -- and nested slash-star comments. A
 * backslash in SQL text is allowed only at the start of a line, and only as
 * one of {@link PSQL_ALLOWED_META}.
 *
 * Dual lex: whether a backslash inside '…' escapes depends on the session's
 * `standard_conforming_strings`, which the dump itself can change (a SET, a
 * `set_config()`, a role default picked up by `\connect`). Rather than chase
 * the spellings, the dump is lexed twice — escapes off and on — and refused
 * when the passes disagree on where any line starts (in a literal, a comment,
 * COPY data, or not), or when either pass finds a disallowed meta-command.
 * pg_dump output never disagrees: it writes `standard_conforming_strings = on`
 * and its literals contain no backslash before a quote. (The import also
 * forces the setting on at connect time; see `importCommand`.)
 *
 * COPY data is skipped only after a COPY … FROM stdin header that is a whole,
 * complete statement on its own line, starting outside any quote, comment or
 * unfinished statement. Any other COPY form is lexed as SQL (a false refusal
 * at worst). A header whose COPY then FAILS would make psql read the data
 * lines as commands — `psql -v ON_ERROR_STOP=1` (always on, and `\set
 * ON_ERROR_STOP off` is refused here) stops at that failure instead.
 *
 * Scope: this is defence in depth against surprising client-side execution,
 * NOT the security boundary. The import runs as the database superuser in the
 * tenant's own container, where SQL alone (`COPY … TO PROGRAM`) already
 * reaches a shell. It applies to operators and non-operators alike.
 */
export async function scanPsqlMetaCommands(file: string): Promise<string | null> {
  const literal = psqlLexer(false);
  const escaping = psqlLexer(true);
  const desync = 'the dump reads differently with backslash escapes on and off in string literals (standard_conforming_strings)';
  for await (const { line: rawLine, truncated } of cappedLines(file, PSQL_MAX_LINE)) {
    if (literal.state() !== escaping.state()) return desync;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const hit = literal.line(line, truncated) ?? escaping.line(line, truncated);
    if (hit) return hit;
  }
  return literal.state() === escaping.state() ? null : desync;
}

// ── serialization ──────────────────────────────────────────────────────────

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** The API view of an import row. The staging path never leaves the server. */
export function serializeImport(r: ImportRow) {
  return {
    id: r.id,
    databaseId: r.databaseId,
    source: r.source,
    status: r.status,
    format: r.format ?? null,
    sizeBytes: r.sizeBytes,
    receivedBytes: r.receivedBytes,
    chunkSize: r.chunkSize,
    sha256: r.sha256 ?? null,
    filename: r.filename ?? null,
    destinationId: r.destinationId ?? null,
    objectKey: r.objectKey ?? null,
    options: (r.options ?? {}) as DatabaseImportOptions,
    safetyBackupId: r.safetyBackupId ?? null,
    error: r.error ?? null,
    createdByUserId: r.createdByUserId ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    startedAt: iso(r.startedAt),
    completedAt: iso(r.completedAt),
  };
}

/** Audit meta: size, format, source and S3 key — never the contents. */
export function importAuditMeta(r: Pick<ImportRow, 'id' | 'databaseId' | 'source' | 'sizeBytes' | 'format' | 'destinationId' | 'objectKey'>) {
  return {
    importId: r.id,
    databaseId: r.databaseId,
    source: r.source,
    sizeBytes: r.sizeBytes,
    format: r.format ?? null,
    ...(r.source === 's3' ? { destinationId: r.destinationId ?? null, key: r.objectKey ?? null } : {}),
  };
}

const clip = (s: string) => (s.length > ERROR_MAX_CHARS ? `${s.slice(0, ERROR_MAX_CHARS - 1)}…` : s);

// ── S3 source ──────────────────────────────────────────────────────────────

/**
 * Download an S3 object into the import's staging file (operator imports).
 * Runs in the background after the create route answered: the row goes from
 * `uploading` to `pending` once the size matches what HEAD reported, or to
 * `failed`. A cancel while the download runs wins: the finished file is
 * deleted instead of promoted.
 */
export async function downloadS3Import(
  db: DB,
  row: Pick<ImportRow, 'id' | 'databaseId' | 'source' | 'sizeBytes' | 'format' | 'destinationId' | 'objectKey' | 'stagingPath'>,
  cfg: S3Config,
  actorId: number | null,
  log: (line: string) => void = () => undefined,
): Promise<void> {
  const file = row.stagingPath!;
  try {
    await s3GetToFile(cfg, row.objectKey!, file);
    const size = (await stat(file)).size;
    if (size !== row.sizeBytes) throw new Error(`downloaded ${size} bytes, the object reported ${row.sizeBytes}`);
    await chmod(file, 0o600);
    const [promoted] = await db
      .update(databaseImports)
      .set({ status: 'pending', receivedBytes: size })
      .where(and(eq(databaseImports.id, row.id), eq(databaseImports.status, 'uploading')))
      .returning({ id: databaseImports.id });
    if (!promoted) await removeStaging(file);
    else log(`import #${row.id}: downloaded ${size} bytes from the destination`);
  } catch (err) {
    await removeStaging(file);
    const message = clip(`S3 download failed: ${err instanceof Error ? err.message : String(err)}`);
    const [failed] = await db
      .update(databaseImports)
      .set({ status: 'failed', error: message, completedAt: new Date() })
      .where(and(eq(databaseImports.id, row.id), eq(databaseImports.status, 'uploading')))
      .returning({ id: databaseImports.id })
      .catch(() => []);
    if (failed) void audit(db, actorId, 'database.import.fail', `#${row.id}`, { ...importAuditMeta(row), error: message });
  }
}

// ── the job ────────────────────────────────────────────────────────────────

/** A refusal found while verifying the file: the message is meant for the importer. */
class ImportRefusal extends Error {}

export interface ImportJobContext {
  actorId: number | null;
  /** The caller's operator flag at `start` (token-narrowed, like every route decision). */
  isOperator: boolean;
  /** mysql/mariadb: the client's sandbox flag probed at `start`. */
  sandboxFlag?: string | null;
  log?: (line: string) => void;
}

/**
 * Run a started import to its end. Never throws: every outcome lands on the
 * row (`completed`, `completed_with_warnings` or `failed`) and in the audit
 * log, and the staging file is always deleted.
 *
 * Order: verify (sha256, envelope, format, non-operator scans, RDB check) →
 * safety backup → import → credential probe. Nothing touches the database
 * before every check has passed.
 */
export async function runImportJob(db: DB, importId: number, ctx: ImportJobContext): Promise<void> {
  const tail: string[] = [];
  const log = (line: string) => {
    tail.push(line);
    if (tail.length > 20) tail.shift();
    ctx.log?.(line);
  };
  const cleanups: Array<() => unknown> = [];
  const row = await db.query.databaseImports.findFirst({ where: eq(databaseImports.id, importId) }).catch(() => undefined);
  if (!row) return;
  const meta = () => importAuditMeta(row);
  try {
    const d = await db.query.databases.findFirst({ where: (t, { eq: e }) => e(t.id, row.databaseId) });
    if (!d) throw new ImportRefusal('the database no longer exists');
    if (!row.stagingPath) throw new ImportRefusal('the uploaded file is gone');
    const options = (row.options ?? {}) as DatabaseImportOptions;
    let file = row.stagingPath;

    if (row.sha256) {
      const got = await sha256File(file);
      if (got !== row.sha256) throw new ImportRefusal(`sha256 mismatch: the upload hashes to ${got}, not the ${row.sha256} it was declared with`);
    }

    let sniff = await sniffFile(file);
    let envelope = false;
    if (sniff.kind === 'envelope') {
      if (!ctx.isOperator) throw new ImportRefusal(ENVELOPE_REFUSAL);
      if (sniff.gzip) throw new ImportRefusal('A gzip-compressed NineDeploy backup is not supported: import the backup file itself');
      envelope = true;
      const staged = await stageForRestore(file);
      cleanups.push(staged.cleanup);
      file = staged.path;
      sniff = await sniffFile(file);
      if (sniff.kind === 'envelope') throw new ImportRefusal('the decrypted backup is itself an envelope');
    }
    let format: DatabaseImportFormat;
    try {
      format = formatFor(d.engine, sniff);
    } catch (err) {
      throw new ImportRefusal((err as Error).message);
    }
    if (format !== row.format) {
      await db.update(databaseImports).set({ format }).where(eq(databaseImports.id, row.id));
      row.format = format;
    }
    if (options.clean && format === 'pg_plain') {
      throw new ImportRefusal('options.clean applies to custom-format dumps only; plain SQL carries its own DROP statements');
    }

    if (sniff.gzip && format !== 'mongo_archive') {
      const raw = `${row.stagingPath}.raw`;
      cleanups.push(() => rm(raw, { force: true }).catch(() => undefined));
      const limit = (await freeBytes(path.dirname(raw))) - FREE_SPACE_MARGIN_BYTES;
      log('Decompressing the dump');
      await gunzipTo(file, raw, Math.max(0, limit));
      file = raw;
    }

    if (!ctx.isOperator && !envelope) {
      if (format === 'mysql_sql') {
        const hit = await scanMysqlDump(file);
        if (hit) {
          throw new ImportRefusal(
            `The dump reaches a mysql system schema or a client command (${hit}); only an instance operator may import it`,
          );
        }
      }
    }
    // Operators too: see scanPsqlMetaCommands for why this is not operator-gated.
    if (format === 'pg_plain') {
      const hit = await scanPsqlMetaCommands(file);
      if (hit) {
        throw new ImportRefusal(
          `The dump contains a psql meta-command pg_dump does not write, or text psql would read as one (${hit}). Remove it, or import a custom-format dump (pg_dump -Fc)`,
        );
      }
    }
    if (format === 'mysql_sql' && !ctx.sandboxFlag && !ctx.isOperator) {
      throw new ImportRefusal('This database client has no sandbox flag (--sandbox / --system-command); only an instance operator may import into it');
    }

    if (format === 'rdb') {
      const image = ENGINES[d.engine]?.image(d.version ?? undefined) ?? null;
      const check = await validateDumpFile(d.engine, file, image);
      if (check.outcome !== 'passed') throw new ImportRefusal(`The RDB file did not validate: ${check.error}`);
    }

    const plan: DatabaseImportPlan = {
      format,
      gzip: format === 'mongo_archive' && sniff.gzip,
      clean: options.clean,
      singleTransaction: options.singleTransaction,
      drop: options.drop,
      sandboxFlag: ctx.sandboxFlag ?? null,
    };
    if (!options.skipSafetyBackup) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = path.join(config.paths.backupsDir, `${d.slug}-${stamp}-pre-import.dump`);
      const [b] = await db
        .insert(backups)
        .values({ databaseId: d.id, scope: 'db', label: 'pre-import', status: 'running', path: backupFile })
        .returning({ id: backups.id });
      plan.safetyBackup = {
        file: backupFile,
        onDone: async () => {
          const sizeBytes = (await stat(backupFile).catch(() => ({ size: 0 }))).size;
          await db.update(backups).set({ status: 'completed', sizeBytes }).where(eq(backups.id, b!.id));
          await db.update(databaseImports).set({ safetyBackupId: b!.id }).where(eq(databaseImports.id, row.id));
          void audit(db, ctx.actorId, 'database.import.safety_backup', d.name, { ...meta(), backupId: b!.id, backupSizeBytes: sizeBytes });
        },
        onFailed: async () => {
          await db.update(backups).set({ status: 'failed' }).where(eq(backups.id, b!.id));
        },
      };
    }

    log(`Importing ${format} into ${d.name}`);
    try {
      await importDatabase(d, file, plan, log);
    } catch (err) {
      const lines = tail.slice(-5).join(' | ');
      const hint = format === 'mysql_sql' && /DEFINER|SET_USER_ID|SUPER privilege|SYSTEM_USER/i.test(lines) ? ` ${DEFINER_HINT}` : '';
      throw new Error(`${err instanceof Error ? err.message : String(err)}${lines ? ` — ${lines}` : ''}${hint}`);
    }

    const credentialsOk = await probeDatabaseCredentials(d);
    const status = credentialsOk ? 'completed' : 'completed_with_warnings';
    await db
      .update(databaseImports)
      .set({ status, error: credentialsOk ? null : CREDENTIALS_CHANGED_WARNING, completedAt: new Date(), stagingPath: null })
      .where(eq(databaseImports.id, row.id));
    void audit(db, ctx.actorId, 'database.import.complete', d.name, { ...meta(), status });
  } catch (err) {
    const message = clip(err instanceof Error ? err.message : String(err));
    await db
      .update(databaseImports)
      .set({ status: 'failed', error: message, completedAt: new Date(), stagingPath: null })
      .where(eq(databaseImports.id, row.id))
      .catch(() => undefined);
    void audit(db, ctx.actorId, 'database.import.fail', `#${row.id}`, { ...meta(), error: message });
  } finally {
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch {
        /* best effort */
      }
    }
    await removeStaging(row.stagingPath);
  }
}

// ── recovery and retention (plugins/databaseImports.ts) ────────────────────

/**
 * Boot: no import of THIS process can be running yet, so every `running` row
 * is the previous process's — mark it failed and drop its staging. The
 * database may hold a half-applied import; the pre-import backup is on the row.
 */
export async function recoverInterruptedImports(db: DB): Promise<number[]> {
  const running = await db.query.databaseImports.findMany({ where: eq(databaseImports.status, 'running') });
  const stuck: Array<{ id: number }> = [];
  for (const r of running) {
    const [hit] = await db
      .update(databaseImports)
      .set({ status: 'failed', error: INTERRUPTED_IMPORT_ERROR, completedAt: new Date(), stagingPath: null })
      .where(and(eq(databaseImports.id, r.id), eq(databaseImports.status, 'running')))
      .returning({ id: databaseImports.id });
    if (!hit) continue;
    await removeStaging(r.stagingPath);
    stuck.push(hit);
  }
  if (stuck.length > 0) {
    void audit(db, null, 'database.import.fail', `${stuck.length} import(s) interrupted by a panel restart`, {
      importIds: stuck.map((r) => r.id),
      error: INTERRUPTED_IMPORT_ERROR,
    });
  }
  return stuck.map((r) => r.id);
}

/** `uploading` / `pending` imports idle for 24h become `expired`; their staging is deleted. */
export async function expireStaleImports(db: DB, now = Date.now()): Promise<number[]> {
  const cutoff = new Date(now - STALE_IMPORT_MS);
  const stale = await db.query.databaseImports.findMany({
    where: and(inArray(databaseImports.status, ['uploading', 'pending']), lt(databaseImports.updatedAt, cutoff)),
  });
  const expired: number[] = [];
  for (const r of stale) {
    const [hit] = await db
      .update(databaseImports)
      .set({ status: 'expired', error: 'expired: no activity for 24 hours', completedAt: new Date(now), stagingPath: null })
      .where(and(eq(databaseImports.id, r.id), inArray(databaseImports.status, ['uploading', 'pending'])))
      .returning({ id: databaseImports.id });
    if (!hit) continue;
    await removeStaging(r.stagingPath);
    expired.push(r.id);
  }
  return expired;
}

/** Retention: finished import rows older than 90 days are deleted (the audit trail keeps the same window). */
export async function pruneFinishedImports(db: DB, now = Date.now()): Promise<number> {
  const gone = await db
    .delete(databaseImports)
    .where(
      and(
        inArray(databaseImports.status, [...FINISHED_IMPORT_STATUSES]),
        lt(databaseImports.createdAt, new Date(now - FINISHED_IMPORT_RETENTION_MS)),
      ),
    )
    .returning({ id: databaseImports.id });
  return gone.length;
}

/**
 * Staging files no live import owns — a crash between creating the file and
 * recording it, a cancel racing a download, or files a rollback to 0.13 left
 * behind — older than 24h are deleted. Only `<id>.part` / `<id>.part.raw`
 * names in the imports directory are considered.
 */
export async function pruneOrphanStaging(db: DB, dir = importStagingDir(), now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const live = new Set(
    (
      await db
        .select({ id: databaseImports.id })
        .from(databaseImports)
        .where(inArray(databaseImports.status, ['uploading', 'pending', 'running']))
    ).map((r) => r.id),
  );
  let removed = 0;
  for (const name of names) {
    const m = /^(\d+)\.part(?:\.raw)?$/.exec(name);
    if (!m || live.has(Number(m[1]))) continue;
    const file = path.join(dir, name);
    try {
      const st = await stat(file);
      if (!st.isFile() || now - st.mtimeMs < STALE_IMPORT_MS) continue;
      await rm(file, { force: true });
      removed++;
    } catch {
      /* vanished mid-scan */
    }
  }
  return removed;
}
