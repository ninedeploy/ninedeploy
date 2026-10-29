import path from 'node:path';
import { rmSync } from 'node:fs';
import { z } from 'zod';
import { PUBLIC_ACCESS_PORT_MAX, PUBLIC_ACCESS_PORT_MIN } from '@ninedeploy/schemas';
import { capture } from '../lib/exec.js';
import { HttpError, conflict } from '../lib/errors.js';
import {
  type SidecarRunSpec,
  inspectSidecar,
  panelUser,
  removeContainer,
  renderPublicDbDynamicConfig,
  sidecarFingerprint,
  sidecarName,
  startSidecar,
  writeConfigFiles,
} from '../lib/publicDatabaseAccess.js';
import { normaliseAllowlist } from '../lib/ipAllowlist.js';
import { switchedOff } from './operands.js';
import type { AgentOpModule } from './index.js';

/**
 * Public access to a node database, agent side (ROADMAP item 10). The same
 * sidecar the panel host runs (lib/publicDatabaseAccess.ts): a Traefik
 * container `nd-dbpub-<slug>` that publishes ONE host port of the node and
 * proxies TCP, behind the IP allow-list, to the database container. Here it
 * joins only the database's own bridge `nd-dbnet-<slug>` (never the node's
 * shared network), so it can reach that database and nothing else.
 *
 * - `db.publicAccess.apply` (sealed): checks that `nd-db-<slug>` is the
 *   managed database with that id, writes the config under the agent's home
 *   (`dbproxy/<slug>`) and (re)starts the sidecar, or only rewrites the
 *   allow-list when the running sidecar already serves that port.
 * - `db.publicAccess.remove` (sealed): removes the sidecar and its config.
 * - `db.publicAccess.inspect`: whether it runs.
 *
 * TLS is end to end between the client and the database (`tlsMode: none`):
 * certificates live on the panel. The node owner turns this off with
 * `NINEDEPLOY_AGENT_PUBLIC_DATABASES=off` (or all node databases with
 * `NINEDEPLOY_AGENT_DATABASES=off`). Every reply is one
 * `ND-PUBLIC-DB {…}` line.
 */

export const PUBLIC_DB_CAPABILITY = 'db.publicAccess' as const;
const REPLY = 'ND-PUBLIC-DB ';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const applyParams = z
  .object({
    databaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    slug,
    container: z.string().max(128).regex(/^nd-db-[a-z0-9][a-z0-9_.-]*$/),
    enginePort: z.number().int().min(1).max(65535),
    port: z.number().int().min(PUBLIC_ACCESS_PORT_MIN).max(PUBLIC_ACCESS_PORT_MAX),
    allowlist: z.array(z.string().max(64)).min(1).max(100),
  })
  .strict();

export function publicDatabasesForbidden(env: NodeJS.ProcessEnv = process.env): boolean {
  return switchedOff(env['NINEDEPLOY_AGENT_DATABASES']) || switchedOff(env['NINEDEPLOY_AGENT_PUBLIC_DATABASES']);
}

/** `<agent home>/dbproxy/<slug>`: the agent home is bind-mounted at the same path, so it is also the host path. */
export const nodeSidecarDir = (s: string, root: string = process.cwd()): string => path.join(root, 'dbproxy', slug.parse(s));
export const nodeDatabaseBridge = (s: string): string => `nd-dbnet-${s}`;

/** The managed database container with this id and slug, or a refusal. */
async function assertManagedDatabase(container: string, databaseId: number, s: string): Promise<void> {
  const out = await capture('docker', [
    'inspect', container, '--format',
    '{{index .Config.Labels "ninedeploy.managed"}}|{{index .Config.Labels "ninedeploy.database.id"}}|{{index .Config.Labels "ninedeploy.database.slug"}}',
  ]).catch(() => null);
  if (out === null) throw new HttpError(409, 'database_missing', 'The database container does not exist on the node');
  const [managed, id, labelSlug] = out.trim().split('|');
  if (managed !== 'database' || id !== String(databaseId) || labelSlug !== s) {
    throw new HttpError(409, 'database_identity_changed', 'The target is not a confirmed managed database');
  }
}

async function answer(onLine: (line: string) => void, action: () => Promise<unknown>): Promise<number> {
  try {
    onLine(`${REPLY}${JSON.stringify(await action())}`);
    return 0;
  } catch (err) {
    const failure =
      err instanceof HttpError ? err : new HttpError(502, 'public_access_failed', (err instanceof Error ? err.message : String(err)).slice(0, 500));
    onLine(`${REPLY}${JSON.stringify({ error: { status: failure.statusCode, code: failure.code, message: failure.message } })}`);
    return 1;
  }
}

function refuseWhenOff(): void {
  if (publicDatabasesForbidden()) throw new HttpError(403, 'public_access_disabled', 'Public database access is disabled by the node owner');
}

export const publicAccessOps: AgentOpModule = {
  name: 'agentOps/publicAccess.ts',
  caps: [PUBLIC_DB_CAPABILITY],
  ops: {
    'db.publicAccess.apply': {
      cap: PUBLIC_DB_CAPABILITY,
      sealedOnly: true,
      run: async (params, onLine) => {
        const input = applyParams.parse(params);
        return answer(onLine, async () => {
          refuseWhenOff();
          await assertManagedDatabase(input.container, input.databaseId, input.slug);
          const dir = nodeSidecarDir(input.slug);
          const name = sidecarName(input.slug);
          const dynamic = renderPublicDbDynamicConfig({
            target: `${input.container}:${input.enginePort}`,
            allowlist: normaliseAllowlist(input.allowlist),
            tlsMode: 'none',
          });
          const state = await inspectSidecar(name);
          if (state?.running && state.fingerprint === sidecarFingerprint(input.port)) {
            writeConfigFiles(dir, dynamic);
            return { mode: 'hot' };
          }
          writeConfigFiles(dir, dynamic);
          const spec: SidecarRunSpec = {
            name,
            databaseId: input.databaseId,
            port: input.port,
            fingerprint: sidecarFingerprint(input.port),
            hostDir: dir,
            user: panelUser(),
            network: nodeDatabaseBridge(input.slug),
          };
          try {
            await startSidecar(spec, () => undefined);
          } catch (err) {
            if (err instanceof HttpError && err.statusCode === 409) throw conflict(err.message);
            throw err;
          }
          return { mode: 'started' };
        });
      },
    },
    'db.publicAccess.remove': {
      cap: PUBLIC_DB_CAPABILITY,
      sealedOnly: true,
      run: async (params, onLine) => {
        const input = z.object({ slug }).strict().parse(params);
        return answer(onLine, async () => {
          await removeContainer(sidecarName(input.slug));
          rmSync(nodeSidecarDir(input.slug), { recursive: true, force: true });
          return { removed: true };
        });
      },
    },
    'db.publicAccess.inspect': {
      cap: PUBLIC_DB_CAPABILITY,
      sealedOnly: false,
      run: async (params, onLine) => {
        const input = z.object({ slug }).strict().parse(params);
        return answer(onLine, async () => {
          const state = await inspectSidecar(sidecarName(input.slug));
          return { running: state?.running === true, fingerprint: state?.fingerprint ?? null };
        });
      },
    },
  },
};
