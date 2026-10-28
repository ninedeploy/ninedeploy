import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { fixtureBash, fixtureBashPath } from './bashFixture.js';

/**
 * G4.1: install.sh's distribution detection and its package-manager branches.
 * os_family and docker_rpm_repo_url run for real (the r576 source-only mode)
 * against os-release files copied from the images they were checked on
 * (Debian 12, Ubuntu 24.04, Rocky 9, Alma 9, CentOS Stream 9, Oracle 9,
 * Fedora 41, Alpine 3.20, Amazon Linux 2023, openSUSE Leap 15.6). The install
 * paths themselves were run in those images; here their wiring is pinned.
 */
const installerPath = new URL('../../../install.sh', import.meta.url);
const installer = readFileSync(installerPath, 'utf8');
const bash = fixtureBash(spawnSync);
const bashOk = spawnSync(bash, ['-c', 'true']).status === 0;
const toBash = (p: string) => fixtureBashPath(spawnSync, p, bash);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const OS_RELEASE: Record<string, string> = {
  'debian-12': 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n',
  'ubuntu-24.04': 'PRETTY_NAME="Ubuntu 24.04.5 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n',
  'rocky-9': 'NAME="Rocky Linux"\nVERSION_ID="9.8"\nID="rocky"\nID_LIKE="rhel centos fedora"\n',
  'alma-9': 'NAME="AlmaLinux"\nVERSION_ID="9.6"\nID="almalinux"\nID_LIKE="rhel centos fedora"\n',
  'centos-stream-9': 'NAME="CentOS Stream"\nVERSION_ID="9"\nID="centos"\nID_LIKE="rhel fedora"\n',
  'oracle-9': 'NAME="Oracle Linux Server"\nVERSION_ID="9.6"\nID="ol"\nID_LIKE="fedora"\n',
  'rhel-9': 'NAME="Red Hat Enterprise Linux"\nVERSION_ID="9.6"\nID="rhel"\nID_LIKE="fedora"\n',
  'fedora-41': 'NAME="Fedora Linux"\nVERSION_ID=41\nID=fedora\n',
  'alpine-3.20': 'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.20.8\n',
  'amazon-2023': 'NAME="Amazon Linux"\nVERSION_ID="2023"\nID="amzn"\nID_LIKE="fedora"\n',
  'opensuse-15.6': 'NAME="openSUSE Leap"\nVERSION_ID="15.6"\nID="opensuse-leap"\nID_LIKE="suse opensuse"\n',
};

function family(name: string): { family: string; repo: string } {
  const dir = mkdtempSync(join(tmpdir(), 'nd-osrel-'));
  dirs.push(dir);
  const file = join(dir, 'os-release');
  writeFileSync(file, OS_RELEASE[name]!);
  const id = /^ID="?([^"\n]+)"?$/m.exec(OS_RELEASE[name]!)![1]!;
  const res = spawnSync(
    bash,
    ['-c', 'NINEDEPLOY_INSTALL_SOURCE_ONLY=1 . "$1"; f="$(os_family "$2")"; printf "%s|%s" "$f" "$(docker_rpm_repo_url "$f" "$3" || true)"', 'x', toBash(fileURLToPath(installerPath)), toBash(file), id],
    { encoding: 'utf8' },
  );
  expect(res.status, res.stderr).toBe(0);
  const [f = '', repo = ''] = res.stdout.split('|');
  return { family: f, repo };
}

describe.skipIf(!bashOk)('install.sh distribution detection (G4.1)', () => {
  it.each([
    ['debian-12', 'debian', ''],
    ['ubuntu-24.04', 'debian', ''],
    ['rocky-9', 'rhel', 'https://download.docker.com/linux/centos/docker-ce.repo'],
    ['alma-9', 'rhel', 'https://download.docker.com/linux/centos/docker-ce.repo'],
    ['centos-stream-9', 'rhel', 'https://download.docker.com/linux/centos/docker-ce.repo'],
    ['oracle-9', 'rhel', 'https://download.docker.com/linux/centos/docker-ce.repo'],
    ['rhel-9', 'rhel', 'https://download.docker.com/linux/rhel/docker-ce.repo'],
    ['fedora-41', 'fedora', 'https://download.docker.com/linux/fedora/docker-ce.repo'],
    ['alpine-3.20', 'alpine', ''],
    // Not claimed: Docker's RPM repository does not serve Amazon Linux; SUSE comes later.
    ['amazon-2023', 'unknown', ''],
    ['opensuse-15.6', 'unknown', ''],
  ])('%s → %s', (name, expected, repo) => {
    expect(family(name)).toEqual({ family: expected, repo });
  });

  it('answers unknown for a host without os-release', () => {
    const res = spawnSync(bash, ['-c', 'NINEDEPLOY_INSTALL_SOURCE_ONLY=1 . "$1"; os_family /nonexistent/os-release', 'x', toBash(fileURLToPath(installerPath))], { encoding: 'utf8' });
    expect(res.stdout.trim()).toBe('unknown');
  });
});

describe('install.sh package-manager branches (G4.1)', () => {
  const fn = (name: string) => {
    const start = installer.indexOf(`\n${name}() {`);
    expect(start, name).toBeGreaterThan(-1);
    return installer.slice(start, installer.indexOf('\n}\n', start));
  };

  it('installs with apt, dnf or apk by family', () => {
    const body = fn('pkg_install');
    expect(body).toContain('debian) run_apt_step apt-get install -y "$@"');
    expect(body).toContain('rhel|fedora) run_quiet_step "dnf install $*" sudo dnf -y install "$@"');
    expect(body).toContain('alpine) run_quiet_step "apk add $*" sudo apk add --no-cache "$@"');
  });

  it('takes Node and Docker from signed RPM repositories on dnf hosts', () => {
    const node = fn('install_node_rpm');
    expect(node).toContain('gpgcheck=1');
    expect(node).toContain('baseurl=https://rpm.nodesource.com/pub_${major}.x/nodistro/nodejs/${arch}');
    const docker = fn('install_docker_rpm');
    expect(docker).toContain('docker_rpm_repo_url "$family" "$id"');
    expect(docker).toContain('docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin');
    expect(fn('install_docker_apk')).toContain('rc-update add docker default');
  });

  it('sends a host without systemd to the Docker mode, and refuses bare-metal there when asked for', () => {
    expect(installer).toContain('The bare-metal mode needs systemd, which this host does not have. Install with --docker instead.');
    expect(installer).toContain('This host has no systemd: installing in Docker mode');
  });

  it('works with BusyBox flock (no -w) and a root shell without sudo', () => {
    expect(installer).toContain("if flock --help 2>&1 | grep -q -- '--wait'; then");
    expect(installer).toMatch(/if \[ "\$\(id -u\)" -eq 0 \] && ! command -v sudo >\/dev\/null 2>&1; then\n {2}sudo\(\) \{/);
  });
});
