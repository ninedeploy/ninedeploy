import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  certificatesExpiring,
  certificatesList,
} from '../src/commands/certificates.js';

const h = vi.hoisted(() => ({
  errorSpy: vi.fn(),
  headerSpy: vi.fn(),
  infoSpy: vi.fn(),
  tableSpy: vi.fn(),
  spinnerSpy: vi.fn(),
}));

vi.mock('../src/lib/format.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/format.js')>(
    '../src/lib/format.js',
  );
  return {
    ...actual,
    error: h.errorSpy,
    header: h.headerSpy,
    info: h.infoSpy,
    table: h.tableSpy,
    spinner: h.spinnerSpy,
  };
});

interface FakeClient {
  traefik: {
    certificateInventory: ReturnType<typeof vi.fn>;
    expiringCertificates: ReturnType<typeof vi.fn>;
  };
}

function makeClient(): FakeClient {
  return {
    traefik: {
      certificateInventory: vi.fn(),
      expiringCertificates: vi.fn(),
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  h.spinnerSpy.mockImplementation(async (_msg: string, fn: () => Promise<unknown>) => fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('certificatesList', () => {
  it('uses the default 30-day threshold and prints the summary', async () => {
    const client = makeClient();
    client.traefik.certificateInventory.mockResolvedValue({
      summary: {
        total: 2,
        valid: 2,
        expiringSoon: 0,
        expired: 0,
        expiringThresholdDays: 30,
        fetchedAt: '2026-01-01T00:00:00Z',
      },
      certificates: [],
    });
    await certificatesList(client as never);
    expect(client.traefik.certificateInventory).toHaveBeenCalledWith({ threshold: 30 });
    expect(h.headerSpy).toHaveBeenCalledWith('Certificate inventory');
    expect(h.infoSpy).toHaveBeenCalledWith('Total:      2');
    // The Valid/Expiring/Expired lines wrap the number in
    // color codes, so we walk the recorded calls and check the
    // prefixes rather than relying on exact-string matchers.
    const calls = h.infoSpy.mock.calls.flat();
    expect(calls.some((c) => String(c).startsWith('Valid:'))).toBe(true);
    expect(calls.some((c) => String(c).startsWith('Expiring:'))).toBe(true);
    expect(h.infoSpy).toHaveBeenCalledWith('No certificates registered yet.');
  });

  it('forwards --threshold when set', async () => {
    const client = makeClient();
    client.traefik.certificateInventory.mockResolvedValue({
      summary: {
        total: 0,
        valid: 0,
        expiringSoon: 0,
        expired: 0,
        expiringThresholdDays: 7,
        fetchedAt: '2026-01-01T00:00:00Z',
      },
      certificates: [],
    });
    await certificatesList(client as never, { threshold: '7' });
    expect(client.traefik.certificateInventory).toHaveBeenCalledWith({ threshold: 7 });
  });

  it('prints usage + throws when --threshold is non-numeric', async () => {
    const client = makeClient();
    await expect(certificatesList(client as never, { threshold: 'abc' })).rejects.toThrow(
      /Usage: --threshold/,
    );
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Usage/));
    expect(client.traefik.certificateInventory).not.toHaveBeenCalled();
  });

  it('prints the expired count when > 0', async () => {
    const client = makeClient();
    client.traefik.certificateInventory.mockResolvedValue({
      summary: {
        total: 1,
        valid: 0,
        expiringSoon: 0,
        expired: 1,
        expiringThresholdDays: 30,
        fetchedAt: '2026-01-01T00:00:00Z',
      },
      certificates: [],
    });
    await certificatesList(client as never);
    expect(h.infoSpy).toHaveBeenCalledWith(expect.stringMatching(/Expired:.*1/));
  });

  it('renders the per-host table with status colors', async () => {
    const client = makeClient();
    client.traefik.certificateInventory.mockResolvedValue({
      summary: {
        total: 2,
        valid: 1,
        expiringSoon: 1,
        expired: 0,
        expiringThresholdDays: 30,
        fetchedAt: '2026-01-01T00:00:00Z',
      },
      certificates: [
        {
          host: 'a.example.com',
          status: 'valid',
          daysToExpiry: 90,
          notAfter: '2026-04-01T00:00:00Z',
          autoRenew: true,
        },
        {
          host: 'b.example.com',
          status: 'expiring-soon',
          daysToExpiry: 5,
          notAfter: '2026-01-06T00:00:00Z',
          autoRenew: false,
        },
      ],
    });
    await certificatesList(client as never);
    expect(h.tableSpy).toHaveBeenCalled();
    const rows = h.tableSpy.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ host: 'a.example.com', daysToExpiry: '90', autoRenew: 'yes' });
    expect(rows[1]?.host).toBe('b.example.com');
    // The 'no' autoRenew marker is colorized via c.dim, so we
    // match the string against a regex rather than an exact value.
    expect(String(rows[1]?.autoRenew)).toMatch(/no/);
  });

  it('renders "—" placeholders when daysToExpiry / notAfter are missing', async () => {
    const client = makeClient();
    client.traefik.certificateInventory.mockResolvedValue({
      summary: {
        total: 1,
        valid: 0,
        expiringSoon: 0,
        expired: 0,
        expiringThresholdDays: 30,
        fetchedAt: '2026-01-01T00:00:00Z',
      },
      certificates: [
        {
          host: 'unknown.example.com',
          status: 'unknown',
          daysToExpiry: null,
          notAfter: null,
          autoRenew: false,
        },
      ],
    });
    await certificatesList(client as never);
    const rows = h.tableSpy.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(rows[0]?.daysToExpiry).toMatch(/—/);
    expect(rows[0]?.expiresAt).toMatch(/—/);
  });
});

describe('certificatesExpiring', () => {
  it('uses the default 30-day window and prints the count', async () => {
    const client = makeClient();
    client.traefik.expiringCertificates.mockResolvedValue({ count: 0, certificates: [] });
    await certificatesExpiring(client as never);
    expect(client.traefik.expiringCertificates).toHaveBeenCalledWith({ days: 30 });
    expect(h.headerSpy).toHaveBeenCalledWith('Certificates expiring within 30 days');
    expect(h.infoSpy).toHaveBeenCalledWith('Count: 0');
    expect(h.infoSpy).toHaveBeenCalledWith('(none)');
  });

  it('forwards --days when set', async () => {
    const client = makeClient();
    client.traefik.expiringCertificates.mockResolvedValue({ count: 0, certificates: [] });
    await certificatesExpiring(client as never, { days: '7' });
    expect(client.traefik.expiringCertificates).toHaveBeenCalledWith({ days: 7 });
  });

  it('prints usage + throws when --days is non-numeric', async () => {
    const client = makeClient();
    await expect(certificatesExpiring(client as never, { days: 'soon' })).rejects.toThrow(
      /Usage: --days/,
    );
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Usage/));
  });

  it('renders the table when there are expiring certs', async () => {
    const client = makeClient();
    client.traefik.expiringCertificates.mockResolvedValue({
      count: 2,
      certificates: [
        {
          host: 'a.example.com',
          status: 'expiring-soon',
          daysToExpiry: 5,
          notAfter: '2026-01-06T00:00:00Z',
        },
        {
          host: 'b.example.com',
          status: 'expired',
          daysToExpiry: -3,
          notAfter: '2025-12-29T00:00:00Z',
        },
      ],
    });
    await certificatesExpiring(client as never, { days: '7' });
    expect(h.headerSpy).toHaveBeenCalledWith('Certificates expiring within 7 days');
    expect(h.infoSpy).toHaveBeenCalledWith('Count: 2');
    const rows = h.tableSpy.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.host).toBe('a.example.com');
    expect(rows[1]?.host).toBe('b.example.com');
  });

  it('renders "—" placeholders for missing daysToExpiry / notAfter', async () => {
    const client = makeClient();
    client.traefik.expiringCertificates.mockResolvedValue({
      count: 1,
      certificates: [
        {
          host: 'unknown.example.com',
          status: 'unknown',
          daysToExpiry: null,
          notAfter: null,
        },
      ],
    });
    await certificatesExpiring(client as never);
    const rows = h.tableSpy.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(rows[0]?.daysToExpiry).toMatch(/—/);
    expect(rows[0]?.expiresAt).toMatch(/—/);
  });
});
