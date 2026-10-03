import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rootFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const workflowDir = new URL('../../../.github/workflows/', import.meta.url);

/**
 * Supply-chain regressions (L-14, L-15). Both findings are about code this
 * project causes to run without being able to say what it was: unpinned
 * third-party Actions inside CI, and vendor scripts piped into a root shell by
 * the installer.
 */

describe('L-14: GitHub Actions are pinned to immutable commits', () => {
  const workflows = readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  it('has workflows to check', () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  it.each(workflows)('%s pins every third-party action to a 40-hex SHA', (file) => {
    const body = readFileSync(new URL(file, workflowDir), 'utf8');
    const uses = [...body.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) {
      // A local composite action (./.github/…) has no upstream to pin.
      if (ref.startsWith('./')) continue;
      expect(ref, `${file}: ${ref}`).toMatch(/^[\w.-]+\/[\w.-]+(\/[\w.-]+)*@[0-9a-f]{40}$/);
    }
  });

  it.each(workflows)('%s states its token permissions instead of inheriting them', (file) => {
    expect(readFileSync(new URL(file, workflowDir), 'utf8')).toMatch(/^permissions:/m);
  });
});

describe('L-15: the installer never pipes remote code into a root shell', () => {
  const installer = rootFile('install.sh');

  it('has no `curl … | sudo sh` / `| sudo bash` construct left', () => {
    const lines = installer.split('\n').filter((l) => !l.trimStart().startsWith('#'));
    for (const line of lines) {
      expect(line, line).not.toMatch(/curl[^|]*\|\s*sudo\s+(sh|bash)/);
      expect(line, line).not.toMatch(/curl[^|]*\|\s*(sh|bash)\b/);
    }
  });

  it('installs Docker and Node from signature-verified APT repositories', () => {
    expect(installer).toContain('install_docker_apt');
    expect(installer).toContain('install_node_apt');
    // apt verifies the packages against a key pinned into /etc/apt/keyrings
    expect(installer).toContain('/etc/apt/keyrings');
    expect(installer).toMatch(/signed-by=/);
    // install.sh interpolates the distro id at install time; the literal
    // shell placeholder must survive into the pinned keyring URL.
    expect(installer).toContain(`https://download.docker.com/linux/\${id}/gpg`);
    expect(installer).toContain('https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key');
  });

  it('makes the script fallback visible, consented and non-silent', () => {
    expect(installer).toContain('run_vendor_script');
    // it must download to a file, digest it and show both before running
    expect(installer).toMatch(/sha256sum "\$stage\/setup\.sh"/);
    expect(installer).toContain('About to run an UNVERIFIED vendor script as root');
    expect(installer).toContain('NINEDEPLOY_ALLOW_UNVERIFIED_INSTALL_SCRIPTS');
    // non-interactive runs (the piped-installer case) must refuse by default
    expect(installer).toContain('Refusing (non-interactive)');
  });

  it('still verifies the artifacts it downloads directly', () => {
    // The pre-existing good pattern must not have regressed.
    expect(installer).toContain('Nixpacks checksum verification failed');
    expect(installer).toContain('Traefik release checksum verification failed');
    // r702: and NineDeploy's own release archive, against its SHA256SUMS.
    expect(installer).toContain('fail "Checksum mismatch for $_asset');
  });

  it('r703: the panel never runs an installer it could not checksum', () => {
    // The self-update used to run raw.githubusercontent.com's install.sh as
    // root after a shebang + `bash -n` check only.
    const selfUpdate = rootFile('apps/server/src/lib/selfUpdate.ts');
    expect(selfUpdate).not.toContain('https://raw.githubusercontent.com');
    expect(selfUpdate).toContain('releases/download/$ND_SELF_UPDATE_TARGET');
    expect(selfUpdate).toContain('[ "$got" = "$want" ] ||');
  });
});
