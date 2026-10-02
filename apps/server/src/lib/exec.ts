import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Hard kill the process (and its children) after this many ms. Default: 30 min. */
  timeoutMs?: number;
  /** Emit a progress heartbeat after this much output silence. Set to 0 to disable.
   *  In {@link capture} the heartbeat lines go here — capture has no log sink of
   *  its own, so without `onProgress` the heartbeat options are inert. */
  heartbeatMs?: number;
  /** Safe, user-facing heartbeat label. Command arguments are never logged implicitly. */
  heartbeatLabel?: string;
  /** Progress sink for {@link capture} heartbeats (and nothing else — captured
   *  stdout/stderr stay out of it and are returned/resolved as before). */
  onProgress?: (line: string) => void;
  /** r667: {@link capture} only — stdout bytes kept before the child is
   *  stopped and the call rejects. Default {@link DEFAULT_CAPTURE_MAX_BYTES}. */
  maxOutputBytes?: number;
}

/**
 * r667: memory ceilings for child output. `capture` used to buffer stdout and
 * stderr without limit and the line splitter kept a newline-less tail without
 * limit — a member's container printing one endless line made
 * `docker logs --tail 300` (lines, not bytes) hold all of it in the panel.
 * The caps sit far above every legitimate output the panel parses (inspect
 * JSON, listings, 300 log lines); stderr only ever feeds an error message, so
 * its newest characters are kept instead of failing.
 */
export const DEFAULT_CAPTURE_MAX_BYTES = 32 * 1024 * 1024;
const CAPTURE_STDERR_KEEP_CHARS = 64 * 1024;
/** A line longer than this is emitted in pieces of this size. */
export const MAX_LINE_CHARS = 1024 * 1024;

/** Thrown by {@link capture} when stdout passes its byte ceiling. */
export class ExecOutputTooLargeError extends Error {
  constructor(public readonly cmd: string, maxBytes: number) {
    super(`\`${cmd}\` produced more than ${maxBytes} bytes of output — stopped`);
    this.name = 'ExecOutputTooLargeError';
  }
}

/**
 * Environment variables that are safe to inherit from the host into a build or
 * runtime subprocess. Everything else (host secrets like the master key, JWT
 * secret, etc.) is deliberately excluded so it can never leak into a user-
 * controlled build shell or `docker inspect`.
 */
const SAFE_INHERITED_ENV = new Set([
  // OS / shell basics needed to locate and run binaries.
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR',
  // Windows equivalents: the Docker CLI locates its bundled compose plugin
  // under %ProgramFiles%\Docker\Docker\resources\cli-plugins (plus
  // %USERPROFILE%\.docker\cli-plugins), and children need SystemRoot.
  'USERPROFILE', 'APPDATA', 'ProgramFiles', 'ProgramData', 'SystemRoot',
  // Locale — some tools refuse to start without it.
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  // Build mode is safe and often expected by toolchains.
  'NODE_ENV',
  // Docker daemon connection — required to talk to the docker socket/daemon.
  'DOCKER_HOST', 'DOCKER_BUILDKIT', 'DOCKER_CONTEXT', 'COMPOSE_FILE',
  // Docker CLI config dir. Under the hardened systemd unit /root is READ-ONLY
  // (ProtectHome=read-only), and modern buildx writes builder-activity files
  // under $DOCKER_CONFIG/buildx/activity — without this inherited var, every
  // `docker build` dies with "read-only file system" the moment the default
  // builder touches its activity log. The unit points DOCKER_CONFIG at a
  // writable path under the data dir.
  'DOCKER_CONFIG',
  // r582: the BuildKit daemon the railpack build pack connects to (railpack
  // reads it itself and refuses to build without it). Operator-set only —
  // like the docker transport keys it is never taken from user env below.
  'BUILDKIT_HOST',
]);

/**
 * Build an isolated environment: only safe host vars + the caller-supplied env.
 *
 * r413: caller-supplied env can NEVER override the transport keys from
 * `SAFE_INHERITED_ENV` — user env rows flow in here as `extra` (nixpacks
 * builds, compose gates), and a member setting `DOCKER_HOST=tcp://attacker`
 * on their own docker service used to redirect every build/pull of that
 * pipeline to a daemon they control, handing over the build context and every
 * injected secret. Non-transport user keys pass through unchanged.
 */
const UNOVERRIDABLE_ENV = new Set(['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'COMPOSE_FILE', 'DOCKER_BUILDKIT', 'BUILDKIT_HOST']);
export function buildEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      // Always dropped from user env — the attack works precisely when the
      // host defines NO value of its own and the user's becomes effective.
      if (UNOVERRIDABLE_ENV.has(key)) continue;
      env[key] = value;
    }
  }
  return env;
}

/** Rejects when a subprocess exceeds its timeout. */
export class ExecTimeoutError extends Error {
  constructor(public readonly cmd: string, timeoutMs: number) {
    super(`\`${cmd}\` timed out after ${timeoutMs}ms`);
    this.name = 'ExecTimeoutError';
  }
}

/** Default per-command timeout: 30 minutes (builds can be slow). */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** A silent command should never make a deployment look frozen for longer than this. */
export const DEFAULT_HEARTBEAT_MS = 20 * 1000;

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(1, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${seconds}s`;
}

/** Report liveness only while a command is silent, keeping normal logs uncluttered. */
function armHeartbeat(
  sink: (line: string) => void,
  intervalMs: number,
  label: string,
  startedAt: number,
  getLastActivityAt: () => number,
): () => void {
  if (intervalMs <= 0) return () => {};
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - getLastActivityAt() < intervalMs) return;
    sink(`Still working: ${label} (${formatElapsed(now - startedAt)} elapsed) …`);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Send a signal to a process and all of its children. `spawn({ detached: true })`
 * makes the child a process-group leader, so `process.kill(-pid)` reaches the
 * whole tree (e.g. `sh -c` → `docker build`). Falls back to a plain kill if the
 * group signal fails (already dead, or unsupported platform).
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (typeof child.pid !== 'number') return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already dead */
    }
  }
}

/** Split a buffer stream into complete lines, buffering any trailing partial line.
 *  Shared by exec.ts and lib/spawnValidated.ts so the chunk-boundary rules
 *  (StringDecoder + pending buffer + `\r?\n`) live in exactly one place. */
export function makeLineSplitter() {
  // StringDecoder (not chunk.toString()): a multi-byte UTF-8 sequence split
  // across two data chunks must be decoded once it is complete, not into
  // U+FFFD replacement characters.
  const decoder = new StringDecoder('utf8');
  let pending = '';
  return {
    feed(chunk: Buffer): string[] {
      pending += decoder.write(chunk);
      const parts = pending.split(/\r?\n/);
      // split() always yields a non-empty array, so pop() is always a string.
      pending = parts.pop() as string;
      const lines = parts.filter((line) => line.length > 0);
      // r667: a newline that never comes must not grow the buffer forever —
      // an over-long line is passed on in MAX_LINE_CHARS pieces.
      while (pending.length > MAX_LINE_CHARS) {
        lines.push(pending.slice(0, MAX_LINE_CHARS));
        pending = pending.slice(MAX_LINE_CHARS);
      }
      return lines;
    },
    flush(): string {
      // Terminal bytes can no longer be completed by a later chunk; end()
      // decodes any remainder (a truncated sequence becomes U+FFFD).
      pending += decoder.end();
      const rest = pending;
      pending = '';
      return rest;
    },
  };
}

/**
 * Arm a hard timeout for a detached child. After `timeoutMs` it tree-kills with
 * SIGTERM, escalates to SIGKILL 5s later, and invokes `onTimeout` exactly once.
 * Returns a cancel function to clear both timers once the child settles.
 */
export function armTimeout(child: ChildProcess, timeoutMs: number, onTimeout: () => void): () => void {
  // fire runs at most once: setTimeout fires once and cancel() clears it.
  const fire = () => {
    killTree(child, 'SIGTERM');
    onTimeout();
    // Escalate so a stuck process can never block shutdown forever.
    const killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 5000);
    killTimer.unref();
  };
  const timer = setTimeout(fire, timeoutMs);
  timer.unref();
  return () => clearTimeout(timer);
}

/**
 * Build the human-readable `cmd args…` label used in error messages, with
 * credential-carrying argv values masked.
 *
 * Secrets travel as argv values by design (no shell interpolation), which is
 * safe for execution but NOT for logging: a failed `mysqldump --password=…`
 * would otherwise carry the database password into journald, the SQLite audit
 * log and notification channels via this label. `--password=x` masks the
 * value in place; `-p` / `-a` style flags mask the NEXT argv element (the
 * same flag doubles as docker publish, where masking a port is a cosmetic
 * cost next to leaking a password).
 *
 * `--env KEY=VALUE` (nixpacks builds carry the service's WHOLE runtime env —
 * project-shared secrets, managed-database URLs with plaintext passwords)
 * keeps the key but masks the value: a failed build's error string reaches
 * the deploy log, which every workspace member with the service can read.
 *
 * r644: `--requirepass <pw>` — the managed redis/valkey password rides as the
 * container command's argument (engine/database.ts), and a failed `docker run`
 * put it in the deploy log, HTTP 400 bodies and the server log verbatim.
 */
const REDACT_NEXT_FLAGS = new Set(['-p', '-a', '--password', '-e', '--requirepass']);
function redactedLabel(cmd: string, args: string[]): string {
  const parts: string[] = [cmd];
  let maskNext = false;
  // r664: ssh's last argv element is the REMOTE command line. The node
  // bootstrap's carries the agent token hash — the node's sealing key — and a
  // failed bootstrap put it into the operator's 400 and the server log.
  const shown = cmd === 'ssh' && args.length > 0 ? [...args.slice(0, -1), '<remote command>'] : args;
  for (const arg of shown) {
    if (maskNext) {
      parts.push('***');
      maskNext = false;
      continue;
    }
    if (arg.startsWith('--password=')) {
      parts.push('--password=***');
      continue;
    }
    if (arg.startsWith('--env=')) {
      const eq = arg.indexOf('=', 6);
      parts.push(eq === -1 ? '--env=***' : `${arg.slice(0, eq)}=***`);
      continue;
    }
    if (arg.startsWith('--env') && !arg.includes('=')) {
      // `--env KEY=VALUE` as two argv elements.
      parts.push(arg);
      maskNext = true;
      continue;
    }
    parts.push(arg);
    maskNext = REDACT_NEXT_FLAGS.has(arg);
  }
  return parts.join(' ');
}

/**
 * Run a command, streaming each stdout/stderr line to `sink`.
 * Rejects with an Error (or {@link ExecTimeoutError}) if the process exits
 * non-zero or exceeds its timeout.
 */
export function run(cmd: string, args: string[], opts: ExecOptions, sink: (line: string) => void, input?: Buffer): Promise<void> {
  const label = redactedLabel(cmd, args);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: buildEnv(opts.env),
      detached: true,
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (input && child.stdin) {
      child.stdin.on('error', () => { /* EPIPE when the child exits early */ });
      child.stdin.end(input);
    }

    // One splitter PER stream: sharing one pending buffer would let a partial
    // stdout line absorb stderr bytes arriving before the newline completes,
    // merging interleaved output into garbage lines.
    const outSplitter = makeLineSplitter();
    const errSplitter = makeLineSplitter();
    child.stdout?.on('data', (chunk: Buffer) => {
      lastActivityAt = Date.now();
      for (const line of outSplitter.feed(chunk)) sink(line);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      lastActivityAt = Date.now();
      for (const line of errSplitter.feed(chunk)) sink(line);
    });

    let settled = false;
    const cancelHeartbeat = armHeartbeat(
      sink,
      opts.heartbeatMs ?? 0,
      opts.heartbeatLabel ?? cmd,
      startedAt,
      () => lastActivityAt,
    );
    // onTimeout fires from the single-shot timer; close/error cancel it first,
    // and Promise settlement is idempotent regardless, so no settled guard here.
    const cancelTimeout = armTimeout(child, timeoutMs, () => {
      settled = true;
      cancelHeartbeat();
      reject(new ExecTimeoutError(label, timeoutMs));
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      cancelHeartbeat();
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      cancelHeartbeat();
      for (const tail of [outSplitter.flush(), errSplitter.flush()]) {
        if (tail.length) sink(tail);
      }
      // `code` is null when the child died to a signal — report the signal,
      // not the nonsense "code null".
      if (code === 0) resolve();
      else if (code === null) reject(new Error(`\`${label}\` was killed by signal ${signal ?? 'unknown'}`));
      else reject(new Error(`\`${label}\` exited with code ${code}`));
    });
  });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run a command and return its captured stdout (rejects on non-zero exit).
 *  `input` is written to stdin before the handle closes (EPIPE-tolerant, same
 *  as {@link run}) — commands that consume a script from stdin (`docker run -i …
 *  postgres --single`) need it, and their stdout is the verification channel. */
export function capture(cmd: string, args: string[], opts: ExecOptions = {}, input?: Buffer): Promise<string> {
  const label = redactedLabel(cmd, args);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: buildEnv(opts.env),
      detached: true,
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (input && child.stdin) {
      child.stdin.on('error', () => { /* EPIPE when the child exits early */ });
      child.stdin.end(input);
    }

    // Same rule as makeLineSplitter: decode bytes across chunks, not per chunk.
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');

    let out = '';
    let errOut = '';
    let outBytes = 0;
    const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_CAPTURE_MAX_BYTES;
    let settled = false;
    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    const cancelHeartbeat = armHeartbeat(
      (line) => opts.onProgress?.(line),
      opts.heartbeatMs ?? 0,
      opts.heartbeatLabel ?? label,
      startedAt,
      () => lastActivityAt,
    );
    // onTimeout fires from the single-shot timer; close/error cancel it first,
    // and Promise settlement is idempotent regardless, so no settled guard here.
    const cancelTimeout = armTimeout(child, timeoutMs, () => {
      settled = true;
      cancelHeartbeat();
      reject(new ExecTimeoutError(label, timeoutMs));
    });

    child.stdout?.on('data', (d: Buffer) => {
      if (settled) return;
      lastActivityAt = Date.now();
      outBytes += d.length;
      if (outBytes > maxOutputBytes) {
        // r667: stop the child and drop what was buffered.
        settled = true;
        cancelHeartbeat();
        cancelTimeout();
        killTree(child, 'SIGKILL');
        out = '';
        reject(new ExecOutputTooLargeError(label, maxOutputBytes));
        return;
      }
      out += outDecoder.write(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      lastActivityAt = Date.now();
      errOut += errDecoder.write(d);
      // r667: only the newest stderr ever reaches an error message.
      if (errOut.length > 2 * CAPTURE_STDERR_KEEP_CHARS) errOut = errOut.slice(-CAPTURE_STDERR_KEEP_CHARS);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cancelHeartbeat();
      cancelTimeout();
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cancelHeartbeat();
      cancelTimeout();
      // close fires after stdio has drained, so end() flushes any final
      // partial sequence (truncated bytes decode as U+FFFD, never throw).
      out += outDecoder.end();
      errOut += errDecoder.end();
      if (code === 0) resolve(out);
      else if (code === null) reject(new Error(`\`${label}\` was killed by signal ${signal ?? 'unknown'}${errOut ? `: ${errOut.trim()}` : ''}`));
      else reject(new Error(`\`${label}\` exited ${code}${errOut ? `: ${errOut.trim()}` : ''}`));
    });
  });
}
