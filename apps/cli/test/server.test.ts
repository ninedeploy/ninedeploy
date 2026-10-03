import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  serverStartAction,
  serverStopAction,
  serverStatusAction,
  serverLogsAction,
} from '../src/commands/server.js';
import * as serverRunner from '../src/lib/serverRunner.js';

vi.mock('../src/lib/serverRunner.js', () => ({
  isDockerAvailable: vi.fn(),
  isServerReachable: vi.fn(),
  getContainerState: vi.fn(),
  startServerContainer: vi.fn(),
  stopServerContainer: vi.fn(),
  getServerLogs: vi.fn(),
  waitForServerReady: vi.fn(),
}));

describe('server commands', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('serverStartAction', () => {
    it('errors out if docker is not available', async () => {
      vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(false);
      await serverStartAction({});
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Docker is not installed'));
      expect(process.exitCode).toBe(1);
    });

    it('informs user if server is already running and reachable', async () => {
      vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
      vi.mocked(serverRunner.isServerReachable).mockResolvedValue(true);
      await serverStartAction({ port: '3000' });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
    });

    it('starts container and waits for readiness successfully with default opts', async () => {
      vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
      vi.mocked(serverRunner.isServerReachable).mockResolvedValue(false);
      vi.mocked(serverRunner.startServerContainer).mockResolvedValue({ port: 3000, newlyCreated: true });
      vi.mocked(serverRunner.waitForServerReady).mockResolvedValue(true);

      await serverStartAction({});

      expect(serverRunner.startServerContainer).toHaveBeenCalledWith(expect.objectContaining({ port: 3000 }));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('NineDeploy server is now running'));
    });

    it('handles start timeout or failure', async () => {
      vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
      vi.mocked(serverRunner.isServerReachable).mockResolvedValue(false);
      vi.mocked(serverRunner.startServerContainer).mockResolvedValue({ port: 3000, newlyCreated: true });
      vi.mocked(serverRunner.waitForServerReady).mockResolvedValue(false);

      await serverStartAction({ port: '3000' });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('failed to respond within 30s'));
      expect(process.exitCode).toBe(1);
    });
  });

  describe('serverStopAction', () => {
    it('errors out if docker is not available', async () => {
      vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(false);
      await serverStopAction();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Docker is not installed'));
      expect(process.exitCode).toBe(1);
    });

    it('informs when container is not running', async () => {
      vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
      vi.mocked(serverRunner.getContainerState).mockResolvedValue({ exists: false, running: false, status: 'not found' });
      await serverStopAction();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('is not running'));
    });

    it('stops container successfully', async () => {
      vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
      vi.mocked(serverRunner.getContainerState).mockResolvedValue({ exists: true, running: true, status: 'running' });
      vi.mocked(serverRunner.stopServerContainer).mockResolvedValue();

      await serverStopAction();

      expect(serverRunner.stopServerContainer).toHaveBeenCalledWith('ninedeploy');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('stopped'));
    });

    it('handles stop error', async () => {
      vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
      vi.mocked(serverRunner.getContainerState).mockResolvedValue({ exists: true, running: true, status: 'running' });
      vi.mocked(serverRunner.stopServerContainer).mockRejectedValue(new Error('docker stop failed'));

      await serverStopAction();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to stop server'));
      expect(process.exitCode).toBe(1);
    });
  });

  describe('serverStatusAction', () => {
    it('reports docker not available when docker is down', async () => {
      vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(false);
      await serverStatusAction();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Docker'));
    });

    it('prints container and http status when docker is available', async () => {
      vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
      vi.mocked(serverRunner.getContainerState).mockResolvedValue({
        exists: true,
        running: true,
        status: 'Up 2 hours',
        id: 'c12345678901',
      });
      vi.mocked(serverRunner.isServerReachable).mockResolvedValue(true);

      await serverStatusAction();

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Container'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('c12345678901'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('reachable'));
    });
  });

  describe('serverLogsAction', () => {
    it('errors out if docker is not available', async () => {
      vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(false);
      await serverLogsAction();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Docker is not installed'));
      expect(process.exitCode).toBe(1);
    });

    it('prints server logs when available', async () => {
      vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
      vi.mocked(serverRunner.getServerLogs).mockResolvedValue('server listening on :3000\n');

      await serverLogsAction({ lines: '20' });

      expect(logSpy).toHaveBeenCalledWith('server listening on :3000\n');
    });

    it('prints fallback message if logs are empty', async () => {
      vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
      vi.mocked(serverRunner.getServerLogs).mockResolvedValue('   ');

      await serverLogsAction();

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no logs recorded'));
    });

    it('handles logs error', async () => {
      vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
      vi.mocked(serverRunner.getServerLogs).mockRejectedValue(new Error('no such container'));

      await serverLogsAction();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to get server logs'));
      expect(process.exitCode).toBe(1);
    });

    it('handles non-Error logs rejection', async () => {
      vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
      vi.mocked(serverRunner.getServerLogs).mockRejectedValue('logs raw err');

      await serverLogsAction();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to get server logs: logs raw err'));
      expect(process.exitCode).toBe(1);
    });
  });

  describe('extra branches', () => {
    it('handles non-Error start failure', async () => {
      vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
      vi.mocked(serverRunner.isServerReachable).mockResolvedValue(false);
      vi.mocked(serverRunner.startServerContainer).mockRejectedValue('start raw err');

      await serverStartAction({ port: '3000' });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to start server: start raw err'));
    });

    it('handles non-Error stop failure', async () => {
      vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
      vi.mocked(serverRunner.getContainerState).mockResolvedValue({ exists: true, running: true, status: 'running' });
      vi.mocked(serverRunner.stopServerContainer).mockRejectedValue('stop raw err');

      await serverStopAction();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to stop server: stop raw err'));
    });

    it('prints stopped container and unreachable status in serverStatusAction', async () => {
      vi.mocked(serverRunner.isDockerAvailable).mockResolvedValue(true);
      vi.mocked(serverRunner.getContainerState).mockResolvedValue({
        exists: true,
        running: false,
        status: 'exited (0)',
        id: undefined,
      });
      vi.mocked(serverRunner.isServerReachable).mockResolvedValue(false);

      await serverStatusAction();

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('exited (0)'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('unreachable'));
    });
  });
});
