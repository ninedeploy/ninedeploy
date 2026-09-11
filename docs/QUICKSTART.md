# Quickstart Guide

This guide walks you through installing, configuring, upgrading, and running **NineDeploy**.

---

## ⚡ 1. Production Installation (Bare-Metal / Recommended)

Bare-metal Linux is the recommended production deployment mode: NineDeploy runs as a hardened systemd service with direct Docker daemon and PM2 process management.

```bash
curl -fsSL https://raw.githubusercontent.com/NineDeploy/NineDeploy/main/install.sh | bash
```

### What the installer does:
1. Detects or installs **Node.js (≥22.13)** and **pnpm (v11 via Corepack)**.
2. Verifies Docker daemon connectivity.
3. Clones or updates the repository to `~/ninedeploy`.
4. Builds the monorepo packages.
5. Generates a secure `.env` file with random 32-byte JWT secrets.
6. Runs initial SQLite migrations via Drizzle.
7. Installs and starts the hardened `ninedeploy.service` under systemd.

### Hardened Systemd Service Features:
- `Type=simple` with `WatchdogSec=0`; long Docker pulls and builds are never terminated by a service watchdog.
- Installer-managed migration override and effective-policy verification repair older `Type=notify` installations during an in-place upgrade.
- `ProtectSystem=full` with explicit write access for the install/data directories, temporary files and Docker socket.
- `NoNewPrivileges=true` and `PrivateTmp=true`.
- `Restart=always` with a five-second restart delay; `/health` is the authoritative installer readiness gate.

---

## 🐳 2. Docker Installation (Containerized)

The installer supports this mode directly — pass `--docker` (or set
`NINEDEPLOY_INSTALL_MODE=docker`). It installs only Docker on the host, fetches
the pinned compose file, generates the secrets into a 0600 `.env`, and runs the
panel container; re-running the same command upgrades it (secrets and data
volume are preserved, and an existing bare-metal install is never clobbered):

```bash
curl -fsSL https://raw.githubusercontent.com/NineDeploy/NineDeploy/main/install.sh | bash -s -- --docker
```

Without the installer, the standalone production compose file is the
one-command path (it refuses to boot without a strong `NINEDEPLOY_JWT_SECRET`,
adds a restart policy and the health-gated readiness check):

```bash
echo "NINEDEPLOY_JWT_SECRET=$(openssl rand -hex 32)" >> .env
echo "DOCKER_GID=$(getent group docker | cut -d: -f3)" >> .env
docker compose -f docker-compose.prod.yml up -d
```

Or run the image directly:

```bash
docker run -d --name ninedeploy \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add $(getent group docker | cut -d: -f3) \
  -v ninedeploy-data:/data \
  -p 3000:3000 \
  -e NINEDEPLOY_DATA_DIR=/data \
  -e NINEDEPLOY_DB_PATH=/data/ninedeploy.db \
  -e NINEDEPLOY_JWT_SECRET=$(openssl rand -hex 32) \
  -e NINEDEPLOY_PUBLIC_URL=https://your-domain.com \
  ghcr.io/ninedeploy/ninedeploy:latest
```

> **Note on Permissions**: The `--group-add` argument is required so the non-root `ninedeploy` user inside the container can interact with the host's `/var/run/docker.sock`.

> **What differs from bare-metal**: PM2-type services (host processes) and UFW
> firewall management are only available via the bare-metal installer. Docker
> and Compose deploys, managed databases, Traefik ingress and encrypted S3
> backups work identically — the panel drives them as host sibling containers
> through the mounted socket.

---

## 💻 3. Local Development from Source

```bash
# 1. Clone the repository
git clone https://github.com/NineDeploy/NineDeploy.git
cd NineDeploy

# 2. Install dependencies & build
pnpm install
cp .env.example .env
pnpm build

# 3. Start development server (API on :3000, Web UI on :5173)
pnpm dev
```

Open `http://localhost:5173` in your browser to create the initial admin account.

---

## 🔄 4. Upgrading NineDeploy

### In-Place Upgrade (Bare-Metal):
Re-running the installation script performs a seamless, zero-data-loss upgrade:
```bash
# Upgrade to latest release tag (default)
curl -fsSL https://raw.githubusercontent.com/NineDeploy/NineDeploy/main/install.sh | bash

# Pin to a specific version
bash install.sh --version v0.7.9

# Track edge (main branch)
bash install.sh --channel main

# Discard local modifications and rebuild from scratch
bash install.sh --force
```

**Where the code comes from**: on the `release` channel the installer downloads the source tarball GitHub publishes for the tag (`/archive/refs/tags/vX.Y.Z.tar.gz`) — no git required on the host. It falls back to a git clone when the tarball is unreachable, and the `main` channel always uses git. The resolved tag is looked up from `git ls-remote`, then the GitHub releases API, then the tags API, so a single unavailable source cannot pin you to a stale version.

**Upgrade Safety Mechanism**:
Before pulling updates or applying migrations, the installer automatically snapshots `.data/ninedeploy.db` and `.data/master.key` to `.data/upgrade-backups/pre-update-YYYYMMDD-HHMMSS.tar.gz`. Build output (`dist/`, the turbo cache) is always cleared before rebuilding, so an upgrade can never leave the previous release's panel bundle in place, and the installer fails if `apps/web/dist/index.html` is missing after the build.

### Docker Upgrade:
```bash
# Compose installs (docker-compose.prod.yml):
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d

# Plain `docker run` installs: stop + remove, then re-run your original
# command with the existing ninedeploy-data volume and a fresh image:
docker pull ghcr.io/ninedeploy/ninedeploy:latest
docker stop ninedeploy && docker rm ninedeploy
```
Migrations apply automatically upon server boot.

### One-Click Self-Update (Bare-Metal Panels):
On systemd bare-metal installations an operator can upgrade the panel from the dashboard itself — an amber banner appears under the header when a new release is available (and the same button lives on **About**). Confirming it runs this install's own installer for the pinned release tag: snapshot of `.data`, source swap, rebuild, migrations, service restart. The panel is briefly offline mid-run (~5–15 minutes) while deployed services keep running; progress survives the restart and reports success or failure with the installer output tail. Container-mode installs don't offer self-update — pull the new image instead.

---

## ⚙️ 5. Key Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `NINEDEPLOY_PORT` | `3000` | HTTP port for API & built Web Dashboard |
| `NINEDEPLOY_HOST` | `127.0.0.1` | Binding address (`0.0.0.0` in Docker) |
| `NINEDEPLOY_DATA_DIR` | `./.data` | Directory for SQLite DB, repos, logs, backups |
| `NINEDEPLOY_DB_PATH` | `./.data/ninedeploy.db` | Absolute path to SQLite database file |
| `NINEDEPLOY_JWT_SECRET` | *(required)* | 32-byte hex key for signing user auth tokens |
| `NINEDEPLOY_MASTER_KEYS` | *(optional)* | Key ring for AES-256-GCM secret rotation (e.g. `0:hex,1:hex`) |
| `NINEDEPLOY_PUBLIC_URL` | `http://localhost:3000` | Public root URL for webhooks and OAuth redirects |

---

## 💻 6. Managing with the Terminal CLI (`ninedeploy`)

Once your server is running, install the CLI on your development machine to manage deployments directly from your terminal:

```bash
# 1. Install CLI globally
npm install -g ninedeploy

# 2. Complete initial administrator setup (for a new server)
ninedeploy setup

# Or authenticate with an existing instance:
ninedeploy config --server https://panel.yourdomain.com
ninedeploy login

# 3. Check status and manage services
ninedeploy whoami
ninedeploy services list
ninedeploy system dashboard
```
