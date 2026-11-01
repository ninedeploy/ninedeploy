import { describe, expect, it, vi } from 'vitest';
import { load } from 'js-yaml';
import { confirmServingTrafficRouting } from '../../../scripts/lib/serving-traffic-routing.mjs';
import { confirmProxyRouting, routingProbeArgs, withRoutingAck } from '../src/lib/proxyRoutingAck.js';

const boundary = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../src/lib/exec.js', () => ({ capture: boundary.capture, sleep: async () => {} }));
const routes = 'http: {}';
function reply() {
  const config = load(withRoutingAck(routes)) as { http: Record<string, Record<string, unknown>> };
  const actual = Object.fromEntries(['routers', 'services', 'middlewares'].map(kind => [kind,
    Object.fromEntries(Object.entries(config.http[kind] ?? {}).map(([name, value]) => [name + '@file', { ...(value as object), status: 'enabled' }]))]));
  const generation = (actual.middlewares!['nd_routing_generation@file'] as any).headers.customResponseHeaders['X-NineDeploy-Generation'];
  return `HTTP/1.1 200 OK\nX-NineDeploy-Generation: ${generation}\n\n${JSON.stringify(actual)}`;
}
describe('node serving smoke routing confirmation', () => {
  it.each(['ninedeploy-proxy', 'short'])('rejects a proxy without its immutable identity: %s', proxyId => {
    const execDocker = vi.fn();
    expect(() => confirmServingTrafficRouting(routes, proxyId, { confirmRouting: confirmProxyRouting, probeArgs: routingProbeArgs, execDocker })).toThrow(/immutable/);
    expect(execDocker).not.toHaveBeenCalled();
  });
  it('retains the panel default when confirming panel routing', async () => {
    boundary.capture.mockReset().mockResolvedValue(reply());
    await confirmProxyRouting(routes);
    expect(boundary.capture.mock.calls.map(args => args[1][1])).toEqual(['ninedeploy-traefik', 'ninedeploy-traefik']);
  });

  it('confirms both HTTP and HTTPS against the observed immutable node proxy', async () => {
    boundary.capture.mockReset().mockResolvedValue(reply());
    const execDocker = vi.fn(async () => ({ stdout: reply(), stderr: '' })), proxyId = 'a'.repeat(64);
    await confirmServingTrafficRouting(routes, proxyId, { confirmRouting: confirmProxyRouting, probeArgs: routingProbeArgs, execDocker });
    expect(execDocker.mock.calls.map(args => args.slice(0, 2))).toEqual([
      ['docker', routingProbeArgs(proxyId, false)], ['docker', routingProbeArgs(proxyId, true)],
    ]);
    expect(boundary.capture).not.toHaveBeenCalled();
  });
});
