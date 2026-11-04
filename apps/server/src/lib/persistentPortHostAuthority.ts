import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export interface PersistentPortHostContext {
  /** Mutators inherit the locked open-file description as descriptor 3. If
   * this worker dies, a still-running mutator continues to fence successors. */
  run(program: string, args: readonly string[], options?: { input?: string; timeoutMs?: number }): string;
}

/** Linux host-namespace worker primitive. All policy writers must share this
 * private state directory and run every kernel mutation through context.run.
 * There is no stale-heartbeat takeover or process-local fallback. */
export async function withPersistentPortHostAuthority<T>(
  directory: string,
  operation: (context: PersistentPortHostContext) => Promise<T>,
  acquireTimeoutSeconds = 10,
): Promise<T> {
  if (process.platform !== 'linux') throw new Error('Persistent port host authority requires Linux');
  if (!isAbsolute(directory) || !Number.isInteger(acquireTimeoutSeconds) || acquireTimeoutSeconds < 1 || acquireTimeoutSeconds > 60) {
    throw new Error('Invalid persistent port authority directory or timeout');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = statSync(directory);
  if (realpathSync(directory) !== resolve(directory) || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) {
    throw new Error('Persistent port authority directory is not private and owned');
  }
  const fd = openSync(join(directory, 'authority.lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let active = true;
  try {
    const lock = fstatSync(fd);
    if (!lock.isFile() || lock.nlink !== 1 || lock.uid !== process.getuid?.() || (lock.mode & 0o077) !== 0) throw new Error('Unsafe persistent port authority lock');
    const acquired = spawnSync('flock', ['--exclusive', '--timeout', String(acquireTimeoutSeconds), '3'], {
      stdio: ['ignore', 'pipe', 'pipe', fd], timeout: (acquireTimeoutSeconds + 1) * 1000, windowsHide: true,
    });
    if (acquired.error || acquired.signal || acquired.status !== 0) throw new Error('Persistent port host authority is unavailable');
    const context: PersistentPortHostContext = {
      run: (program, args, options = {}) => {
        if (!active) throw new Error('Persistent port host authority has ended');
        const timeout = options.timeoutMs ?? 30_000;
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120_000) throw new Error('Invalid persistent port command deadline');
        const result = spawnSync(program, [...args], {
          input: options.input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe', fd],
          timeout, maxBuffer: 8 << 20, windowsHide: true,
        });
        // Do not attach raw command arguments, environment, stdout or stderr:
        // container commands can contain operator-provided secrets.
        if (result.error || result.signal || result.status !== 0) throw new Error('Persistent port host command did not complete successfully');
        return result.stdout;
      },
    };
    return await operation(context);
  } finally {
    active = false;
    // Do not issue LOCK_UN here: that would also unlock a surviving child's
    // inherited descriptor. Closing releases only this worker's reference.
    closeSync(fd);
  }
}
