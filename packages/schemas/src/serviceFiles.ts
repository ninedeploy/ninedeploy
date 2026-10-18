import { z } from 'zod';
import { containerPath } from './common.js';

/**
 * 0.16.3 file mounts: a file whose content is kept by the panel (encrypted)
 * and mounted read-only at a path inside a docker service's container, like
 * Coolify's and Dokploy's file mounts. Typical uses: an nginx.conf, a
 * config.yaml, a certificate bundle.
 */

/** Files per service. */
export const MAX_SERVICE_FILES = 20;
/** Bytes per file (UTF-8). */
export const MAX_SERVICE_FILE_BYTES = 256 * 1024;

/**
 * Paths Docker manages itself or that would hand the container the host:
 * mounting a file there either fails at `docker run` or does something no
 * config file should.
 */
const RESERVED = ['/proc', '/sys', '/dev', '/etc/hosts', '/etc/hostname', '/etc/resolv.conf', '/var/run/docker.sock', '/run/docker.sock'];

/** Why `path` cannot be a file mount, or null. */
export function serviceFilePathProblem(path: string): string | null {
  if (path === '/' || path.endsWith('/')) return 'must name a file, not a directory';
  for (const r of RESERVED) {
    if (path === r || path.startsWith(`${r}/`)) return `${r} is managed by Docker and cannot be a file mount`;
  }
  return null;
}

export const serviceFilePath = containerPath.max(255).superRefine((v, ctx) => {
  const problem = serviceFilePathProblem(v);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

/** UTF-8 byte length (the package targets no DOM, so no TextEncoder). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** `PUT /v1/services/:id/files`: create or replace the file at `path`. */
export const serviceFilePut = z.object({
  path: serviceFilePath,
  content: z
    .string()
    .refine((v) => utf8Length(v) <= MAX_SERVICE_FILE_BYTES, `at most ${MAX_SERVICE_FILE_BYTES / 1024} KiB`)
    .refine((v) => !v.includes('\0'), 'must be text (no NUL bytes)'),
});
export type ServiceFilePut = z.infer<typeof serviceFilePut>;

/** One file as the list returns it; `content` only from the single-file read. */
export interface ServiceFileEntry {
  id: number;
  path: string;
  size: number;
  updatedAt: string;
}
export interface ServiceFile extends ServiceFileEntry {
  content: string;
}
