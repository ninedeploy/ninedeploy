import { describe, expect, it } from 'vitest';
import { cloudServer, hetznerOptions, hetznerServerCreate, hetznerStatus, hetznerTokenInput, vultrOptions, vultrServerCreate, vultrStatus, vultrTokenInput } from '../src/cloud.js';

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

describe('Vultr contracts', () => {
  it('validates the API key, the create input and the options', () => {
    expect(vultrTokenInput.parse({ token: 'A'.repeat(36) }).token).toBe('A'.repeat(36));
    expect(vultrTokenInput.safeParse({ token: 'A-'.repeat(18) }).success).toBe(false);
    const input = { name: 'edge-1', region: 'ams', plan: 'vc2-1c-1gb', osId: 2284 };
    expect(vultrServerCreate.parse(input)).toEqual({ ...input, sshKeyIds: [], agentPort: 4600 });
    const key = '3b8066a7-b438-455a-9688-44afc9a3597f';
    expect(vultrServerCreate.parse({ ...input, sshKeyIds: [key] }).sshKeyIds).toEqual([key]);
    for (const change of [{ osId: 0 }, { osId: 1.5 }, { sshKeyIds: ['7'] }, { plan: 'A' }, { name: 'a_b' }]) {
      expect(vultrServerCreate.safeParse({ ...input, ...change }).success).toBe(false);
    }
    const options = { regions: [{ id: 'ams', city: 'Amsterdam', country: 'NL' }], plans: [{ id: 'vc2-1c-1gb', vcpus: 1, memoryGb: 1, diskGb: 25, priceMonthly: 5, regions: ['ams'] }], images: [{ id: 2284, name: 'Ubuntu 24.04 LTS x64', family: 'ubuntu' }], sshKeys: [{ id: key, name: 'laptop' }] };
    expect(vultrOptions.parse(options)).toEqual(options);
    expect(vultrStatus).toBe(hetznerStatus);
  });
  it('a Vultr node row carries its UUID', () => {
    const server = { serverId: 1, name: 'edge', provider: 'vultr', providerServerId: 'cb676a46-66fd-4dfb-b839-443f2e6c0b60', location: 'ams', serverType: 'vc2-1c-1gb', image: 'Ubuntu', ipv4: '192.0.2.1', providerStatus: 'active', nodeStatus: 'online', createdAt: 'now' };
    expect(cloudServer.parse(server)).toEqual(server);
  });
});
