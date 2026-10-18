import { describe, expect, it } from 'vitest';
import { parseRunSpec, runSpecArgv, runSpecOps } from '../src/agentOps/runSpec.js';

/**
 * 0.16.1 `docker.ports` on the agent: `docker.runSpec` takes `ports`, each
 * operand only in the canonical form the panel sends (parsed and re-formatted
 * here), never on the node's own listeners, never overlapping or over the
 * port budget; the argv gets one `-p` per operand.
 */

const base = { name: 'game-5', image: 'game/server:1' };
const env = { NINEDEPLOY_AGENT_PORT: '4700' } as NodeJS.ProcessEnv;

describe('docker.runSpec ports', () => {
  it('declares docker.ports beside docker.runSpec', () => {
    expect(runSpecOps.caps).toEqual(['docker.runSpec', 'docker.ports']);
  });

  it('publishes each canonical operand after the other flags', () => {
    const spec = parseRunSpec({ ...base, publish: '8080:3000', ports: ['27015-27030:27015-27030/udp', '203.0.113.7:53:53/udp', '[2001:db8::7]:8443:443/tcp'] }, env);
    expect(spec.ports).toEqual(['27015-27030:27015-27030/udp', '203.0.113.7:53:53/udp', '[2001:db8::7]:8443:443/tcp']);
    const argv = runSpecArgv(spec, 'run');
    expect(argv.slice(argv.indexOf('8080:3000') - 1, argv.indexOf('game/server:1'))).toEqual([
      '-p', '8080:3000', '-p', '27015-27030:27015-27030/udp', '-p', '203.0.113.7:53:53/udp', '-p', '[2001:db8::7]:8443:443/tcp',
    ]);
    expect(parseRunSpec(base, env).ports).toEqual([]);
  });

  it.each([
    ['a non-canonical form', ['27015-27030/udp']],
    ['a missing protocol', ['8080:80']],
    ['an extra flag', ['8080:80/tcp --privileged']],
    ['a non-string', [8080]],
    ['the unspecified address', ['0.0.0.0:80:80/tcp']],
  ])('refuses %s', (_what, ports) => {
    expect(() => parseRunSpec({ ...base, ports }, env)).toThrow(/Invalid port mapping/);
  });

  it("refuses the node's own listeners, overlaps, too many rules and a non-list", () => {
    for (const port of ['22:22/tcp', '440-450:440-450/udp', '4700:4700/tcp']) {
      expect(() => parseRunSpec({ ...base, ports: [port] }, env), port).toThrow(/reserved on this node/);
    }
    expect(() => parseRunSpec({ ...base, ports: ['9000:9000/udp', '8990-9010:8990-9010/udp'] }, env)).toThrow(/overlapping/);
    expect(() => parseRunSpec({ ...base, ports: ['10000-11000:10000-11000/udp'] }, env)).toThrow(/over the port budget/);
    expect(() => parseRunSpec({ ...base, ports: Array.from({ length: 21 }, (_, i) => `${20000 + i}:80/tcp`) }, env)).toThrow(/Invalid ports/);
    expect(() => parseRunSpec({ ...base, ports: '9000:9000/udp' }, env)).toThrow(/Invalid ports/);
  });

  it('the agent port defaults to 4600', () => {
    expect(() => parseRunSpec({ ...base, ports: ['4600:4600/tcp'] }, {} as NodeJS.ProcessEnv)).toThrow(/reserved/);
  });
});
