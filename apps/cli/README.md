# 🚀 NineDeploy CLI (`ninedeploy`)

> Interactive Command Line Interface for [NineDeploy](https://github.com/NineDeploy/NineDeploy) — Self-hosted PaaS & Deployment Platform.

[![npm version](https://img.shields.io/npm/v/ninedeploy.svg)](https://www.npmjs.com/package/ninedeploy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

NineDeploy CLI allows you to deploy applications, manage databases, stream build/runtime logs, monitor infrastructure health, and configure ingress directly from your terminal.

---

## ⚡ How It Works

NineDeploy is composed of two main parts:
1. **NineDeploy Server (Core PaaS Engine)**: Runs on your server/VPS (via Docker or Linux systemd). It manages Docker containers, Traefik reverse proxy, databases, SSL certificates, and deployments.
2. **NineDeploy CLI (`ninedeploy`)**: The client tool you install on your machine to interact with your NineDeploy server.

```
┌────────────────────────────────────────────────────────┐
│  NineDeploy Server (Runs on VPS / Docker)              │
│  - Docker / Traefik / SQLite / Blue-Green Engine       │
│  - Port 3000 (API & Dashboard)                         │
└──────────────────────────┬─────────────────────────────┘
                           │ HTTP / WebSocket API
┌──────────────────────────▼─────────────────────────────┐
│  NineDeploy CLI (npm install -g ninedeploy)            │
│  - Terminal commands on your local machine             │
│  - Communicates with the server URL                    │
└────────────────────────────────────────────────────────┘
```

---

## 📦 Quick Start Guide

### Step 1: Start Your NineDeploy Server

Before using the CLI, ensure you have a NineDeploy server running:

* **With Docker (Quickest)**:
  ```bash
  docker run -d --name ninedeploy \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v ninedeploy-data:/data \
    -p 3000:3000 \
    -e NINEDEPLOY_JWT_SECRET=$(openssl rand -hex 32) \
    ghcr.io/ninedeploy/ninedeploy:latest
  ```

* **On Bare-Metal Linux VPS**:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/NineDeploy/NineDeploy/main/install.sh | bash
  ```

---

### Step 2: Install the CLI

Install `ninedeploy` globally via npm, pnpm, or bun:

```bash
npm install -g ninedeploy
```

---

### Step 3: Initial Setup & Login

If you just started, create your administrator account:

```bash
ninedeploy setup
```
> 💡 **Automatic Docker Bootstrapping**: If you don't have a NineDeploy server running yet, `ninedeploy setup` will automatically detect Docker and offer to start a local server container for you!

Or connect to an existing remote server:

```bash
# Point to your server URL (if not localhost:3000)
ninedeploy config --server https://panel.yourdomain.com

# Log in
ninedeploy login
```

Verify your authentication:
```bash
ninedeploy whoami
```

---

## 🛠️ CLI Commands Overview

### 🖥️ Local Server Management (Docker)
```bash
ninedeploy server start               # Start local NineDeploy server container
ninedeploy server stop                # Stop local server container
ninedeploy server status              # Check local container and HTTP API health
ninedeploy server logs                # Stream local server container logs
```

### 🚀 Applications & Services
```bash
ninedeploy services list               # List all running services
ninedeploy services create             # Interactive wizard (Git repo or Docker image)
ninedeploy services get <id>           # Detailed service inspection
ninedeploy services deploy <id>        # Trigger a blue-green zero-downtime deployment
ninedeploy services logs <id>          # Newest runtime log lines (--tail N, --grep text)
ninedeploy services compose <id>       # View generated Docker Compose YAML
ninedeploy services stop <id>          # Stop a service
ninedeploy services start <id>         # Start a stopped service
ninedeploy services restart <id>       # Restart a service
ninedeploy services delete <id>        # Delete a service
```

### 🗄️ Managed Databases
```bash
ninedeploy databases list              # List all managed databases
ninedeploy databases create            # Provision Postgres, MySQL, Redis, MongoDB, or ClickHouse
ninedeploy backups list [dbId]         # List database backup snapshots
ninedeploy backups create <dbId>       # Trigger an immediate backup snapshot
ninedeploy backups restore <dbId> <id> # Restore from a backup snapshot
```

### 📦 1-Click Templates
```bash
ninedeploy templates list              # Browse verified application templates
ninedeploy templates deploy <id>       # Deploy WordPress, Next.js, Ghost, Strapi, etc.
```

### 🔑 Environment Variables & Secrets
```bash
ninedeploy env list <serviceId>                    # List environment variables
ninedeploy env set <serviceId> KEY VALUE           # Set encrypted secret
ninedeploy env set <serviceId> KEY VALUE --public  # Set public env variable
ninedeploy env rm <serviceId> KEY                  # Remove variable
ninedeploy env set <serviceId> KEY VALUE --preview # Value only this service's PR previews receive (also: list/rm --preview)
```

### 🌐 Domains & Routing
```bash
ninedeploy domains list                            # List configured routing rules
ninedeploy domains add <serviceId> app.domain.com  # Route domain with automatic Let's Encrypt SSL
ninedeploy domains rm <serviceId> <domainId>       # Remove domain rule
```

### 📊 System Health, Diagnostics & Monitoring
```bash
ninedeploy doctor                      # Run full diagnostics (Node, Docker, Server, Auth)
ninedeploy system info                 # Display system version, tech stack & telemetry
ninedeploy system dashboard            # Interactive live terminal dashboard
ninedeploy system update-check         # Check for newer releases
ninedeploy system prune                # Housekeeping prune (dangling containers & cache)
```

### 📡 Uptime Monitors & Status Pages (0.16.8)
```bash
ninedeploy monitors list [--service <id|slug>] [--json]       # Status, 24h / 30d uptime, last response
ninedeploy monitors add site https://app.example.com/health   # HTTP(S); host:port (or --tcp) is a TCP check
ninedeploy monitors show|check|pause|resume|rm <id>           # Details + last 10 checks, check now, pause, delete
ninedeploy status-pages add acme "Acme status" --monitor 1 2 --publish
ninedeploy status-pages publish|unpublish|rm <id>
ninedeploy status-pages notice <id> "Maintenance at 22:00"    # --clear removes it
```

### 🐤 Canary Releases (0.16.9)
```bash
ninedeploy canary show web [--json]                     # Configuration, and the running canary: step, share, 5xx %, p95
ninedeploy canary set web --steps 10,50 --max-p95 800   # Options not given keep their value; --max-p95 off stops judging it
ninedeploy canary off web                               # The next deploy switches all traffic at once
ninedeploy canary promote web [--deployment <id>]       # Skip the remaining steps; stop one with `deploys cancel`
```

### 📈 Autoscaling (0.16.10)
```bash
ninedeploy autoscale show web [--json]                        # Bounds, metric and target, containers serving, last value, desired count, last change
ninedeploy autoscale set web --max 4 --target 70              # Turn it on (cpu by default); --metric memory|rps, --min, --up-seconds, --down-seconds
ninedeploy autoscale set web --metric rps --target 200        # Options not given keep their value; rps needs traffic analytics
ninedeploy autoscale off web                                  # The next deploy runs the fixed replicas again
```
Turning it on applies fully at the next deploy, which creates the spare containers.

### 💤 Scale to Zero (0.16.11)
```bash
ninedeploy sleep show web [--json]     # "sleeps after N minutes without a request" or "never sleeps"; asleep now, and since when
ninedeploy sleep set web 30            # Sleep after 30 minutes without a request (5-1440)
ninedeploy sleep off web               # Never sleep
ninedeploy sleep now web               # Sleep now, even without a setting
ninedeploy sleep wake web              # Wake it now; the next request, `services start` and `services restart` wake it too
```
Docker services on the panel host. It needs traffic analytics on (Traefik → Traffic) and a routed domain: requests are counted from the traffic log, and a request through a domain wakes it. The containers, volumes and variables stay as they are while it sleeps.

### 🧪 A Database Copy per PR Preview (0.16.12)
```bash
ninedeploy previews show web [--json]           # Previews on/off, auto-destroy, database copies, domain pattern, max active
ninedeploy previews database-copies web on      # Give each preview its own database copies (off turns it off)
```
Each PR preview gets a copy of the attached PostgreSQL and Redis-family databases, made from the latest backup, named `<database> · PR #<n>`; the copies are removed with the preview. MySQL, MariaDB and MongoDB are not copied yet.

---

## 📄 License

MIT © [NineDeploy](https://github.com/NineDeploy/NineDeploy)
