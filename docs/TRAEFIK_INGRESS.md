# Ingress, Routing & Cloudflare Tunnels

NineDeploy embeds Traefik as its reverse proxy and ingress controller, providing automated TLS certificates, custom middlewares, and secure tunneling.

---

## 🌐 1. Dynamic Ingress Architecture

- **Automatic Route Generation**: Every deployed service is assigned dynamic Traefik routers based on its domain configurations.
- **Health-Gated Routing**: Traefik only sends traffic to containers marked healthy by NineDeploy's health monitoring loop.
- **WebSocket & HTTP/2 Support**: Native bidirectional streaming for WebSockets, SSE, and HTTP/2 multiplexing.

---

## 🔒 2. Let's Encrypt SSL Certificates

- **HTTP-01 Challenge**: Automatic SSL issuance for apex and subdomains on port 80/443.
- **DNS-01 Challenge**: Automatic wildcard SSL certificates (`*.yourdomain.com`) via Cloudflare, DigitalOcean, Hetzner, Linode, Gandi or DuckDNS DNS API integration.
- **Auto-Renewal**: Traefik automatically renews certificates 30 days before expiration.
- **HTTP → HTTPS**: a domain with SSL on also answers plain HTTP with a redirect to HTTPS (a temporary one, so turning SSL off takes effect). The panel domain does the same once an ACME email is configured.

---

## 🛡️ 3. Middlewares & Rate Limiting

Apply security middlewares directly from the dashboard:
- **IP Allowlisting / Denylisting**: Restrict internal admin services to VPN/office CIDRs.
- **Basic Auth**: Add an extra authentication layer in front of legacy web services. Passwords are stored and rendered as APR1 htpasswd hashes (`user:password` is hashed on save; a pasted `user:$apr1$…` / bcrypt entry is kept as is), and are hidden from viewer seats.
- **Custom Headers & CORS**: Inject HSTS, Content-Security-Policy, and CORS headers automatically.

---

## 🚇 4. Cloudflare Tunnels Integration

Deploy services on private servers, home labs, or NAT-restricted environments without opening public ports or configuring firewall port-forwarding.
- Secure outbound connections to the Cloudflare Edge network.
- DDoS mitigation and global anycast routing.

---

## 🧾 5. Domain claim limits

Operators can tune how domains are claimed with `PUT /v1/settings/domain-policy` (instance operators are exempt from the caps; `0` disables a limit):
- `maxOwnZoneDomainsPerService` (default 50): domains one service may hold inside the instance's own wildcard zone, which need no DNS proof. Existing domains are never removed.
- `maxDomainCreatesPerHour` (default 30): domains one account may add per rolling hour.
- `pendingExpiryDays` (default 30): unverified domains are removed after this many days. A claimant who proves a hostname another service holds only as unverified can take it over: the add request explains the TXT record to publish.

---

## 📁 6. The dynamic config directory (0.14)

From 0.14 the panel's Traefik reads a **directory** instead of one file. The static config (`<data>/traefik/traefik.yml`) says `providers.file.directory: /etc/traefik/dynamic` with `watch: true`, and `<data>/traefik/dynamic/` holds up to three files. Each is written atomically with mode 0600:

| File | Contents | Present when |
| :--- | :--- | :--- |
| `ninedeploy.yml` | The generated routes, the same content `dynamic.yml` held before 0.14 | Always |
| `certificates.yml` | Uploaded certificates, inline (section 8) | At least one valid certificate is uploaded |
| `custom.yml` | The operator's custom dynamic config (section 7) | A custom config is saved |

**The first 0.14 boot recreates `ninedeploy-traefik` once,** through the same guarded path every static change uses: the image is pulled before the old container is removed, and liveness is checked afterwards. Before the recreate, the panel copies the legacy `<data>/traefik/dynamic.yml` to `dynamic/ninedeploy.yml`, so the new container starts with every existing route and there is no 404 window. The legacy file stays on disk and is no longer written. If the recreate fails (for example, the image pull fails), the old container keeps serving `dynamic.yml`, and route writes are mirrored into it until a later recreate succeeds.

**Remote nodes.** Node proxies use the same directory provider. Before 0.14 they loaded **no routes at all**: their static config pointed at `/etc/traefik/dynamic.yml`, but the agent wrote `dynamic/ninedeploy.yml`. Each node recreates its proxy once after the upgrade and then serves its routes. The custom config stays panel-only in 0.14. Uploaded certificates are sent to a node inline in its generated file, and only for hostnames that node routes. The agent caps a node's dynamic config at 1 MiB, so the panel warns once uploaded certificates pass about 512 KiB.

The Traefik page (`GET /v1/traefik/config`) reads `dynamic/ninedeploy.yml` and lists what `custom.yml` defines separately, under `custom`.

---

## ✏️ 7. Custom dynamic config

Operators can add their own routers, middlewares, services and TLS options next to the generated ones: **Traefik → Custom config**, `ninedeploy proxy config get|validate|set|clear`, or the API:

| Route | Purpose |
| :--- | :--- |
| `GET /v1/traefik/custom-config` | `{content, sha256, updatedAt, updatedBy, status: none\|applied\|rejected, lastError}` |
| `POST /v1/traefik/custom-config/validate` | `{ok, errors[], warnings[]}`; changes nothing |
| `PUT /v1/traefik/custom-config` | `{content}`: validate, preflight, write |
| `DELETE /v1/traefik/custom-config` | Remove the file and the stored versions |

All four are **operator-only**. Fine-grained API tokens are refused: a custom router could take over another tenant's hostname.

**Rules** (a violation is a 400 with `errors: [{path, message}]`):

- UTF-8, no NUL, at most **256 KiB**, at most 50 000 YAML nodes. YAML aliases (`*name`) and merge keys (`<<`) are refused. Keys are matched case-insensitively, as Traefik reads them, so `Routers` and `routers` count as the same key.
- Top-level keys: `http`, `tcp` and `tls.options` only. `udp`, `tls.certificates` and `tls.stores` are refused; upload certificates instead (section 8).
- Sections: `http.routers`, `http.middlewares`, `http.services`, `http.serversTransports`, `tcp.routers`, `tcp.services`, `tcp.middlewares`.
- **Every name you define starts with `custom-` or `custom_`** (`^custom[-_][A-Za-z0-9_-]{1,100}$`). Generated names (`<slug>_<id>`, `svc_*`, `mw_*`, `ninedeploy_panel*`) can therefore never collide with yours. You may *reference* a generated service or middleware; you get a warning, because it can be renamed when its service changes.
- Routers: `entryPoints` within `web` and `websecure` (TCP routers: `websecure` only, and they must list it). `priority` below 100000, the panel router's. `tls.certResolver` may only be `letsencrypt`, and only when an ACME email is set.
- These keys are refused anywhere: `plugin`, `certFile`, `keyFile`, `rootCAs`, `ca`, `caFiles`. No file on the host can be named from here.
- `{{ … }}` is escaped before Traefik reads the file, so Go templates cannot read the environment (for example, a DNS provider token).

**Saving.** A `PUT` that passes the rules is loaded first by a **throwaway Traefik** (`--network none`, read-only, the current `ninedeploy.yml` and `certificates.yml` beside it, about 5 seconds). If that Traefik reports a file-provider error, the answer is 422 (`custom_config_refused`) and nothing is written. If Docker cannot run it, the answer is 503 (`traefik_validation_unavailable`) and nothing is saved. Otherwise the file is written, and the live Traefik's log is watched for about 4 seconds. If Traefik still rejects the file, the panel restores the last good version (or removes the file) and answers 422 (`custom_config_rejected`, audited as `traefik.custom_config.rejected`). Problems below the file level, such as a router naming a middleware that does not exist, come back as `warnings` and do not block the save.

This is strict for a reason: in directory mode, **one file Traefik cannot decode freezes every dynamic update**, including the generated routes. The preflight is the main guard. The post-write log check is best-effort, because Traefik's log wording changes between versions.

**Storage.** The content is stored encrypted in the database (settings `traefik_custom_config_encrypted` and `traefik_custom_config_last_good_encrypted`; the status is in `traefik_custom_config_status`). The database is the source of truth: every boot rewrites `custom.yml` from the last good version. Saves and clears are audited as `traefik.custom_config.save` and `traefik.custom_config.clear`, with the sha256, never the content.

Example:

```yaml
http:
  middlewares:
    custom-hsts:
      headers:
        stsSeconds: 31536000
        stsIncludeSubdomains: true
  routers:
    custom-status:
      rule: "Host(`status.example.com`)"
      entryPoints: [websecure]
      service: custom-status
      tls: {}
  services:
    custom-status:
      loadBalancer:
        servers:
          - url: "http://10.0.0.20:8080"
```

---

## 🔐 8. Uploaded certificates

Bring your own certificate (a commercial or internal-CA certificate, or a wildcard you manage elsewhere): **Traefik → Certificates**, `ninedeploy certificates custom list|upload|replace|delete`, or `GET`/`POST /v1/traefik/certificates/custom` and `PUT`/`DELETE /v1/traefik/certificates/custom/:id`. Operator-only, for the same reason as the custom config: a wildcard certificate would let a member take over other tenants' TLS.

**What an upload must be** (otherwise 400 `invalid_certificate`):

- A PEM chain with the **leaf first** (at most 64 KiB), and its private key (at most 16 KiB). The key must match the leaf and must not be passphrase-protected.
- Key types: RSA of 2048 bits or more, ECDSA P-256 or P-384, or Ed25519.
- The leaf must not have expired. Its hostnames come from the SAN DNS entries, or from the CN when there is no SAN at all.
- At most 100 certificates, and each certificate (by sha256 fingerprint) only once (409).

The chain is stored as is; the key is encrypted with the master key. A key that no longer decrypts (a lost master key) is skipped when rendering, and audited once; it never breaks the routes.

**When a certificate is used.** An SSL domain whose every hostname is covered by a valid uploaded certificate is rendered with `tls: {}` and **no** `certResolver`, so Traefik serves the uploaded certificate from `certificates.yml`. Coverage means an exact name or a single-label wildcard (`*.example.com` covers `app.example.com`, not `a.b.example.com`). A domain with a www redirect needs both names covered. The panel domain follows the same rule. Expired certificates are never served, so a domain they covered falls back to ACME (or to Traefik's default certificate without an ACME email).

**Interplay with Let's Encrypt.** Nothing changes until a covering certificate is uploaded: every other domain keeps `certResolver: letsencrypt` (or `tls: {}` without an ACME email). Deleting the certificate puts the resolver back on the next render. Not verified yet: which certificate Traefik prefers when `acme.json` already holds an ACME certificate for the same host. If a covered domain keeps serving its ACME certificate, remove the domain and add it again.

**Inventory and alerts.** Uploaded certificates appear in the certificate inventory with their real issuer and subject, `source: static` and `autoRenew: false`, and they feed the `cert-expiry` alert metric. Renew them yourself with *replace*. Uploads, replacements and deletions are audited as `traefik.certificate.upload`, `.replace` and `.delete`, with the fingerprint and hostnames, never the PEM.

> **Expiry alerts start firing after the 0.14 upgrade.** Before 0.14 the panel could not read the expiry dates in `acme.json` (Traefik stores the certificates base64-encoded), so every ACME certificate's expiry was unknown and the `cert-expiry` alert never fired. If an alert fires right after the upgrade, that certificate really is close to expiry. Check why Traefik is not renewing it (port 80 reachability, DNS, rate limits).

---

## 🗄️ 9. Public database access

Make one managed database reachable from outside the host, for a BI tool, a laptop or another cloud: **Database → Settings → Public access**, `ninedeploy databases public-access <id> …`, or:

| Route | Who | Purpose |
| :--- | :--- | :--- |
| `GET /v1/databases/:id/public-access` | `admin` on the database | `{supported, configured, enabled, port, tlsMode, tlsHostname, ipAllowlist, status: off\|running\|error, lastError, appliedAt, publicHost}` |
| `PUT /v1/databases/:id/public-access` | Instance operator | `{enabled: true, port, ipAllowlist, tlsMode: none\|terminate, tlsHostname?}`; applied before the answer |
| `DELETE /v1/databases/:id/public-access` | Instance operator | Turn it off; the settings are kept for a later re-enable |

Turning it on spends a host-wide port and puts the database within reach of the internet, so it is operator-only, the same precedent as Database Studio.

> **⚠ Public access exposes the database's root (superuser) account.** The connection string NineDeploy gives you, including `publicConnectionString` in `GET /v1/databases/:id/credentials`, uses the account the panel created the database with. Before you share an endpoint, create a separate user inside the database with only the rights the client needs, and give out that user instead.

**How it works.** Each database with public access gets its own small Traefik container, `nd-dbpub-<slug>`. The panel's main Traefik is never touched, so changing a database's access can never take the HTTP ingress down. The sidecar:

- publishes exactly one host port (`-p <port>:7000`) and joins the `ninedeploy` network. A TCP router (`HostSNI(*)`) behind an `ipAllowList` middleware forwards to `nd-db-<slug>` on the engine's port;
- runs with `--cap-drop ALL`, `no-new-privileges`, 128 MB of memory and half a CPU, as the panel's own uid:gid, with its config (`<data>/dbproxy/<slug>/`, mode 0600) mounted read-only;
- carries the labels `ninedeploy.public-db=<databaseId>` and a config fingerprint.

**Engines.** postgres, mysql, mariadb, redis, valkey and mongo. clickhouse and meilisearch speak HTTP: put a service with a domain in front of them instead. rabbitmq is not supported yet. Both are refused with 422.

**The allow-list is required.**

- 1–100 entries, each an IPv4 or IPv6 address or CIDR range. An empty list is never "allow everyone".
- A `/0` range (`0.0.0.0/0`, `::/0`) is refused, and so are IPv4-mapped IPv6 entries (write the IPv4 form). Entries are stored normalised, with the host bits cleared.
- Prefer single addresses or narrow ranges. The UI warns about ranges wider than /16 (IPv4) or /48 (IPv6), and about private, loopback and link-local ranges: Docker's userland proxy can rewrite the client address to the bridge gateway, so a private range can admit more than you expect.
- IPv6 clients are reached only when Docker's IPv6 support is on and the list holds IPv6 entries.

**Port.** 1024–65535. Not a port NineDeploy listens on (panel, Traefik, SSH), not another database's public port, and not a service's published port (409). A port another host process already holds fails when the sidecar starts, and the API answers 409 with Docker's message.

**TLS.**

- `none` (the default): plain TCP passthrough. Postgres, MySQL and MariaDB still negotiate their own TLS end to end if the server and client are set up for it.
- `terminate`: the sidecar terminates TLS with an uploaded certificate covering `tlsHostname` (section 8), or with Traefik's default self-signed certificate when none covers it. With the default certificate, `sslmode=require` works and `verify-full` does not. Allowed for postgres, redis, valkey and mongo; refused for mysql and mariadb, whose TLS is negotiated inside the protocol. For postgres in this mode `publicConnectionString` carries `?sslmode=require`. Postgres through a terminating proxy relies on Traefik's Postgres STARTTLS support, which has not been verified end to end. If a client cannot connect, switch back to `none`.

**Where clients connect.** `publicHost` is `tlsHostname`, else the panel domain, else the host of the panel's public URL. Point a DNS name at the server if you need a stable name.

**Lifecycle.**

- An allow-list or TLS change on the same port rewrites the sidecar's config, and Traefik reloads it without dropping the port. A port change recreates the sidecar, which drops that database's open public connections.
- If an apply fails, the previous sidecar is restored and the settings stay as they were (audited as `database.public_access.apply_failed`).
- Stopping or restarting the database needs nothing: the sidecar resolves it when a client connects. Deleting the database removes its sidecar first.
- At boot and every 5 minutes, the panel makes every enabled database's sidecar run with its current config, and removes orphan `ninedeploy.public-db` containers whose config lives under this panel's `<data>/dbproxy`.
- Uploading, replacing or deleting a certificate re-renders the config of every sidecar in `terminate` mode.
- Changes are audited as `database.public_access.enable`, `.update` and `.disable`, with the port, the number of allow-list entries and the TLS mode, never the addresses.

**Rolling back to 0.13** leaves the sidecars running with their allow-lists, and 0.13 cannot turn them off. Remove them with `docker rm -f $(docker ps -aq --filter label=ninedeploy.public-db)`. See [ROLLBACK.md](./ROLLBACK.md).

---

## 📈 10. Traffic analytics (0.15, opt-in)

Requests, status codes and latency per domain, read from Traefik's access log: **Traefik → Traffic** (operators), the traffic card on a service's page, `ninedeploy traffic …`, or the API:

| Route | Who | Purpose |
| :--- | :--- | :--- |
| `GET /v1/traffic/settings` | Instance operator | `{enabled, retentionDays, status: off\|starting\|running\|error, lastError, lastIngestAt, logBytes, malformedLines, dockerLogDriver}` |
| `PUT /v1/traffic/settings` | Instance operator | `{enabled?, retentionDays?}`; answers with the GET shape |
| `GET /v1/traffic/summary?range=1h\|24h\|7d\|30d&top=10` | Instance operator | Instance totals, a series, the top domains, the panel and the custom-config buckets, p50/p95/p99 |
| `GET /v1/services/:id/traffic?range=…` | Any seat on the service (`read/services`) | The same for the service's domains; empty series, never 404, without data |

`1h` and `24h` use minute buckets, `7d` and `30d` hour buckets; every answer states its `granularity` and whether analytics is `enabled`. Percentiles are estimated from a 12-bucket latency histogram (edges 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000 and 10000 ms). The read-only MCP tools are `traffic_summary` (per service) and `instance_traffic_summary` (operator).

**It is off on every install, new or upgraded.** With it off, the static config still says `accessLog: {}`, byte for byte what 0.14 wrote, so upgrading never recreates `ninedeploy-traefik`. **Turning it on or off recreates Traefik once,** synchronously, through the usual guarded path: about 1–2 seconds of refused connections. If the recreate fails, the setting goes back to its previous value, the previous config is re-applied and the answer is 502 `traefik_recreate_failed`. A browser that reaches the panel through Traefik can lose the answer to the recreate itself; the web card reads the settings again.

**What is logged.** When on, `accessLog: {}` is replaced by a JSON access log in a file:

```yaml
accessLog:
  filePath: /var/log/ninedeploy-traffic/access.log
  format: json
  fields:
    defaultMode: drop
    names:
      StartUTC: keep
      RouterName: keep
      ServiceName: keep
      RequestHost: keep
      RequestMethod: keep
      DownstreamStatus: keep
      DownstreamContentSize: keep
      Duration: keep
      OriginDuration: keep
    headers:
      defaultMode: drop
```

Every field not listed is dropped, and every header. **No client IP, no path, no query string, no user name and no header ever reaches the disk.** The host name is kept so the history keeps a label after a domain is deleted. Turning analytics on also ends the stdout access log, which held full request lines with query strings (OAuth codes, tokens in links) for as long as Docker kept the container log.

**Where the log lives.** `<data>/traffic-logs/`, mounted read-write into Traefik at `/var/log/ninedeploy-traffic` only while analytics is on. The panel creates the directory, so it can rename and delete the files Traefik writes. It sits outside `<data>/traefik/`, so the system export never includes it.

**How it is read.** The panel reads new complete lines every 10 seconds (at most 32 MiB per pass) from a cursor it stores with the counts in the same transaction, so a crash neither loses nor double-counts lines. Lines are attributed by router name: `<slug>_<domainId>` (and its `_http` twin) to the domain and its service, `ninedeploy_panel*` to the panel, `custom-*`/`custom_*` to your custom config, anything else to `other`. Malformed lines are skipped and counted in `malformedLines`.

**Rotation and disk use.** Once the file has been read past 64 MiB, the panel renames it to `access.log.1` and sends Traefik `SIGUSR1`, which reopens the log; the old file is drained and deleted on a later pass. That keeps the directory near 2 × 64 MiB while the panel runs. If Traefik does not reopen the file, the panel falls back to truncating after each read, losing at most one pass of lines. While the panel is down Traefik keeps appending; if the file is over 1 GiB at boot, the panel skips to its end, rotates, and audits `traffic.log_skipped` with the number of bytes skipped.

**Turning it off** recreates Traefik without the mount and with `accessLog: {}` again, drains what is left, and deletes the files in `<data>/traffic-logs`. The counts stay until retention.

**Retention.** Minute rows are kept 48 hours; hour rows `retentionDays` (default 30, 1–400). The hourly housekeeping deletes them in batches.

**Not covered in 0.15:** node proxies (their traffic is not counted), paths, client addresses and user agents (by design), and alerts on error rates or latency.

Changes are audited as `traffic.settings.update`, plus `traffic.enable` / `traffic.disable` with the previous state.

### Log rotation for Traefik's own container log (0.15)

Through 0.14, Traefik's stdout, where the default access log goes, was written to Docker's `json-file` log with no size limit, on the panel host and on every node. From 0.15, when `docker info` reports the `json-file` or `local` log driver, `ninedeploy-traefik` and node proxies are started with `--log-opt max-size=20m --log-opt max-file=3`. With any other driver nothing is added, because an option the driver does not accept would make `docker run` fail and take the ingress down.

The option is not part of the config fingerprint, so **it never forces a recreate**: it applies the next time the proxy is recreated for another reason (an ACME or DNS change, a Traefik update, turning analytics on or off). `GET /v1/traffic/settings` shows the detected driver as `dockerLogDriver`. To apply it sooner on the panel host, turn analytics on and off again; on a node, it applies at the node proxy's next recreate, with a 0.15 agent.

**Rolling back to 0.14 with analytics on:** 0.14 renders `accessLog: {}`, sees the fingerprint change and recreates Traefik once without the mount. `<data>/traffic-logs` stays on disk; see [ROLLBACK.md](./ROLLBACK.md).
