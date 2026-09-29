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
    expect(compose).toMatch(/image:\s*ghcr\.io\/ninedeploy\/ninedeploy:latest/);
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
    expect(sh).toContain('docker_cmd start "$_old_cid" 2>/dev/null || true');
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
