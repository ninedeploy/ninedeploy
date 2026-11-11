/**
 * Pieces of the commands `import data` prints for the source host. The names
 * in them come from the source platform's API, and the person pastes the
 * command into a shell, so a name only goes in when it is a plain Docker
 * name; anything else becomes a placeholder to fill in by hand.
 */

import type { PlanRuntime } from './plan.js';

/** A Docker container or service name: no spaces, quotes, `$`, `;` or other shell syntax. */
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

export const isPlainName = (name: string): boolean => DOCKER_NAME.test(name);

/** Single-quote for POSIX sh. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** A file name made of safe characters only. */
export function fileBase(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[.-]+/, '_');
  return safe || 'import';
}

/**
 * The container to reach on the source host: a container name, or the newest
 * task container of a Swarm service (`all` also finds stopped ones). A
 * missing or unusual name gives `<container>` and a note saying so.
 */
export function sourceTarget(
  runtime: PlanRuntime | undefined,
  what: string,
  all = false,
): { target: string; note: string | null } {
  if (runtime && isPlainName(runtime.name)) {
    switch (runtime.kind) {
      case 'container':
        return { target: runtime.name, note: null };
      case 'swarm-service':
        return { target: `$(docker ps -${all ? 'a' : ''}q --filter label=com.docker.swarm.service.name=${runtime.name} | head -n 1)`, note: null };
      case 'heroku-app':
        // A Heroku app has no container on a host you run docker on.
        return { target: '<container>', note: `Replace <container> with ${what}; Heroku runs it, so there is no docker host to read it from.` };
      default: {
        const never: never = runtime.kind;
        return never;
      }
    }
  }
  const why = runtime ? ` (its name on the source, ${JSON.stringify(runtime.name)}, is not a plain Docker name, so it is not put in a shell command)` : '';
  return { target: '<container>', note: `Replace <container> with ${what} on the source host (docker ps${all ? ' -a' : ''})${why}.` };
}

/** `<name>=<file>` for a --dump / --volume flag, quoted when the name is not plain. */
export function flagArg(name: string, file: string): string {
  return isPlainName(name) ? `${name}=${file}` : shellQuote(`${name}=${file}`);
}
