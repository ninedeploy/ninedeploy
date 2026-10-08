# Rolling back a release

Upgrades are built so that the previous release still boots on the upgraded data: migrations only add tables and columns, and an older release ignores what it does not know. A rollback is therefore a matter of running the previous image or tag again. This page lists what each release leaves behind when you do, and how to clean it up.

**How to roll back:**

- **Installer-managed Docker:** re-run the installer pinned to the previous tag (`bash install.sh --docker --version v0.14.0`), or set `NINEDEPLOY_IMAGE_TAG` in `/opt/ninedeploy-docker/.env` to that tag and run `docker compose pull && docker compose up -d` there.
- **Your own compose file or `docker run`:** start the previous image on the same data volume, with the same `NINEDEPLOY_MASTER_KEY` and `NINEDEPLOY_JWT_SECRET`.
- **Bare metal:** re-run the installer pinned to the previous tag: `bash install.sh --version v0.14.0`.

See [QUICKSTART.md §4](./QUICKSTART.md) for the install modes. Every upgrade first snapshots the database and master key (`.data/upgrade-backups/` on bare metal). You do not need to restore that snapshot to roll back, and restoring it would throw away everything written since the upgrade.

To rehearse the 0.15 → 0.14 rollback on throwaway containers, run `node scripts/smoke-upgrade.mjs --from=v0.15.0 --from-image=<candidate image> --to=v0.14.0`. It asserts the behaviour described below: 0.14 boots, migration 0071 stays recorded with its rows, Traefik is recreated without the traffic-log mount and the domain still routes, a guest's grant no longer opens anything, and the terminal-helper runbook command works. It records what `<data>/traffic-logs` still holds and whether a shell left open across the stop is still running. The 0.14 → 0.13 rehearsal is the same command with `--from=v0.14.0 … --to=v0.13.0`.

---

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
