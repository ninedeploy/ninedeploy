# Terminals: container, database, node and host shells

From 0.15, an instance operator can open an interactive shell from the panel (the service and database pages, **Servers** for a node or the panel host, and the **Terminals** page for the history), from the CLI (`ninedeploy terminal …`) or from the SDK (`client.terminals`). Each session gets a real TTY, so prompts, echo, line editing and full-screen programs work, and the browser's terminal size reaches the shell. Every session is recorded as metadata and audited. Nothing you type or see is stored.

On Docker installs this also fixes the old container terminal, which never had a PTY: the official image has no `python3`, so it always fell back to a pipe with no prompt and no echo. Shells now go through the Docker Engine API, which gives a TTY without any native dependency.

---

## 1. What you can open

| Target | Where it runs | Default | Notes |
| :--- | :--- | :--- | :--- |
| `service` | The service's container on the panel host, or on the node it runs on (its primary placement or a fan-out target) | On | `replica` picks `<runtimeId>-r<n>`. Compose services are refused with 422 `use_container_target`: list their containers with `GET /v1/services/:id/containers` and open one with the `container` target. |
| `database` | The managed database's container (always on the panel host) | On | `mode: "shell"` opens a shell. `mode: "client"` opens `psql`, `mysql`/`mariadb`, `redis-cli` (Redis and Dragonfly), `valkey-cli` or `keydb-cli` with the stored credentials passed in the exec environment (`PGPASSWORD`, `MYSQL_PWD`, `REDISCLI_AUTH`), never on the command line. Other engines answer 422 `client_mode_unsupported` for client mode. |
| `container` | Any NineDeploy-managed container on the panel host, by name | On | A container of a node-placed service is refused with 422 `remote_container` (use the `service` target). The panel's own container is refused with 403 `panel_container_refused`: a shell there would expose `master.key` and the database. |
| `host` | The panel host (`serverId: null`) or a node | **Off** | See section 3. |

A target that is not running answers 409 `not_running`.

**Who.** Every terminal route is instance-operator-only, and fine-grained API tokens are refused (there is no token scope for terminals). A coarse API token with the `operator` scope can open container and database shells. Workspace admins, including admins through an access grant, cannot open terminals in 0.15.

---

## 2. Sessions, tickets and the protocol

Opening a terminal takes two steps:

1. `POST /v1/terminals` with `{target, cols?, rows?, password?}` (cols 10–500, default 120; rows 5–200, default 32). Authorisation, target resolution and, for a host shell, the password re-check all happen here, on a normal HTTP route. The answer is 201 with `{session, ticket, ticketExpiresAt, attachPath}`.
2. Open a WebSocket to `attachPath` (`/v1/terminals/:id/attach`) offering two subprotocols: `ninedeploy.terminal.v1` and `ninedeploy.ticket.<ticket>`. The server selects `ninedeploy.terminal.v1`, so the ticket is never echoed back.

The ticket is 32 random bytes, valid for **30 seconds** and usable **once**. Only its sha256 is stored. A reused, expired or unknown ticket closes the socket with 4401. When a browser connects, its `Origin` must be one of the panel's origins (otherwise 4403). The CLI and SDK in Node send no `Origin`, which is allowed, because the ticket and not a cookie is the credential.

**Frames (protocol v1):**

- Client → server: binary frames are keyboard input. Text frames are JSON control messages: `{"t":"resize","cols":n,"rows":n}` and `{"t":"ping"}`.
- Server → client: binary frames are terminal output. Text frames are JSON: `{"t":"ready","sessionId","target":{kind,label,serverId}}` once the shell is up, `{"t":"notice","message"}`, and `{"t":"exit","code","reason"}` just before the close.
- Input sent before `ready` may be lost. The CLI and SDK hold it and send it on `ready`.

**Close codes:**

| Code | Meaning |
| :--- | :--- |
| 1000 | The shell exited |
| 1009 | A frame was larger than 64 KiB |
| 4401 | Bad, used or expired ticket |
| 4403 | Forbidden: wrong `Origin`, or access was revoked during the session |
| 4408 | Idle timeout (no input) |
| 4409 | Maximum session length reached |
| 4410 | Terminated by an operator (`DELETE /v1/terminals/:id`) |
| 4429 | Too many open sessions |
| 4502 | The target could not be reached (Docker or the node's agent failed) |

**Limits** (Settings → Security → Terminals, or `PUT /v1/terminals/settings`):

| Setting | Default | Range |
| :--- | :--- | :--- |
| `idleTimeoutMinutes` | 15 | 1–240 |
| `maxSessionMinutes` | 240 | 5–1440 |
| `maxConcurrent` (whole panel) | 10 | 1–50 |
| `retentionDays` (session history) | 180 | 30–3650 |

Each user may also hold at most **3** live sessions. While a session runs, the panel re-checks every 60 seconds that the user is still an operator, that the sign-in (or API token) that opened it is still valid, and, for a host shell, that host shells are still enabled. A failed check ends the session with 4403. Browser sessions are checked against the sign-in session and the account's token version, not the 15-minute access token, so a terminal outlives a token refresh. Output is paused while more than 4 MiB is waiting to reach a slow client.

**When a session ends**, however it ends, the panel stops the shell. Docker keeps an exec process running after its connection drops, so the shell reports its process id when it starts (an escape sequence the panel strips from the output) and the panel sends it `SIGHUP`, then `SIGKILL` 5 seconds later if it is still running. A host shell's helper container is force-removed.

---

## 3. Host shells (off by default)

A host shell is a root shell on the server. In a Docker install the panel container already holds the Docker socket, so it adds no privilege an operator does not have, but it turns a stolen operator browser session into a root shell in one click. That is why it is behind several gates, all of which must pass:

1. **The setting** `hostTerminalEnabled` is on. It is off on every install, new or upgraded. Turning it on needs an interactive session (not an API token) and your current password (or, for an SSO-only account, a sign-in less than 10 minutes old). A wrong password answers 403 `invalid_password`.
2. **The environment does not forbid it.** `NINEDEPLOY_HOST_TERMINAL=off` on the panel wins over the setting (`GET /v1/terminals/settings` reports it as `hostTerminalForbiddenByEnv`). Use it to forbid host shells from infrastructure-as-code.
3. **Each session** needs an interactive session and the password re-check again.
4. **On a node,** the node's agent must allow it (section 4).

While host shells are off, a host target answers 403 `host_terminal_disabled`. Turning the setting off ends every live host shell.

**How it works on the panel host.** The panel starts a short-lived helper container, `nd-hostshell-<sessionId>`, privileged and in the host's PID, network, IPC and UTS namespaces, which runs `nsenter -t 1 -m -u -i -n -p` into a login shell (`bash` when the host has it, otherwise `sh`). The helper carries the labels `ninedeploy.terminal.session=<id>` and `ninedeploy.terminal.expires=<unix time>`, is auto-removed when the shell exits, and is force-removed when the session ends. At boot the panel removes every container with that label, and a reaper removes, every 60 seconds, any helper whose session is not live.

- **Helper image.** `NINEDEPLOY_HOST_SHELL_IMAGE`, by default the Traefik image (`traefik:3`), which is already on the host and has BusyBox's `nsenter`. The panel checks the image once per process by running `nsenter --help`. An image without `nsenter` answers 422 `host_shell_image_unsupported`; a missing image names the `docker pull` to run.
- **Docker transport.** Host shells need the Docker Engine API over the local socket or plain `tcp://`. With a TLS or `ssh://` `DOCKER_HOST`, or a Docker CLI context, host shells answer 422 `host_shell_unsupported_docker_host`, and container shells fall back to the CLI in pipe mode (no TTY, no resize).
- **Rootless Docker.** `nsenter -t 1` enters the rootless user namespace, not the real host.

Every host-shell start is also audited as `security.host_terminal`, which goes through the audit fan-out to notification channels and the plugin bus, so a host shell never goes unnoticed.

---

## 4. Node terminals

Service shells on a node and node host shells run through that node's agent:

- **Agent v0.15.0 or later.** The agent advertises a `terminal` capability in its sealed ping. An older agent, or a node the panel reaches only over the unencrypted transport, answers 422 `node_terminal_unsupported` with an "update the agent" message. Everything else on that node keeps working. `GET /v1/servers` shows `terminal: {host, container, reason?}` per node.
- **Encrypted end to end.** The panel asks the agent to open the shell with a sealed `terminal.open` request, then connects to the agent's `/agent/terminal` WebSocket with a single-use channel id (valid 30 seconds). Every frame is AES-256-GCM encrypted with a key derived per channel, and counters must increase by exactly one, so a captured stream can be neither replayed nor spliced. Terminal bytes never cross the network in clear.
- **The node owner's switch.** A node advertises host shells (`terminal.host`) unless its agent runs with `NINEDEPLOY_AGENT_HOST_TERMINAL=off` (`NINEDEPLOY_HOST_TERMINAL=off` is honoured on the node too). A node that refuses answers 403 `host_terminal_disabled`. The panel's own gates (section 3) apply as well.
- **Agent limits:** at most 8 open terminals per node and a hard 24-hour cap per session. The agent only opens containers the panel names, and refuses its own container, the proxy and terminal helpers.
- **Databases on nodes (0.15.3).** A database placed on a node opens a **shell** in its `nd-db-<slug>` container through the node's agent, like a service shell (the same `terminal` capability and sealed transport), once the database is running. Client mode answers 422 `client_mode_unsupported`: the agent's terminal runs a shell only, so open a shell and run the client there (`psql -U nine app` for postgres). See [DATABASES_BACKUPS.md §8](./DATABASES_BACKUPS.md).

---

## 5. History and audit

Sessions are listed under **Terminals**, with `ninedeploy terminals list|show|kill`, with the read-only MCP tool `list_terminal_sessions` (operator, coarse token; the list includes client IPs), or `GET /v1/terminals?status=&userId=&targetKind=&limit=&before=` and `GET /v1/terminals/:id`. A row records **metadata only**: who, the target, the client IP and user agent, when it was created, started and ended, the duration, the bytes in and out, the end reason and the exit code. Statuses are `pending`, `active`, `ended`, `failed` and `expired`. End reasons include `shell_exited`, `client_closed`, `idle`, `max_duration`, `terminated`, `revoked`, `frame_too_large`, `target_unreachable`, `ticket_expired` and `panel_restart` (a restart ends every session, and no session survives it). Rows older than `retentionDays` are pruned by the hourly housekeeping.

**No transcripts.** Neither input nor output is recorded. Input would capture passwords typed at prompts (echo-off hides the output, not the keystrokes). Output would make the history a store of secrets (`env`, `cat .env`). Use the terminal accordingly: what you run is attributable to you through the audit trail, but its content is not kept anywhere.

Audit actions: `terminal.session.create`, `terminal.session.start`, `terminal.session.end` (written on every way a session can end, with duration, bytes and reason), `terminal.session.terminate`, `terminal.settings.update` and `security.host_terminal`.

An operator can end anyone's live session with `DELETE /v1/terminals/:id` (close 4410).

---

## 6. The old exec socket

`GET /v1/services/:id/exec`, the 0.14 web terminal's socket, still works for existing clients with its raw frames, auth and close codes unchanged. It now runs on the same engine, so it gains the TTY, a session row and the end audit. It has no resize, and it is deprecated: it will be removed no earlier than 0.17.

---

## 7. Upgrading and rolling back

**Upgrade.** Migration 0071 adds an empty `terminal_sessions` table. Host shells are off, container shells keep working for operators, and no setting row exists until you change one.

**Rollback to 0.14.** The table and the settings are ignored, and live sessions end with the process. 0.14 has no reaper, so a host-shell helper whose shell ignored the hang-up would linger. Remove leftovers on the panel host and on each node with:

```bash
ids=$(docker ps -aq --filter label=ninedeploy.terminal.session); [ -z "$ids" ] || docker rm -f $ids
```

A shell inside an app container that was open when the panel stopped abruptly (a crash or a hard kill) never receives the hang-up, on any release. It idles until the container is restarted or replaced by the next deploy. `docker top <container>` shows it. See [ROLLBACK.md](./ROLLBACK.md).

`node scripts/smoke-upgrade.mjs` exercises all of this against the published images: a protocol-v1 round trip with a resize, the ended row and its audits, a reused ticket (4401), the shell gone after a dropped socket, a host shell through the nsenter helper, and, as a rollback rehearsal, the runbook command above.
