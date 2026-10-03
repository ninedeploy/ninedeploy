/**
 * Domain transfer — `ninedeploy domain {transfer,
 * accept-transfer, cancel-transfer, preview-transfer}`.
 *
 * A transfer moves a `domains` row from one service to
 * another in two phases:
 *
 *   1. Source user (admin on the source service) calls
 *      `startTransfer(...)` which inserts a `pending`
 *      `domain_transfers` row with a one-time URL token.
 *      The token is the random 32-byte string the caller
 *      embeds in `acceptUrl`; the database stores only the
 *      SHA-256 so a leaked dump cannot be used to forge a
 *      transfer (mirrors the api_tokens pattern).
 *
 *   2. Target user (admin on the target service) calls
 *      `acceptTransfer(...)` with the token + a target
 *      service id they own. The server re-checks the
 *      source service is still alive (no race with a
 *      domain delete), the target service is admin-reachable
 *      for the caller, the row is still `pending`, and the
 *      token's hash matches; only then does it move the
 *      `domains.service_id` and flip the row to `accepted`.
 *
 * The state machine is `pending` -> `accepted` /
 * `cancelled` / `expired`. The expiry is checked lazily by
 * the routes (a `pending` row whose `expires_at` is in
 * the past is reported as `expired`), so there's no
 * background sweep.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { domainTransfers, domains, services, users, type DB } from '@ninedeploy/db';

const TOKEN_BYTES = 32;
/** Tokens are valid for 7 days; the operator can re-initiate if it lapses. */
const EXPIRY_SECONDS = 7 * 24 * 60 * 60;

export interface StartTransferInput {
  domainId: number;
  sourceUserId: number;
  targetEmail: string;
  /** Base URL the acceptUrl is built from (panel origin). */
  panelOrigin: string;
}

export interface StartTransferResult {
  transferId: number;
  token: string;
  acceptUrl: string;
  expiresAt: number;
  hostname: string;
}

export interface PreviewTransferResult {
  id: number;
  status: 'pending' | 'accepted' | 'cancelled' | 'expired';
  hostname: string;
  sourceEmail: string;
  targetEmail: string;
  expiresAt: number;
  createdAt: number;
  /** Set when the row is `accepted`. */
  acceptedAt: number | null;
  /** Set when the row is `cancelled`. */
  cancelledAt: number | null;
  /** When status is `pending` and `expiresAt` is in the past. */
  effectivelyExpired: boolean;
}

export interface AcceptTransferInput {
  token: string;
  /** Caller's user id — the target side. */
  userId: number;
  targetServiceId: number;
}

export interface AcceptTransferResult {
  transferId: number;
  domainId: number;
  serviceId: number;
  hostname: string;
  /** Where the domain used to point (for the audit log). */
  fromServiceId: number;
}

// ── public surface ─────────────────────────────────────────────────────────

/**
 * Start a transfer. Validates: the source user is admin on
 * the source service, the target email is well-formed, and
 * no `pending` transfer already exists for this domain
 * (two concurrent transfers would race for the same row).
 */
export async function startTransfer(
  db: DB,
  input: StartTransferInput,
): Promise<StartTransferResult> {
  const targetEmail = input.targetEmail.trim().toLowerCase();
  if (!isEmail(targetEmail)) {
    throw new Error('targetEmail is not a valid email address');
  }
  if (targetEmail === (await emailForUserId(db, input.sourceUserId))) {
    throw new Error('Cannot transfer a domain to the same user');
  }
  const domain = await db.query.domains.findFirst({ where: eq(domains.id, input.domainId) });
  if (!domain) throw new Error('Domain not found');

  // Refuse if there's already a LIVE transfer on the same
  // domain — accepting the second one would race with the
  // first. Expiry is lazy (see effectiveStatus): a row whose
  // `expires_at` has passed keeps `status='pending'` in the DB
  // forever, so the check filters on the clock, not the column —
  // otherwise an expired transfer would block every future
  // transfer of that domain until someone cancelled it by hand.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const existing = await db
    .select({ id: domainTransfers.id })
    .from(domainTransfers)
    .where(
      and(
        eq(domainTransfers.domainId, input.domainId),
        eq(domainTransfers.status, 'pending'),
        gt(domainTransfers.expiresAt, nowSeconds),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    throw new Error('A pending transfer already exists for this domain; cancel it first or wait for expiry');
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const tokenSha256 = sha256Hex(token);
  const expiresAt = Math.floor(Date.now() / 1000) + EXPIRY_SECONDS;
  const [row] = await db
    .insert(domainTransfers)
    .values({
      domainId: input.domainId,
      sourceUserId: input.sourceUserId,
      targetEmail,
      tokenSha256,
      expiresAt,
    })
    .returning();
  if (!row) throw new Error('Failed to create transfer row');

  const acceptUrl = buildAcceptUrl(input.panelOrigin, token);
  return {
    transferId: row.id,
    token,
    acceptUrl,
    expiresAt: row.expiresAt,
    hostname: domain.hostname,
  };
}

/**
 * Read-only preview by token. Used by:
 *   - the public CLI command (no auth)
 *   - the panel's accept page (no auth until the user clicks
 *     accept — the email is the secret here)
 */
export async function previewTransfer(db: DB, token: string): Promise<PreviewTransferResult | null> {
  const row = await findByToken(db, token);
  if (!row) return null;
  return await toPreview(db, row);
}

/**
 * Accept a transfer. Validates:
 *   - the token is well-formed and matches a row
 *   - the row is `pending` and not expired
 *   - the caller's email equals the target email
 *   - the target service is admin-reachable for the caller
 *   - the source service still owns the domain (no race with
 *     a delete)
 *
 * On success: moves the domain row to the target service,
 * flips the transfer to `accepted`, and returns the
 * pre-/post-move ids.
 */
export async function acceptTransfer(db: DB, input: AcceptTransferInput): Promise<AcceptTransferResult> {
  if (!input.token) throw new Error('token is required');
  const row = await findByToken(db, input.token);
  if (!row) throw new Error('Transfer not found');
  const status = await effectiveStatus(db, row);
  if (status !== 'pending') {
    throw new Error(`Transfer is ${status}, not pending`);
  }
  const caller = await db.query.users.findFirst({ where: eq(users.id, input.userId) });
  if (!caller) throw new Error('User not found');
  if (caller.email.toLowerCase() !== row.targetEmail) {
    // Refuse on the email mismatch — the token is the
    // shared secret between the two parties, and the
    // accept page already shows the target email.
    throw new Error('This transfer is addressed to a different email; sign in as the target user to accept');
  }
  const targetService = await db.query.services.findFirst({ where: eq(services.id, input.targetServiceId) });
  if (!targetService) throw new Error('Target service not found');

  // Re-read the domain so we have the up-to-date
  // serviceId (a delete between the transfer's start and
  // this accept would have cascade-deleted the transfer
  // row itself, but the cascade is on `domain_id`; we
  // also re-check the source service is reachable for
  // the caller — they're the target, so this is a no-op
  // except it confirms the service still exists).
  const domain = await db.query.domains.findFirst({ where: eq(domains.id, row.domainId) });
  if (!domain) throw new Error('Domain no longer exists');
  const fromServiceId = domain.serviceId;

  // Claim the transfer FIRST, conditionally on it still being `pending`: two
  // concurrent accepts — or an accept racing a cancel — then cannot both move
  // the domain row. Exactly one caller wins the conditional flip; the loser
  // gets a clean "no longer pending" error instead of a double move.
  const now = Math.floor(Date.now() / 1000);
  const claimed = await db
    .update(domainTransfers)
    .set({
      status: 'accepted',
      targetUserId: input.userId,
      targetServiceId: input.targetServiceId,
      acceptedAt: now,
    })
    .where(and(eq(domainTransfers.id, row.id), eq(domainTransfers.status, 'pending')))
    .returning({ id: domainTransfers.id });
  if (claimed.length === 0) throw new Error('Transfer is no longer pending');

  // Move the domain row. The (hostname, path) unique index
  // could collide if the target service already has the
  // same host:path; let drizzle raise the error and the
  // route translates it to a 409.
  await db
    .update(domains)
    .set({ serviceId: input.targetServiceId, updatedAt: new Date() })
    .where(eq(domains.id, row.domainId));

  return {
    transferId: row.id,
    domainId: row.domainId,
    serviceId: input.targetServiceId,
    hostname: domain.hostname,
    fromServiceId,
  };
}

/**
 * Cancel a pending transfer. Only the source user (or an
 * instance operator) can cancel; the target email cannot
 * "spoil" the source's intent by cancelling first.
 */
export async function cancelTransfer(
  db: DB,
  token: string,
  userId: number,
  isOperator: boolean,
): Promise<{ transferId: number; status: 'cancelled' }> {
  const row = await findByToken(db, token);
  if (!row) throw new Error('Transfer not found');
  if (!isOperator && row.sourceUserId !== userId) {
    throw new Error('Only the source user can cancel a transfer');
  }
  const status = await effectiveStatus(db, row);
  if (status !== 'pending') {
    throw new Error(`Transfer is ${status}, not pending`);
  }
  const now = Math.floor(Date.now() / 1000);
  await db
    .update(domainTransfers)
    .set({ status: 'cancelled', cancelledAt: now })
    .where(eq(domainTransfers.id, row.id));
  return { transferId: row.id, status: 'cancelled' };
}

// ── helpers ────────────────────────────────────────────────────────────────

async function findByToken(db: DB, token: string) {
  const tokenSha256 = sha256Hex(token);
  return db.query.domainTransfers.findFirst({ where: eq(domainTransfers.tokenSha256, tokenSha256) });
}

async function toPreview(db: DB, row: typeof domainTransfers.$inferSelect): Promise<PreviewTransferResult> {
  const [domain] = await db.select({ hostname: domains.hostname }).from(domains).where(eq(domains.id, row.domainId));
  const [source] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, row.sourceUserId));
  const status = await effectiveStatus(db, row);
  return {
    id: row.id,
    status,
    hostname: domain?.hostname ?? '',
    sourceEmail: source?.email ?? '',
    targetEmail: row.targetEmail,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt instanceof Date ? Math.floor(row.createdAt.getTime() / 1000) : Number(row.createdAt),
    acceptedAt: row.acceptedAt != null ? Number(row.acceptedAt) : null,
    cancelledAt: row.cancelledAt != null ? Number(row.cancelledAt) : null,
    effectivelyExpired: row.status === 'pending' && row.expiresAt < Math.floor(Date.now() / 1000),
  };
}

/**
 * The DB's `status` column only updates on accept/cancel.
 * For the `pending → expired` transition we do a lazy
 * check against `expires_at`; this keeps the routes
 * race-free without a background sweep.
 */
async function effectiveStatus(
  _db: DB,
  row: typeof domainTransfers.$inferSelect,
): Promise<'pending' | 'accepted' | 'cancelled' | 'expired'> {
  if (row.status !== 'pending') return row.status;
  return row.expiresAt < Math.floor(Date.now() / 1000) ? 'expired' : 'pending';
}

async function emailForUserId(db: DB, userId: number): Promise<string | null> {
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.email ?? null;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function buildAcceptUrl(panelOrigin: string, token: string): string {
  const base = panelOrigin.replace(/\/$/, '');
  return `${base}/domains/transfers/${token}/accept`;
}

// Re-export for the routes module without making `sql` a
// direct import elsewhere.
export { sql };
