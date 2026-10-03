import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { doctorAction } from '../src/commands/doctor.js';
import * as serverRunner from '../src/lib/serverRunner.js';
import * as configMod from '../src/config.js';
import type { NineDeployClient } from '../src/client.js';

vi.mock('../src/lib/serverRunner.js', () => ({
  isDockerAvailable: vi.fn(),
  getContainerState: vi.fn(),
  isServerReachable: vi.fn(),
  startServerContainer: vi.fn(),
}));

vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(),
}));

describe('doctorAction', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let mockClient: NineDeployClient;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockClient = {
      auth: {
        me: vi.fn(),
      },
    } as unknown as NineDeployClient;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports all checks passed when everything is healthy and authenticated', async () => {
    vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
    vi.mocked(serverRunner.getContainerState).mockResolvedValue({ exists: true, running: true, status: 'running' });
    vi.mocked(configMod.loadConfig).mockReturnValue({ baseUrl: 'http://localhost:3000', token: 'tok123' });
    vi.mocked(serverRunner.isServerReachable).mockResolvedValue(true);
    (mockClient.auth.me as any).mockResolvedValue({ email: 'admin@nine.io', isOperator: true });

    await doctorAction(mockClient);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('1. Local Environment'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2. Docker'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('running'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('connected'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('admin@nine.io (operator)'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('All critical checks passed'));
  });

  it('labels a session without an operator seat as a member', async () => {
    vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
    vi.mocked(serverRunner.getContainerState).mockResolvedValue({ exists: true, running: true, status: 'running' });
    vi.mocked(configMod.loadConfig).mockReturnValue({ baseUrl: 'http://localhost:3000', token: 'tok123' });
    vi.mocked(serverRunner.isServerReachable).mockResolvedValue(true);
    (mockClient.auth.me as any).mockResolvedValue({ email: 'dev@nine.io', isOperator: false });

    await doctorAction(mockClient);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('dev@nine.io (member)'));
  });

  it('handles docker not available and stopped container', async () => {
    vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(false);
    vi.mocked(configMod.loadConfig).mockReturnValue({ baseUrl: 'http://localhost:3000' });
    vi.mocked(serverRunner.isServerReachable).mockResolvedValue(true);

    await doctorAction(mockClient);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not found or daemon not running'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not logged in'));
  });

  it('reports stopped and not created container states when docker is available', async () => {
    vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
    vi.mocked(serverRunner.getContainerState).mockResolvedValueOnce({ exists: true, running: false, status: 'exited' });
    vi.mocked(configMod.loadConfig).mockReturnValue({ baseUrl: 'http://localhost:3000', token: 'tok' });
    vi.mocked(serverRunner.isServerReachable).mockResolvedValue(true);
    (mockClient.auth.me as any).mockResolvedValue({ email: 'admin@nine.io', isOperator: true });

    await doctorAction(mockClient);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('stopped'));

    // Test not created container state
    vi.mocked(serverRunner.getContainerState).mockResolvedValueOnce({ exists: false, running: false, status: 'not found' });
    await doctorAction(mockClient);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not in use (baremetal / systemd mode)'));
  });

  it('handles unreachable server and invalid token with issues summary and prescriptions', async () => {
    vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
    vi.mocked(serverRunner.getContainerState).mockResolvedValue({ exists: true, running: true, status: 'running' });
    vi.mocked(configMod.loadConfig).mockReturnValue({ baseUrl: 'http://localhost:3000', token: 'bad-tok' });
    vi.mocked(serverRunner.isServerReachable).mockResolvedValue(false);
    (mockClient.auth.me as any).mockRejectedValue(new Error('unauthorized'));

    await doctorAction(mockClient);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('unreachable'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('invalid or expired'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Found 2 issue(s)'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Prescriptions & Solutions'));
  });

  it('heals stopped container and missing data directory when --fix is provided', async () => {
    vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
    vi.mocked(serverRunner.getContainerState).mockResolvedValue({ exists: true, running: false, status: 'exited' });
    vi.mocked(serverRunner.startServerContainer).mockResolvedValue(undefined as any);
    vi.mocked(configMod.loadConfig).mockReturnValue({ baseUrl: 'http://localhost:3000', token: 'tok' });
    vi.mocked(serverRunner.isServerReachable).mockResolvedValue(true);
    (mockClient.auth.me as any).mockResolvedValue({ email: 'admin@nine.io', isOperator: true });

    await doctorAction(mockClient, { fix: true });

    expect(serverRunner.startServerContainer).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Healed Issues (--fix)'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Started stopped ninedeploy Docker container'));
  });

  it('handles --fix failure gracefully when starting container errors', async () => {
    vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
    vi.mocked(serverRunner.getContainerState).mockResolvedValue({ exists: true, running: false, status: 'exited' });
    vi.mocked(serverRunner.startServerContainer).mockRejectedValue(new Error('port busy'));
    vi.mocked(configMod.loadConfig).mockReturnValue({ baseUrl: 'http://localhost:3000', token: 'tok' });
    vi.mocked(serverRunner.isServerReachable).mockResolvedValue(true);
    (mockClient.auth.me as any).mockResolvedValue({ email: 'admin@nine.io', isOperator: true });

    await doctorAction(mockClient, { fix: true });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('port busy'));
  });
});
