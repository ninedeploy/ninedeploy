import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { buildEnv, ExecTimeoutError, killTree } from './exec.js';
import { trackDeployChild } from './deployAbort.js';

/** Bounded file-to-stdin streaming without retaining dump bytes or child output. */
export async function streamFileToCommand(cmd: string, args: string[], file: string, timeoutMs: number): Promise<void> {
  const child = spawn(cmd, args, { env: buildEnv(), detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  trackDeployChild(child, killTree);
  let spawnError: Error | undefined;
  let inputError: unknown;
  let timedOut = false;
  child.on('error', error => { spawnError = error; });
  const closed = new Promise<number | null>(resolve => { child.once('close', code => resolve(code)); });
  const timer = setTimeout(() => { timedOut = true; killTree(child, 'SIGKILL'); }, timeoutMs);
  try {
    try { await pipeline(createReadStream(file), child.stdin!); }
    catch (error) { inputError = error; killTree(child, 'SIGKILL'); }
    const code = await closed;
    if (timedOut) throw new ExecTimeoutError(cmd, timeoutMs);
    if (spawnError || inputError || code !== 0) throw new Error('File input command did not complete');
  } finally { clearTimeout(timer); }
}
