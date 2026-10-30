import { z } from 'zod';
import { capture, run } from '../lib/exec.js';
import { HttpError } from '../lib/errors.js';
import { PGBOUNCER_IMAGE, createPgbouncerSidecar, pgbouncerSidecarState, renderPgbouncerIni, renderUserlist } from '../lib/pgbouncer.js';
import { switchedOff } from './operands.js';
import type { AgentOpModule } from './index.js';

/**
 * PgBouncer for a node database, agent side (ROADMAP item 10). The same
 * sidecar the panel host runs (lib/pgbouncer.ts): `nd-pgb-<slug>`, joined
 * only to the database's own bridge `nd-dbnet-<slug>`, the network the
 * services attached to that database are on. It publishes no port of the
 * node; those services connect to `nd-pgb-<slug>:<port>` by name.
 *
 * - `db.pgbouncer.enable` (sealed: it carries the database password) checks
 *   that `nd-db-<slug>` is the running managed postgres with that id, then
 *   (re)creates the sidecar. The config is copied into the container and the
 *   temporary files are deleted at once.
 * - `db.pgbouncer.disable` (sealed) removes it.
 * - `db.pgbouncer.status`: whether it runs, and its pool mode.
 *
 * The node owner turns it off with `NINEDEPLOY_AGENT_PGBOUNCER=off` (or all
 * node databases with `NINEDEPLOY_AGENT_DATABASES=off`). Every reply is one
 * `ND-PGBOUNCER {…}` line.
 */

export const PGBOUNCER_CAPABILITY = 'db.pgbouncer' as const;
const REPLY = 'ND-PGBOUNCER ';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
/** Values that land in the ini and the userlist: nothing that could start a new line or close a quote. */
const identifier = z.string().regex(/^[A-Za-z0-9_]{1,63}$/);
const enableParams = z
  .object({
    databaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    slug,
    container: z.string().max(128).regex(/^nd-db-[a-z0-9][a-z0-9_.-]*$/),
    postgresPort: z.number().int().min(1).max(65535),
    listenPort: z.number().int().min(1024).max(65535),
    user: identifier,
    dbName: identifier,
    password: z.string().min(1).max(256).regex(/^[^"\r\n\0\\]+$/),
  })
  .strict();

export function pgbouncerForbidden(env: NodeJS.ProcessEnv = process.env): boolean {
  return switchedOff(env['NINEDEPLOY_AGENT_DATABASES']) || switchedOff(env['NINEDEPLOY_AGENT_PGBOUNCER']);
}

export const nodePgbouncerName = (s: string): string => `nd-pgb-${slug.parse(s)}`;

/** The running managed database with this id and slug (the panel only asks for postgres), or a refusal. */
async function assertManagedPostgres(container: string, databaseId: number, s: string): Promise<void> {
  const out = await capture('docker', [
    'inspect', container, '--format',
    '{{index .Config.Labels "ninedeploy.managed"}}|{{index .Config.Labels "ninedeploy.database.id"}}|{{index .Config.Labels "ninedeploy.database.slug"}}|{{.State.Running}}',
  ]).catch(() => null);
  if (out === null) throw new HttpError(409, 'database_missing', 'The database container does not exist on the node');
  const [managed, id, labelSlug, running] = out.trim().split('|');
  if (managed !== 'database' || id !== String(databaseId) || labelSlug !== s) {
    throw new HttpError(409, 'database_identity_changed', 'The target is not a confirmed managed database');
  }
  if (running !== 'true') throw new HttpError(409, 'not_running', 'The database is not running on the node; start it first');
}

async function answer(onLine: (line: string) => void, action: () => Promise<unknown>): Promise<number> {
  try {
    onLine(`${REPLY}${JSON.stringify(await action())}`);
    return 0;
  } catch (err) {
    const failure =
      err instanceof HttpError ? err : new HttpError(502, 'pgbouncer_failed', (err instanceof Error ? err.message : String(err)).slice(0, 500));
    onLine(`${REPLY}${JSON.stringify({ error: { status: failure.statusCode, code: failure.code, message: failure.message } })}`);
    return 1;
  }
}

const swallow = () => undefined;

export const pgbouncerOps: AgentOpModule = {
  name: 'agentOps/pgbouncer.ts',
  caps: [PGBOUNCER_CAPABILITY],
  ops: {
    'db.pgbouncer.enable': {
      cap: PGBOUNCER_CAPABILITY,
      sealedOnly: true,
      run: async (params, onLine) => {
        const input = enableParams.parse(params);
        return answer(onLine, async () => {
          if (pgbouncerForbidden()) throw new HttpError(403, 'pgbouncer_disabled', 'PgBouncer is disabled by the node owner');
          await assertManagedPostgres(input.container, input.databaseId, input.slug);
          const containerName = nodePgbouncerName(input.slug);
          await capture('docker', ['pull', PGBOUNCER_IMAGE]).catch(swallow);
          await createPgbouncerSidecar(
            {
              containerName,
              network: `nd-dbnet-${input.slug}`,
              publishPort: null,
              ini: renderPgbouncerIni({
                postgresHost: input.container,
                postgresPort: input.postgresPort,
                listenPort: input.listenPort,
                user: input.user,
                password: input.password,
                dbName: input.dbName,
              }),
              userlist: renderUserlist({ user: input.user, password: input.password }),
            },
            () => undefined,
          );
          const state = await pgbouncerSidecarState(containerName);
          if (!state.running) {
            await run('docker', ['rm', '-f', containerName], {}, swallow).catch(swallow);
            throw new HttpError(502, 'pgbouncer_failed', 'The PgBouncer sidecar did not stay running');
          }
          return { containerName, running: true };
        });
      },
    },
    'db.pgbouncer.disable': {
      cap: PGBOUNCER_CAPABILITY,
      sealedOnly: true,
      run: async (params, onLine) => {
        const input = z.object({ slug }).strict().parse(params);
        return answer(onLine, async () => {
          await run('docker', ['rm', '-f', nodePgbouncerName(input.slug)], {}, swallow).catch(swallow);
          return { removed: true };
        });
      },
    },
    'db.pgbouncer.status': {
      cap: PGBOUNCER_CAPABILITY,
      sealedOnly: false,
      run: async (params, onLine) => {
        const input = z.object({ slug }).strict().parse(params);
        return answer(onLine, () => pgbouncerSidecarState(nodePgbouncerName(input.slug)));
      },
    },
  },
};
