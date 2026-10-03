import { describe, expect, it, vi } from 'vitest';
import { LocalDockerDriver } from '../../src/kernel/drivers/docker.js';
import { TraefikProxyDriver } from '../../src/kernel/drivers/traefik.js';
import { S3StorageDriver } from '../../src/kernel/drivers/s3.js';
import * as exec from '../../src/lib/exec.js';
import * as proxyEngine from '../../src/engine/proxy.js';
import * as s3Lib from '../../src/lib/s3.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFakeDb } from '../helpers.js';

describe('Kernel Drivers', () => {
  describe('LocalDockerDriver', () => {
    it('handles pullImage, runContainer, stopContainer, removeContainer, inspectContainer, and getLogs', async () => {
      const driver = new LocalDockerDriver();
      expect(driver.name).toBe('docker-local');

      const runSpy = vi.spyOn(exec, 'run').mockResolvedValue(undefined);
      const captureSpy = vi.spyOn(exec, 'capture').mockImplementation(async (_cmd, args) => {
        if (args.includes('inspect')) {
          return 'running|172.20.0.4|redis:alpine\n';
        }
        if (args.includes('logs')) {
          return 'line 1\nline 2\n';
        }
        return '';
      });

      // 1. pullImage
      const logCb = vi.fn();
      await driver.pullImage('redis:alpine', logCb);
      // pullImage delegates to lib/dockerPull, which arms a progress heartbeat
      // so a slow registry pull does not read as a frozen deploy. The assertion
      // predated that and still expected a bare `{}`.
      expect(runSpy).toHaveBeenCalledWith(
        'docker',
        ['pull', 'redis:alpine'],
        { heartbeatMs: 20_000, heartbeatLabel: 'Pulling application image redis:alpine' },
        expect.any(Function),
      );

      // 2. runContainer with all options
      await driver.runContainer({
        name: 'my-redis',
        image: 'redis:alpine',
        network: 'ninedeploy',
        envFile: '/tmp/env',
        volume: 'redis-data',
        mount: '/data',
        cpuShares: '512',
        cpuLimitMilli: '500',
        memLimitMb: '256',
      });
      expect(captureSpy).toHaveBeenCalledWith('docker', [
        'run', '-d', '--name', 'my-redis', '--restart', 'unless-stopped',
        '--network', 'ninedeploy',
        '--env-file', '/tmp/env',
        '-v', 'redis-data:/data',
        '--cpu-shares', '512',
        '--cpus', '0.5',
        '--memory', '256m', '--memory-swap', '256m',
        'redis:alpine',
      ]);

      // runContainer minimal
      await driver.runContainer({
        name: 'min-redis',
        image: 'redis:alpine',
      });

      // 3. stopContainer
      await driver.stopContainer('my-redis', 5);
      expect(captureSpy).toHaveBeenCalledWith('docker', ['stop', '-t', '5', 'my-redis']);

      // 4. removeContainer
      await driver.removeContainer('my-redis');
      expect(captureSpy).toHaveBeenCalledWith('docker', ['rm', '-f', 'my-redis']);

      // 5. inspectContainer
      const insp = await driver.inspectContainer('my-redis');
      expect(insp).toEqual({ status: 'running', ipAddress: '172.20.0.4', image: 'redis:alpine' });

      captureSpy.mockResolvedValueOnce('stopped||\n');
      const inspEmpty = await driver.inspectContainer('stopped-redis');
      expect(inspEmpty).toEqual({ status: 'stopped', ipAddress: undefined, image: undefined });

      // 6. getLogs
      const logs = await driver.getLogs('my-redis', 50);
      expect(logs).toEqual(['line 1', 'line 2']);

      // 7. Error handling branches
      captureSpy.mockRejectedValue(new Error('Docker daemon not reachable'));
      await expect(driver.stopContainer('err-c')).resolves.toBeUndefined();
      await expect(driver.removeContainer('err-c')).resolves.toBeUndefined();
      expect(await driver.inspectContainer('err-c')).toEqual({ status: 'missing' });
      expect(await driver.getLogs('err-c')).toEqual([]);

      runSpy.mockRestore();
      captureSpy.mockRestore();
    });
  });

  describe('TraefikProxyDriver', () => {
    it('syncs configuration, triggers reload and returns certificate status', async () => {
      const db = createFakeDb();
      const driver = new TraefikProxyDriver(db);
      expect(driver.name).toBe('traefik');

      const syncSpy = vi.spyOn(proxyEngine, 'writeDynamicConfig').mockResolvedValue(undefined);
      const readCertSpy = vi.spyOn(proxyEngine, 'readCertificates').mockReturnValue([
        { domain: 'app.example.com', expiresAt: new Date(Date.now() + 86400000) },
        { domain: 'expired.example.com', expiresAt: new Date(Date.now() - 86400000) },
        { domain: 'noexpiry.example.com' },
      ]);
      const captureSpy = vi.spyOn(exec, 'capture').mockResolvedValue('');

      await driver.syncConfiguration([], []);
      expect(syncSpy).toHaveBeenCalled();

      await driver.reload();
      expect(captureSpy).toHaveBeenCalledWith('docker', ['kill', '--signal=HUP', 'ninedeploy-traefik']);

      // reload error branch
      captureSpy.mockRejectedValueOnce(new Error('no such container'));
      await expect(driver.reload()).resolves.toBeUndefined();

      const certs = await driver.getCertificateStatus();
      expect(certs).toHaveLength(3);
      expect(certs[0]?.valid).toBe(true);
      expect(certs[1]?.valid).toBe(false);
      expect(certs[2]?.valid).toBe(true);

      syncSpy.mockRestore();
      readCertSpy.mockRestore();
      captureSpy.mockRestore();
    });
  });

  describe('S3StorageDriver', () => {
    it('uploads, downloads, and deletes files via s3 client', async () => {
      const s3Config = {
        endpoint: 'https://s3.example.com',
        region: 'us-east-1',
        bucket: 'backups',
        accessKeyId: 'key',
        secretAccessKey: 'sec',
      };
      const driver = new S3StorageDriver(s3Config);
      expect(driver.name).toBe('s3');

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-driver-test-'));
      const srcFile = path.join(tmpDir, 'source.sql');
      const destFile = path.join(tmpDir, 'dest.sql');
      fs.writeFileSync(srcFile, 'sample-backup-content');

      const putSpy = vi.spyOn(s3Lib, 's3Put').mockResolvedValue(undefined);
      const getSpy = vi.spyOn(s3Lib, 's3Get').mockResolvedValue(Buffer.from('downloaded-backup-content'));
      const delSpy = vi.spyOn(s3Lib, 's3Delete').mockResolvedValue(undefined);

      // Upload
      await driver.upload(srcFile, 'backups/db.sql');
      expect(putSpy).toHaveBeenCalledWith(s3Config, 'backups/db.sql', Buffer.from('sample-backup-content'));

      // Download
      await driver.download('backups/db.sql', destFile);
      expect(getSpy).toHaveBeenCalledWith(s3Config, 'backups/db.sql');
      expect(fs.readFileSync(destFile, 'utf8')).toBe('downloaded-backup-content');

      // Delete
      await driver.delete('backups/db.sql');
      expect(delSpy).toHaveBeenCalledWith(s3Config, 'backups/db.sql');

      fs.rmSync(tmpDir, { recursive: true, force: true });
      putSpy.mockRestore();
      getSpy.mockRestore();
      delSpy.mockRestore();
    });
  });
});
