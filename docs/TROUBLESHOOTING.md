# Operational Troubleshooting & Diagnostics

Common operational edge cases, recovery steps, and diagnostic procedures for NineDeploy.

---

## 🔁 0. Nothing Comes Back After a Host Reboot

**Symptoms**:
- After rebooting the server, NineDeploy, Traefik and deployed containers are all down.

**Resolution**:
1. Check whether the Docker daemon is running and boot-enabled — every container's restart policy depends on it, and the `ninedeploy` unit requires it:
   ```bash
   systemctl status docker ninedeploy --no-pager
   systemctl is-enabled docker ninedeploy
   ```
   If Docker is disabled, re-running the installer fixes it permanently (`sudo systemctl enable docker` is the immediate repair).
2. Containers stopped manually before the reboot stay stopped (`unless-stopped` semantics). List and start them:
   ```bash
   docker ps -a
   docker start <container>
   ```
3. Bare-metal (PM2) deployments are restored at boot by the `ninedeploy-pm2` systemd unit from the dump the panel refreshes after each start/stop. If the unit is missing or the dump is stale, re-run the installer or redeploy the service:
   ```bash
   systemctl status ninedeploy-pm2 --no-pager
   ```

**The panel says "running" but nothing is actually running**:
The service status used to record the *last lifecycle result*, so a reboot or daemon outage left stale `running` rows. The panel now self-heals: at startup and every 60 seconds it compares each local service's desired state with the live runtime and **revives** anything the panel believes should be running — stopped containers are `docker start`ed (Compose sidecars come along), a dead PM2 daemon is resurrected from the dump and stopped processes restarted. Only a runtime that was deleted (needs a redeploy) is downgraded to `error`. Lifecycle actions also report the truth: starting/restarting a runtime that no longer exists returns **409** (redeploy required), and a Docker daemon that cannot be reached returns **503** instead of a fake success.

---

## 🛑 1. Docker Daemon / Socket Permission Denied

**Symptoms**:
- Deployment logs show `Cannot connect to the Docker daemon at unix:///var/run/docker.sock`.
- Service container creation fails with `permission denied`.

**Resolution**:
- If running under **bare-metal**:
  ```bash
  sudo usermod -aG docker ninedeploy
  sudo systemctl restart ninedeploy
  ```
- If running under **Docker**:
  Ensure the host's docker group GID is passed via `--group-add`:
  ```bash
  docker run ... --group-add $(getent group docker | cut -d: -f3) ...
  ```

---

## 🔒 2. Database Locked (`SQLITE_BUSY`)

**Symptoms**:
- API responses return `database is locked` during concurrent high-throughput operations.

**Resolution**:
1. Check for long-running backup processes holding locks.
2. Ensure WAL (Write-Ahead Logging) mode is active:
   ```bash
   sqlite3 .data/ninedeploy.db "PRAGMA journal_mode=WAL;"
   ```
3. Restart the systemd service to flush pending transactions.

---

## 🩺 3. Healthcheck Flapping & Deployment Timeouts

**Symptoms**:
- Blue-green deployment times out and rolls back after container boot.

**Resolution**:
1. Check the service's internal health check path (`/health`, `/api/health`, or custom port).
2. Inspect new container logs before teardown:
   ```bash
   ninedeploy services logs <service-id>
   ```
3. Increase `healthCheckTimeout` in service configuration if the application has a long cold-start initialization phase.

---

## 🌐 4. Let's Encrypt Certificate Issuance Failures

**Symptoms**:
- Service routes return self-signed Traefik default certificate instead of valid Let's Encrypt certificate.

**Resolution**:
1. Verify DNS records: Ensure both apex and subdomains point directly to your server's public IP address (`A` record).
2. Ensure port `80` and `443` are open and not blocked by cloud provider firewalls / security groups (AWS Security Groups, Hetzner Firewall, UFW).
3. If using Cloudflare proxy (orange cloud), ensure SSL mode is set to **Full (Strict)**.

---

## 🔌 5. CLI Connection & Server Discovery Failures

**Symptoms**:
- Running `ninedeploy services list` or `ninedeploy init` prints `fetch failed` or `ECONNREFUSED`.

**Resolution**:
1. Run `ninedeploy doctor` to test network and socket connectivity.
2. Check configured target server URL:
   ```bash
   ninedeploy config
   ```
3. If connecting to a remote server, update the base URL:
   ```bash
   ninedeploy config --server https://panel.yourdomain.com
   ```
4. If connecting locally, check if the Docker container is active:
   ```bash
   ninedeploy server status
   ninedeploy server start
   ```

---

## 🐳 6. Local Server Container Conflicts & Port Collisions

**Symptoms**:
- `ninedeploy server start` fails with `port is already allocated` or `Conflict. The container name "/ninedeploy" is already in use`.

**Resolution**:
1. **Port in use**: If another service occupies port 3000, specify a custom port:
   ```bash
   ninedeploy server start --port 3001
   ninedeploy config --server http://localhost:3001
   ```
2. **Container conflict**: Remove stale or orphaned containers:
   ```bash
   docker rm -f ninedeploy
   ninedeploy server start
   ```

---

## 🩺 7. Running Full Health Diagnostics

Whenever encountering unexpected behavior, run the built-in doctor utility:
```bash
ninedeploy doctor
```
This inspects:
- Node.js runtime and architecture
- Docker daemon status and server container state
- NineDeploy HTTP API response and latency
- Local session token validity and user roles

---

## 🛑 8. Docker Pull Exits with Code 143 (SIGTERM)

**Symptoms**:
- Pulling or deploying large Docker images/templates (e.g. `n8nio/n8n`, `supabase`, `postgres`) fails with:
  ```
  ✗ Deployment failed: `docker pull n8nio/n8n` exited with code 143
  ```

**Cause**:
- Exit code 143 is `128 + SIGTERM (15)`: an external supervisor terminated the Docker CLI. Older NineDeploy units used `Type=notify` with `WatchdogSec=90`; unreliable watchdog notification could terminate the server cgroup during a long pull.
- Linux OOM termination normally uses `SIGKILL` and surfaces as exit code 137, not 143.

**Resolution**:
1. **Run the current installer over the existing installation**. It replaces the unit, installs a migration safety override and refuses to start unless effective systemd policy is `Type=simple` with the watchdog disabled:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/NineDeploy/NineDeploy/main/install.sh | bash
   ```
2. **Verify the installed policy**:
   ```bash
   systemctl show ninedeploy -p Type -p WatchdogUSec
   ```
   Expected values are `Type=simple` and `WatchdogUSec=0`.

For exit code 137 or kernel OOM records, add swap or memory separately; the installer provisions swap automatically on low-memory supported Linux hosts.

---

## 🔐 9. Private Repository 401 or 404 on Clone

**Symptoms**:
- First deploy of a private repo logs `remote: Repository not found` or `fatal: Authentication failed for 'https://github.com/…'`.
- The build stage exits non-zero before any `docker build` / `nixpacks` line appears.

**Cause**:
- The credential attached to the service cannot reach the repository. Most often a **stale or under-scoped PAT**, an **SSH key without write-access to the repo**, or a credential bound to a different GitHub user than the repo owner.

**Resolution**:
1. **Live-test the credential** before debugging the deploy:
   ```bash
   ninedeploy sources test <id>
   # or
   curl -fsS -H "Authorization: Bearer $ND_TOKEN" https://your-ninedeploy.example.com/v1/sources/<id>/test
   ```
   The response is `{ ok: true, login: "<your-handle>" }` on success, or `{ ok: false, status: 401, error: "Bad credentials" }` (or 404) on failure.
2. **Re-issue the PAT** with the right scopes. The minimum working scopes are:
   - **Fine-grained PAT**: `Contents: Read-only` (on the specific repo) + `Metadata: Read-only` (always required).
   - **Classic PAT**: `repo`.
3. **For GitHub org repos**, the PAT must be issued by a user who has access to the org, OR you must enable "Allow access via fine-grained personal access tokens" in the org's third-party application settings.
4. **For SSH**: ensure the **public** key is added as a *Deploy key* on the repo with **read** access; the matching **private** key is what you paste into the Source.
5. **If the repo was renamed or transferred**, the Source still works (it stores only the token), but the service's `repoUrl` is stale — update it under **Service → Settings → Repository URL** and re-trigger a deploy.
6. **If the credential passes the test but the clone still fails**, the panel server cannot reach `github.com` (or your self-hosted Gitea/GitLab host). From the host:
   ```bash
   curl -fsS -I https://github.com
   ```

See [PRIVATE_REPO_GUIDE.md](./PRIVATE_REPO_GUIDE.md) for a full step-by-step.

---

## 🪝 10. Webhook Signature Rejected (401)

**Symptoms**:
- A `git push` does **not** trigger a new deploy row.
- GitHub's webhook delivery page shows the request returning **HTTP 401** with body `{"error":{"code":"unauthorized","message":"Invalid webhook signature"}}`.

**Cause**:
- The **secret on the GitHub side does not match the secret NineDeploy stored**. Most often caused by: copying a trailing space / newline, regenerating the secret in NineDeploy but forgetting to update GitHub, or registering the webhook on the wrong repo.

**Resolution**:
1. **Cross-check the secret byte-for-byte**:
   - In NineDeploy: **Service → Webhooks → the secret was returned only once, at creation**. If you don't have it, **delete the webhook in both places and re-add it**.
   - In GitHub: **Repo → Settings → Webhooks → the webhook → Secret** (latest "Update" overrides earlier ones; there's no "show me what I set" — re-paste it).
2. **Test locally with the same secret**:
   ```bash
   SECRET='paste-the-secret-here'
   BODY='{"ref":"refs/heads/main","head_commit":{"id":"abc1234","message":"hi","author":{"username":"x"}},"repository":{"clone_url":"https://github.com/owner/repo.git"}}'
   SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"
   curl -i -X POST "https://your-ninedeploy.example.com/v1/hooks/<id>" \
     -H "Content-Type: application/json" \
     -H "X-GitHub-Event: push" \
     -H "X-Hub-Signature-256: $SIG" \
     --data "$BODY"
   #   → expect 200 { "ok": true, "deploymentId": ... }
   ```
3. **Make sure the URL is reachable from GitHub** (i.e. your panel has a public HTTPS address). If you are testing locally, GitHub cannot reach `http://localhost:3000` — use a tunnel (`ngrok`, `cloudflared`) or test with the curl above.
4. **Re-save the secret**: if the original secret in NineDeploy was lost, the only recovery is delete + re-add on both sides. The new secret is shown exactly once.

---

## 🛠️ 11. Nixpacks CLI Not Found

**Symptoms**:
- A Dockerfile-less repo's deploy fails immediately with:
  ```
  ✗ Deployment failed: Nixpacks CLI is unavailable. Re-run the NineDeploy installer to provision the checksum-verified source build tool.
  ```

**Cause**:
- The `nixpacks` binary is not on the panel server's `PATH`. This is normally installed by `install.sh`, but a manually-installed or Docker-only install may not have provisioned it.

**Resolution**:
- **Bare-metal install**: re-run the installer — it skips already-installed components and only provisions the missing ones:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/NineDeploy/NineDeploy/main/install.sh | bash
  ```
  The installer fetches a pinned Nixpacks release, verifies its SHA-256 against the table inside `install.sh`, and only then puts it on `PATH`.
- **Docker install**: the `ninedeploy` image bundles the binary at `/usr/local/bin/nixpacks`. If you built the image yourself and the binary is missing, rebuild from the official `Dockerfile` (it has the checksum-verified `ARG NIXPACKS_VERSION` step) or set `NINEDEPLOY_NIXPACKS_VERSION` and rebuild:
  ```bash
  docker compose -f docker-compose.prod.yml build --no-cache
  ```
- **Verify**:
  ```bash
  nixpacks --version    # bare-metal
  docker exec ninedeploy nixpacks --version   # Docker install
  ```
- **Don't want Nixpacks?** Switch the service to `buildPack: "dockerfile"` and provide a Dockerfile — the panel will not invoke Nixpacks.

---

## 📁 12. Dockerfile Not Found (Monorepo With a Subdirectory Dockerfile)

**Symptoms**:
- A repo that has a `Dockerfile` (e.g. `apps/api/Dockerfile`) silently uses Nixpacks instead of `docker build`. The build output shows Nixpacks detection logs, and your custom Dockerfile is never read.

**Cause**:
- For backward compatibility with single-Dockerfile-at-root repos, the old behavior was "if `/Dockerfile` does not exist at the configured `baseDir`, use Nixpacks". That misses monorepos.

**Resolution**:
- **If you can re-deploy without changing anything**: the current `auto` build pack walks the repo up to 2 directory levels deep and picks the closest Dockerfile to the root. `apps/api/Dockerfile` will now be detected automatically.
- **If you want to be explicit** (recommended for any non-trivial repo): set either
  - `Service → Settings → Build → Base directory: /apps/api`, **or**
  - `Service → Settings → Build → Dockerfile path: apps/api/Dockerfile`.
- **If you want Nixpacks regardless of the Dockerfile**: set `buildPack: "nixpacks"` (or `"auto"` won't help — explicit override wins).
- **If your Dockerfile is more than 2 levels deep** (e.g. `services/payments/api/Dockerfile`): set `baseDir` to the directory containing it, or set `dockerfilePath` to the full path.

The deploy log prints the path it picked: `📁 Auto-detected Dockerfile at apps/api/Dockerfile (depth 1)`.

---

## 🔑 13. `ninedeploy sources keygen` Fails With "ssh-keygen: command not found"

**Symptoms**:
- The CLI/Web generate-deploy-key flow returns a 500 with `ssh-keygen: command not found` (or similar) in the error message.
- Server log shows the same error originating from `lib/sshKey.ts`.

**Cause**:
- The bare-metal installer's `apt-get install -y ...` step pulls in `openssh-client` (the `ssh` binary) on Debian/Ubuntu but not on every minimal container image. The `Dockerfile` provided by this repo installs `openssh-client` explicitly; if you built a custom image without it, server-side key generation is unavailable.

**Resolution**:
- **Bare-metal**: `sudo apt-get install -y openssh-client`, then re-run the keygen.
- **Docker**: rebuild the panel image with `apt-get install -y openssh-client` in your custom `Dockerfile`, or fall back to the manual workflow (§4.3 in `PRIVATE_REPO_GUIDE.md`) — generate a key on your workstation with `ssh-keygen -t ed25519`, paste the private key into the source's "SSH deploy key" field.
- **Verify** the binary is on `PATH` inside the container:
  ```bash
  docker exec ninedeploy ssh-keygen -V
  ```


