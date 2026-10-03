import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture } from './exec.js';

export interface GeneratedKeyPair {
  /**
   * OpenSSH private key in `-----BEGIN OPENSSH PRIVATE KEY-----` PEM form.
   * Stored as-is (newline-stripped at the boundary so it fits the existing
   * `deployKeyEncrypted` text column).
   */
  privateKey: string;
  /** OpenSSH public key, one line: `ssh-ed25519 AAAA… comment`. */
  publicKey: string;
  /** Colon-separated SHA-256 fingerprint as printed by `ssh-keygen -lf`. */
  fingerprint: string;
}

/**
 * Generate a fresh ed25519 deploy-key pair via `ssh-keygen`.
 *
 * Workflow:
 *   1. Create an isolated `mkdtemp` working directory, mode 0700.
 *   2. Run `ssh-keygen -t ed25519 -f ./id_ed25519 -N "" -C <comment> -q`.
 *   3. Read the private + public key, fingerprint.
 *   4. `rmSync({ recursive, force })` the temp dir — keys live only in this scope.
 *
 * The comment makes the key recognisable in `~/.ssh/known_hosts` review
 * ("ninedeploy@github-personal" is a clearer audit trail than the default
 * `root@host`).
 */
export async function generateDeployKeyPair(comment: string): Promise<GeneratedKeyPair> {
  if (!/^[\w.@:-]+$/.test(comment)) {
    // ssh-keygen's comment flag is positional and permits a wide range of
    // characters; we restrict it so it cannot inject new args or break the
    // `ssh-keygen -C "<comment>"` shell-token assumption.
    throw new Error(`Invalid SSH key comment: ${JSON.stringify(comment)}`);
  }
  const work = mkdtempSync(join(tmpdir(), 'nd-sshkey-'));
  let cleanup = () => {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ }
  };
  try {
    const privPath = join(work, 'id_ed25519');
    const pubPath = `${privPath}.pub`;
    await capture('ssh-keygen', [
      '-t', 'ed25519',
      '-f', privPath,
      '-N', '',          // no passphrase — the private key is itself encrypted at rest by AES-256-GCM
      '-C', comment,
      '-q',              // quiet: skip the progress UI / fingerprint banner
    ]);
    const privateKey = readFileSync(privPath, 'utf8').trim();
    const publicKey = readFileSync(pubPath, 'utf8').trim();
    // `ssh-keygen -lf` prints the fingerprint to stdout, "SHA256:..." form.
    // The trailing token is the comment/key-type tag in parentheses (e.g.
    // "(ED25519)"), so the fingerprint is the second whitespace-separated
    // field, not the last one.
    const fingerprintOut = await capture('ssh-keygen', ['-lf', privPath]);
    const fingerprint = fingerprintOut.trim().split(/\s+/)[1] ?? '';
    cleanup();
    // Prevent the best-effort cleanup from running twice (no-op, but cleaner).
    cleanup = () => {};
    return { privateKey, publicKey, fingerprint };
  } finally {
    cleanup();
  }
}
