/** Docker boundary fixture for the legacy agent transport/argv tests. */
export const LEGACY_DOCKER_ID = 'c'.repeat(64);
export function legacyDockerStub(line?: string) {
  let name = 'web-3', running = false;
  return async (_exe: unknown, argv: unknown, sink: unknown) => {
    const args = argv as string[], onLine = sink as ((line: string) => void) | undefined;
    if (args[0] === 'inspect' && args.includes('--type') && args.some(arg => arg.includes('.State.Running'))) {
      const reference = args.at(-1)!;
      if (reference !== LEGACY_DOCKER_ID) name = reference;
      onLine?.(JSON.stringify({ id: LEGACY_DOCKER_ID, name: `/${name}`, managed: null, serviceId: null, deploymentId: null,
        status: running ? 'running' : 'exited', running }));
    } else {
      if (args[0] === 'start') running = true;
      if (args[0] === 'stop') running = false;
      if (line) onLine?.(line);
    }
    return 0;
  };
}
