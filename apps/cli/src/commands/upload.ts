import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NineDeployClient } from '../client.js';
import { error, info, spinner, success } from '../lib/format.js';

/** The panel's limit for one upload (POST /v1/services/:id/source). */
export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** Never part of a build context: VCS data, dependency trees, build output, local env files. */
export const DEFAULT_EXCLUDES = ['.git', 'node_modules', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.venv', '__pycache__', '.env', '.env.*', '.DS_Store'];

/** `tar -czf` of `dir` (its contents, not the folder) into a buffer, with the excludes. */
export async function packDirectory(dir: string, excludes: string[]): Promise<Buffer> {
  const work = mkdtempSync(path.join(tmpdir(), 'nd-up-'));
  const out = path.join(work, 'source.tar.gz');
  try {
    await new Promise<void>((resolve, reject) => {
      // Relative -f with cwd: GNU tar reads a drive-letter colon (C:\…) as a remote host.
      const args = ['-czf', path.basename(out), ...excludes.map((e) => `--exclude=${e}`), '-C', dir, '.'];
      const child = spawn('tar', args, { cwd: work, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr.trim()}`))));
    });
    return readFileSync(out);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface DeployUpOptions {
  service?: string;
  create?: string;
  port?: string;
  deploy?: boolean;
  exclude?: string[];
}

/**
 * `ninedeploy deploy up [dir]` (0.16.1): pack a local folder (or send a
 * ready .zip / .tar.gz) and deploy it as the service's source — no Git
 * repository needed. `--service` names an existing upload-sourced service
 * (id or slug); `--create <name>` makes a new docker service for it.
 */
export async function deployUp(
  client: NineDeployClient,
  target: string | undefined,
  opts: DeployUpOptions,
  deps: { pack?: typeof packDirectory } = {},
): Promise<void> {
  const pack = deps.pack ?? packDirectory;
  const where = path.resolve(target ?? '.');
  if (!existsSync(where)) return error(`${where} does not exist.`);
  if (!opts.service && !opts.create) {
    return error('Name the service: --service <id|slug> for an existing one, or --create <name> for a new one.');
  }
  try {
    let archive: Buffer;
    if (statSync(where).isDirectory()) {
      const excludes = [...DEFAULT_EXCLUDES, ...(opts.exclude ?? [])];
      archive = await spinner(`Packing ${where}`, () => pack(where, excludes));
    } else if (/\.(zip|tar\.gz|tgz)$/i.test(where)) {
      archive = readFileSync(where);
    } else {
      return error('Pass a folder, a .zip or a .tar.gz.');
    }
    if (archive.length > UPLOAD_MAX_BYTES) {
      return error(
        `The archive is ${(archive.length / 1024 / 1024).toFixed(1)} MiB; the panel takes up to ${UPLOAD_MAX_BYTES / 1024 / 1024} MiB. ` +
          'Exclude build output or dependencies with --exclude <pattern>.',
      );
    }

    let serviceId: number;
    if (opts.create) {
      const port = opts.port ? Number(opts.port) : undefined;
      if (opts.port && (!Number.isInteger(port) || port! < 1 || port! > 65535)) return error('--port must be a port number.');
      const svc = await spinner(`Creating service ${opts.create}`, () =>
        client.services.create({ name: opts.create!, type: 'docker', ...(port ? { port } : {}) }),
      );
      serviceId = svc.id;
      info(`Service #${svc.id} (${svc.slug}) created.`);
    } else {
      const ref = opts.service!;
      if (/^\d+$/.test(ref)) {
        serviceId = Number(ref);
      } else {
        const found = (await client.services.list()).find((s) => s.slug === ref || s.name === ref);
        if (!found) return error(`No service named "${ref}".`);
        serviceId = found.id;
      }
    }

    const sizeMiB = (archive.length / 1024 / 1024).toFixed(1);
    const res = await spinner(`Uploading ${sizeMiB} MiB`, () =>
      client.services.uploadSource(serviceId, new Uint8Array(archive.buffer, archive.byteOffset, archive.length), { deploy: opts.deploy !== false }),
    );
    success(`Uploaded ${res.sha.slice(0, 7)} (${res.entries} entries).`);
    if (res.deploymentId != null) {
      success(`Deployment #${res.deploymentId} queued.`);
      info(`Watch logs: ninedeploy services logs ${serviceId}`);
    } else {
      info(`Stored only. Deploy it with: ninedeploy services deploy ${serviceId}`);
    }
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
  }
}
