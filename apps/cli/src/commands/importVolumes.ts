/**
 * `ninedeploy import data <plan> --volume <service>=<file.tar.gz>` (A1 step 3).
 *
 * Moves the contents of a service's data volume: the volume mounted at the
 * path the service was created with (`create.volumeMount`), which NineDeploy
 * keeps in `nd-svc-<slug>-data`.
 *
 * - The command printed for the source host reads the volume through the
 *   stopped source container (`--volumes-from`, read-only), so it needs no
 *   volume name and works for a named volume and a bind mount alike, and
 *   writes a gzipped tar with numeric owners, the format the panel restores.
 * - The archive goes through the panel's chunked volume import with its
 *   sha256, which the panel checks before the volume is touched. The panel
 *   snapshots a volume that already exists, then swaps the archive in.
 * - The receipt records the import id, sha256 and size. A stopped upload
 *   resumes, a volume already imported is not imported again.
 */
import path from 'node:path';
import type { VolumeImport } from '@ninedeploy/schemas';
import type { NineDeployClient } from '../client.js';
import type { ImportPlan, PlanService } from '../lib/importers/plan.js';
import { fileBase, flagArg, shellQuote, sourceTarget } from '../lib/importers/shell.js';
import type { ImportReceipt } from './importApply.js';

/** The panel calls the volume half makes; NineDeployClient satisfies it. */
export interface VolumeClient {
  volumeImports: {
    importFile: NineDeployClient['volumeImports']['importFile'];
    get: NineDeployClient['volumeImports']['get'];
    wait: NineDeployClient['volumeImports']['wait'];
  };
}

/** The helper image the panel itself tars volumes with (server lib/inventory.ts HELPER_IMAGE). */
const TAR_IMAGE = 'alpine:3.21';

/**
 * The source-host command that archives a service's data volume, or why it
 * cannot be printed. Null when the service has no data volume.
 */
export function volumeCommand(s: PlanService): { command: string; file: string; notes: string[] } | { manual: string } | null {
  const mount = s.create.volumeMount;
  if (!mount) return null;
  const v = s.volumes.find((x) => x.mountPath === mount);
  if (v?.source === 'file') return { manual: `${mount} is a file mount on the source; recreate it under Service → File mounts` };
  const notes: string[] = [];
  const { target, note } = sourceTarget(s.runtime, `${s.name}'s container`, true);
  if (note) notes.push(note);
  const others = s.volumes.filter((x) => x.mountPath !== mount && x.source !== 'file');
  if (others.length) notes.push(`Only ${mount} moves; copy ${others.map((x) => x.mountPath).join(', ')} by hand.`);
  const file = `${fileBase(s.name)}.volume.tar.gz`;
  return {
    command: `docker run --rm --volumes-from ${target}:ro ${TAR_IMAGE} tar -czf - --numeric-owner -C ${shellQuote(mount)} . > ${file}`,
    file,
    notes,
  };
}

/** The preview lines for every service with a data volume. */
export function renderVolumePreview(plan: ImportPlan, receipt: ImportReceipt | null): string[] {
  const out: string[] = [];
  for (const s of plan.services) {
    const cmd = volumeCommand(s);
    if (!cmd) continue;
    if (out.length === 0) out.push('', 'Volumes (the data volume of each service; stop the service on the source first):');
    const created = receipt?.items[`service:${s.ref}`];
    const done = receipt?.items[`volume:${s.ref}`];
    if (!created || created.state !== 'done') out.push(`  – ${s.name}: not created yet (run import apply first)`);
    else if (done?.state === 'done') out.push(`  ✓ ${s.name}: imported (#${done.importId}, sha256 ${done.sha256?.slice(0, 12)}…)`);
    else if ('manual' in cmd) out.push(`  – ${s.name}: ${cmd.manual}`);
    else {
      out.push(`  + ${s.name} (${s.create.volumeMount}, NineDeploy service #${created.id}):`);
      out.push(`      ${cmd.command}`);
      for (const n of cmd.notes) out.push(`      ${n}`);
      out.push(`      then: --volume ${flagArg(s.name, cmd.file)}`);
    }
  }
  return out;
}

export interface VolumeDeps {
  client: VolumeClient;
  receipt: ImportReceipt;
  save: (receipt: ImportReceipt) => void;
  hashFile: (file: string) => Promise<{ sha256: string; bytes: number }>;
  open: (file: string) => (offset: number) => AsyncIterable<Uint8Array>;
  now?: () => Date;
}

/** Check every archive, then import each, recording every step in the receipt. */
export async function importVolumes(plan: ImportPlan, archives: Record<string, string>, deps: VolumeDeps): Promise<ImportReceipt> {
  const now = deps.now ?? (() => new Date());
  const { receipt } = deps;
  const jobs: Array<{ s: PlanService; serviceId: number; file: string; sha256: string; bytes: number }> = [];
  for (const [name, file] of Object.entries(archives)) {
    const s = plan.services.find((x) => x.name === name);
    if (!s) throw new Error(`--volume names no service in the plan: ${name}.`);
    const created = receipt.items[`service:${s.ref}`];
    if (created?.state !== 'done' || created.id === undefined) throw new Error(`${name} has not been created yet: run \`ninedeploy import apply\` first.`);
    if (!s.create.volumeMount) throw new Error(`${name} has no data volume in the plan (no volume mount), so there is nothing to import into.`);
    const { sha256, bytes } = await deps.hashFile(file);
    if (bytes === 0) throw new Error(`${file} is empty.`);
    const prior = receipt.items[`volume:${s.ref}`];
    if (prior?.sha256 !== undefined && prior.sha256 !== sha256 && (prior.state === 'done' || prior.importId !== undefined)) {
      throw new Error(`${name} already has volume import #${prior.importId} recorded for a different archive. import data does not import twice; restore its pre-import snapshot or use the panel if you mean to.`);
    }
    jobs.push({ s, serviceId: created.id, file, sha256, bytes });
  }

  for (const job of jobs) {
    const key = `volume:${job.s.ref}`;
    const prior = receipt.items[key];
    if (prior?.state === 'done') continue;
    const base = { kind: 'volume' as const, ref: job.s.ref, name: job.s.name, id: job.serviceId, sha256: job.sha256, bytes: job.bytes };
    const put = (state: 'pending' | 'done' | 'failed', notes: string[], importId?: number) => {
      receipt.items[key] = { ...base, state, notes, ...(importId !== undefined ? { importId } : {}), at: now().toISOString() };
      deps.save(receipt);
    };
    let resumeImportId = prior?.sha256 === job.sha256 ? prior.importId : undefined;
    put('pending', [], resumeImportId);
    let row: VolumeImport;
    try {
      const existing = resumeImportId === undefined ? undefined : await deps.client.volumeImports.get(job.serviceId, resumeImportId);
      if (existing?.status === 'completed') row = existing;
      else if (existing?.status === 'running') row = await deps.client.volumeImports.wait(job.serviceId, existing.id);
      else {
        if (existing && ['failed', 'cancelled', 'expired'].includes(existing.status)) {
          resumeImportId = undefined;
          put('pending', []);
        }
        row = await deps.client.volumeImports.importFile(job.serviceId, deps.open(job.file), {
          sizeBytes: job.bytes,
          sha256: job.sha256,
          filename: path.basename(job.file),
          ...(resumeImportId !== undefined ? { resumeImportId } : {}),
          onCreated: (r) => put('pending', [], r.id),
        });
        row = await deps.client.volumeImports.wait(job.serviceId, row.id);
      }
    } catch (err) {
      const status = (err as { status?: number }).status;
      const message = status === 404 && receipt.items[key]?.importId === undefined
        ? 'This panel has no volume import: update it (0.18.27 or later), or copy the files by hand.'
        : err instanceof Error ? err.message : String(err);
      put('failed', [message], receipt.items[key]?.importId);
      continue;
    }
    if (row.status === 'completed') {
      put('done', [
        `Imported into ${row.volumeName}: ${job.bytes} bytes, sha256 checked by the panel.`,
        ...(row.safetyBackupId ? [`The volume's earlier contents are in volume backup #${row.safetyBackupId} (pre-import).`] : []),
      ], row.id);
    } else {
      // The panel's message can quote file names from the archive, so the receipt keeps the status only.
      put('failed', [`Volume import #${row.id} ended ${row.status}. Details: the service's volume imports on the panel.`], row.id);
    }
  }
  return receipt;
}
