import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginAction } from '../src/commands/login.js';

const h = vi.hoisted(() => {
  class NineDeployError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = 'unknown_error') {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    NineDeployError,
    createClient: vi.fn(),
    loadConfig: vi.fn(),
    saveConfig: vi.fn(),
    prompt: vi.fn(),
    promptHidden: vi.fn(),
  };
});

vi.mock('@ninedeploy/sdk', () => ({
  createClient: h.createClient,
  NineDeployError: h.NineDeployError,
}));
vi.mock('../src/config.js', () => ({ loadConfig: h.loadConfig, saveConfig: h.saveConfig }));
vi.mock('../src/prompts.js', () => ({ prompt: h.prompt, promptHidden: h.promptHidden }));
vi.mock('../src/lib/serverRunner.js', () => ({
  normalizeServerUrl: (u: string) => u || 'http://default:3000',
}));

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = 0;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  h.loadConfig.mockReturnValue({ baseUrl: 'http://default:3000' });
  h.prompt.mockResolvedValue('http://srv:3000');
  h.promptHidden.mockResolvedValue('secret-pass');
  h.createClient.mockReturnValue({ auth: { login: vi.fn() } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loginAction', () => {
  it('stores the token and prints the user on success', async () => {
    const login = vi.fn().mockResolvedValue({
      tokens: { accessToken: 'tok123' },
      user: { email: 'a@b.com', isOperator: true },
    });
    h.createClient.mockReturnValue({ auth: { login } });
    h.prompt.mockReset().mockResolvedValueOnce('http://srv:3000').mockResolvedValueOnce('a@b.com');

    await loginAction();

    expect(h.prompt).toHaveBeenNthCalledWith(1, 'Server URL', 'http://default:3000');
    expect(h.prompt).toHaveBeenNthCalledWith(2, 'Email');
    expect(h.promptHidden).toHaveBeenCalledWith('Password');
    expect(h.createClient).toHaveBeenCalledWith({ baseUrl: 'http://srv:3000' });
    expect(login).toHaveBeenCalledWith({ email: 'a@b.com', password: 'secret-pass' });
    expect(h.saveConfig).toHaveBeenCalledWith({ baseUrl: 'http://srv:3000', token: 'tok123' });
    expect(logSpy).toHaveBeenCalledWith('✓ Logged in as a@b.com (operator)');
    expect(process.exitCode).toBe(0);
  });

  it('labels a session without an operator seat as a member', async () => {
    const login = vi.fn().mockResolvedValue({
      tokens: { accessToken: 'tok123' },
      user: { email: 'dev@b.com', isOperator: false },
    });
    h.createClient.mockReturnValue({ auth: { login } });
    h.prompt.mockReset().mockResolvedValueOnce('http://srv:3000').mockResolvedValueOnce('dev@b.com');

    await loginAction();

    expect(logSpy).toHaveBeenCalledWith('✓ Logged in as dev@b.com (member)');
  });

  it('rejects an empty email', async () => {
    h.prompt.mockReset().mockResolvedValueOnce('http://srv:3000').mockResolvedValueOnce('');

    await loginAction();

    expect(errorSpy).toHaveBeenCalledWith('Email is required.');
    expect(process.exitCode).toBe(1);
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.saveConfig).not.toHaveBeenCalled();
  });

  it('rejects an empty password', async () => {
    h.promptHidden.mockResolvedValue('');

    await loginAction();

    expect(errorSpy).toHaveBeenCalledWith('Password is required.');
    expect(process.exitCode).toBe(1);
    expect(h.saveConfig).not.toHaveBeenCalled();
  });

  it('prints the server error for a NineDeployError', async () => {
    const login = vi.fn().mockRejectedValue(new h.NineDeployError(401, 'unauthorized'));
    h.createClient.mockReturnValue({ auth: { login } });

    await loginAction();

    expect(errorSpy).toHaveBeenCalledWith('✗ Login failed (401): unauthorized');
    expect(process.exitCode).toBe(1);
  });

  it('prints the message for a generic Error', async () => {
    const login = vi.fn().mockRejectedValue(new Error('network down'));
    h.createClient.mockReturnValue({ auth: { login } });

    await loginAction();

    expect(errorSpy).toHaveBeenCalledWith('✗ Login failed:', 'network down');
    expect(process.exitCode).toBe(1);
  });

  it('prints the raw value for a non-Error rejection', async () => {
    const login = vi.fn().mockRejectedValue('boom');
    h.createClient.mockReturnValue({ auth: { login } });

    await loginAction();

    expect(errorSpy).toHaveBeenCalledWith('✗ Login failed:', 'boom');
    expect(process.exitCode).toBe(1);
  });

  it('prints connection guidance when server is unreachable', async () => {
    const login = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3000'));
    h.createClient.mockReturnValue({ auth: { login } });

    await loginAction();

    expect(errorSpy).toHaveBeenCalledWith('✗ Login failed:', 'connect ECONNREFUSED 127.0.0.1:3000');
    expect(errorSpy).toHaveBeenCalledWith('  Could not reach NineDeploy server at http://srv:3000. Check your URL or ensure the server is running.');
    expect(process.exitCode).toBe(1);
  });
});

describe('r197: two-factor login', () => {
  it('prompts for the TOTP code and retries with it', async () => {
    const login = vi
      .fn()
      .mockRejectedValueOnce(new h.NineDeployError(401, 'Two-factor code required', 'totp_required'))
      .mockResolvedValueOnce({
        tokens: { accessToken: 'a', refreshToken: 'r' },
        user: { email: 'op@x.io', isOperator: true },
      });
    h.createClient.mockReturnValue({ auth: { login } });
    h.prompt.mockResolvedValueOnce('http://srv').mockResolvedValueOnce('op@x.io').mockResolvedValueOnce('123456');
    h.promptHidden.mockResolvedValueOnce('pw');
    await loginAction();
    expect(login).toHaveBeenLastCalledWith({ email: 'op@x.io', password: 'pw', totpCode: '123456' });
    expect(h.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ token: 'a', refreshToken: 'r' }));
    expect(process.exitCode).toBe(0);
  });

  it('gives up cleanly on a blank code', async () => {
    const login = vi.fn().mockRejectedValueOnce(new h.NineDeployError(401, 'Two-factor code required', 'totp_required'));
    h.createClient.mockReturnValue({ auth: { login } });
    h.prompt.mockResolvedValueOnce('http://srv').mockResolvedValueOnce('op@x.io').mockResolvedValueOnce('');
    h.promptHidden.mockResolvedValueOnce('pw');
    await loginAction();
    expect(login).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });
});
