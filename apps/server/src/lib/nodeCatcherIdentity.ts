/** Only the legacy backend or an agent-generated name may enter a Traefik upstream. */
export const validNodeCatcherName = (name: string) => name === 'ninedeploy-wake' ||
  name.length === 50 && /^ninedeploy-wake-g-[a-f0-9]{32}$/.test(name);
export type CatcherIdentity = { id: string; image: string; name?: string };
