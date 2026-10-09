# GitHub App

Since 0.13, NineDeploy can deploy GitHub repositories through a **GitHub App** instead of a personal access token (PAT). This is the recommended setup for GitHub and GitHub Enterprise Server (GHES):

- **Short-lived tokens.** Every clone uses an installation token that GitHub expires within an hour. The token is scoped to one repository with `contents: read`, and it is never written to the database.
- **One webhook for every service.** The App's single webhook deploys every linked service. You no longer paste a secret into each repository.
- **Routing by repository id.** A renamed or transferred repository keeps deploying, and the service's clone URL is corrected automatically.
- **Feedback on GitHub (opt-in per service).** Commit statuses for each deploy, and one PR comment per pull request with the preview URL and the outcome.
- **Remote nodes can clone private repositories.** A node receives a per-job token and never holds a long-lived credential.

Existing PAT, deploy-key and webhook setups keep working unchanged. Nothing changes for a service until an operator links it to an App.

---

## 1. Setup

Registering an App is **operator-only**, because its private key can mint tokens for every repository its installations reach. Any number of Apps can be registered; they are unique per API base URL and App id.

### 1.1 One-click setup (github.com)

The panel needs a public domain, because GitHub must reach its webhook URL. Set it under **Settings → Security** (panel domain) first. On a `localhost` panel the setup refuses to start with `panel_origin_local`.

1. Open **Sources → GitHub Apps → Create GitHub App**.
2. Choose **Personal account** or **Organization**. For an organization, enter its login.
3. Press **Continue on GitHub**. GitHub opens with the App pre-filled:
   - permissions: contents and metadata `read`, pull requests and commit statuses `write`;
   - events: `push` and `pull_request` (GitHub always sends `installation` events to Apps);
   - webhook URL `https://<panel>/v1/hooks/github-app/<key>`, callback URL `/github-apps/callback`, setup URL `/github-apps/installed`.
4. Confirm the App name on GitHub. GitHub sends the browser back to `/github-apps/callback`, and the panel saves the App: its id, private key, webhook secret and client secret are stored encrypted.
5. Press **Install the App**, pick the account and the repositories. GitHub returns to `/github-apps/installed`, which syncs the installations.

The setup state is signed, expires after one hour, can be used once, and belongs to the user who started it. If the callback reports that the state was already used or has expired (for example, because the panel restarted in between), start the setup again. GitHub's code is also single-use.

The CLI cannot drive the browser flow. `ninedeploy github-app list` prints the panel URL to open.

### 1.2 Manual entry (GHES, or an existing App)

Use **Sources → GitHub Apps → Add manually (GHES)**, the CLI, or the API:

```bash
ninedeploy github-app add-manual --name "NineDeploy (GHES)" --app-id 12 --key-file ./app.private-key.pem \
  --web-base-url https://github.example.com --api-base-url https://github.example.com/api/v3
```

```http
POST /v1/github-apps
{ "name": "NineDeploy (GHES)", "appId": 12, "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n…",
  "webBaseUrl": "https://github.example.com", "apiBaseUrl": "https://github.example.com/api/v3" }
```

- Omit both base URLs for github.com. For GHES give both; giving only one is refused, so a GHES App's JWT is never sent to `api.github.com`.
- The panel signs a JWT with the key and calls `GET /app` before saving. A key that is not a PEM private key is refused with `400`. A key belonging to a different App is also refused.
- Leave the webhook secret empty and the panel generates one and points the App's webhook at itself (`PATCH /app/hook/config`). This needs a public panel origin. If you pass `webhookSecret` (the CLI reads `NINEDEPLOY_GITHUB_APP_WEBHOOK_SECRET`), the panel stores it and leaves the App's webhook configuration alone.
- The CLI never takes a key on the command line: use `--key-file` or `NINEDEPLOY_GITHUB_APP_KEY`.
- Base URLs must be `https`. A GHES host on a private address is blocked by the egress guard unless the server runs with `NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1`; `http` is accepted only with that setting.

### 1.3 Maintenance

| Action | UI (Sources → GitHub Apps) | CLI | API |
|---|---|---|---|
| List / show | App card | `github-app list`, `github-app show <id>` | `GET /v1/github-apps`, `GET /v1/github-apps/:id` |
| Sync installations | **Sync** | `github-app sync <id>` | `POST /v1/github-apps/:id/installations/sync` |
| Replace the private key | **Rotate key** | `github-app rotate-key <id> --key-file new.pem` | `PUT /v1/github-apps/:id/private-key` |
| Re-point the webhook after a domain change | **Webhook sync** | | `POST /v1/github-apps/:id/webhook/sync` |
| New webhook secret | | | `POST /v1/github-apps/:id/webhook-secret/rotate` |
| Rename, OAuth client fields | | | `PATCH /v1/github-apps/:id` |
| Forget the App | **Delete** | `github-app remove <id>` | `DELETE /v1/github-apps/:id` |

Responses carry metadata only (`webhookUrl`, `installUrl`, `hasPrivateKey`, `hasClientSecret`, permissions, events), never a secret. Deleting an App removes its installation rows and service links. The generated sources stay, so services keep their source, but their clones run anonymously and private repositories fail closed. The App itself stays on GitHub; delete it there too if you no longer need it.

---

## 2. Installations

Each installation (an account or organization where the App is installed) becomes a **source** named `gh-app:<account>` with type `github_app`. The source holds no token; clones mint one.

- **Sync** reads `GET /app/installations` from GitHub; the list GitHub returns is the only input. The `/github-apps/installed?installation_id=…` page syncs every App and never trusts the query parameter.
- Installation webhooks keep the list current without a sync:
  - `installation.created` adds the installation and its source;
  - `installation.deleted` marks it removed;
  - `installation.suspend` / `unsuspend` set or clear the suspended state;
  - `installation.new_permissions_accepted` refreshes the stored permissions;
  - `installation_repositories.added` / `removed` are audited, naming the linked services they affect.
- Installation rows are never hard-deleted. A removed or suspended installation stops minting tokens; reinstall or unsuspend it on GitHub and sync.
- Testing a `github_app` source (**Test installation**, `ninedeploy sources test <id>`, `GET /v1/sources/:id/test`) proves the App key and reads the installation: `{ok, provider: "github_app", login, repositorySelection, permissions, suspended}`.
- `GET /v1/sources/:id/repos` lists the repositories the installation can see. Each row carries GitHub's numeric `repoId`.
- The read-only MCP tool `list_github_installations` lists Apps and their installations (operator, coarse tokens only).

---

## 3. Linking services

A service is **App-driven** when it has an enabled link on a live installation. The link stores GitHub's numeric repository id; webhooks are routed by that id, never by URL.

### 3.1 New services

In the Deploy Wizard, pick the `gh-app:<account>` source. The repository picker lists what the installation can see. After the service is created, the wizard links it to the picked repository by id before the first deploy. If the link is refused (for example, the repository is not in the installation's selection), the wizard warns and still deploys; the first clone links the service lazily anyway.

A service on a `github_app` source with no link is linked automatically on its first clone, with feedback switched off.

### 3.2 Migrating an existing PAT or webhook service

Migration never cuts anything off:

1. **Migrate.** Service → Settings → GitHub App → pick the installation → **Migrate to GitHub App**. CLI: `ninedeploy services github <id> --migrate <sourceId>`. API: `POST /v1/services/:id/github/migrate {sourceId}`.
   - The panel resolves the repository id through the installation and creates the link. It remembers the current source as `previousSourceId` and copies the deploying webhook's watch paths.
   - The service's own source and webhooks stay as they are. While the installation is live, deliveries to the per-service webhook are skipped (`{ok: "skipped", reason: "github_app_linked"}`), so one push never deploys twice.
2. **Finalize (optional).** **Finalize migration**, `--finalize`, or `POST /v1/services/:id/github/finalize`. The App source becomes the service's source and its per-service webhooks are switched off. It is refused (`409`) unless the link is enabled and the installation is live, because deploys would otherwise stop. Afterwards, delete the old webhook on GitHub too.
3. **Revert.** **Revert to previous source**, `--unlink`, or `DELETE /v1/services/:id/github`. The previous source comes back, every deactivated webhook is switched on again, and the link is removed.

**The 409 revert rule:** revert is refused with `409` when the source it would restore is the App installation's own source, that is, a service created on (or finalized onto) the App with no earlier source. Cloning through that source would re-create the link on the next deploy, so the unlink would not stick. Attach another source to the service first, or disable the link instead (`PUT /v1/services/:id/github` with `enabled: false`). The UI keeps the reason on screen.

### 3.3 Link settings

| Setting | Who | Where |
|---|---|---|
| Re-link, `enabled`, `tokenScope`, `watchPaths` | operator | `PUT /v1/services/:id/github`; Settings card (scope and enabled) |
| Commit statuses, PR comments | service admin | `PATCH /v1/services/:id/github/feedback`; Settings card; `--status on\|off`, `--pr-comment on\|off` |
| Read the link | any viewer of the service | `GET /v1/services/:id/github` (`{link}`; `link.active` says whether the App drives deploys) |

PR previews follow their parent service's link; linking a preview directly is refused.

`tokenScope` is `repository` by default: the clone token covers only the linked repository. Set it to `installation` when the repository has **submodules in sibling repositories** of the same installation; the token then covers every repository the installation can see.

---

## 4. Coexistence with per-service webhooks

- An unlinked service is unchanged: its per-service webhook (`/v1/hooks/:id`) deploys it as before.
- An App-driven service skips its per-service webhook deliveries. The App webhook applies the same gates: branch, `[skip ci]` markers, the link's watch paths, the deploy guard, SHA de-duplication and the race guard.
- When the installation is suspended or removed, or the link is disabled, the per-service webhook takes over again automatically.
- Pull requests from forks are refused by repository id (`external_pr_repository`). Previews from the App webhook use the same preview lifecycle as the per-service webhook.
- When the push payload shows a renamed or transferred repository (same host and id, different clone URL), the panel updates the service's repository URL and audits `service.repo_renamed`.

---

## 5. Commit statuses and PR comments

Both are **off by default** and switched on per service (service admin role).

- **Commit statuses:** `pending` when a deploy starts (only when the commit SHA is known), then `success`, `failure` or `error` (cancelled). The context is `ninedeploy/<slug>`, or `ninedeploy/<parent-slug>/preview` for a PR preview. The target URL is the service's first domain.
- **PR comments (previews only):** one comment per pull request, marked `<!-- ninedeploy:preview:<parentId> -->` and updated in place with the preview URL, the outcome and the short SHA. A deleted comment is re-created. When the preview is torn down, the comment says so.
- Feedback is observational: a GitHub error is logged (redacted) and never fails a deploy.
- The Checks API is not used in 0.13. The manifest flag `checks` only requests the permission.

---

## 6. Remote nodes

An App repository can be deployed to a remote node (docker services) when:

- the node agent is **v0.13.0 or newer** and advertises the `git.credential` capability;
- the panel reaches the agent over the **sealed** (encrypted) transport;
- the node has **git 2.31 or newer** (the credential is passed with `GIT_CONFIG_COUNT`, which older git ignores).

Per job, the panel mints a repository-scoped `contents: read` token and sends it inside the sealed `git.ensure` / fetch / reset operands. The agent applies it only through the git child process environment (`http.<origin>/.extraheader`): never in argv, never in `.git/config`, and redacted from every output line. When the job finishes the panel revokes the token (`DELETE /installation/token`).

An older agent, or an unsealed transport, gets today's refusal with an instruction to update the agent; nothing is minted.

**PATs and deploy keys on nodes (0.15.2).** A PAT or deploy-key source is still refused on nodes by default. Two ways forward: build the service on the panel and ship the image (`buildOn: panel`, panel 0.15.3), or allow that source on nodes (`allowOnNodes`, with your password), which sends the PAT or key to the node for one clone at a time and needs node agent v0.15.2. Unlike an App token, a PAT is not revoked after the clone. See [PRIVATE_REPO_GUIDE.md §10](./PRIVATE_REPO_GUIDE.md) and [MULTI_NODE.md §6](./MULTI_NODE.md).

---

## 7. Token model and security

| Token | Scope | Lifetime | Stored |
|---|---|---|---|
| App JWT | the App | 9 minutes | no (signed per call) |
| Clone token | one repository, `contents: read` (or the installation with `tokenScope: installation`) | GitHub's expiry (1 hour); reused until 5 minutes before it | in memory only |
| Node job token | one repository, `contents: read` | one job, then revoked | no |
| Listing token | `metadata: read` | as above | in memory only |
| Feedback token | one repository, `statuses: write` / `pull_requests: write` | as above | in memory only |

- The private key, webhook secret and client secret are encrypted at rest (and re-encrypted by master-key rotation). No route returns them, and audit entries carry ids and names only.
- A token is never sent to a host other than the App's: the clone URL's host must equal the App's web host, otherwise the clone is refused ("Refusing to send a GitHub App token to <host>").
- Every App, installation and Gitea call goes through the egress guard. Private destinations are refused unless `NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1`.
- Tokens are redacted from clone output, API errors and agent output.

### Audit actions

| Action | Actor | Meaning |
|---|---|---|
| `github_app.create` | operator | App registered (`via: manifest` or `manual`) |
| `github_app.update` | operator | renamed, OAuth fields changed, or webhook re-pointed (`changed: ["webhook"]`) |
| `github_app.rotate_key` | operator | private key replaced |
| `github_app.rotate_webhook_secret` | operator | new webhook secret registered on GitHub |
| `github_app.delete` | operator | App forgotten |
| `github_app.sync` | operator | installations synced (counts in meta) |
| `github_installation.created` | system | installation added by webhook |
| `github_installation.removed` | system | installation removed (webhook, or `detectedBy: sync`) |
| `github_installation.suspended` / `.unsuspended` | system | installation suspended or resumed on GitHub |
| `github_installation.permissions_updated` | system | new permissions accepted on GitHub |
| `github.repos_changed` | system | repositories added to or removed from an installation; names the affected services |
| `service.github_link` | operator, admin or system | service linked or re-linked, feedback toggled (`change: feedback`), or linked lazily on first clone |
| `service.github_migrate` | operator | PAT/webhook service linked to the App |
| `service.github_finalize` | operator | previous source detached, webhooks switched off |
| `service.github_unlink` | operator | reverted to the previous source |
| `service.repo_renamed` | system | clone URL corrected after a rename or transfer |

System entries have no actor, so only operators see them.

---

## 8. Troubleshooting

- **"The panel's address is http://localhost…, which GitHub cannot reach"** (`panel_origin_local`): set the panel domain under Settings → Security, or use manual entry with your own webhook secret.
- **Callback says the setup state was already used or expired:** start the setup again from Sources. The state lives in memory, so a panel restart in between invalidates it.
- **"GitHub refused the App credentials"** (`github_app_rejected`): the App id and key do not match, the key was revoked on GitHub, or the GHES base URL is wrong. Rotate the key.
- **Clone fails with "not found or no access":** add the repository to the installation's repository access (GitHub → Settings → Installed GitHub Apps → Configure), and check that the installation is not suspended. For a failing submodule in a sibling repository, set the token scope to `installation`.
- **"Refusing to send a GitHub App token to <host>":** the service's repository URL is not on the App's GitHub host. Fix the URL or use a different source.
- **Pushes do not deploy:** check the App's **Advanced → Recent deliveries** on GitHub. `401` means the webhook secret differs (run **Webhook sync**, or rotate the secret). `404 Unknown webhook` means the App was deleted from the panel or the webhook URL is stale (run **Webhook sync** after a domain change). An `ignored` answer with `no_linked_service` means no enabled link matches the repository id.
- **Remote node refuses an App repository:** update the node agent to v0.13.0 or newer (re-run its bootstrap from the Servers page), and make sure the sealed transport is in use.
- **A GHES or Gitea host on the LAN is refused:** the egress guard blocks private addresses. Set `NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1` on the server if that is intended.

---

## 9. Rolling back to 0.12

Rolling back the panel image to 0.12 is safe; the 0.13 tables and the `sources.base_url` column are ignored.

- **Migrated but not finalized** services keep their PAT and per-service webhook, which 0.12 uses as before.
- **App-only services** (created on, or finalized onto, a `github_app` source) clone anonymously on 0.12, so private repositories fail closed. No secret is exposed. Re-attach a PAT or deploy key to keep deploying, or switch the per-service webhooks back on.
- The 0.12 source test answers "Unknown source type" for `github_app` sources, and their type label is blank.
- `/v1/hooks/github-app/*` answers 404, so GitHub records failed deliveries until you upgrade again.
- Gitea base URLs are ignored; the Gitea test is "not supported" again.

Upgrading back to 0.13 restores everything: the links, Apps and installations are still in the database.

---

## 10. Gitea

0.13 adds a **base URL** to Gitea sources (Sources → New source → Gitea → *Gitea base URL*, the card's *Base URL · edit*, `ninedeploy sources add --base-url https://git.example.com`, or `baseUrl` on `POST`/`PATCH /v1/sources`). With it:

- **Test token** calls `GET <base>/api/v1/user` and reports `{ok, provider: "gitea", login, name}`;
- the Deploy Wizard lists your repositories (`<base>/api/v1/user/repos`, following the `Link` header) and their branches.

Without a base URL the test keeps its old answer, now with the message "Set the Gitea base URL to enable the live test". The base URL must be `https` (`http` only with `NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1`), without credentials, query or fragment; `PATCH` with `baseUrl: null` clears it. A base URL on any other source type is refused.
