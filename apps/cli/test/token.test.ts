import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenCreateAction, tokenListAction } from '../src/commands/token.js';

const h = vi.hoisted(() => {
  class NineDeployError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    NineDeployError,
    getClient: vi.fn(),
    prompt: vi.fn(),
  };
});

vi.mock('@ninedeploy/sdk', () => ({ NineDeployError: h.NineDeployError }));
vi.mock('../src/client.js', () => ({ getClient: h.getClient }));
vi.mock('../src/prompts.js', () => ({ prompt: h.prompt }));

let logSpy: ReturnType<typeof vi.spyOn>;
let tableSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function clientWithTokens(tokens: { create?: ReturnType<typeof vi.fn>; list?: ReturnType<typeof vi.fn> }) {
  h.getClient.mockReturnValue({ auth: { tokens } });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = 0;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  tableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  h.prompt.mockResolvedValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tokenCreateAction', () => {
  it('creates a token with the default name and prints the raw token once', async () => {
    const create = vi.fn().mockResolvedValue({ id: 7, name: 'ci', token: 'raw-secret', scopes: ['write'] });
    clientWithTokens({ create });
    // Two prompts now: the name, then the scope list.
    h.prompt.mockResolvedValueOnce('').mockResolvedValueOnce('write');

    await tokenCreateAction();

    expect(h.prompt).toHaveBeenCalledWith('Token name', 'ci');
    expect(create).toHaveBeenCalledWith({ name: 'ci', scopes: ['write'] });
    expect(logSpy).toHaveBeenCalledWith('✓ Token "ci" created (id: 7).');
    expect(logSpy).toHaveBeenCalledWith('  Scopes: write');
    expect(logSpy).toHaveBeenCalledWith('  This token is shown ONCE — store it securely:');
    expect(logSpy).toHaveBeenCalledWith('  raw-secret');
    expect(logSpy).toHaveBeenCalledWith('  Use it as: Authorization: Bearer <token>');
    expect(process.exitCode).toBe(0);
  });

  it('uses an explicit token name when provided', async () => {
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'deploy', token: 's', scopes: ['read'] });
    clientWithTokens({ create });
    h.prompt.mockResolvedValueOnce('deploy').mockResolvedValueOnce('read');

    await tokenCreateAction();

    expect(create).toHaveBeenCalledWith({ name: 'deploy', scopes: ['read'] });
  });

  it('omits scopes on a blank answer so the server applies its read-only default', async () => {
    // r090: the server refuses an explicit `[]` — it would be stored as a
    // legacy unrestricted token. Blank must never mean "unrestricted" again.
    const create = vi.fn().mockResolvedValue({ id: 2, name: 'plain', token: 's', scopes: ['read'] });
    clientWithTokens({ create });
    h.prompt.mockResolvedValueOnce('plain').mockResolvedValueOnce('');

    await tokenCreateAction();

    expect(create).toHaveBeenCalledWith({ name: 'plain' });
    expect(logSpy).toHaveBeenCalledWith('  Scopes: read');
  });

  it('drops scope values outside the vocabulary rather than widening the token', async () => {
    const create = vi.fn().mockResolvedValue({ id: 3, name: 'x', token: 's', scopes: ['read'] });
    clientWithTokens({ create });
    h.prompt.mockResolvedValueOnce('x').mockResolvedValueOnce('read, root, ADMIN');

    await tokenCreateAction();

    expect(create).toHaveBeenCalledWith({ name: 'x', scopes: ['read'] });
  });

  it('reports a NineDeployError', async () => {
    const create = vi.fn().mockRejectedValue(new h.NineDeployError(401, 'unauthorized'));
    clientWithTokens({ create });

    await tokenCreateAction();

    expect(errorSpy).toHaveBeenCalledWith('✗ Could not create token:', 'unauthorized');
    expect(process.exitCode).toBe(1);
  });

  it('reports a generic Error', async () => {
    const create = vi.fn().mockRejectedValue(new Error('network down'));
    clientWithTokens({ create });

    await tokenCreateAction();

    expect(errorSpy).toHaveBeenCalledWith('✗ Could not create token:', 'network down');
    expect(process.exitCode).toBe(1);
  });

  it('reports a non-Error rejection', async () => {
    const create = vi.fn().mockRejectedValue('boom');
    clientWithTokens({ create });

    await tokenCreateAction();

    expect(errorSpy).toHaveBeenCalledWith('✗ Could not create token:', 'boom');
    expect(process.exitCode).toBe(1);
  });
});

describe('tokenListAction', () => {
  it('prints a notice when there are no tokens', async () => {
    clientWithTokens({ list: vi.fn().mockResolvedValue([]) });

    await tokenListAction();

    expect(logSpy).toHaveBeenCalledWith('No API tokens.');
    expect(tableSpy).not.toHaveBeenCalled();
  });

  it('tables the tokens, defaulting lastUsed to never', async () => {
    const list = vi.fn().mockResolvedValue([
      { id: 1, name: 'ci', scopes: [], lastUsedAt: null, expiresAt: null, createdAt: '2026-01-01T00:00:00Z' },
      {
        id: 2,
        name: 'deploy',
        scopes: ['read', 'write'],
        lastUsedAt: '2026-02-01T00:00:00Z',
        expiresAt: '2026-06-01T00:00:00Z',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);
    clientWithTokens({ list });

    await tokenListAction();

    expect(tableSpy).toHaveBeenCalledWith([
      // An empty scope list is a pre-0.3.5 token with the owner's full
      // authority — the listing names that rather than showing a blank cell.
      { id: 1, name: 'ci', scopes: 'unrestricted', lastUsed: 'never', expires: 'never', created: '2026-01-01T00:00:00Z' },
      {
        id: 2,
        name: 'deploy',
        scopes: 'read,write',
        lastUsed: '2026-02-01T00:00:00Z',
        expires: '2026-06-01T00:00:00Z',
        created: '2026-01-01T00:00:00Z',
      },
    ]);
  });
});
