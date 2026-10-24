import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { routingReplyIsApplied, withRoutingAck } from '../../src/lib/proxyRoutingAck.js';

const routes = 'http:\n  services:\n    app:\n      loadBalancer:\n        servers:\n          - url: http://candidate:80\n';
function reply() {
  const config = (load(withRoutingAck(routes)) as { http: Record<string, Record<string, object>> }).http;
  const body = Object.fromEntries(['routers', 'services', 'middlewares'].map(kind => [kind, Object.fromEntries(Object.entries(config[kind] ?? {}).map(([name, value]) => [name + '@file', { ...value, status: 'enabled' }]))]));
  return { body, header: `HTTP/1.1 200 OK\nX-NineDeploy-Generation: ${createHash('sha256').update(routes).digest('hex')}\n\n` };
}
describe('private routing reply validation', () => {
  it('confirms the generation together with enabled route definitions', () => {
    const { body, header } = reply(); expect(routingReplyIsApplied(routes, header + JSON.stringify(body))).toBe(true);
  });
  it('refuses a valid generation with a changed upstream or disabled service', () => {
    const { body, header } = reply();
    expect(routingReplyIsApplied(routes, header + JSON.stringify(body).replace('candidate:80', 'other:80'))).toBe(false);
    expect(routingReplyIsApplied(routes, header + JSON.stringify(body).replaceAll('enabled', 'disabled'))).toBe(false);
  });
  it('refuses a missing or wrong header, invalid JSON and invalid configuration without leaking the body', () => {
    const { body, header } = reply();
    expect(routingReplyIsApplied(routes, JSON.stringify(body))).toBe(false);
    expect(routingReplyIsApplied(routes, header.replace(/[a-f0-9]{64}/, '0'.repeat(64)) + JSON.stringify(body))).toBe(false);
    expect(routingReplyIsApplied(routes, header + '{private-invalid-body')).toBe(false);
    const invalid = 'http: [';
    expect(routingReplyIsApplied(invalid, `X-NineDeploy-Generation: ${createHash('sha256').update(invalid).digest('hex')}\n{}`)).toBe(false);
  });
});
