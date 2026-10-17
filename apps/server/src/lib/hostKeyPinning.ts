import { randomUUID } from 'node:crypto';

const GENERATION_PREFIX = '# ninedeploy-host-key-generation:';

/** A reset starts a new trust generation; known_hosts readers ignore comments. */
export function newHostKeyGeneration(): string {
  return `${GENERATION_PREFIX}${randomUUID()}\n`;
}

export function hostKeyGeneration(hostKeys: string | null | undefined): string | null {
  const firstLine = hostKeys?.split('\n', 1)[0];
  return firstLine?.startsWith(GENERATION_PREFIX) ? firstLine : null;
}
