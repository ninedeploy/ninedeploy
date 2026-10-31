import { readFileSync } from 'node:fs';
import type { CiJobView, CiRunnerView } from '@ninedeploy/schemas';
import type { NineDeployClient } from '../client.js';
import { c, error, fmtTime, header, info, kv, spinner, success, table } from '../lib/format.js';
import { terminalSafe } from './logs.js';
import { plain } from './sources.js';
import { resolveServiceRef } from './uptime.js';

/**
 * R5 CI jobs on enrolled runners:
 *
 *   ninedeploy ci runners list [--json]
 *   ninedeploy ci runners add <name> [--labels a,b] [--capacity n]
 *   ninedeploy ci runners revoke <id>
 *   ninedeploy ci pipeline <service> [--json]
 *   ninedeploy ci set <service> <pipeline.json>
 *   ninedeploy ci jobs <service> [--json]
 *   ninedeploy ci run <service> [--ref <branch or commit>] [--follow]
 *   ninedeploy ci log <service> <job> [--attempt n] [--follow]
 *   ninedeploy ci approve|cancel <service> <job>
 *
 * `<service>` is an id, a slug or a name.
 */

const message = (err: unknown): string => plain(err instanceof Error ? err.message : String(err));
const load = <T>(json: boolean | undefined, msg: string, fn: () => Promise<T>): Promise<T> => (json ? fn() : spinner(msg, fn));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LIVE = ['awaiting_approval', 'queued', 'running'];

function positive(raw: string, what: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    error(`${what} must be a positive integer`);
    return null;
  }
  return n;
}

const statusText = (s: CiJobView['status']): string =>
  s === 'succeeded' ? c.green(s) : s === 'failed' ? c.red(s) : s === 'cancelled' ? c.gray(s) : c.yellow(s);

/** `ninedeploy ci runners list [--json]` (operator) */
export async function ciRunnersList(client: NineDeployClient, opts: { json?: boolean } = {}): Promise<void> {
  try {
    const runners = await load(opts.json, 'Loading runners', () => client.ci.runners.list());
    if (opts.json) {
      console.log(JSON.stringify(runners, null, 2));
      return;
    }
    header('CI runners');
    if (runners.length === 0) {
      info('No runner yet. Add one with `ninedeploy ci runners add <name>`.');
      return;
    }
    table(
      runners.map((r: CiRunnerView) => ({
        id: r.id,
        name: plain(r.name),
        state: r.revokedAt ? c.gray('revoked') : r.online ? c.green('online') : c.yellow('offline'),
        labels: r.labels.join(',') || c.dim('—'),
        running: `${r.running}/${r.capacity}`,
        seen: r.lastSeenAt ? fmtTime(r.lastSeenAt) : c.dim('never'),
      })),
      ['id', 'name', 'state', 'labels', 'running', 'seen'],
    );
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy ci runners add <name> [--labels a,b] [--capacity n]` (operator) */
export async function ciRunnersAdd(client: NineDeployClient, name: string, opts: { labels?: string; capacity?: string } = {}): Promise<void> {
  let capacity: number | undefined;
  if (opts.capacity !== undefined) {
    const n = positive(opts.capacity, '--capacity');
    if (n === null) return;
    capacity = n;
  }
  const labels = (opts.labels ?? '').split(/[\s,]+/).filter(Boolean);
  try {
    const r = await spinner('Adding the runner', () => client.ci.runners.create({ name, labels, ...(capacity ? { capacity } : {}) }));
    success(`Runner "${plain(r.name)}" added (id ${r.id}). Its token is shown only this once:`);
    console.log(r.token);
    info('Start the runner with NINEDEPLOY_RUNNER_URL and NINEDEPLOY_RUNNER_TOKEN set (see docs/CI_RUNNERS.md).');
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy ci runners revoke <id>` (operator) */
export async function ciRunnersRevoke(client: NineDeployClient, rawId: string): Promise<void> {
  const id = positive(rawId, 'The runner id');
  if (id === null) return;
  try {
    await spinner('Revoking', () => client.ci.runners.revoke(id));
    success(`Runner ${id} revoked: its token no longer works and its running jobs were requeued.`);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy ci pipeline <service> [--json]` */
export async function ciPipelineShow(client: NineDeployClient, ref: string, opts: { json?: boolean } = {}): Promise<void> {
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    const { pipeline } = await load(opts.json, 'Loading the pipeline', () => client.ci.pipeline(id));
    if (opts.json) {
      console.log(JSON.stringify(pipeline, null, 2));
      return;
    }
    if (!pipeline) {
      info('This service has no CI pipeline. Set one with `ninedeploy ci set <service> <pipeline.json>`.');
      return;
    }
    header('CI pipeline');
    kv('Image', pipeline.image);
    kv('Labels', pipeline.labels.join(', ') || '—');
    kv('Variables', pipeline.secrets.join(', ') || '—');
    kv('Timeout', `${pipeline.timeoutMinutes} min`);
    kv('Attempts', pipeline.maxAttempts);
    kv('On push', pipeline.runOnPush ? 'yes' : 'no');
    kv('Gates deploys', pipeline.gateDeploys ? 'yes' : 'no');
    kv('Approval', pipeline.requireApproval ? 'every job' : 'no');
    console.log(`\n${pipeline.script}`);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy ci set <service> <pipeline.json>` (service admin) */
export async function ciPipelineSet(client: NineDeployClient, ref: string, file: string): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    error(`Could not read ${plain(file)} as JSON: ${message(err)}`);
    return;
  }
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    await spinner('Saving the pipeline', () => client.ci.setPipeline(id, body as never));
    success('CI pipeline saved.');
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy ci jobs <service> [--json]` */
export async function ciJobsList(client: NineDeployClient, ref: string, opts: { json?: boolean } = {}): Promise<void> {
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    const jobs = await load(opts.json, 'Loading jobs', () => client.ci.jobs.list(id));
    if (opts.json) {
      console.log(JSON.stringify(jobs, null, 2));
      return;
    }
    header('CI jobs');
    if (jobs.length === 0) {
      info('No job has run yet.');
      return;
    }
    table(
      jobs.map((j) => ({
        id: j.id,
        status: statusText(j.status),
        trigger: j.deploymentId !== null ? `deploy #${j.deploymentId}` : j.trigger,
        commit: j.commitSha ? j.commitSha.slice(0, 7) : c.dim(j.ref ?? '—'),
        attempts: `${j.attempts}/${j.maxAttempts}`,
        created: fmtTime(j.createdAt),
      })),
      ['id', 'status', 'trigger', 'commit', 'attempts', 'created'],
    );
  } catch (err) {
    error(message(err));
  }
}

/** Print an attempt's log from the start; with `follow`, until the attempt is over. */
async function printLog(client: NineDeployClient, serviceId: number, jobId: number, attempt: number, follow: boolean, pollMs: number): Promise<void> {
  let offset = 0;
  for (;;) {
    const slice = await client.ci.jobs.log(serviceId, jobId, attempt, { offset });
    // Job output is untrusted: colours stay, other terminal control sequences go.
    if (slice.data) process.stdout.write(terminalSafe(slice.data));
    offset = slice.size;
    if (slice.done || !follow) return;
    await sleep(pollMs);
  }
}

/** Follow a job: wait for its attempts and print each one's log, then exit non-zero unless it succeeded. */
async function followJob(client: NineDeployClient, serviceId: number, jobId: number, pollMs: number): Promise<void> {
  let printed = 0;
  for (;;) {
    const { job, attempts } = await client.ci.jobs.get(serviceId, jobId);
    for (const a of attempts.filter((x) => x.number > printed)) {
      info(`Attempt ${a.number}${a.runnerName ? ` on ${plain(a.runnerName)}` : ''}`);
      await printLog(client, serviceId, jobId, a.number, true, pollMs);
      printed = a.number;
    }
    if (!LIVE.includes(job.status)) {
      if (job.status === 'succeeded') success(`Job #${job.id} succeeded.`);
      else error(`Job #${job.id} ${job.status}${job.error ? `: ${plain(job.error)}` : ''}`);
      return;
    }
    await sleep(pollMs);
  }
}

/** `ninedeploy ci run <service> [--ref x] [--follow]` */
export async function ciRun(client: NineDeployClient, ref: string, opts: { ref?: string; follow?: boolean; pollMs?: number } = {}): Promise<void> {
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    const job = await spinner('Starting the job', () => client.ci.jobs.create(id, opts.ref ? { ref: opts.ref } : {}));
    success(`Job #${job.id} ${job.status === 'awaiting_approval' ? 'is waiting for an admin to approve it' : 'is queued'}.`);
    if (opts.follow) await followJob(client, id, job.id, opts.pollMs ?? 2000);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy ci log <service> <job> [--attempt n] [--follow]` */
export async function ciLog(
  client: NineDeployClient,
  ref: string,
  rawJob: string,
  opts: { attempt?: string; follow?: boolean; pollMs?: number } = {},
): Promise<void> {
  const jobId = positive(rawJob, 'The job id');
  if (jobId === null) return;
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    if (opts.attempt === undefined && opts.follow) return await followJob(client, id, jobId, opts.pollMs ?? 2000);
    let attempt: number;
    if (opts.attempt !== undefined) {
      const n = positive(opts.attempt, '--attempt');
      if (n === null) return;
      attempt = n;
    } else {
      const { attempts } = await client.ci.jobs.get(id, jobId);
      const last = attempts.at(-1);
      if (!last) {
        info('No runner has taken this job yet.');
        return;
      }
      attempt = last.number;
    }
    await printLog(client, id, jobId, attempt, !!opts.follow, opts.pollMs ?? 2000);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy ci approve|cancel <service> <job>` */
export async function ciDecide(client: NineDeployClient, decision: 'approve' | 'cancel', ref: string, rawJob: string): Promise<void> {
  const jobId = positive(rawJob, 'The job id');
  if (jobId === null) return;
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    if (decision === 'approve') {
      await spinner('Approving', () => client.ci.jobs.approve(id, jobId));
      success(`Job #${jobId} approved: a runner can take it now.`);
    } else {
      await spinner('Cancelling', () => client.ci.jobs.cancel(id, jobId));
      success(`Job #${jobId} cancelled.`);
    }
  } catch (err) {
    error(message(err));
  }
}
