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
ninedeploy services logs <id>          # Stream runtime container logs
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

---

## 📄 License

MIT © [NineDeploy](https://github.com/NineDeploy/NineDeploy)
