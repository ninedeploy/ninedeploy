import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { volumeFileWrite } from '@ninedeploy/schemas';
import { capture, run } from '../lib/exec.js';
import { HttpError } from '../lib/errors.js';
import { HELPER_IMAGE } from '../lib/inventory.js';
import { isManagedVolume } from '../agentOps/operands.js';
import { safeRelPath } from './volumeFiles.js';
import { listContainerDir, readContainerFile, writeContainerFile, makeContainerDir, deleteContainerPath, type ContainerFileEntry } from './containerFiles.js';

const MAX_REPLY = 2 * 1024 * 1024;
const CAP = 1024 * 1024;
const OWNER = 'ninedeploy.volume-file-tool';
const metadata = z.object({ Name: z.string(), Driver: z.literal('local'), Mountpoint: z.string(), CreatedAt: z.string().min(1),
  Scope: z.literal('local'), Labels: z.record(z.string(), z.string()).nullable().optional(), Options: z.record(z.string(), z.string()).nullable().optional() });
const daemonSchema = z.object({ root: z.string(), os: z.literal('linux'), id: z.string().min(1).max(256) });
export interface VolumeFileResults {
  list: ContainerFileEntry[];
  read: { content: string; encoding: 'utf8' | 'base64' };
  write: { ok: true };
  mkdir: { ok: true };
  delete: { ok: true };
}
export type VolumeFileAction = keyof VolumeFileResults;
const failed = () => new HttpError(502, 'volume_file_tool_failed', 'Volume file operation could not be confirmed');
const changed = () => new HttpError(409, 'volume_identity_changed', 'The volume or Docker daemon changed; retry after checking its identity');

/** Bind an existing local volume inode; never pass a named-volume mount that can auto-create it. */
export async function volumeFileTool<A extends VolumeFileAction>(volume: string, action: A, operands: { path?: string; contentBase64?: string } = {}): Promise<VolumeFileResults[A]> {
  if (!isManagedVolume(volume) || !['list', 'read', 'write', 'mkdir', 'delete'].includes(action)) throw new HttpError(400, 'invalid_volume_tool', 'Invalid volume file operation');
  const rel = safeRelPath(operands.path ?? '');
  if (rel === null || rel.includes('\r') || rel.length > 2048 || action !== 'list' && !rel) throw new HttpError(400, 'invalid_volume_path', 'A valid path inside the volume is required');
  if (action !== 'write' && operands.contentBase64 !== undefined) throw new HttpError(400, 'invalid_volume_tool', 'Unexpected file content');
  let content: string | undefined;
  if (action === 'write') {
    const value = volumeFileWrite.safeParse({ path: rel, contentBase64: operands.contentBase64 });
    if (!value.success) throw new HttpError(400, 'invalid_volume_content', 'Invalid file content');
    content = value.data.contentBase64.replace(/\s/g, '');
    if (Buffer.byteLength(content, 'base64') > CAP) throw new HttpError(413, 'file_too_large', 'File exceeds the 1 MiB editor limit');
  }
  const deadline = Date.now() + 120_000, nonce = randomUUID(), name = `nd-volume-tool-${nonce}`;
  const helpers: { name: string; id?: string }[] = [];
  let helperId: string | undefined, source: string | undefined, daemonId: string | undefined, operationError: HttpError | undefined, cleanupFailed = false, result: unknown;
  const budget = (requested: number) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new HttpError(504, 'volume_tool_timeout', 'Volume operation timed out');
    return Math.min(requested, remaining);
  };
  const read: typeof capture = (exe, args, options = {}) => capture(exe, args, { ...options, timeoutMs: budget(30_000), maxOutputBytes: Math.min(options.maxOutputBytes ?? MAX_REPLY, MAX_REPLY) });
  const execute: typeof run = (exe, args, options, sink, stdin) => run(exe, args, { ...options, timeoutMs: budget(30_000) }, sink, stdin);
  const daemon = async () => {
    const value = daemonSchema.parse(JSON.parse(await read('docker', ['info', '--format', '{"root":{{json .DockerRootDir}},"os":{{json .OSType}},"id":{{json .ID}}}'])));
    if (!value.root.startsWith('/') || value.root === '/' || /[\0\r\n,]/.test(value.root) || path.posix.normalize(value.root) !== value.root) throw changed();
    return value;
  };
  const inspectVolume = async () => {
    let raw: string;
    try { raw = await read('docker', ['volume', 'inspect', '--format', '{{json .}}', '--', volume], { maxOutputBytes: 64 * 1024 }); }
    catch (error) { if (/No such volume/i.test(error instanceof Error ? error.message : '')) throw new HttpError(404, 'volume_not_found', 'Volume not found'); throw error; }
    const value = metadata.safeParse(JSON.parse(raw));
    if (!value.success || value.data.Name !== volume || Object.keys(value.data.Options ?? {}).length) throw new HttpError(422, 'volume_driver_unsupported', 'File tools require a confirmed local Docker volume without external driver options');
    return value.data;
  };
  const cleanup = async () => {
    // All idle helpers self-exit after 150s if the agent dies or Docker cannot confirm cleanup.
    if (helpers.length && daemonId) {
      const cleanupDeadline = Date.now() + 20_000;
      const cleanupBudget = (ms: number) => Math.max(1, Math.min(ms, cleanupDeadline - Date.now()));
      try {
        const now = daemonSchema.parse(JSON.parse(await capture('docker', ['info', '--format', '{"root":{{json .DockerRootDir}},"os":{{json .OSType}},"id":{{json .ID}}}'], { timeoutMs: cleanupBudget(5000), maxOutputBytes: 4096 })));
        if (now.id !== daemonId) throw changed();
        for (const helper of helpers.reverse()) {
          try {
            const owned = JSON.parse(await capture('docker', ['inspect', '--type', 'container', '--format', '{"id":{{json .Id}},"owner":{{json (index .Config.Labels "ninedeploy.volume-file-tool")}}}', helper.id ?? helper.name], { timeoutMs: cleanupBudget(5000), maxOutputBytes: 4096 })) as { id: string; owner: string };
            if (!/^[a-f0-9]{64}$/.test(owned.id) || owned.owner !== nonce || helper.id && owned.id !== helper.id) throw changed();
            await run('docker', ['rm', '-f', owned.id], { timeoutMs: cleanupBudget(10_000) }, () => undefined);
          } catch (error) {
            if (!/No such (object|container)/i.test(error instanceof Error ? error.message : '')) cleanupFailed = true;
          }
        }
      } catch { cleanupFailed = true; }
    }
  };
  try {
    const originalDaemon = await daemon(); daemonId = originalDaemon.id;
    const original = await inspectVolume(); source = original.Mountpoint;
    if (source !== path.posix.join(originalDaemon.root, 'volumes', volume, '_data')) throw changed();
    const fingerprint = JSON.stringify(original);
    let image: string;
    try { image = (await read('docker', ['image', 'inspect', '--format', '{{.Id}}', HELPER_IMAGE])).trim(); }
    catch {
      await run('docker', ['pull', HELPER_IMAGE], { timeoutMs: budget(90_000) }, () => undefined);
      image = (await read('docker', ['image', 'inspect', '--format', '{{.Id}}', HELPER_IMAGE])).trim();
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw failed();
    const startHelper = async (readOnly: boolean) => {
      const owned = { name: helpers.length ? `${name}-${helpers.length}` : name, id: undefined as string | undefined };
      helpers.push(owned); // Retain the nonce/name if a timed-out Docker reply loses the created ID.
      const id = (await read('docker', ['run', '-d', '--rm', '--name', owned.name, '--label', `${OWNER}=${nonce}`, '--network', 'none', '--read-only',
        '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--memory', '64m', '--cpus', '0.5',
        '--mount', `type=bind,source=${source},target=/v,bind-propagation=rslave${readOnly ? ',readonly' : ''}`, image, 'sleep', '150'])).trim();
      if (!/^[a-f0-9]{64}$/.test(id)) throw failed();
      owned.id = id;
      return id;
    };
    helperId = await startHelper(false);
    const inode = async (id: string) => {
      const value = (await read('docker', ['exec', id, 'stat', '-c', '%d:%i', '/v'], { maxOutputBytes: 256 })).trim();
      if (!/^\d+:\d+$/.test(value)) throw failed();
      return value;
    };
    const pinnedInode = await inode(helperId);
    const verify = async () => {
      const now = await daemon();
      if (now.id !== daemonId || now.root !== originalDaemon.root || JSON.stringify(await inspectVolume()) !== fingerprint) throw changed();
      // Metadata can collide after a rapid replacement. A fresh read-only bind attests the current inode.
      // Each probe mounts only this volume, and cannot redirect the already pinned operation helper.
      if (await inode(await startHelper(true)) !== pinnedInode) throw changed();
    };
    // The first live bind selects the object. Subsequent delete/recreate cannot redirect its file operations.
    await verify();
    const target = rel ? `/v/${rel}` : '/v';
    const guard = 'set -f; target=$1; action=$2; old=$IFS; IFS=/; set -- $target; IFS=$old; current=; remaining=$#; for part do remaining=$((remaining-1)); [ -n "$part" ] || continue; next="$current/$part"; if [ -L "$next" ] && ! { [ "$action" = delete ] && [ "$remaining" -eq 0 ]; }; then current=$(readlink -f -- "$next") || exit 41; else current=$next; fi; case "$current" in /v|/v/*) ;; *) exit 41 ;; esac; done; printf "%s" "$current"';
    let resolved: string;
    try { resolved = await read('docker', ['exec', helperId, 'sh', '-c', guard, 'sh', target, action], { maxOutputBytes: 4096 }); }
    catch { throw new HttpError(400, 'volume_path_escape', 'Path cannot be resolved inside the volume'); }
    if (resolved !== '/v' && !resolved.startsWith('/v/')) throw new HttpError(400, 'volume_path_escape', 'Path cannot be resolved inside the volume');
    switch (action) {
      case 'list': result = await listContainerDir(helperId, resolved, read); break;
      case 'read': result = await readContainerFile(helperId, resolved, read); break;
      case 'write': await writeContainerFile(helperId, resolved, content!, () => undefined, execute); result = { ok: true }; break;
      case 'mkdir': await makeContainerDir(helperId, resolved, read); result = { ok: true }; break;
      case 'delete': await deleteContainerPath(helperId, resolved, () => undefined, execute); result = { ok: true }; break;
    }
    await verify();
  } catch (error) {
    operationError = error instanceof HttpError ? error : failed();
  } finally {
    await cleanup();
  }
  if (operationError) throw operationError;
  if (cleanupFailed) throw new HttpError(502, 'volume_helper_cleanup_unconfirmed', 'Volume operation completed but helper cleanup could not be confirmed; its lifetime is bounded');
  return result as VolumeFileResults[A];
}
