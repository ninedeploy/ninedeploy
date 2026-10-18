import { describe, expect, it } from 'vitest';
import {
  formatPortMapping,
  healthCheckMode,
  isBindableIp,
  mappedPortCount,
  parsePortMapping,
  portMappings,
  portMappingsOverlap,
  portMappingsProblem,
  redirectRegexProblem,
  redirectRule,
} from '../src/index.js';

/** 0.16.1 port mappings (UDP, ranges, a host IP, allow lists), bindable IPs and redirect regexes. */

describe('isBindableIp', () => {
  it.each([
    ['203.0.113.7', true],
    ['0.0.0.0', false],
    ['01.2.3.4', false],
    ['256.1.1.1', false],
    ['::1', true],
    ['2001:db8::7', true],
    ['1:2:3:4:5:6:7:8', true],
    ['::ffff:192.0.2.1', true],
    ['1:2:3:4:5:6:192.0.2.1', true],
    ['::', false],
    ['0::0', false],
    ['0:0:0:0:0:0:0:0', false],
    ['1:2:3:4:5:6:7:8:9', false],
    ['1:2:3:4:5:6:7', false],
    ['1::2:3:4:5:6:7:8', false],
    ['1::2::3', false],
    ['fe80::1%eth0', false],
    ['10.0.0.0/8', false],
    ['g::1', false],
    ['host', false],
    [`${'1:'.repeat(23)}1`, false],
  ])('%s → %s', (ip, ok) => {
    expect(isBindableIp(ip)).toBe(ok);
  });
});

describe('portMappingsOverlap', () => {
  const a = { hostPort: 100, hostPortEnd: 110, containerPort: 100 };
  it('needs the same protocol (tcp by default), the same or an unset IP, and overlapping ports', () => {
    expect(portMappingsOverlap(a, { hostPort: 105, containerPort: 1 })).toBe(true);
    expect(portMappingsOverlap(a, { hostPort: 105, containerPort: 1, protocol: 'udp' })).toBe(false);
    expect(portMappingsOverlap({ ...a, protocol: 'udp' }, { hostPort: 105, containerPort: 1, protocol: 'udp' })).toBe(true);
    expect(portMappingsOverlap({ ...a, hostIp: '203.0.113.7' }, { hostPort: 105, containerPort: 1, hostIp: '203.0.113.8' })).toBe(false);
    expect(portMappingsOverlap({ ...a, hostIp: '2001:DB8::7' }, { hostPort: 105, containerPort: 1, hostIp: '2001:db8::7' })).toBe(true);
    expect(portMappingsOverlap({ ...a, hostIp: '203.0.113.7' }, { hostPort: 105, containerPort: 1 })).toBe(true);
    expect(portMappingsOverlap(a, { hostPort: 111, containerPort: 1 })).toBe(false);
    expect(portMappingsOverlap({ hostPort: 120, containerPort: 1 }, a)).toBe(false);
  });
});

describe('portMappingsProblem', () => {
  it('accepts a valid list and counts ranges', () => {
    expect(portMappingsProblem([{ hostPort: 27015, hostPortEnd: 27030, containerPort: 27015, protocol: 'udp' }, { hostPort: 5432, containerPort: 5432, allowFrom: ['10.0.0.0/8'] }])).toBeNull();
    expect(mappedPortCount({ hostPort: 27015, hostPortEnd: 27030 })).toBe(16);
    expect(mappedPortCount({ hostPort: 80 })).toBe(1);
  });

  it.each([
    ['a range that ends before it starts', [{ hostPort: 10, hostPortEnd: 5, containerPort: 10 }], /ends before it starts/],
    ['a container range past 65535', [{ hostPort: 65000, hostPortEnd: 65010, containerPort: 65530 }], /past 65535/],
    ['an allow list on UDP', [{ hostPort: 53, containerPort: 53, protocol: 'udp' as const, allowFrom: ['10.0.0.0/8'] }], /one TCP port/],
    ['an allow list on a range', [{ hostPort: 6000, hostPortEnd: 6001, containerPort: 6000, allowFrom: ['10.0.0.0/8'] }], /one TCP port/],
    ['an overlap', [{ hostPort: 53, containerPort: 53 }, { hostPort: 50, hostPortEnd: 60, containerPort: 50 }], /overlaps 53:53\/tcp/],
    ['more than 1000 ports', [{ hostPort: 10000, hostPortEnd: 11000, containerPort: 10000 }], /at most 1000/],
  ])('refuses %s', (_what, list, message) => {
    expect(portMappingsProblem(list)).toMatch(message);
  });
});

describe('formatPortMapping', () => {
  it('writes the docker -p operand', () => {
    expect(formatPortMapping({ hostPort: 8080, containerPort: 80 })).toBe('8080:80/tcp');
    expect(formatPortMapping({ hostPort: 27015, hostPortEnd: 27030, containerPort: 27015, protocol: 'udp' })).toBe('27015-27030:27015-27030/udp');
    expect(formatPortMapping({ hostIp: '203.0.113.7', hostPort: 53, containerPort: 5353, protocol: 'udp' })).toBe('203.0.113.7:53:5353/udp');
    expect(formatPortMapping({ hostIp: '2001:db8::7', hostPort: 53, containerPort: 53, protocol: 'udp' })).toBe('[2001:db8::7]:53:53/udp');
  });
});

describe('parsePortMapping', () => {
  it('parses every accepted form', () => {
    expect(parsePortMapping('8080:80')).toEqual({ hostIp: null, hostPort: 8080, hostPortEnd: null, containerPort: 80, protocol: 'tcp' });
    expect(parsePortMapping(' 53/UDP ')).toEqual({ hostIp: null, hostPort: 53, hostPortEnd: null, containerPort: 53, protocol: 'udp' });
    expect(parsePortMapping('27015-27030:27015/udp')).toMatchObject({ hostPortEnd: 27030, containerPort: 27015 });
    expect(parsePortMapping('10-20:30-40')).toMatchObject({ hostPort: 10, hostPortEnd: 20, containerPort: 30 });
    expect(parsePortMapping('5000-5000:6000')).toMatchObject({ hostPortEnd: null });
    expect(parsePortMapping('80:80-80')).toMatchObject({ hostPort: 80, hostPortEnd: null, containerPort: 80 });
    expect(parsePortMapping('203.0.113.7:53/udp')).toMatchObject({ hostIp: '203.0.113.7', hostPort: 53 });
    expect(parsePortMapping('[2001:db8::7]:8080:80')).toMatchObject({ hostIp: '2001:db8::7', containerPort: 80 });
    expect(parsePortMapping('5432@10.0.0.0/8, 203.0.113.4')).toMatchObject({ protocol: 'tcp', allowFrom: ['10.0.0.0/8', '203.0.113.4'] });
  });

  it.each([
    ['a@b@c', /more than one @/],
    ['5432@ , ', /list the addresses after @/],
    ['abc', /not a port mapping/],
    ['1.2.3.453', /not a port mapping/],
    ['0.0.0.0:80', /not an address a port can be bound to/],
    ['[::]:80', /not an address a port can be bound to/],
    ['70000:80', /1 to 65535/],
    ['0:80', /1 to 65535/],
    ['30-20:30', /ends before it starts/],
    ['10-20:30-35', /as long as the host range/],
    ['80:80-81', /as long as the host range/],
  ])('refuses %s', (text, message) => {
    expect(parsePortMapping(text)).toMatch(message);
  });
});

describe('the portMappings field', () => {
  it('runs the list checks', () => {
    expect(portMappings.safeParse([{ hostPort: 53, containerPort: 53, protocol: 'udp' }]).success).toBe(true);
    const twice = portMappings.safeParse([{ hostPort: 53, containerPort: 53 }, { hostPort: 53, containerPort: 53 }]);
    expect(twice.success).toBe(false);
    expect(twice.error?.issues[0]?.message).toMatch(/overlaps/);
  });

  it('healthCheckMode takes http or running', () => {
    expect(healthCheckMode.parse('running')).toBe('running');
    expect(healthCheckMode.safeParse('tcp').success).toBe(false);
  });
});

describe('redirectRegexProblem', () => {
  it('refuses what Go RE2 cannot run, and an invalid regex', () => {
    expect(redirectRegexProblem('^https://a/(.*)')).toBeNull();
    expect(redirectRegexProblem('^https://a/(?!keep)')).toMatch(/lookahead/);
    expect(redirectRegexProblem('(?<=a)b')).toMatch(/lookahead/);
    expect(redirectRegexProblem('(a)\\1')).toMatch(/backreferences/);
    expect(redirectRegexProblem('[a-')).toMatch(/not a valid regular expression/);
  });

  it('the rule schema reports the problem on the regex', () => {
    expect(redirectRule.safeParse({ regex: '^a$', replacement: 'https://b/' }).data).toEqual({ regex: '^a$', replacement: 'https://b/', permanent: false });
    const bad = redirectRule.safeParse({ regex: '(?!x)', replacement: 'https://b/' });
    expect(bad.error?.issues[0]?.path).toEqual(['regex']);
  });
});
