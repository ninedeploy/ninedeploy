import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { count } from 'drizzle-orm';
import { type DB, users } from '@ninedeploy/db';
import { config } from '../config.js';
import { HttpError } from './errors.js';

/**
 * First-run setup token (0.16).
 *
 * The first account on an empty instance becomes the instance operator, and
 * since 0.16 the installer publishes the panel on 0.0.0.0 by default — so
 * anyone who reaches http://<ip>:3000 before the owner does could claim the
 * server. The bootstrap (`POST /v1/setup`, the first `/auth/register`, the
 * first SSO auto-enrolment) therefore needs a one-time token:
 *
 * - `NINEDEPLOY_SETUP_TOKEN` (the installer generates it and prints it), else
 * - in production, `<dataDir>/setup-token`, generated on first use and logged
 *   at boot — covers a bare `docker run` that never saw the installer.
 *
 * Development and test instances without the env var keep the old open
 * bootstrap. The token only matters while the instance has no users, so
 * already-initialised servers are unaffected by the upgrade.
 */

const SETUP_TOKEN_FILENAME = 'setup-token';

export function setupTokenFile(): string {
  return path.join(config.paths.dataDir, SETUP_TOKEN_FILENAME);
}

function readOrCreateFileToken(): string {
  const file = setupTokenFile();
  try {
    const stat = lstatSync(file);
    if (stat.isFile()) {
      const existing = readFileSync(file, 'utf8').trim();
      if (existing.length >= 16) return existing;
    } else {
      throw new Error(`Refusing non-regular setup token path "${file}"`);
    }
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err;
  }
  const generated = randomBytes(18).toString('base64url');
  writeFileSync(file, `${generated}\n`, { mode: 0o600 });
  return generated;
}

/** The token the bootstrap must present, or null when none is required. */
export function requiredSetupToken(): string | null {
  const fromEnv = (process.env['NINEDEPLOY_SETUP_TOKEN'] ?? '').trim();
  if (fromEnv) return fromEnv;
  if (!config.isProd) return null;
  return readOrCreateFileToken();
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Throws 403 `setup_token_required` unless `provided` matches the required token. */
export function assertSetupToken(provided: string | undefined): void {
  const required = requiredSetupToken();
  if (required === null) return;
  if (provided && sameToken(provided.trim(), required)) return;
  throw new HttpError(
    403,
    'setup_token_required',
    'A valid setup token is required to create the first admin account. The installer printed it; it is also in the server log and in the setup-token file in the data directory.',
  );
}

/** Drop the generated token file once the first admin exists (best effort). */
export function clearSetupTokenFile(): void {
  try {
    rmSync(setupTokenFile(), { force: true });
  } catch {
    // The token is inert once a user exists; a leftover file is harmless.
  }
}

/**
 * Boot banner: while the instance has no users, say that the bootstrap needs
 * the setup token and where it is. A generated (file) token is logged in
 * full — for a bare `docker run` the log is the only place an operator can
 * read it without exec-ing into the container. An installer-provided one is
 * already in the operator's .env and terminal, so only its source is named.
 */
export async function announceSetupToken(db: DB, log: { warn: (msg: string) => void }): Promise<void> {
  const [row] = await db.select({ n: count() }).from(users);
  if ((row?.n ?? 0) > 0) return;
  const fromEnv = (process.env['NINEDEPLOY_SETUP_TOKEN'] ?? '').trim() !== '';
  const token = requiredSetupToken();
  if (token === null) return;
  log.warn(
    fromEnv
      ? 'First-run setup: creating the admin account requires the setup token from NINEDEPLOY_SETUP_TOKEN (the installer printed it).'
      : `First-run setup: creating the admin account requires this setup token: ${token} (also in ${setupTokenFile()}).`,
  );
}
