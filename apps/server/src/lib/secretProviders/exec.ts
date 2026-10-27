import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { EXEC_NAME_PLACEHOLDER, execProviderConfig } from '@ninedeploy/schemas';
import type { NamedCallOptions, NamedSecretDriver } from './named.js';
import { SecretProviderError } from './vault.js';

/**
 * G3.2: the exec provider, `${{exec:<name>}}` — any secret manager with a
 * command-line client (Bitwarden, Doppler, `op`, `pass`, sops, a script),
 * after Uncloud's exec provider and Kamal's vendor-CLI adapters.
 *
 * The operator stores an argv; at deploy it runs on the panel host WITHOUT a
 * shell, with `{name}` in any argument replaced by the reference name and the
 * name also in NINEDEPLOY_SECRET_NAME. Its stdout (one trailing newline
 * dropped) is the value. A non-zero exit, a timeout or more than 64 KiB of
 * output fails the deploy.
 *
 * It runs a program as the panel, so it is off unless the panel was started
 * with NINEDEPLOY_SECRET_EXEC=1: without it the provider can be neither saved
 * nor used. Reference names never start with `-` and never contain a `..`
 * segment, but the command still decides what a name may reach (put `--`
 * before `{name}` where the client supports it) — the r510 allowlist decides
 * which services may resolve references at all.
 */

type ExecConfig = { command: string[]; timeoutSeconds: number };

export const EXEC_OPT_IN_ENV = 'NINEDEPLOY_SECRET_EXEC';
const MAX_OUTPUT = 64 * 1024;
const STDERR_LIMIT = 200;

export const execEnabled = (): boolean => process.env[EXEC_OPT_IN_ENV] === '1';

function checkEnabled(): void {
  if (!execEnabled()) {
    throw new SecretProviderError(`The exec secret provider is off: start the panel with ${EXEC_OPT_IN_ENV}=1 to allow it`);
  }
}

async function runCommand(config: ExecConfig, name: string, opts: NamedCallOptions): Promise<string> {
  checkEnabled();
  // A name never starts with `-` (as its own argument it would read as an
  // option, e.g. `--output=/x`) and never has a `..` segment.
  if (!/^[A-Za-z0-9_./:@][A-Za-z0-9_./:@-]{0,255}$/.test(name) || name.split('/').some((s) => s === '..')) {
    throw new SecretProviderError('Invalid exec reference name');
  }
  const [file, ...rest] = config.command;
  const args = rest.map((a) => a.split(EXEC_NAME_PLACEHOLDER).join(name));
  return new Promise((resolve, reject) => {
    execFile(
      file!,
      args,
      {
        shell: false,
        timeout: config.timeoutSeconds * 1000,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_OUTPUT,
        windowsHide: true,
        encoding: 'utf8',
        // Not the panel's environment: the master key and tokens stay out.
        env: { PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin', HOME: homedir(), NINEDEPLOY_SECRET_NAME: name },
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
          let why: string;
          if (e.code === 'ENOENT') why = `${file} was not found`;
          else if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') why = `it printed more than ${MAX_OUTPUT / 1024} KiB`;
          else if (e.killed) why = `it ran longer than ${config.timeoutSeconds} s`;
          else why = `it exited with ${String(e.code ?? 'an error')}${stderr.trim() ? `: ${stderr.trim().slice(0, STDERR_LIMIT)}` : ''}`;
          reject(new SecretProviderError(`The exec command failed: ${why}`));
          return;
        }
        resolve(stdout.endsWith('\r\n') ? stdout.slice(0, -2) : stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout);
      },
    );
  });
}

export const execDriver: NamedSecretDriver<ExecConfig> = {
  kind: 'exec',
  label: 'exec command',
  credentialFields: [],
  requiredCredentials: [],
  parseConfig: (raw) => {
    const parsed = execProviderConfig.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  validate: () => checkEnabled(),
  target: () => 'local',
  read: (config, _creds, name, opts) => runCommand(config, name, opts),
  async test(config, _creds, opts) {
    checkEnabled();
    if (!opts.probeName) return `The exec provider is on; ${config.command[0]} runs for each reference (give a probe name to try one)`;
    const value = await runCommand(config, opts.probeName, opts);
    return `The command answered for the probe name (${Buffer.byteLength(value)} bytes)`;
  },
  clearCache: () => undefined,
};
