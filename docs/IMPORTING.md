# Moving from Coolify, Dokploy, CapRover or Heroku

`ninedeploy import plan` reads another platform's API, or a Heroku app's `app.json` and `Procfile`, and shows what NineDeploy would create. For each item it also lists what NineDeploy cannot carry over and what needs a person. It is read-only: it creates nothing in NineDeploy and changes nothing on the source. `ninedeploy import apply` then creates what a saved plan describes. It never touches the source.

| Step | What it does | Status |
|---|---|---|
| 1. Plan | Read the source and list each service, domain, environment variable name, volume and database, with every unsupported option | Available (CLI) |
| Review | Open the saved plan in the panel and inspect the proposed resources and manual steps | Available (browser) |
| 2. Apply | Create the planned services and databases in NineDeploy, resumably, with a receipt per item | Available (CLI). The browser can prepare service definitions and empty databases. |
| 3. Data and cutover | Move database contents and primary service volumes with checksums, then deploy and switch DNS | Database and primary volume imports in the browser and CLI. Direct DNS cutover in the browser and CLI. |

## Run a plan

The command runs on your machine. The source credential stays there: it is read from an environment variable or a hidden prompt, never from the command line, and it is never written to the plan.

```bash
# Coolify: turn on Settings → Advanced → API access, then create a token with "read" (Keys & Tokens).
NINEDEPLOY_IMPORT_TOKEN=… ninedeploy import plan coolify --url https://coolify.example.com

# Dokploy: create an API key for the organization (Profile → API keys) with rate limiting off: a default key allows 10 requests a day.
NINEDEPLOY_IMPORT_TOKEN=… ninedeploy import plan dokploy --url https://dokploy.example.com

# CapRover: the dashboard password (NINEDEPLOY_IMPORT_OTP for a two-factor code; otherwise it is asked for).
NINEDEPLOY_IMPORT_PASSWORD=… ninedeploy import plan caprover --url https://captain.apps.example.com

# Heroku: no credential. --url is the app's repository, --dir a checkout of it; --app names the Heroku app.
ninedeploy import plan heroku --url https://github.com/acme/shop.git --dir ./shop --branch main --app acme-shop
```

`--json` prints the plan as JSON, and `--out plan.json` also saves it. Leave the variable unset and the command asks for the credential without echoing it.

## Review the saved plan in the panel

Open **New resource → Review migration plan** and choose the version 1 JSON file saved by `--out`. The browser reads up to 2 MiB locally and shows the services, databases, domains, volume mappings, environment variable names and manual steps. Source-generated domains are marked as staying with the source.

The source credential stays on the machine that generated the plan.

Instance operators can select **Check target** to compare the plan with the target's current service and database inventory. The browser checks for occupied names, repeated names and references, missing sources, unsupported engines, and invalid settings. An occupied name can be a resource from an earlier attempt. Check its definition and receipt before proceeding. Resource creation performs its own checks, including runtime and storage checks, when you apply the plan.

Instance operators can select **Prepare resources → Create resources** to create service definitions and start empty databases on the panel host. The panel rechecks the inventory at confirmation, skips unsupported items and reports conflicts for review. If a database has a retained volume under the proposed name, creation stops for that item. Service deployment, environment values, database attachments, data transfer and domain cutover are separate steps.

To resume, reopen the same plan in the same browser tab as the same operator. The panel reads the target inventory and shows which preparations it verified by resource ID, normalized name, and service type or database engine. It also flags incomplete settings, unconfirmed requests, and missing or changed targets. **Check target** still reports names held by other resources. A verified preparation lets you continue with environment values, data transfer, deployment readiness, or domain cutover as applicable. These steps have their own checks. The CLI steps use their own receipt beside the plan. If you started in the browser and need to continue in the CLI, first review the prepared resources and run `import apply` with the same plan to create the CLI receipt.

### Migrate environment and connections

For a prepared service, choose its `.env` file under **Migrate environment and connections**. The panel previews key names locally. It accepts up to 100 KB with unique, single-line `KEY=value` entries. Import saves only planned variables as secrets and keeps existing service values. The preview lists planned keys missing from the file and known source connection keys that need review. Values are sent to the target panel when you confirm.

The panel can attach running databases specified explicitly in the plan, using their prepared target IDs and planned environment aliases. An attachment supplies its connection string on the next deployment. Aliases reserved for these attachments are excluded from the `.env` import. A conflict with an existing variable or attachment needs review. For connection strings inferred from copied values, use the CLI workflow below or edit the connection in the service's Environment tab.

### Review deployment readiness

For each prepared service, use **Check deployment readiness** to compare the plan with the target. The panel checks the configured repository or image, the environment keys assembled for deployment, the planned database aliases, and any unfinished import or deployment work. The check sends key names and status only. Secret references are resolved when you deploy.

Under **Data transfer on the target**, review the latest recorded status for matching planned database connections and the primary volume. An active import appears in the readiness problems. Results such as missing records, failures and completions with warnings are shown for review, so workloads that start with empty storage can still proceed. A completed record describes a past operation. Check the current data separately before switching traffic.

When the review passes, use **Open deployments** to open the service's Deploys tab. Start deployment there and verify the running application before switching DNS. Readiness reflects the target at the time of the check. It does not validate secret values or test application health.

## Apply a plan

```bash
ninedeploy import plan caprover --url https://captain.apps.example.com --out plan.json
ninedeploy import apply plan.json                      # shows what it would create; creates nothing
ninedeploy import apply plan.json --yes --project 3 --dotenv blog=./blog.env   # creates them
```

`import apply` uses the panel the CLI is signed in to (`ninedeploy login`). It reads the plan file only, so it needs no source credential. Edit the plan first if you want different names or fewer items.

**What it creates**
- Each service that has something to deploy from: an image, or a repository and branch, with its port, replicas, limits, health path and first volume.
- Each database with a NineDeploy engine. It is created empty. The source's version is used when the source runs the same image (for example `postgres:14.5`); otherwise the panel's default is used.
- **Attachments for copied connection strings.** A value in a `--dotenv` file can still name the source's database, for example `DATABASE_URL=postgres://…@srv-captain--pg:5432/…`. In that case apply attaches the new database to the service under that variable's name. At every deploy the attachment sets the variable to the new database's connection string; the service's own copy still shows the old value. The file is read on your machine, and only variable, database and host names reach the output and the receipt.
  - Apply attaches only when the panel's connection string can stand in exactly: `postgres://`, `mysql://` or `mariadb://` with no `?options`, or `redis://` on database 0.
  - Anything else is listed for you to change by hand, with the reason: `postgresql://` and other scheme spellings your driver may need, `?sslmode=` and other options, a Redis database index, Mongo (the panel's string names no database), and a variable that holds only the host.
  - A value that names the old platform's own host, such as `captain.old.example` (as written in the plan's source URL), is listed too. NineDeploy can still reach that host, so the app would quietly keep using the old database.
  - The source hosts are the CapRover app name (with and without `srv-captain--`), the Coolify container name and the Dokploy app name. CapRover's and Dokploy's were checked against live instances. Coolify's comes from its source, which names the container after the database's uuid; the live API returned the uuid the plan uses.

**What it does not do**
- **It does not deploy anything.** Deploy each service when its environment is complete.
- **It does not add domains.** Adding a domain makes NineDeploy request a certificate, and the request would fail while DNS still points at the old platform. With the Cloudflare integration on, adding a domain would also change your DNS. Domains move at the cutover, step 3.
- **It does not invent environment values.** A plan holds names only. Pass `--dotenv <service>=<path>` with a `.env` file to set a service's values through the panel's `.env` import. Variables with no value are listed in the receipt; they are not created empty.

**The receipt**
- It is saved next to the plan as `plan.receipt.json` (`--receipt` to choose the file).
- It records each item's state (`done`, `skipped`, `failed`), its NineDeploy id and notes: what still needs a person, and which domains wait for the cutover. It never contains a value.
- Running the same command again repeats only what is not `done`. Each item is written as pending before the panel is called. Creates are sent with `reuseExisting`, so a run that stopped halfway picks up your own idle service or database of the same definition instead of failing on the name.
- A receipt is tied to one panel and one source. Apply refuses a receipt from another one.

## Move the data

Select **Check import status** next to a prepared database or volume in the plan to see the latest recorded operation for that target. This is a read-only snapshot. Use the linked import page for details, uploads, and restores.

For prepared databases with dump support, use **Import a dump into** in the migration plan to open the target database's **Backups → Import a dump** card. You can reopen the same plan in the same tab and account to return to these links. Quiesce writes on the source before taking the final dump, then choose that file and select **Upload and import**. The panel keeps the existing safety-backup workflow and shows the result in **Recent imports**.

The browser computes SHA-256 in bounded chunks before uploading a local file, and the panel checks it before restoring. When resuming, select the original dump. For an upload with a recorded hash, the browser checks that the file matches before sending another chunk. An older upload created without a hash can resume by size.

```bash
ninedeploy import data plan.json                                  # the order, and a dump command per database
ninedeploy import data plan.json --dump pgreal=pgreal.dump --yes  # imports it
ninedeploy import data plan.json --volume files=files.volume.tar.gz --yes  # restores a service's data volume
```

Without `--yes`, `import data` prints the order that loses no writes, and the dump command to run on the source host for each database:

1. A day ahead, lower the TTL of each domain's DNS record.
2. Stop writes on the source. A dump of a live database misses every write made after it.
3. Take the final dumps.
4. Import them with `--dump <database>=<file> --yes`.
5. Deploy each service and check it is healthy. Where a copied connection string allowed it, `import apply` already attached the new database; change the variables it listed by hand.
6. Switch DNS, then add the domains with `import cutover` (below).

**The dump commands**
- The commands produce what the panel's import accepts: `pg_dump -Fc`, `mysqldump` or `mariadb-dump` of the app's database, a gzipped `mongodump --archive`, or an RDB snapshot.
- They read credentials from the database container's own environment, inside single quotes, so no password appears in the output or in your shell history.
- The CapRover commands were run against a live CapRover v1.16.0: a PostgreSQL 16 one-click app with 500 rows arrived with the same row count and checksum. The Dokploy commands were run against a live Dokploy v0.31.0: the dump of a PostgreSQL 16 database lists its table and rows (`pg_restore -l`), and the volume archive holds the volume's files. The Coolify commands follow its source code: the live Coolify 4.7.5 check read its API only and deployed nothing, so they have not been run.
- The MySQL command was run against a MySQL 8.4 container: 500 rows arrived in the managed database with the same checksum. It names the database without `--databases`, because that form adds `CREATE DATABASE` and `USE` lines, which would put the rows in a second database beside the one NineDeploy connects your app to.

**The import**
- Each file goes through the panel's chunked dump import with its sha256 declared. The panel checks the hash before it restores anything.
- The receipt records the import id, sha256 and size.
- Once the receipt has an import id, retrying after an upload/status error checks that same job: unfinished uploads resume, running jobs are awaited, and completed jobs are recorded without restoring again.
- If that job's status cannot be read, its id stays in the receipt for another retry instead of starting a replacement.
- A different dump is refused while a prior import id is recorded. Inspect it with `ninedeploy databases imports <database-id>`; use `ninedeploy databases import <database-id> --file <file>` for a deliberate new import.
- A database whose data is already in is not imported again. The same file is skipped, and a different file is refused; use `ninedeploy databases import` directly if you mean it.
- ClickHouse has no dump import, so move its data by hand.

## Move the volumes

For prepared Docker services with a supported primary mount, select **Import a volume archive into** in the migration plan. The link opens **Volumes & Storage → Import a volume archive**. You can also open the archive card from the service itself. The panel checks the live service and mount against the preparation receipt before offering the link.

Choose a `.tar.gz` and select **Upload archive** to stage it with a SHA-256 checksum. If the upload is interrupted, use **Resume** and select the original archive again. After stopping the target service, select **Restore archive** and confirm the volume and mount. Keep the service stopped until the import completes. The panel checks the archive, takes a safety backup if the volume exists, and reports the result in **Recent volume imports**.

`import data` also moves each service's data volume: the one mounted at the path the service was created with. In NineDeploy that is the service's `nd-svc-<name>-data` volume.

1. Stop the app on the source so its files do not change while they are copied. On CapRover, set it to 0 instances.
2. Run the command the preview prints on the source host. For a named volume it mounts the volume read-only by name, so the app's container does not need to exist, and it writes a gzipped tar with numeric owners:
   `docker run --rm -v files-html:/v:ro alpine:3.21 tar -czf - --numeric-owner -C /v . > files.volume.tar.gz`
3. Import it: `ninedeploy import data plan.json --volume files=files.volume.tar.gz --yes`.

**What the panel does with the archive**
- It uploads in chunks with the archive's sha256 and checks the hash before the volume is touched. It also refuses a file that is not a gzipped tar.
- It refuses the import while the service is running or deploying. Stop the service in NineDeploy first; a service `import apply` just created has never run.
- If the volume already exists, the panel first snapshots it as a `pre-import` volume backup, so an import can be undone with an ordinary restore.
- It restores through the same staged swap a volume backup restore uses. The archive is extracted beside the current contents and swapped in only once the extraction is complete, so a corrupt archive or a full disk leaves the volume as it was.
- Files keep their owners, modes and symlinks.

**What it covers**
- Docker services on the panel host that have a volume mount. Swarm services, compose stacks, services on a node and services spread over several hosts are refused. Restoring an archive needs an operator, the same as a volume backup restore.
- Only the volume at the service's volume mount. The preview lists any other volumes, to be copied by hand.
- A bind mount, or a volume whose name the plan does not hold, is read through the source container instead (`--volumes-from`). That works only while the container still exists: a Swarm service scaled to 0 has none left. Otherwise archive the host directory yourself with `tar -czf - --numeric-owner -C <dir> .`.
- The receipt records the import id, sha256 and size. A stopped upload resumes. A volume that is already imported is not imported again, and a different archive is refused.

**Checked live** on CapRover v1.16.0, which names an app's Docker volume exactly as its volume name. A volume holding a nested file, a file owned by uid 1234 with mode 640, and a symlink arrived in the deployed NineDeploy service with the same listing, owners and checksums, and nginx served the page through the symlink. A second run made no second import. While the service ran, the start was refused; after stopping it, the same import snapshotted the volume first. The Dokploy volume command was run against a live Dokploy v0.31.0, which names the Docker volume exactly as the mount's volume name. On Coolify the volume name carries the application's uuid as a prefix (`<uuid>-web-html`), as the live 4.7.5 API showed. Its source names the Docker volume exactly that, but the command has not been run there.

## Cut over the domains

The migration plan shows **Cut over domains** for services prepared on the panel host. After deploying the target, verify the application and update its DNS records. In the plan, select **Check cutover**, review the expected and resolved addresses, then confirm the hostname you want the panel to route. The server checks the latest deployment and all A and AAAA answers again at confirmation. It uses the destination configured under **Settings → DNS records**, or the detected public IP when no destination is set. DNS records are managed separately from this panel action.

If an existing route uses a different protocol from the plan, the web panel and CLI report the difference. Review the route in **Domains** before retrying. This applies to attached routes and routes still awaiting ownership verification.

If the domain is pending, publish the displayed TXT record and select **Verify ownership**. For an attached domain, **Check cutover** reports its current DNS alongside the attachment status. A DNS mismatch or lookup problem leaves the route in place. Wildcards, shared routes, proxied records whose addresses differ from the target, and non-local service placement need manual review or the CLI options below.

For an attached domain, the same check inspects the proxy configuration for its hostname, protocol, and root path. It displays the routing diagnosis and links to the service's **Network** tab. Test the application from a client before switching traffic.

```bash
ninedeploy import cutover plan.json                    # what is ready, host by host
ninedeploy import cutover plan.json --yes              # adds the domains that pass
```

`import cutover` adds each planned domain to its service, but only when two checks pass:

- **The service is ready.** It is `running` and its latest deployment succeeded. This is not an HTTP check of your app, so open it yourself before you switch DNS. The command never deploys.
- **DNS already points here.** The host is resolved with a direct DNS query (not the OS cache or hosts file), and every A and AAAA address must be one this panel expects. A leftover record that still names the old host fails the check even when another one already points here: Let's Encrypt validates over IPv6 first when an AAAA exists, so a stale AAAA alone fails the certificate. The expected address is `--expect <address>` if given (repeat it for a panel with both IPv4 and IPv6), otherwise Settings → DNS records (an admin can read it). A hostname there is resolved first. `--resolver <ip>` picks the DNS server; the output names the one used.

The DNS check is strict on purpose. Adding a domain makes Traefik ask Let's Encrypt for a certificate, and Let's Encrypt limits failed attempts per hostname. A host that fails waits; switch its DNS and run the same command again.

- **Shared hostnames.** The CLI leaves path-specific routes, www redirects, and hostnames with several existing routes for review in **Domains**. If the plan assigns a hostname to several services or both HTTP and HTTPS, resolve the assignment in the plan before retrying.
- The source's own generated hosts (sslip.io, nip.io, traefik.me) are never added. Wildcard hosts need a DNS-01 certificate, so they are listed for you to add by hand.
- **Proxied records.** For a domain that still needs to be added or verified, `--skip-dns-check <host>` lets you proceed when the panel's Cloudflare integration is known to be off. The receipt records the skipped check. An integration that is on could add an A record next to the old target and split traffic between two hosts.
- **Attached domains.** Each run compares their current A and AAAA answers against the expected destination. A mismatch or resolver failure is reported for that host and the command continues through the rest of the plan. The route stays attached and its receipt retains the attachment. Use `--skip-dns-check <host>` to skip this read-only check for a deliberately proxied domain. Attached wildcards require manual DNS review.
- **Ownership proof.** If you are not an operator and the host is outside this instance's zone, the panel adds it as `pending`. The command prints the TXT record to publish; the next run verifies it. The value is printed, never written to the receipt.


## What a plan contains

- **Services**, each with:
  - a kind: image, Git or compose;
  - the fields a NineDeploy service would be created with: repository and branch, build pack, base directory, port, replicas, CPU and memory limits, health path, first volume;
  - its domains, with whether each had HTTPS. A host the source generated for itself is marked as staying behind: CapRover's `<app>.<root domain>`, Coolify's `sslip.io` hosts and Dokploy's `traefik.me` hosts;
  - its environment variable **names**;
  - its volumes.
- **Databases**, each with the matching NineDeploy engine and the source image, which carries the version.
- **Issues** on every item:
  - `✗ unsupported`: no NineDeploy equivalent;
  - `! manual`: a person must do something;
  - `· info`: worth knowing.

**What a plan never contains:** variable values, database passwords, registry passwords, Git credentials, tokens or keys. Some sources return these to any authenticated client: Dokploy returns decrypted env values and database passwords, and CapRover returns Git passwords and SSH keys. The importer reads names and drops the rest. It also removes `user:password@` from every URL.

## Per source

**Coolify**
- A plain `read` token is enough. Values that need `read:sensitive` (env values, compose YAML, passwords) are never requested. Checked live: a `read` token is given no env value or database password at all.
- An app from a public repository needs nothing reconnected. The plan asks you to reconnect private access when the app uses a GitHub App, GitLab or other Git source, a deploy key (seen as an SSH repository URL, since a `read` token hides the key) or an HTTPS username.
- A compose stack from a one-click template is listed without its compose file. Paste the file into a new compose service, or look for the app in the NineDeploy Hub.
- Databases are read from `/databases`, so KeyDB, Dragonfly and ClickHouse are included. SQLite has no managed equivalent.

**Dokploy**
- The plan covers the organization the API key belongs to.
- **Create the API key with rate limiting off.** A default Dokploy key is limited to 10 requests a day; in the live check it was refused after 5. A plan makes 2 requests plus one per application, compose stack and database. Dokploy refuses a spent key with the same 401 as a wrong one.
- Applications and databases run as Swarm services named after their app name, and a volume mount's Docker volume is named exactly as its volume name (checked live).
- Builds with Heroku and Paketo buildpacks map to the same NineDeploy build packs.
- An uploaded ("drop") application cannot be read over the API; re-upload it as a ZIP source.
- For a Gitea source the URL must be entered by hand, because the record does not include the Gitea host.
- libSQL has no managed equivalent.

**CapRover**
- A one-click database (marked by its template tag) is listed as a database.
- An app built by CapRover from an upload or the CLI, with no repository on record, has its image only inside CapRover. Push its source or image somewhere NineDeploy can reach first.
- A custom nginx config, pre-deploy script and Swarm service override have no equivalent and are listed as such.
- An app that was registered but never deployed has no image or repository to carry. It is listed for a person to complete.

**Heroku**
- The plan is built from the app's `app.json` and `Procfile`, as Heroku documents them. No Heroku API is read and no credential is needed.
- Each Procfile process except `release` becomes a service built from the repository with Nixpacks. Its start command is the process's line.
  - This is checked live on a NineDeploy panel. Nixpacks runs the start command through a shell, so `$PORT` expands, and sets `PORT` to the service port. The `web` service gets port 5000.
  - The heroku and paketo build packs, and Dockerfile builds, ignore a start command, which is why the importer does not use them for Procfile apps.
- Other processes, such as `worker`, get the `running` health check (they answer no HTTP) and no domain. `formation` quantities become replicas, at most 10.
- `release` is not mapped to NineDeploy's pre-deploy hook, which runs in the panel's own container before the build, without a shell. Nixpacks runs the Procfile's `release` line itself, as a build step of every service built from the repository. In the live check it saw the attached `DATABASE_URL`. So it runs before each deploy of each of those services, not once per release: make sure that is safe (a migration usually is), or take it out of the Procfile and run it by hand. A `$VARIABLE` in it is built into the image with its value. The deploy log masks secret values, but the image's build history keeps them.
- Nixpacks reads the Procfile itself, as YAML, so a command containing `: ` (a colon and a space) must be quoted in the Procfile or the build fails. The plan flags such lines.
- The `heroku-postgresql` and `heroku-redis` add-ons become a NineDeploy PostgreSQL and Redis, attached to every service as `DATABASE_URL` and `REDIS_URL`, as Heroku sets them. Other add-ons are listed for you to replace.
- Config var names come from `app.json`. Heroku's config vars belong to the app, and `--dotenv` is set per service, so pass the same file for each process: `heroku config --shell -a <app> > shop.env`, then `import apply plan.json --dotenv shop=shop.env --dotenv shop-worker=shop.env --yes`. Leave out `DATABASE_URL` and `REDIS_URL`, which the attachments set.
- Heroku Postgres requires SSL, so apps often force it in code. The NineDeploy database is reached over the internal Docker network, which has no TLS: drop that requirement for this connection.
- `import data` prints `heroku pg:backups:capture` and a download of the backup, which the dump import accepts as a pg_dump custom-format file. Heroku Key-Value Store (Redis) has no export command, so move those keys by hand.
- Not carried: `scripts.postdeploy` (it runs once on Heroku, so run it by hand after the first deploy), `heroku.yml` container builds, buildpacks other than Nixpacks's own detection, dyno sizes and domains. Add domains to the plan, or under Service → Domains.

## How the adapters were checked

The field mappings were written against the source code of Coolify v4.7.0, Dokploy v0.31.0 and CapRover v1.16.0, and are tested with fixtures derived from that code and with captures from live instances.

- **CapRover v1.16.0 was also run live.** A plan was made against a fresh instance with an app from a repository, an image app with a host port and a one-click PostgreSQL. Its responses are kept as a test fixture, with secret values replaced. That run found three things the source reading had missed:
  - an app that was never deployed runs CapRover's placeholder image, which is not planned as its image;
  - a stopped app (0 instances) is flagged as stopped;
  - the version is read from `versionInfo`.
- **Dokploy v0.31.0 was also run live**, set up the way its installer does. A project with an image application (env, domain, volume mount) and a PostgreSQL 16 database was created through its API, and the plan matched it field for field. Its responses are kept as a test fixture, with secret values replaced. The run also confirmed the Swarm service and volume names that `import data` uses, and found that a default API key is rate-limited.
- **Coolify 4.7.5 was also run live**, set up the way its installer does. Through its API, a project was created with:
  - an image application with env, a domain, memory and CPU limits and a volume;
  - a public-repository Nixpacks application with a base directory, a health check and env;
  - PostgreSQL and Redis databases;
  - an uptime-kuma one-click service.

  Nothing was deployed. The plan matched what was created, its responses are kept as a test fixture, and the `read` token was given no secret value. The run found one false flag: Coolify gives public-repository apps its built-in "Public GitHub" source, which the plan took for a private one. The dump and volume commands were not run there.

If a plan looks wrong for your version, please open an issue with the plan's `source.version`.
