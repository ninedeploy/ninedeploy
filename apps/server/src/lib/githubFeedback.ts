import { and, asc, eq } from 'drizzle-orm';
import {
  deployments,
  domains,
  githubAppInstallations,
  githubApps,
  githubPrComments,
  serviceGithubLinks,
  services,
  type DB,
  type GithubApp,
  type GithubAppInstallation,
  type Service,
  type ServiceGithubLink,
} from '@ninedeploy/db';
import { GithubAppError, githubApi, installationToken } from './githubApp.js';
import { createKeyedOperationGuard } from './keyedOperationGuard.js';
import { redactSecrets } from './redactSecret.js';

/**
 * Deploy feedback to GitHub (0.13), opt-in per GitHub link:
 *
 *   • `report_status` — a commit status per deploy (`ninedeploy/<slug>`, or
 *     `ninedeploy/<parent-slug>/preview` for a PR preview): pending when the
 *     deploy starts, then success / failure / error.
 *   • `pr_comment` — one comment per pull request (previews only), upserted
 *     on every preview deploy and edited to "destroyed" on teardown.
 *
 * A preview has no link of its own; it reports through its parent's.
 *
 * Observational only: every entry point swallows its own failures and logs
 * them redacted, so GitHub being down, a revoked installation or a missing
 * permission never fails or delays a deploy. Tokens are minted per call with
 * the one permission each request needs (`statuses: write` /
 * `pull_requests: write`), scoped to the linked repository.
 */

/** The logger surface this module writes to (a Fastify logger satisfies it). */
export interface FeedbackLog {
  warn(obj: object, msg: string): void;
}

export type CommitState = 'pending' | 'success' | 'failure' | 'error';

const SHA40 = /^[0-9a-f]{40}$/;
const DESCRIPTION_MAX = 140;

/** The marker that starts every NineDeploy preview comment for one parent service. */
export function previewCommentMarker(parentServiceId: number): string {
  return `<!-- ninedeploy:preview:${parentServiceId} -->`;
}

/** A deploy outcome (`deployment.status_changed` status) as a commit status state; null = not reported. */
export function commitStateFor(status: string | undefined): Exclude<CommitState, 'pending'> | null {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'failure';
  if (status === 'cancelled') return 'error';
  return null;
}

/** The deployment's commit as a full 40-hex SHA, else null (GitHub keys statuses on the full SHA). */
function fullSha(value: string | null | undefined): string | null {
  const sha = (value ?? '').trim().toLowerCase();
  return SHA40.test(sha) ? sha : null;
}

/** Text from a member-editable field, safe inside a GitHub markdown comment (no mentions, links or HTML). */
function plain(value: string): string {
  return value.replace(/[`*_[\]<>@#|\\!~]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

interface LinkContext {
  owner: Service;
  link: ServiceGithubLink;
  inst: GithubAppInstallation;
  app: GithubApp;
}

interface FeedbackTarget extends LinkContext {
  /** The service that deployed: `owner` itself, or a PR preview of it. */
  service: Service;
  isPreview: boolean;
}

/** The ENABLED link of `ownerServiceId` on a live installation, with its App. */
async function linkContext(db: DB, ownerServiceId: number): Promise<LinkContext | null> {
  const link = await db.query.serviceGithubLinks.findFirst({ where: eq(serviceGithubLinks.serviceId, ownerServiceId) });
  if (!link?.enabled || (!link.reportStatus && !link.prComment)) return null;
  const inst = await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.id, link.installationRowId) });
  if (!inst || inst.suspendedAt || inst.removedAt) return null;
  const app = await db.query.githubApps.findFirst({ where: eq(githubApps.id, inst.githubAppId) });
  if (!app) return null;
  const owner = await db.query.services.findFirst({ where: eq(services.id, ownerServiceId) });
  if (!owner) return null;
  return { owner, link, inst, app };
}

async function feedbackTarget(db: DB, serviceId: number): Promise<FeedbackTarget | null> {
  const service = await db.query.services.findFirst({ where: eq(services.id, serviceId) });
  if (!service) return null;
  const isPreview = service.previewParentServiceId != null;
  const ctx = await linkContext(db, service.previewParentServiceId ?? service.id);
  return ctx ? { ...ctx, service, isPreview } : null;
}

async function firstDomainUrl(db: DB, serviceId: number): Promise<string | null> {
  const row = await db.query.domains.findFirst({ where: eq(domains.serviceId, serviceId), orderBy: [asc(domains.id)] });
  return row?.hostname ? `https://${row.hostname}` : null;
}

function statusDescription(state: CommitState, service: Service): string {
  const name = service.name.trim();
  const text =
    state === 'pending'
      ? `Deploying ${name}`
      : state === 'success'
        ? `Deployed ${name}`
        : state === 'failure'
          ? `Deploy of ${name} failed`
          : `Deploy of ${name} was cancelled`;
  return text.slice(0, DESCRIPTION_MAX);
}

const repoPath = (fullName: string) => fullName.split('/').map(encodeURIComponent).join('/');

/** Mint a repo-scoped token carrying one permission; `tokens` collects it for redaction. */
async function scopedToken(db: DB, ctx: LinkContext, permission: 'statuses' | 'pull_requests', tokens: string[]): Promise<string> {
  const token = await installationToken(db, ctx.app, ctx.inst, {
    repositoryIds: [ctx.link.repoId],
    permissions: { [permission]: 'write' },
  });
  tokens.push(token);
  return token;
}

async function postStatus(db: DB, t: FeedbackTarget, sha: string, state: CommitState, tokens: string[]): Promise<void> {
  const token = await scopedToken(db, t, 'statuses', tokens);
  const context = t.isPreview ? `ninedeploy/${t.owner.slug}/preview` : `ninedeploy/${t.service.slug}`;
  const targetUrl = await firstDomainUrl(db, t.service.id);
  await githubApi(t.app, token, 'POST', `/repos/${repoPath(t.link.repoFullName)}/statuses/${sha}`, {
    state,
    context,
    description: statusDescription(state, t.service),
    ...(targetUrl ? { target_url: targetUrl } : {}),
  });
}

type CommentPhase = 'deploying' | Exclude<CommitState, 'pending'> | 'destroyed';

const PHASE_TEXT: Record<CommentPhase, string> = {
  deploying: 'Deploying',
  success: 'Deployed',
  failure: 'Deploy failed',
  error: 'Deploy cancelled',
  destroyed: 'Preview destroyed',
};

/** The upserted PR comment body. Starts with the parent's marker. */
export function previewCommentBody(opts: {
  parentServiceId: number;
  parentName: string;
  prNumber: number;
  phase: CommentPhase;
  url: string | null;
  sha: string | null;
}): string {
  const lines = [
    previewCommentMarker(opts.parentServiceId),
    `**NineDeploy preview** for ${plain(opts.parentName) || `service ${opts.parentServiceId}`} (PR #${opts.prNumber})`,
    '',
    `- Status: **${PHASE_TEXT[opts.phase]}**`,
  ];
  if (opts.phase !== 'destroyed') lines.push(`- Preview: ${opts.url ?? 'no domain'}`);
  if (opts.sha) lines.push(`- Commit: \`${opts.sha.slice(0, 7)}\``);
  return lines.join('\n');
}

/** One PR comment upsert per (parent service, PR) at a time, so two deploys never create two comments. */
const commentGuard = createKeyedOperationGuard<string>();

/**
 * PATCH the stored comment; when GitHub answers 404 (deleted by someone) or
 * nothing is stored yet, POST a new one and remember its id. With
 * `createIfMissing: false` (teardown) a missing comment is left missing.
 */
async function upsertComment(
  db: DB,
  ctx: LinkContext,
  prNumber: number,
  body: string,
  sha: string | null,
  tokens: string[],
  createIfMissing = true,
): Promise<void> {
  await commentGuard(`${ctx.owner.id}:${prNumber}`, async () => {
    const token = await scopedToken(db, ctx, 'pull_requests', tokens);
    const repo = repoPath(ctx.link.repoFullName);
    const row = await db.query.githubPrComments.findFirst({
      where: and(eq(githubPrComments.serviceId, ctx.owner.id), eq(githubPrComments.prNumber, prNumber)),
    });
    if (row) {
      try {
        await githubApi(ctx.app, token, 'PATCH', `/repos/${repo}/issues/comments/${row.commentId}`, { body });
        await db
          .update(githubPrComments)
          .set({ headSha: sha ?? row.headSha, updatedAt: new Date() })
          .where(eq(githubPrComments.id, row.id));
        return;
      } catch (err) {
        if (!(err instanceof GithubAppError && err.status === 404)) throw err;
        // The comment was deleted on GitHub: recreate it below.
      }
    }
    if (!createIfMissing) return;
    const res = await githubApi<{ id?: unknown }>(ctx.app, token, 'POST', `/repos/${repo}/issues/${prNumber}/comments`, { body });
    const commentId = res.data?.id;
    if (typeof commentId !== 'number' || !Number.isSafeInteger(commentId)) return;
    await db
      .insert(githubPrComments)
      .values({ serviceId: ctx.owner.id, prNumber, commentId, headSha: sha })
      .onConflictDoUpdate({
        target: [githubPrComments.serviceId, githubPrComments.prNumber],
        set: { commentId, headSha: sha, updatedAt: new Date() },
      });
  });
}

async function previewComment(db: DB, t: FeedbackTarget, phase: CommentPhase, sha: string | null, tokens: string[]): Promise<void> {
  const prNumber = t.service.prNumber;
  if (!t.isPreview || !t.link.prComment || prNumber == null) return;
  const body = previewCommentBody({
    parentServiceId: t.owner.id,
    parentName: t.owner.name,
    prNumber,
    phase,
    url: await firstDomainUrl(db, t.service.id),
    sha,
  });
  await upsertComment(db, t, prNumber, body, sha, tokens);
}

/** Run one feedback step; any failure is logged redacted and swallowed. */
async function observe(log: FeedbackLog, what: Record<string, unknown>, step: (tokens: string[]) => Promise<void>): Promise<void> {
  const tokens: string[] = [];
  try {
    await step(tokens);
  } catch (err) {
    try {
      log.warn({ ...what, error: redactSecrets(err, tokens) }, 'GitHub feedback failed (the deploy is unaffected)');
    } catch {
      /* a logger failure must not escape either */
    }
  }
}

/** `service.deploying`: a pending status (when the SHA is already known) and a "deploying" preview comment. */
export async function deployingFeedback(db: DB, log: FeedbackLog, serviceId: number, deploymentId: number): Promise<void> {
  await observe(log, { serviceId, deploymentId, phase: 'deploying' }, async (tokens) => {
    const t = await feedbackTarget(db, serviceId);
    if (!t) return;
    const dep = await db.query.deployments.findFirst({ where: eq(deployments.id, deploymentId) });
    const sha = fullSha(dep?.commitSha);
    if (t.link.reportStatus && sha) await postStatus(db, t, sha, 'pending', tokens);
    await previewComment(db, t, 'deploying', sha, tokens);
  });
}

/** `deployment.status_changed`: the final status and the preview comment for a deploy outcome. */
export async function outcomeFeedback(db: DB, log: FeedbackLog, deploymentId: number | undefined, status: string | undefined): Promise<void> {
  const state = commitStateFor(status);
  if (!state || typeof deploymentId !== 'number') return;
  await observe(log, { deploymentId, phase: state }, async (tokens) => {
    const dep = await db.query.deployments.findFirst({ where: eq(deployments.id, deploymentId) });
    if (!dep) return;
    const t = await feedbackTarget(db, dep.serviceId);
    if (!t) return;
    // The SHA the pipeline stamped after checkout.
    const sha = fullSha(dep.commitSha);
    if (t.link.reportStatus && sha) await postStatus(db, t, sha, state, tokens);
    await previewComment(db, t, state, sha, tokens);
  });
}

/** A preview was torn down: edit its PR comment (if one was posted) to say so. */
export async function previewDestroyedFeedback(db: DB, log: FeedbackLog, parentServiceId: number, prNumber: number): Promise<void> {
  await observe(log, { serviceId: parentServiceId, prNumber, phase: 'destroyed' }, async (tokens) => {
    const ctx = await linkContext(db, parentServiceId);
    if (!ctx?.link.prComment) return;
    const row = await db.query.githubPrComments.findFirst({
      where: and(eq(githubPrComments.serviceId, parentServiceId), eq(githubPrComments.prNumber, prNumber)),
    });
    if (!row) return;
    const body = previewCommentBody({
      parentServiceId,
      parentName: ctx.owner.name,
      prNumber,
      phase: 'destroyed',
      url: null,
      sha: row.headSha ?? null,
    });
    await upsertComment(db, ctx, prNumber, body, null, tokens, false);
  });
}
