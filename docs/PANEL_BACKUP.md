# Panel Self-Backup

NineDeploy can back up **the panel itself** on a schedule: its database, its master key, its `.env` and its Traefik configuration. Each backup is encrypted with a **recovery passphrase** that you choose and keep, then uploaded to one of your S3-compatible backup destinations.

It is **off by default**. An upgraded panel behaves exactly as before until an operator turns it on under **Settings → Panel backup**.

---

## 🔑 1. What you must keep (read this first)

| Keep this | Where | Why |
|---|---|---|
| **The recovery passphrase** | A password manager or vault, **not** on the panel server | Every panel backup is encrypted with it. Without it, no backup can be opened, by you or by NineDeploy. |
| **The bucket credentials** (endpoint, bucket, access key, secret key) | Same place | A new server needs them to reach the backups. |
| **`NINEDEPLOY_MASTER_KEY` / `NINEDEPLOY_MASTER_KEYS`**, *only if you set one* | Same place | When the master key comes from the environment rather than the `master.key` file, the backup does **not** contain it. The settings page shows a warning when this applies. |

Why a passphrase and not the master key? The backup contains the master key. Its job is to restore the panel on a new machine after the old one, and its key, are gone. A backup that only the lost key could open would be useless, so it is sealed with a secret that lives outside the server.

The panel stores the passphrase **encrypted under its master key** (settings key `panel_backup_passphrase_encrypted`), so scheduled runs need no one at the keyboard. The API never returns it. Master-key rotation re-encrypts it along with the other stored secrets.

Changing the passphrase only affects **new** backups. Older objects keep the passphrase they were made with. Keep old passphrases until those backups have aged out of retention.

---

## 📦 2. What a backup contains

The artifact is the same archive `GET /v1/system/export` produces (one format, one importer), wrapped in a passphrase envelope:

| Member | Content |
|---|---|
| `_db-<stamp>.db` | A consistent snapshot of the panel's SQLite database, taken with `VACUUM INTO` while the panel keeps serving. It is never a raw copy of the live WAL files. |
| `master.key` | The instance master key file, when one exists. |
| `_env-<stamp>` | The panel's `.env` (from its working directory), when present. |
| `traefik/` | The panel's Traefik config directory (dynamic config, ACME store). |
| `_meta-<stamp>.json` | Export time, row counts, `kind: "panel-backup"`, the panel version and whether the master key came from the environment. |

**Not included** (each has its own backup path):

- **App volumes:** volume snapshots on the Backups page.
- **Managed database data:** per-database dumps on the Backups page and the database's Backups tab.
- **Docker images and build caches:** rebuilt or pulled again on redeploy.
- **Remote nodes' local state:** each node re-enrolls against the restored panel.

Objects are written to `<destination prefix>/panel-backups/ninedeploy-panel-<UTC timestamp>-<random>.ndpb`.

### Envelope format (`NDPB1`)

```
NDPB1:scrypt:<N>:<r>:<p>:<base64 salt>:<base64 iv>\n   header line (also the GCM AAD)
<AES-256-GCM ciphertext of the .tar.gz>
<16-byte GCM tag>
```

The key is `scrypt(passphrase, salt, 32 bytes, N, r, p)`. Today N=32768, r=8, p=1. Readers accept N between 2^14 and 2^20. Because the header is authenticated, a wrong passphrase, a damaged file, or an object someone swapped into the bucket all fail the same way, and nothing is imported.

---

## ⚙️ 3. Setting it up

1. Add a bucket under **Backups → Destinations** and use **Test** to confirm the panel can reach it.
2. Open **Settings → Panel backup**:
   - **Schedule:** a 5-field cron expression in server time. Default: `0 3 * * *`.
   - **Destination:** the bucket from step 1.
   - **Keep:** how many panel backups to retain (1–365, default 7).
   - **Recovery passphrase:** at least 12 characters. Type it twice, then store it off the server.
3. Turn on **Scheduled backups** and save.
4. Click **Back up now** once and confirm that the run reports `completed` and the object appears in the list.

The same settings are available from the CLI (`ninedeploy system panel-backup set --enable --destination 1 --cron "0 3 * * *" --retain 7 --passphrase`) and through the SDK (`client.system.panelBackup.update(...)`).

### Runs, retention and alerts

- **No overlap.** If a run (or a restore) is still in progress when the next tick fires, that tick is skipped and audited as `backup.panel.skipped`. "Back up now" answers `409` in the same situation.
- **Retention never deletes the last good backup.** Pruning runs only after a successful upload, keeps the newest *N* (at least one), and always keeps the backup that was just written. A failed run prunes nothing. If a delete fails, the run still counts as completed: the new backup is safe, the run records a warning, and the delete is retried next time. Objects that do not match the panel-backup name pattern are never touched.
- **Every outcome is audited.** Runs produce `backup.panel.completed`, `backup.panel.failed` or `backup.panel.skipped`. Settings changes produce `backup.panel.settings` (never with the passphrase in it). Restores produce `backup.panel.restore` or `backup.panel.restore_failed`, plus `system.import`. Audit is the notification fan-out, so a channel subscribed to `backup.` is told when a scheduled panel backup fails.
- **Plaintext never stays on disk.** The unencrypted archive is deleted the moment the sealed copy exists. Scratch files live in `<data dir>/_panel-backup/` and are cleared at boot.

### Keep only one panel writing to a prefix

If you restore onto a new server while the old one is still running with panel backups enabled, both panels write to, and prune, the same `panel-backups/` prefix. Disable panel backups on the old server, or point the new one at another destination or prefix.

---

## ♻️ 4. Restoring

A restore **replaces** the panel's database, master key, `.env` and Traefik config. The files it replaces are moved to `<data dir>/_backup-<timestamp>/` first. NineDeploy must be restarted afterwards, just as after any `system import`.

Install the **same or a newer** NineDeploy version than the one that wrote the backup. A newer panel migrates the restored database when it starts. An older panel cannot read a newer database.

### A. From the panel (fresh install)

1. Install NineDeploy on the new server and finish the first-run setup. This account is temporary: the restore replaces it.
2. Add the **same bucket** under **Backups → Destinations**, with the same prefix.
3. Open **Settings → Panel backup**. Under *Backups in the destination*, pick that destination.
4. Click **Restore…** on the backup you want, enter the recovery passphrase, and type the backup's file name to confirm.
5. Restart NineDeploy (`sudo systemctl restart ninedeploy`, or restart the container), then sign in with the **old** panel's credentials.

The API equivalent is `POST /v1/system/panel-backup/restore` with `{ destinationId, key, passphrase, confirm: "<file name>" }`, or `client.system.panelBackup.restore(...)` in the SDK.

### B. Offline (CLI)

Use this path if the new panel cannot reach the bucket, or if you have already downloaded the object:

```bash
# 1. Download the .ndpb object with any S3 client, e.g.
aws s3 cp s3://<bucket>/<prefix>/panel-backups/ninedeploy-panel-<…>.ndpb .

# 2. Open it with the recovery passphrase (works without a running panel)
ninedeploy system panel-backup decrypt ninedeploy-panel-<…>.ndpb backup.tar.gz

# 3. Import it into the fresh panel (destructive, asks for confirmation)
ninedeploy login            # prompts for the new panel URL and credentials
ninedeploy system import backup.tar.gz

# 4. Restart NineDeploy
```

`backup.tar.gz` is a plain `/system/export` archive, so you can also upload it under **Settings → Migration → Import backup**. It contains the database and the master key, so delete it once the import is done.

### After the restore

- Remote servers are rows in the restored database. Check that each one shows online under **Servers**. If the panel's address changed, re-enroll any node that cannot reach it.
- If the master key came from `NINEDEPLOY_MASTER_KEY(S)`, set the same value on the new server **before** restarting.
- Run **Back up now** on the restored panel to confirm the schedule still works from its new home.

---

## 🔌 5. API, SDK and CLI reference

All routes are instance-operator only.

| Route | SDK | CLI |
|---|---|---|
| `GET /v1/system/panel-backup` | `system.panelBackup.get()` | `system panel-backup status` |
| `PUT /v1/system/panel-backup` | `system.panelBackup.update(patch)` | `system panel-backup set …` |
| `POST /v1/system/panel-backup/run` (202, background) | `system.panelBackup.run()` | `system panel-backup now [--wait]` |
| `GET /v1/system/panel-backup/remote[?destinationId=]` | `system.panelBackup.list(id?)` | `system panel-backup list [--destination]` |
| `POST /v1/system/panel-backup/restore` | `system.panelBackup.restore(input)` | offline: `system panel-backup decrypt` + `system import` |

Storage: the configuration lives in the `settings` table. The `panel_backup` key holds the schedule, destination and retention. `panel_backup_passphrase_encrypted` holds the passphrase, sealed. `panel_backup_state` holds the last run and the last success. No schema migration is involved, and an absent row means "disabled".
