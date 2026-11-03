import { describe, expect, it } from 'vitest';
import { persistentPortFingerprint, persistentPortForwardRules, persistentPortRules, renderPersistentPortNft, type PersistentPortNftSpec } from '../../src/lib/persistentPortNft.js';

const spec: PersistentPortNftSpec = { serviceId: 1, owner: 'a'.repeat(32), revision: 1, mark: 0x4e440001,
  target: { id: 'b'.repeat(64), ipv4: '172.29.0.2' }, bindings: [
    { hostIp: '10.6.6.9', hostPort: 5060, containerPort: 5060, protocol: 'tcp' },
    { hostIp: '10.6.6.9', hostPort: 5060, containerPort: 5060, protocol: 'udp' },
    { hostIp: '10.6.6.9', hostPort: 10000, hostPortEnd: 10100, containerPort: 20000, protocol: 'udp' },
    { hostIp: '10.6.6.9', hostPort: 3478, containerPort: 3478, protocol: 'udp' },
  ] };

describe('source-preserving persistent ingress rules', () => {
  it('maps every RTP port by offset and keeps TCP and UDP on 5060 distinct', () => {
    const rules = persistentPortRules(spec);
    expect(rules).toHaveLength(104);
    expect(rules).toContainEqual({ ip: '10.6.6.9', protocol: 'udp', hostPort: 10100, containerPort: 20100 });
    expect(rules.filter(r => r.hostPort === 5060).map(r => r.protocol).sort()).toEqual(['tcp', 'udp']);
  });
  it('limits publication to the claimed destination and never rewrites client source addresses', () => {
    const text = renderPersistentPortNft(spec, true);
    expect(text).toMatch(/^delete table ip ndpi_s1\ntable ip ndpi_s1/);
    expect(text).toContain('hook prerouting priority -101'); expect(text).toContain('hook output priority -101');
    expect(text).toContain('ip daddr 10.6.6.9 udp dport 10100 ct mark set 0x4e440001 dnat to 172.29.0.2:20100');
    expect(text).not.toMatch(/snat|masquerade|flush ruleset/i);
  });
  it('binds fingerprints to immutable target, owner and revision', () => {
    for (const change of [{ owner: 'c'.repeat(32) }, { revision: 2 }, { target: { id: 'c'.repeat(64), ipv4: '172.29.0.3' } }]) {
      expect(persistentPortFingerprint({ ...spec, ...change })).not.toBe(persistentPortFingerprint(spec));
    }
  });
  it('keeps the fingerprint stable across equivalent target property order', () => {
    expect(persistentPortFingerprint({ ...spec, target: { ipv4: spec.target.ipv4, id: spec.target.id } })).toBe(persistentPortFingerprint(spec));
  });
  it('retains old and new forwarding only for the marked original service endpoint', () => {
    const rules = persistentPortForwardRules(spec, [spec.target, { id: 'c'.repeat(64), ipv4: '172.29.0.3' }]);
    expect(rules).toHaveLength(208);
    expect(rules[0]).toEqual(expect.arrayContaining(['--mark', '0x4e440001', '--ctorigdst', '10.6.6.9', '--ctorigdstport']));
  });
  it.each([
    { ...spec, serviceId: -1 }, { ...spec, owner: 'bad; flush ruleset' }, { ...spec, target: { ...spec.target, ipv4: '0.0.0.0' } },
    { ...spec, bindings: [{ ...spec.bindings[0]!, hostIp: '10.6.6.9;flush ruleset' }] },
    { ...spec, bindings: [{ ...spec.bindings[0]!, hostPortEnd: 5059 }] },
    { ...spec, bindings: [{ ...spec.bindings[0]!, hostPortEnd: 6060 }] },
    { ...spec, bindings: [spec.bindings[0]!, spec.bindings[0]!] },
    { ...spec, bindings: [{ ...spec.bindings[0]!, allowFrom: ['10.0.0.0/8'] }] },
  ])('refuses an unsafe or unsupported rule set before generating commands', invalid => {
    expect(() => renderPersistentPortNft(invalid)).toThrow();
  });
});
