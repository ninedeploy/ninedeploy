import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ssoAdd, ssoAddAction, ssoListAction, ssoRemove, ssoRemoveAction } from '../src/commands/sso.js';

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

interface FakeSso {
  listProviders: ReturnType<typeof vi.fn>;
  addProvider: ReturnType<typeof vi.fn>;
  removeProvider: ReturnType<typeof vi.fn>;
}

function newClient(): { sso: FakeSso } {
  return { sso: { listProviders: vi.fn(), addProvider: vi.fn(), removeProvider: vi.fn() } };
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

describe('sso list', () => {
  it('prints a hint when no providers are configured', async () => {
    const client = newClient();
    (client.sso.listProviders as ReturnType<typeof vi.fn>).mockResolvedValue({ providers: [] });
    await ssoListAction(client as never);
    expect(h.infoSpy).toHaveBeenCalledWith(expect.stringMatching(/No SSO providers/));
  });

  it('prints each provider as `#<id>  <name>  (<type>)`', async () => {
    const client = newClient();
    (client.sso.listProviders as ReturnType<typeof vi.fn>).mockResolvedValue({
      providers: [
        { id: 1, type: 'oidc', name: 'corp', createdAt: '2026-08-29T00:00:00.000Z' },
        { id: 2, type: 'saml', name: 'school', createdAt: '2026-08-29T00:00:00.000Z' },
      ],
    });
    await ssoListAction(client as never);
    const printed = h.infoSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('#1  corp  (oidc)');
    expect(printed).toContain('#2  school  (saml)');
  });

  it('surfaces a thrown error and sets exitCode=1', async () => {
    const client = newClient();
    (client.sso.listProviders as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
    await ssoListAction(client as never);
    expect(h.errorSpy).toHaveBeenCalledWith('db down');
    expect(process.exitCode).toBe(1);
  });
});

describe('sso add', () => {
  it('forwards (type, name, config) to the SDK', async () => {
    const client = newClient();
    (client.sso.addProvider as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, id: 5 });
    const result = await ssoAdd(client as never, 'oidc', 'corp', { issuer: 'https://idp' });
    expect(result.ok).toBe(true);
    expect(client.sso.addProvider).toHaveBeenCalledWith({ type: 'oidc', name: 'corp', config: { issuer: 'https://idp' } });
  });

  it('prints a success line on the happy path', async () => {
    const client = newClient();
    (client.sso.addProvider as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, id: 5 });
    await ssoAddAction(client as never, 'oidc', 'corp', { issuer: 'https://idp' });
    expect(h.successSpy).toHaveBeenCalledWith('Added SSO provider "corp" (id=5)');
  });

  it('refuses an unknown type and sets exitCode=1', async () => {
    const client = newClient();
    await ssoAddAction(client as never, 'magic', 'corp', {});
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Usage:/));
    expect(process.exitCode).toBe(1);
  });

  it('surfaces a thrown error and sets exitCode=1', async () => {
    const client = newClient();
    (client.sso.addProvider as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
    await ssoAddAction(client as never, 'oidc', 'corp', {});
    expect(h.errorSpy).toHaveBeenCalledWith('db down');
    expect(process.exitCode).toBe(1);
  });
});

describe('sso remove', () => {
  it('forwards the id to the SDK', async () => {
    const client = newClient();
    (client.sso.removeProvider as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const result = await ssoRemove(client as never, 5);
    expect(result.ok).toBe(true);
    expect(client.sso.removeProvider).toHaveBeenCalledWith(5);
  });

  it('prints a success line on the happy path', async () => {
    const client = newClient();
    (client.sso.removeProvider as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    await ssoRemoveAction(client as never, '5');
    expect(h.successSpy).toHaveBeenCalledWith('Removed SSO provider #5');
  });

  it('refuses a non-numeric id and sets exitCode=1', async () => {
    const client = newClient();
    await ssoRemoveAction(client as never, 'abc');
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Usage:/));
    expect(process.exitCode).toBe(1);
  });
});
