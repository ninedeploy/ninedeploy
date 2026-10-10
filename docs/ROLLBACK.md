# Rolling back a release

Upgrades are built so that the previous release still boots on the upgraded data: migrations only add tables and columns, and an older release ignores what it does not know. A rollback is therefore a matter of running the previous image or tag again. This page lists what each release leaves behind when you do, and how to clean it up.

**How to roll back:**

- **Installer-managed Docker:** re-run the installer pinned to the previous tag (`bash install.sh --docker --version v0.14.0`), or set `NINEDEPLOY_IMAGE_TAG` in `/opt/ninedeploy-docker/.env` to that tag and run `docker compose pull && docker compose up -d` there.
- **Your own compose file or `docker run`:** start the previous image on the same data volume, with the same `NINEDEPLOY_MASTER_KEY` and `NINEDEPLOY_JWT_SECRET`.
- **Bare metal:** re-run the installer pinned to the previous tag: `bash install.sh --version v0.14.0`.

See [QUICKSTART.md §4](./QUICKSTART.md) for the install modes. Every upgrade first snapshots the database and master key (`.data/upgrade-backups/` on bare metal). You do not need to restore that snapshot to roll back, and restoring it would throw away everything written since the upgrade.

To rehearse the 0.15 → 0.14 rollback on throwaway containers, run `node scripts/smoke-upgrade.mjs --from=v0.15.0 --from-image=<candidate image> --to=v0.14.0`. It asserts the behaviour described below: 0.14 boots, migration 0071 stays recorded with its rows, Traefik is recreated without the traffic-log mount and the domain still routes, a guest's grant no longer opens anything, and the terminal-helper runbook command works. It records what `<data>/traffic-logs` still holds and whether a shell left open across the stop is still running. The 0.14 → 0.13 rehearsal is the same command with `--from=v0.14.0 … --to=v0.13.0`.

To rehearse the multi-node rollback below, run `node scripts/smoke-multinode.mjs --from=<candidate tag> --from-image=<candidate image> --to=v0.15.1`. The candidate panel and agent build, clone, ship images, attach volumes, place a database on the node and run a Swarm stack; then 0.15.1 boots on the same data while the candidate agent keeps running, and the smoke asserts the 0.15.1 column of the table below and runs the cleanup commands.

---

## 0.15.x multi-node rollback runbook

The remote-node features arrived in three patch releases: **0.15.2** (migration 0072, Nixpacks and Railpack builds on nodes, PAT and deploy-key clones on nodes, node volumes), **0.15.3** (build placement and image transfer, the build-server role, managed databases on nodes) and **0.15.4** (Swarm). Rolling the panel back past one of them never makes the older release act on the wrong host: what it cannot handle, it refuses or ignores, and the containers already running keep running. Migration 0072 stays recorded, its columns and the `image_transfers` table stay in place and are ignored, and upgrading again picks everything up where it was.

**Keep the node agents you have.** A newer agent under an older panel changes nothing (every older operation is unchanged), and the agent holds no state the older panel needs. Downgrading an agent only takes features away when you upgrade the panel again. The rehearsal above runs 0.15.1 against the candidate agent.

| Feature (on the panel) | Back to 0.15.3 | Back to 0.15.2 | Back to 0.15.1 or 0.15.0 |
| :--- | :--- | :--- | :--- |
| Nixpacks and Railpack builds on a node | Unchanged | Unchanged | A node service that builds with Nixpacks fails at its next deploy, with the reason in the log. A Railpack one builds the repository's Dockerfile instead. |
| PAT and deploy-key clones on a node (`allowOnNodes`) | Unchanged | Unchanged | Refused at the next deploy (400 `remote_deploy_unsupported`); the toggle is ignored. |
| Volume attachments, a command or the Docker socket on a node service | Unchanged | Unchanged | Refused at the next deploy (400). The volumes stay on the node. |
| Node volume backups | Unchanged | Unchanged | Listed and downloadable, but **do not restore one**: 0.15.1 restores into the panel host's volume of the same name, not the node's. |
| Build placement (`buildOn`), build servers, image transfers | Unchanged | Ignored: every service builds where it runs. A node service built on the panel builds on its node again (its PAT or key needs `allowOnNodes`; the static pack is refused); a panel service built on a build server builds on the panel. | Ignored, as for 0.15.2, and a node service that clones with a PAT or key, or builds with Nixpacks or the static pack, is refused or fails at its next deploy. |
| Managed databases on a node | Unchanged | Refused: start, restart, backup, restore and import fail and nothing runs on the panel host; stop only changes the status; logs, size and the terminal give nothing; public access answers 422. | As for 0.15.2, except that turning public access on starts a sidecar on the panel host that cannot reach the database. |
| Swarm | Degrades: see the next section | Degrades | Degrades |

In every column, the containers the newer release started keep running, and a refused service keeps its last container until you upgrade again or clear its node.

**Managed databases on nodes** (back to 0.15.2 or earlier). The older release sees a node database as a row without a container name and refuses to act on it. The database keeps running on its node with its data, but the panel can no longer manage or back it up, and the scheduled backup records a failure every day. If the rollback may last, take a backup on the newer release first: backups are ordinary files on the panel, and the older release can still download them, or restore them into a database on the panel host.

```sql
-- the databases placed on nodes (sqlite3 <data dir>/ninedeploy.db)
SELECT id, name, server_id, node_container_name FROM databases WHERE server_id IS NOT NULL;
```

```bash
# on the node: the database is still there
docker exec -it nd-db-<slug> psql -U nine app          # postgres; other engines: their own client
# on the panel host, 0.15.1 or earlier only: a public-access sidecar started for a node database
docker rm -f nd-dbpub-<slug>
# on the panel host: a Studio container started for a node database (it cannot reach it)
docker rm -f nd-studio-<slug>
```

Do not delete node databases on the older release: it deletes the row and leaves the container and its `nd-db-<slug>-data` volume running on the node, unmanaged. If that happened, run `docker rm -f nd-db-<slug>` on the node, and keep or remove the volume. Deleting the node itself fails while a database is placed on it, even with `?force=true`.

**Node volumes and images** (back to 0.15.1 or earlier):

```bash
# on each node
docker volume ls --filter label=ninedeploy.managed=volume     # volumes created for node services
docker image ls 'ninedeploy/*'                                # builds and shipped images; remove the ones nothing runs
rm -rf /var/lib/ninedeploy-agent/.agent-work/.transfer        # only if an agent died mid-transfer (a current agent sweeps it)
```

---

## Swarm services → a release before Swarm (0.15.3 or earlier)

Swarm services **keep serving** after the rollback (they degrade instead of being refused). The other multi-node features the older release lacks make it refuse to act (see the runbook above).

- **Routes keep working:** the older release routes to `runtimeId` (`nd-<slug>_web`) like any container, and Traefik stays attached to the service's overlay, as long as the Traefik container is not recreated. The older release does not re-attach Traefik to `nd-swarm-*` overlays after Traefik restarts, so after such a restart those routes return 502 until the service is redeployed.
- **The next deploy of such a service runs it as plain containers** on the panel host (`services.replicas` round-robin clones, no Swarm). The route moves to the new container, and **the stack keeps running without a route**. The image is pullable from the registry or already on the panel host, so that deploy works.
- **Clean up** once the local deploy is live: `docker stack ls`, then for each NineDeploy stack `docker stack rm nd-<slug>`, `docker network disconnect nd-swarm-<slug> ninedeploy-traefik` (Traefik is still attached, and Docker refuses to remove a network in use) and `docker network rm nd-swarm-<slug>`; repeat the `rm` if it reports active endpoints while the stack's tasks are still shutting down. Run `docker swarm leave --force` on the nodes, and then on the panel host, only if you are giving up Swarm.
- `/v1/orchestrators` still lists the stacks. A downgraded node agent refuses join and leave, but the node stays in the swarm, because membership lives in the node's Docker daemon.
- **Node labels stay:** `nd.member=1` and `nd.preload.<slug>=<image id prefix>` remain on the nodes, and a running stack keeps requiring them, so its tasks stay where they are. They are harmless once the stacks are gone; remove them with `docker node update --label-rm nd.member <node>` (and the same for each `nd.preload.<slug>`) when you clean up. The per-deploy registry config directories under `<dataDir>/swarm/.docker-*` are removed after each deploy; a crash can leave one behind, which only the newer release sweeps at boot, so delete any you find there.

## KeyDB and Dragonfly databases → a release before 0.15.6

A KeyDB or Dragonfly database (engine `keydb` / `dragonfly`) needs no migration; its row is an ordinary `databases` row whose `engine` text an older release does not know. The container keeps serving, but the older panel cannot manage it:

- **The Databases list answers HTTP 500 for instance operators** while a *running* row of an unknown engine exists (the older release builds the connection string for every running row and throws on the engine name). Members' lists still load. Fix it before you roll back: delete the KeyDB / Dragonfly databases (their volumes are retained), or stop them from the panel so the row is no longer `running`.
- Scheduled backups of such a database are recorded as failed every night; manual backup, restore, start and Studio fail with an unknown-engine error. A service attached to it fails its deploy when the older panel builds its environment.
- Rolling forward again restores everything; the data lives in the volume `nd-db-<slug>-data` (`/data/dump.rdb`, a standard RDB file that Redis can also read, up to the RDB version Redis understands).

## 0.15 → 0.14

0.14 boots on 0.15 data. Migration 0071 stays recorded, and its three tables (`access_grants`, `terminal_sessions`, `traffic_rollups`) are left untouched and ignored, as are the 0.15 settings keys. Upgrading to 0.15 again picks everything up where it was. Every effect below is a **loss** of access or of a feature, never a gain.

### Access grants stop counting (fail-closed)

0.14 has no grants. **Guests** (users with grants but no seat in a workspace) lose all access to that workspace, and users whose role a grant raised fall back to their seat role. Nothing becomes more permissive. Tell your guests before you roll back. The rows stay in `access_grants` and count again after an upgrade back to 0.15. To drop them for good instead, run `DELETE FROM access_grants;` against the panel database while the panel is stopped.

### Traffic analytics: Traefik is recreated once, the logs stay

- **Analytics on:** 0.14 renders `accessLog: {}`, sees the fingerprint change and recreates `ninedeploy-traefik` once, without the `/var/log/ninedeploy-traffic` mount (about a second of refused connections). Domains keep routing. Traefik's access log goes back to stdout, with full request lines.
- **Analytics off:** nothing happens; 0.15 never changed the static config.
- **`<data>/traffic-logs/` stays on disk** (`access.log`, possibly `access.log.1`; at most about 128 MiB while the panel ran). It holds no client address, path or header. Remove it:

  ```bash
  rm -rf <data>/traffic-logs
  # Docker install, from the host:
  docker exec <panel container> rm -rf /data/traffic-logs
  ```

- **Log rotation:** a Traefik container that 0.15 created with `--log-opt max-size=20m --log-opt max-file=3` keeps those options until 0.14 recreates it; the recreate above drops them. A node proxy keeps them until its next recreate.

### Terminals

Live sessions end with the 0.15 process; the session history is ignored. 0.14 has no reaper for host-shell helper containers, so a helper whose shell ignored the hang-up would keep running. Remove leftovers on the panel host and on each node (the command does nothing when there are none):

```bash
ids=$(docker ps -aq --filter label=ninedeploy.terminal.session); [ -z "$ids" ] || docker rm -f $ids
```

A shell inside an app container that was open when the panel stopped abruptly never received the hang-up. It idles until the container is restarted or replaced by the next deploy; `docker top <container>` shows it. 0.14's web terminal keeps working (on Docker installs it goes back to pipe mode, with no prompt or echo). Node terminals are unavailable on 0.14; a 0.15 node agent keeps working with a 0.14 panel.

### The OpenAPI document and the 0.15 MCP tools

`GET /v1/openapi.json` and the 0.15 routes answer 404 on 0.14. The 0.15 MCP server's generated tools for those routes (`traffic_summary`, `instance_traffic_summary`, `list_terminal_sessions`, `list_access_grants`, `my_access`) and `search_api` fail against a 0.14 panel; the others keep working.

---

## 0.14 → 0.13

0.13 boots on 0.14 data. Migration 0070 stays recorded, and its four tables (`database_public_access`, `tls_certificates`, `database_imports`, `secret_providers`) are left untouched and ignored. Upgrading to 0.14 again picks everything up where it was.

### Traefik goes back to a single file

On its first boot, 0.13 renders its static config with `providers.file.filename: /etc/traefik/dynamic.yml` again, sees the fingerprint change, and recreates `ninedeploy-traefik`. Its boot then rewrites `<data>/traefik/dynamic.yml` with the current routes. Routes may be stale for about a second.

- **The custom dynamic config stops applying.** `custom.yml` is no longer read, so every custom router, middleware and service is gone until you upgrade again.
- **Domains that used an uploaded certificate** fall back to Let's Encrypt (or to Traefik's default certificate when no ACME email is set). Expect certificate warnings on those hostnames until Let's Encrypt has issued.
- **`<data>/traefik/dynamic/` stays on disk.** It holds `ninedeploy.yml`, `custom.yml` and `certificates.yml`. **`certificates.yml` contains the private keys of your uploaded certificates inline** (mode 0600). The keys remain encrypted in the database. If you do not plan to upgrade again soon, remove the directory:

  ```bash
  rm -rf <data>/traefik/dynamic
  ```

  `<data>` is the panel's data directory: `.data/` in a bare-metal checkout, or `/data` inside the panel container, which is the data volume (`docker volume ls | grep ninedeploy-data` finds it, `docker volume inspect <name> --format '{{.Mountpoint}}'` shows its host path). From the host you can also run it in the panel container, for example `docker exec <panel container> rm -rf /data/traefik/dynamic`. 0.14 recreates the files from the database on its next boot.

### Public database sidecars keep running

0.13 does not know the `nd-dbpub-<slug>` containers, so it neither stops nor manages them. They keep publishing their ports and keep enforcing their allow-lists, but nothing can turn them off from the panel. The automatic prune treats `nd-*` containers as infrastructure and leaves them alone. Remove them all with:

```bash
docker rm -f $(docker ps -aq --filter label=ninedeploy.public-db)
```

Their config directories, `<data>/dbproxy/<slug>/`, can be removed as well. After an upgrade back to 0.14, the boot reconcile starts a sidecar again for every database whose public access is still enabled.

### Dump import staging files

An import that was uploading or pending at the time of the rollback leaves its staging file in `<data>/backups/imports/` (`<importId>.part`, and possibly a `.raw` sibling). 0.13 does not clean that directory. Delete it:

```bash
rm -rf <data>/backups/imports
```

`pre-import` safety backups are ordinary database backups and stay listed and restorable on 0.13.

### Vault and AWS secret references become literal

0.13 does not resolve `${{vault:…}}` or `${{aws:…}}`. A service deployed on 0.13 receives the **literal reference text** in its environment. Nothing leaks, but the app is misconfigured. Before rolling back, move those values into ordinary secret env vars (or into Infisical or Doppler), or avoid redeploying the affected services until you upgrade again. Containers already running keep the values they were started with. See [SECRET_MANAGERS.md](./SECRET_MANAGERS.md).

### Remote nodes

0.14 recreated every node's proxy once on a directory provider, which is what made node proxies load their routes at all: from 0.7.0 to 0.13.x their static config pointed at a file the agent never wrote, so they loaded none (see [TRAEFIK_INGRESS.md §6](./TRAEFIK_INGRESS.md)). When 0.13 next syncs a node's proxy, it pushes its own single-file static config again, which puts the node back in that state: **node-hosted domains stop being routed** until you upgrade again.

### Certificate expiry alerts

0.14 reads the real expiry of ACME certificates, so `cert-expiry` alerts can fire after the upgrade for certificates that really are expiring. 0.13 cannot read those dates, so those alerts go quiet again after a rollback. The certificates do not change.
