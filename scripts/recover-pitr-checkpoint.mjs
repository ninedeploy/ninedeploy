/** Offline N04 recovery. Secrets live in a mode-0600 JSON input file, never command-line arguments. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function recoverFromFile(file) {
  const input = JSON.parse(await readFile(file, 'utf8'));
  if (!/^nd-db-[a-z0-9][a-z0-9-]{0,60}-data$/.test(input.volumeName ?? '')) throw new Error('Choose a new nd-db-<name>-data volume');
  if (typeof input.newPassword !== 'string' || input.newPassword.length < 16) throw new Error('Set a new database password of at least 16 characters');
  if (typeof input.passphrase !== 'string' || input.passphrase.length < 16) throw new Error('Provide the operator-held recovery passphrase');
  if (new URL(input.cfg.endpoint).protocol !== 'https:') throw new Error('Use an HTTPS S3 endpoint');
  const targetTime = input.targetTime == null ? null : new Date(input.targetTime);
  if (targetTime && Number.isNaN(targetTime.getTime())) throw new Error('Invalid targetTime');
  const { encrypt } = await import('../apps/server/dist/lib/crypto.js');
  const { recoverRemotePitrCheckpoint } = await import('../apps/server/dist/lib/pitrRemote.js');
  const outcome = await recoverRemotePitrCheckpoint({ cfg: input.cfg, key: input.key, passphrase: input.passphrase, targetTime,
    target: { id: -1, engine: 'postgres', serverId: null, slug: input.volumeName.slice(6, -5), name: 'Remote recovery', volumeName: input.volumeName,
      passwordEncrypted: encrypt(input.newPassword), ownerUserId: null, pitrEnabled: false } },
  (line) => process.stderr.write(`${line}\n`));
  return { volumeName: input.volumeName, ...outcome };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/recover-pitr-checkpoint.mjs /secure/recovery.json');
  try { console.log(JSON.stringify(await recoverFromFile(process.argv[2]), null, 2)); }
  catch { console.error('Remote PITR recovery failed. Verify the passphrase, object integrity, target time, image availability and destination access. No successful recovery is claimed.'); process.exitCode = 1; }
}
