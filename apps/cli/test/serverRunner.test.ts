import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import {
  isDockerAvailable,
  isServerReachable,
  getContainerState,
  startServerContainer,
  stopServerContainer,
  getServerLogs,
  waitForServerReady,
  normalizeServerUrl,
  formatDockerError,
  dockerSocketGid,
} from '../src/lib/serverRunner.js';
import { promises as fsp } from 'node:fs';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

describe('serverRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('normalizeServerUrl', () => {
    it('handles empty or whitespace string', () => {
      expect(normalizeServerUrl('')).toBe('http://localhost:3000');
      expect(normalizeServerUrl('   ')).toBe('http://localhost:3000');
    });

    it('adds http:// for loopback hosts, https:// for anything else', () => {
      expect(normalizeServerUrl('localhost:3000')).toBe('http://localhost:3000');
      // Non-loopback hosts default to https: the bearer token must not ride
      // plaintext HTTP to a remote host. LAN-IP users can type http:// explicitly.
      expect(normalizeServerUrl('192.168.1.10:3000')).toBe('https://192.168.1.10:3000');
      expect(normalizeServerUrl('panel.example.com')).toBe('https://panel.example.com');
    });

    it('preserves existing https:// and strips trailing slashes', () => {
      expect(normalizeServerUrl('https://panel.example.com///')).toBe('https://panel.example.com');
      expect(normalizeServerUrl('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000');
    });
  });

  describe('formatDockerError', () => {
    it('diagnoses permission denied error', () => {
      const err = new Error('connect EACCES /var/run/docker.sock permission denied');
      expect(formatDockerError(err)).toContain('Docker socket permission denied');
    });

    it('diagnoses container name conflict', () => {
      const err = new Error('Conflict. The container name "/ninedeploy" is already in use');
      expect(formatDockerError(err)).toContain("Container conflict: A 'ninedeploy' container already exists");
    });

    it('diagnoses port collision error', () => {
      const err = new Error('Bind for 0.0.0.0:3000 failed: port is already allocated');
      expect(formatDockerError(err)).toContain('Port conflict: The host port is already allocated');
    });

    it('passes through generic error message', () => {
      const err = new Error('unexpected error');
      expect(formatDockerError(err)).toBe('unexpected error');
    });

    it('handles string / non-Error value', () => {
      expect(formatDockerError('raw string error')).toBe('raw string error');
    });
  });

  describe('isDockerAvailable', () => {
    it('returns true when docker --version succeeds', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((_cmd, _args, cb: any) => {
        cb(null, { stdout: 'Docker version 27.0.0', stderr: '' });
        return {} as any;
      });
      const available = await isDockerAvailable();
      expect(available).toBe(true);
    });

    it('returns false when docker command fails', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((_cmd, _args, cb: any) => {
        cb(new Error('command not found'), { stdout: '', stderr: '' });
        return {} as any;
      });
      const available = await isDockerAvailable();
      expect(available).toBe(false);
    });
  });

  describe('isServerReachable', () => {
    it('returns true when fetch succeeds with 200', async () => {
      global.fetch = vi.fn().mockResolvedValue({ status: 200 } as Response);
      const ok = await isServerReachable('http://localhost:3000');
      expect(ok).toBe(true);
    });

    it('returns false when another service returns 401 or 404', async () => {
      global.fetch = vi.fn().mockResolvedValue({ status: 401 } as Response);
      const ok = await isServerReachable('http://localhost:3000');
      expect(ok).toBe(false);
      expect(global.fetch).toHaveBeenCalledWith('http://localhost:3000/health', expect.any(Object));
    });

    it('returns false when fetch rejects with error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));
      const ok = await isServerReachable('http://localhost:3000');
      expect(ok).toBe(false);
    });

    it('returns false for invalid URL', async () => {
      const ok = await isServerReachable('not a valid url');
      expect(ok).toBe(false);
    });
  });

  describe('getContainerState', () => {
    it('parses running container inspection', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((_cmd, _args, cb: any) => {
        cb(null, { stdout: 'c12345678901234|true|running\n', stderr: '' });
        return {} as any;
      });
      const state = await getContainerState('ninedeploy');
      expect(state).toEqual({
        exists: true,
        running: true,
        status: 'running',
        id: 'c12345678901',
      });
    });

    it('handles not found / inspect error', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((_cmd, _args, cb: any) => {
        cb(new Error('No such object'), { stdout: '', stderr: '' });
        return {} as any;
      });
      const state = await getContainerState('ninedeploy');
      expect(state).toEqual({
        exists: false,
        running: false,
        status: 'not found',
      });
    });
  });

  describe('startServerContainer', () => {
    it('returns directly if container is already running', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((_cmd, args: any, cb: any) => {
        if (args[0] === 'inspect') {
          cb(null, { stdout: 'c12345678901234|true|running', stderr: '' });
        }
        return {} as any;
      });
      const res = await startServerContainer({ port: 3000 });
      expect(res).toEqual({ port: 3000, newlyCreated: false });
    });

    it('starts container if it exists but is stopped', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((_cmd, args: any, cb: any) => {
        if (args[0] === 'inspect') {
          cb(null, { stdout: 'c12345678901234|false|exited', stderr: '' });
        } else if (args[0] === 'start') {
          cb(null, { stdout: 'ninedeploy', stderr: '' });
        }
        return {} as any;
      });
      const res = await startServerContainer({ port: 3000 });
      expect(res).toEqual({ port: 3000, newlyCreated: false });
    });

    it('runs new container if it does not exist', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((_cmd, args: any, cb: any) => {
        if (args[0] === 'inspect') {
          cb(new Error('No such object'), { stdout: '', stderr: '' });
        } else if (args[0] === 'run') {
          cb(null, { stdout: 'cid999', stderr: '' });
        }
        return {} as any;
      });
      const res = await startServerContainer({ port: 3000, secret: 'sec123' });
      expect(res).toEqual({ port: 3000, newlyCreated: true });
    });

    it('r247: adds the docker socket group so the non-root image can reach the daemon', async () => {
      const calls: string[][] = [];
      vi.mocked(childProcess.execFile).mockImplementation((_cmd, args: any, cb: any) => {
        calls.push(args);
        if (args[0] === 'inspect') cb(new Error('No such object'), { stdout: '', stderr: '' });
        else cb(null, { stdout: 'cid', stderr: '' });
        return {} as any;
      });
      await startServerContainer({ port: 3000, secret: 's', dockerGid: 998 });
      const run = calls.find((a) => a[0] === 'run')!;
      expect(run[run.indexOf('--group-add') + 1]).toBe('998');
      calls.length = 0;
      await startServerContainer({ port: 3000, secret: 's', dockerGid: null });
      expect(calls.find((a) => a[0] === 'run')).not.toContain('--group-add');
    });

    it('r247: reads the socket gid on Linux only', async () => {
      const stat = vi.spyOn(fsp, 'stat').mockResolvedValue({ gid: 997 } as never);
      expect(await dockerSocketGid('linux')).toBe(997);
      expect(await dockerSocketGid('darwin')).toBeNull();
      stat.mockRejectedValueOnce(new Error('ENOENT'));
      expect(await dockerSocketGid('linux')).toBeNull();
    });

    it('throws formatted error when docker run fails', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((_cmd, args: any, cb: any) => {
        if (args[0] === 'inspect') {
          cb(new Error('No such object'), { stdout: '', stderr: '' });
        } else if (args[0] === 'run') {
          cb(new Error('Bind for 0.0.0.0:3000 failed: port is already allocated'), { stdout: '', stderr: '' });
        }
        return {} as any;
      });
      await expect(startServerContainer({ port: 3000 })).rejects.toThrow('Port conflict');
    });

    it('throws formatted error when docker start fails', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((_cmd, args: any, cb: any) => {
        if (args[0] === 'inspect') {
          cb(null, { stdout: 'cid|false|exited', stderr: '' });
        } else if (args[0] === 'start') {
          cb(new Error('connect EACCES /var/run/docker.sock permission denied'), { stdout: '', stderr: '' });
        }
        return {} as any;
      });
      await expect(startServerContainer({ port: 3000 })).rejects.toThrow('Docker socket permission denied');
    });
  });

  describe('stopServerContainer', () => {
    it('calls docker stop', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((_cmd, _args, cb: any) => {
        cb(null, { stdout: 'ninedeploy', stderr: '' });
        return {} as any;
      });
      await stopServerContainer('ninedeploy');
      expect(childProcess.execFile).toHaveBeenCalledWith('docker', ['stop', 'ninedeploy'], expect.any(Function));
    });

    it('throws formatted error when docker stop fails', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((_cmd, _args, cb: any) => {
        cb(new Error('no such container'), { stdout: '', stderr: '' });
        return {} as any;
      });
      await expect(stopServerContainer('ninedeploy')).rejects.toThrow('no such container');
    });
  });

  describe('getServerLogs', () => {
    it('returns stdout from docker logs', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((_cmd, _args, cb: any) => {
        cb(null, { stdout: 'server started\n', stderr: '' });
        return {} as any;
      });
      const logs = await getServerLogs('ninedeploy', 10);
      expect(logs).toBe('server started\n');
    });

    it('returns empty string if both stdout and stderr are empty', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((_cmd, _args, cb: any) => {
        cb(null, { stdout: '', stderr: '' });
        return {} as any;
      });
      const logs = await getServerLogs('ninedeploy');
      expect(logs).toBe('');
    });

    it('throws formatted error when docker logs fails', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((_cmd, _args, cb: any) => {
        cb(new Error('logs failed'), { stdout: '', stderr: '' });
        return {} as any;
      });
      await expect(getServerLogs('ninedeploy')).rejects.toThrow('logs failed');
    });
  });

  describe('getContainerState extra branches', () => {
    it('handles empty status and empty id', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((_cmd, _args, cb: any) => {
        cb(null, { stdout: '|false|\n', stderr: '' });
        return {} as any;
      });
      const state = await getContainerState('ninedeploy');
      expect(state).toEqual({
        exists: true,
        running: false,
        status: 'unknown',
        id: undefined,
      });
    });

    it('creates container with default port, name and image when none supplied', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((_cmd, args: any, cb: any) => {
        if (args[0] === 'inspect') {
          cb(new Error('not found'), { stdout: '', stderr: '' });
        } else if (args[0] === 'run') {
          cb(null, { stdout: 'cid1', stderr: '' });
        }
        return {} as any;
      });
      const res = await startServerContainer();
      expect(res).toEqual({ port: 3000, newlyCreated: true });
    });
  });

  describe('waitForServerReady', () => {
    it('resolves true when server becomes reachable', async () => {
      global.fetch = vi.fn().mockResolvedValue({ status: 200 } as Response);
      const ready = await waitForServerReady('http://localhost:3000', 3, 10);
      expect(ready).toBe(true);
    });

    it('returns false when server fails to respond within max attempts', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const ready = await waitForServerReady('http://localhost:3000', 2, 10);
      expect(ready).toBe(false);
    });
  });
});
