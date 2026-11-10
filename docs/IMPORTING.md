# Moving from Coolify, Dokploy or CapRover

`ninedeploy import plan` reads another platform's API and shows what NineDeploy would create. For each item it also lists what NineDeploy cannot carry over and what needs a person. It is read-only: it creates nothing in NineDeploy and changes nothing on the source. `ninedeploy import apply` then creates what a saved plan describes. It never touches the source.

| Step | What it does | Status |
|---|---|---|
| 1. Plan | Read the source and list each service, domain, environment variable name, volume and database, with every unsupported option | Available (CLI) |
| 2. Apply | Create the planned services and databases in NineDeploy, resumably, with a receipt per item, and leave the source untouched | Available (CLI) |
| 3. Data | Move database contents, checksummed; then deploy, switch DNS and add the domains as the last step | Databases and the domain cutover available (CLI); volumes by hand for now |

## Run a plan

The command runs on your machine. The source credential stays there: it is read from an environment variable or a hidden prompt, never from the command line, and it is never written to the plan.

```bash
# Coolify: turn on Settings → Advanced → API access, then create a token with "read" (Keys & Tokens).
NINEDEPLOY_IMPORT_TOKEN=… ninedeploy import plan coolify --url https://coolify.example.com

# Dokploy: create an API key for the organization (Profile → API keys).
NINEDEPLOY_IMPORT_TOKEN=… ninedeploy import plan dokploy --url https://dokploy.example.com

# CapRover: the dashboard password (NINEDEPLOY_IMPORT_OTP for a two-factor code; otherwise it is asked for).
NINEDEPLOY_IMPORT_PASSWORD=… ninedeploy import plan caprover --url https://captain.apps.example.com
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
```

Without `--yes`, `import data` prints the order that loses no writes, and the dump command to run on the source host for each database:

1. A day ahead, lower the TTL of each domain's DNS record.
2. Stop writes on the source. A dump of a live database misses every write made after it.
3. Take the final dumps.
4. Import them with `--dump <database>=<file> --yes`.
5. Deploy each service and check it is healthy. Connection strings copied from the source may still name its database hosts: attach the new database to the service (it sets `DATABASE_URL` or the engine's own variable at deploy), or edit them.
6. Switch DNS, then add the domains with `import cutover` (below).

**The dump commands**
- The commands produce what the panel's import accepts: `pg_dump -Fc`, `mysqldump` or `mariadb-dump` of the app's database, a gzipped `mongodump --archive`, or an RDB snapshot.
- They read credentials from the database container's own environment, inside single quotes, so no password appears in the output or in your shell history.
- The CapRover commands were run against a live CapRover v1.16.0: a PostgreSQL 16 one-click app with 500 rows arrived with the same row count and checksum. The Coolify and Dokploy commands follow their source code.

**The import**
- Each file goes through the panel's chunked dump import with its sha256 declared. The panel checks the hash before it restores anything.
- The receipt records the import id, sha256 and size.
- Once the receipt has an import id, retrying after an upload/status error checks that same job: unfinished uploads resume, running jobs are awaited, and completed jobs are recorded without restoring again.
- If that job's status cannot be read, its id stays in the receipt for another retry instead of starting a replacement.
- A different dump is refused while a prior import id is recorded. Inspect it with `ninedeploy databases imports <database-id>`; use `ninedeploy databases import <database-id> --file <file>` for a deliberate new import.
- A database whose data is already in is not imported again. The same file is skipped, and a different file is refused; use `ninedeploy databases import` directly if you mean it.
- ClickHouse has no dump import, so move its data by hand.

## Cut over the domains

```bash
ninedeploy import cutover plan.json                    # what is ready, host by host
ninedeploy import cutover plan.json --yes              # adds the domains that pass
```

`import cutover` adds each planned domain to its service, but only when two checks pass:

- **The service is ready.** It is `running` and its latest deployment succeeded. This is not an HTTP check of your app, so open it yourself before you switch DNS. The command never deploys.
- **DNS already points here.** The host is resolved with a direct DNS query (not the OS cache or hosts file), and at least one A or AAAA address must be one this panel expects. The expected address is `--expect <address>` if given, otherwise Settings → DNS records (an admin can read it). A hostname there is resolved first. `--resolver <ip>` picks the DNS server; the output names the one used.

The DNS check is strict on purpose. Adding a domain makes Traefik ask Let's Encrypt for a certificate, and Let's Encrypt limits failed attempts per hostname. A host that fails waits; switch its DNS and run the same command again.

- The source's own generated hosts (sslip.io, nip.io, traefik.me) are never added. Wildcard hosts need a DNS-01 certificate, so they are listed for you to add by hand.
- **Proxied records.** A record behind Cloudflare's proxy resolves to Cloudflare, not to this panel. `--skip-dns-check <host>` adds it anyway, and the receipt notes the skipped check. It is refused while the panel's own Cloudflare integration is on, or when you can't tell (only an admin can). That integration creates a new A record for every domain added, and next to a record that still points at the old host it would split traffic between the two.
- **The panel is the truth.** Each run lists the service's domains first. A domain that is already there, added by hand or by an earlier run, counts as done and is not added again.
- **Ownership proof.** If you are not an operator and the host is outside this instance's zone, the panel adds it as `pending`. The command prints the TXT record to publish; the next run verifies it. The value is printed, never written to the receipt.

**Volumes** are not moved yet. Copy their files from the source host, then upload them in the service's Volumes & Storage tab.

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

## How the adapters were checked

The field mappings were written against the source code of Coolify v4.7.0, Dokploy v0.31.0 and CapRover v1.16.0, and are tested with fixtures derived from that code.

- **CapRover v1.16.0 was also run live.** A plan was made against a fresh instance with an app from a repository, an image app with a host port and a one-click PostgreSQL. Its responses are kept as a test fixture, with secret values replaced. That run found three things the source reading had missed:
  - an app that was never deployed runs CapRover's placeholder image, which is not planned as its image;
  - a stopped app (0 instances) is flagged as stopped;
  - the version is read from `versionInfo`.
- **Coolify and Dokploy have not yet been run against live instances.**

If a plan looks wrong for your version, please open an issue with the plan's `source.version`.
