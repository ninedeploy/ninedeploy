/**
 * `ninedeploy import data <plan.json> [--dump <database>=<file> …] [--yes]`
 *
 * A1 step 3, data half (docs/plans/COMPETITIVE_ROADMAP_2026-11.md). Moves
 * database contents into the databases `import apply` created.
 *
 * - Without --yes it prints the cutover order and, for each database, the
 *   command that takes a dump on the source host. The commands read the
 *   credentials from the database container's own environment, inside
 *   single quotes, so no password reaches this output or the shell history.
 * - With --dump and --yes it uploads each file through the panel's chunked
 *   dump import, declaring the file's sha256. The panel checks it before it
 *   restores anything.
 * - The receipt records each import's id, sha256 and size, never content. A
 *   run that stops during the upload resumes the same import. A database whose
 *   data is already in is not imported again.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseImport, DatabaseImportOptions } from '@ninedeploy/schemas';
import { getClient, type NineDeployClient } from '../client.js';
import { loadConfig } from '../config.js';
import { c, error, header, info, success } from '../lib/format.js';
import type { ImportPlan, PlanDatabase, PlanEngine, SourceKind } from '../lib/importers/plan.js';
import { fileBase, flagArg, isPlainName, sourceTarget } from '../lib/importers/shell.js';
import { type ImportReceipt, renderReceipt, validatePlan, writeReceipt } from './importApply.js';
import { importVolumes, renderVolumePreview, type VolumeClient } from './importVolumes.js';

/** The panel calls `import data` makes; NineDeployClient satisfies it. */
export interface DataClient extends VolumeClient {
  databases: {
    importFile: NineDeployClient['databases']['importFile'];
    imports: {
      get: NineDeployClient['databases']['imports']['get'];
      wait: NineDeployClient['databases']['imports']['wait'];
    };
  };
}

/** Engines the panel's dump import accepts (schemas databaseImport.ts). */
const IMPORTABLE: Record<PlanEngine, boolean> = {
  postgres: true, mysql: true, mariadb: true, mongo: true, redis: true, keydb: true, dragonfly: true, clickhouse: false,
};

/** Dump file name per engine, by format. */
const DUMP_FILE: Record<PlanEngine, (n: string) => string> = {
  postgres: (n) => `${n}.dump`, mysql: (n) => `${n}.sql`, mariadb: (n) => `${n}.sql`, mongo: (n) => `${n}.archive.gz`,
  redis: (n) => `${n}.rdb`, keydb: (n) => `${n}.rdb`, dragonfly: (n) => `${n}.rdb`, clickhouse: (n) => n,
};

/**
 * The command, run on the source host, that writes a dump the panel's import
 * accepts: pg_dump custom format, mysqldump/mariadb-dump SQL of the app
 * database (not the system schemas, which the import refuses), a gzipped
 * mongodump archive, an RDB snapshot.
 *
 * The MySQL/MariaDB dump names the database positionally, never with
 * --databases: that form writes `CREATE DATABASE shopdb; USE shopdb;`, and
 * the panel feeds the file to `mysql … app` as it is, so the rows would land
 * in `shopdb` instead of the managed `app` database (and the panel refuses
 * any `USE` other than `USE app` from a non-operator).
 */
export function dumpCommand(db: PlanDatabase): { command: string; file: string; notes: string[] } | null {
  if (!db.engine || !IMPORTABLE[db.engine]) return null;
  const file = DUMP_FILE[db.engine](fileBase(db.name));
  if (db.runtime?.kind === 'heroku-app') {
    // Heroku Postgres: a pg_dump custom-format backup taken by Heroku, downloaded with the Heroku CLI.
    if (db.engine !== 'postgres') return null;
    const app = isPlainName(db.runtime.name) ? db.runtime.name : '<app>';
    return {
      command: `heroku pg:backups:capture -a ${app} && curl -sSfo ${file} "$(heroku pg:backups:url -a ${app})"`,
      file,
      notes: app === '<app>' ? ['Replace <app> with the Heroku app name.'] : [],
    };
  }
  const notes: string[] = [];
  const { target, note } = sourceTarget(db.runtime, 'the name of the database container');
  if (note) notes.push(note);
  let inner: string;
  let auth = '';
  switch (db.engine) {
    case 'postgres':
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, run inside the container
      inner = 'pg_dump -Fc -U "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"';
      break;
    case 'mysql':
      inner = 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers "$MYSQL_DATABASE"';
      notes.push('If the container has no MYSQL_DATABASE, put the database name in its place.');
      break;
    case 'mariadb':
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, run inside the container
      inner = 'exec mariadb-dump -uroot -p"${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}" --single-transaction --routines --triggers "${MARIADB_DATABASE:-$MYSQL_DATABASE}"';
      notes.push('If the container has no MARIADB_DATABASE or MYSQL_DATABASE, put the database name in its place.');
      break;
    case 'mongo':
      inner = 'exec mongodump --archive --gzip -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin';
      break;
    default: {
      // redis, keydb, dragonfly: an RDB snapshot through the CLI the image ships.
      const cli = db.engine === 'keydb' ? 'keydb-cli' : 'redis-cli';
      inner = `${cli} --rdb /tmp/nd-dump.rdb >/dev/null && cat /tmp/nd-dump.rdb && rm -f /tmp/nd-dump.rdb`;
      auth = ' -e REDISCLI_AUTH';
      notes.push('With a password, first run `read -rs REDISCLI_AUTH; export REDISCLI_AUTH` on the source host; -e passes it by name, never on the command line.');
      if (db.engine === 'dragonfly') notes.push('Dragonfly images do not always ship redis-cli; run it from a redis image on the same network if it is missing.');
    }
  }
  return { command: `docker exec${auth} ${target} sh -c '${inner}' > ${file}`, file, notes };
}

/** The order that loses no writes, and the steps this command does not do. */
export const CUTOVER_ORDER = [
  'A day ahead: lower the TTL of each domain\'s DNS record (for example to 60 seconds).',
  'Stop writes on the source: stop the apps that write, or put them in maintenance. A dump of a live database misses every write made after it.',
  'Take the final dump of each database with the commands below, on the source host.',
  'Import them: ninedeploy import data plan.json --dump <database>=<file> --yes',
  'Deploy each service in NineDeploy and check it is healthy. import apply attached the new database where a copied connection string allowed it; change the variables it listed by hand.',
  'Switch DNS to this panel, then add the domains: ninedeploy import cutover plan.json --yes (it adds only hosts whose DNS already points here).',
];

const SOURCE_CHECKED_LIVE: Record<SourceKind, boolean> = { caprover: true, coolify: false, dokploy: false, heroku: false };

export function renderDataPreview(plan: ImportPlan, receipt: ImportReceipt | null): string {
  const out: string[] = ['Order:'];
  for (const [i, step] of CUTOVER_ORDER.entries()) out.push(`  ${i + 1}. ${step}`);
  out.push('', 'Databases:');
  for (const db of plan.databases) {
    const created = receipt?.items[`database:${db.ref}`];
    const data = receipt?.items[`data:${db.ref}`];
    if (!created || created.state !== 'done') {
      out.push(`  – ${db.name}: not created yet (run import apply first)`);
      continue;
    }
    if (data?.state === 'done') {
      out.push(`  ✓ ${db.name}: imported (#${data.importId}, sha256 ${data.sha256?.slice(0, 12)}…)`);
      continue;
    }
    // A Heroku add-on without the app name has no command (and no container to docker exec into).
    const cmd = plan.source.kind === 'heroku' && db.runtime?.kind !== 'heroku-app' ? null : dumpCommand(db);
    if (!cmd && plan.source.kind === 'heroku') {
      out.push(`  – ${db.name}: ${db.engine === 'postgres' ? 'pass --app <heroku app> to import plan for the pg:backups command, or download a backup from Heroku' : 'Heroku has no export command for it; move its keys by hand'}`);
      continue;
    }
    if (!cmd) {
      out.push(`  – ${db.name}: the panel has no dump import for ${db.engine ?? 'this engine'}; move its data by hand`);
      continue;
    }
    out.push(`  + ${db.name} (${db.engine}, NineDeploy database #${created.id}):`);
    out.push(`      ${cmd.command}`);
    for (const n of cmd.notes) out.push(`      ${n}`);
    out.push(`      then: --dump ${flagArg(db.name, cmd.file)}`);
  }
  if (plan.source.kind === 'heroku') out.push('', 'The Heroku commands follow the Heroku CLI documentation and have not been run against Heroku.');
  else if (!SOURCE_CHECKED_LIVE[plan.source.kind]) out.push('', `The ${plan.source.kind} commands follow its source code and have not been run against a live instance yet.`);
  out.push(...renderVolumePreview(plan, receipt));
  return out.join('\n');
}

export interface DataDeps {
  client: DataClient;
  receipt: ImportReceipt;
  save: (receipt: ImportReceipt) => void;
  /** sha256 and size of a local file. */
  hashFile: (file: string) => Promise<{ sha256: string; bytes: number }>;
  /** Stream of the file from a byte offset (for a resumed upload). */
  open: (file: string) => (offset: number) => AsyncIterable<Uint8Array>;
  now?: () => Date;
}

const FINISHED_OK: ReadonlyArray<DatabaseImport['status']> = ['completed', 'completed_with_warnings'];

/** Import each named dump, recording every step in the receipt. */
export async function importData(plan: ImportPlan, dumps: Record<string, string>, deps: DataDeps): Promise<ImportReceipt> {
  const now = deps.now ?? (() => new Date());
  const { receipt } = deps;
  if (receipt.source.kind !== plan.source.kind || receipt.source.url !== plan.source.url) {
    throw new Error(`The receipt is for a plan of ${receipt.source.kind} at ${receipt.source.url}, not ${plan.source.kind} at ${plan.source.url}. Pass another --receipt.`);
  }
  // Check every dump before uploading any.
  const jobs: Array<{ db: PlanDatabase; databaseId: number; file: string; sha256: string; bytes: number }> = [];
  for (const [name, file] of Object.entries(dumps)) {
    const db = plan.databases.find((d) => d.name === name);
    if (!db) throw new Error(`--dump names no database in the plan: ${name}.`);
    const created = receipt.items[`database:${db.ref}`];
    if (created?.state !== 'done' || created.id === undefined) throw new Error(`${name} has not been created yet: run \`ninedeploy import apply\` first.`);
    if (!db.engine || !IMPORTABLE[db.engine]) throw new Error(`The panel has no dump import for ${name} (${db.engine ?? 'no managed engine'}).`);
    const { sha256, bytes } = await deps.hashFile(file);
    if (bytes === 0) throw new Error(`${file} is empty.`);
    const prior = receipt.items[`data:${db.ref}`];
    if (prior?.state === 'done' && prior.sha256 !== sha256) {
      throw new Error(`${name} already has a dump imported (sha256 ${prior.sha256?.slice(0, 12)}…), and this one differs. import data does not import twice; use \`ninedeploy databases import ${created.id} --file …\` if you mean to.`);
    }
    if ((prior?.state === 'pending' || prior?.state === 'failed') && prior.importId !== undefined && prior.sha256 !== sha256) {
      throw new Error(`${name} has import #${prior.importId} recorded for a different dump. Check it with \`ninedeploy databases imports ${created.id}\`; use \`ninedeploy databases import ${created.id} --file …\` to deliberately import another dump.`);
    }
    jobs.push({ db, databaseId: created.id, file, sha256, bytes });
  }

  for (const job of jobs) {
    const key = `data:${job.db.ref}`;
    const prior = receipt.items[key];
    if (prior?.state === 'done') continue;
    const base = { kind: 'data' as const, ref: job.db.ref, name: job.db.name, id: job.databaseId, sha256: job.sha256, bytes: job.bytes };
    const put = (state: 'pending' | 'done' | 'failed', notes: string[], importId?: number) => {
      receipt.items[key] = { ...base, state, notes, ...(importId !== undefined ? { importId } : {}), at: now().toISOString() };
      deps.save(receipt);
    };
    // An upload of this same file that stopped part-way continues where the panel stands.
    let resumeImportId = (prior?.state === 'pending' || prior?.state === 'failed') && prior.sha256 === job.sha256 ? prior.importId : undefined;
    put('pending', [], resumeImportId);
    const options: DatabaseImportOptions = ['redis', 'keydb', 'dragonfly'].includes(job.db.engine!) ? { confirmReplace: true } : {};
    let row: DatabaseImport;
    try {
      const existing = resumeImportId === undefined ? undefined : await deps.client.databases.imports.get(job.databaseId, resumeImportId);
      if (existing && FINISHED_OK.includes(existing.status)) {
        row = existing;
      } else if (existing?.status === 'running') {
        row = await deps.client.databases.imports.wait(job.databaseId, existing.id);
      } else {
        if (existing && ['failed', 'cancelled', 'expired'].includes(existing.status)) {
          resumeImportId = undefined;
          put('pending', []);
        }
        row = await deps.client.databases.importFile(job.databaseId, deps.open(job.file), {
          sizeBytes: job.bytes,
          sha256: job.sha256,
          filename: path.basename(job.file),
          ...(resumeImportId !== undefined ? { resumeImportId } : { options }),
          onCreated: (r) => put('pending', [], r.id),
        });
        row = await deps.client.databases.imports.wait(job.databaseId, row.id);
      }
    } catch (err) {
      put('failed', [err instanceof Error ? err.message : String(err)], receipt.items[key]?.importId);
      continue;
    }
    // The panel's own message can quote the dump, so the receipt keeps the status only.
    if (FINISHED_OK.includes(row.status)) {
      put('done', [`Imported${row.status === 'completed_with_warnings' ? ' with warnings' : ''}: ${job.bytes} bytes, sha256 checked by the panel.`], row.id);
    } else {
      put('failed', [`Import #${row.id} ended ${row.status}. Details: ninedeploy databases imports ${job.databaseId}`], row.id);
    }
  }
  return receipt;
}

async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const st = statSync(file);
  if (!st.isFile()) throw new Error(`${file} is not a regular file.`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return { sha256: hash.digest('hex'), bytes: st.size };
}

export interface ImportDataOpts {
  receipt?: string;
  dump?: string[];
  volume?: string[];
  yes?: boolean;
}

export async function importDataAction(planPath: string, opts: ImportDataOpts, deps: { client?: DataClient; panel?: string } = {}): Promise<void> {
  try {
    const plan = validatePlan(JSON.parse(readFileSync(planPath, 'utf8')));
    const receiptPath = opts.receipt ?? `${planPath.replace(/\.json$/i, '')}.receipt.json`;
    if (!existsSync(receiptPath)) throw new Error(`No receipt at ${receiptPath}: run \`ninedeploy import apply ${planPath} --yes\` first.`);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as ImportReceipt;
    const panel = (deps.panel ?? loadConfig().baseUrl).replace(/\/+$/, '');
    if (receipt.panel !== panel) throw new Error(`The receipt is for ${receipt.panel}, but the CLI is signed in to ${panel}.`);
    const pairs = (flag: string, what: string, specs: string[] = []) => {
      const out: Record<string, string> = {};
      for (const spec of specs) {
        const eq = spec.indexOf('=');
        if (eq <= 0 || eq === spec.length - 1) throw new Error(`--${flag} takes <${what}>=<file>, got "${spec}".`);
        out[spec.slice(0, eq)] = spec.slice(eq + 1);
      }
      return out;
    };
    const dumps = pairs('dump', 'database', opts.dump);
    const archives = pairs('volume', 'service', opts.volume);
    header(`Data into ${panel}`);
    if (!opts.yes || Object.keys(dumps).length + Object.keys(archives).length === 0) {
      console.log(renderDataPreview(plan, receipt));
      info(`${c.dim('Nothing was imported.')} Pass --dump <database>=<file> or --volume <service>=<file> with --yes to import.`);
      return;
    }
    const client = deps.client ?? getClient();
    const common = {
      client, receipt, save: (r: ImportReceipt) => writeReceipt(receiptPath, r), hashFile,
      open: (file: string) => (offset: number) => createReadStream(file, { start: offset }),
    };
    await importData(plan, dumps, common);
    await importVolumes(plan, archives, common);
    const items = Object.values(receipt.items).filter((i) => i.kind === 'data' || i.kind === 'volume');
    console.log(renderReceipt({ ...receipt, items: Object.fromEntries(items.map((i) => [`${i.kind}:${i.ref}`, i])) }));
    const failed = items.filter((i) => i.state === 'failed').length;
    if (failed) error(`${failed} import(s) failed. Fix the cause and run the same command again. Receipt: ${receiptPath}`);
    else success(`Done. Receipt: ${receiptPath}. Next: deploy and check each service, switch DNS, then run import cutover.`);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
  }
}
