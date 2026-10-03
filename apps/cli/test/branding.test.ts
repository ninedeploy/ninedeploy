import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brandingGet, brandingGetAction, brandingSet, brandingSetAction } from '../src/commands/branding.js';

const h = vi.hoisted(() => ({
  errorSpy: vi.fn(),
  infoSpy: vi.fn(),
  successSpy: vi.fn(),
  headerSpy: vi.fn(),
}));

vi.mock('../src/lib/format.js', () => ({
  error: h.errorSpy,
  header: h.headerSpy,
  info: h.infoSpy,
  success: h.successSpy,
}));

interface FakeBranding {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

function newClient(): { branding: FakeBranding } {
  return {
    branding: { get: vi.fn(), set: vi.fn() },
  };
}

let savedExitCode: number | undefined;
beforeEach(() => {
  savedExitCode = process.exitCode;
  process.exitCode = 0;
  h.errorSpy.mockReset();
  h.infoSpy.mockReset();
  h.successSpy.mockReset();
  h.headerSpy.mockReset();
});
afterEach(() => {
  process.exitCode = savedExitCode;
});

describe('branding get', () => {
  it('delegates to client.branding.get', async () => {
    const client = newClient();
    (client.branding.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      logoUrl: 'https://cdn.example.com/logo.svg',
      primaryColor: '#1d4ed8',
      supportEmail: null,
      footerHtml: null,
    });
    const result = await brandingGet(client as never);
    expect(result.logoUrl).toMatch(/^https:/);
    expect(result.primaryColor).toBe('#1d4ed8');
    expect(client.branding.get).toHaveBeenCalledOnce();
  });

  it('prints every field, falling back to "(default)" for nulls', async () => {
    const client = newClient();
    (client.branding.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      logoUrl: 'https://cdn.example.com/logo.svg',
      primaryColor: null,
      supportEmail: null,
      footerHtml: '<p>Footer</p>',
    });
    await brandingGetAction(client as never);
    expect(h.headerSpy).toHaveBeenCalledWith('Branding');
    const printed = h.infoSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('https://cdn.example.com/logo.svg');
    expect(printed).toContain('(default)');
    // The exact length is implementation-defined; we just need to
    // assert the format `<n> chars` is present.
    expect(printed).toMatch(/\d+ chars/);
    expect(process.exitCode).toBe(0);
  });

  it('surfaces a thrown error and sets exitCode=1', async () => {
    const client = newClient();
    (client.branding.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('server down'));
    await brandingGetAction(client as never);
    expect(h.errorSpy).toHaveBeenCalledWith('server down');
    expect(process.exitCode).toBe(1);
  });

  it('falls back to String() when a non-Error is rejected', async () => {
    const client = newClient();
    (client.branding.get as ReturnType<typeof vi.fn>).mockRejectedValue('plain failure');
    await brandingGetAction(client as never);
    expect(h.errorSpy).toHaveBeenCalledWith('plain failure');
    expect(process.exitCode).toBe(1);
  });
});

describe('branding set', () => {
  it('refuses when no fields are supplied', async () => {
    const client = newClient();
    await expect(brandingSet(client as never, {})).rejects.toThrow(/At least one/);
    expect(client.branding.set).not.toHaveBeenCalled();
  });

  it('forwards the supplied fields to the SDK', async () => {
    const client = newClient();
    (client.branding.set as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const result = await brandingSet(client as never, { primaryColor: '#1d4ed8', supportEmail: 'ops@example.com' });
    expect(result.ok).toBe(true);
    expect(client.branding.set).toHaveBeenCalledWith({ primaryColor: '#1d4ed8', supportEmail: 'ops@example.com' });
  });

  it('prints a success line listing the fields that were updated', async () => {
    const client = newClient();
    (client.branding.set as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    await brandingSetAction(client as never, { logoUrl: 'https://cdn.example.com/x.svg' });
    expect(h.headerSpy).toHaveBeenCalledWith('Branding set');
    expect(h.successSpy).toHaveBeenCalledWith('Branding updated (logoUrl)');
    expect(process.exitCode).toBe(0);
  });

  it('surfaces a thrown error and sets exitCode=1', async () => {
    const client = newClient();
    (client.branding.set as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('denied'));
    await brandingSetAction(client as never, { primaryColor: '#1d4ed8' });
    expect(h.errorSpy).toHaveBeenCalledWith('denied');
    expect(process.exitCode).toBe(1);
  });
});
