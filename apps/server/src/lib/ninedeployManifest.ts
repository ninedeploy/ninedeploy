import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  type NinedeployManifest,
  NINEDEPLOY_MANIFEST_FILENAMES,
  NINEDEPLOY_MANIFEST_MAX_BYTES,
  ninedeployManifest,
  hasSecret,
  type SecretHit,
  scanForSecrets,
} from '@ninedeploy/schemas';
import { isENOENT } from './fsErrors.js';

/**
 * The `.ninedeploy` loader.
 *
 * Three layers of defence before a manifest is accepted:
 *   1. Size cap (16 KB) — large files are abusive or accidental.
 *   2. Secret scan on the raw YAML — refuses AKIA, ghp_, glpat-, etc. before
 *      the parser even runs, so a real credential never gets logged.
 *   3. Zod validation — schema is the source of truth, not the parser.
 *
 * The loader is intentionally small: it produces a parsed object and a path,
 * nothing more. "Apply to a build config", "generate nixpacks.toml",
 * "merge into service config" live in separate helpers so each can be
 * tested in isolation and so a future change in the apply logic does not
 * touch the parse path.
 */

/** Where a manifest was found, plus the parsed payload. */
export interface LoadedManifest {
  /** Absolute path of the file that was loaded. */
  filePath: string;
  /** Repo-relative POSIX form of the same path. */
  relativePath: string;
  manifest: NinedeployManifest;
  /** Secret-pattern hits discovered in the raw file contents. Always empty on
   *  success — the loader refuses to return a manifest when hits exist. */
  rawSecretHits: SecretHit[];
}

/** Thrown when the manifest file exists but is larger than the size cap. */
/**
 * r620: the manifest path exists but is not a regular file (a symlink, FIFO,
 * device or directory). The repo is member-controlled; following such a path
 * read host files into the deploy log (YAML errors quote the source) or hung
 * the panel on `/dev/zero`.
 */
export class ManifestNotRegularFileError extends Error {
  constructor(public readonly filePath: string) {
    super(`.ninedeploy at ${filePath} must be a regular file in the repository (symlinks are not followed)`);
    this.name = 'ManifestNotRegularFileError';
  }
}

export class ManifestTooLargeError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly sizeBytes: number,
  ) {
    super(
      `.ninedeploy at ${filePath} is ${sizeBytes} bytes; the maximum allowed is ${NINEDEPLOY_MANIFEST_MAX_BYTES} bytes`,
    );
    this.name = 'ManifestTooLargeError';
  }
}

/** Thrown when the raw manifest text matches a known secret pattern. */
export class ManifestSecretError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly hits: SecretHit[],
  ) {
    const summary = hits
      .map((h) => `${h.patternId} (${h.redacted})`)
      .join(', ');
    super(
      `.ninedeploy at ${filePath} contains values that look like secrets: ${summary}. ` +
        'Move them to the panel env vault; this file is committed to the repo.',
    );
    this.name = 'ManifestSecretError';
  }
}

/** Thrown when the YAML is malformed. */
export class ManifestParseError extends Error {
  constructor(
    public readonly filePath: string,
    public override readonly cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`.ninedeploy at ${filePath} is not valid YAML: ${reason}`);
    this.name = 'ManifestParseError';
  }
}

/** Thrown when the parsed document does not match the schema. */
export class ManifestValidationError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly issues: ReadonlyArray<{ path: string; message: string }>,
  ) {
    const detail = issues
      .map((i) => `  - ${i.path || '<root>'}: ${i.message}`)
      .join('\n');
    super(`.ninedeploy at ${filePath} failed schema validation:\n${detail}`);
    this.name = 'ManifestValidationError';
  }
}

/**
 * Find the first manifest filename that exists in `workDir`. Returns the
 * absolute path or `null` when none is present. The priority order is the
 * one documented in `NINEDEPLOY_MANIFEST_FILENAMES`; a single repo with two
 * files (e.g. both `.ninedeploy` and `.ninedeploy.yml`) takes the first.
 */
export function findManifestPath(workDir: string): string | null {
  for (const filename of NINEDEPLOY_MANIFEST_FILENAMES) {
    const candidate = path.join(workDir, filename);
    // r620: lstat, not exists — a dangling or hostile symlink is still "the
    // manifest the repo declared", and the loader refuses it by name.
    try {
      lstatSync(candidate);
      return candidate;
    } catch (err) {
      if (!isENOENT(err)) throw err;
      /* absent */
    }
  }
  return null;
}

/**
 * Parse a raw `.ninedeploy` YAML string into a typed object.
 *
 * Throws:
 *   - `ManifestParseError` when the YAML is malformed.
 *   - `ManifestValidationError` when the parsed document fails Zod.
 *
 * Does NOT scan for secrets — callers that load from disk must run the
 * secret scan on the raw text BEFORE this is called, so the values are
 * never logged.
 */
export function parseNinedeployManifest(yamlText: string, filePath = '<string>'): NinedeployManifest {
  let doc: unknown;
  try {
    doc = yaml.load(yamlText, { filename: filePath });
  } catch (err) {
    throw new ManifestParseError(filePath, err);
  }
  if (doc == null) {
    throw new ManifestValidationError(filePath, [
      { path: '', message: 'manifest is empty' },
    ]);
  }
  const result = ninedeployManifest.safeParse(doc);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    throw new ManifestValidationError(filePath, issues);
  }
  return result.data;
}

/**
 * Read, scan and parse the manifest in `workDir`. Returns `null` when no
 * manifest file is present — a missing manifest is not an error, the build
 * continues with auto-detected defaults.
 *
 * Throws on size cap, secret hit, parse error, or schema mismatch.
 */
export function loadNinedeployManifest(workDir: string): LoadedManifest | null {
  const filePath = findManifestPath(workDir);
  if (!filePath) return null;

  // Synchronous on purpose (16 KB cap) so the rest of the function stays
  // linear and testable. r620: only a regular file is read — lstat first,
  // then O_NOFOLLOW so a swap to a symlink between the two is refused too —
  // and the size is checked BEFORE reading, which never goes past the cap.
  // ENOENT (deleted in the gap since findManifestPath) is "no manifest".
  let buf: Buffer;
  let fd: number | null = null;
  try {
    if (!lstatSync(filePath).isFile()) throw new ManifestNotRegularFileError(filePath);
    fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) throw new ManifestNotRegularFileError(filePath);
    if (st.size > NINEDEPLOY_MANIFEST_MAX_BYTES) throw new ManifestTooLargeError(filePath, st.size);
    const chunk = Buffer.alloc(NINEDEPLOY_MANIFEST_MAX_BYTES + 1);
    const n = readSync(fd, chunk, 0, chunk.length, 0);
    if (n > NINEDEPLOY_MANIFEST_MAX_BYTES) throw new ManifestTooLargeError(filePath, n);
    buf = chunk.subarray(0, n);
  } catch (err) {
    if (isENOENT(err)) return null;
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new ManifestNotRegularFileError(filePath);
    throw err;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  const text = buf.toString('utf8');

  const rawSecretHits = scanForSecrets(text);
  if (rawSecretHits.length > 0) {
    throw new ManifestSecretError(filePath, rawSecretHits);
  }

  const manifest = parseNinedeployManifest(text, filePath);
  const relativePath = path.relative(workDir, filePath).split(path.sep).join('/');
  return { filePath, relativePath, manifest, rawSecretHits: [] };
}

/**
 * Cheap boolean variant — used by the build pipeline to decide whether to
 * log a "manifest loaded" line without paying the cost of a Zod parse.
 * Returns `false` for "no manifest" AND for "manifest exists but the secret
 * scan / parse / validation failed" — the caller is expected to invoke
 * `loadNinedeployManifest` separately and surface those errors.
 */
export function hasNinedeployManifest(workDir: string): boolean {
  return findManifestPath(workDir) !== null;
}

/** Re-export so callers do not have to import both modules. */
export { hasSecret, scanForSecrets, type SecretHit };
