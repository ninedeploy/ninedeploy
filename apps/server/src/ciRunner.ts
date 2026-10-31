/**
 * R5: the NineDeploy CI runner. It pulls jobs from a panel and runs each in
 * a throwaway container on this machine's Docker.
 *
 *   NINEDEPLOY_RUNNER_URL=https://panel.example.com \
 *   NINEDEPLOY_RUNNER_TOKEN=ndrun_… \
 *   node apps/server/dist/ciRunner.js
 *
 * The job container gets the checked-out source at /workspace, the variables
 * the pipeline names, and nothing of the runner: no Docker socket, no runner
 * token, no lease token. Each container carries this runner's label, so
 * leftovers of a crashed runner are removed when it starts again.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CI_RESERVED_ENV, type CiClaimResponse } from '@ninedeploy/schemas';

export interface RunnerOptions {
  url: string;
  token: string;
  capacity: number;
  pollMs: number;
  memory: string;
  cpus: string;
  pidsLimit: number;
  docker: string;
  /** Arguments put before every Docker call (a test runs a stand-in through node). */
  dockerPrefix?: string[];
  /** Where job workspaces live. In a container, mount it at the same path on the host: the job's bind mounts are resolved by the host's Docker. */
  workDir: string;
  /**
   * `isolated` (the default): each job gets a bridge network of its own, so it
   * cannot reach other containers on this machine, nor another job. `none`:
   * no network at all.
   */
  network?: 'isolated' | 'none';
  version: string;
  log: (line: string) => void;
}

/** The per-job network of an attempt (`network: isolated`). */
export const jobNetwork = (attemptId: number): string => `nd-ci-net-${attemptId}`;

const LOG_FLUSH_MS = 1000;
const LOG_CHUNK_BYTES = 64 * 1024;

export function runnerLabel(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** The job's variables without any name that would change the docker client rather than the job. */
export function jobEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !CI_RESERVED_ENV.test(k)));
}

/** The `docker run` arguments of one job. Pure, so the isolation it promises can be tested. */
export function jobRunArgs(opts: RunnerOptions, claim: CiClaimResponse, dirs: { source: string; script: string }): string[] {
  return [
    'run',
    '--rm',
    '--name',
    `nd-ci-${claim.attemptId}`,
    '--label',
    `ninedeploy.ci-runner=${runnerLabel(opts.token)}`,
    '--label',
    `ninedeploy.ci-attempt=${claim.attemptId}`,
    '--security-opt',
    'no-new-privileges',
    '--network',
    opts.network === 'none' ? 'none' : jobNetwork(claim.attemptId),
    '--pids-limit',
    String(opts.pidsLimit),
    '--memory',
    opts.memory,
    '--cpus',
    opts.cpus,
    '--workdir',
    '/workspace',
    '-v',
    `${dirs.source}:/workspace`,
    '-v',
    `${dirs.script}:/nd-ci/script.sh:ro`,
    // Values travel in the docker client's environment, never on its command line.
    ...Object.keys(jobEnv(claim.env)).flatMap((k) => ['-e', k]),
    '-e',
    'CI=true',
    '-e',
    `NINEDEPLOY_CI_JOB=${claim.jobId}`,
    '-e',
    `NINEDEPLOY_CI_ATTEMPT=${claim.number}`,
    ...(claim.commitSha ? ['-e', `NINEDEPLOY_CI_COMMIT=${claim.commitSha}`] : []),
    '--entrypoint',
    '/bin/sh',
    claim.image,
    '-e',
    '/nd-ci/script.sh',
  ];
}

class Panel {
  constructor(private readonly opts: RunnerOptions) {}

  async call(method: string, pathname: string, init: { body?: unknown; lease?: string } = {}): Promise<Response> {
    return fetch(`${this.opts.url}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        ...(init.lease ? { 'x-nd-lease': init.lease } : {}),
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  }
}

function docker(opts: RunnerOptions, args: string[], env?: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(opts.docker, [...(opts.dockerPrefix ?? []), ...args], { stdio: 'ignore', env: env ?? process.env });
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
}

function dockerOutput(opts: RunnerOptions, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(opts.docker, [...(opts.dockerPrefix ?? []), ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
  });
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Containers (and their job networks) this runner left behind when it last stopped (crash, kill, reboot). */
export async function removeOrphans(opts: RunnerOptions): Promise<number> {
  const filter = `label=ninedeploy.ci-runner=${runnerLabel(opts.token)}`;
  const ids = lines(await dockerOutput(opts, ['ps', '-aq', '--filter', filter]));
  for (const id of ids) await docker(opts, ['rm', '-f', id]);
  for (const net of lines(await dockerOutput(opts, ['network', 'ls', '-q', '--filter', filter]))) await docker(opts, ['network', 'rm', net]);
  // A runner whose token changed no longer matches the label of what it left
  // behind. Job networks are created just before their container runs, so one
  // that is empty and older than ten minutes is left over, whoever made it.
  for (const net of lines(await dockerOutput(opts, ['network', 'ls', '-q', '--filter', 'label=ninedeploy.ci-runner']))) {
    const [created, attached] = (await dockerOutput(opts, ['network', 'inspect', '-f', '{{.Created}}|{{len .Containers}}', net])).trim().split('|');
    const age = Date.now() - Date.parse(created ?? '');
    if (attached === '0' && age > 10 * 60_000) await docker(opts, ['network', 'rm', net]);
  }
  return ids.length;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One attempt, from source download to the reported result. */
async function runAttempt(opts: RunnerOptions, panel: Panel, claim: CiClaimResponse, stopping: () => boolean): Promise<void> {
  const lease = claim.leaseToken;
  const base = `/v1/ci/runner/attempts/${claim.attemptId}`;
  mkdirSync(opts.workDir, { recursive: true });
  const root = mkdtempSync(path.join(opts.workDir, `nd-ci-${claim.attemptId}-`));
  const source = path.join(root, 'src');
  const script = path.join(root, 'script.sh');
  mkdirSync(source, { recursive: true });
  writeFileSync(script, `${claim.script}\n`, { mode: 0o644 });

  // Log shipping: ordered chunks, each retried until the panel has it.
  let seq = 0;
  let pending = '';
  let shipping: Promise<void> = Promise.resolve();
  let superseded = false;
  const ship = (data: string) => {
    const n = ++seq;
    shipping = shipping.then(async () => {
      // About five minutes: a panel restart or a short outage loses no lines.
      for (let tries = 0; tries < 150 && !superseded; tries++) {
        try {
          const res = await panel.call('POST', `${base}/log`, { lease, body: { seq: n, data } });
          if (res.ok) return;
          if (res.status === 409 || res.status === 401) {
            superseded = res.status === 401 || superseded;
            return;
          }
        } catch {
          /* the panel is unreachable: retry */
        }
        await sleep(2000);
      }
    });
  };
  const write = (text: string) => {
    pending += text;
    if (Buffer.byteLength(pending) >= LOG_CHUNK_BYTES) {
      ship(pending);
      pending = '';
    }
  };
  const flushTimer = setInterval(() => {
    if (pending) {
      ship(pending);
      pending = '';
    }
  }, LOG_FLUSH_MS);

  // Heartbeat: a "stop" (cancelled, superseded) or a lost lease kills the container.
  let stopReason: string | null = null;
  const kill = (reason: string) => {
    if (stopReason) return;
    stopReason = reason;
    void docker(opts, ['kill', `nd-ci-${claim.attemptId}`]);
  };
  const beat = setInterval(async () => {
    try {
      const res = await panel.call('POST', `${base}/heartbeat`, { lease });
      if (res.status === 401 || res.status === 404) return kill('the panel no longer knows this attempt');
      const body = (await res.json().catch(() => ({}))) as { action?: string; reason?: string };
      if (body.action === 'stop') kill(body.reason === 'cancelled' ? 'cancelled' : 'this attempt no longer counts');
    } catch {
      /* unreachable panel: keep running until it answers or the job ends */
    }
    if (stopping()) kill('the runner is shutting down');
  }, claim.heartbeatSeconds * 1000);

  let exitCode: number | null = null;
  let error: string | undefined;
  try {
    if (claim.sourcePath) {
      write(`▸ Fetching the source${claim.commitSha ? ` at ${claim.commitSha.slice(0, 12)}` : ''}\n`);
      const res = await panel.call('GET', claim.sourcePath, { lease });
      if (!res.ok || !res.body) throw new Error(`the panel could not provide the source (${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`);
      const archive = path.join(root, 'source.tar.gz');
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(archive));
      if ((await docker(opts, ['--version'])) < 0) throw new Error(`${opts.docker} is not available`);
      const untar = await new Promise<number>((resolve) => {
        const child = spawn('tar', ['-xzf', archive, '-C', source], { stdio: 'ignore' });
        child.on('error', () => resolve(-1));
        child.on('close', (code) => resolve(code ?? -1));
      });
      if (untar !== 0) throw new Error('could not unpack the source archive');
      // The panel pins the commit on the first checkout; the job sees it as NINEDEPLOY_CI_COMMIT.
      const commit = res.headers.get('x-nd-commit');
      if (commit && /^[0-9a-f]{40}$/i.test(commit)) claim.commitSha = commit;
      write(`▸ Source at ${commit?.slice(0, 12) ?? 'the uploaded archive'}\n`);
    }
    if (opts.network !== 'none') {
      const net = jobNetwork(claim.attemptId);
      const made = await docker(opts, ['network', 'create', '--driver', 'bridge', '--label', `ninedeploy.ci-runner=${runnerLabel(opts.token)}`, net]);
      if (made !== 0) throw new Error(`could not create the job network ${net}`);
    }
    write(`▸ Running in ${claim.image} (attempt ${claim.number})\n`);
    // The docker client runs with the job's variables in its environment (values stay off the command line).
    // Names that would steer the client itself are dropped (the panel refuses them too), and the runner's
    // own settings are written last so nothing can replace them.
    const env: NodeJS.ProcessEnv = { ...jobEnv(claim.env), PATH: process.env['PATH'], HOME: process.env['HOME'], DOCKER_HOST: process.env['DOCKER_HOST'] };
    if (process.platform === 'win32') Object.assign(env, { SystemRoot: process.env['SystemRoot'], USERPROFILE: process.env['USERPROFILE'] });
    const child = spawn(opts.docker, [...(opts.dockerPrefix ?? []), ...jobRunArgs(opts, claim, { source, script })], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => write(d.toString()));
    child.stderr.on('data', (d: Buffer) => write(d.toString()));
    const timeout = setTimeout(() => kill(`timed out after ${claim.timeoutSeconds} s`), claim.timeoutSeconds * 1000);
    exitCode = await new Promise<number | null>((resolve) => {
      child.on('error', (err) => {
        error = err.message;
        resolve(null);
      });
      child.on('close', (code) => resolve(code));
    });
    clearTimeout(timeout);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    write(`✗ ${error}\n`);
  } finally {
    clearInterval(beat);
    clearInterval(flushTimer);
  }
  if (stopReason) error = `Stopped: ${stopReason}`;
  write(stopReason ? `✗ ${error}\n` : exitCode === 0 ? '✓ Succeeded\n' : `✗ Exited with ${exitCode ?? 'no code'}\n`);
  if (pending) ship(pending);
  await shipping;
  await docker(opts, ['rm', '-f', `nd-ci-${claim.attemptId}`]);
  if (opts.network !== 'none') await docker(opts, ['network', 'rm', jobNetwork(claim.attemptId)]);
  rmSync(root, { recursive: true, force: true });

  // A cancelled or superseded attempt reports nothing: its result does not count.
  // A runner shutting down leaves the attempt to lapse, so the job is retried elsewhere.
  const stopped = stopReason as string | null;
  if (stopped && !stopped.startsWith('timed out')) return;
  const result = { status: exitCode === 0 && !error ? 'succeeded' : 'failed', exitCode, ...(error ? { error } : {}) };
  for (let tries = 0; tries < 20; tries++) {
    try {
      const res = await panel.call('POST', `${base}/finish`, { lease, body: result });
      if (res.ok || res.status === 409 || res.status === 401) {
        opts.log(`attempt ${claim.attemptId} (job ${claim.jobId}) ${res.ok ? result.status : 'no longer counts'}`);
        return;
      }
    } catch {
      /* retry */
    }
    await sleep(3000);
  }
  opts.log(`attempt ${claim.attemptId}: could not report the result; the panel will treat it as lost`);
}

/** The claim loop. Resolves when `signal` aborts and every running attempt has ended. */
export async function runRunner(opts: RunnerOptions, signal: AbortSignal): Promise<void> {
  const panel = new Panel(opts);
  const orphans = await removeOrphans(opts);
  if (orphans > 0) opts.log(`removed ${orphans} container(s) left by an earlier run`);
  const active = new Set<Promise<void>>();
  let warned = false;
  while (!signal.aborted) {
    if (active.size < opts.capacity) {
      try {
        const res = await panel.call('POST', '/v1/ci/runner/claim', { body: { running: active.size, version: opts.version } });
        if (res.status === 401) throw new Error('the panel refused this runner token (unknown or revoked)');
        if (res.status === 200) {
          const claim = (await res.json()) as CiClaimResponse;
          opts.log(`attempt ${claim.attemptId}: job ${claim.jobId} (try ${claim.number}) in ${claim.image}`);
          const run = runAttempt(opts, panel, claim, () => signal.aborted).catch((err: unknown) => opts.log(`attempt ${claim.attemptId} failed in the runner: ${String(err)}`));
          active.add(run);
          void run.finally(() => active.delete(run));
          warned = false;
          continue;
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('the panel refused')) throw err;
        if (!warned) opts.log(`cannot reach ${opts.url}: ${err instanceof Error ? err.message : String(err)}`);
        warned = true;
      }
    }
    await sleep(opts.pollMs);
  }
  await Promise.all(active);
}

function fromEnv(): RunnerOptions {
  const url = (process.env['NINEDEPLOY_RUNNER_URL'] ?? '').replace(/\/+$/, '');
  const token = process.env['NINEDEPLOY_RUNNER_TOKEN'] ?? '';
  if (!/^https?:\/\//.test(url) || !token.startsWith('ndrun_')) {
    throw new Error('Set NINEDEPLOY_RUNNER_URL (the panel address) and NINEDEPLOY_RUNNER_TOKEN (ndrun_…, from Settings → CI runners)');
  }
  return {
    url,
    token,
    capacity: Math.max(1, Number(process.env['NINEDEPLOY_RUNNER_CAPACITY'] ?? 1) || 1),
    pollMs: 3000,
    memory: process.env['NINEDEPLOY_RUNNER_MEMORY'] ?? '2g',
    cpus: process.env['NINEDEPLOY_RUNNER_CPUS'] ?? '2',
    pidsLimit: Number(process.env['NINEDEPLOY_RUNNER_PIDS'] ?? 1024) || 1024,
    docker: process.env['NINEDEPLOY_RUNNER_DOCKER'] ?? 'docker',
    workDir: process.env['NINEDEPLOY_RUNNER_WORKDIR'] ?? os.tmpdir(),
    network: process.env['NINEDEPLOY_RUNNER_NETWORK'] === 'none' ? 'none' : 'isolated',
    version: process.env['npm_package_version'] ?? 'dev',
    log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
  };
}

const isMain = process.argv[1] && /ciRunner\.[cm]?[jt]s$/.test(process.argv[1]);
if (isMain) {
  const opts = fromEnv();
  // Never hand the runner token to a job: drop it from this process's environment.
  delete process.env['NINEDEPLOY_RUNNER_TOKEN'];
  const controller = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => controller.abort());
  opts.log(`runner for ${opts.url}, capacity ${opts.capacity}`);
  runRunner(opts, controller.signal).then(
    () => process.exit(0),
    (err: unknown) => {
      opts.log(String(err instanceof Error ? err.message : err));
      process.exit(1);
    },
  );
}
