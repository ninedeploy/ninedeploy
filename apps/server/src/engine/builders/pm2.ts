import { readFileSync } from 'node:fs';
import type { ProcessDescription } from 'pm2';
import pm2 from 'pm2';
import type { Builder } from '../types.js';
import { buildEnv, run, sleep } from '../../lib/exec.js';

const DEPLOY_HEARTBEAT_MS = 20_000;

const connect = () => new Promise<void>((res, rej) => pm2.connect((err) => (err ? rej(err) : res())));

// The pm2 package owns one process-global RPC connection. Parallel callers
// cannot independently connect/disconnect it: one caller's disconnect closes
// another caller's in-flight request. Serialize complete sessions instead.
let pm2SessionTail: Promise<void> = Promise.resolve();

/** Run `fn` against the PM2 daemon in an exclusive connection session. */
const withPm2 = async <T>(fn: () => Promise<T>): Promise<T> => {
  const session = pm2SessionTail.then(async () => {
    await connect();
    try {
      return await fn();
    } finally {
      pm2.disconnect();
    }
  });
  pm2SessionTail = session.then(() => undefined, () => undefined);
  return session;
};

/**
 * Persist the PM2 process list to <PM2_HOME>/dump.pm2. Must run INSIDE a
 * withPm2 session. The PM2 daemon dies with every reboot (and every panel
 * restart), taking bare-metal deployments with it; the ninedeploy-pm2 systemd
 * unit resurrects this dump at boot, so it must reflect every lifecycle
 * change. Best-effort: a dump failure must not fail the lifecycle operation.
 */
const dumpProcessList = async (): Promise<void> => {
  try {
    await new Promise<void>((res) => pm2.dump(() => res()));
  } catch {
    /* best-effort: never fail the lifecycle operation over a dump */
  }
};

/**
 * Split a start command into a PM2 script + args. PM2's `script` option is a
 * binary/file path, not a shell command — so `node dist/index.js` must become
 * `script: 'node', args: 'dist/index.js'`, and `npm start` must become
 * `script: 'npm', args: 'start'`. Without this, PM2 treats the whole string as
 * a (non-existent) script path.
 */
function parseStartCommand(cmd: string): { script: string; args: string } {
  const parts = cmd.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { script: 'npm', args: 'start' };
  return { script: parts[0]!, args: parts.slice(1).join(' ') };
}

/** PM2 builder: install + build, then run/stop the app via the PM2 daemon. */
export const pm2Builder: Builder = {
  async buildAndRun(ctx, previous) {
    const { service, buildConfig, workDir, deploymentId, env, log } = ctx;

    // Build steps run WITH the service env so they can see DB connection
    // strings and other config the app needs at build time.
    if (buildConfig?.installCmd) {
      log('Installing dependencies …');
      await run(
        'sh',
        ['-c', buildConfig.installCmd],
        { cwd: workDir, env, heartbeatMs: DEPLOY_HEARTBEAT_MS, heartbeatLabel: 'Installing application dependencies' },
        log,
      );
    }
    if (buildConfig?.buildCmd) {
      log('Building …');
      await run(
        'sh',
        ['-c', buildConfig.buildCmd],
        { cwd: workDir, env, heartbeatMs: DEPLOY_HEARTBEAT_MS, heartbeatLabel: 'Building application' },
        log,
      );
    }
    // PM2 binds the service port, so two versions cannot coexist — the previous
    // process must stop before the new one starts. True zero-downtime is only
    // achievable by the Docker builder (blue-green); PM2 accepts a brief gap,
    // and the pipeline cleans up a failed new process on error.
    if (previous) {
      log(`Stopping previous process ${previous.runtimeId} …`);
      await this.stop(previous.runtimeId);
    }

    const name = `${service.slug}-${deploymentId}`;
    const { script, args } = parseStartCommand(buildConfig?.startCmd ?? '');
    log(`Starting PM2 process ${name} …`);

    const effectivePort = service.publishedPort ?? service.port;
    if (effectivePort && env.PORT === undefined) {
      env.PORT = String(effectivePort);
    }

    // interpreter: 'none' makes PM2 exec the script directly so `npm`/`node`
    // are run as binaries instead of being re-interpreted through node.
    const startOpts: Record<string, unknown> = {
      name,
      script,
      args,
      interpreter: 'none',
      cwd: workDir,
      autorestart: true,
      max_restarts: 10,
      // r233: PM2 merges the DAEMON's environment into every app — and the
      // daemon inherits the panel's, master key and JWT secret included. The
      // app gets the same allowlisted base every other build/runtime child
      // gets (PATH, HOME, locale…) plus its own variables, and nothing else.
      env: buildEnv(env),
      filter_env: true,
    };
    // Enforce a memory ceiling via PM2's auto-restart-on-OOM, mirroring the
    // Docker builder's --memory limit.
    if (service.memLimitMb > 0) startOpts.max_memory_restart = `${service.memLimitMb}M`;

    await withPm2(async () => {
      await new Promise<void>((res, rej) =>
        pm2.start(startOpts, (err) => (err ? rej(err) : res())),
      );
      await dumpProcessList();
    });
    return { runtimeId: name, port: service.port ?? null, healthPath: service.healthPath ?? '/' };
  },

  async isHealthy(runtime, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const online = await withPm2(async () => {
        const procs = await new Promise<ProcessDescription[]>((res, rej) =>
          pm2.describe(runtime.runtimeId, (err, desc) => (err ? rej(err) : res(desc ?? []))),
        );
        return procs.some((proc) => proc?.pm2_env?.status === 'online');
      }).catch(() => false);
      if (online) return true;
      await sleep(1000);
    }
    return false;
  },

  async stop(runtimeId) {
    await withPm2(async () => {
      await new Promise<void>((res) => pm2.delete(runtimeId, () => res()));
      await dumpProcessList();
    }).catch(() => undefined);
  },
};

/**
 * Stop a PM2 process (keeps it registered; status → stopped). Unlike the
 * deploy-engine teardown above (`stop` deletes the process), lifecycle stop
 * preserves the process so `start` can resume it without a full redeploy.
 */
export async function pm2Stop(runtimeId: string): Promise<void> {
  await withPm2(async () => {
    await new Promise<void>((res, rej) => pm2.stop(runtimeId, (err) => (err ? rej(err) : res())));
    await dumpProcessList();
  });
}

/** Start (resume) an existing PM2 process. Rejects when it was deleted. */
export async function pm2Start(runtimeId: string): Promise<void> {
  await withPm2(async () => {
    await new Promise<void>((res, rej) => pm2.restart(runtimeId, (err) => (err ? rej(err) : res())));
    await dumpProcessList();
  });
}

/** Restart a PM2 process. */
export async function pm2Restart(runtimeId: string): Promise<void> {
  await withPm2(async () => {
    await new Promise<void>((res, rej) => pm2.restart(runtimeId, (err) => (err ? rej(err) : res())));
    await dumpProcessList();
  });
}

/**
 * Live process state for reconciliation: 'online', present-but-not-running
 * ('stopped'), or absent from the daemon ('gone' — also returned when the
 * daemon cannot be reached, in which case nothing is running by definition).
 */
export async function pm2Status(runtimeId: string): Promise<'online' | 'stopped' | 'gone'> {
  try {
    return await withPm2(async () => {
      const procs = await new Promise<ProcessDescription[]>((res, rej) =>
        pm2.describe(runtimeId, (err, desc) => (err ? rej(err) : res(desc ?? []))),
      );
      const proc = procs.find((p) => p?.name === runtimeId);
      if (!proc) return 'gone';
      return proc.pm2_env?.status === 'online' ? 'online' : 'stopped';
    });
  } catch {
    return 'gone';
  }
}

/**
 * Best-effort `pm2 resurrect`: restore the dumped process list after the
 * daemon died (reboot, crash). Processes that were stopped when the dump was
 * written are restored as stopped, so this is safe during reconciliation of
 * services whose desired state is running. Declared typings miss resurrect,
 * but the runtime API exposes it.
 */
export async function pm2Resurrect(): Promise<void> {
  await withPm2(
    () =>
      new Promise<void>((res) =>
        (pm2 as unknown as { resurrect: (cb: () => void) => void }).resurrect(() => res()),
      ),
  ).catch(() => undefined);
}

/** Tail the last 300 lines of a process's combined stdout+stderr log files. */
export async function pm2Logs(runtimeId: string): Promise<string> {
  return withPm2(async () => {
    const procs = await new Promise<ProcessDescription[]>((res, rej) =>
      pm2.describe(runtimeId, (err, desc) => (err ? rej(err) : res(desc ?? []))),
    );
    const proc = procs.find((p) => p?.name === runtimeId);
    const tail = (file: string | undefined): string => {
      if (!file) return '';
      try {
        const lines = readFileSync(file, 'utf8').split('\n');
        // A trailing newline yields a final empty element — drop it so joined
        // out+err logs don't end in a stray blank line.
        if (lines[lines.length - 1] === '') lines.pop();
        return lines.slice(-300).join('\n');
      } catch {
        return '';
      }
    };
    return [tail(proc?.pm2_env?.pm_out_log_path), tail(proc?.pm2_env?.pm_err_log_path)].filter(Boolean).join('\n');
  });
}
