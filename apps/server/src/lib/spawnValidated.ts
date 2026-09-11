import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { armTimeout, makeLineSplitter } from './exec.js';

/**
 * Default cap for an op's child. The master's request to this agent dies at
 * 600s (lib/agentClient AbortSignal.timeout) — without a child-side timeout a
 * stalled op keeps running orphaned, and an orphaned `git fetch` still holds
 * the workspace's .git locks so the NEXT op fails on "cannot lock ref".
 * 595s sits just under that request window.
 */
const OP_TIMEOUT_MS = 595_000;
/** Exit code reported when the child is killed by the timeout (GNU timeout convention). */
const TIMEOUT_EXIT = 124;

/**
 * Single choke-point for spawning the two agent executables. The argv arrays
 * passed here are produced exclusively by the typed operation table in
 * agent.ts (literal flags + regex-validated operands); this module exists so
 * there is exactly ONE spawn site to audit.
 */

export type AllowedExecutable = 'docker' | 'git';

export interface SpawnValidatedOptions {
  /**
   * Working directory for the child. MUST already be resolved and confined by
   * the caller (`agent.ts` derives it from `resolveWorkspace()`, which refuses
   * anything outside the agent's workspace root). It exists because git has no
   * per-invocation repo operand: `git fetch` / `checkout` / `reset` act on the
   * process's cwd, so without this the agent could only ever hold ONE
   * repository — every remote service would fight over the same checkout.
   */
  cwd?: string;
  /** Written to the child's stdin, then closed. Used by `docker login`. */
  stdin?: string;
  /** Hard-kill the child (tree) after this many ms. Default {@link OP_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Spawn one of the two fixed executables and collect its output lines. */
export function spawnValidated(
  executable: AllowedExecutable,
  argv: string[],
  onLine: (line: string) => void,
  opts: SpawnValidatedOptions = {},
): Promise<number> {
  // detached (POSIX) makes the child a process-group leader so the timeout
  // can kill the whole tree — a `git fetch`'s remote helpers must die with
  // it. Skipped on Windows: detached spawns a visible console there, and the
  // libuv job object already tears descendants down with the child.
  const spawnOpts: SpawnOptions = { detached: process.platform !== 'win32' };
  if (opts.cwd) spawnOpts.cwd = opts.cwd;
  const child: ChildProcess =
    executable === 'docker' ? spawn('docker', argv, spawnOpts) : spawn('git', argv, spawnOpts);
  if (opts.stdin !== undefined) {
    child.stdin?.end(opts.stdin);
  }
  return new Promise<number>((resolve) => {
    let finished = false;
    const finish = (code: number) => {
      if (!finished) {
        finished = true;
        resolve(code);
      }
    };
    child.stdin?.on('error', () => { /* child gone */ });
    const cancelTimeout = armTimeout(child, opts.timeoutMs ?? OP_TIMEOUT_MS, () => {
      onLine(`Operation timed out after ${opts.timeoutMs ?? OP_TIMEOUT_MS}ms — killed`);
      finish(TIMEOUT_EXIT);
    });
    const outSplitter = makeLineSplitter();
    const errSplitter = makeLineSplitter();
    child.stdout?.on('data', (d: Buffer) => {
      for (const l of outSplitter.feed(d)) onLine(l);
    });
    child.stderr?.on('data', (d: Buffer) => {
      for (const l of errSplitter.feed(d)) onLine(l);
    });
    child.on('error', () => { cancelTimeout(); finish(127); });
    child.on('close', (code) => {
      cancelTimeout();
      for (const tail of [outSplitter.flush(), errSplitter.flush()]) {
        if (tail) onLine(tail);
      }
      // `code` is null when the child died to a SIGNAL (supervisor stop, OOM
      // kill, external terminate) — an abnormal termination. Reporting 0 told
      // the agent's callers the op had succeeded while exec.ts's run() and
      // capture() treat the same condition as failure (r035). Numeric exit
      // codes pass through untouched.
      finish(code ?? 1);
    });
  });
}
