import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VERSION } from '../../src/version.js';

// Mutable config so tests control isProd and every test gets an isolated
// data dir — mirroring the pattern in resources.test.ts.
const configMock = vi.hoisted(() => ({
  isProd: false,
  paths: { dataDir: '' },
}));
vi.mock('../../src/config.js', () => ({ config: configMock }));

// Full child_process replacement: launches must be observed, never executed.
const spawnMock = vi.hoisted(() => ({
  spawn: null as unknown,
  calls: [] as Array<{ cmd: string; args: string[]; opts?: unknown }>,
}));
function installSpawn() {
  const fn = (cmd: string, args: string[], opts?: unknown) => {
    spawnMock.calls.push({ cmd, args, opts });
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const register = (ev: string, cb: (...a: unknown[]) => void) => {
      const list = handlers[ev] ?? [];
      list.push(cb);
      handlers[ev] = list;
    };
    queueMicrotask(() => {
      // systemd-run probe resolves through 'spawn' (job accepted); anything
      // else rejects through 'error' so the fallback detached branch runs.
      if (cmd === 'systemd-run') {
        for (const cb of handlers['spawn'] ?? []) cb();
        for (const cb of handlers['once-spawn'] ?? []) cb();
        for (const cb of handlers['once-exit'] ?? []) cb(0);
      }
    });
    return {
      on: (ev: string, cb: (...a: unknown[]) => void) => register(ev, cb),
      once: (ev: string, cb: (...a: unknown[]) => void) => register(`once-${ev}`, cb),
      unref: () => undefined,
    };
  };
  return fn;
}
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  void real;
  spawnMock.spawn = installSpawn();
  return { spawn: (...a: unknown[]) => (spawnMock.spawn as (...a: unknown[]) => unknown)(...(a as [string, string[], unknown])) };
});

const createdDirs: string[] = [];
function newDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-selfupd-'));
  createdDirs.push(dir);
  configMock.paths.dataDir = dir;
  return dir;
}

/** A fake installation directory that passes the support gate. */
function newInstallDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-selfinst-'));
  createdDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'install.sh'), '#!/usr/bin/env bash\nexit 0');
  return dir;
}

async function loadLib() {
  return await import('../../src/lib/selfUpdate.js');
}

function stateDir(): string {
  return path.join(configMock.paths.dataDir, 'self-update');
}

function readState(): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(), 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

beforeEach(() => {
  newDataDir();
  spawnMock.calls = [];
  // The bash-fallback test swaps in an erroring spawn override; restore the
  // default install here so the leak cannot bleed into later cases.
  spawnMock.spawn = installSpawn();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

afterAll(() => {
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('self-update support gating', () => {
  it('is unsupported outside production, with a reason', async () => {
    configMock.isProd = false;
    const lib = await loadLib();
    expect(lib.selfUpdateSupported(newInstallDir()).supported).toBe(false);
    const status = await lib.getSelfUpdateStatus({ installDir: newInstallDir() });
    expect(status.supported).toBe(false);
    expect(status.phase).toBe('unsupported');
    expect(status.reason).toContain('production');
  });

  it('is unsupported for container installs', async () => {
    configMock.isProd = true;
    const lib = await loadLib();
    // A real file standing in for /.dockerenv proves the branch without
    // needing to spy on node:fs internals under ESM.
    const marker = path.join(newDataDir(), 'fake-dockerenv');
    fs.writeFileSync(marker, '');
    const res = lib.selfUpdateSupported(newInstallDir(), marker);
    expect(res.supported).toBe(false);
    expect(res.reason).toContain('docker compose');
  });

  it('is unsupported when install.sh is missing next to the install dir', async () => {
    configMock.isProd = true;
    const lib = await loadLib();
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-bare-'));
    createdDirs.push(bare);
    expect(lib.selfUpdateSupported(bare).supported).toBe(false);
  });

  it('reports idle when supported and never run', async () => {
    configMock.isProd = true;
    const lib = await loadLib();
    const status = await lib.getSelfUpdateStatus({ installDir: newInstallDir() });
    expect(status.phase).toBe('idle');
    expect(status.targetVersion).toBeNull();
  });
});

describe('startSelfUpdate', () => {
  it('launches the updater through systemd-run with a pinned tag and persists the run state', async () => {
    configMock.isProd = true;
    const lib = await loadLib();
    const res = await lib.startSelfUpdate('v99.0.0', { installDir: newInstallDir() });
    expect(res.ok).toBe(true);

    expect(spawnMock.calls).toHaveLength(1);
    const call = spawnMock.calls[0]!;
    expect(call.cmd).toBe('systemd-run');
    expect(call.args[0]).toBe('--unit');
    expect(call.args).toContain('--collect');
    // The target travels twice: as --setenv into the transient unit (validated)
    // and inside the generated wrapper script.
    expect(call.args.join(' ')).toContain('--setenv=ND_SELF_UPDATE_TARGET=v99.0.0');

    const state = readState();
    expect(state).toMatchObject({ phase: 'running', to: 'v99.0.0' });

    const script = fs.readFileSync(path.join(stateDir(), 'run-update.sh'), 'utf8');
    expect(script).toContain('--version "$ND_SELF_UPDATE_TARGET"');
    expect(script).toContain('install.sh');
  });

  describe('r371: runs the target release installer', () => {
    // Executes the generated wrapper for real (bash + a fake curl on PATH):
    // the string checks above cannot tell a working fallback from a typo.
    const realCp = () => vi.importActual<typeof import('node:child_process')>('node:child_process');
    const hasBash = async () => (await realCp()).spawnSync('bash', ['-c', 'exit 0']).status === 0;

    async function runWrapper(curl: 'serve' | 'fail' | 'garbage') {
      configMock.isProd = true;
      const installDir = newInstallDir();
      const marker = path.join(installDir, 'ran.txt').replaceAll('\\', '/');
      fs.writeFileSync(path.join(installDir, 'install.sh'), `#!/usr/bin/env bash\necho "installed $*" > "${marker}"\n`);
      const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-fakebin-'));
      createdDirs.push(bin);
      const target = `#!/usr/bin/env bash\necho "target $* dir=$NINEDEPLOY_INSTALL_DIR" > "${marker}"\n`;
      const body = curl === 'serve' ? target : curl === 'garbage' ? '<html>rate limited</html>\n' : '';
      fs.writeFileSync(path.join(bin, 'body'), body);
      fs.writeFileSync(
        path.join(bin, 'curl'),
        [
          '#!/usr/bin/env bash',
          `echo "$@" > "${path.join(bin, 'args').replaceAll('\\', '/')}"`,
          curl === 'fail' ? 'exit 22' : '',
          'out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done',
          `cat "${path.join(bin, 'body').replaceAll('\\', '/')}" > "$out"`,
        ].join('\n'),
        { mode: 0o755 },
      );
      const lib = await loadLib();
      await lib.startSelfUpdate('v99.0.0', { installDir });
      const cp = await realCp();
      const PATH = `${cp.spawnSync('bash', ['-c', `cygpath -u '${bin}' 2>/dev/null || echo '${bin}'`]).stdout.toString().trim()}:${process.env.PATH}`;
      const res = cp.spawnSync('bash', [path.join(stateDir(), 'run-update.sh')], {
        env: { ...process.env, PATH, ND_SELF_UPDATE_TARGET: 'v99.0.0' },
      });
      return {
        status: res.status,
        ran: fs.readFileSync(path.join(installDir, 'ran.txt'), 'utf8').trim(),
        curlArgs: fs.readFileSync(path.join(bin, 'args'), 'utf8'),
        exitCode: fs.readFileSync(path.join(stateDir(), 'exit-code'), 'utf8').trim(),
        installDir,
      };
    }

    it('fetches the pinned tag installer and runs it against the install dir', async () => {
      if (!(await hasBash())) return;
      const r = await runWrapper('serve');
      expect(r.curlArgs).toContain('https://raw.githubusercontent.com/NineDeploy/NineDeploy/v99.0.0/install.sh');
      expect(r.ran).toMatch(/^target --version v99\.0\.0 dir=/);
      expect(r.ran).toContain(path.basename(r.installDir));
      expect(r.exitCode).toBe('0');
    });

    it('falls back to the installed installer when the fetch fails', async () => {
      if (!(await hasBash())) return;
      const r = await runWrapper('fail');
      expect(r.ran).toBe('installed --version v99.0.0');
      expect(r.exitCode).toBe('0');
      expect(fs.existsSync(path.join(stateDir(), 'install-target.sh.part'))).toBe(false);
    });

    it('never executes a fetched body that is not a bash script', async () => {
      if (!(await hasBash())) return;
      const r = await runWrapper('garbage');
      expect(r.ran).toBe('installed --version v99.0.0');
      expect(fs.existsSync(path.join(stateDir(), 'install-target.sh'))).toBe(false);
    });
  });

  it('keeps the updater state directory and its log owner-only', async () => {
    // The wrapper script was already 0700; the log beside it was created at the
    // default 0644 while capturing the installer's entire output stream, and
    // `errorTail` surfaces the tail of that through the API. `install.sh` is
    // careful to chmod 600 the .env it writes — this is the same care applied
    // to where its output lands.
    configMock.isProd = true;
    const lib = await loadLib();
    await lib.startSelfUpdate('v99.0.0', { installDir: newInstallDir() });

    const mode = (p: string) => fs.statSync(p).mode & 0o777;
    // Windows does not model POSIX permission bits; assert only where they mean
    // something.
    if (process.platform === 'win32') return;
    expect(mode(stateDir())).toBe(0o700);
    expect(mode(path.join(stateDir(), 'update.log'))).toBe(0o600);
    expect(mode(path.join(stateDir(), 'run-update.sh'))).toBe(0o700);
  });

  it('rejects a target that is not newer than the running version', async () => {
    configMock.isProd = true;
    const lib = await loadLib();
    await expect(lib.startSelfUpdate(`v${VERSION}`, { installDir: newInstallDir() })).rejects.toMatchObject({
      code: 'not_newer',
      statusCode: 400,
    });
    await expect(lib.startSelfUpdate('v0.0.1', { installDir: newInstallDir() })).rejects.toMatchObject({
      code: 'not_newer',
    });
  });

  it('rejects malformed tags before touching the filesystem', async () => {
    configMock.isProd = true;
    const lib = await loadLib();
    await expect(
      lib.startSelfUpdate('v1.2.3; rm -rf /', { installDir: newInstallDir() }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(readState()).toBeNull();
    expect(spawnMock.calls).toHaveLength(0);
  });

  it('refuses to start while another update is already running', async () => {
    configMock.isProd = true;
    const lib = await loadLib();
    await lib.startSelfUpdate('v99.0.0', { installDir: newInstallDir() });
    await expect(lib.startSelfUpdate('v99.0.1', { installDir: newInstallDir() })).rejects.toMatchObject({
      statusCode: 409,
      code: 'conflict',
    });
  });

  it('falls back to a plain detached bash child when systemd-run is unavailable', async () => {
    configMock.isProd = true;
    const lib = await loadLib();

    const spawnOverride = (cmd: string, args: string[], opts?: unknown) => {
      spawnMock.calls.push({ cmd, args, opts });
      const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
      const emitErr = () => {
        for (const cb of handlers['error'] ?? []) cb(new Error('ENOENT'));
        for (const cb of handlers['once-error'] ?? []) cb(new Error('ENOENT'));
      };
      return {
        on: (ev: string, cb: (...a: unknown[]) => void) => {
          const list = handlers[ev] ?? [];
          list.push(cb);
          handlers[ev] = list;
          if (ev === 'error') queueMicrotask(emitErr);
        },
        once: (ev: string, cb: (...a: unknown[]) => void) => {
          const key = `once-${ev}`;
          const list = handlers[key] ?? [];
          list.push(cb);
          handlers[key] = list;
          if (ev === 'error') queueMicrotask(emitErr);
        },
        unref: () => undefined,
      };
    };
    (spawnMock as unknown as { spawn: unknown }).spawn = spawnOverride;

    await lib.startSelfUpdate('v99.0.0', { installDir: newInstallDir() });
    expect(spawnMock.calls.map((c) => c.cmd)).toEqual(['systemd-run', '/bin/bash']);
    // The bash spawn emitted ENOENT. The error must be recorded as a finished,
    // failed update — not swallowed (which used to crash the panel with an
    // uncaught 'error' event) and not left dangling as "running" forever.
    const state = readState()!;
    expect(state.phase).toBe('failed');
    expect(state.finishedAt).toBeTruthy();
    expect(String(state.error)).toContain('ENOENT');
  });
});

describe('status resolution from marker files', () => {
  async function started(target = 'v99.0.0'): Promise<void> {
    configMock.isProd = true;
    const lib = await loadLib();
    await lib.startSelfUpdate(target, { installDir: newInstallDir() });
  }

  it('keeps reporting running until a marker appears', async () => {
    await started();
    const lib = await loadLib();
    const status = await lib.getSelfUpdateStatus({ installDir: newInstallDir() });
    expect(status.phase).toBe('running');
  });

  it('resolves a zero exit code to success and remembers it across reads', async () => {
    await started();
    fs.writeFileSync(path.join(stateDir(), 'exit-code'), '0');
    const lib = await loadLib();
    const first = await lib.getSelfUpdateStatus({ installDir: newInstallDir() });
    expect(first.phase).toBe('success');
    expect(first.finishedAt).toBeTruthy();
    // Second read takes the persisted terminal-phase branch, not re-resolution.
    const second = await lib.getSelfUpdateStatus({ installDir: newInstallDir() });
    expect(second.phase).toBe('success');
    expect(second.finishedAt).toBe(first.finishedAt);
  });

  it('resolves a non-zero exit code to failure with a log tail', async () => {
    await started();
    fs.writeFileSync(path.join(stateDir(), 'update.log'), 'line1\nline2\nboom: pnpm build failed\n');
    fs.writeFileSync(path.join(stateDir(), 'exit-code'), '1');
    const lib = await loadLib();
    const status = await lib.getSelfUpdateStatus({ installDir: newInstallDir() });
    expect(status.phase).toBe('failed');
    expect(status.errorTail).toContain('pnpm build failed');
  });

  it('fails a run whose updater went silent past the staleness bound', async () => {
    await started();
    const state = readState()!;
    const started90minAgo = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(stateDir(), 'state.json'), JSON.stringify({ ...state, startedAt: started90minAgo }));
    const lib = await loadLib();
    const status = await lib.getSelfUpdateStatus({ installDir: newInstallDir() });
    expect(status.phase).toBe('failed');
  });

  it('promotes a rebooted panel onto the target release to success after the boot grace', async () => {
    // Scenario: this process IS the upgraded panel — the persisted target tag
    // equals the RUNNING version — but the installer never got to write its
    // exit marker. Crafted directly: startSelfUpdate refuses equal tags.
    configMock.isProd = true;
    const p = {
      dir: stateDir(),
      log: path.join(stateDir(), 'update.log'),
      script: path.join(stateDir(), 'run-update.sh'),
      exitCode: path.join(stateDir(), 'exit-code'),
      state: path.join(stateDir(), 'state.json'),
    };
    fs.mkdirSync(p.dir, { recursive: true });
    fs.writeFileSync(p.state, JSON.stringify({
      phase: 'running',
      from: 'v0.0.9',
      to: `v${VERSION}`,
      startedAt: new Date().toISOString(),
    }));
    const lib = await loadLib();

    // Immediately after boot: still "running" — the installer may still be
    // finishing its health gate.
    let status = await lib.getSelfUpdateStatus({ installDir: newInstallDir() });
    expect(status.phase).toBe('running');

    // After the grace window passes with no exit marker: success.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    status = await lib.getSelfUpdateStatus({ installDir: newInstallDir() });
    expect(status.phase).toBe('success');
  });
});

describe('updaterEnvironment', () => {
  it('passes operator settings and host tooling through, forcing production mode', async () => {
    vi.stubEnv('PATH', '/usr/local/bin:/usr/bin');
    vi.stubEnv('NINEDEPLOY_PORT', '3000');
    vi.stubEnv('NINEDEPLOY_MASTER_KEY_FILE', '/var/lib/ninedeploy/master.key');
    const lib = await loadLib();
    const env = lib.updaterEnvironment();
    expect(env['NINEDEPLOY_PORT']).toBe('3000');
    expect(env['NINEDEPLOY_MASTER_KEY_FILE']).toBe('/var/lib/ninedeploy/master.key');
    expect(env['NODE_ENV']).toBe('production');
  });

  it('r171: never hands secret-valued settings to the updater (they become argv)', async () => {
    vi.stubEnv('NINEDEPLOY_JWT_SECRET', 'jwt-secret-value');
    vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'master-key-value');
    vi.stubEnv('NINEDEPLOY_DNS_TOKEN', 'dns-token-value');
    vi.stubEnv('NINEDEPLOY_ADMIN_PASSWORD', 'pw');
    const lib = await loadLib();
    const env = lib.updaterEnvironment();
    const leaked = Object.values(env).join(' ');
    for (const v of ['jwt-secret-value', 'master-key-value', 'dns-token-value']) expect(leaked).not.toContain(v);
    expect(env['NINEDEPLOY_ADMIN_PASSWORD']).toBeUndefined();
  });
});
