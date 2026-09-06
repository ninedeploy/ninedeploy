import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { EgressBlockedError } from '../../src/lib/egressGuard.js';
import { assertCloneTargetAllowed } from '../../src/lib/gitEgress.js';

const h = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: h.lookup }));

afterEach(() => {
  delete process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
  vi.clearAllMocks();
});

describe('assertCloneTargetAllowed (git SSRF gate)', () => {
  it('blocks https remotes aimed at the metadata service / loopback', async () => {
    await expect(assertCloneTargetAllowed('https://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    await expect(assertCloneTargetAllowed('http://127.0.0.1:3000/admin')).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('blocks ssh remotes whose host is a private literal', async () => {
    await expect(
      assertCloneTargetAllowed('ssh://deploy@10.1.2.3:2222/srv/repo.git'),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('blocks scp-style git remotes on private hosts', async () => {
    await expect(assertCloneTargetAllowed('git@192.168.1.10:nine/app.git')).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
  });

  it('allows https remotes whose DNS answers are public', async () => {
    h.lookup.mockResolvedValue([{ address: '140.82.121.4' }, { address: '2606:50c0:8000::153' }]);
    await expect(assertCloneTargetAllowed('https://github.com/acme/app.git')).resolves.toBeUndefined();
    expect(h.lookup).toHaveBeenCalledWith('github.com', { all: true });
  });

  it('blocks ssh remotes when ANY DNS answer is private (mixed answers)', async () => {
    h.lookup.mockResolvedValue([{ address: '140.82.121.4' }, { address: '172.16.0.9' }]);
    await expect(assertCloneTargetAllowed('ssh://git@git.corp.example/team/app.git')).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
  });

  it('lets unknown-scheme shapes pass untouched (the URL schema owns them)', async () => {
    await expect(assertCloneTargetAllowed('not a url at all')).resolves.toBeUndefined();
  });

  it('blocks git:// remotes aimed at the cloud metadata service (SSRF guard)', async () => {
    // git:// (Git protocol, port 9418) to 169.254.169.254 reaches the instance
    // metadata service and can leak IAM credentials and instance metadata.
    await expect(assertCloneTargetAllowed('git://169.254.169.254/team/repo')).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
  });

  it('blocks git:// remotes on private LAN addresses (SSRF guard)', async () => {
    await expect(assertCloneTargetAllowed('git://10.0.0.5/team/repo.git')).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    await expect(assertCloneTargetAllowed('git://192.168.1.100/repo.git')).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
  });

  it('blocks git:// remotes on localhost (SSRF guard)', async () => {
    await expect(assertCloneTargetAllowed('git://localhost/team/repo.git')).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
  });

  it('allows git:// remotes when the host resolves to a public address', async () => {
    h.lookup.mockResolvedValue([{ address: '140.82.121.4' }, { address: '2606:50c0:8000::153' }]);
    await expect(assertCloneTargetAllowed('git://github.com/owner/repo.git')).resolves.toBeUndefined();
  });

  it('is disabled by NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1 (self-hosted LAN remotes)', async () => {
    process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = '1';
    // No DNS lookup needed — the escape hatch short-circuits before parsing.
    await expect(assertCloneTargetAllowed('http://169.254.169.254/latest/meta-data/')).resolves.toBeUndefined();
    expect(h.lookup).not.toHaveBeenCalled();
  });
});

// Silence unused-import lint on node:test-less environments.
afterAll(() => undefined);
