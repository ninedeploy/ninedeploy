#!/usr/bin/env bash
#
# NineDeploy — one-click installer
# https://github.com/NineDeploy/NineDeploy
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/NineDeploy/NineDeploy/main/install.sh | bash
#
# Or from a clone:
#   ./install.sh
#
# Deployment modes (the installer follows what is already installed):
#   --docker        panel runs as a Docker container (no Node.js/systemd/PM2
#                   on the host; Docker/Compose deploys, managed databases,
#                   Traefik ingress and S3 backups work identically)
#   --bare-metal    hardened systemd service with direct PM2 access (default
#                   for fresh non-interactive runs)
#   NINEDEPLOY_INSTALL_MODE=docker|bare-metal works too. With no flag, an
#   existing install decides the mode; on a fresh host with a terminal the
#   installer asks. Upgrades are the same command re-run.
#
# Version selection:
#   --channel release   newest vX.Y.Z tag on GitHub (default)
#   --channel main      track the main branch (edge)
#   --version vX.Y.Z    pin an exact tag
#   --force             discard local modifications to tracked files and drop
#                       every build artifact before rebuilding. Use this when
#                       an upgrade left a stale panel bundle behind.
#                       NINEDEPLOY_FORCE=1 works too.
#
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✓${NC}  $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
fail()  { echo -e "${RED}✗${NC}  $*"; exit 1; }

# ── Remote code policy (L-15) ──────────────────────────────────────────────
#
# This script installs Nixpacks and Traefik by downloading a pinned artifact
# and checking its SHA-256 before use. Docker and Node.js used to be different:
# both were fetched with `curl … | sudo sh`, i.e. whatever bytes the endpoint
# returned were executed as root, unverified, with no record of what ran. A
# compromised CDN, a hijacked domain or an attacker on the path between the
# host and the endpoint got root on the machine that holds every deployment
# secret on this instance.
#
# Those two now install from their vendors' APT repositories, whose packages
# are signed and verified by apt against a key pinned into
# /etc/apt/keyrings — the vendors' own documented method, and the one that
# gives the host a verifiable chain instead of a pipe.
#
# The setup script remains as a last-resort fallback, but it is no longer
# silent: it downloads to a file, prints the URL and the digest of exactly
# what it fetched, and refuses to run without consent.
allow_unverified_scripts() { [ "${NINEDEPLOY_ALLOW_UNVERIFIED_INSTALL_SCRIPTS:-}" = "1" ]; }

# ── Long-step visibility ─────────────────────────────────────────────────────
#
# Vendor installs (Node, Docker) push hundreds of MB through apt with their
# output discarded — from the operator's chair that is indistinguishable from
# a hung installer (a multi-minute "freeze" on a slow mirror). Stream apt's
# own progress lines (Get:/Unpacking/Setting up) live, with a heartbeat when
# nothing matched for a while. The exit code is the wrapped command's own.
run_apt_step() {
  local log offset new printed elapsed rc pid
  log=$(mktemp) || return 1
  offset=1
  elapsed=0
  printed=0
  # DEBIAN_FRONTEND=noninteractive: a conffile or debconf prompt would block
  # forever on the piped installer's non-terminal stdin. </dev/null enforces
  # the same guarantee for anything that reads stdin directly.
  sudo env DEBIAN_FRONTEND=noninteractive "$@" </dev/null >"$log" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5
    elapsed=$((elapsed + 5))
    # "Waiting for cache lock" (unattended-upgrades holding dpkg on a fresh
    # boot) and "Processing triggers" are real progress and belong on screen —
    # hiding them is what made long apt phases look like a dead installer.
    new=$(tail -c +"$offset" "$log" | grep -E '^(Get|Hit|Fetched|Unpacking|Setting up|Selecting|Preparing|Need to get|Waiting|Processing)' || true)
    if [ -n "$new" ]; then
      printf '%s\n' "$new"
      offset=$(( $(wc -c <"$log") + 1 ))
      printed=$elapsed
    elif [ $((elapsed - printed)) -ge 20 ]; then
      printf '  … still working (%ss elapsed)\n' "$elapsed" >&2
      printed=$elapsed
    fi
  done
  wait "$pid"
  rc=$?
  new=$(tail -c +"$offset" "$log" | grep -E '^(Get|Hit|Fetched|Unpacking|Setting up|Selecting|Preparing|Waiting|Processing)' || true)
  [ -z "$new" ] || printf '%s\n' "$new"
  if [ "$rc" -ne 0 ]; then
    warn "Command failed: sudo $*"
    tail -n 15 "$log" >&2
  fi
  rm -f "$log"
  return "$rc"
}

# Heartbeat for the SILENT long steps that are not apt — pnpm install and the
# monorepo build run many minutes with no output at all on a cold host (pnpm's
# progress bars need a TTY the piped installer does not have), which reads as
# a hung installer. Capture to a log, tick every 30s, and dump the log tail on
# failure so a broken build explains itself instead of dying quietly.
run_quiet_step() {
  local label="$1" log elapsed rc pid
  shift
  log=$(mktemp) || return 1
  "$@" >"$log" 2>&1 &
  pid=$!
  elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5
    elapsed=$((elapsed + 5))
    if [ $((elapsed % 30)) -eq 0 ]; then
      printf '  … %s — still working (%ss elapsed)\n' "$label" "$elapsed" >&2
    fi
  done
  wait "$pid"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    warn "Step failed: $*"
    tail -n 30 "$log" >&2
  fi
  rm -f "$log"
  return "$rc"
}

# Fetch a vendor GPG key into /etc/apt/keyrings and register its repository.
# Args: <name> <key-url> <repo-line-without-signed-by>
add_signed_apt_repo() {
  local name="$1" key_url="$2" repo_line="$3"
  local keyring="/etc/apt/keyrings/${name}.asc"
  sudo install -m 0755 -d /etc/apt/keyrings || return 1
  curl -fsSL "$key_url" | sudo tee "$keyring" >/dev/null || return 1
  sudo chmod a+r "$keyring" || return 1
  echo "deb [arch=$(dpkg --print-architecture) signed-by=${keyring}] ${repo_line}" \
    | sudo tee "/etc/apt/sources.list.d/${name}.list" >/dev/null || return 1
  run_apt_step apt-get update -y || return 1
}

# Last resort: download a vendor setup script, show what it is, and run it
# only with explicit consent.
run_vendor_script() {
  local url="$1" stage digest
  stage=$(mktemp -d) || fail "Could not create a download workspace"
  curl -fsSL "$url" -o "$stage/setup.sh" || { rm -rf "$stage"; return 1; }
  digest=$(sha256sum "$stage/setup.sh" | awk '{print $1}')
  warn "About to run an UNVERIFIED vendor script as root:"
  warn "  url    : $url"
  warn "  sha256 : $digest"
  if ! allow_unverified_scripts; then
    if [ -t 0 ]; then
      read -r -p "Run it? [y/N] " _reply
      case "$_reply" in [yY]*) ;; *) rm -rf "$stage"; return 1 ;; esac
    else
      warn "Refusing (non-interactive). Re-run with NINEDEPLOY_ALLOW_UNVERIFIED_INSTALL_SCRIPTS=1 to accept."
      rm -rf "$stage"
      return 1
    fi
  fi
  sudo -E bash "$stage/setup.sh"
  local rc=$?
  rm -rf "$stage"
  return $rc
}

# Node.js from NodeSource's signed APT repository.
install_node_apt() {
  local major="$1"
  add_signed_apt_repo "nodesource" \
    "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" \
    "https://deb.nodesource.com/node_${major}.x nodistro main" || return 1
  run_apt_step apt-get install -y nodejs
}

# Node.js: signed repo first, consented script second.
install_node() {
  install_node_apt 24 && return 0
  install_node_apt 22 && return 0
  warn "NodeSource APT repository unavailable — falling back to their setup script."
  (run_vendor_script "https://deb.nodesource.com/setup_24.x" || run_vendor_script "https://deb.nodesource.com/setup_22.x") \
    && sudo apt-get install -y nodejs
}

# Docker from Docker Inc.'s signed APT repository.
install_docker_apt() {
  local codename
  codename=$( (. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") 2>/dev/null ) || return 1
  local id
  id=$( (. /etc/os-release && echo "$ID") 2>/dev/null ) || return 1
  case "$id" in ubuntu|debian) ;; *) return 1 ;; esac
  add_signed_apt_repo "docker" \
    "https://download.docker.com/linux/${id}/gpg" \
    "https://download.docker.com/linux/${id} ${codename} stable" || return 1
  run_apt_step apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

if [ -z "${NINEDEPLOY_INSTALL_DIR:-}" ]; then
  if [ -f "./package.json" ] && [ -d "./apps/server" ]; then
    INSTALL_DIR="$(pwd)"
  elif [ -d "/opt/ninedeploy" ] && [ -f "/opt/ninedeploy/package.json" ]; then
    INSTALL_DIR="/opt/ninedeploy"
  elif [ -d "$HOME/ninedeploy" ]; then
    INSTALL_DIR="$HOME/ninedeploy"
  else
    INSTALL_DIR="$HOME/ninedeploy"
  fi
else
  INSTALL_DIR="$NINEDEPLOY_INSTALL_DIR"
fi
REPO_URL="https://github.com/NineDeploy/NineDeploy.git"
# Same repository as REPO_URL, in the owner/name form the GitHub API wants.
REPO_SLUG="NineDeploy/NineDeploy"
NEEDS_CLONE=false

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║       NineDeploy Installer               ║${NC}"
echo -e "${BOLD}║       Self-hosted PaaS                   ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── 0. Arguments & deployment mode ────────────────────────────────────────

CHANNEL="${NINEDEPLOY_CHANNEL:-release}"
PINNED_VERSION="${NINEDEPLOY_VERSION:-}"
FORCE_REFRESH="${NINEDEPLOY_FORCE:-0}"
INSTALL_MODE_FLAG=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --docker)
      INSTALL_MODE_FLAG="docker"
      shift
      ;;
    --bare-metal)
      INSTALL_MODE_FLAG="bare-metal"
      shift
      ;;
    --version=*)
      PINNED_VERSION="${1#--version=}"
      shift
      ;;
    --version)
      [ "$#" -ge 2 ] || fail "--version requires a vX.Y.Z value"
      PINNED_VERSION="$2"
      shift 2
      ;;
    --channel=*)
      CHANNEL="${1#--channel=}"
      shift
      ;;
    --channel)
      [ "$#" -ge 2 ] || fail "--channel requires release or main"
      CHANNEL="$2"
      shift 2
      ;;
    --force|-f)
      FORCE_REFRESH=1
      shift
      ;;
    v[0-9]*)
      [ -z "$PINNED_VERSION" ] && PINNED_VERSION="$1"
      shift
      ;;
    *)
      fail "Unknown installer argument: $1"
      ;;
  esac
done

case "$CHANNEL" in
  release|main) ;;
  *) fail "Unsupported channel '$CHANNEL' (expected release or main)" ;;
esac

if [ -n "$PINNED_VERSION" ] && ! printf '%s' "$PINNED_VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  fail "Invalid version '$PINNED_VERSION' (expected vX.Y.Z)"
fi

# Deployment mode: explicit flag > env > whatever is already installed. A
# fresh host with a terminal gets asked; piped/non-interactive runs default
# to bare-metal so the documented one-liner keeps its current behaviour.
DOCKER_INSTALL_DIR="${NINEDEPLOY_DOCKER_INSTALL_DIR:-/opt/ninedeploy-docker}"
BARE_METAL_UNIT_FILE="/etc/systemd/system/ninedeploy.service"

bare_metal_present() {
  [ -f "$BARE_METAL_UNIT_FILE" ] && return 0
  # A repo checkout alone is not an install; the installer's own .env plus
  # data directory are the footprint it leaves behind on this machine.
  [ -f "$INSTALL_DIR/package.json" ] && [ -f "$INSTALL_DIR/.env" ] && [ -d "$INSTALL_DIR/.data" ] && return 0
  return 1
}

docker_install_present() { [ -f "$DOCKER_INSTALL_DIR/docker-compose.yml" ]; }

if [ -n "$INSTALL_MODE_FLAG" ]; then
  INSTALL_MODE="$INSTALL_MODE_FLAG"
elif [ -n "${NINEDEPLOY_INSTALL_MODE:-}" ]; then
  INSTALL_MODE="$NINEDEPLOY_INSTALL_MODE"
elif bare_metal_present; then
  INSTALL_MODE="bare-metal"
elif docker_install_present; then
  INSTALL_MODE="docker"
elif [ -t 0 ]; then
  echo "Deployment mode:"
  echo "  1) Docker container   — panel runs as a container; no Node.js/PM2/systemd on the host"
  echo "  2) Bare-metal systemd — full feature set incl. PM2 services and UFW management"
  read -r -p "Choose [1/2, Enter=2]: " _mode_reply
  case "$_mode_reply" in
    1) INSTALL_MODE="docker" ;;
    *) INSTALL_MODE="bare-metal" ;;
  esac
else
  INSTALL_MODE="bare-metal"
fi

case "$INSTALL_MODE" in
  docker|bare-metal) ;;
  *) fail "Unsupported install mode '$INSTALL_MODE' (expected docker or bare-metal)" ;;
esac

if [ "$INSTALL_MODE" = "docker" ] && bare_metal_present; then
  fail "A bare-metal installation is already present. Upgrade it in place (re-run without --docker) or uninstall it first — running both would fight over the same ports and the Traefik ingress."
fi
ok "Deployment mode: $INSTALL_MODE"

# ── 1. Prerequisites ───────────────────────────────────────────────────────

# Base system packages on Debian/Ubuntu
if [ "$(uname -s)" = "Linux" ] && command -v apt-get &>/dev/null; then
  if ! command -v curl &>/dev/null || ! command -v git &>/dev/null || ! command -v tar &>/dev/null || ! command -v sha256sum &>/dev/null; then
    info "Installing base system packages (curl, git, ca-certificates, tar, coreutils)…"
    run_apt_step apt-get update -y || true
    run_apt_step apt-get install -y curl git ca-certificates tar gzip coreutils || true
  fi
fi

# Node.js, pnpm and the host Nixpacks CLI drive bare-metal builds and PM2
# services. In Docker mode the panel container bundles its own Node runtime
# and Nixpacks, so none of these are needed on the host.
if [ "$INSTALL_MODE" != "docker" ]; then

# Node.js ≥ 22.13 (pnpm 11 requires node:sqlite)
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
  NODE_MINOR=$(node -v | sed 's/v//' | cut -d. -f2)
  if [ "$NODE_MAJOR" -gt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 13 ]; }; then
    ok "Node.js $(node -v)"
  else
    warn "Node.js $(node -v) is older than recommended (≥ 22.13). Upgrading to LTS via NodeSource…"
    if command -v apt-get &>/dev/null; then
      install_node || fail "Could not upgrade Node.js. Install >= 22.13 manually: https://nodejs.org/"
      ok "Upgraded Node.js to $(node -v)"
    else
      fail "Node.js $(node -v) — need ≥ 22.13. Upgrade: https://nodejs.org/"
    fi
  fi
else
  warn "Node.js not found. Installing Active LTS via NodeSource…"
  info "This downloads the NodeSource repository and the Node.js package — a few minutes on slow mirrors. Progress lines follow."
  if command -v apt-get &>/dev/null; then
    install_node || fail "Could not install Node.js. Install >= 22.13 manually: https://nodejs.org/"
  elif command -v brew &>/dev/null; then
    brew install node@24 2>/dev/null || brew install node@22
  else
    fail "Node.js not found and no supported package manager. Install manually: https://nodejs.org/"
  fi
  ok "Node.js $(node -v) installed"
fi

# pnpm
if ! command -v pnpm &>/dev/null; then
  warn "pnpm not found. Installing pnpm…"
  PNPM_VERSION="11.23.0"
  if [ -f "$INSTALL_DIR/package.json" ]; then
    PNPM_VERSION=$(node -p "require('${INSTALL_DIR}/package.json').packageManager.replace(/^pnpm@/, '').split('+')[0]" 2>/dev/null || echo "11.23.0")
  fi
  (corepack enable 2>/dev/null && corepack prepare "pnpm@${PNPM_VERSION}" --activate 2>/dev/null) || sudo npm install -g "pnpm@${PNPM_VERSION}" || npm install -g "pnpm@${PNPM_VERSION}"
fi
ok "pnpm $(pnpm -v 2>/dev/null || echo 'installed')"

# Nixpacks CLI — required for source repositories without a Dockerfile.
# ghcr.io/railwayapp/nixpacks is a build base image, not a runnable CLI image,
# so install the pinned upstream binary and verify it before exposing it.
#
# Override at install time with: NINEDEPLOY_NIXPACKS_VERSION=1.40.0 ./install.sh
# The table below only carries checksums for versions we know about; an unknown
# version is rejected rather than silently fetched (defence-in-depth against
# tampered release artefacts). To add a new release, drop its checksums in
# here from the official GitHub release page.
NIXPACKS_VERSION="${NINEDEPLOY_NIXPACKS_VERSION:-1.41.0}"

# Nixpacks → SHA-256 (per arch: <version>:<arch>:<sha256>).
# Source: https://github.com/railwayapp/nixpacks/releases — every entry below
# was cross-checked against the GitHub-published `sha256sum -c *.sha256`.
NIXPACKS_SHA_AMD64_x86_64="0f55de7874507b9cf7502113120bd96f2ab6979f78d10eaf2eb2ade9207b3af6"
NIXPACKS_SHA_ARM64_aarch64="912bd02dd2bb6f9c3a9ed965fe8a68b4aa318dc7a2546e2eca6f2806a894ba39"

install_nixpacks() {
  case "$(uname -m)" in
    x86_64|amd64)
      NIXPACKS_TARGET="x86_64-unknown-linux-musl"
      NIXPACKS_SHA256="$NIXPACKS_SHA_AMD64_x86_64"
      ;;
    aarch64|arm64)
      NIXPACKS_TARGET="aarch64-unknown-linux-musl"
      NIXPACKS_SHA256="$NIXPACKS_SHA_ARM64_aarch64"
      ;;
    *) fail "Nixpacks ${NIXPACKS_VERSION} has no verified binary for architecture $(uname -m)" ;;
  esac

  if [ -z "$NIXPACKS_SHA256" ]; then
    fail "Nixpacks ${NIXPACKS_VERSION} is not in the installer's verified-checksum table. Set NIXPACKS_VERSION to a known release, or update the SHA table in install.sh after auditing the GitHub release."
  fi

  NIXPACKS_ASSET="nixpacks-v${NIXPACKS_VERSION}-${NIXPACKS_TARGET}.tar.gz"
  NIXPACKS_STAGE=$(mktemp -d) || fail "Could not create Nixpacks installation workspace"
  curl -fsSL "https://github.com/railwayapp/nixpacks/releases/download/v${NIXPACKS_VERSION}/${NIXPACKS_ASSET}" \
    -o "$NIXPACKS_STAGE/$NIXPACKS_ASSET" || { rm -rf "$NIXPACKS_STAGE"; fail "Could not download Nixpacks ${NIXPACKS_VERSION}"; }
  NIXPACKS_ACTUAL_SHA=$(sha256sum "$NIXPACKS_STAGE/$NIXPACKS_ASSET" | awk '{print $1}')
  if [ "$NIXPACKS_ACTUAL_SHA" != "$NIXPACKS_SHA256" ]; then
    rm -rf "$NIXPACKS_STAGE"
    fail "Nixpacks checksum verification failed; refusing to install an unverified build tool"
  fi
  tar -xzf "$NIXPACKS_STAGE/$NIXPACKS_ASSET" -C "$NIXPACKS_STAGE" nixpacks || { rm -rf "$NIXPACKS_STAGE"; fail "Could not extract Nixpacks"; }
  sudo install -m 0755 "$NIXPACKS_STAGE/nixpacks" /usr/local/bin/nixpacks || { rm -rf "$NIXPACKS_STAGE"; fail "Could not install Nixpacks"; }
  rm -rf "$NIXPACKS_STAGE"
}

if command -v nixpacks &>/dev/null && nixpacks --version 2>/dev/null | grep -q "${NIXPACKS_VERSION}"; then
  ok "Nixpacks $(nixpacks --version 2>/dev/null)"
else
  info "Installing checksum-verified Nixpacks ${NIXPACKS_VERSION} for source builds…"
  install_nixpacks
  nixpacks --version 2>/dev/null | grep -q "${NIXPACKS_VERSION}" || fail "Nixpacks installation verification failed"
  ok "Nixpacks $(nixpacks --version 2>/dev/null)"
fi

fi # end bare-metal-only prerequisites (Node, pnpm, Nixpacks)

# Docker
if ! command -v docker &>/dev/null; then
  if ! command -v curl &>/dev/null; then
    warn "Install Docker manually: https://docs.docker.com/engine/install/"
    fail "Docker is required."
  fi
  info "Docker not found. Installing Docker Engine + containerd from the signed APT repository…"
  info "This is the largest download of the install (~150 MB) and can take several minutes. Progress lines follow."
  if command -v apt-get &>/dev/null && install_docker_apt; then
    ok "Installed Docker from Docker Inc.'s signed APT repository"
  else
    warn "Docker APT repository unavailable — falling back to get.docker.com."
    run_vendor_script "https://get.docker.com" \
      || fail "Docker is required. Install it manually: https://docs.docker.com/engine/install/"
  fi
fi
if ! docker info &>/dev/null 2>&1; then
  if command -v systemctl &>/dev/null; then
    warn "Starting Docker service…"
    sudo systemctl start docker || true
  fi
fi
if [ "$(uname -s)" = "Linux" ] && [ "$(id -u)" -ne 0 ]; then
  CURRENT_USER="$(id -un)"
  if ! groups "$CURRENT_USER" 2>/dev/null | grep -q '\bdocker\b'; then
    info "Adding user $CURRENT_USER to docker group…"
    sudo usermod -aG docker "$CURRENT_USER" 2>/dev/null || true
  fi
fi
if docker info &>/dev/null 2>&1; then
  DOCKER=(docker)
elif sudo docker info &>/dev/null 2>&1; then
  # A just-added docker group is not visible in the current shell. Keep this
  # one installer run reliable; the systemd service starts with its own groups.
  DOCKER=(sudo docker)
else
  warn "Docker daemon not running. Start it and re-run."
  fail "Docker daemon must be running."
fi
docker_cmd() { "${DOCKER[@]}" "$@"; }
ok "Docker $(docker_cmd --version 2>/dev/null | awk '{print $3}' | tr -d ',' || echo 'installed')"

# Boot resilience: a Docker daemon that is merely running NOW but not enabled
# in systemd silently stays down after the next reboot. Docker's restart
# policies then never fire, so Traefik and every deployed container stay dead,
# and the NineDeploy unit (Requires=docker.service) goes down with them. Ensure
# boot enablement unconditionally — including when this installer did not
# install Docker itself.
if [ "$(uname -s)" = "Linux" ] && command -v systemctl &>/dev/null; then
  sudo systemctl enable docker.service >/dev/null 2>&1 || true
  sudo systemctl enable docker.socket >/dev/null 2>&1 || true
  sudo systemctl enable containerd.service >/dev/null 2>&1 || true
  if systemctl is-enabled --quiet docker.service 2>/dev/null \
    || systemctl is-enabled --quiet docker.socket 2>/dev/null; then
    ok "Docker is enabled at boot (systemd)"
  else
    # Not a hard failure: snap-managed or socket-activated Docker installs can
    # be boot-persistent without these exact unit names. Warn loudly instead.
    warn "Could not verify Docker boot enablement via systemd units."
    warn "If Docker is not managed by snap, run: sudo systemctl enable docker.service"
  fi
fi

# Swap space (Linux)
# Low-memory VPS nodes (<= 4GB RAM) without swap risk OOM-kills when pulling
# or unpacking large Docker images (e.g. n8n, Supabase, Postgres).
if [ "$(uname -s)" = "Linux" ]; then
  SWAP_TOTAL=$(free -m 2>/dev/null | awk '/^Swap:/ {print $2}' || echo "0")
  if [ -n "$SWAP_TOTAL" ] && [ "${SWAP_TOTAL:-0}" -lt 1024 ]; then
    MEM_TOTAL=$(free -m 2>/dev/null | awk '/^Mem:/ {print $2}' || echo "2048")
    if [ "${MEM_TOTAL:-2048}" -le 4096 ]; then
      info "Low swap detected (${SWAP_TOTAL:-0}MB on ${MEM_TOTAL:-2048}MB RAM). Configuring 2GB swapfile for reliable Docker operations…"
      if [ ! -f /swapfile ]; then
        (sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048) 2>/dev/null || true
        sudo chmod 600 /swapfile 2>/dev/null || true
        sudo mkswap /swapfile >/dev/null 2>&1 || true
      fi
      if sudo swapon /swapfile >/dev/null 2>&1; then
        ok "2GB swapfile activated"
        if ! grep -q '/swapfile' /etc/fstab 2>/dev/null; then
          echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null 2>&1 || true
        fi
      else
        warn "Could not activate swapfile (may be running inside container or non-root) — continuing."
      fi
    fi
  elif [ -n "$SWAP_TOTAL" ] && [ "${SWAP_TOTAL:-0}" -ge 1024 ]; then
    ok "Swap space (${SWAP_TOTAL}MB)"
  fi
fi

# Network & Ingress Prerequisites
info "Preparing Docker network and Traefik proxy…"
if ! docker_cmd network inspect ninedeploy >/dev/null 2>&1; then
  docker_cmd network create ninedeploy >/dev/null || fail "Could not create the required Docker network 'ninedeploy'"
fi

# A healthy containerd overlayfs store always has this directory alongside
# metadata.db. Some interrupted Docker 29 cleanups leave the metadata database
# behind but remove the physical snapshot root, making every pull/import fail.
# Restore only the missing directory; never remove or rewrite snapshot data.
if [ -S /var/run/docker/containerd/containerd.sock ]; then
  CONTAINERD_OVERLAY_ROOT="/var/lib/docker/containerd/daemon/io.containerd.snapshotter.v1.overlayfs"
else
  CONTAINERD_OVERLAY_ROOT="/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs"
fi
CONTAINERD_SNAPSHOT_DIR="$CONTAINERD_OVERLAY_ROOT/snapshots"
DOCKER_STORAGE_DRIVER=$(docker_cmd info --format '{{.Driver}}' 2>/dev/null || true)
if [ "$DOCKER_STORAGE_DRIVER" = "overlayfs" ] && [ ! -d "$CONTAINERD_SNAPSHOT_DIR" ]; then
  warn "Docker's containerd overlayfs snapshot directory is missing; restoring the required host directory…"
  sudo install -d -o root -g root -m 0700 "$CONTAINERD_SNAPSHOT_DIR" || fail "Could not restore $CONTAINERD_SNAPSHOT_DIR"
  [ -d "$CONTAINERD_SNAPSHOT_DIR" ] || fail "Containerd snapshot directory is still unavailable after repair"
  ok "Containerd overlayfs snapshot directory restored"
fi

# Docker 29's containerd store can retain a broken Alpine snapshot forever.
# Do not loop, prune, restart Docker, or mutate containerd metadata here. A
# single registry attempt is enough; the verified binary fallback below has no
# dependency on the conflicting Alpine layer.
traefik_image_usable() {
  docker_cmd image inspect traefik:3 >/dev/null 2>&1 || return 1
  IMAGE_VERSION=$(docker_cmd run --rm traefik:3 version 2>/dev/null || true)
  printf '%s\n' "$IMAGE_VERSION" | grep -Eq 'Version:[[:space:]]+3\.'
}

build_traefik_fallback_image() {
  TRAEFIK_RELEASE="v3.7.11"
  case "$(uname -m)" in
    x86_64|amd64) TRAEFIK_ARCH="amd64" ;;
    aarch64|arm64) TRAEFIK_ARCH="arm64" ;;
    armv7l) TRAEFIK_ARCH="armv7" ;;
    armv6l) TRAEFIK_ARCH="armv6" ;;
    *) warn "No verified Traefik binary fallback is available for architecture $(uname -m)."; return 1 ;;
  esac

  TRAEFIK_ASSET="traefik_${TRAEFIK_RELEASE}_linux_${TRAEFIK_ARCH}.tar.gz"
  TRAEFIK_RELEASE_URL="https://github.com/traefik/traefik/releases/download/${TRAEFIK_RELEASE}"
  TRAEFIK_STAGE=$(mktemp -d) || return 1
  mkdir -p "$TRAEFIK_STAGE/rootfs/etc/ssl/certs" "$TRAEFIK_STAGE/rootfs/tmp" || { rm -rf "$TRAEFIK_STAGE"; return 1; }
  chmod 1777 "$TRAEFIK_STAGE/rootfs/tmp" || { rm -rf "$TRAEFIK_STAGE"; return 1; }

  info "Docker's Alpine snapshot is unusable; building a minimal Traefik ${TRAEFIK_RELEASE} image from the official release assets…"
  curl -fsSL "$TRAEFIK_RELEASE_URL/$TRAEFIK_ASSET" -o "$TRAEFIK_STAGE/$TRAEFIK_ASSET" || { rm -rf "$TRAEFIK_STAGE"; return 1; }
  curl -fsSL "$TRAEFIK_RELEASE_URL/traefik_${TRAEFIK_RELEASE}_checksums.txt" -o "$TRAEFIK_STAGE/checksums.txt" || { rm -rf "$TRAEFIK_STAGE"; return 1; }
  EXPECTED_SHA=$(awk -v asset="$TRAEFIK_ASSET" '$2 == asset { print $1; exit }' "$TRAEFIK_STAGE/checksums.txt")
  ACTUAL_SHA=$(sha256sum "$TRAEFIK_STAGE/$TRAEFIK_ASSET" | awk '{print $1}')
  if [ -z "$EXPECTED_SHA" ] || [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    warn "Traefik release checksum verification failed; refusing to create a local image."
    rm -rf "$TRAEFIK_STAGE"
    return 1
  fi

  tar -xzf "$TRAEFIK_STAGE/$TRAEFIK_ASSET" -C "$TRAEFIK_STAGE" traefik || { rm -rf "$TRAEFIK_STAGE"; return 1; }
  install -m 0755 "$TRAEFIK_STAGE/traefik" "$TRAEFIK_STAGE/rootfs/traefik" || { rm -rf "$TRAEFIK_STAGE"; return 1; }
  if [ -f /etc/ssl/certs/ca-certificates.crt ]; then
    install -m 0644 /etc/ssl/certs/ca-certificates.crt "$TRAEFIK_STAGE/rootfs/etc/ssl/certs/ca-certificates.crt" || { rm -rf "$TRAEFIK_STAGE"; return 1; }
  else
    warn "Host CA certificate bundle is unavailable; refusing to create a TLS proxy image."
    rm -rf "$TRAEFIK_STAGE"
    return 1
  fi

  tar -C "$TRAEFIK_STAGE/rootfs" -cf - . | docker_cmd import \
    --change 'ENTRYPOINT ["/traefik"]' \
    --change 'EXPOSE 80 443' \
    --change 'LABEL org.opencontainers.image.source="https://github.com/traefik/traefik"' \
    --change "LABEL org.opencontainers.image.version=\"$TRAEFIK_RELEASE\"" \
    - traefik:3 >/dev/null || { rm -rf "$TRAEFIK_STAGE"; return 1; }
  rm -rf "$TRAEFIK_STAGE"

  LOCAL_TRAEFIK_VERSION=$(docker_cmd run --rm traefik:3 version 2>/dev/null || true)
  printf '%s\n' "$LOCAL_TRAEFIK_VERSION" | grep -Eq "Version:[[:space:]]+${TRAEFIK_RELEASE#v}$" || {
    warn "The locally constructed Traefik image failed its version probe."
    return 1
  }
  ok "Verified minimal Traefik ${TRAEFIK_RELEASE} image created without the corrupt Alpine snapshot"
}

if traefik_image_usable; then
  ok "Existing Traefik v3 image verified; skipping registry pull"
else
  # The pull output is captured (printed after completion on success), so say
  # what is happening during the silent ~100 MB download window.
  info "Pulling the Traefik v3 image (~100 MB) — output follows when it finishes…"
  if PULL_OUTPUT=$(docker_cmd pull traefik:3 2>&1) && traefik_image_usable; then
    printf '%s\n' "$PULL_OUTPUT"
  else
    printf '%s\n' "$PULL_OUTPUT" >&2
    warn "Docker Hub image is unusable; switching immediately to the verified layer-free Traefik image…"
    build_traefik_fallback_image || fail "Could not provision Traefik from Docker Hub or verified upstream release assets; ingress cannot operate"
  fi
fi

# Free ports 80/443 if default apache2/nginx are occupying them on Linux
if [ "$(uname -s)" = "Linux" ] && command -v systemctl &>/dev/null; then
  if systemctl is-active --quiet apache2 2>/dev/null; then
    warn "Stopping conflicting apache2 service on port 80/443…"
    sudo systemctl stop apache2 2>/dev/null || true
    sudo systemctl disable apache2 2>/dev/null || true
  fi
  if systemctl is-active --quiet nginx 2>/dev/null; then
    warn "Stopping conflicting nginx service on port 80/443…"
    sudo systemctl stop nginx 2>/dev/null || true
    sudo systemctl disable nginx 2>/dev/null || true
  fi
fi

# Host Firewall (UFW on Linux)
if [ "$(uname -s)" = "Linux" ] && command -v ufw &>/dev/null; then
  info "Configuring host firewall (UFW) with safe defaults…"
  sudo ufw allow 22/tcp comment 'SSH' >/dev/null 2>&1 || true
  sudo ufw allow 80/tcp comment 'HTTP (Traefik)' >/dev/null 2>&1 || true
  sudo ufw allow 443/tcp comment 'HTTPS (Traefik)' >/dev/null 2>&1 || true
  if [ -n "${NINEDEPLOY_PORT:-}" ] && [ "${NINEDEPLOY_PORT:-3000}" != "80" ] && [ "${NINEDEPLOY_PORT:-3000}" != "443" ]; then
    sudo ufw allow "${NINEDEPLOY_PORT}/tcp" comment 'NineDeploy Direct Panel' >/dev/null 2>&1 || true
  fi
  ok "Firewall rules updated (UFW: 22, 80, 443 permitted)"
fi
ok "Docker network & ingress ready"

# ── 2. Resolve the version to install ──────────────────────────────────────
#
# Channel:
#   release (default) — latest vX.Y.Z git tag (stable)
#   main              — track the main branch (edge; previous behaviour)
# A specific tag can be pinned with --version vX.Y.Z / NINEDEPLOY_VERSION.

# Highest vX.Y.Z from a newline-separated tag list on stdin.
#
# `sort -V` is GNU-only; busybox and BSD coreutils either lack it or sort
# lexically, which ranks v0.2.9 above v0.2.36 and would pin an upgrade to a
# stale release forever. Normalise each component to a zero-padded fixed
# width first so a plain lexical `sort` is correct everywhere.
highest_semver_tag() {
  (grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true) \
    | awk -F'[v.]' '{ printf "%010d%010d%010d %s\n", $2, $3, $4, $0 }' \
    | sort \
    | tail -1 \
    | awk '{print $2}'
}

# Newest vX.Y.Z release tag, asked of GitHub directly. Three independent
# sources, because a single one is not reliable enough to decide what an
# operator's `--channel release` upgrade actually installs:
#
#   1. `git ls-remote` — works behind a git-only proxy, no API rate limit.
#   2. The releases API — authoritative for what is *published*, and the only
#      source that skips a tag pushed without a release.
#   3. The tags API — fallback when releases/latest 404s (no published
#      release yet) but tags exist.
#
# The first source that yields a well-formed tag wins.
latest_tag() {
  local _tag=""

  _tag=$(
    (git ls-remote --tags --refs "$REPO_URL" 2>/dev/null || true) \
      | awk -F/ '{print $NF}' | highest_semver_tag
  )
  if [ -n "$_tag" ]; then printf '%s' "$_tag"; return 0; fi

  warn "git ls-remote returned no tags — asking the GitHub releases API"
  _tag=$(
    (curl -fsSL -m 15 -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/${REPO_SLUG}/releases/latest" 2>/dev/null || true) \
      | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | head -1 | sed 's/.*"\([^"]*\)"$/\1/' | highest_semver_tag
  )
  if [ -n "$_tag" ]; then printf '%s' "$_tag"; return 0; fi

  warn "No published release — falling back to the GitHub tags API"
  _tag=$(
    (curl -fsSL -m 15 -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/${REPO_SLUG}/tags?per_page=100" 2>/dev/null || true) \
      | grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | sed 's/.*"\([^"]*\)"$/\1/' | highest_semver_tag
  )
  printf '%s' "$_tag"
}

# Source of the tree the installer is about to build. `release` means the
# published tarball for a tag; `git` means a clone/checkout. Set in section 3.
SOURCE_MODE=""
# Records the installed release so a later upgrade knows what is on disk
# without needing a git history.
RELEASE_STAMP_FILE=".ninedeploy-release"

# Download and unpack the source tarball GitHub publishes for a tag.
#   $1  tag (vX.Y.Z)
#   $2  directory to unpack into (created; the archive's top-level
#       <repo>-<version>/ wrapper is stripped)
# Returns non-zero — leaving no partial tree behind — when the release does
# not exist, the download fails, or the archive does not look like NineDeploy.
fetch_release_tarball() {
  local _ref="$1" _dest="$2" _stage _archive _url
  _url="https://github.com/${REPO_SLUG}/archive/refs/tags/${_ref}.tar.gz"
  _stage=$(mktemp -d) || return 1
  _archive="$_stage/ninedeploy-${_ref}.tar.gz"

  if ! curl -fsSL --retry 3 --retry-delay 2 -m 600 "$_url" -o "$_archive"; then
    rm -rf "$_stage"
    return 1
  fi
  # A 404 page or an HTML error would still be a file; make tar prove it.
  if ! tar -tzf "$_archive" >/dev/null 2>&1; then
    rm -rf "$_stage"
    return 1
  fi

  mkdir -p "$_dest" || { rm -rf "$_stage"; return 1; }
  # Every failure past this point leaves a partial tree behind. The caller
  # falls back to `git clone`, which refuses a non-empty target, so unwind it.
  if ! tar -xzf "$_archive" -C "$_dest" --strip-components=1; then
    rm -rf "$_stage" "${_dest:?}"
    return 1
  fi
  rm -rf "$_stage"

  # The archive must be the monorepo root, not some other project's tarball.
  if [ ! -f "$_dest/package.json" ] || [ ! -f "$_dest/pnpm-workspace.yaml" ]; then
    warn "The tarball for $_ref does not look like a NineDeploy source tree"
    rm -rf "${_dest:?}"
    return 1
  fi

  # ── Provenance: bind the extracted tree to the requested tag. ──────────
  # TLS proves the transport; these checks prove the CONTENT is the release
  # the operator asked for (a swapped, stale or tampered archive fails here
  # instead of becoming a root-built service).
  _tar_version=$(sed -n 's/.*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$_dest/package.json" | head -1)
  if [ "v$_tar_version" != "$_ref" ]; then
    warn "Tarball for $_ref carries version '${_tar_version:-?}' — content does not match the tag, refusing"
    rm -rf "${_dest:?}"
    return 1
  fi
  # A source tree must carry no symlinks (extraction-time escapes) and no
  # setuid/setgid bits (privilege seeds for the root-built service).
  if find "$_dest" -type l -print -quit 2>/dev/null | grep -q .; then
    warn "Tarball for $_ref contains symlinks — refusing"
    rm -rf "${_dest:?}"
    return 1
  fi
  if find "$_dest" -type f -perm /6000 -print -quit 2>/dev/null | grep -q .; then
    warn "Tarball for $_ref contains setuid/setgid files — refusing"
    rm -rf "${_dest:?}"
    return 1
  fi
  info "Tarball provenance verified: $_ref, version $_tar_version, no symlinks, no setuid bits"
  return 0
}

REF=""
if [ -n "$PINNED_VERSION" ]; then
  REF="$PINNED_VERSION"
  info "Installing pinned version $REF"
elif [ "$CHANNEL" = "main" ]; then
  REF="main"
  info "Edge channel: tracking the main branch"
else
  REF=$(latest_tag)
  if [ -z "$REF" ]; then
    warn "No release tags found — falling back to the main branch"
    REF="main"
  else
    info "Release channel: installing $REF (latest tag)"
  fi
fi

# ── 2b. Docker mode: deploy the panel as a container and finish ──────────
#
# Everything above is shared with bare-metal (Docker daemon, boot enablement,
# swap, the ninedeploy network, the Traefik image, port and firewall prep).
# From here the modes diverge: Docker mode never clones, builds or installs
# systemd units — it fetches the pinned compose file, maintains a 0600 .env
# next to it, and lets compose own the lifecycle. Re-running the installer
# in this mode IS the upgrade path (same volume, same secrets).
install_docker_mode() {
  # Compose v2 ships with the signed Docker APT repo this installer uses,
  # but a pre-existing Docker install may lack the plugin.
  if ! docker_cmd compose version >/dev/null 2>&1; then
    info "Docker Compose v2 plugin missing — installing docker-compose-plugin…"
    run_apt_step apt-get install -y docker-compose-plugin \
      || fail "Docker Compose v2 is required for the Docker install mode. Install 'docker-compose-plugin' and re-run."
  fi

  # Install dir owned by the invoking user, so .env and compose state stay
  # manageable without sudo (root invocations keep root ownership).
  if [ "$(id -u)" -ne 0 ]; then
    sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0755 "$DOCKER_INSTALL_DIR" \
      || fail "Could not create $DOCKER_INSTALL_DIR"
  else
    install -d -m 0755 "$DOCKER_INSTALL_DIR" || fail "Could not create $DOCKER_INSTALL_DIR"
  fi

  # Compose file for $REF: prefer a checkout the installer was run from,
  # otherwise fetch exactly this file from the same origin as install.sh.
  if [ -f "./docker-compose.prod.yml" ] && [ -f "./package.json" ]; then
    info "Using docker-compose.prod.yml from the current checkout"
    cp ./docker-compose.prod.yml "$DOCKER_INSTALL_DIR/docker-compose.yml.new" \
      || fail "Could not stage the compose file"
  else
    info "Fetching docker-compose.prod.yml for $REF…"
    curl -fsSL "https://raw.githubusercontent.com/NineDeploy/NineDeploy/${REF}/docker-compose.prod.yml" \
      -o "$DOCKER_INSTALL_DIR/docker-compose.yml.new" \
      || fail "Could not fetch docker-compose.prod.yml for $REF"
  fi
  # The compose file drives a root-equivalent container deployment, so the
  # fetched content is validated BEFORE it is trusted: the services key must
  # exist, the project must reference exactly ONE image and it must be this
  # panel's own repository, and the compose engine itself must accept the
  # file (dummy values satisfy the required-variable defaults at parse time).
  grep -q '^services:' "$DOCKER_INSTALL_DIR/docker-compose.yml.new" \
    || fail "The fetched compose file does not look right (missing 'services:') — refusing to deploy it"
  if [ "$(grep -cE '^[[:space:]]*image:[[:space:]]*' "$DOCKER_INSTALL_DIR/docker-compose.yml.new")" != "1" ] \
    || ! grep -Eq "image:[[:space:]]*ghcr\.io/${REPO_SLUG//./\\.}:" "$DOCKER_INSTALL_DIR/docker-compose.yml.new"; then
    fail "The fetched compose file references an unexpected image — refusing to deploy it"
  fi
  NINEDEPLOY_JWT_SECRET=provenance-check DOCKER_GID=1 docker_cmd compose \
    --file "$DOCKER_INSTALL_DIR/docker-compose.yml.new" config --quiet \
    || fail "The fetched compose file is not a valid compose project — refusing to deploy it"
  mv "$DOCKER_INSTALL_DIR/docker-compose.yml.new" "$DOCKER_INSTALL_DIR/docker-compose.yml"

  # Substitute the image tag the release workflow tagged for this ref.
  # `:latest` for release tags (set by release.yml on tag push) and `:edge`
  # for the main channel (set by ci.yml on every push to main). A pinned
  # `--version` always uses `:latest` because the tag was promoted to
  # :latest at release time.
  IMAGE_TAG="latest"
  if [ "$CHANNEL" = "main" ] && [ -z "$PINNED_VERSION" ]; then
    IMAGE_TAG="edge"
  fi
  if grep -q 'ghcr.io/.*:latest' "$DOCKER_INSTALL_DIR/docker-compose.yml"; then
    sed -i.bak "s|ghcr.io/${REPO_SLUG}:latest|ghcr.io/${REPO_SLUG}:${IMAGE_TAG}|" \
      "$DOCKER_INSTALL_DIR/docker-compose.yml" \
      && rm -f "$DOCKER_INSTALL_DIR/docker-compose.yml.bak" \
      || fail "Could not substitute the image tag in docker-compose.yml"
    info "Compose file pinned to ghcr.io/${REPO_SLUG}:${IMAGE_TAG}"
  fi

  cd "$DOCKER_INSTALL_DIR"

  # .env: created 0600, then upserted per run. The JWT secret survives
  # upgrades (rotating it would invalidate every session); DOCKER_GID is
  # refreshed every run because the host's docker group id can change.
  gen_secret() {
    if command -v openssl &>/dev/null; then openssl rand -hex 32
    else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
  }
  upsert_env() { # <key> <value>
    if [ -f .env ] && grep -q "^$1=" .env; then
      sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak
    else
      printf '%s=%s\n' "$1" "$2" >> .env
    fi
  }
  local old_umask jwt_secret docker_gid
  old_umask=$(umask)
  umask 077
  [ -f .env ] || touch .env
  jwt_secret="$(sed -n 's/^NINEDEPLOY_JWT_SECRET=//p' .env | tail -1)"
  [ -n "${NINEDEPLOY_JWT_SECRET:-}" ] && jwt_secret="$NINEDEPLOY_JWT_SECRET"
  [ -z "$jwt_secret" ] && jwt_secret="$(gen_secret)"
  docker_gid="$(getent group docker | cut -d: -f3)"
  [ -n "$docker_gid" ] || fail "Could not resolve the host docker group id (getent group docker)"
  upsert_env NINEDEPLOY_JWT_SECRET "$jwt_secret"
  upsert_env DOCKER_GID "$docker_gid"
  upsert_env NINEDEPLOY_PORT "${NINEDEPLOY_PORT:-3000}"
  # Optional integrations: written only when provided by the environment and
  # never overwritten once present, so operator edits survive upgrades.
  for _var in NINEDEPLOY_PUBLIC_URL NINEDEPLOY_ACME_EMAIL NINEDEPLOY_DNS_PROVIDER NINEDEPLOY_DNS_TOKEN; do
    _val="${!_var:-}"
    if [ -n "$_val" ] && ! grep -q "^${_var}=" .env; then
      printf '%s=%s\n' "$_var" "$_val" >> .env
    fi
  done
  # The direct port is LOOPBACK-bound (see docker-compose.prod.yml), so the
  # truthful default panel URL is localhost:port — not the host's LAN name.
  # Once the operator attaches a domain and an ACME email, Traefik serves
  # HTTPS on :443 and NINEDEPLOY_PUBLIC_URL should be set to that origin.
  grep -q '^NINEDEPLOY_PUBLIC_URL=' .env \
    || upsert_env NINEDEPLOY_PUBLIC_URL "http://localhost:${NINEDEPLOY_PORT:-3000}"
  chmod 600 .env
  umask "$old_umask"

  info "Pulling the NineDeploy panel image (a few hundred MB on first run)…"
  # Preflight: try an unauthenticated `docker manifest inspect` against
  # the exact tag the compose file will use. A 401/403 here means the
  # GHCR package is still private and the operator must flip its
  # visibility to "Public" at
  # https://github.com/orgs/NineDeploy/packages/container/ninedeploy/settings
  # — the docs page (docs/INSTALL.md) has a one-time checklist. Failing
  # fast here is friendlier than the generic "image pull failed" the
  # compose call would otherwise surface ten seconds later.
  if ! docker_cmd manifest inspect "ghcr.io/${REPO_SLUG}:${IMAGE_TAG}" >/dev/null 2>&1; then
    fail "ghcr.io/${REPO_SLUG}:${IMAGE_TAG} is not publicly pullable. Make the GHCR package 'Public' at https://github.com/orgs/NineDeploy/packages/container/ninedeploy/settings (one-time setup), or use the bare-metal installer (./install.sh without --docker) which builds from source."
  fi
  docker_cmd compose pull \
    || fail "Image pull failed — check registry connectivity and re-run the installer."
  docker_cmd compose up -d \
    || { docker_cmd compose logs --tail 50 2>/dev/null || true; fail "docker compose up failed"; }

  HEALTH_PORT="$(sed -n 's/^NINEDEPLOY_PORT=//p' .env | tail -1)"
  HEALTH_PORT="${HEALTH_PORT:-3000}"
  info "Waiting for the panel to become healthy (up to 120s)…"
  _healthy=false
  for _i in $(seq 1 120); do
    if curl -fsS -m 2 "http://127.0.0.1:${HEALTH_PORT}/health" >/dev/null 2>&1; then _healthy=true; break; fi
    sleep 1
  done
  if [ "$_healthy" != "true" ]; then
    docker_cmd compose logs --tail 50 2>/dev/null || true
    fail "Panel did not become healthy in 120s — inspect: cd $DOCKER_INSTALL_DIR && docker compose logs -f"
  fi
  ok "NineDeploy panel is healthy (docker compose project 'ninedeploy')"

  PUBLIC_URL="$(sed -n 's/^NINEDEPLOY_PUBLIC_URL=//p' .env | tail -1)"
  echo ""
  echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}║       ✓ Installation Complete            ║${NC}"
  echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${CYAN}Dashboard:${NC}  ${PUBLIC_URL:-http://localhost:${HEALTH_PORT}}"
  echo -e "  ${CYAN}Mode:${NC}       Docker container (compose project 'ninedeploy', restart: unless-stopped)"
  echo -e "  ${CYAN}Directory:${NC}  $DOCKER_INSTALL_DIR (secrets in .env, mode 0600)"
  echo ""
  echo -e "  ${YELLOW}Manage:${NC}"
  echo -e "    cd $DOCKER_INSTALL_DIR && docker compose logs -f"
  echo -e "    docker compose restart"
  echo -e "    docker compose down        # data volume survives"
  echo -e "  ${YELLOW}Upgrade:${NC} re-run this installer (it auto-detects the Docker install), or"
  echo -e "    cd $DOCKER_INSTALL_DIR && docker compose pull && docker compose up -d"
  echo ""
}

if [ "$INSTALL_MODE" = "docker" ]; then
  install_docker_mode
  exit 0
fi

# ── 3. Get the code ────────────────────────────────────────────────────────
#
# Preferred source: the tarball GitHub publishes for a release tag. It is the
# exact tree the tag points at, needs no git on the host, and cannot land on a
# half-fetched object the way a shallow clone can. `git` stays available for
# the edge channel and as the fallback when the archive endpoint is
# unreachable or the tag has no tarball yet.

# Replace the tracked source tree in $INSTALL_DIR with the release tarball for
# $1, preserving .env, .data and node_modules. Returns non-zero when the
# tarball could not be fetched, leaving the existing install untouched.
upgrade_from_release() {
  local _ref="$1" _stage
  _stage=$(mktemp -d) || return 1
  rm -rf "$_stage"

  info "Downloading the $_ref release tarball from GitHub…"
  if ! fetch_release_tarball "$_ref" "$_stage"; then
    rm -rf "$_stage"
    return 1
  fi

  # Drop source directories that the new tree owns wholesale, so a file
  # deleted in this release does not survive as a stale module. Everything
  # holding state — .env, .data, node_modules — is outside this list.
  local _d
  for _d in apps packages scripts systemd patches docs .github; do
    rm -rf "${INSTALL_DIR:?}/$_d"
  done

  # Copy the new tree over the install dir (dotfiles included) — but not
  # install.sh: this script is executing from that exact path, and bash reads
  # it incrementally. Overwriting it in place would make the running shell
  # resume at a byte offset in different content.
  (cd "$_stage" && tar -cf - --exclude=./install.sh .) | (cd "$INSTALL_DIR" && tar -xf -) || {
    rm -rf "$_stage"
    fail "Could not unpack $_ref over $INSTALL_DIR"
  }

  # Swap the installer itself by rename: the running process keeps its open
  # descriptor on the old inode and finishes reading the script it started.
  if [ -f "$_stage/install.sh" ]; then
    if cp "$_stage/install.sh" "$INSTALL_DIR/.install.sh.new"; then
      chmod +x "$INSTALL_DIR/.install.sh.new" 2>/dev/null || true
      mv -f "$INSTALL_DIR/.install.sh.new" "$INSTALL_DIR/install.sh"         || rm -f "$INSTALL_DIR/.install.sh.new"
    fi
  fi

  rm -rf "$_stage"
  ok "Source tree replaced with release $_ref"
  return 0
}

# Move an existing git checkout onto $1 and hard-reset it to the remote.
update_from_git() {
  local _ref="$1"

  # The remote must be the canonical repository. A fork or a renamed remote
  # left behind by an earlier manual clone would silently pin the upgrade to
  # somebody else's history.
  local _origin
  _origin=$(git remote get-url origin 2>/dev/null || true)
  if [ "$_origin" != "$REPO_URL" ]; then
    if [ -z "$_origin" ]; then
      git remote add origin "$REPO_URL"
    else
      warn "origin was $_origin — repointing it at $REPO_URL"
      git remote set-url origin "$REPO_URL"
    fi
  fi

  # Fresh installs used to be cloned with --depth 1, so the checkout holds
  # exactly one commit and none of the objects a newer tag needs. `git fetch
  # --tags` on such a repository succeeds while fetching nothing usable, and
  # the checkout then lands on the old commit — which is how an "upgraded"
  # host keeps serving the previous release. Deepen first.
  if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo false)" = "true" ]; then
    info "Shallow checkout detected — fetching full history so tags resolve…"
    git fetch --unshallow --tags origin 2>/dev/null \
      || git fetch --depth=2147483647 --tags origin 2>/dev/null \
      || warn "Could not deepen the checkout; tag resolution may be limited"
  fi

  # --force + --prune-tags so a retagged or deleted release is reflected
  # locally instead of leaving a stale tag pointing at old objects.
  info "Fetching the latest refs from GitHub…"
  git fetch --force --tags --prune origin || fail "could not fetch from $REPO_URL"
  git fetch --force --prune --prune-tags --tags origin >/dev/null 2>&1 || true

  if [ "$FORCE_REFRESH" = "1" ]; then
    warn "--force: discarding local modifications to tracked files"
    git reset --hard HEAD >/dev/null 2>&1 || true
  fi

  # Contract (see --help): only --force discards local modifications. A dirty
  # tree must not be silently clobbered by `checkout --force`, so on the
  # default path detect it and abort with guidance (the panel is restarted in
  # the fail branch below).
  if [ "$FORCE_REFRESH" != "1" ] && { ! git diff --quiet || ! git diff --cached --quiet; }; then
    [ "$HAS_SYSTEMD" = true ] && sudo systemctl start ninedeploy
    fail "local modifications to tracked files would be overwritten; commit or stash them, or re-run with --force"
  fi

  if [ "$FORCE_REFRESH" = "1" ]; then
    git checkout --force "$_ref" || { [ "$HAS_SYSTEMD" = true ] && sudo systemctl start ninedeploy; fail "could not check out $_ref"; }
  else
    git checkout "$_ref" || { [ "$HAS_SYSTEMD" = true ] && sudo systemctl start ninedeploy; fail "could not check out $_ref"; }
  fi

  # Land exactly on the remote's idea of $_ref. `checkout --force` on a branch
  # leaves the old local commit in place; on a tag it can silently keep a
  # stale local tag. Reset to the fetched object either way — but ONLY under
  # --force, which is the flag that owns destroying local state.
  if [ "$FORCE_REFRESH" = "1" ]; then
    if [ "$_ref" = "main" ]; then
      git reset --hard origin/main || warn "could not reset to origin/main; continuing with the checked-out tree"
    else
      git reset --hard "refs/tags/$_ref" || warn "could not reset to $_ref; continuing with the checked-out tree"
    fi
  fi

  ok "Source tree at $_ref ($(git rev-parse --short HEAD 2>/dev/null || echo unknown))"
}


if [ -f "$INSTALL_DIR/package.json" ]; then
  # What is on disk right now, so the upgrade reports both ends of the jump.
  PREVIOUS_VERSION=$(node -p "require('${INSTALL_DIR}/package.json').version" 2>/dev/null || echo "")
  PREVIOUS_REF=$(cat "$INSTALL_DIR/$RELEASE_STAMP_FILE" 2>/dev/null || echo "")
  if [ -n "$PREVIOUS_VERSION" ]; then
    info "Existing installation found at $INSTALL_DIR — upgrading ${PREVIOUS_REF:-v$PREVIOUS_VERSION} → $REF"
  else
    info "Existing installation found at $INSTALL_DIR — updating…"
  fi
  cd "$INSTALL_DIR"

  HAS_SYSTEMD=false
  if [ "$(uname -s)" = "Linux" ] && command -v systemctl &>/dev/null && systemctl is-active --quiet ninedeploy 2>/dev/null; then
    HAS_SYSTEMD=true
    info "Stopping the service for a consistent backup…"
    sudo systemctl stop ninedeploy
  fi

  # Safety net before an upgrade: snapshot the database and the master key.
  #
  # This used to pass both paths to one `tar` invocation with stderr muted.
  # `master.key` is written lazily — the first time something is encrypted —
  # so on an instance that has no secrets yet the file does not exist, tar
  # exits non-zero, and the whole snapshot was skipped: including the
  # database, which did exist. The operator saw one muted warning and
  # upgraded with no rollback point at all.
  #
  # Archive each member that is actually present, and treat a missing
  # master.key as the normal state it is. SQLite's -wal/-shm sidecars are
  # included when present so the snapshot is a consistent set rather than a
  # main file missing its most recent committed transactions.
  BACKUP_OK=false
  BACKUP_FILE=""
  if [ -d .data ]; then
    BACKUP_MEMBERS=""
    for _f in .data/ninedeploy.db .data/ninedeploy.db-wal .data/ninedeploy.db-shm .data/master.key; do
      [ -f "$_f" ] && BACKUP_MEMBERS="$BACKUP_MEMBERS $_f"
    done

    if [ -z "$BACKUP_MEMBERS" ]; then
      # Nothing to lose — a data directory with no database is a fresh state.
      info "No database or master key in .data yet — nothing to snapshot"
    else
      mkdir -p .data/upgrade-backups
      BACKUP_FILE=".data/upgrade-backups/pre-update-$(date +%Y%m%d-%H%M%S).tar.gz"
      # The archive contains master.key — the key that decrypts EVERY stored
      # secret. Tighten the umask for the tar child so the file lands 0600
      # regardless of the caller's ambient umask, and assert it afterwards.
      # shellcheck disable=SC2086 # deliberate word splitting: one arg per member
      if TAR_ERR=$(umask 077 && tar -czf "$BACKUP_FILE" $BACKUP_MEMBERS 2>&1); then
        chmod 600 "$BACKUP_FILE" 2>/dev/null || true
        BACKUP_OK=true
        ok "Pre-update backup saved to $BACKUP_FILE ($(echo "$BACKUP_MEMBERS" | wc -w) file(s))"
      else
        rm -f "$BACKUP_FILE"
        BACKUP_FILE=""
        warn "Could not snapshot .data — continuing WITHOUT a rollback point:"
        printf '%s\n' "$TAR_ERR" | head -5 | sed 's/^/     /'
      fi
    fi
  fi

  # Used by the readiness gate's failure messages, which must not claim a
  # backup exists when the snapshot above did not run.
  if [ "$BACKUP_OK" = true ]; then
    BACKUP_HINT="A pre-update backup is in ${INSTALL_DIR}/${BACKUP_FILE#./}"
  else
    BACKUP_HINT="No pre-update backup was taken"
  fi

  # ── Upgrade: release tarball first, git second ─────────────────────────
  #
  # A tagged release is the artifact operators are told to run, so it is what
  # the installer fetches. `git` remains the path for the edge channel and
  # for hosts that cannot reach the archive endpoint, and it is the only way
  # to move an existing clone-based install forward.
  if [ "$REF" != "main" ] && upgrade_from_release "$REF"; then
    SOURCE_MODE="release"
  elif [ -d "$INSTALL_DIR/.git" ]; then
    [ "$REF" = "main" ] || warn "Release tarball unavailable for $REF — falling back to git"
    SOURCE_MODE="git"
    update_from_git "$REF"
  else
    fail "Could not download the $REF release tarball, and $INSTALL_DIR is not a git checkout. Re-run with --channel main, or check network access to github.com."
  fi
else
  # ── Fresh install ──────────────────────────────────────────────────────
  if [ "$REF" != "main" ]; then
    info "Downloading the $REF release tarball from GitHub…"
    # Unpack into a staging directory rather than straight into $INSTALL_DIR:
    # a failed extraction must never remove whatever the operator already had
    # at that path, and `git clone` (the fallback) refuses a non-empty target.
    FRESH_STAGE=$(mktemp -d) && rm -rf "$FRESH_STAGE"
    if fetch_release_tarball "$REF" "$FRESH_STAGE"; then
      mkdir -p "$INSTALL_DIR"
      if (cd "$FRESH_STAGE" && tar -cf - .) | (cd "$INSTALL_DIR" && tar -xf -); then
        SOURCE_MODE="release"
        ok "Unpacked NineDeploy $REF to $INSTALL_DIR"
      else
        warn "Could not unpack $REF into $INSTALL_DIR — falling back to git clone"
      fi
    else
      warn "Release tarball unavailable for $REF — falling back to git clone"
    fi
    rm -rf "$FRESH_STAGE"
  fi
  if [ -z "$SOURCE_MODE" ]; then
    info "Cloning NineDeploy to $INSTALL_DIR …"
    git clone --depth 1 ${REF:+-b "$REF"} "$REPO_URL" "$INSTALL_DIR"
    SOURCE_MODE="git"
  fi
  cd "$INSTALL_DIR"
fi

# Stamp what is on disk. `git describe` is unavailable in a tarball install,
# so without this an upgrade has no way to report the version it replaced.
printf '%s\n' "$REF" > "$INSTALL_DIR/$RELEASE_STAMP_FILE" 2>/dev/null || true

# A build artifact from the previous release is not overwritten by a checkout
# — dist/ is gitignored, so an upgrade that rebuilds nothing keeps serving the
# old panel bundle, which is exactly the "upgraded but the UI still shows the
# previous version" failure. Drop the artifacts and the turbo cache so the
# build below cannot be skipped.
info "Clearing build artifacts from the previous release…"
rm -rf .turbo apps/*/.turbo packages/*/.turbo 2>/dev/null || true
rm -rf apps/*/dist packages/*/dist 2>/dev/null || true
rm -rf node_modules/.cache node_modules/.vite 2>/dev/null || true
if [ "$FORCE_REFRESH" = "1" ] && [ "$SOURCE_MODE" = "git" ]; then
  # Untracked leftovers can shadow a moved or renamed source file. .data,
  # .env and the upgrade backups are gitignored on purpose and must survive,
  # so clean only what git tracks as ignored *build* output — never -x.
  # A release-tarball install has no git index; upgrade_from_release already
  # replaced the source directories wholesale.
  git clean -fd -e .data -e .env -e '*.local' >/dev/null 2>&1 || true
fi

# ── 3. Install + build ────────────────────────────────────────────────────
#
# pnpm prints nothing without a TTY — on a cold host `pnpm install` alone runs
# 10-20 silent minutes, which every operator to date has read as a hung
# installer (two documented kills mid-build). Both steps get heartbeats and a
# failure log tail.

info "Installing dependencies… (silent — heartbeats every 30s; often 10-20 min on a cold host)"
# Fail-CLOSED on lockfile drift. The previous behaviour fell back to a bare
# `pnpm install`, which re-resolves the whole dependency graph ON A PRODUCTION
# HOST and immediately runs the lifecycle scripts of whatever versions the
# registry hands out — turning a mismatched lockfile into a supply-chain
# event. The loose path is now an explicit operator decision.
if ! run_quiet_step "pnpm install" pnpm install --frozen-lockfile; then
  if [ "${NINEDEPLOY_ALLOW_LOOSE_INSTALL:-0}" = "1" ]; then
    warn "Frozen install failed — retrying with a regenerated lockfile (NINEDEPLOY_ALLOW_LOOSE_INSTALL=1)."
    run_quiet_step "pnpm install (retry)" pnpm install \
      || fail "pnpm install failed — see the log tail above"
  else
    fail "pnpm install --frozen-lockfile failed: the lockfile does not match package.json (or the registry is unreachable). Fix the checkout, or re-run with NINEDEPLOY_ALLOW_LOOSE_INSTALL=1 to explicitly accept a re-resolved dependency graph on this host."
  fi
fi

info "Building the panel, API and CLI… (silent — often 5-10 min)"
run_quiet_step "pnpm build" pnpm build \
  || fail "pnpm build failed — see the log tail above"

# Prove the tree that was just built is the one that was requested. A silent
# mismatch here is the difference between "upgraded" and "still on the old
# release but nobody noticed".
BUILT_VERSION=$(node -p "require('${INSTALL_DIR}/package.json').version" 2>/dev/null || echo "unknown")
if [ "$REF" = "main" ]; then
  ok "Built NineDeploy ${BUILT_VERSION} from main ($(git rev-parse --short HEAD 2>/dev/null || echo unknown))"
elif [ "v${BUILT_VERSION}" = "$REF" ]; then
  ok "Built NineDeploy ${BUILT_VERSION} (matches $REF)"
else
  warn "Checked out $REF but package.json reports ${BUILT_VERSION} — the tag and the manifest disagree."
fi
if [ ! -f "${INSTALL_DIR}/apps/web/dist/index.html" ]; then
  fail "The web panel did not build (apps/web/dist/index.html is missing). Re-run with --force."
fi

# Link global CLI executable
if [ -f "$INSTALL_DIR/apps/cli/dist/index.js" ]; then
  chmod +x "$INSTALL_DIR/apps/cli/dist/index.js" 2>/dev/null || true
  sudo ln -sf "$INSTALL_DIR/apps/cli/dist/index.js" /usr/local/bin/ninedeploy 2>/dev/null || true
  ok "CLI symlinked to /usr/local/bin/ninedeploy"
fi

# ── 4. Configure ──────────────────────────────────────────────────────────

if [ ! -f ".env" ]; then
  info "Creating .env from template…"
  # Tighten the umask BEFORE the file exists: `cp` then `chmod 600` at the end
  # leaves the generated JWT secret and master key world-readable (default
  # umask 022) for the duration of the sed passes below. `sed -i` also creates
  # its temp file under the same umask.
  _nd_old_umask=$(umask)
  umask 077
  cp .env.example .env

  # Set production mode
  sed -i.bak "s|^NODE_ENV=.*|NODE_ENV=production|" .env && rm -f .env.bak

  # Generate strong 32-byte hex secrets (64 chars)
  JWT_SECRET=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  sed -i.bak "s|^NINEDEPLOY_JWT_SECRET=.*|NINEDEPLOY_JWT_SECRET=${JWT_SECRET}|" .env && rm -f .env.bak

  MASTER_KEY=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  sed -i.bak "s|^NINEDEPLOY_MASTER_KEY=.*|NINEDEPLOY_MASTER_KEY=${MASTER_KEY}|" .env && rm -f .env.bak

  chmod 600 .env
  umask "$_nd_old_umask"

  ok ".env created with generated production secrets"
else
  chmod 600 .env
  ok ".env already exists"
fi

mkdir -p .data

info "Running database migrations…"
# Export .env first: drizzle.config reads NINEDEPLOY_DB_PATH/NINEDEPLOY_DATA_DIR
# from the environment, so without this the migrate step could target a
# different database file than the one the service actually runs on.
set -a
# shellcheck disable=SC1091
. ./.env
set +a
if [ -z "${NINEDEPLOY_ACME_EMAIL:-}" ]; then
  ACME_INPUT=""
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf "Let's Encrypt account email (required for automatic HTTPS; Enter to configure later): " > /dev/tty
    IFS= read -r ACME_INPUT < /dev/tty || ACME_INPUT=""
  fi
  if [ -n "$ACME_INPUT" ] && printf '%s' "$ACME_INPUT" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; then
    sed -i.bak "s|^NINEDEPLOY_ACME_EMAIL=.*|NINEDEPLOY_ACME_EMAIL=${ACME_INPUT}|" .env && rm -f .env.bak
    export NINEDEPLOY_ACME_EMAIL="$ACME_INPUT"
    ok "Automatic HTTPS configured for $ACME_INPUT"
  else
    [ -z "$ACME_INPUT" ] || warn "The supplied ACME email is invalid and was not saved."
    warn "Automatic HTTPS is not active yet: set the Let's Encrypt account email in Settings -> Security after signing in. NineDeploy will apply it to Traefik immediately."
  fi
fi
pnpm db:migrate

# ── 5. Systemd (Linux) ────────────────────────────────────────────────────

if [ "$(uname -s)" = "Linux" ] && command -v systemctl &>/dev/null; then
  info "Setting up systemd service…"
  # Render the CHECKED-IN hardened unit (systemd/ninedeploy.service) with this
  # install's paths so the installer and the repo unit never drift apart.
  # Placeholders: @NODE@, @INSTALL_DIR@, @DATA_DIR@.
  UNIT_TEMPLATE="$INSTALL_DIR/systemd/ninedeploy.service"
  if [ ! -f "$UNIT_TEMPLATE" ]; then
    fail "systemd/ninedeploy.service not found in the repo — re-run ./install.sh"
  fi
  DATA_DIR_SETTING="${NINEDEPLOY_DATA_DIR:-$INSTALL_DIR/.data}"
  mkdir -p "$DATA_DIR_SETTING"
  # Environment files commonly use NINEDEPLOY_DATA_DIR=./.data. systemd
  # requires every ReadWritePaths= operand to be absolute, so resolve the
  # configured directory from the installer's current INSTALL_DIR before
  # rendering the unit.
  DATA_DIR=$(cd "$DATA_DIR_SETTING" && pwd -P)
  # Writable homes for the toolchains the panel spawns: DOCKER_CONFIG (buildx
  # builder-activity writes) and PM2_HOME (dump.pm2 persistence). Both default
  # to /root/... which the hardened unit's ProtectHome=read-only makes
  # unwritable — the unit exports these env vars pointing here.
  mkdir -p "$DATA_DIR/docker-config" "$DATA_DIR/pm2"
  SERVICE_FILE="/etc/systemd/system/ninedeploy.service"
  UNIT_STAGE_DIR=$(mktemp -d)
  UNIT_STAGE_FILE="$UNIT_STAGE_DIR/ninedeploy.service"
  sed -e "s|@NODE@|$(which node)|g" \
      -e "s|@INSTALL_DIR@|${INSTALL_DIR}|g" \
      -e "s|@DATA_DIR@|${DATA_DIR}|g" \
      -e "s|@USER@|root|g" \
      -e "s|@GROUP@|root|g" \
      "$UNIT_TEMPLATE" > "$UNIT_STAGE_FILE"

  # Validate before replacing the live unit. This catches malformed rendered
  # paths without leaving an existing installation unbootable.
  if command -v systemd-analyze &>/dev/null; then
    systemd-analyze verify "$UNIT_STAGE_FILE" >/dev/null || {
      rm -f "$UNIT_STAGE_FILE"
      rmdir "$UNIT_STAGE_DIR"
      fail "Rendered systemd unit is invalid"
    }
  fi
  sudo install -m 0644 "$UNIT_STAGE_FILE" "$SERVICE_FILE"
  rm -f "$UNIT_STAGE_FILE"
  rmdir "$UNIT_STAGE_DIR"

  # Older NineDeploy releases installed Type=notify + WatchdogSec=90. A
  # lingering drop-in can override the new main unit and SIGTERM the server
  # (and its docker pull child) during a long image extraction. Keep this
  # installer-owned, last-applied safety override for both fresh installs and
  # in-place upgrades. User overrides that sort later are detected below.
  RUNTIME_DROPIN_DIR="/etc/systemd/system/ninedeploy.service.d"
  RUNTIME_DROPIN="$RUNTIME_DROPIN_DIR/zzzz-ninedeploy-runtime-safety.conf"
  sudo mkdir -p "$RUNTIME_DROPIN_DIR"
  # v0.2.4 briefly used a numeric prefix which sorts before the conventional
  # override.conf name. Remove only that installer-owned obsolete file; keep
  # every administrator-owned drop-in intact.
  sudo rm -f "$RUNTIME_DROPIN_DIR/99-ninedeploy-runtime-safety.conf"
  printf '%s\n' \
    '# Managed by NineDeploy install.sh — do not enable a service watchdog.' \
    '[Service]' \
    'Type=simple' \
    'WatchdogSec=0' | sudo tee "$RUNTIME_DROPIN" >/dev/null

  sudo systemctl daemon-reload

  EFFECTIVE_TYPE=$(systemctl show ninedeploy --property=Type --value)
  EFFECTIVE_WATCHDOG=$(systemctl show ninedeploy --property=WatchdogUSec --value)
  if [ "$EFFECTIVE_TYPE" != "simple" ]; then
    fail "Unsafe effective systemd Type=$EFFECTIVE_TYPE (expected simple); inspect: systemctl cat ninedeploy"
  fi
  case "$EFFECTIVE_WATCHDOG" in
    # Modern systemd (v240+) reports a DISABLED watchdog as "infinity", not
    # "0" — most visibly on never-started units during fresh installs. Both
    # spellings mean "will never fire": accept them, reject real intervals.
    0|0us|0ms|0s|infinity|infinityus) ;;
    *) fail "Unsafe effective systemd watchdog $EFFECTIVE_WATCHDOG (expected disabled); inspect: systemctl cat ninedeploy" ;;
  esac
  ok "systemd runtime policy verified (Type=simple, watchdog disabled)"

  # The service runs as root. When the code tree lives inside the invoking
  # user's HOME, everything root executes — and the .env it reads — is
  # writable by that user, which is a quiet path from "panel user" to "root
  # code execution" on the next restart. Locking ownership is a deliberate,
  # opt-in step because it also requires future updates to run under sudo.
  case "$INSTALL_DIR" in
    "$HOME"/*)
      if [ "${NINEDEPLOY_HARDEN_OWNERSHIP:-0}" = "1" ]; then
        sudo chown -R root:root "$INSTALL_DIR"
        ok "Install tree handed to root (NINEDEPLOY_HARDEN_OWNERSHIP=1)."
        warn "Future updates must run the installer under sudo: sudo -E ./install.sh"
      else
        warn "The root service runs code from a user-writable tree: $INSTALL_DIR"
        warn "Harden it by re-running with NINEDEPLOY_HARDEN_OWNERSHIP=1 (future updates then need sudo)."
      fi
      ;;
  esac

  sudo systemctl enable ninedeploy
  sudo systemctl restart ninedeploy

  # Everything the operator would otherwise have to go and collect by hand.
  # A readiness failure is the single most common place an install ends, and
  # "inspect journalctl" costs a round trip that the installer can spend for
  # them — it already knows the unit name, the port and the data directory.
  dump_service_diagnostics() {
    echo ""
    warn "── systemd unit ────────────────────────────────────────────────"
    systemctl --no-pager --full status ninedeploy 2>&1 | head -20 || true
    echo ""
    warn "── last 60 log lines (journalctl -u ninedeploy) ─────────────────"
    sudo journalctl -u ninedeploy -n 60 --no-pager 2>&1 || true
    echo ""
    warn "── port ${HEALTH_PORT} ─────────────────────────────────────────────────"
    (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null || true) | grep -E "[:.]${HEALTH_PORT}[[:space:]]" || echo "  nothing is listening on ${HEALTH_PORT}"
    echo ""
  }

  # Readiness gate: give the API time to answer /health before declaring
  # success — a failed migration or boot crash surfaces here, not later.
  #
  # The window is generous because the first boot after an upgrade also runs
  # migrations, but a process that is *not running* is never going to answer,
  # so a crash-loop is called immediately rather than after the full timeout.
  HEALTH_PORT="${NINEDEPLOY_PORT:-3000}"
  HEALTH_TIMEOUT="${NINEDEPLOY_HEALTH_TIMEOUT:-120}"
  info "Waiting for the API to come up (up to ${HEALTH_TIMEOUT}s)…"
  if command -v curl &>/dev/null; then
    _health_ok=false
    _crash_strikes=0
    for i in $(seq 1 "$HEALTH_TIMEOUT"); do
      if curl -fsS -m 2 "http://127.0.0.1:${HEALTH_PORT}/health" >/dev/null 2>&1; then
        _health_ok=true
        break
      fi

      # `Restart=always` means a unit that dies is restarted, so a crashing
      # server oscillates between active and activating instead of settling
      # into `failed`. Count consecutive non-active samples: three in a row
      # is a boot that is not going to succeed, not a slow start.
      case "$(systemctl is-active ninedeploy 2>/dev/null || echo unknown)" in
        active)
          _crash_strikes=0
          ;;
        failed)
          warn "ninedeploy entered the failed state while starting"
          dump_service_diagnostics
          fail "Service failed to start. ${BACKUP_HINT:-No pre-update backup was taken}"
          ;;
        *)
          _crash_strikes=$((_crash_strikes + 1))
          if [ "$_crash_strikes" -ge 3 ]; then
            warn "ninedeploy is restarting repeatedly — it is crashing on boot"
            dump_service_diagnostics
            fail "Service is crash-looping. ${BACKUP_HINT:-No pre-update backup was taken}"
          fi
          ;;
      esac

      sleep 1
    done

    if [ "$_health_ok" = true ]; then
      ok "NineDeploy service is healthy (systemd, hardened unit)"
    else
      warn "The process is running but /health did not answer within ${HEALTH_TIMEOUT}s"
      dump_service_diagnostics
      fail "Service did not become healthy in ${HEALTH_TIMEOUT}s. Raise the window with NINEDEPLOY_HEALTH_TIMEOUT=<seconds> if this host is just slow. ${BACKUP_HINT:-No pre-update backup was taken}"
    fi
  else
    ok "NineDeploy service started (systemd, hardened unit)"
  fi

  # /health is only a valid installation gate when the mandatory ingress
  # container is also live on the shared network. Never print a successful
  # installation while domain routing is unavailable.
  TRAEFIK_RUNNING=$(docker_cmd inspect ninedeploy-traefik --format '{{.State.Running}}' 2>/dev/null || true)
  TRAEFIK_NETWORKS=$(docker_cmd inspect ninedeploy-traefik --format '{{json .NetworkSettings.Networks}}' 2>/dev/null || true)
  if [ "$TRAEFIK_RUNNING" != "true" ] || ! printf '%s' "$TRAEFIK_NETWORKS" | grep -q '"ninedeploy"'; then
    docker_cmd logs --tail 50 ninedeploy-traefik 2>&1 || true
    fail "Traefik failed its post-install runtime check; NineDeploy installation is not healthy"
  fi
  TRAEFIK_HTTP_STATUS=$(curl -sS -o /dev/null -m 5 -w '%{http_code}' -H 'Host: ninedeploy-install-check.invalid' http://127.0.0.1/ 2>/dev/null || true)
  case "$TRAEFIK_HTTP_STATUS" in
    2??|3??|4??) ;;
    *) docker_cmd logs --tail 50 ninedeploy-traefik 2>&1 || true; fail "Traefik is running but its HTTP entrypoint on :80 is not responding" ;;
  esac
  ok "Traefik ingress verified (network attached, :80 responding)"

  # ── Deploy preflight: prove a build actually works in this environment ──
  # The panel spawns `docker build` under the hardened unit (ProtectHome makes
  # /root read-only; buildx writes builder activity under $DOCKER_CONFIG), and
  # the operator's FIRST deploy is a miserable place to discover a broken
  # toolchain. A five-second scratch build — run with the same DOCKER_CONFIG
  # the unit exports — catches that class of failure here, while the installer
  # can still explain it.
  PROBE_DIR=$(mktemp -d)
  printf 'FROM scratch\nCOPY .keep /\n' > "$PROBE_DIR/Dockerfile"
  : > "$PROBE_DIR/.keep"
  if DOCKER_CONFIG="$DATA_DIR/docker-config" docker_cmd build -q -t ninedeploy-install-probe "$PROBE_DIR" >/dev/null 2>&1; then
    ok "Deploy preflight passed: docker build works (DOCKER_CONFIG=$DATA_DIR/docker-config)"
  else
    warn "Deploy preflight FAILED — \`docker build\` is broken in this environment, so the first deploy will fail too. Output:"
    PROBE_OUT=$(DOCKER_CONFIG="$DATA_DIR/docker-config" docker_cmd build -t ninedeploy-install-probe "$PROBE_DIR" 2>&1 || true)
    printf '%s\n' "$PROBE_OUT" | tail -8
    case "$PROBE_OUT" in
      *"read-only file system"*)
        warn "Known cause: buildx writing under a read-only /root. This release's unit exports DOCKER_CONFIG=$DATA_DIR/docker-config — verify with: systemctl show ninedeploy --property=Environment"
        ;;
    esac
  fi
  docker_cmd rmi ninedeploy-install-probe >/dev/null 2>&1 || true
  rm -rf "$PROBE_DIR"

  # PM2 boot resurrection: bare-metal deployments live in a PM2 daemon that
  # dies with every reboot — and with the panel restart above. The server
  # keeps /root/.pm2/dump.pm2 fresh after each lifecycle change; this unit
  # restores that dump at boot. It is a clean no-op until the first PM2
  # deployment writes a dump (ConditionPathExists).
  PM2_UNIT_TEMPLATE="$INSTALL_DIR/systemd/ninedeploy-pm2.service"
  PM2_CLI="$INSTALL_DIR/apps/server/node_modules/pm2/bin/pm2"
  if [ -f "$PM2_UNIT_TEMPLATE" ] && [ -f "$PM2_CLI" ]; then
    PM2_STAGE_DIR=$(mktemp -d)
    sed -e "s|@NODE@|$(which node)|g" \
        -e "s|@INSTALL_DIR@|${INSTALL_DIR}|g" \
        -e "s|@PM2_HOME@|${DATA_DIR}/pm2|g" \
        "$PM2_UNIT_TEMPLATE" > "$PM2_STAGE_DIR/ninedeploy-pm2.service"
    if ! command -v systemd-analyze &>/dev/null \
      || systemd-analyze verify "$PM2_STAGE_DIR/ninedeploy-pm2.service" >/dev/null 2>&1; then
      sudo install -m 0644 "$PM2_STAGE_DIR/ninedeploy-pm2.service" /etc/systemd/system/ninedeploy-pm2.service
      sudo systemctl daemon-reload
      sudo systemctl enable ninedeploy-pm2 >/dev/null 2>&1 || true
      # Also runs right now: on upgrades the panel restart above killed the
      # PM2 daemon's processes, and resurrect brings them straight back.
      sudo systemctl start ninedeploy-pm2 >/dev/null 2>&1 || true
      if systemctl is-failed --quiet ninedeploy-pm2 2>/dev/null; then
        sudo systemctl reset-failed ninedeploy-pm2 >/dev/null 2>&1 || true
        warn "PM2 resurrect unit failed to run; inspect: journalctl -u ninedeploy-pm2 -n 30"
      else
        ok "PM2 deployments are restored at boot (ninedeploy-pm2.service)"
      fi
    else
      warn "Rendered ninedeploy-pm2 unit failed verification; PM2 deployments will not auto-restore at boot"
    fi
    rm -rf "$PM2_STAGE_DIR"
  else
    warn "PM2 CLI or unit template not found; bare-metal deployments will not auto-restore at boot"
  fi
else
  warn "systemd not available — starting in foreground…"
  info "For production, set up a process manager (systemd/pm2/launchd)."
fi

# ── 6. Print summary ──────────────────────────────────────────────────────

HOST="${NINEDEPLOY_HOST:-0.0.0.0}"
PORT="${NINEDEPLOY_PORT:-3000}"
PUBLIC_URL="${NINEDEPLOY_PUBLIC_URL:-http://localhost:3000}"

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║       ✓ Installation Complete            ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}Dashboard:${NC}  ${PUBLIC_URL}"
echo -e "  ${CYAN}API:${NC}       ${PUBLIC_URL}/health"
echo ""
echo -e "  ${YELLOW}Next steps:${NC}"
echo -e "  1. Open ${PUBLIC_URL} in your browser"
echo -e "  2. Create your admin account (first-run setup)"
echo -e "  3. Deploy your first service from the Hub or a Git repo"
echo ""
if [ "$(uname -s)" = "Linux" ]; then
  echo -e "  ${CYAN}Manage:${NC}"
  echo -e "  sudo systemctl status ninedeploy"
  echo -e "  sudo systemctl restart ninedeploy"
  echo -e "  journalctl -u ninedeploy -f"
fi
echo ""
echo -e "  ${CYAN}CLI:${NC}"
echo -e "  npx ninedeploy init      # complete initial admin setup"
echo -e "  npx ninedeploy doctor    # run diagnostic check"
echo -e "  npx ninedeploy services list"
echo ""
