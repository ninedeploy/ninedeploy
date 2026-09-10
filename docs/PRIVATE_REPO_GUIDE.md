# Private Repository Deployment Guide

End-to-end playbook for deploying a **private GitHub repository** with NineDeploy — covers credential setup, build-pack selection, the auto-deploy webhook, and the three working methods (UI, CLI, REST API).

---

## 1. TL;DR (3 commands via CLI)

If you have the CLI installed and `NINEDEPLOY_GITHUB_TOKEN` exported, this is the entire flow:

```bash
# 1. Save the token once
ninedeploy sources add github-personal
#    (it will pick up $NINEDEPLOY_GITHUB_TOKEN if set, otherwise prompt for it — masked)

# 2. One-shot deploy: source + service + env + first deploy, all from a URL
ninedeploy deploy create-from-github https://github.com/your-org/your-private-app

# 3. Wire up auto-deploy on every push
ninedeploy webhooks add <serviceId> main
#    — returns the URL and a one-time secret; paste both into GitHub's webhook UI
```

That's it. The same flow works in the Web UI under **New Service → Source** and on the REST API.

---

## 2. The pieces, and what they do

| Piece | Purpose | Where it lives |
|---|---|---|
| **Source** (a.k.a. "Git credential") | An encrypted Personal Access Token (PAT) or SSH deploy key the panel uses to `git clone` private repos | Admin-only; created once, reused for every service. Stored in the `sources` table, AES-256-GCM encrypted. |
| **Service** | A long-lived definition of "the thing that deploys": repo URL, branch, port, build pack, env vars… | Created from a Source when the repo is private. |
| **Build pack** | How the source becomes a runnable image. **`auto` picks Dockerfile when one is present, else Nixpacks.** Set per-service. | `service.build.buildPack` |
| **Webhook** | An HMAC-signed endpoint GitHub POSTs to on every push. Triggers a deploy automatically. | Per-service; you paste the secret into GitHub once. |

A private repo **always** needs a Source. The other two are optional but recommended.

---

## 3. Create a GitHub Personal Access Token (PAT)

You need a **fine-grained PAT** (recommended) or a **classic PAT**.

### Fine-grained PAT (recommended)

1. Go to <https://github.com/settings/personal-access-tokens/new> (or for an org, `Settings → Developer settings → Personal access tokens → Fine-grained tokens`).
2. **Resource owner**: pick your user **or** the org that owns the repo.
3. **Repository access**:
   - "All repositories" — simplest, deploys every repo this PAT can reach.
   - "Only select repositories" — recommended for least-privilege; pick the specific repo(s) you plan to deploy.
4. **Permissions** (least privilege that actually works):
   - **Repository → Contents: Read-only** — the panel only ever clones & checks out; it never writes to your repo.
   - **Repository → Metadata: Read-only** — required by GitHub for almost any call.
   - **Repository → Webhooks: Read & write** *(optional)* — only if you want NineDeploy to register the GitHub webhook for you in a future release. For now, you paste the secret manually and this is not required.
5. Click **Generate token**, copy the `github_pat_…` value. **GitHub will never show it again** — paste it into NineDeploy immediately.

### Classic PAT (only if fine-grained is blocked by tooling)

1. <https://github.com/settings/tokens/new> (classic tab).
2. **Scopes**:
   - `repo` — full read of private repos (includes everything else you need for cloning).
   - `admin:repo_hook` — only required if you want NineDeploy to manage webhooks on your behalf; you can skip it and register the webhook manually in the GitHub UI.
3. Generate, copy, paste.

### SSH deploy key (alternative to a token)

If you prefer SSH:

1. Generate an ed25519 key on your local machine:
   ```bash
   ssh-keygen -t ed25519 -C "ninedeploy@your-host" -f ~/.ssh/ninedeploy_deploy
   ```
2. Add the **public** key as a **Deploy key** on the GitHub repo: `Settings → Security → Deploy keys → Add deploy key` (read-only is enough; the panel never pushes).
3. Save the **private** key (the `.pub` is useless without the matching private key) — paste its full contents (one line) into the Source's "SSH deploy key" field, or set `NINEDEPLOY_SSH_KEY` in the env when running `ninedeploy sources add`.

### Bitbucket specifics

Create the Source with type `bitbucket` and a **Bitbucket Cloud API token**
(account → Settings → API tokens — it authenticates as Bearer). The token
powers the repos/branches pickers and the connection test. For cloning:

- **Deploy keys work over SSH**: add the panel's public key under
  `repo → Settings → Access keys` (Read permission) and use the SSH clone URL
  — this is the recommended path for private Bitbucket repos.
- HTTPS token clones require the `x-token-auth` username; if you paste an
  HTTPS URL, make sure the token type you stored matches that flow.

Bitbucket webhooks (`repo:push`, `pullrequest:*`, signed with the webhook
secret via `X-Hub-Signature`) drive auto-deploys and PR previews exactly like
the GitHub providers.

---

## 4. Add the credential to NineDeploy

Pick the method that fits:

### 4.1 Web UI (admins)

1. Log in as an **admin** (members cannot create sources — by design).
2. **System → Sources** (sidebar) → **Add credential**.
3. **Name**: e.g. `github-personal`.
4. **Provider**: `GitHub`.
5. **Auth kind**: `token` (or `ssh` for deploy keys).
6. Paste the token / key. Hit **Save**.
7. The list now shows it with a green `Token` badge. The actual value is never shown again — only the boolean flag.

### 4.2 CLI

```bash
# Easiest: provide the token via env so the script can be non-interactive.
export NINEDEPLOY_GITHUB_TOKEN='github_pat_…'
ninedeploy sources add github-personal
# → "Provider (github | gitlab | gitea | registry | custom)" — choose github
# → "Auth kind (token | ssh)" — choose token
# → picks up $NINEDEPLOY_GITHUB_TOKEN automatically
# → "Default branch (used as suggestion only)" — main

# No env? The prompt is masked — your token never appears on screen or in
# ~/.bash_history (the prompt disables echo and only prints *).
ninedeploy sources add github-personal

# Verify it still works
ninedeploy sources test github-personal
# ✓ github token authenticates as your-handle (Your Name)

# List all
ninedeploy sources list
```

### 4.3 REST API

```bash
curl -fsS -X POST https://your-ninedeploy.example.com/v1/sources \
  -H "Authorization: Bearer $ND_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"github-personal","type":"github","token":"github_pat_…","defaultBranch":"main"}'
# → { "id": 1, "name": "github-personal", "type": "github", "hasToken": true, ... }
```

The token is encrypted with the master key (AES-256-GCM) before it hits the database. It is decrypted only at the moment a `git clone` runs; the plaintext never touches the `.git/config` of the checked-out repo (the panel resets `origin` back to the clean URL after the clone).

### 4.4 Generate an SSH deploy key on the panel (recommended for private repos)

Instead of pasting a PAT, you can ask the panel itself to mint an ed25519 deploy-key pair. The **private key never leaves the server** (it's encrypted into the source row with AES-256-GCM); the panel only returns the **public key** and a fingerprint, which you paste once into the Git host's "Deploy keys" UI.

This is faster and more secure than the manual keygen workflow because:
- The operator never has to handle a private key file.
- The public key is recognizable in `~/.ssh/known_hosts` review (comment = `ninedeploy@<source-name>`).
- The server can rotate the key on demand without any operator-side file management.

**CLI:**

```bash
# 1. Create the source (no credential needed yet)
ninedeploy sources add my-app --provider github   # or: pick "ssh" when prompted

# 2. Ask the panel to generate the key pair
ninedeploy sources keygen 1
# → "Deploy key generated (fingerprint SHA256:abc…)."
# → Prints the public key, ready to copy.
```

**Web UI:** open **System → Sources**, find the source card, click **"Generate deploy key"**. The panel shows the public key, fingerprint, and a direct link to your Git host's "Deploy keys" page (GitHub: `repo → Settings → Security → Deploy keys`).

**REST API:**

```bash
curl -fsS -X POST https://your-ninedeploy.example.com/v1/sources/1/generate-deploy-key \
  -H "Authorization: Bearer $ND_TOKEN"
# → { "publicKey": "ssh-ed25519 AAAA… ninedeploy@my-app", "fingerprint": "SHA256:…" }
```

The response is the public key only. The private key lives encrypted on the source row and is decrypted only at the moment a `git clone` runs (same lifecycle as a stored PAT — the panel resets `origin` back to the clean URL after the clone, so the plaintext never lands in `.git/config`).

To rotate, run the same command again — the previous key is replaced and the old one stops working at the next clone.

### 4.4 Live credential check

Useful after a token rotation, or to debug "private repo deploys fail with 401":

```bash
# CLI
ninedeploy sources test 1
# API
curl -fsS -H "Authorization: Bearer $ND_TOKEN" https://your-ninedeploy.example.com/v1/sources/1/test
# → { "ok": true, "provider": "github", "login": "your-handle", "name": "Your Name" }
#   or { "ok": false, "provider": "github", "status": 401, "error": "Bad credentials" }
```

---

## 5. Deploy the private repo

### 5.1 Web UI (the one-click way)

1. **Services → New Service** (the wizard button on the top right).
2. **Step 1 — Source**:
   - Pick **Git repo** as the source type.
   - In the **Source (Git Credential)** dropdown, pick the credential you added in §4. (The new "Add credential" button right next to the dropdown does it inline if you skipped ahead.)
   - The dropdown next to it lists the repos the credential can reach — pick yours, or paste the URL directly.
3. The panel **clones the repo on the server** to framework-analyse it (a "Framework analysis" panel appears with detected language, package manager, suggested install/build/start commands, port, and whether a Dockerfile was found).
4. **Step 2 — Runtime**: pick `docker` (the default). Port is pre-filled from the analysis; tweak if your app actually listens on a different one. **Build pack** defaults to `auto` — see §6 for what that means.
5. **Step 3 — Environment**: add env vars (any `KEY=value` lines your app needs at runtime).
6. **Step 4 — Resources**: CPU shares, memory limit, persistent volume mount, direct host port (only if you must bypass Traefik).
7. **Step 5 — Review** → **Deploy**.

You can also click **Add webhook** in the Review step — the wizard prints a GitHub-ready URL and a one-time secret.

### 5.2 CLI (one command)

```bash
ninedeploy deploy create-from-github https://github.com/your-org/your-app
```

What this does, in order:

1. **Source resolution** — picks the first matching GitHub credential, or creates one if you have none and `NINEDEPLOY_GITHUB_TOKEN` is set, or prompts you.
2. **Clone & analyse** — the panel server clones the repo, runs framework detection, and shows you:
   - Language, Node version, package manager
   - Detected framework (Next.js / Express / Vite / etc.)
   - Has Dockerfile / Has compose file / Is monorepo
   - Suggested `install`, `build`, `start` commands and port
3. **Confirm / override** the build config (build pack, port, health path, custom commands).
4. **Env vars** — keep typing `KEY` + `value` lines, leave key empty to stop.
5. **Create the service**.
6. **Trigger the first deploy** (default yes).
7. **Optional webhook** — one more `y/N` and it prints the URL + secret for GitHub.

You can also run it non-interactively for CI / scripts by setting env vars ahead of time and answering `n` to the prompts that the CLI can't infer:

```bash
NINEDEPLOY_GITHUB_TOKEN=... ninedeploy deploy create-from-github https://github.com/org/app
```

### 5.3 REST API

```bash
# 1. Create the service with the source attached
curl -fsS -X POST https://your-ninedeploy.example.com/v1/services \
  -H "Authorization: Bearer $ND_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "my-app",
    "type": "docker",
    "repoUrl": "https://github.com/your-org/your-app.git",
    "branch": "main",
    "sourceId": 1,
    "port": 3000,
    "healthPath": "/health",
    "build": { "buildPack": "auto" }
  }'

# 2. (optional) set env
curl -fsS -X POST https://your-ninedeploy.example.com/v1/services/42/env \
  -H "Authorization: Bearer $ND_TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"DATABASE_URL","value":"postgres://…","isSecret":true}'

# 3. trigger the first deploy
curl -fsS -X POST https://your-ninedeploy.example.com/v1/services/42/deploys \
  -H "Authorization: Bearer $ND_TOKEN" -H "Content-Type: application/json" -d '{}'
```

---

## 6. How the build pack is chosen

`buildPack: "auto"` (the default) is the magic switch. The panel does, in this order:

1. **Is there a `Dockerfile` at the configured `baseDir`?** If yes → `docker build` directly with the BuildKit image builder.
2. **Did the user pin a `dockerfilePath`?** (e.g. `apps/api/Dockerfile` for a monorepo) — if that file exists, use it.
3. **Otherwise, walk the repo up to 2 levels deep** looking for any `Dockerfile`. The closest one to the root wins. This makes a monorepo with `apps/api/Dockerfile` and a bare `/package.json` "just work" without the user having to set any field.
4. **If no Dockerfile is found anywhere**: fall through to **Nixpacks** (the buildpack used by Railway / Fly / Render), which auto-detects Node, Python, Go, Rust, Ruby, PHP, Java and produces a runnable image using your repo's own `package.json` / `requirements.txt` / `go.mod` / etc. For Node repos it also honors `engines.node` and a `pnpm-lock.yaml` / `yarn.lock` / `package-lock.json` / `bun.lockb` lockfile to pick the install command.

If you ever need to override:

- `buildPack: "dockerfile"` — force `docker build`, fail if no Dockerfile exists.
- `buildPack: "nixpacks"` — force buildpack-only, ignore any Dockerfile.

The CLI's `deploy create-from-github` shows the analysis result and lets you override the choice interactively; the wizard does the same.

### When to choose what

| Repo shape | Recommended `buildPack` | Why |
|---|---|---|
| Single `Dockerfile` at the root | `auto` | Detects the Dockerfile, uses it. |
| `apps/api/Dockerfile` in a monorepo, no other Dockerfile | `auto` | Walks 2 levels, finds it, no config needed. |
| `apps/api/Dockerfile` in a monorepo, plus a `Dockerfile` in `infra/` | `auto` + `baseDir: "/apps/api"` (or `dockerfilePath: "apps/api/Dockerfile"`) | Stops the walker from picking the wrong one. |
| Plain Next.js / Express / Vite / SvelteKit / Astro with no Dockerfile | `auto` | Falls through to Nixpacks, no config needed. |
| Custom build that Nixpacks doesn't model (esoteric base image, complex multi-stage) | `dockerfile` | You write the Dockerfile, the panel runs `docker build`. |
| Repo with a Dockerfile **and** a `docker-compose.yml` | Use **`type: "compose"`** instead of `type: "docker"` | Compose deploys run the full compose stack, not just one service. |

---

## 7. Set up the auto-deploy webhook

Without a webhook, deploys are manual (`Deploy now` button / `ninedeploy services deploy <id>` / `POST /v1/services/:id/deploys`). With one, every push to your branch triggers a fresh build.

### 7.1 Generate the webhook in NineDeploy

```bash
# CLI
ninedeploy webhooks add 42 main
# → URL:   https://your-ninedeploy.example.com/v1/hooks/7
# → Secret: a1b2c3…   (printed exactly once)
```

The same works in the UI under **Service → Webhooks → Add**. The secret is stored encrypted; the CLI / UI only shows it once.

### 7.2 Register it in GitHub

1. Repo → **Settings → Webhooks → Add webhook**.
2. **Payload URL**: the URL printed by NineDeploy.
3. **Content type**: `application/json`.
4. **Secret**: the secret printed by NineDeploy.
5. **SSL verification**: enabled (the panel sits behind Traefik with Let's Encrypt by default; if you run without TLS, set `NINEDEPLOY_PUBLIC_URL` to an `https://…` you terminate elsewhere and front the panel with that).
6. **Which events**: "Just the push event." (PR events are also handled if you want preview environments — see [DEPLOYMENTS.md §4](./DEPLOYMENTS.md#4-ephemeral-pr-preview-environments)).
7. **Active**: ✓.
8. **Add webhook**.

GitHub immediately sends a `ping` event; NineDeploy responds with `{ ok: "pong" }` and the webhook shows green in the GitHub UI. Your next `git push` is the real test.

### 7.3 Watch-paths (monorepos)

If your monorepo contains multiple deployable apps, you almost certainly want the webhook to **only fire for changes under your service's path**. Add a watch path when creating the webhook:

```bash
ninedeploy webhooks add 42 main "apps/api/**\npackages/shared/**"
```

Pushes that don't touch those globs (e.g. a docs-only commit) are silently ignored — no wasted builds.

You can also use `[skip ci]` or `[skip cd]` in the commit message to opt a specific commit out of auto-deploy, matching standard CI conventions.

### 7.4 Webhook smoke test

```bash
# Push a tiny commit:
git commit --allow-empty -m "chore: trigger deploy"
git push origin main

# Watch live in the CLI:
ninedeploy deploys watch 42 <deploymentId>
#   (or: ninedeploy services logs 42, after the deploy finishes)

# In the UI:
#   Service → Deploys → click the new row → live log stream
```

If the deploy never queues, the most common cause is **wrong secret on the GitHub side**: NineDeploy's HMAC-SHA-256 verification rejects the request with HTTP 401, but GitHub does not retry on 401. Re-paste the secret (start over: delete the webhook in both places, add it again).

---

## 8. Security notes

- The token is **encrypted at rest** (AES-256-GCM, master key in `NINEDEPLOY_MASTER_KEY` env or the auto-generated `master.key` file). The DB row only ever holds the ciphertext.
- The token is **decrypted only at the moment a clone runs**, and only inside the pipeline process — it never reaches the `.git/config` of the checkout. After the clone, the panel resets `origin` back to the clean URL.
- Tokens are **never logged**. The runtime log sanitizer (in `lib/docker.ts`) redacts common credential shapes (passwords, tokens, `api_key=…`, `://user:pass@…`) before anything is written to a deploy log.
- The webhook secret is also encrypted at rest, and the **raw secret is only ever returned once** at creation time. If you lose it, delete and recreate the webhook.
- A PAT is **read-only by default**. NineDeploy never writes to your repo — it only clones, checks out a commit, and runs the build. You can use a `Contents: Read` fine-grained PAT, or a classic PAT with only the `repo` scope (no `workflow`, no `admin:org`).
- For least-privilege, use a **fine-grained PAT scoped to a single repo** instead of a classic PAT that grants access to everything your user can see.

---

## 9. Troubleshooting quick links

- "Repository not found" at clone time → see [TROUBLESHOOTING.md → Private repository 401/404 on clone](./TROUBLESHOOTING.md#private-repository-401-or-404-on-clone).
- "Nixpacks CLI unavailable" at build time → see [TROUBLESHOOTING.md → Nixpacks CLI not found](./TROUBLESHOOTING.md#nixpacks-cli-not-found).
- Auto-deploy never fires after a push → see [TROUBLESHOOTING.md → Webhook signature rejected](./TROUBLESHOOTING.md#webhook-signature-rejected-401).
- The wizard detected no Dockerfile but there is one in a subdirectory → `buildPack: "auto"` walks two levels deep; for deeper structures set `baseDir` or `dockerfilePath` explicitly.
