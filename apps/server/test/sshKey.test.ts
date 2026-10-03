import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDeployKeyPair } from '../src/lib/sshKey.js';
import { capture } from '../src/lib/exec.js';

vi.mock('../src/lib/exec.js', () => ({ capture: vi.fn() }));

const mockCapture = vi.mocked(capture);

/**
 * Integration-style test: the real `ssh-keygen` binary is not available in
 * CI on every platform. We mock `capture` (the only subprocess wrapper) to
 * simulate the tool's I/O contract, so the file handling, comment validation,
 * and cleanup paths are exercised end-to-end without a real key pair.
 */
describe('generateDeployKeyPair', () => {
  beforeEach(() => {
    mockCapture.mockReset();
  });

  it('returns a key pair and the SHA-256 fingerprint on the happy path', async () => {
    // Have capture create the files for us so the lib's readFileSync calls
    // (which run against the same mkdtemp work dir) find the expected contents.
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const { writeFileSync } = realFs;
    mockCapture.mockImplementation(async (cmd, args) => {
      if (cmd !== 'ssh-keygen') throw new Error(`unexpected cmd: ${cmd}`);
      if (args.includes('-lf')) return '256 SHA256:abc123fingerprint user@host (ED25519)\n';
      const target = args[args.indexOf('-f') + 1] as string;
      const pub = `${target}.pub`;
      writeFileSync(target, '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n');
      writeFileSync(pub, 'ssh-ed25519 AAAAfake user@host\n');
      return '';
    });
    const result = await generateDeployKeyPair('ninedeploy@github-personal');
    expect(result.publicKey).toMatch(/^ssh-ed25519 /);
    expect(result.fingerprint).toBe('SHA256:abc123fingerprint');
  });

  it('rejects an unsafe comment before calling ssh-keygen', async () => {
    await expect(generateDeployKeyPair('a;rm -rf /')).rejects.toThrow(/Invalid SSH key comment/);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('rejects a comment with whitespace (a real ssh-keygen gotcha)', async () => {
    await expect(generateDeployKeyPair('has space')).rejects.toThrow(/Invalid SSH key comment/);
  });

  it('propagates ssh-keygen errors without leaking the temp dir', async () => {
    mockCapture.mockRejectedValueOnce(new Error('ssh-keygen exited 1'));
    await expect(generateDeployKeyPair('ninedeploy@x')).rejects.toThrow(/ssh-keygen exited 1/);
  });
});

/**
 * Sanity check: if the host has `ssh-keygen` (typical for any Linux/macOS dev
 * machine), the library actually runs it end-to-end. Skipped on platforms
 * without the binary — this is a developer-machine convenience test, not a
 * CI gate.
 */
describe('generateDeployKeyPair (real ssh-keygen, dev-only)', () => {
  it('produces a valid OpenSSH key pair when ssh-keygen is on PATH', async () => {
    // Probe: is ssh-keygen available at all?
    let available = false;
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('ssh-keygen', ['-V'], { stdio: 'ignore' });
      available = true;
    } catch {
      available = false;
    }
    if (!available) return; // skip silently on Windows / minimal CI images
    const pair = await generateDeployKeyPair('ninedeploy@test');
    expect(pair.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/);
    expect(pair.publicKey).toMatch(/^ssh-ed25519 /);
    // The fingerprint is the second whitespace-separated token of `ssh-keygen -lf`,
    // not the last (the last is the type tag in parentheses).
    expect(pair.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/=]+$/);
  });
});
