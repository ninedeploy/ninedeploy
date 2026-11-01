/** A node proxy is distinct from the panel's default Traefik container. */
export function confirmServingTrafficRouting(routes, proxyId, { confirmRouting, probeArgs, execDocker }) {
  if (typeof proxyId !== 'string' || !/^[a-f0-9]{64}$/.test(proxyId)) throw Error('An immutable node proxy ID is required');
  return confirmRouting(routes, { read: async (remainingMs, tls) => {
    const { stdout } = await execDocker('docker', probeArgs(proxyId, tls), { timeout: Math.min(3000, remainingMs), maxBuffer: 4 << 20 });
    return stdout;
  } });
}
