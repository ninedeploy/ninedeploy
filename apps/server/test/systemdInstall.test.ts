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
    // r574: that refusal is only reachable when the table is keyed by
    // VERSION — an arch-only table handed an overridden version the 1.41.0
    // digest, and the run died on a generic checksum mismatch instead.
    const start = installer.indexOf('nixpacks_sha256() {');
    const table = installer.slice(start, installer.indexOf('\n}\n', start));
    expect(table).toContain('case "$1:$2" in');
    expect(table).toMatch(/^\s*1\.41\.0:x86_64\)/m);
    expect(table).toMatch(/^\s*1\.41\.0:aarch64\)/m);
    expect(table).toMatch(/^\s*\*\) printf '' ;;/m);
    expect(installer).toContain('NIXPACKS_SHA256="$(nixpacks_sha256 "$NIXPACKS_VERSION" x86_64)"');
    expect(installer).toContain('NIXPACKS_SHA256="$(nixpacks_sha256 "$NIXPACKS_VERSION" aarch64)"');
    expect(installer).not.toContain('NIXPACKS_SHA_AMD64_x86_64');
    // The empty-digest refusal precedes the download.
    const install = installer.slice(installer.indexOf('install_nixpacks() {'));
    expect(install.indexOf('if [ -z "$NIXPACKS_SHA256" ]; then')).toBeLessThan(install.indexOf('curl -fsSL'));
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

  it('r357: a failed tarball upgrade rolls back to the previous release (and its database) before restarting', () => {
    const installer = rootFile('install.sh');
    const at = (needle: string, from = 0) => {
      const i = installer.indexOf(needle, from);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    const body = (name: string) => {
      const start = at(`\n${name}() {`);
      return installer.slice(start, at('\n}\n', start));
    };

    // The old tree is set aside (renamed, not copied) BEFORE the tarball path
    // deletes or overwrites anything; the git path never touches it.
    const release = body('upgrade_from_release');
    expect(release.indexOf('prepare_upgrade_rollback "$_stage"')).toBeGreaterThan(release.indexOf('fetch_release_tarball'));
    expect(release.indexOf('prepare_upgrade_rollback "$_stage"')).toBeLessThan(release.indexOf('rm -rf "${INSTALL_DIR:?}/$_d"'));
    expect(release.indexOf('prepare_upgrade_rollback "$_stage"')).toBeLessThan(release.indexOf('tar -cf - --exclude=./install.sh'));
    expect(body('update_from_git')).not.toMatch(/rollback/i);
    const take = body('rollback_take_entry');
    expect(take).toContain('mv "$_src" "$ROLLBACK_DIR/old/$_name"');
    expect(take).toContain('[ "$(path_device "$_src")" = "$(path_device "$ROLLBACK_DIR")" ] || return 1');
    for (const keep of ['.env', '.data', '.git']) expect(take).toMatch(new RegExp(`\\|${keep.replace('.', '\\.')}\\|`));
    const prepare = body('prepare_upgrade_rollback');
    expect(prepare).toContain('for _p in node_modules apps packages');
    // Armed (and the trap installed) before the first rename.
    expect(prepare.indexOf('trap restore_service_on_exit EXIT')).toBeLessThan(prepare.indexOf('rollback_take_entry'));

    // The trap rolls back first, then r262 starts the unit, then the failed
    // tree is deleted. An armed rollback is acted on regardless of $? (bash
    // reports 0 in an EXIT trap after SIGTERM).
    const trap = body('restore_service_on_exit');
    expect(trap.indexOf('rollback_failed_upgrade "$_rc" || true')).toBeLessThan(trap.indexOf('start_service_after_failed_upgrade "$_rc"'));
    expect(trap.indexOf('start_service_after_failed_upgrade "$_rc"')).toBeLessThan(trap.indexOf('rm -rf "${ROLLBACK_DISCARD:?}"'));
    expect(trap).not.toMatch(/_rc"? -eq 0/);

    // Database: migrations are flagged right before they run; past that point
    // the snapshot is restored before the old code goes back, and without a
    // snapshot covering the live DB the code is NOT rolled back.
    expect(installer).toMatch(/DB_MIGRATION_STARTED=true\npnpm db:migrate/);
    expect(at('DB_MIGRATION_STARTED=true')).toBeGreaterThan(at('. ./.env'));
    expect(installer).toContain('[ "${BACKUP_OK:-false}" = true ] && [ "$_r357_db_path" = "$INSTALL_DIR/.data/ninedeploy.db" ]');
    const rollback = body('rollback_failed_upgrade');
    expect(rollback.indexOf('DB_BACKUP_COVERS_MIGRATION')).toBeLessThan(rollback.indexOf('restore_pre_upgrade_database'));
    expect(rollback.indexOf('restore_pre_upgrade_database')).toBeLessThan(rollback.indexOf('rollback_upgrade_tree'));
    // A migrated database's WAL must never be replayed over the snapshot.
    expect(body('restore_pre_upgrade_database')).toContain('ninedeploy.db ninedeploy.db-wal ninedeploy.db-shm ninedeploy.db-journal');

    // Disarmed at the section-5 restart; the copy is dropped once healthy.
    expect(installer).toMatch(/SERVICE_STOPPED_BY_UPGRADE=false\n(?:\s*#.*\n)*\s*ROLLBACK_ARMED=false/);
    expect(at('prune_upgrade_rollbacks\n', at('ok "NineDeploy service is healthy'))).toBeLessThan(at('TRAEFIK_RUNNING='));
    expect(rootFile('.gitignore')).toContain('.upgrade-rollback-*/');
  });

  it('r263: --docker targets the lowercase GHCR image and pulls the pinned version tag', () => {
    const installer = rootFile('install.sh');
    const compose = rootFile('docker-compose.prod.yml');
    // r571: the tag is a variable the installer pins in .env; `:latest` only as the fallback.
    expect(compose).toMatch(/image:\s*ghcr\.io\/ninedeploy\/ninedeploy:\$\{NINEDEPLOY_IMAGE_TAG:-latest\}/);
    expect(installer).toContain(`IMAGE_REPO="$(printf '%s' "$REPO_SLUG" | tr '[:upper:]' '[:lower:]')"`);
    // No image reference may be built from the mixed-case GitHub slug.
    expect(installer).not.toMatch(/ghcr\\?\.io\/\$\{REPO_SLUG/);
    expect(installer).toMatch(/if \[ -n "\$PINNED_VERSION" \]; then\n\s*IMAGE_TAG="\$PINNED_VERSION"/);
  });
});

// ── r447–r452: docker-mode upgrade safety + env hygiene ────────────────
describe('docker-mode upgrade safety (r447–r452)', () => {
  const installer = () => rootFile('install.sh');

  it('r447: a failed compose up -d restarts the previous container (docker mode finally gets the r087 treatment)', () => {
    const sh = installer();
    // The old container id is captured BEFORE the recreate…
    expect(sh).toContain('_old_cid="$(docker_cmd compose ps -q ninedeploy 2>/dev/null || true)"');
    // …and started again only when the new one is not running.
    expect(sh).toContain('if docker_cmd start "$_old_cid" >/dev/null 2>&1; then');
    // The old unconditional one-liner is gone.
    expect(sh).not.toContain('docker_cmd compose up -d \\n    || { docker_cmd compose logs --tail 50 2>/dev/null || true; fail "docker compose up failed"; }');
  });

  it('r448: an operator-set NINEDEPLOY_PORT survives a re-run without the env var', () => {
    const sh = installer();
    // Read back from .env first, env override second, default last — the JWT
    // secret pattern. The old unconditional clobber is gone.
    expect(sh).not.toContain('upsert_env NINEDEPLOY_PORT "${NINEDEPLOY_PORT:-3000}"');
    expect(sh).toContain(`panel_port="$(sed -n 's/^NINEDEPLOY_PORT=//p' .env | tail -1)"`);
    expect(sh).toContain('[ -n "${NINEDEPLOY_PORT:-}" ] && panel_port="$NINEDEPLOY_PORT"');
    expect(sh).toContain('upsert_env NINEDEPLOY_PORT "$panel_port"');
  });

  it('r449: upsert_env never interpolates values through a sed replacement', () => {
    const sh = installer();
    // The docker-mode upsert_env took RAW env values (JWT secret, DNS token)
    // through a sed replacement — `&`/`|`/backslashes corrupted .env. The
    // bare-metal seds stay: their inputs are literals, generated hex, or
    // email-regex-validated.
    expect(sh).not.toContain('sed -i.bak "s|^$1=.*|$1=$2|" .env');
    expect(sh).toContain('grep -v "^$1=" .env');
    // Written with printf (append semantics), never through a sed replacement.
    expect(sh.indexOf('_tmp="$(mktemp)"')).toBeGreaterThan(sh.indexOf('upsert_env() {'));
  });

  it('r451: .data is created private (the DB, repos and PM2 dump live there)', () => {
    expect(installer()).toContain('install -d -m 0750 .data');
  });

  it('r451: NINEDEPLOY_BIND is persisted when the operator provides it', () => {
    expect(installer()).toContain('NINEDEPLOY_BIND=%s');
    expect(installer()).toContain("grep -q '^NINEDEPLOY_BIND=' .env");
  });

  it('r450: the git upgrade path warns about its missing rollback point BEFORE the tree swap', () => {
    const sh = installer();
    const warnAt = sh.indexOf('The git upgrade path has no automatic code rollback');
    const callAt = sh.indexOf('update_from_git "$REF"');
    expect(warnAt).toBeGreaterThan(-1);
    expect(warnAt).toBeLessThan(callAt);
  });

  it('r452: refuses to re-point the live install at a different clone', () => {
    const sh = installer();
    expect(sh).toContain(`sed -n 's/^WorkingDirectory=//p' "$BARE_METAL_UNIT_FILE" | tail -1`);
    expect(sh).toContain('orphan the existing data');
  });
});

// ── r457–r460: installer P3 sweep ───────────────────────────────────────
describe('installer P3 sweep (r457–r460)', () => {
  const installer = () => rootFile('install.sh');

  it('r457: fstab swap persistence ignores commented lines', () => {
    expect(installer()).not.toContain("grep -q '/swapfile' /etc/fstab");
    expect(installer()).toContain("grep -Eq '^[^#]*/swapfile' /etc/fstab");
  });

  it('r458: the docker health gate probes the bound address, not hardcoded loopback', () => {
    const sh = installer();
    expect(sh).toContain(`HEALTH_HOST="$(sed -n 's/^NINEDEPLOY_BIND=//p' .env | tail -1)"`);
    expect(sh).toContain('case "$HEALTH_HOST" in ""|0.0.0.0|127.0.0.1|localhost) HEALTH_HOST="127.0.0.1" ;; esac');
    expect(sh).toContain('"http://${HEALTH_HOST}:${HEALTH_PORT}/health"');
  });

  it('r459: a no-systemd UPGRADE warns that the old code is still running', () => {
    const sh = installer();
    expect(sh).toContain('still executes the OLD code');
    expect(sh).toContain('restart it manually now');
  });

  it('r460: pre-update snapshots are pruned to the newest five', () => {
    const sh = installer();
    expect(sh).toContain('tail -n +6');
    expect(sh).toContain('pre-update-*.tar.gz');
  });

  it('r458: GitHub API fallbacks and the compose fetch retry like the tarball fetch', () => {
    const sh = installer();
    const retryApi = sh.match(/curl -fsSL -m 15 --retry 3 --retry-delay 2 -H 'Accept: application\/vnd\.github\+json'/g) ?? [];
    expect(retryApi).toHaveLength(2);
    expect(sh).toContain('--retry 3 --retry-delay 2 "https://raw.githubusercontent.com/NineDeploy/NineDeploy/${REF}/docker-compose.prod.yml"');
  });
});

// ── r570–r576: 0.10.36 install/upgrade path ────────────────────────────
describe('install/upgrade path (r570–r576)', () => {
  const installer = () => rootFile('install.sh');
  const at = (sh: string, needle: string, from = 0) => {
    const i = sh.indexOf(needle, from);
    expect(i, needle).toBeGreaterThanOrEqual(0);
    return i;
  };
  const body = (sh: string, name: string) => {
    const start = at(sh, `\n${name}() {`);
    return sh.slice(start, at(sh, '\n}\n', start));
  };

  it('r571: the release channel asks the releases API first and git ls-remote last', () => {
    const fn = body(installer(), 'latest_tag');
    const releases = at(fn, '/releases/latest');
    const tags = at(fn, '/tags?per_page=100');
    const lsRemote = at(fn, 'git ls-remote --tags --refs');
    expect(releases).toBeLessThan(tags);
    expect(tags).toBeLessThan(lsRemote);
    // Diagnostics go to stderr: `REF=$(latest_tag)` captures stdout, and a
    // warning there used to become part of the resolved ref.
    for (const line of fn.split('\n').filter((l) => l.includes('warn '))) expect(line).toMatch(/>&2\s*$/);
  });

  it('r571: docker mode pins the image to the resolved tag in the 0600 .env, keeping the one-image check', () => {
    const sh = installer();
    const fn = body(sh, 'docker_image_tag');
    // pinned > edge (main channel) > resolved release tag > latest
    expect(at(fn, 'if [ -n "$1" ]; then')).toBeLessThan(at(fn, '[ "$2" = "main" ]'));
    expect(at(fn, '[ "$2" = "main" ]')).toBeLessThan(at(fn, "grep -Eq '^v[0-9]+\\.[0-9]+\\.[0-9]+$'"));
    expect(fn).toContain("printf 'latest'");
    expect(sh).toContain('IMAGE_TAG="$(docker_image_tag "" "$CHANNEL" "$REF")"');
    expect(sh).toContain('upsert_env NINEDEPLOY_IMAGE_TAG "$IMAGE_TAG"');
    // The shell env must not override the .env value compose reads.
    expect(at(sh, 'unset NINEDEPLOY_IMAGE_TAG')).toBeLessThan(at(sh, 'docker_cmd compose pull'));
    // The compose file still names exactly one image, ours, so the installer's
    // provenance check (one `image:` line, ghcr.io/<repo>:) keeps passing.
    const compose = rootFile('docker-compose.prod.yml');
    expect(compose.match(/^\s*image:\s*/gm)).toHaveLength(1);
    expect(compose).toMatch(/image:\s*ghcr\.io\/ninedeploy\/ninedeploy:/);
    // Legacy compose files (a pinned older release) are still rewritten in place.
    expect(sh).toContain('sed -i.bak "s|ghcr.io/${IMAGE_REPO}:latest|ghcr.io/${IMAGE_REPO}:${IMAGE_TAG}|"');
  });

  it('r570: a failed docker recreate restores the previous release even after compose removed its container', () => {
    const sh = installer();
    // The previous compose file + .env are kept (0700) before either is replaced…
    const keep = at(sh, 'cp -p "$DOCKER_INSTALL_DIR/docker-compose.yml" "$DOCKER_ROLLBACK_DIR/docker-compose.yml"');
    expect(keep).toBeLessThan(at(sh, 'mv "$DOCKER_INSTALL_DIR/docker-compose.yml.new" "$DOCKER_INSTALL_DIR/docker-compose.yml"'));
    expect(sh).toContain('(umask 077 && mkdir -p "$DOCKER_ROLLBACK_DIR")');
    // …the old container's immutable image id is captured before the recreate…
    expect(at(sh, `_old_image="$(docker_cmd inspect --format '{{.Image}}' "$_old_cid"`)).toBeLessThan(at(sh, 'if ! docker_cmd compose up -d; then'));
    // …and when the container is gone, the previous files come back and the
    // old image is re-tagged under the reference they name, then recreated.
    const rbStart = at(sh, '\n  docker_rollback_panel() {');
    const rb = sh.slice(rbStart, at(sh, '\n  }\n', rbStart));
    expect(at(rb, 'docker_cmd start "$_old_cid"')).toBeLessThan(at(rb, 'docker_restore_previous_files || return 1'));
    expect(at(rb, 'docker_restore_previous_files || return 1')).toBeLessThan(at(rb, 'compose config --images'));
    expect(at(rb, 'docker_cmd tag "$_old_image" "$_prev_ref"')).toBeLessThan(at(rb, 'docker_cmd compose up -d'));
    // A failed pull/manifest check also puts the previous files back.
    expect(sh).toMatch(/if ! docker_cmd compose pull; then\n\s*docker_restore_previous_files \|\| true/);
    // Healthy: the copy (it holds the secrets) is removed.
    expect(at(sh, 'rm -rf "${DOCKER_ROLLBACK_DIR:?}"', at(sh, 'NineDeploy panel is healthy'))).toBeGreaterThan(0);
  });

  it('r570: the health gates wait for boot migrations (docker) and probe the bound address (bare metal)', () => {
    const sh = installer();
    expect(sh).toContain('DOCKER_HEALTH_TIMEOUT="${NINEDEPLOY_HEALTH_TIMEOUT:-300}"');
    expect(sh).toContain('for _i in $(seq 1 "$DOCKER_HEALTH_TIMEOUT"); do');
    expect(sh).toContain('PANEL_PROBE_HOST="${NINEDEPLOY_HOST:-0.0.0.0}"');
    expect(sh).toContain('""|0.0.0.0|::|"[::]"|127.0.0.1|localhost) PANEL_PROBE_HOST="127.0.0.1" ;;');
    expect(sh).toContain('curl -fsS -m 2 "http://${PANEL_PROBE_HOST}:${HEALTH_PORT}/health"');
    expect(sh).not.toContain('curl -fsS -m 2 "http://127.0.0.1:${HEALTH_PORT}/health"');
  });

  it('r570: a corepack-managed pnpm never blocks the self-update on a download prompt', () => {
    const sh = installer();
    expect(at(sh, 'export COREPACK_ENABLE_DOWNLOAD_PROMPT=0')).toBeLessThan(at(sh, 'run_quiet_step "pnpm install" pnpm install --frozen-lockfile'));
  });

  it('r574: apache2/nginx are stopped only on a fresh install, and only when they hold :80/:443', () => {
    const sh = installer();
    const block = sh.slice(at(sh, 'web_ports_holder() {'), at(sh, '# Host Firewall (UFW on Linux)'));
    expect(block).toContain('_fresh_host=true');
    expect(block).toContain('if bare_metal_present || docker_install_present; then _fresh_host=false; fi');
    // The stop is guarded by BOTH conditions…
    const stop = at(block, 'sudo systemctl stop "$_web_svc"');
    const guard = block.lastIndexOf('if [ "$_fresh_host" = true ] && [ "$_holder_rc" -eq 0 ]; then', stop);
    expect(guard).toBeGreaterThan(-1);
    expect(block.slice(guard, stop)).not.toMatch(/\n\s*(elif|else|fi)\b/);
    // …and names the service it stops; no unconditional stop is left.
    expect(block).toContain('warn "$_web_svc is listening on port 80/443, which the Traefik ingress needs');
    expect(sh).not.toContain('sudo systemctl stop apache2');
    expect(sh).not.toContain('sudo systemctl stop nginx');
  });

  it('r574: the tarball check claims only what it verifies', () => {
    const sh = installer();
    expect(sh).not.toContain('tampered archive fails here');
    expect(sh).toContain('those checks alone do NOT prove\n  # authenticity');
    // r702: the authenticity those checks lack now comes from SHA256SUMS
    // (and its signature) — the old "not verified yet" claim is gone.
    expect(sh).not.toContain('which this installer does not verify yet');
    expect(sh).toContain('the archive is byte-for-byte the one SHA256SUMS lists (fail-closed)');
  });

  it('r576: a source-only mode exposes the pure helpers to CI, and only when sourced', () => {
    const sh = installer();
    const guard = at(sh, 'if [ "${NINEDEPLOY_INSTALL_SOURCE_ONLY:-}" = "1" ] && (return 0 2>/dev/null); then');
    // Every helper CI exercises is defined before the guard; nothing that
    // touches the host (banner, flock, apt, docker) runs before it.
    for (const fn of [
      'highest_semver_tag', 'release_tag_from_json', 'highest_tag_from_tags_json', 'latest_tag', 'docker_image_tag', 'nixpacks_sha256', 'resolve_data_dir',
      // r702: the release-integrity helpers CI and release-publish.yml source.
      'semver_key', 'release_has_checksums', 'release_archive_name', 'release_asset_url', 'sha256sums_lookup', 'verify_checksums_signature',
    ]) {
      expect(at(sh, `\n${fn}() {`), fn).toBeLessThan(guard);
    }
    for (const effect of ['NineDeploy Installer', 'flock -w', 'Installing base system packages', 'docker_cmd network create']) {
      expect(at(sh, effect), effect).toBeGreaterThan(guard);
    }
    // CI sources the real script instead of re-typing its lines.
    const ci = rootFile('.github/workflows/ci.yml');
    expect(ci).toContain('NINEDEPLOY_INSTALL_SOURCE_ONLY=1 . ./install.sh');
    expect(ci).toContain('resolve_data_dir "$scratch"');
    // r702: the smoke exercises the checksum parsing and the checksum era
    // with fixtures — including a real `sha256sum` round trip.
    expect(ci).toContain('sha256sums_lookup ninedeploy-v0.10.43.tar.gz');
    expect(ci).toContain('sha256sums_lookup a.tar.gz < "$scratch/SHA256SUMS"');
    expect(ci).toContain('if release_has_checksums v0.10.42 || release_has_checksums v0.9.99 || release_has_checksums main; then exit 1; fi');
    expect(ci).toContain('verify_checksums_signature "$scratch/SHA256SUMS" "$scratch/none.json"');
    expect(ci).not.toContain('DATA_DIR_SETTING="${NINEDEPLOY_DATA_DIR:-$INSTALL_DIR/.data}"');
    // The systemd step uses the same helper the smoke test runs.
    expect(sh).toContain('DATA_DIR=$(resolve_data_dir "$INSTALL_DIR")');
  });
});
