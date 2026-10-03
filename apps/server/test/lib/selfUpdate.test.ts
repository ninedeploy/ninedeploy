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

  describe('r371/r703: runs the target release installer only when its checksum verifies', () => {
    // Executes the generated wrapper for real (bash + a fake curl/cosign on
    // PATH): the string checks above cannot tell a working fallback from a typo.
    const realCp = () => vi.importActual<typeof import('node:child_process')>('node:child_process');
    const hasBash = async () => (await realCp()).spawnSync('bash', ['-c', 'command -v sha256sum >/dev/null']).status === 0;
    const RELEASE = 'https://github.com/NineDeploy/NineDeploy/releases/download/v99.0.0';

    interface Release {
      /** install.sh asset body; absent = 404. */
      installer?: 'target' | 'garbage';
      /** SHA256SUMS: listing the asset's real digest, a different one, or absent (404). */
      sums?: 'match' | 'mismatch';
      bundle?: boolean;
      cosign?: 'ok' | 'bad';
      env?: Record<string, string>;
    }

    async function runWrapper(release: Release) {
      configMock.isProd = true;
      const installDir = newInstallDir();
      const marker = path.join(installDir, 'ran.txt').replaceAll('\\', '/');
      fs.writeFileSync(path.join(installDir, 'install.sh'), `#!/usr/bin/env bash\necho "installed $*" > "${marker}"\n`);
      const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-fakebin-'));
      createdDirs.push(bin);
      const assets = path.join(bin, 'assets');
      fs.mkdirSync(assets);
      const fwd = (p: string) => p.replaceAll('\\', '/');
      const body = release.installer === 'target'
        ? `#!/usr/bin/env bash\necho "target $* dir=$NINEDEPLOY_INSTALL_DIR" > "${marker}"\n`
        : '<html>rate limited</html>\n';
      if (release.installer) fs.writeFileSync(path.join(assets, 'install.sh'), body);
      if (release.sums) {
        const { createHash } = await import('node:crypto');
        const digest = release.sums === 'match' ? createHash('sha256').update(body).digest('hex') : '0'.repeat(64);
        fs.writeFileSync(path.join(assets, 'SHA256SUMS'), `${'a'.repeat(64)}  ninedeploy-v99.0.0.tar.gz\n${digest}  install.sh\n`);
      }
      if (release.bundle) fs.writeFileSync(path.join(assets, 'SHA256SUMS.sigstore.json'), '{}');
      fs.writeFileSync(
        path.join(bin, 'curl'),
        [
          '#!/usr/bin/env bash',
          `echo "$@" >> "${fwd(path.join(bin, 'args'))}"`,
          'out=""; url=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; case "$1" in https://*) url="$1";; esac; shift; done',
          `src="${fwd(assets)}/\${url##*/}"`,
          '[ -f "$src" ] || exit 22',
          'cat "$src" > "$out"',
        ].join('\n'),
        { mode: 0o755 },
      );
      if (release.cosign) {
        fs.writeFileSync(
          path.join(bin, 'cosign'),
          [
            '#!/usr/bin/env bash',
            '[ "$2" = "--help" ] && { echo "  --new-bundle-format"; exit 0; }',
            `echo "$@" >> "${fwd(path.join(bin, 'cosign-args'))}"`,
            release.cosign === 'ok' ? 'exit 0' : 'exit 1',
          ].join('\n'),
          { mode: 0o755 },
        );
      }
      const lib = await loadLib();
      await lib.startSelfUpdate('v99.0.0', { installDir });
      const cp = await realCp();
      const PATH = `${cp.spawnSync('bash', ['-c', `cygpath -u '${bin}' 2>/dev/null || echo '${bin}'`]).stdout.toString().trim()}:${process.env.PATH}`;
      const res = cp.spawnSync('bash', [path.join(stateDir(), 'run-update.sh')], {
        env: { ...process.env, PATH, ND_SELF_UPDATE_TARGET: 'v99.0.0', ...(release.env ?? {}) },
      });
      const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '');
      return {
        status: res.status,
        ran: read(path.join(installDir, 'ran.txt')),
        curlArgs: read(path.join(bin, 'args')),
        cosignArgs: read(path.join(bin, 'cosign-args')),
        exitCode: read(path.join(stateDir(), 'exit-code')),
        log: read(path.join(stateDir(), 'update.log')),
        installDir,
      };
    }

    it('runs the release installer asset whose sha256 SHA256SUMS lists, against the install dir', async () => {
      if (!(await hasBash())) return;
      const r = await runWrapper({ installer: 'target', sums: 'match' });
      expect(r.curlArgs).toContain(`${RELEASE}/SHA256SUMS`);
      expect(r.curlArgs).toContain(`${RELEASE}/install.sh`);
      // r703: the unverified raw.githubusercontent.com fetch is gone.
      expect(r.curlArgs).not.toContain('raw.githubusercontent.com');
      expect(r.ran).toMatch(/^target --version v99\.0\.0 dir=/);
      expect(r.ran).toContain(path.basename(r.installDir));
      expect(r.exitCode).toBe('0');
      expect(r.log).toContain('cosign is not installed');
      expect(r.log).toContain('using the v99.0.0 installer (sha256');
    });

    it('refuses the update when the installer does not match SHA256SUMS — nothing runs', async () => {
      if (!(await hasBash())) return;
      const r = await runWrapper({ installer: 'target', sums: 'mismatch' });
      expect(r.ran).toBe('');
      expect(r.exitCode).toBe('1');
      expect(r.status).toBe(1);
      expect(r.log).toContain('but SHA256SUMS lists 0000');
      expect(r.log).toContain('refusing to update (nothing was changed)');
      expect(fs.existsSync(path.join(stateDir(), 'install-target.sh'))).toBe(false);
    });

    it('with cosign present, a SHA256SUMS signature that does not verify refuses the update', async () => {
      if (!(await hasBash())) return;
      const bad = await runWrapper({ installer: 'target', sums: 'match', bundle: true, cosign: 'bad' });
      expect(bad.ran).toBe('');
      expect(bad.exitCode).toBe('1');
      expect(bad.log).toContain('did NOT verify');
      expect(bad.cosignArgs).toContain("--certificate-identity-regexp ^https://github\\.com/(?i:ninedeploy/ninedeploy)/");
      expect(bad.cosignArgs).toContain('--certificate-oidc-issuer https://token.actions.githubusercontent.com');

      const ok = await runWrapper({ installer: 'target', sums: 'match', bundle: true, cosign: 'ok' });
      expect(ok.ran).toMatch(/^target --version v99\.0\.0/);
      expect(ok.log).toContain('SHA256SUMS signature verified (cosign)');

      const skipped = await runWrapper({ installer: 'target', sums: 'match', cosign: 'bad', env: { NINEDEPLOY_SKIP_SIGNATURE_VERIFY: '1' } });
      expect(skipped.ran).toMatch(/^target --version v99\.0\.0/);
      expect(skipped.cosignArgs).toBe('');
    });

    it('falls back to the installed installer when the release assets cannot be fetched', async () => {
      if (!(await hasBash())) return;
      const none = await runWrapper({});
      expect(none.ran).toBe('installed --version v99.0.0');
      expect(none.exitCode).toBe('0');
      expect(fs.existsSync(path.join(stateDir(), 'install-target.sh.part'))).toBe(false);
      // An installer asset without SHA256SUMS is never run unverified.
      const unlisted = await runWrapper({ installer: 'target' });
      expect(unlisted.ran).toBe('installed --version v99.0.0');
      expect(unlisted.curlArgs).not.toContain(`${RELEASE}/install.sh`);
    });

    it('never executes a verified body that is not a bash script', async () => {
      if (!(await hasBash())) return;
      const r = await runWrapper({ installer: 'garbage', sums: 'match' });
      expect(r.ran).toBe('installed --version v99.0.0');
      expect(fs.existsSync(path.join(stateDir(), 'install-target.sh'))).toBe(false);
    });

    it('trusts the same release signer as install.sh', async () => {
      const lib = await loadLib();
      const sh = fs.readFileSync(new URL('../../../../install.sh', import.meta.url), 'utf8');
      expect(sh).toContain(`RELEASE_SIGNER_IDENTITY_RE='${lib.RELEASE_SIGNER_IDENTITY_RE}'`);
      expect(sh).toContain(`RELEASE_SIGNER_ISSUER="${lib.RELEASE_SIGNER_ISSUER}"`);
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

  it('r-next: two SIMULTANEOUS starts spawn exactly one updater (claim race)', async () => {
    // The running-check and the state write are separate steps; two POSTs in
    // the same milliseconds both used to pass the check and both spawned an
    // updater. The exclusive-create claim must let exactly one through.
    configMock.isProd = true;
    const lib = await loadLib();
    const results = await Promise.allSettled([
      lib.startSelfUpdate('v99.0.0', { installDir: newInstallDir() }),
      lib.startSelfUpdate('v99.0.0', { installDir: newInstallDir() }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    expect(spawnMock.calls).toHaveLength(1);
    // The winner's claim is released once the durable running state exists.
    expect(fs.existsSync(path.join(stateDir(), 'state.json.lock'))).toBe(false);
  });

  it('r-next: steals a claim left behind by a crashed claimer', async () => {
    configMock.isProd = true;
    const lib = await loadLib();
    const installDir = newInstallDir();
    // Pre-age the lock past the claim window (10 s): a claimer that died
    // between creating the lock and writing state.json must not block the
    // next update attempt forever.
    fs.mkdirSync(stateDir(), { recursive: true });
    const lock = path.join(stateDir(), 'state.json.lock');
    fs.writeFileSync(lock, '99999');
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, stale, stale);
    const res = await lib.startSelfUpdate('v99.0.0', { installDir });
    expect(res.ok).toBe(true);
    expect(spawnMock.calls).toHaveLength(1);
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

describe('r572: in-flight deployments block the update unless forced', () => {
  it('refuses with 409 deploys_in_flight before writing any run state', async () => {
    configMock.isProd = true;
    const lib = await loadLib();
    const err = await lib
      .startSelfUpdate('v99.0.0', {
        installDir: newInstallDir(),
        inFlightDeployments: async () => [{ id: 3, service: 'api', status: 'building' }],
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 409, code: 'deploys_in_flight' });
    expect((err as Error).message).toContain('1 deployment is in progress: #3 api (building)');
    expect(readState()).toBeNull();
    expect(spawnMock.calls).toHaveLength(0);
  });

  it('force skips the check entirely (the provider is never asked)', async () => {
    configMock.isProd = true;
    const lib = await loadLib();
    let asked = false;
    const res = await lib.startSelfUpdate('v99.0.0', {
      installDir: newInstallDir(),
      force: true,
      inFlightDeployments: async () => {
        asked = true;
        return [{ id: 3, service: 'api', status: 'building' }];
      },
    });
    expect(res.ok).toBe(true);
    expect(asked).toBe(false);
  });

  it('names the first ten and summarises the rest', async () => {
    const lib = await loadLib();
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, service: `s${i + 1}`, status: 'deploying' }));
    const err = lib.deploysInFlightError(rows);
    expect(err.message).toContain('12 deployments are in progress');
    expect(err.message).toContain('#10 s10 (deploying) and 2 more');
    expect(err.message).not.toContain('#11 ');
  });
});
