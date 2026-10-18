import { z } from 'zod';

/**
 * 0.16.3 custom Docker labels on a docker service's container, for tools that
 * read them on the host (monitoring and log shippers, backup agents). Routing
 * is not affected: the panel's Traefik reads its file provider only.
 */

export const MAX_DOCKER_LABELS = 50;

/**
 * Prefixes a user label may not use: the panel's own (deployment recovery and
 * cleanup find containers by them), Docker Compose's (the multi-line-env path
 * runs the container through compose), and Traefik's (they would do nothing
 * here, and could steer a second proxy someone runs on the host).
 */
export const RESERVED_DOCKER_LABEL_PREFIXES = ['ninedeploy.', 'com.docker.', 'traefik.'] as const;

/** Why `key` cannot be a user label key, or null. */
export function dockerLabelKeyProblem(key: string): string | null {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/.test(key)) {
    return 'letters, digits, . _ / - (starting and ending with a letter or digit), at most 128 characters';
  }
  const lower = key.toLowerCase();
  const reserved = RESERVED_DOCKER_LABEL_PREFIXES.find((p) => lower.startsWith(p));
  return reserved ? `the ${reserved}* labels are reserved` : null;
}

export const dockerLabelValue = z
  .string()
  .max(1000)
  .refine((v) => !/[\r\n\0]/.test(v), 'must be a single line');

export const dockerLabels = z
  .record(
    z.string().superRefine((key, ctx) => {
      const problem = dockerLabelKeyProblem(key);
      if (problem) ctx.addIssue({ code: 'custom', message: `${key}: ${problem}` });
    }),
    dockerLabelValue,
  )
  .refine((labels) => Object.keys(labels).length <= MAX_DOCKER_LABELS, `at most ${MAX_DOCKER_LABELS} labels`);
export type DockerLabels = z.infer<typeof dockerLabels>;

/**
 * The `key=value` per line text form (the web field, the CLI): blank lines
 * and `#` comments are skipped, the first `=` splits, a later line wins.
 * Lines that cannot be a label are returned in `invalid`.
 */
export function parseDockerLabels(text: string): { labels: Record<string, string>; invalid: string[] } {
  const labels: Record<string, string> = {};
  const invalid: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const key = (eq === -1 ? line : line.slice(0, eq)).trim();
    if (eq === -1 || dockerLabelKeyProblem(key) !== null) {
      invalid.push(line);
      continue;
    }
    labels[key] = line.slice(eq + 1).trim();
  }
  return { labels, invalid };
}

export function formatDockerLabels(labels: Record<string, string> | null | undefined): string {
  return Object.entries(labels ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}
