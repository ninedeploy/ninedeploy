import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rootFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

describe('bare-metal systemd installation policy', () => {
  it('ships a simple service with watchdog supervision explicitly disabled', () => {
    const unit = rootFile('systemd/ninedeploy.service');

    expect(unit).toMatch(/^Type=simple$/m);
    expect(unit).toMatch(/^WatchdogSec=0$/m);
    expect(unit).not.toMatch(/^Type=notify$/m);
    expect(unit).toMatch(/^User=root$/m);
    expect(unit).toMatch(/^Group=root$/m);
  });

  it('migrates stale watchdog installations and verifies effective settings', () => {
    const installer = rootFile('install.sh');

    expect(installer).toContain('zzzz-ninedeploy-runtime-safety.conf');
    expect(installer).toContain('DATA_DIR=$(cd "$DATA_DIR_SETTING" && pwd -P)');
    expect(installer).toContain("'Type=simple'");
    expect(installer).toContain("'WatchdogSec=0'");
    expect(installer).toContain('EFFECTIVE_TYPE=$(systemctl show ninedeploy --property=Type --value)');
    expect(installer).toContain('EFFECTIVE_WATCHDOG=$(systemctl show ninedeploy --property=WatchdogUSec --value)');
  });

  it('does not retain the broken runtime sd_notify client', () => {
    expect(rootFile('apps/server/src/server.ts')).not.toContain('sdNotify');
    expect(rootFile('apps/server/src/agent.ts')).not.toContain('sdNotify');
  });

  it('reuses a verified Traefik image or falls back immediately without mutating Docker state', () => {
    const installer = rootFile('install.sh');

    expect(installer).toContain('traefik_image_usable');
    expect(installer).toContain('CONTAINERD_SNAPSHOT_DIR="$CONTAINERD_OVERLAY_ROOT/snapshots"');
    expect(installer).toContain('/var/lib/docker/containerd/daemon/io.containerd.snapshotter.v1.overlayfs');
    expect(installer).toContain('sudo install -d -o root -g root -m 0700 "$CONTAINERD_SNAPSHOT_DIR"');
    expect(installer).toContain('Containerd overlayfs snapshot directory restored');
    expect(installer).toContain('Existing Traefik v3 image verified; skipping registry pull');
    expect(installer).toContain('PULL_OUTPUT=$(docker_cmd pull traefik:3 2>&1)');
    expect(installer).toContain('switching immediately to the verified layer-free Traefik image');
    expect(installer).toContain('build_traefik_fallback_image');
    expect(installer).toContain('checksums.txt');
    expect(installer).toContain('ACTUAL_SHA=$(sha256sum');
    expect(installer).toContain("--change 'ENTRYPOINT [\"/traefik\"]'");
    expect(installer).toContain('docker_cmd run --rm traefik:3 version');
    expect(installer).not.toContain('sudo systemctl restart docker');
    expect(installer).not.toContain('docker image prune');
    expect(installer).not.toContain('ctr --namespace moby snapshots');
  });

  it('uses one elevated Docker command path and probes the real ingress entrypoint', () => {
    const installer = rootFile('install.sh');

    expect(installer).toContain('docker_cmd() { "$' + '{DOCKER[@]}" "$@"; }');
    expect(installer).toContain("-H 'Host: ninedeploy-install-check.invalid' http://127.0.0.1/");
    expect(installer).toContain('Traefik is running but its HTTP entrypoint on :80 is not responding');
  });

  it('installs a pinned and checksum-verified Nixpacks CLI instead of treating its base image as a CLI image', () => {
    const installer = rootFile('install.sh');
    const containerfile = rootFile('Dockerfile');

    // The installer accepts an override (NINEDEPLOY_NIXPACKS_VERSION) but defaults to the latest verified release.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: installer shell parameter expansion under test
    expect(installer).toContain('NIXPACKS_VERSION="${NINEDEPLOY_NIXPACKS_VERSION:-1.41.0}"');
    expect(installer).toContain('NIXPACKS_ACTUAL_SHA=$(sha256sum');
    expect(installer).toContain('sudo install -m 0755 "$NIXPACKS_STAGE/nixpacks" /usr/local/bin/nixpacks');
    expect(containerfile).toContain('ARG NIXPACKS_VERSION=1.41.0');
    expect(containerfile).toContain('echo "$' + '{NIXPACKS_SHA256}  /tmp/$' + '{NIXPACKS_ASSET}" | sha256sum -c -');
    expect(rootFile('apps/server/src/engine/builders/docker.ts')).not.toContain('ghcr.io/railwayapp/nixpacks:latest');
  });

  it('rejects an unknown Nixpacks version (defence-in-depth against tampered releases)', () => {
    const installer = rootFile('install.sh');
    // The installer must not silently download a release whose SHA-256 isn't
    // in its verified-checksum table — it has to fail with a clear message
    // so the operator knows to update the table after auditing GitHub.
    expect(installer).toContain('is not in the installer');
  });

  it('r261: only prompts on a terminal it can actually open (self-update has none)', () => {
    const installer = rootFile('install.sh');
    // Permission bits on /dev/tty are world-rw even with no controlling
    // terminal; the open itself fails (ENXIO) and set -e killed the upgrade.
    expect(installer).not.toContain('[ -r /dev/tty ] && [ -w /dev/tty ]');
    expect(installer).toContain('[ -z "$' + '{ND_SELF_UPDATE_TARGET:-}" ] && { : <>/dev/tty; } 2>/dev/null');
  });

  it('r262: an upgrade that dies after stopping the panel starts it again, and keeps a build to start', () => {
    const installer = rootFile('install.sh');
    const at = (needle: string) => {
      const i = installer.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    // Armed before the stop, disarmed only once the normal restart ran.
    expect(at('trap restore_service_on_exit EXIT')).toBeLessThan(at('sudo systemctl stop ninedeploy'));
    expect(at('sudo systemctl restart ninedeploy\n  # r262')).toBeGreaterThan(at('sudo systemctl stop ninedeploy'));
    expect(installer).toMatch(/sudo systemctl restart ninedeploy\n(?:\s*#.*\n)*\s*SERVICE_STOPPED_BY_UPGRADE=false/);
    // Previous dist/ is cleared only after dependencies installed.
    expect(at('rm -rf apps/*/dist packages/*/dist')).toBeGreaterThan(at('run_quiet_step "pnpm install" pnpm install --frozen-lockfile'));
    expect(at('rm -rf apps/*/dist packages/*/dist')).toBeLessThan(at('run_quiet_step "pnpm build" pnpm build'));
  });
});
