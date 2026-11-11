# Moving from Coolify, Dokploy, CapRover or Heroku

`ninedeploy import plan` reads another platform's API, or a Heroku app's `app.json` and `Procfile`, and shows what NineDeploy would create. For each item it also lists what NineDeploy cannot carry over and what needs a person. It is read-only: it creates nothing in NineDeploy and changes nothing on the source. `ninedeploy import apply` then creates what a saved plan describes. It never touches the source.

| Step | What it does | Status |
|---|---|---|
| 1. Plan | Read the source and list each service, domain, environment variable name, volume and database, with every unsupported option | Available (CLI) |
| 2. Apply | Create the planned services and databases in NineDeploy, resumably, with a receipt per item, and leave the source untouched | Available (CLI) |
| 3. Data | Move database contents, checksummed; then deploy, switch DNS and add the domains as the last step | Databases, service volumes and the domain cutover available (CLI) |

## Run a plan

The command runs on your machine. The source credential stays there: it is read from an environment variable or a hidden prompt, never from the command line, and it is never written to the plan.

```bash
# Coolify: turn on Settings → Advanced → API access, then create a token with "read" (Keys & Tokens).
NINEDEPLOY_IMPORT_TOKEN=… ninedeploy import plan coolify --url https://coolify.example.com

# Dokploy: create an API key for the organization (Profile → API keys).
NINEDEPLOY_IMPORT_TOKEN=… ninedeploy import plan dokploy --url https://dokploy.example.com

# CapRover: the dashboard password (NINEDEPLOY_IMPORT_OTP for a two-factor code; otherwise it is asked for).
NINEDEPLOY_IMPORT_PASSWORD=… ninedeploy import plan caprover --url https://captain.apps.example.com

# Heroku: no credential. --url is the app's repository, --dir a checkout of it; --app names the Heroku app.
ninedeploy import plan heroku --url https://github.com/acme/shop.git --dir ./shop --branch main --app acme-shop
```

`--json` prints the plan as JSON, and `--out plan.json` also saves it. Leave the variable unset and the command asks for the credential without echoing it.

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
  - The source hosts are the CapRover app name (with and without `srv-captain--`), the Coolify container name and the Dokploy app name. Only CapRover's were checked against a live instance.

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
- The CapRover commands were run against a live CapRover v1.16.0: a PostgreSQL 16 one-click app with 500 rows arrived with the same row count and checksum. The Coolify and Dokploy commands follow their source code.
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

**Checked live** on CapRover v1.16.0, which names an app's Docker volume exactly as its volume name. A volume holding a nested file, a file owned by uid 1234 with mode 640, and a symlink arrived in the deployed NineDeploy service with the same listing, owners and checksums, and nginx served the page through the symlink. A second run made no second import. While the service ran, the start was refused; after stopping it, the same import snapshotted the volume first. The Coolify and Dokploy volume commands follow their source code.

## Cut over the domains

```bash
ninedeploy import cutover plan.json                    # what is ready, host by host
ninedeploy import cutover plan.json --yes              # adds the domains that pass
```

`import cutover` adds each planned domain to its service, but only when two checks pass:

- **The service is ready.** It is `running` and its latest deployment succeeded. This is not an HTTP check of your app, so open it yourself before you switch DNS. The command never deploys.
- **DNS already points here.** The host is resolved with a direct DNS query (not the OS cache or hosts file), and every A and AAAA address must be one this panel expects. A leftover record that still names the old host fails the check even when another one already points here: Let's Encrypt validates over IPv6 first when an AAAA exists, so a stale AAAA alone fails the certificate. The expected address is `--expect <address>` if given (repeat it for a panel with both IPv4 and IPv6), otherwise Settings → DNS records (an admin can read it). A hostname there is resolved first. `--resolver <ip>` picks the DNS server; the output names the one used.

The DNS check is strict on purpose. Adding a domain makes Traefik ask Let's Encrypt for a certificate, and Let's Encrypt limits failed attempts per hostname. A host that fails waits; switch its DNS and run the same command again.

- The source's own generated hosts (sslip.io, nip.io, traefik.me) are never added. Wildcard hosts need a DNS-01 certificate, so they are listed for you to add by hand.
- **Proxied records.** A record behind Cloudflare's proxy resolves to Cloudflare, not to this panel. `--skip-dns-check <host>` adds it anyway, and the receipt notes the skipped check. It is refused while the panel's own Cloudflare integration is on, or when you can't tell (only an admin can). That integration creates a new A record for every domain added, and next to a record that still points at the old host it would split traffic between the two.
- **The panel is the truth.** Each run lists the service's domains first. A domain that is already there, added by hand or by an earlier run, counts as done and is not added again.
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
- A plain `read` token is enough. Values that need `read:sensitive` (env values, compose YAML, passwords) are never requested.
- A compose stack from a one-click template is listed without its compose file. Paste the file into a new compose service, or look for the app in the NineDeploy Hub.
- Databases are read from `/databases`, so KeyDB, Dragonfly and ClickHouse are included. SQLite has no managed equivalent.

**Dokploy**
- The plan covers the organization the API key belongs to.
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

The field mappings were written against the source code of Coolify v4.7.0, Dokploy v0.31.0 and CapRover v1.16.0, and are tested with fixtures derived from that code.

- **CapRover v1.16.0 was also run live.** A plan was made against a fresh instance with an app from a repository, an image app with a host port and a one-click PostgreSQL. Its responses are kept as a test fixture, with secret values replaced. That run found three things the source reading had missed:
  - an app that was never deployed runs CapRover's placeholder image, which is not planned as its image;
  - a stopped app (0 instances) is flagged as stopped;
  - the version is read from `versionInfo`.
- **Coolify and Dokploy have not yet been run against live instances.**

If a plan looks wrong for your version, please open an issue with the plan's `source.version`.
