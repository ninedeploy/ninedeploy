import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { badRequest, conflict } from './errors.js';
import { isNewer } from './updateCheck.js';
import { VERSION } from '../version.js';
import { config } from '../config.js';

/**
 * Panel self-update — the apply side of /v1/system/update-check ("update
 * available" → one-click upgrade).
 *
 * Starting an update runs this install's own install.sh: the same documented
 * upgrade path as a hand-typed installer run — snapshot .data, replace the
 * source tree with the pinned release tarball, clear stale build output,
 * rebuild, migrate the database, restart the systemd unit.
 *
 * The hard part is surviving our own upgrade. install.sh stops the ninedeploy
 * unit mid-run, and even under KillMode=mixed every remaining process in the
 * unit's cgroup receives SIGKILL once the main process exits — so a plainly
 * detached child dies halfway through the build. On a systemd host the
 * updater therefore launches through `systemd-run` into its own transient
 * unit, a cgroup the panel's stop never touches. Hosts without systemd fall
 * back to a plain detached child, which is fine wherever nothing stops the
 * unit mid-run (containers/dev machines — excluded upstream regardless).
 *
 * State lives in marker files under <dataDir>/self-update/, not process
 * memory: the panel answering status polls after an upgrade is a different
 * process than the one that started it. Resolution:
 *
 *   exit-code file present         → success (0) / failed (nonzero)
 *   none + running VERSION==target → success once boot grace passes
 *   none + older than STALE        → failed (updater never reported)
 *   none + fresh                   → running
 */

/** Generous: apt mirrors, slow hosts and long builds are all normal here. */
const STALE_RUNNING_MS = 45 * 60 * 1000;
/** After a reboot onto the target release, wait this long for the installer's final exit marker before declaring success by version alone. */
const BOOT_GRACE_MS = 3 * 60 * 1000;
const ERROR_TAIL_LINES = 15;

export interface SelfUpdatePaths {
  dir: string;
  log: string;
  script: string;
  exitCode: string;
  state: string;
}

interface SelfUpdateState {
  phase: 'running' | 'success' | 'failed';
  /** Tag the panel ran when the update started, e.g. "v0.3.2". */
  from: string;
  /** Pinned release tag handed to install.sh --version. */
  to: string;
  startedAt: string;
  finishedAt?: string;
  /** Present only when the updater could not be launched at all. */
  error?: string;
}

type Phase = 'idle' | 'running' | 'success' | 'failed' | 'unsupported';

function currentTag(): string {
  return `v${VERSION}`;
}

function normalizeTag(v: string): string {
  const t = v.trim();
  return t.startsWith('v') ? t : `v${t}`;
}

function paths(stateDir?: string): SelfUpdatePaths {
  const dir = stateDir ?? path.join(config.paths.dataDir, 'self-update');
  return {
    dir,
    log: path.join(dir, 'update.log'),
    script: path.join(dir, 'run-update.sh'),
    exitCode: path.join(dir, 'exit-code'),
    state: path.join(dir, 'state.json'),
  };
}

/**
 * Self-update applies only where install.sh owns the running tree: a
 * production bare-metal installation. Devs (who build in-repo via turbo) and
 * container deployments (whose lifecycle is compose pull) must keep using
 * their own flows.
 */
export function selfUpdateSupported(
  installDir?: string,
  // Injectable so tests can prove the container branch without fs spies.
  dockerEnvMarker = '/.dockerenv',
): { supported: boolean; reason?: string; installDir?: string } {
  if (!config.isProd) {
    return { supported: false, reason: 'Panel self-update runs only on production installs.' };
  }
  if (existsSync(dockerEnvMarker)) {
    return {
      supported: false,
      reason: 'The panel runs as a container — upgrade with docker compose pull && docker compose up -d.',
    };
  }
  // Production starts the service with WorkingDirectory=<install dir>.
  const dir = installDir ?? process.cwd();
  if (!existsSync(path.join(dir, 'install.sh')) || !existsSync(path.join(dir, 'package.json'))) {
    return { supported: false, reason: 'install.sh was not found next to the running installation.' };
  }
  return { supported: true, installDir: dir };
}

function readFileText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function safeMtimeIso(file: string): string | null {
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

function atomicWriteJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

function tailLog(p: SelfUpdatePaths, lines = ERROR_TAIL_LINES): string | null {
  const text = readFileText(p.log);
  if (text == null || text.trim() === '') return null;
  return text.split('\n').filter(Boolean).slice(-lines).join('\n');
}

// Module-load time stands in for "when did the current panel process boot" —
// good enough for the boot-grace comparison and adjustable in tests.
const PROCESS_BOOTED_AT = Date.now();

interface ResolvedRun {
  targetVersion: string;
  startedAt: string;
  finishedAt: string | null;
  phase: 'running' | 'success' | 'failed';
  errorTail: string | null;
}

/**
 * Fold marker files (+ persisted terminal phases) into the display phase.
 * Terminal resolutions are written back so every later reader — including the
 * next panel process — agrees on the outcome.
 */
function resolveRun(p: SelfUpdatePaths): ResolvedRun | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileText(p.state) ?? '');
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const st = raw as Partial<SelfUpdateState>;
  if (typeof st.to !== 'string' || typeof st.startedAt !== 'string') return null;

  const base = { targetVersion: st.to, startedAt: st.startedAt };

  if (st.phase === 'failed') {
    return { ...base, phase: 'failed', finishedAt: st.finishedAt ?? safeMtimeIso(p.exitCode), errorTail: tailLog(p) };
  }
  if (st.phase === 'success') {
    return { ...base, phase: 'success', finishedAt: st.finishedAt ?? safeMtimeIso(p.exitCode), errorTail: null };
  }

  // Persisted phase: running.
  const exitRaw = readFileText(p.exitCode)?.trim() ?? null;

  const finish = (ok: boolean) => {
    const resolved: SelfUpdateState = {
      ...(st as SelfUpdateState),
      phase: ok ? 'success' : 'failed',
      finishedAt: new Date().toISOString(),
    };
    atomicWriteJson(p.state, resolved);
    return {
      ...base,
      phase: resolved.phase,
      finishedAt: resolved.finishedAt!,
      errorTail: ok ? null : (tailLog(p) ?? `The updater exited ${exitRaw} without leaving output.`),
    };
  };

  if (exitRaw != null && /^\d+$/.test(exitRaw)) {
    return finish(exitRaw === '0');
  }

  const startedMs = Date.parse(st.startedAt);
  const ageKnown = Number.isFinite(startedMs);

  if (normalizeTag(st.to) === currentTag() && Date.now() - PROCESS_BOOTED_AT > BOOT_GRACE_MS) {
    // This panel IS the release the update pinned — it made it through its own
    // upgrade even though no exit marker survived. The grace window keeps an
    // installer whose health gate is still finishing from flashing "success".
    return finish(true);
  }

  if (ageKnown && Date.now() - startedMs > STALE_RUNNING_MS) {
    return finish(false);
  }

  return { ...base, phase: 'running', finishedAt: null, errorTail: null };
}

/** Status payload for GET /v1/system/update-status. Safe to call anywhere. */
export function getSelfUpdateStatus(opts: { installDir?: string; stateDir?: string } = {}) {
  const support = selfUpdateSupported(opts.installDir);

  if (!support.supported) {
    return {
      supported: false as const,
      phase: 'unsupported' as Phase,
      currentVersion: currentTag(),
      targetVersion: null,
      startedAt: null,
      finishedAt: null,
      errorTail: null,
      reason: support.reason,
    };
  }

  const p = paths(opts.stateDir);
  const run = existsSync(p.state) ? resolveRun(p) : null;
  if (!run) {
    return {
      supported: true as const,
      phase: 'idle' as Phase,
      currentVersion: currentTag(),
      targetVersion: null,
      startedAt: null,
      finishedAt: null,
      errorTail: null,
    };
  }

  return {
    supported: true as const,
    phase: run.phase satisfies 'running' | 'success' | 'failed',
    currentVersion: currentTag(),
    targetVersion: run.targetVersion,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    errorTail: run.errorTail,
  };
}

/**
 * Environment handed to the updater. Deliberately narrower than process.env:
 * the service environment holds every deployment secret and a transient
 * unit's environment is readable via `systemctl show`. PATH/HOME keep
 * node/pnpm resolvable inside the clean systemd-run environment; NINEDEPLOY_*
 * keeps operator settings consistent between the panel and the installer.
 *
 * r171: secret-valued NINEDEPLOY_* keys (master key, JWT secret, tokens,
 * passwords) are NOT passed. They became `--setenv=K=V` arguments — readable
 * by every local user in `ps` / `/proc/<pid>/cmdline` and later via
 * `systemctl show` on the transient unit. install.sh reads them from `.env`
 * itself (the same file the service's EnvironmentFile= loads).
 */
const SECRET_KEY = /(SECRET|_KEY|_KEYS|TOKEN|PASSWORD|PASSWD)$/;

export function updaterEnvironment(): Record<string, string> {
  const passthrough = ['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR'];
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (passthrough.includes(key)) out[key] = value;
    else if (key.startsWith('NINEDEPLOY_') && !SECRET_KEY.test(key)) out[key] = value;
  }
  out['NODE_ENV'] = 'production';
  return out;
}

function updaterScript(p: SelfUpdatePaths, installDir: string): string {
  // ND_SELF_UPDATE_TARGET arrives pre-validated (^v\d+\.\d+\.\d+$), so the
  // only interpolation below is into double quotes by our own generator.
  return [
    '#!/usr/bin/env bash',
    '# Generated by the NineDeploy panel — re-created on every update start.',
    'set -u',
    // Log everything, including the installer's streamed progress lines.
    `exec >>"${p.log}" 2>&1`,
    'echo "== NineDeploy self-update started $(date -Is)"',
    `cd "${installDir}" || { echo 1 > "${p.exitCode}"; exit 1; }`,
    'bash ./install.sh --version "$ND_SELF_UPDATE_TARGET"',
    'rc=$?',
    `echo "$rc" > "${p.exitCode}"`,
    'echo "== installer exited $rc at $(date -Is)"',
    'exit "$rc"',
    '',
  ].join('\n');
}

/**
 * Launch the updater for `version` and return immediately. The work continues
 * in a process designed to survive the panel restart it triggers. Typed
 * HttpErrors surface through the route's error envelope.
 */
export async function startSelfUpdate(version: string, opts: { installDir?: string; stateDir?: string } = {}): Promise<{ ok: boolean }> {
  const target = normalizeTag(version);
  if (!/^v\d+\.\d+\.\d+$/.test(target)) throw badRequest('version must be a release tag like v0.3.4');

  const support = selfUpdateSupported(opts.installDir);
  if (!support.supported) throw conflict(support.reason ?? 'Panel self-update is not available on this installation');

  if (!isNewer(target, currentTag())) {
    throw badRequest(`${target} is not newer than the running ${currentTag()} — nothing to update`, 'not_newer');
  }

  const existing = getSelfUpdateStatus({ installDir: opts.installDir, stateDir: opts.stateDir });
  if (existing.phase === 'running') throw conflict(`An update to ${existing.targetVersion} is already in progress`);

  const p = paths(opts.stateDir);
  // 0700: this directory holds the generated updater script and the captured
  // installer output. `install.sh` is careful to chmod 600 the .env it writes;
  // the place its output lands deserves the same treatment.
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });

  writeFileSync(p.script, updaterScript(p, support.installDir!), { mode: 0o700 });
  try { unlinkSync(p.exitCode); } catch { /* first run */ }
  // Truncate with the same restriction as the script beside it. The updater
  // appends the installer's whole stream here, and `errorTail` surfaces the
  // last lines of it through the API on failure.
  writeFileSync(p.log, '', { mode: 0o600 });

  const state: SelfUpdateState = {
    phase: 'running',
    from: currentTag(),
    to: target,
    startedAt: new Date().toISOString(),
  };
  // Persist BEFORE spawning: losing power between spawn and bookkeeping must
  // leave a "running" marker the staleness bound can resolve, not silence.
  atomicWriteJson(p.state, state);

  await launchUpdater(p.script, { ...updaterEnvironment(), ND_SELF_UPDATE_TARGET: target }, p.state, state);
  return { ok: true };
}

async function launchUpdater(
  script: string,
  env: Record<string, string>,
  stateFile: string,
  state: SelfUpdateState,
): Promise<void> {
  if (await trySystemdRun(script, env)) return;
  // No systemd(-run): plain detached child. Correct wherever nothing stops
  // the panel unit mid-upgrade; the supported() gate above excludes hosts
  // where that distinction matters in practice.
  const child = spawn('/bin/bash', [script], { detached: true, stdio: 'ignore', env });
  // A spawn failure (host without /bin/bash) arrives asynchronously as an
  // 'error' event — with no listener Node turns it into an uncaught exception
  // that kills the panel mid-request. Record the failure instead so the UI
  // shows a finished, failed update rather than a stuck "running" marker.
  child.once('error', (err) => {
    try {
      atomicWriteJson(stateFile, {
        ...state,
        phase: 'failed',
        finishedAt: new Date().toISOString(),
        error: `Failed to launch the updater: ${err.message}`,
      });
    } catch {
      // Best effort — nothing sane is left to do if even the state file
      // cannot be written at this point.
    }
  });
  child.unref();
}

/**
 * Launch via systemd-run so the updater escapes the service cgroup. Resolves
 * false when systemd-run is unusable (missing binary / spawn failure) so the
 * caller can fall back. systemd-run registers the transient unit and returns
 * immediately (no --wait); the updater outlives this call either way.
 */
function trySystemdRun(script: string, env: Record<string, string>): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };

    const args = [
      '--unit', `ninedeploy-self-update-${Date.now()}`, // unique name: --collect cleans dead units, a collision would abort the run
      '--collect',
      '--quiet',
      ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`),
      '/bin/bash', script,
    ];
    const child = spawn('systemd-run', args, { detached: true, stdio: 'ignore' });
    // r171: success is systemd-run's EXIT status (it returns as soon as the
    // transient unit is registered). 'spawn' only means the binary started —
    // without a D-Bus/systemd session it then exits non-zero, and the update
    // used to show "running" for 45 minutes instead of falling back.
    child.once('exit', (code) => done(code === 0));
    child.once('error', () => done(false));
  });
}
