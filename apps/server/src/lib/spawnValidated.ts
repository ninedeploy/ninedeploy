import { spawn, type ChildProcess } from 'node:child_process';
import { makeLineSplitter } from './exec.js';

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
}

/** Spawn one of the two fixed executables and collect its output lines. */
export function spawnValidated(
  executable: AllowedExecutable,
  argv: string[],
  onLine: (line: string) => void,
  opts: SpawnValidatedOptions = {},
): Promise<number> {
  const spawnOpts = opts.cwd ? { cwd: opts.cwd } : {};
  const child: ChildProcess =
    executable === 'docker' ? spawn('docker', argv, spawnOpts) : spawn('git', argv, spawnOpts);
  if (opts.stdin !== undefined) {
    child.stdin?.end(opts.stdin);
  }
  return new Promise<number>((resolve) => {
    child.stdin?.on('error', () => { /* child gone */ });
    const outSplitter = makeLineSplitter();
    const errSplitter = makeLineSplitter();
    child.stdout?.on('data', (d: Buffer) => {
      for (const l of outSplitter.feed(d)) onLine(l);
    });
    child.stderr?.on('data', (d: Buffer) => {
      for (const l of errSplitter.feed(d)) onLine(l);
    });
    child.on('error', () => resolve(127));
    child.on('close', (code) => {
      for (const tail of [outSplitter.flush(), errSplitter.flush()]) {
        if (tail) onLine(tail);
      }
      // `code` is null when the child died to a SIGNAL (supervisor stop, OOM
      // kill, external terminate) — an abnormal termination. Reporting 0 told
      // the agent's callers the op had succeeded while exec.ts's run() and
      // capture() treat the same condition as failure (r035). Numeric exit
      // codes pass through untouched.
      resolve(code ?? 1);
    });
  });
}
