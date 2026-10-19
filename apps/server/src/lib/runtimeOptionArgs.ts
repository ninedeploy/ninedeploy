import type { ServiceRuntimeOptions } from '@ninedeploy/db';

/**
 * 0.16.1: the `docker run` flags for a service's advanced container options
 * (Service → Settings → Container options, operator only). Every value was
 * range- and allowlist-checked by the `runtimeOptions` schema when it was
 * saved; nothing here is a free-form flag. Null/empty → no flags, the line
 * every deploy had before.
 *
 * 0.16.6: moved here from engine/builders/docker.ts (which re-exports it) so
 * the node agent's `docker.runSpec` builds the same flags.
 */
export function runtimeOptionArgs(opts: ServiceRuntimeOptions | null | undefined): string[] {
  if (!opts) return [];
  const args: string[] = [];
  if (opts.gpus != null) args.push('--gpus', String(opts.gpus));
  if (opts.shmSizeMb != null) args.push('--shm-size', `${opts.shmSizeMb}m`);
  if (opts.init) args.push('--init');
  if (opts.ulimitNofile != null) args.push('--ulimit', `nofile=${opts.ulimitNofile}:${opts.ulimitNofile}`);
  for (const cap of opts.capAdd ?? []) args.push('--cap-add', cap);
  return args;
}

/** Whether the options set anything (the schema keeps an empty object possible). */
export function hasRuntimeOptions(opts: ServiceRuntimeOptions | null | undefined): opts is ServiceRuntimeOptions {
  return runtimeOptionArgs(opts).length > 0;
}
