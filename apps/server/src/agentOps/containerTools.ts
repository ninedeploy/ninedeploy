import { z } from 'zod';
import { containerFileWrite } from '@ninedeploy/schemas';
import { capture, run } from '../lib/exec.js';
import { HttpError } from '../lib/errors.js';
import { deleteContainerPath, getContainerComposeManifest, inspectContainer, isManagedContainer, listContainerDir, makeContainerDir, readContainerFile, safeContainerPath, writeContainerFile, CONTAINER_FILE_READ_CAP } from '../engine/containerFiles.js';
import type { AgentOpModule } from './index.js';
import type { Params } from './operands.js';

const MAX_REPLY = 2 * 1024 * 1024;
const input = z.object({
  action: z.enum(['inspect', 'compose', 'list', 'read', 'write', 'mkdir', 'delete']),
  container: z.string().refine(isManagedContainer),
  path: z.string().max(1024).optional(),
  contentBase64: z.string().max(Math.ceil(CONTAINER_FILE_READ_CAP / 3) * 4).optional(),
}).strict();
const boundedCapture: typeof capture = (exe, args, options = {}) => capture(exe, args, { ...options, timeoutMs: 30_000, maxOutputBytes: MAX_REPLY });
const boundedRun: typeof run = (exe, args, options, sink, stdin) => run(exe, args, { ...options, timeoutMs: 30_000 }, sink, stdin);

/** Sealed operator tools resolve a name once, then use only the immutable container ID. */
async function containerTool(params: Params, onLine: (line: string) => void): Promise<number> {
  const parsed = input.safeParse(params);
  if (!parsed.success) throw new Error('Invalid node container tool input');
  const p = parsed.data;
  const metadata = p.action === 'inspect' || p.action === 'compose';
  if (metadata && p.path !== undefined || p.action !== 'write' && p.contentBase64 !== undefined) throw new Error('Unexpected node container tool operand');
  const path = metadata ? '/' : safeContainerPath(p.path ?? '/');
  if (!path || p.action !== 'list' && !metadata && path === '/') throw new Error('Invalid container path');
  let write: z.infer<typeof containerFileWrite> | undefined;
  if (p.action === 'write') {
    const value = containerFileWrite.safeParse({ path, contentBase64: p.contentBase64 });
    if (!value.success || Buffer.byteLength(value.data.contentBase64.replace(/\s/g, ''), 'base64') > CONTAINER_FILE_READ_CAP) throw new Error('Invalid or oversized node file content');
    write = value.data;
  }
  try {
    const id = (await capture('docker', ['inspect', '--type', 'container', '--format', '{{.Id}}', p.container], { timeoutMs: 10_000, maxOutputBytes: 128 })).trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Container identity is unconfirmed');
    let result: unknown;
    switch (p.action) {
      case 'inspect': result = await inspectContainer(id, boundedCapture); break;
      case 'compose': result = await getContainerComposeManifest(id, boundedCapture); break;
      case 'list': result = await listContainerDir(id, path, boundedCapture); break;
      case 'read': result = await readContainerFile(id, path, boundedCapture); break;
      case 'write': await writeContainerFile(id, path, write!.contentBase64, () => undefined, boundedRun); result = { ok: true }; break;
      case 'mkdir': await makeContainerDir(id, path, boundedCapture); result = { ok: true }; break;
      case 'delete': await deleteContainerPath(id, path, () => undefined, boundedRun); result = { ok: true }; break;
    }
    const reply = JSON.stringify({ ok: true, result });
    if (Buffer.byteLength(reply) > MAX_REPLY) throw new HttpError(413, 'container_reply_too_large', 'Node container result exceeds the supported size');
    onLine(reply); return 0;
  } catch (error) {
    const known = error instanceof HttpError;
    onLine(JSON.stringify({ ok: false, error: known ? { status: error.statusCode, code: error.code, message: error.message } : { status: 502, code: 'node_container_tool_failed', message: 'Node container operation could not be completed; no local fallback was attempted' } }));
    return 1;
  }
}

export const containerToolOps: AgentOpModule = {
  name: 'agentOps/containerTools.ts', caps: ['docker.containerTools'],
  ops: { 'docker.containerTool': { cap: 'docker.containerTools', sealedOnly: true, run: containerTool } },
};
