import { describe, expect, it } from 'vitest';
import { cloudServer, hetznerOptions, hetznerServerCreate, hetznerStatus, hetznerTokenInput } from '../src/cloud.js';

describe('Hetzner Cloud contracts', () => {
  it('validates tokens and never includes one in status', () => {
    expect(hetznerTokenInput.parse({ token: ` ${'a'.repeat(32)} ` }).token).toBe('a'.repeat(32));
    expect(hetznerTokenInput.safeParse({ token: 'short' }).success).toBe(false);
    expect(hetznerTokenInput.safeParse({ token: '!'.repeat(32) }).success).toBe(false);
    expect(hetznerStatus.parse({ configured: true, tokenHint: 'abcd', token: 'secret' })).toEqual({ configured: true, tokenHint: 'abcd' });
  });
  it('sets safe defaults and rejects invalid hostnames, ports and SSH keys', () => {
    const input = { name: 'worker-1', location: 'fsn1', serverType: 'cx22', image: 'ubuntu-24.04' };
    expect(hetznerServerCreate.parse(input)).toEqual({ ...input, sshKeyIds: [], agentPort: 4600 });
    for (const change of [{ name: '-bad' }, { location: '../etc' }, { serverType: '!' }, { image: '' }, { agentPort: 22 }, { sshKeyIds: [0] }]) {
      expect(hetznerServerCreate.safeParse({ ...input, ...change }).success).toBe(false);
    }
  });
  it('validates provider options and node status views', () => {
    const options = { locations: [{ name: 'fsn1', city: 'Falkenstein', country: 'DE' }], serverTypes: [{ name: 'cx22', description: 'x', cores: 2, memoryGb: 4, diskGb: 40, architecture: 'x86', locations: ['fsn1'] }], images: [{ name: 'ubuntu-24.04', description: 'Ubuntu', architecture: 'x86' }], sshKeys: [{ id: 1, name: 'key', fingerprint: 'fp' }] };
    expect(hetznerOptions.parse(options)).toEqual(options);
    const server = { serverId: 1, name: 'worker', provider: 'hetzner', providerServerId: 2, location: 'fsn1', serverType: 'cx22', image: 'ubuntu', ipv4: '192.0.2.1', providerStatus: null, nodeStatus: 'offline', createdAt: 'now' };
    expect(cloudServer.parse(server)).toEqual(server);
    expect(cloudServer.safeParse({ ...server, provider: 'other' }).success).toBe(false);
  });
});
