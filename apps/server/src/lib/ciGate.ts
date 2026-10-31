import { and, asc, eq, gt, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  deployments, githubAppInstallations, githubApps, serviceGithubLinks, services,
  type DB, type Deployment, type DeploymentCiGate, type Service,
} from '@ninedeploy/db';
import { githubApi, githubApiPages, installationToken } from './githubApp.js';
import { githubRepoFromUrl } from './sourceCreds.js';

const WAIT_MS = 2 * 60 * 60_000;
const POLL_MS = 30_000;
const FRESH_MS = 60_000;
const LEASE_MS = 60_000;
const SHA = /^[a-f0-9]{40}$/i;
const repoPath = (name: string) => name.split('/').map(encodeURIComponent).join('/');

/** Only safe, useful evidence is returned to API clients; never tokens or API errors. */
export function ciSummary(gate: DeploymentCiGate | null | undefined) {
  if (!gate) return null;
  return {
    state: gate.state, reason: gate.reason, headSha: gate.headSha,
    deadlineAt: new Date(gate.deadlineAt).toISOString(),
    checkedAt: gate.checkedAt == null ? null : new Date(gate.checkedAt).toISOString(),
    checks: gate.checks,
  };
}

async function policyLink(db: DB, service: Service) {
  return db.query.serviceGithubLinks.findFirst({ where: eq(serviceGithubLinks.serviceId, service.previewParentServiceId ?? service.id) });
}

async function newerStarted(db: DB, dep: Pick<Deployment, 'id' | 'serviceId'>): Promise<boolean> {
  return !!await db.query.deployments.findFirst({ where: and(
    eq(deployments.serviceId, dep.serviceId), gt(deployments.id, dep.id),
    or(isNotNull(deployments.startedAt), inArray(deployments.status, ['building', 'deploying', 'running', 'superseded'])),
  ) });
}

/** No network in the serialized worker claim path. A persisted status holds no build slot. */
export async function holdForCiIfNeeded(db: DB, deploymentId: number, now = Date.now()): Promise<boolean> {
  const dep = await db.query.deployments.findFirst({ where: eq(deployments.id, deploymentId) });
  if (!dep || dep.status !== 'queued') return true;
  const service = await db.query.services.findFirst({ where: eq(services.id, dep.serviceId) });
  if (!service) return true;
  let gate = dep.ciGate;
  if (gate && await newerStarted(db, dep)) {
    await db.update(deployments).set({ status: 'cancelled', finishedAt: new Date(now), ciGate: { ...gate, reason: 'Replaced by a newer deployment' } })
      .where(and(eq(deployments.id, dep.id), eq(deployments.status, 'queued')));
    return true;
  }
  if (!gate) {
    const link = await policyLink(db, service);
    if (!link?.requiredWorkflows.length) return false;
    const owner = service.previewParentServiceId == null ? service : await db.query.services.findFirst({ where: eq(services.id, service.previewParentServiceId) });
    gate = {
      version: 1, linkId: link.id, installationRowId: link.installationRowId,
      repoId: link.repoId, repoFullName: link.repoFullName,
      repoUrl: service.repoUrl ?? '', branch: service.branch,
      ownerServiceId: owner?.id ?? service.id, ownerRepoUrl: owner?.repoUrl ?? '',
      preview: service.previewParentServiceId != null,
      workflows: [...link.requiredWorkflows], headSha: dep.commitSha,
      state: 'waiting', reason: 'Waiting for required GitHub workflows',
      checks: link.requiredWorkflows.map((path) => ({ path, state: 'missing', runId: null, attempt: null })),
      deadlineAt: now + WAIT_MS, checkedAt: null, nextCheckAt: now,
    };
  } else if (gate.state === 'passed' && gate.headSha === dep.commitSha && gate.checkedAt != null && now >= gate.checkedAt && now - gate.checkedAt < FRESH_MS) {
    // Configuration may change while a human approves. Do not use a receipt
    // for a different source, link, installation, or repository.
    try { await context(db, gate, service); return false; } catch { /* held below */ }
  }
  const renewing = gate.state === 'passed';
  await db.update(deployments).set({
    status: 'awaiting_ci',
    ciGate: { ...gate, state: 'waiting', nextCheckAt: now, ...(renewing ? { deadlineAt: now + WAIT_MS } : {}) },
    // A review of "main" cannot approve a SHA resolved later by the poller.
    ...(!dep.commitSha ? { reviewedBy: null, reviewedAt: null } : {}),
  }).where(and(eq(deployments.id, dep.id), eq(deployments.status, 'queued')));
  return true;
}

class SourceChanged extends Error {}

async function context(db: DB, gate: DeploymentCiGate, service: Service) {
  if (service.image || service.composeContent || !service.repoUrl) {
    throw new SourceChanged('Required CI supports repository builds only; change the service source and deploy again');
  }
  if (service.repoUrl !== gate.repoUrl || service.branch !== gate.branch ||
      (service.previewParentServiceId ?? service.id) !== gate.ownerServiceId) {
    throw new SourceChanged('CI source changed; cancel and deploy again');
  }
  const owner = gate.ownerServiceId === service.id ? service : await db.query.services.findFirst({ where: eq(services.id, gate.ownerServiceId) });
  if (owner?.repoUrl !== gate.ownerRepoUrl) throw new SourceChanged('CI source changed; cancel and deploy again');
  const link = await db.query.serviceGithubLinks.findFirst({ where: eq(serviceGithubLinks.id, gate.linkId) });
  if (!link || link.serviceId !== gate.ownerServiceId || link.installationRowId !== gate.installationRowId ||
      link.repoId !== gate.repoId || link.repoFullName !== gate.repoFullName) {
    throw new SourceChanged('CI repository link changed; cancel and deploy again');
  }
  if (!link.enabled) throw new Error('CI GitHub link is disabled');
  const inst = await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.id, gate.installationRowId) });
  if (!inst || inst.removedAt || inst.suspendedAt) throw new Error('CI installation is unavailable');
  const app = await db.query.githubApps.findFirst({ where: eq(githubApps.id, inst.githubAppId) });
  if (!app) throw new Error('CI GitHub App is unavailable');
  const repo = githubRepoFromUrl(gate.ownerRepoUrl, app.webBaseUrl);
  if (repo.fullName.toLowerCase() !== gate.repoFullName.toLowerCase()) throw new SourceChanged('CI source changed; cancel and deploy again');
  // Validate the preview's host too; tokens are only sent to the App API.
  const source = githubRepoFromUrl(gate.repoUrl, app.webBaseUrl);
  if (!gate.preview && source.fullName.toLowerCase() !== gate.repoFullName.toLowerCase()) {
    throw new SourceChanged('CI source changed; cancel and deploy again');
  }
  return { app, inst };
}

/** Last guard before the pipeline can execute hooks or build the checked-out SHA. */
export async function assertCiGateForBuild(db: DB, dep: Deployment, service: Service): Promise<void> {
  const gate = dep.ciGate;
  if (!gate) {
    if ((await policyLink(db, service))?.requiredWorkflows.length) throw new Error('Required CI has not been verified');
    return;
  }
  if (gate.version !== 1 || gate.state !== 'passed' || !gate.headSha || gate.headSha !== dep.commitSha || !SHA.test(gate.headSha)) {
    throw new Error('Required CI has not passed for this exact commit');
  }
  await context(db, gate, service);
  if (await newerStarted(db, dep)) throw new Error('CI candidate was replaced by a newer deployment');
}

const workflowRun = z.object({
  id: z.number().int().positive(), run_attempt: z.number().int().positive(),
  path: z.string(), head_sha: z.string(), event: z.string(),
  status: z.string(), conclusion: z.string().nullable(),
});
const runsResponse = z.object({ workflow_runs: z.array(workflowRun) });

export interface CiGateTransition {
  deploymentId: number;
  serviceId: number;
  status: 'queued' | 'failed' | 'cancelled';
  reason: string;
}

async function checkOne(db: DB, dep: Deployment, now: number, signal: AbortSignal): Promise<CiGateTransition | undefined> {
  const original = dep.ciGate;
  if (!original) return; // old/corrupt row cannot become queued through this path
  const leased = { ...original, nextCheckAt: now + LEASE_MS };
  const won = await db.update(deployments).set({ ciGate: leased }).where(and(
    eq(deployments.id, dep.id), eq(deployments.status, 'awaiting_ci'), eq(deployments.ciGate, original),
  )).returning({ id: deployments.id });
  if (!won.length) return;
  let gate: DeploymentCiGate = { ...leased, checkedAt: now, nextCheckAt: now + POLL_MS };
  let status: 'awaiting_ci' | 'queued' | 'failed' | 'cancelled' = 'awaiting_ci';
  try {
    if (original.version !== 1 || !original.workflows.length) throw new SourceChanged('Invalid CI policy; cancel and deploy again');
    if (now >= original.deadlineAt) throw new SourceChanged('Required CI timed out after two hours; deploy again to retry');
    const service = await db.query.services.findFirst({ where: eq(services.id, dep.serviceId) });
    if (!service) return;
    const { app, inst } = await context(db, original, service);
    const token = await installationToken(db, app, inst, {
      repositoryIds: [original.repoId], permissions: { actions: 'read', contents: 'read' }, signal,
    });
    const path = `/repos/${repoPath(original.repoFullName)}`;
    const repo = await githubApi<{ id?: number }>(app, token, 'GET', path, undefined, { signal });
    if (repo.data?.id !== original.repoId) throw new SourceChanged('CI repository identity changed; deploy again');
    let sha = original.headSha;
    if (!sha) {
      // Fork previews arrive with an exact webhook SHA. Never resolve the
      // fork branch against the parent repository or give a fork our token.
      if (original.preview) throw new SourceChanged('A CI-gated preview requires an exact commit SHA');
      const commit = await githubApi<{ sha?: string }>(app, token, 'GET', `${path}/commits/${encodeURIComponent(original.branch)}`, undefined, { signal });
      sha = commit.data?.sha ?? null;
    }
    if (!sha || !SHA.test(sha)) throw new SourceChanged('GitHub did not return an exact commit SHA');
    if (dep.commitSha && dep.commitSha !== sha) throw new SourceChanged('CI commit changed; deploy again');
    gate = { ...gate, headSha: sha };
    // Persist pin BEFORE more network I/O: a timeout or restart must never
    // resolve an advanced branch to another candidate on the next poll.
    const pinned = { ...leased, headSha: sha };
    const saved = await db.update(deployments).set({ ciGate: pinned, commitSha: sha }).where(and(
      eq(deployments.id, dep.id), eq(deployments.status, 'awaiting_ci'), eq(deployments.ciGate, leased),
    )).returning({ id: deployments.id });
    if (!saved.length) return;
    Object.assign(leased, { headSha: sha });
    const result = await githubApiPages<unknown, z.infer<typeof workflowRun>>(
      app, token, `${path}/actions/runs?head_sha=${sha}`,
      (data) => runsResponse.parse(data).workflow_runs, { maxPages: 10, signal },
    );
    if (result.truncated) throw new Error('Workflow run results are incomplete');
    gate.checks = gate.workflows.map((workflow) => {
      const latest = result.rows.filter((run) => run.head_sha.toLowerCase() === sha.toLowerCase() &&
        run.path.split('@')[0] === workflow &&
        (original.preview ? run.event === 'pull_request' : ['push', 'workflow_dispatch', 'merge_group'].includes(run.event)))
        .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0];
      return {
        path: workflow, runId: latest?.id ?? null, attempt: latest?.run_attempt ?? null,
        state: !latest ? 'missing' : latest.status !== 'completed' ? 'pending' : latest.conclusion === 'success' ? 'success' : 'failure',
      };
    });
    if (gate.checks.some((check) => check.state === 'failure')) {
      gate.state = 'failed'; gate.reason = 'A required GitHub workflow did not succeed; rerun CI and deploy again'; status = 'failed';
    } else if (gate.checks.every((check) => check.state === 'success')) {
      // Check live configuration again after the network boundary.
      const current = await db.query.services.findFirst({ where: eq(services.id, service.id) });
      if (!current) return;
      await context(db, original, current);
      gate.state = 'passed'; gate.reason = 'All required GitHub workflows passed for this exact commit'; status = 'queued';
    } else {
      gate.reason = 'Waiting for required GitHub workflows on the pinned commit';
    }
    if (await newerStarted(db, dep)) { status = 'cancelled'; gate.reason = 'Replaced by a newer deployment'; }
  } catch (err) {
    if (err instanceof SourceChanged) { status = 'failed'; gate.state = 'failed'; gate.reason = err.message; }
    else gate.reason = 'GitHub could not verify CI. Check the App link, repository access and Actions read permission; retrying.';
  }
  if (signal.aborted) return;
  const changed = await db.update(deployments).set({
    status, ciGate: gate, ...(status === 'failed' || status === 'cancelled' ? { finishedAt: new Date(now) } : {}),
  }).where(and(eq(deployments.id, dep.id), eq(deployments.status, 'awaiting_ci'), eq(deployments.ciGate, leased))).returning({ id: deployments.id });
  if (changed.length && status !== 'awaiting_ci') return { deploymentId: dep.id, serviceId: dep.serviceId, status, reason: gate.reason };
}

/** Four bounded HTTP checks, independent of build slots. Leases survive restart. */
export async function pollCiGates(db: DB, opts: { now?: number; signal?: AbortSignal } = {}): Promise<CiGateTransition[]> {
  const now = opts.now ?? Date.now();
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000);
  const due = await db.query.deployments.findMany({
    // Rows without a gate wait on a runner job (ciDeployGate.ts): they would sort first and fill every slot.
    where: and(eq(deployments.status, 'awaiting_ci'), isNotNull(deployments.ciGate), sql`coalesce(json_extract(${deployments.ciGate}, '$.nextCheckAt'), 0) <= ${now}`),
    orderBy: [asc(sql`coalesce(json_extract(${deployments.ciGate}, '$.nextCheckAt'), 0)`), asc(deployments.id)], limit: 4,
  });
  const results = await Promise.allSettled(due.map((dep) => checkOne(db, dep, now, signal)));
  const errors = results.filter((result) => result.status === 'rejected');
  if (errors.length) throw new AggregateError(errors.map((result) => result.reason), 'CI gate database operations failed');
  return results.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
}
