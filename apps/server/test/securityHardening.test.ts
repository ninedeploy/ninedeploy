import { describe, expect, it } from 'vitest';
import { createService, serverSshBootstrap } from '@ninedeploy/schemas';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { secretEquals } from '../src/lib/crypto.js';
import { writeSecretFile } from '../src/lib/secretFile.js';
import { repoRelative, resolveInRepo } from '../src/lib/repoPath.js';

/**
 * Phase 3 security-scan hardening (2026-08-20): M-3 (security headers),
 * M-4 (OAuth redirect_uri from config, not the Host header), M-5 (private
 * temp files for secrets) and the constant-time half of M-6.
 *
 * The M-3 and M-4 assertions live next to their own module's tests
 * (`app.test.ts`, `oidc.test.ts`); this file covers the two new library
 * primitives and the property that made M-5 exploitable.
 */

describe('M-5: secret temp files are unguessable and private', () => {
  it('places each file in its own fresh directory', () => {
    const a = writeSecretFile('nd-test', 'x.env', 'A=1\n');
    const b = writeSecretFile('nd-test', 'x.env', 'A=1\n');
    try {
      expect(dirname(a.path)).not.toBe(dirname(b.path));
      expect(readFileSync(a.path, 'utf8')).toBe('A=1\n');
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('creates the directory 0700 and the file 0600', () => {
    if (process.platform === 'win32') return; // POSIX mode bits only
    const f = writeSecretFile('nd-test', 'x.env', 'SECRET=1\n');
    try {
      expect(statSync(dirname(f.path)).mode & 0o777).toBe(0o700);
      expect(statSync(f.path).mode & 0o777).toBe(0o600);
    } finally {
      f.cleanup();
    }
  });

  it('cleanup removes the file and its directory, and is safe to call twice', () => {
    const f = writeSecretFile('nd-test', 'x.env', 'A=1\n');
    const dir = dirname(f.path);
    f.cleanup();
    expect(() => statSync(dir)).toThrow();
    expect(() => f.cleanup()).not.toThrow();
  });

  it('refuses to reuse a directory an attacker pre-created', () => {
    // The whole point of mkdtemp over a predictable name: the old code did
    // `writeFileSync('${tmpdir()}/nd-env-<pid>-<ms>.env')`, which FOLLOWS a
    // symlink planted at that path. Here the target of a pre-created path is
    // never written to, because every call mints a fresh random directory.
    const planted = mkdtempSync(join(tmpdir(), 'nd-test-planted-'));
    const decoy = join(planted, 'x.env');
    writeFileSync(decoy, 'ORIGINAL\n');
    const f = writeSecretFile('nd-test', 'x.env', 'SECRET=1\n');
    try {
      expect(f.path).not.toBe(decoy);
      expect(readFileSync(decoy, 'utf8')).toBe('ORIGINAL\n');
    } finally {
      f.cleanup();
    }
  });
});

describe('M-6: secretEquals compares in constant time', () => {
  it('matches equal secrets and rejects different ones', () => {
    expect(secretEquals('s3cret-token', 's3cret-token')).toBe(true);
    expect(secretEquals('s3cret-token', 's3cret-tokeM')).toBe(false);
  });

  it('handles unequal lengths without throwing', () => {
    // timingSafeEqual throws on a length mismatch; hashing both sides first is
    // what makes this safe AND keeps the stored secret's length private.
    expect(secretEquals('short', 'a-much-longer-secret-value')).toBe(false);
    expect(secretEquals('', '')).toBe(true);
    expect(secretEquals('', 'x')).toBe(false);
  });
});

// ── L-1 · SSH destination operands ─────────────────────────────────────────

describe('L-1: SSH user/host cannot become an ssh option', () => {
  const base = { name: 'node', host: '10.0.0.5', sshKey: 'k' };

  it('rejects an sshUser that would turn the destination into -oProxyCommand', () => {
    // `${sshUser}@${host}` is ONE argv element; OpenSSH parses a leading dash
    // as an option, and ProxyCommand runs through /bin/sh on the panel host.
    const res = serverSshBootstrap.safeParse({ ...base, sshUser: '-oProxyCommand=touch /tmp/pwn' });
    expect(res.success).toBe(false);
  });

  it('rejects hosts and users with whitespace, @ or a leading dash', () => {
    for (const sshUser of ['-x', 'ro ot', 'root@evil', '']) {
      expect(serverSshBootstrap.safeParse({ ...base, sshUser }).success, `sshUser=${JSON.stringify(sshUser)}`).toBe(false);
    }
    for (const host of ['-oProxyCommand=x', 'a b', '@evil', '']) {
      expect(serverSshBootstrap.safeParse({ ...base, host, sshUser: 'root' }).success, `host=${JSON.stringify(host)}`).toBe(false);
    }
  });

  it('still accepts ordinary users, hostnames and IPs', () => {
    for (const [sshUser, host] of [['root', 'node-1.example.com'], ['deploy_bot', '10.0.0.5'], ['ubuntu', 'fe80::1']]) {
      expect(serverSshBootstrap.safeParse({ ...base, sshUser, host }).success, `${sshUser}@${host}`).toBe(true);
    }
  });
});

// ── L-13 · build paths stay inside the repository ──────────────────────────

describe('L-13: the schema rejects paths that climb out of the repo', () => {
  const svc = (build: Record<string, unknown>) =>
    createService.safeParse({ name: 'app', type: 'docker', build: { buildPack: 'auto', baseDir: '/', ...build } });

  it('rejects traversal and drive letters', () => {
    for (const dockerfilePath of ['../../etc/hosts', 'a/../../b', 'C:\\Windows\\system.ini']) {
      expect(svc({ dockerfilePath }).success, dockerfilePath).toBe(false);
    }
    expect(svc({ baseDir: '../..' }).success).toBe(false);
  });

  it('still accepts the leading-slash convention, which means "repo root"', () => {
    // `/app` is an existing, documented value — rejecting it here would break
    // real configurations. Containment is enforced at the sink instead (the
    // next describe block), which is where the escape actually happened.
    expect(svc({ baseDir: '/' }).success).toBe(true);
    expect(svc({ baseDir: '/app' }).success).toBe(true);
    expect(svc({ baseDir: 'apps/api', dockerfilePath: 'docker/Dockerfile.prod' }).success).toBe(true);
    // An empty string means "unset" to the builders and must stay valid.
    expect(svc({ dockerfilePath: '' }).success).toBe(true);
  });
});

// ── L-13 (sink) · build paths are re-anchored on the repo ──────────────────

describe('L-13: build paths cannot escape the checkout', () => {
  const workDir = '/data/repos/42';

  it('treats a leading slash as the repo root, not the filesystem root', () => {
    // This is the whole bug: path.resolve('/data/repos/42', '/etc') is '/etc',
    // so `baseDir: "/etc"` made the host's /etc the docker build context.
    expect(repoRelative(workDir, '/app')).toBe('app');
    expect(resolveInRepo(workDir, '/etc')).toBe(resolveInRepo(workDir, 'etc'));
    expect(resolveInRepo(workDir, '/etc')).not.toBe(resolve('/etc'));
  });

  it('maps the documented repo-root values to a usable operand', () => {
    for (const v of [undefined, '', '/', '\\']) {
      expect(repoRelative(workDir, v as string | undefined)).toBe('.');
    }
  });

  it('keeps ordinary sub-paths intact', () => {
    expect(repoRelative(workDir, 'apps/api')).toBe('apps/api');
    expect(repoRelative(workDir, 'docker/Dockerfile.prod')).toBe('docker/Dockerfile.prod');
  });

  it('refuses a path that climbs out of the checkout', () => {
    expect(() => resolveInRepo(workDir, '../../etc/passwd')).toThrow(/outside the repository/);
    expect(() => repoRelative(workDir, '../..')).toThrow(/outside the repository/);
  });

  it('refuses a path that walks through a symlink inside the checkout', () => {
    // Lexical containment is not enough: `ln -s /etc evil` + `baseDir: "evil"`
    // escapes the checkout through the filesystem — and on a bare-metal panel
    // the writer runs as root, so a dangling absolute symlink is root-owned
    // file creation anywhere on the host. Creating symlinks needs privileges
    // on Windows; when the OS refuses, CI (linux) covers this case.
    const realWork = mkdtempSync(join(tmpdir(), 'nd-repopath-'));
    try {
      const link = join(realWork, 'evil');
      try {
        symlinkSync(
          process.platform === 'win32' ? tmpdir() : '/etc',
          link,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch {
        return;
      }
      expect(() => resolveInRepo(realWork, 'evil', 'nixpacks.toml')).toThrow(/through a symlink/);
      expect(() => repoRelative(realWork, 'evil')).toThrow(/through a symlink/);
      // Ordinary files still resolve — the guard is not a blanket ban.
      writeFileSync(join(realWork, 'Dockerfile'), 'FROM scratch\n');
      expect(repoRelative(realWork, 'Dockerfile')).toBe('Dockerfile');
    } finally {
      rmSync(realWork, { recursive: true, force: true });
    }
  });
});
