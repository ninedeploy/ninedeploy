# Moving from Coolify, Dokploy or CapRover

`ninedeploy import plan` reads another platform's API and shows what NineDeploy would create. For each item it also lists what NineDeploy cannot carry over and what needs a person. **This is step 1 of three, and it is read-only.** It creates nothing in NineDeploy and changes nothing on the source.

| Step | What it does | Status |
|---|---|---|
| 1. Plan | Read the source and list each service, domain, environment variable name, volume and database, with every unsupported option | Available (CLI) |
| 2. Apply | Create the planned services in NineDeploy, resumably, with a receipt per item, and leave the source untouched | Not yet |
| 3. Data | Move database contents and volumes, checksummed, then switch DNS as an explicit last step | Not yet |

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

## What a plan contains

- **Services**, each with:
  - a kind: image, Git or compose;
  - the fields a NineDeploy service would be created with: repository and branch, build pack, base directory, port, replicas, CPU and memory limits, health path, first volume;
  - its domains, with whether each had HTTPS;
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

## How the adapters were checked

The field mappings were written against the source code of Coolify v4.7.0, Dokploy v0.31.0 and CapRover v1.16.0, and are tested with fixtures derived from that code. They have **not yet been run against live instances**. If a plan looks wrong for your version, please open an issue with the plan's `source.version`.
